// ─── AI-drafted workflows (Workflows > Create with AI) ───────────────────────
// Two stages, because they need different things:
//
//   OUTLINE — requirements in, a reviewable outline out (trigger, steps in
//     order, assumptions, open questions). The model sees the tenant's
//     workflow library as NAMES AND DESCRIPTIONS only: enough to pick the
//     right trigger and actions, small enough to be quick, and this is the
//     stage the user revises, possibly several times.
//   BUILD — the approved outline in, a complete ISC workflow out. Now the
//     model gets the FULL detail (input fields, example payloads) of just the
//     trigger and actions the outline chose, plus real workflows from this
//     tenant as format references — the definition JSON has conventions
//     (".$" keys for JSONPath values, choice/comparator shapes) that are far
//     more reliably copied than described.
//
// Everything here is pure (no network): catalog shaping, prompt text, JSON
// extraction, and the structural validation that gates a save. The routes in
// index.js do the ISC and AI calls.

const clip = (v, n) => {
  const text = typeof v === "string" ? v : JSON.stringify(v ?? "");
  return text.length > n ? `${text.slice(0, n)}…` : text;
};

// The library lists every version of an action/trigger; offer the model only
// the current one (not deprecated, highest versionNumber) per id.
function currentVersions(items) {
  const byId = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (!item?.id || item.deprecated) continue;
    const held = byId.get(item.id);
    if (!held || (item.versionNumber ?? 0) > (held.versionNumber ?? 0)) byId.set(item.id, item);
  }
  return [...byId.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

/** { triggers, actions, operators } from ISC's three workflow-library lists. */
function buildCatalog({ triggers, actions, operators }) {
  return { triggers: currentVersions(triggers), actions: currentVersions(actions), operators: currentVersions(operators) };
}

const catalogLine = (x) => `- ${x.id} — ${x.name}: ${clip(x.description || "", 160)}`;

// Names and descriptions only — the OUTLINE stage's view of the library.
function catalogSummary(catalog) {
  return [
    "TRIGGERS (what starts the workflow):", ...catalog.triggers.map((t) => `${catalogLine(t)} [type ${t.type}]`),
    "", "ACTIONS (steps that do something):", ...catalog.actions.map(catalogLine),
    "", "OPERATORS (flow control — comparisons/choices, loops, waits, success/failure ends):", ...catalog.operators.map(catalogLine),
  ].join("\n");
}

// Allowed values matter most for comparators — the model must pick one verbatim.
const fieldLine = (f) =>
  `    ${f.name}${f.required ? " (required)" : ""} — ${f.type || "?"}${f.label ? `, "${f.label}"` : ""}${f.helpText ? `: ${clip(f.helpText, 140)}` : ""}` +
  (Array.isArray(f.options) && f.options.length ? ` — one of: ${f.options.slice(0, 30).map((o) => o?.value).filter((v) => v != null).join(", ")}` : "");

// Full detail for the ids the outline chose — the BUILD stage's view.
function catalogDetail(catalog, { triggerId, stepIds }) {
  const out = [];
  const trigger = catalog.triggers.find((t) => t.id === triggerId);
  if (trigger) {
    out.push(`TRIGGER ${trigger.id} — ${trigger.name} [type ${trigger.type}]`, `  ${trigger.description || ""}`);
    if (trigger.inputExample) out.push(`  Its payload (what $.trigger.… holds) looks like: ${clip(trigger.inputExample, 1800)}`);
    const fields = (trigger.formFields || []).filter((f) => f?.name).slice(0, 12);
    if (fields.length) out.push("  Trigger attributes:", ...fields.map(fieldLine));
  }
  const wanted = new Set(stepIds);
  for (const item of [...catalog.actions, ...catalog.operators]) {
    if (!wanted.has(item.id)) continue;
    out.push("", `${catalog.actions.includes(item) ? "ACTION" : "OPERATOR"} ${item.id} — ${item.name}${item.versionNumber != null ? ` [versionNumber ${item.versionNumber}]` : ""}`, `  ${item.description || ""}`);
    const fields = (item.formFields || []).filter((f) => f?.name);
    if (fields.length) out.push("  Attributes:", ...fields.map(fieldLine));
    if (item.exampleOutput && Object.keys(item.exampleOutput).length) out.push(`  Its output (what $.<stepName>.… holds) looks like: ${clip(item.exampleOutput, 900)}`);
  }
  return out.join("\n");
}

// Every step in a workflow, loop bodies included.
function* allSteps(steps) {
  for (const step of Object.values(steps || {})) {
    if (!step || typeof step !== "object") continue;
    yield step;
    if (step.attributes?.steps && typeof step.attributes.steps === "object") yield* allSteps(step.attributes.steps);
  }
}

// How the tenant's existing workflows actually fill in each of these actions
// — up to `perId` distinct attribute sets each. The library's field list has
// gaps (the Wait action lists only "type"; its duration hides inside that
// field's options), and real usage fills them for any action, not just the
// ones someone thought to special-case. Long values are clipped: this shows
// the SHAPE, and keeps another workflow's email bodies out of the prompt.
function actionUsageExamples(workflows, ids, perId = 2) {
  const wanted = new Set(ids);
  const found = new Map();
  const shorten = (v) => (typeof v === "string" && v.length > 80 ? `${v.slice(0, 80)}…` : v);
  for (const w of Array.isArray(workflows) ? workflows : []) {
    for (const step of allSteps(w?.definition?.steps)) {
      if (!wanted.has(step.actionId) || !step.attributes || step.actionId === "sp:loop:iterator") continue;
      const attrs = Object.fromEntries(Object.entries(step.attributes).map(([k, v]) => [k, shorten(v)]));
      const text = clip(attrs, 500);
      const list = found.get(step.actionId) || [];
      if (list.length < perId && !list.includes(text)) found.set(step.actionId, [...list, text]);
    }
  }
  return [...found.entries()].map(([id, list]) => `${id}:\n${list.map((t) => `    attributes: ${t}`).join("\n")}`).join("\n");
}

// Real workflows from the tenant, as format references: smallest complete
// ones first, preferring any that show a choice (the trickiest shape).
// `isValid` (validateWorkflow against the catalog) keeps half-finished drafts
// out — an example that breaks the rules teaches the model to break them.
function pickExampleWorkflows(workflows, isValid = () => true, max = 2, maxChars = 7000) {
  const usable = (Array.isArray(workflows) ? workflows : [])
    .filter((w) => w?.definition?.start && w.definition.steps && w.trigger?.attributes?.id && isValid(w))
    .map((w) => {
      const doc = { name: w.name, description: w.description, trigger: w.trigger, definition: w.definition };
      const steps = Object.values(w.definition.steps);
      return { doc, size: JSON.stringify(doc).length, hasChoice: steps.some((st) => st?.type === "choice"), stepCount: steps.length };
    })
    .filter((x) => x.size <= maxChars && x.stepCount >= 3)
    .sort((a, b) => Number(b.hasChoice) - Number(a.hasChoice) || a.size - b.size);
  return usable.slice(0, max).map((x) => x.doc);
}

// ── Prompts ──────────────────────────────────────────────────────────────────

const OUTLINE_SHAPE = `{
  "name": "<short workflow name>",
  "description": "<one or two sentences: what it does and when>",
  "trigger": { "id": "<a TRIGGER id from the library>", "name": "<its name>", "why": "<why this trigger fits>", "filter": "<plain-language condition for when it should run, or null if always>" },
  "steps": [
    { "name": "<unique step name, as it will appear in the workflow>", "id": "<an ACTION or OPERATOR id from the library>", "purpose": "<what this step does here, in plain language — one or two sentences>",
      "next": "<the NAME of the step that runs after this one; null for an end step and for a decision>",
      "branches": [ { "when": "<plain-language condition>", "next": "<step NAME to go to when it holds>" } ],
      "otherwise": "<step NAME to go to when no branch holds>" }
  ],
  "assumptions": ["<anything you assumed that the requirements didn't state>"],
  "questions": ["<anything the requester should answer to make this right — omit if none>"]
}`;

function outlinePrompt({ requirements, catalog, previousOutline, feedback }) {
  return [
    "You are designing a SailPoint Identity Security Cloud (ISC) workflow for an ISC administrator. Produce an OUTLINE for them to review — not the workflow JSON yet.",
    "",
    "Use ONLY triggers, actions and operators from this tenant's workflow library below, by their exact ids. If the requirements need something the library can't do, don't invent a step: use the closest real one (an HTTP Request action can call any API) and say so in assumptions, or raise it in questions.",
    "The outline is drawn as a flowchart, so the links between steps are data, not prose: the FIRST step in \"steps\" is where the workflow starts; an ordinary step has \"next\" (one step name) and no branches; a DECISION (a compare / verify operator) has \"branches\" and \"otherwise\" and a null \"next\"; an END (the success or failure operator) has none of them. Every name in next / branches / otherwise must be the exact name of a step in the list. Every path must reach an end. Keep it as simple as the requirements allow.",
    "",
    catalogSummary(catalog),
    "",
    `THE REQUIREMENTS:\n${requirements}`,
    ...(previousOutline ? ["", `YOUR PREVIOUS OUTLINE:\n${JSON.stringify(previousOutline, null, 2)}`, "", `THE REQUESTER'S REVISION — change the outline accordingly, keeping what they didn't ask to change:\n${feedback}`] : []),
    "",
    `Reply with ONLY a JSON object of exactly this shape, no code fence, nothing before or after:\n${OUTLINE_SHAPE}`,
  ].join("\n");
}

function buildPrompt({ requirements, outline, catalog, examples, usage, problems }) {
  const stepIds = (outline.steps || []).map((st) => st.id).filter(Boolean);
  return [
    "You are building a SailPoint Identity Security Cloud (ISC) workflow. The outline below has been reviewed and APPROVED by the administrator — implement exactly it: same trigger, same steps by the same names, wired exactly as its next / branches / otherwise say (the first step in the list is definition.start). The administrator may have reordered steps by hand, so trust the outline's links over the wording of any step's purpose — and remember a step can only read the output of steps that run BEFORE it on its path; if the order makes some data unavailable, take it from the trigger or leave a REPLACE_WITH_… placeholder rather than referencing a later step.",
    "",
    "Produce the complete workflow as ISC's API accepts it: { name, description, trigger: { type, attributes }, definition: { start, steps } }.",
    "- trigger is { type, attributes }: type is the library trigger's type (EVENT, SCHEDULED, EXTERNAL, …) and attributes.id is its library id. An EVENT trigger that should only run sometimes gets attributes[\"filter.$\"]: a JSONPath filter over the trigger payload, e.g. \"$.changes[?(@.attribute == 'department')]\". A SCHEDULED trigger gets cronString / frequency / timeZone as the library lists them.",
    "- definition.start is the first step's name; definition.steps maps each step name (the outline's names, spaces allowed) to its object. Give every step a displayName (its name).",
    "- An ACTION step: { type: \"action\", actionId, versionNumber (when the library gives one), attributes: { …its inputs… }, nextStep }.",
    "- A DECISION is a comparison operator step: { type: \"choice\", actionId: \"sp:compare-strings\" (or the compare operator the outline chose), choiceList: [{ comparator, \"variableA.$\": <JSONPath>, \"variableB.$\": <JSONPath> OR variableB: <literal>, nextStep }], defaultStep }. The key is choiceList (not choices); comparator must be one of the operator's allowed values verbatim; the first matching entry wins, otherwise defaultStep.",
    "- ENDS: { type: \"success\", actionId: \"sp:operator-success\" } and { type: \"failure\", actionId: \"sp:operator-failure\", failureName, failureDetails }. They have no nextStep. Every path must reach one.",
    "- A LOOP is an action step with actionId \"sp:loop:iterator\" whose attributes hold the loop body: { \"input.$\": <JSONPath to the array>, start: <first body step name>, steps: { …body steps, in this same format, ending in a success step… } }. Inside the body the current item is $.loop.loopInput.",
    "- A value taken from the trigger or an earlier step is a JSONPath expression and the attribute KEY gets a \".$\" suffix: \"recipientId.$\": \"$.trigger.identity.id\". $.trigger is the trigger's payload. An earlier step's output is $.<ref>, where <ref> is that step's name with the spaces removed and the first letter lowercased: step \"Get Identity\" → $.getIdentity, \"HTTP Request 1\" → $.hTTPRequest1.",
    "- A \".$\" key holds exactly ONE JSONPath: its value must start with \"$\" and nothing else — never text, never a concatenation like \"'Hello ' + $.x\" (ISC refuses to enable such a workflow). For text that includes values — an email subject or body, a comment — use the PLAIN key (no \".$\") and put {{$.path}} templates inside the text: \"body\": \"<p>Hello {{$.getManager.displayName}}</p>\".",
    "- Use only attribute names the library lists for each action. Leave out optional attributes you have no value for. Where a value must come from the administrator (an id, an email address, a URL), put a clearly marked placeholder like \"REPLACE_WITH_…\" and never invent a real-looking one.",
    "",
    `THE ORIGINAL REQUIREMENTS:\n${requirements}`,
    "",
    `THE APPROVED OUTLINE:\n${JSON.stringify(outline, null, 2)}`,
    "",
    `LIBRARY DETAIL FOR WHAT THE OUTLINE USES:\n${catalogDetail(catalog, { triggerId: outline.trigger?.id, stepIds })}`,
    ...(usage ? ["", `HOW THIS TENANT'S EXISTING WORKFLOWS FILL IN THESE ACTIONS — the library's attribute lists are sometimes incomplete; where real usage shows an attribute the library doesn't (e.g. a wait's duration), follow the real usage:\n${usage}`] : []),
    ...(examples.length ? ["", "REAL WORKFLOWS FROM THIS TENANT — copy their JSON conventions exactly (key naming, \".$\" usage, how choices and ends are written); do not copy their content:", ...examples.map((e) => JSON.stringify(e))] : []),
    ...(problems?.length ? ["", `YOUR PREVIOUS ATTEMPT WAS REJECTED by validation. Fix every one of these and return the whole corrected workflow:\n${problems.map((p) => `- ${p}`).join("\n")}`] : []),
    "",
    "Reply with ONLY the workflow JSON object, no code fence, nothing before or after.",
  ].join("\n");
}

// Changing an existing workflow is one stage, not two: the workflow itself is
// the "outline" the user already knows, and the whole library's detail is only
// ~7k tokens — so the model sees every action in full and can add ones the
// workflow doesn't use yet. The reply is the complete modified workflow plus a
// plain-language change list for the review screen.
function modifyPrompt({ workflow, instructions, catalog, usage, previous, feedback, problems }) {
  const current = { name: workflow.name, description: workflow.description, trigger: workflow.trigger, definition: workflow.definition };
  const everyStepId = [...catalog.actions, ...catalog.operators].map((x) => x.id);
  return [
    "You are modifying an existing SailPoint Identity Security Cloud (ISC) workflow for an ISC administrator. Make the change they ask for and NOTHING else: every step, attribute, name and link they didn't ask to change stays exactly as it is, character for character. Keep existing step names (other steps and running references use them); new steps get new, unique names.",
    "",
    "ISC workflow conventions:",
    "- trigger is { type, attributes }: attributes.id is the trigger's library id; an EVENT trigger may carry attributes[\"filter.$\"], a JSONPath filter over its payload.",
    "- definition.start names the first step; definition.steps maps each step name to its object; steps carry a displayName.",
    "- An ACTION step: { type: \"action\", actionId, versionNumber (when the library gives one), attributes, nextStep }. It may have catch: [{ next }] for an error path.",
    "- A DECISION: { type: \"choice\", actionId: <a compare operator>, choiceList: [{ comparator, \"variableA.$\", \"variableB.$\" or variableB, nextStep }], defaultStep }. comparator must be one of the operator's allowed values verbatim.",
    "- ENDS: { type: \"success\", actionId: \"sp:operator-success\" } / { type: \"failure\", actionId: \"sp:operator-failure\", failureName, failureDetails }. Every path must reach one.",
    "- A LOOP is an action step with actionId \"sp:loop:iterator\" whose attributes hold { \"input.$\", start, steps: { …body… } }; inside it the current item is $.loop.loopInput.",
    "- A value from the trigger or an earlier step is a JSONPath and its attribute KEY gets a \".$\" suffix. $.trigger is the trigger payload; an earlier step's output is $.<ref>, <ref> being its name with spaces removed and the first letter lowercased (\"Get Identity\" → $.getIdentity). A step can only read steps that run before it.",
    "- A \".$\" key holds exactly ONE JSONPath: its value must start with \"$\" and nothing else — never text, never a concatenation like \"'Hello ' + $.x\" (ISC refuses to enable such a workflow). For text that includes values — an email subject or body, a comment — use the PLAIN key (no \".$\") and put {{$.path}} templates inside the text: \"body\": \"<p>Hello {{$.getManager.displayName}}</p>\".",
    "- Use only triggers, actions and operators from the library below, and only attribute names it lists (or that this tenant's real usage shows). Where a value must come from the administrator (an address, an id, a URL), put a REPLACE_WITH_… placeholder; never invent a real-looking one.",
    "",
    `TRIGGERS AVAILABLE (only relevant if they ask to change what starts it):\n${catalog.triggers.map((t) => `- ${t.id} — ${t.name} [type ${t.type}]`).join("\n")}`,
    "",
    `THE LIBRARY:\n${catalogDetail(catalog, { triggerId: workflow.trigger?.attributes?.id, stepIds: everyStepId })}`,
    ...(usage ? ["", `HOW THIS TENANT'S WORKFLOWS FILL IN ACTIONS (follow this where it shows an attribute the library omits):\n${usage}`] : []),
    "",
    `THE CURRENT WORKFLOW:\n${JSON.stringify(current)}`,
    "",
    `THE CHANGE REQUESTED:\n${instructions}`,
    ...(previous ? ["", `YOUR PREVIOUS PROPOSAL (already applied to the current workflow above):\n${JSON.stringify(previous)}`, "", `THE ADMINISTRATOR'S FEEDBACK ON IT — revise the proposal accordingly:\n${feedback}`] : []),
    ...(problems?.length ? ["", `YOUR PREVIOUS REPLY WAS REJECTED by validation. Fix every one of these and return the whole thing again:\n${problems.map((p) => `- ${p}`).join("\n")}`] : []),
    "",
    'Reply with ONLY a JSON object, no code fence, nothing before or after, of exactly this shape:\n{ "summary": ["<one plain-language sentence per change you made, naming the step>"], "notes": ["<anything the administrator must do or check — placeholders to fill, an assumption you made; omit if none>"], "workflow": { "name": …, "description": …, "trigger": …, "definition": … } }',
  ].join("\n");
}

/**
 * What actually differs between two workflows, computed — the review screen
 * shows this beside the AI's own summary so the user isn't taking the model's
 * word for what it touched. { added, removed, changed: [step names],
 * triggerChanged, startChanged, renamed, descriptionChanged }.
 */
function diffWorkflows(before, after) {
  const a = before?.definition?.steps || {};
  const b = after?.definition?.steps || {};
  const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  return {
    added: Object.keys(b).filter((k) => !(k in a)),
    removed: Object.keys(a).filter((k) => !(k in b)),
    changed: Object.keys(b).filter((k) => k in a && !same(a[k], b[k])),
    triggerChanged: !same(before?.trigger, after?.trigger),
    startChanged: before?.definition?.start !== after?.definition?.start,
    renamed: (before?.name || "") !== (after?.name || ""),
    descriptionChanged: (before?.description || "") !== (after?.description || ""),
  };
}

// ── Reply handling ───────────────────────────────────────────────────────────

/** The first complete top-level JSON object in a model reply, or null. */
function extractJsonObject(reply) {
  const text = String(reply || "").replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/, "");
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) {
      try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

const OUTLINE_END_IDS = new Set(["sp:operator-success", "sp:operator-failure"]);

// Every step an outline step hands off to.
function outlineTargets(st) {
  const out = [];
  if (st?.next) out.push(st.next);
  for (const b of Array.isArray(st?.branches) ? st.branches : []) if (b?.next) out.push(b.next);
  if (st?.otherwise) out.push(st.otherwise);
  return out;
}

/**
 * Problems with an outline (empty = fine): real library ids, and links that
 * form a drawable, buildable graph. The same check runs on an outline the
 * user has reordered by hand before it is built.
 */
function validateOutline(outline, catalog) {
  const problems = [];
  if (!outline || typeof outline !== "object") return ["The reply wasn't an outline object."];
  if (!outline.name || !String(outline.name).trim()) problems.push("The outline has no name.");
  if (!catalog.triggers.some((t) => t.id === outline.trigger?.id)) problems.push(`trigger.id "${outline.trigger?.id}" is not a trigger in the library.`);
  const steps = Array.isArray(outline.steps) ? outline.steps : [];
  if (steps.length === 0) problems.push("The outline has no steps.");
  const known = new Set([...catalog.actions, ...catalog.operators].map((x) => x.id));
  const names = new Set();
  for (const st of steps) {
    if (!st?.name) problems.push("A step has no name.");
    else if (names.has(st.name)) problems.push(`Two steps are both named "${st.name}" — step names must be unique.`);
    else names.add(st.name);
    if (!known.has(st?.id)) problems.push(`Step "${st?.name}": id "${st?.id}" is not an action or operator in the library.`);
  }
  if (problems.length) return problems;

  // The links — what the flowchart draws and the build stage wires up.
  for (const st of steps) {
    const targets = outlineTargets(st);
    for (const t of targets) if (!names.has(t)) problems.push(`Step "${st.name}" points to "${t}", which is not a step in the outline.`);
    const isEnd = OUTLINE_END_IDS.has(st.id);
    const isDecision = Array.isArray(st.branches) && st.branches.length > 0;
    if (isEnd && targets.length) problems.push(`Step "${st.name}" is an end step, so it can't lead anywhere.`);
    if (!isEnd && targets.length === 0) problems.push(`Step "${st.name}" leads nowhere — give it a "next", or make it an end step.`);
    if (isDecision && !st.otherwise) problems.push(`Decision "${st.name}" has no "otherwise".`);
    if (isDecision && st.next) problems.push(`Decision "${st.name}" has both "branches" and "next" — a decision's exits are its branches and "otherwise" only.`);
  }
  if (problems.length) return problems;
  const byName = new Map(steps.map((st) => [st.name, st]));
  const seen = new Set();
  const queue = [steps[0].name];
  while (queue.length) {
    const name = queue.pop();
    if (seen.has(name)) continue;
    seen.add(name);
    queue.push(...outlineTargets(byName.get(name)));
  }
  const orphans = steps.filter((st) => !seen.has(st.name)).map((st) => st.name);
  if (orphans.length) problems.push(`These steps can never run — nothing leads to them from the first step: ${orphans.join(", ")}.`);
  if (![...seen].some((n) => OUTLINE_END_IDS.has(byName.get(n).id))) problems.push("No path reaches a success or failure end step.");
  return problems;
}

// Every step (in the SAME step map) a step can hand off to: its nextStep, a
// choice's branches and default, and an error handler (catch: [{ next }]).
function stepTargets(step) {
  const out = [];
  if (step?.nextStep) out.push(step.nextStep);
  if (step?.defaultStep) out.push(step.defaultStep);
  for (const c of Array.isArray(step?.choiceList) ? step.choiceList : []) if (c?.nextStep) out.push(c.nextStep);
  for (const c of Array.isArray(step?.catch) ? step.catch : []) if (c?.next) out.push(c.next);
  return out;
}

// A loop (sp:loop:iterator) carries its body as its own step map in attributes.
const loopBody = (step) =>
  step?.attributes?.steps && typeof step.attributes.steps === "object" && !Array.isArray(step.attributes.steps)
    ? { start: step.attributes.start, steps: step.attributes.steps }
    : null;

const END_TYPES = new Set(["success", "failure"]);

// ISC's own rule, enforced only when a workflow is ENABLED (a save accepts
// anything): a key ending in ".$" holds ONE JSONPath, so its value must be a
// string starting with "$". The classic model mistake is building text under
// such a key — "body.$": "'Hello ' + $.x" — which saves fine and then fails
// to enable with "unable parse path …, must start with $". Text that mixes
// in values belongs under the plain key with {{$.path}} templates instead.
// Walks everything under a step except a loop's nested steps (checked as
// their own step map).
function badJsonPathKeys(value, path = "") {
  const out = [];
  if (Array.isArray(value)) value.forEach((v, i) => out.push(...badJsonPathKeys(v, `${path}[${i}]`)));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      const here = path ? `${path}.${k}` : k;
      if (k.endsWith(".$")) {
        // null / "" is an unset optional field — ISC's own editor leaves those behind.
        const unset = v == null || (typeof v === "string" && v.trim() === "");
        if (!unset && (typeof v !== "string" || !v.trim().startsWith("$"))) out.push(here);
      } else if (!(k === "steps" && path === "attributes")) out.push(...badJsonPathKeys(v, here));
    }
  }
  return out;
}

// One step map — the workflow's, or a loop's body (checked the same way,
// recursively: its targets resolve within itself and it must reach an end).
function checkStepMap({ start, steps }, where, knownIds, problems) {
  const at = (name) => `${where}"${name}"`;
  if (!start) problems.push(`${where || "definition."}start is missing.`);
  else if (!steps[start]) problems.push(`${where || "definition."}start "${start}" is not one of its steps.`);

  for (const [name, step] of Object.entries(steps)) {
    if (!step?.type) { problems.push(`Step ${at(name)} has no type.`); continue; }
    if (step.type === "action" && !step.actionId) problems.push(`Step ${at(name)} is an action with no actionId.`);
    if (step.actionId && !knownIds.has(step.actionId)) problems.push(`Step ${at(name)}: actionId "${step.actionId}" is not in the library.`);
    if (step.choices && !step.choiceList) problems.push(`Step ${at(name)} uses "choices" — ISC's key is "choiceList".`);
    if (step.type === "choice") {
      if (!(Array.isArray(step.choiceList) && step.choiceList.length)) problems.push(`Choice step ${at(name)} has no choiceList.`);
      if (!step.defaultStep) problems.push(`Choice step ${at(name)} has no defaultStep.`);
    }
    for (const key of badJsonPathKeys(step)) {
      problems.push(`Step ${at(name)}: "${key}" must be a single JSONPath starting with "$" — a ".$" key can't hold text or a concatenation. For text that includes values, use the plain key (without ".$") and {{$.path}} templates inside the text.`);
    }
    for (const target of stepTargets(step)) if (!steps[target]) problems.push(`Step ${at(name)} points to "${target}", which is not a step${where ? " in the same loop body" : ""}.`);
    if (!END_TYPES.has(step.type) && stepTargets(step).length === 0) problems.push(`Step ${at(name)} (type ${step.type}) leads nowhere — it needs a nextStep, or the path must end in a success/failure step.`);
    const body = loopBody(step);
    if (body) checkStepMap(body, `${where}loop "${name}" › `, knownIds, problems);
  }

  if (start && steps[start]) {
    const seen = new Set();
    const queue = [start];
    while (queue.length) {
      const name = queue.pop();
      if (seen.has(name) || !steps[name]) continue;
      seen.add(name);
      queue.push(...stepTargets(steps[name]));
    }
    const orphans = Object.keys(steps).filter((n) => !seen.has(n));
    if (orphans.length) problems.push(`${where}these steps can never run — nothing leads to them: ${orphans.join(", ")}.`);
    if (![...seen].some((n) => END_TYPES.has(steps[n]?.type))) problems.push(`${where || "The workflow: "}no path reaches a success or failure step.`);
  }
}

/**
 * Structural problems with a generated workflow (empty = safe to send to
 * ISC). Not a semantic check — ISC does that on create and on enable — but it
 * catches what a model most often gets wrong: a dangling nextStep, a made-up
 * action or trigger, a path that never ends.
 */
function validateWorkflow(workflow, catalog) {
  const problems = [];
  if (!workflow || typeof workflow !== "object") return ["The reply wasn't a workflow object."];
  if (!workflow.name || !String(workflow.name).trim()) problems.push("name is missing.");

  const trigger = workflow.trigger;
  const libTrigger = catalog.triggers.find((t) => t.id === trigger?.attributes?.id);
  if (!trigger?.type) problems.push("trigger.type is missing.");
  if (!libTrigger) problems.push(`trigger.attributes.id "${trigger?.attributes?.id}" is not a trigger in the library (the trigger's library id goes in trigger.attributes.id).`);
  else if (trigger.type && libTrigger.type && trigger.type !== libTrigger.type) problems.push(`trigger.type is "${trigger.type}" but the library says ${libTrigger.id} is type "${libTrigger.type}".`);

  const def = workflow.definition;
  const steps = def?.steps && typeof def.steps === "object" ? def.steps : null;
  if (!steps || Object.keys(steps).length === 0) return [...problems, "definition.steps is missing or empty."];
  // Operators (compare-*, success/failure, variables) are steps too, so their
  // ids are as valid in actionId as the actions'.
  const knownIds = new Set([...catalog.actions, ...catalog.operators].map((a) => a.id));
  checkStepMap({ start: def.start, steps }, "", knownIds, problems);
  return problems;
}

module.exports = {
  buildCatalog, catalogSummary, catalogDetail, pickExampleWorkflows, actionUsageExamples,
  outlinePrompt, buildPrompt, modifyPrompt, diffWorkflows, extractJsonObject, validateOutline, validateWorkflow,
};
