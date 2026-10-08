/**
 * ported/workflows.js
 * Browser-side port of the old Express /api/workflows/* routes that only
 * talk to ISC: structural validation against the tenant's workflow library
 * (POST /validate), delete (disable first), save (disable → PUT → re-enable)
 * and enable/disable. The AI routes (/ai/outline, /ai/create, /:id/ai/modify,
 * /:id/flowchart) are in ./workflowAi.js.
 *
 * Each export returns the same body the route used to send. Failures throw
 * routeError()/badRequest() so callers still read err.response.data.error.
 */

import { iscGet, iscPut, iscPatch, iscDelete, describeError, badRequest } from "../isc";
import { getCredentials } from "../sailpoint";

// ─── ISC's workflow error shape ─────────────────────────────────────────────
// ISC's workflow endpoints answer a rejected save / enable with
//   { message: "Please fix the following validation errors…", details: { "Error 1": "step '…' has errors: …" } }
// — the message alone says nothing; the reasons are in `details`. (Its other
// endpoints use messages[0].text.) One place that reads every shape.
export function iscWorkflowErrorText(err) {
  const data = err.response?.data;
  const head = data?.messages?.[0]?.text || data?.message || data?.error || describeError(err);
  const details = data?.details;
  const lines =
    details && typeof details === "object"
      ? Object.values(details).flat().filter((d) => typeof d === "string" && d.trim())
      : typeof details === "string" && details.trim()
      ? [details]
      : [];
  return lines.length ? `${head}\n${lines.map((l) => `• ${l}`).join("\n")}` : head;
}

// Route-shaped error carrying ISC's workflow message (what the routes sent).
function workflowError(err) {
  if (err?.isRouteError) return err;
  return badRequest(iscWorkflowErrorText(err), err?.response?.status || 500);
}

const workflowPath = (id) => `/v2026/workflows/${encodeURIComponent(id)}`;
const setEnabledOp = (id, enabled) => iscPatch(workflowPath(id), [{ op: "replace", path: "/enabled", value: enabled }]);

// ─── Workflow library catalog (port of server/workflowAi.js) ────────────────

// The library lists every version of an action/trigger; keep only the
// current one (not deprecated, highest versionNumber) per id.
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
export function buildCatalog({ triggers, actions, operators }) {
  return { triggers: currentVersions(triggers), actions: currentVersions(actions), operators: currentVersions(operators) };
}

// The tenant's workflow library barely changes; don't refetch ~1MB of it on
// every check. Per tenant, 10 minutes. (In memory on purpose — it's a cache
// of ISC's data, not state.)
const workflowLibraryCache = new Map();
export async function getWorkflowCatalog() {
  const tenant = getCredentials()?.tenant || "_";
  const cached = workflowLibraryCache.get(tenant);
  if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.catalog;
  const [triggers, actions, operators] = await Promise.all(
    ["triggers", "actions", "operators"].map((kind) => iscGet(`/v2026/workflow-library/${kind}`, { limit: 250 }))
  );
  const catalog = buildCatalog({ triggers, actions, operators });
  workflowLibraryCache.set(tenant, { at: Date.now(), catalog });
  return catalog;
}

// ─── Outline validation ─────────────────────────────────────────────────────

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
export function validateOutline(outline, catalog) {
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

// ─── Workflow validation ────────────────────────────────────────────────────

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
// string starting with "$". Text that mixes in values belongs under the plain
// key with {{$.path}} templates instead. Walks everything under a step except
// a loop's nested steps (checked as their own step map).
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
 * Structural problems with a workflow (empty = safe to send to ISC). Not a
 * semantic check — ISC does that on create and on enable — but it catches a
 * dangling nextStep, a made-up action or trigger, a path that never ends.
 */
export function validateWorkflow(workflow, catalog) {
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

// ─── Routes ─────────────────────────────────────────────────────────────────

/**
 * POST /api/workflows/validate — { workflow } or { outline }.
 * Returns { state: "OK" | "ERROR", problems: [], checked: "workflow" | "outline" }.
 */
export async function validateWorkflowDraft(payload) {
  const { workflow, outline } = payload || {};
  if (!workflow && !outline) throw badRequest("workflow or outline is required.");
  try {
    const catalog = await getWorkflowCatalog();
    const problems = workflow ? validateWorkflow(workflow, catalog) : validateOutline(outline, catalog);
    return { state: problems.length ? "ERROR" : "OK", problems, checked: workflow ? "workflow" : "outline" };
  } catch (err) {
    throw badRequest(describeError(err), err.response?.status || 500);
  }
}

/**
 * DELETE /api/workflows/:id
 * ISC refuses to delete an enabled workflow, so an enabled one is disabled
 * first — and if the delete then fails, it is re-enabled rather than left
 * switched off.
 */
export async function deleteWorkflow(id) {
  try {
    const current = await iscGet(workflowPath(id));
    if (current.enabled) await setEnabledOp(id, false);
    try {
      await iscDelete(workflowPath(id));
    } catch (err) {
      if (current.enabled) await setEnabledOp(id, true).catch((e) => console.error(`[workflows] FAILED to re-enable ${id} after a failed delete:`, e.response?.data || e.message));
      throw err;
    }
  } catch (err) {
    throw workflowError(err);
  }
}

/**
 * PUT /api/workflows/:id/save — { workflow: <the PUT body>, allowDisable? }
 * ISC refuses to update a workflow while it is enabled, so this does the
 * disable → PUT (as disabled) → re-enable dance in one place, re-enabling
 * even when the PUT fails. If the edit itself sets enabled: false, it is
 * left disabled. Without allowDisable an enabled workflow gets a 409
 * { code: "WORKFLOW_ENABLED" }.
 * Returns { workflow, wasDisabledToSave, reenabled, reenableError? }.
 */
export async function updateWorkflow(id, body, { allowDisable = false } = {}) {
  if (!body || typeof body !== "object") throw badRequest("workflow (the fields to save) is required.");
  try {
    const current = await iscGet(workflowPath(id));
    if (!current.enabled) {
      const saved = await iscPut(workflowPath(id), body);
      return { workflow: saved, wasDisabledToSave: false, reenabled: false };
    }
    if (!allowDisable) {
      const conflict = badRequest("This workflow is enabled — ISC only accepts changes to a disabled workflow.", 409);
      conflict.response.data.code = "WORKFLOW_ENABLED";
      throw conflict;
    }

    const wantEnabled = body.enabled !== false;
    await setEnabledOp(id, false);
    let saved;
    let saveError = null;
    try {
      saved = await iscPut(workflowPath(id), { ...body, enabled: false });
    } catch (err) {
      saveError = err;
    }
    // Back on whether or not the save took — unless the edit was to disable it.
    let reenabled = false;
    let reenableError = null;
    if (wantEnabled || saveError) {
      try {
        await setEnabledOp(id, true);
        reenabled = true;
      } catch (err) {
        reenableError = iscWorkflowErrorText(err);
        console.error(`[workflows] FAILED to re-enable ${id}:`, err.response?.data || err.message);
      }
    }
    if (saveError) {
      throw badRequest(
        `${iscWorkflowErrorText(saveError)}${reenableError ? ` — and the workflow could NOT be re-enabled (${reenableError}); it is currently DISABLED.` : " — nothing was changed; the workflow is enabled again."}`,
        saveError.response?.status || 500
      );
    }
    return { workflow: { ...saved, enabled: reenabled }, wasDisabledToSave: true, reenabled, ...(reenableError ? { reenableError } : {}) };
  } catch (err) {
    throw workflowError(err);
  }
}

/**
 * PUT /api/workflows/:id/enabled — { enabled: boolean }.
 * ISC validates on enable and refuses an incomplete workflow with its own
 * message, passed through. Returns the updated workflow.
 */
export async function setWorkflowEnabled(id, enabled) {
  if (typeof enabled !== "boolean") throw badRequest("enabled (true or false) is required.");
  try {
    return await setEnabledOp(id, enabled);
  } catch (err) {
    throw workflowError(err);
  }
}
