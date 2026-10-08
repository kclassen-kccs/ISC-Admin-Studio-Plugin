/**
 * ported/workflowAi.js
 * Browser port of the old server's AI workflow routes: POST /api/workflows/ai/
 * outline, /ai/create, /:id/ai/modify and /:id/flowchart.
 *
 */

import { iscGet, iscPost, withApiRetry, badRequest, routeError } from "../isc";
import { getCredentials } from "../sailpoint";
import { generateText } from "../aiProxy";
import { getWorkflowCatalog, validateOutline, validateWorkflow, iscWorkflowErrorText } from "./workflows";

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
// The prompt text, catalog shaping and JSON extraction are the server's
// workflowAi.js verbatim; the structural validation lives in ./workflows.js.
// The four exported route ports at the end do the ISC and AI calls, the
// model call going through lib/aiProxy.js (the "Admin Studio AI Query"
// workflow by default).

const clip = (v, n) => {
  const text = typeof v === "string" ? v : JSON.stringify(v ?? "");
  return text.length > n ? `${text.slice(0, n)}…` : text;
};

const catalogLine = (x) => `- ${x.id} — ${x.name}: ${clip(x.description || "", 160)}`;

// Names and descriptions only — the OUTLINE stage's view of the library.
export function catalogSummary(catalog) {
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
export function catalogDetail(catalog, { triggerId, stepIds }) {
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
export function actionUsageExamples(workflows, ids, perId = 2) {
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
export function pickExampleWorkflows(workflows, isValid = () => true, max = 2, maxChars = 7000) {
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

export function outlinePrompt({ requirements, catalog, previousOutline, feedback }) {
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

export function buildPrompt({ requirements, outline, catalog, examples, usage, problems }) {
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
export function modifyPrompt({ workflow, instructions, catalog, usage, previous, feedback, problems }) {
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
export function diffWorkflows(before, after) {
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
export function extractJsonObject(reply) {
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


// ── The routes ───────────────────────────────────────────────────────────────

const WORKFLOW_AI_MAX_REQUIREMENTS = 6000;

// Ask, parse, validate; on a bad reply, tell the model what was wrong and ask
// once more. Returns { value } or { problems } (what was still wrong).
async function generateValidated({ makePrompt, validate, maxTokens }) {
  let problems = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const reply = await generateText(makePrompt(problems), { maxTokens, strong: true });
    const value = extractJsonObject(reply);
    problems = value ? validate(value) : ["The reply was not a JSON object."];
    if (problems.length === 0) return { value };
  }
  return { problems };
}

function checkRequirements(requirementsIn) {
  const requirements = String(requirementsIn ?? "").trim();
  if (!requirements) throw badRequest("Describe what the workflow should do.");
  if (requirements.length > WORKFLOW_AI_MAX_REQUIREMENTS) throw badRequest(`The requirements are too long (${requirements.length.toLocaleString()} characters; the limit is ${WORKFLOW_AI_MAX_REQUIREMENTS.toLocaleString()}).`);
  return requirements;
}

function workflowRouteError(err, fallbackStatus = 500) {
  if (err?.isRouteError) return err;
  const out = routeError(err, fallbackStatus);
  out.message = iscWorkflowErrorText(err);
  out.response.data.error = out.message;
  return out;
}

const placeholdersIn = (value) => [...new Set(JSON.stringify(value).match(/REPLACE_WITH_[A-Za-z0-9_]+/g) || [])];

/**
 * POST /api/workflows/ai/outline — { outline }. outline + feedback revise a
 * previous outline instead of starting over.
 */
export async function draftWorkflowOutline({ requirements: requirementsIn, outline, feedback: feedbackIn } = {}) {
  const requirements = checkRequirements(requirementsIn);
  const previousOutline = outline && typeof outline === "object" ? outline : null;
  const feedback = String(feedbackIn ?? "").trim().slice(0, 3000);
  if (previousOutline && !feedback) throw badRequest("Say what to change in the outline.");
  try {
    const catalog = await getWorkflowCatalog();
    const { value, problems } = await generateValidated({
      maxTokens: 6000,
      validate: (o) => validateOutline(o, catalog),
      makePrompt: (prev) =>
        outlinePrompt({ requirements, catalog, previousOutline, feedback }) +
        (prev ? `\n\nYour previous reply was rejected:\n${prev.map((p) => `- ${p}`).join("\n")}\nReturn a corrected outline.` : ""),
    });
    if (!value) throw badRequest(`The AI couldn't produce a usable outline (${problems[0]}). Try rephrasing the requirements.`, 502);
    return { outline: value };
  } catch (err) {
    throw workflowRouteError(err);
  }
}

/**
 * POST /api/workflows/ai/create — builds the approved outline into a full
 * workflow, validates it (one retry), and creates it in ISC DISABLED, owned
 * by the signed-in user. { workflow, placeholders }; a 422 carries { problems }.
 */
export async function createWorkflowFromOutline({ requirements: requirementsIn, outline } = {}) {
  const requirements = checkRequirements(requirementsIn);
  try {
    const catalog = await getWorkflowCatalog();
    const outlineProblems = validateOutline(outline, catalog);
    if (outlineProblems.length) throw badRequest(`That outline can't be built: ${outlineProblems[0]}`);

    const existing = await iscGet("/v2026/workflows", { limit: 250 }).catch(() => []);
    const examples = pickExampleWorkflows(existing, (wf) => validateWorkflow(wf, catalog).length === 0);
    const usage = actionUsageExamples(existing, (outline.steps || []).map((st) => st.id));

    const { value: built, problems } = await generateValidated({
      maxTokens: 16000,
      validate: (wf) => validateWorkflow(wf, catalog),
      makePrompt: (prev) => buildPrompt({ requirements, outline, catalog, examples, usage, problems: prev }),
    });
    if (!built) {
      const err = badRequest("The AI's workflow didn't pass validation, so nothing was saved. Try again, or simplify the outline.", 422);
      err.response.data.problems = problems;
      throw err;
    }

    const body = {
      name: String(built.name || outline.name).slice(0, 250),
      description: built.description || outline.description || "",
      owner: { type: "IDENTITY", id: getCredentials()?.identityId },
      definition: built.definition,
      trigger: built.trigger,
      enabled: false,
    };
    const created = await iscPost("/v2026/workflows", body);
    return { workflow: created, placeholders: placeholdersIn(built) };
  } catch (err) {
    throw workflowRouteError(err);
  }
}

/**
 * POST /api/workflows/:id/ai/modify — proposes a modified workflow; changes
 * nothing in ISC. { workflow, summary, notes, diff, placeholders }; `base`
 * stands in for the saved workflow (unsaved editor content); proposal +
 * feedback revise a previous proposal. A 422 carries { problems }.
 */
export async function proposeWorkflowModification(id, { instructions: instructionsIn, proposal, feedback: feedbackIn, base: baseIn } = {}) {
  const instructions = String(instructionsIn ?? "").trim();
  if (!instructions) throw badRequest("Describe the change you want.");
  if (instructions.length > WORKFLOW_AI_MAX_REQUIREMENTS) throw badRequest("That description is too long.");
  const previous = proposal && typeof proposal === "object" ? proposal : null;
  const feedback = String(feedbackIn ?? "").trim().slice(0, 3000);
  if (previous && !feedback) throw badRequest("Say what to change in the proposal.");
  try {
    const base = baseIn && typeof baseIn === "object" && baseIn.definition ? baseIn : null;
    const [catalog, saved, existing] = await Promise.all([
      getWorkflowCatalog(),
      iscGet(`/v2026/workflows/${encodeURIComponent(id)}`),
      iscGet("/v2026/workflows", { limit: 250 }).catch(() => []),
    ]);
    const workflow = base ? { ...saved, name: base.name ?? saved.name, description: base.description ?? saved.description, trigger: base.trigger, definition: base.definition } : saved;
    const usage = actionUsageExamples(existing, [...catalog.actions, ...catalog.operators].map((x) => x.id), 1);

    const { value, problems } = await generateValidated({
      maxTokens: 24000,
      // The envelope must hold a workflow, and the workflow must be sound.
      validate: (reply) => (reply?.workflow ? validateWorkflow({ name: workflow.name, ...reply.workflow }, catalog) : ['The reply has no "workflow".']),
      makePrompt: (prev) => modifyPrompt({ workflow, instructions, catalog, usage, previous, feedback, problems: prev }),
    });
    if (!value) {
      const err = badRequest("The AI's modified workflow didn't pass validation, so there is nothing to review. Try again, or describe the change differently.", 422);
      err.response.data.problems = problems;
      throw err;
    }

    const proposed = {
      name: String(value.workflow.name || workflow.name).slice(0, 250),
      description: value.workflow.description ?? workflow.description ?? "",
      trigger: value.workflow.trigger,
      definition: value.workflow.definition,
    };
    const strings = (list) => (Array.isArray(list) ? list.filter((x) => typeof x === "string" && x.trim()) : []);
    return {
      workflow: proposed,
      summary: strings(value.summary),
      notes: strings(value.notes),
      diff: diffWorkflows(workflow, proposed),
      placeholders: placeholdersIn(proposed),
    };
  } catch (err) {
    throw workflowRouteError(err);
  }
}

/**
 * POST /api/workflows/:id/flowchart — { svg }: the workflow's step graph as a
 * self-contained SVG, sanitized (scripts, event handlers, foreignObject and
 * external references stripped) since it is injected into the DOM.
 */
export async function generateWorkflowFlowchart(id) {
  try {
    const workflow = await withApiRetry(() => iscGet(`/v2026/workflows/${encodeURIComponent(id)}`), { label: `workflow flowchart: fetch ${id}` });
    const raw = await generateText(
      `Render this SailPoint ISC workflow's logic as a flowchart in a single self-contained SVG.\n\n` +
        `Requirements:\n` +
        `- Respond with ONLY the SVG markup — no prose, no markdown fences.\n` +
        `- <svg> root with viewBox="0 0 640 H" (pick H to fit; width scales to its container), no fixed width/height attributes.\n` +
        `- Start with the trigger, then follow the step graph from the definition's "start" through nextStep/choiceList links, including every branch and end state.\n` +
        `- Rounded rectangles for steps (short title plus a one-line detail), a distinct color for choice/decision steps, gray for start/end. Label decision branches (e.g. Yes/No).\n` +
        `- CRITICAL: wrap each step's shapes and text in a <g data-step="STEP_KEY"> element, where STEP_KEY is that step's EXACT key in definition.steps (copy it verbatim, including spaces and casing). Wrap the trigger node in <g data-step="__trigger__">. Every drawn node must have its data-step group; don't invent keys that aren't in definition.steps.\n` +
        `- Use only inline fills/strokes with good contrast on white; sans-serif text, 13-14px titles, 11-12px details; arrows via a marker def.\n` +
        `- Keep every element inside the viewBox; no <script>, no <foreignObject>, no external references.\n\n` +
        `Workflow JSON:\n${JSON.stringify(workflow, null, 2)}`,
      { maxTokens: 4000 }
    );
    const match = (raw || "").match(/<svg[\s\S]*<\/svg>/i);
    if (!match) throw badRequest("The AI response didn't contain an SVG — try again.", 502);
    const svg = match[0]
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, "")
      .replace(/\son\w+="[^"]*"/gi, "")
      .replace(/\son\w+='[^']*'/gi, "")
      .replace(/(href|xlink:href)="(?!#)[^"]*"/gi, "");
    return { svg };
  } catch (err) {
    throw routeError(err);
  }
}
