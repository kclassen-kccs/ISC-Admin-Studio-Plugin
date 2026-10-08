/**
 * aiSetup.js
 * Sets up, on the tenant the plugin runs in, everything the "ISC workflow"
 * AI route needs, from the Anthropic API key the user types on Preferences:
 *
 *   - Parameter "Admin Studio AI Connection" (2.4 Web App): url = the Claude
 *     Messages API endpoint. Created if missing; its URL is restored if blank.
 *   - Parameter "Admin Studio AI Key" (1.3 HTTP Custom Authorization):
 *     headerName x-api-key, headerValue = the key, encrypted in the browser
 *     to SailPoint's enclave (ported/parameterCrypto.js). Created if missing,
 *     otherwise its private value is replaced with the new key.
 *   - Workflow "Admin Studio AI Query" (aiWorkflow.template.json) bound to
 *     the key parameter and left DISABLED, because the plugin runs it as a
 *     test execution (see aiWorkflow.js). Created if missing; re-bound or
 *     re-disabled if it drifted.
 *
 * Safe to run again: a key update finds everything in place, replaces the
 * secret and checks the rest. scripts/setup-ai-workflow.mjs does the same
 * from a terminal with an API client, without the key.
 */

import { iscGet, iscPost, iscPut, badRequest, routeError } from "./isc";
import { createParameter, updateParameter } from "./ported/parameters";
import { getCredentials } from "./sailpoint";
import { AI_WORKFLOW_NAME, AI_CONNECTION_PARAMETER, AI_KEY_PARAMETER, resetAiWorkflowCache } from "./aiWorkflow";
import template from "./aiWorkflow.template.json";

export const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const HTTP_STEP = "Query Claude";

const sameName = (a, b) => String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
const byName = (list, name) => (Array.isArray(list) ? list : []).find((x) => sameName(x.name, name)) || null;

function failedSecret(parameter) {
  const info = parameter?._secretNotSaved;
  if (!info) return null;
  return badRequest(`ISC saved the "${AI_KEY_PARAMETER}" parameter but refused its key value: ${info.reason}`, 502);
}

async function ensureConnection(existing) {
  const spec = {
    name: AI_CONNECTION_PARAMETER,
    description: "Anthropic Messages API endpoint used by the Admin Studio AI Query workflow.",
    publicFields: { url: ANTHROPIC_MESSAGES_URL },
  };
  if (!existing) {
    const created = await createParameter({ ...spec, type: "2.4" });
    return { id: created.id, action: "created" };
  }
  if (!String(existing.publicFields?.url || "").trim()) {
    await updateParameter(existing.id, { publicFields: spec.publicFields });
    return { id: existing.id, action: "repaired" };
  }
  return { id: existing.id, action: "present" };
}

async function ensureKey(existing, apiKey) {
  const publicFields = { headerName: "x-api-key" };
  if (!existing) {
    const created = await createParameter({
      type: "1.3",
      name: AI_KEY_PARAMETER,
      description: "Anthropic API key sent as the x-api-key header by the Admin Studio AI Query workflow.",
      publicFields,
      privateFields: { headerValue: apiKey },
    });
    const refused = failedSecret(created);
    if (refused) throw refused;
    return { id: created.id, action: "created" };
  }
  const headerOk = String(existing.publicFields?.headerName || "").toLowerCase() === "x-api-key";
  const updated = await updateParameter(existing.id, {
    ...(headerOk ? {} : { publicFields }),
    privateFields: { headerValue: apiKey },
  });
  const refused = failedSecret(updated);
  if (refused) throw refused;
  return { id: existing.id, action: "updated" };
}

function workflowBody(keyParameterId) {
  const body = JSON.parse(JSON.stringify(template));
  body.definition.steps[HTTP_STEP].attributes.param_header.paramID = keyParameterId;
  body.enabled = false;
  return body;
}

function isBound(workflow, keyParameterId) {
  return workflow?.definition?.steps?.[HTTP_STEP]?.attributes?.param_header?.paramID === keyParameterId;
}

async function ensureWorkflow(existing, keyParameterId) {
  const body = workflowBody(keyParameterId);
  let workflow = existing;
  let action = "present";
  if (!workflow) {
    const identityId = getCredentials()?.identityId;
    workflow = await iscPost("/v2026/workflows", { ...body, ...(identityId ? { owner: { type: "IDENTITY", id: identityId } } : {}) });
    action = "created";
  }
  // A POST drops the parameter binding (paramID and the reference ISC creates
  // for it); only a PUT keeps it. The same PUT puts a drifted workflow back.
  if (!isBound(workflow, keyParameterId) || workflow.enabled) {
    workflow = await iscPut(`/v2026/workflows/${workflow.id}`, { ...body, owner: workflow.owner });
    if (action !== "created") action = workflow.enabled === false && existing?.enabled ? "disabled" : "repaired";
  }
  return { id: workflow.id, action };
}

/**
 * Creates or updates the two parameters and the workflow for the given key.
 * Returns { connection, key, workflow }, each { id, action } with action one of
 * created | updated | repaired | disabled | present. Throws route-shaped errors.
 */
export async function provisionAiWorkflow(apiKey) {
  const key = String(apiKey || "").trim();
  if (!key) throw badRequest("An Anthropic API key is required.");
  try {
    const [parameters, workflows] = await Promise.all([
      iscGet("/v2026/parameter-storage/parameters", { limit: 250 }),
      iscGet("/v2026/workflows", { limit: 250 }),
    ]);
    const connection = await ensureConnection(byName(parameters, AI_CONNECTION_PARAMETER));
    const keyParameter = await ensureKey(byName(parameters, AI_KEY_PARAMETER), key);
    const workflow = await ensureWorkflow(byName(workflows, AI_WORKFLOW_NAME), keyParameter.id);
    resetAiWorkflowCache();
    return { connection, key: keyParameter, workflow };
  } catch (err) {
    resetAiWorkflowCache();
    throw routeError(err);
  }
}

/** One line for the Preferences screen, e.g. "Created the AI parameters and workflow on this tenant." */
export function describeAiSetup(result) {
  if (!result) return "";
  const { connection, key, workflow } = result;
  const created = [connection, key, workflow].filter((r) => r.action === "created").length;
  if (created === 3) return "Created the AI connection, key parameter and workflow on this tenant.";
  const parts = [];
  parts.push(key.action === "created" ? `created the "${AI_KEY_PARAMETER}" parameter` : `updated the "${AI_KEY_PARAMETER}" parameter`);
  if (connection.action === "created") parts.push(`created the "${AI_CONNECTION_PARAMETER}" parameter`);
  else if (connection.action === "repaired") parts.push(`restored the "${AI_CONNECTION_PARAMETER}" URL`);
  if (workflow.action === "created") parts.push(`created the "${AI_WORKFLOW_NAME}" workflow`);
  else if (workflow.action === "repaired") parts.push(`re-bound the "${AI_WORKFLOW_NAME}" workflow to the key`);
  else if (workflow.action === "disabled") parts.push(`disabled the "${AI_WORKFLOW_NAME}" workflow (it must stay disabled)`);
  const checked = [connection, workflow].filter((r) => r.action === "present").length;
  if (checked === 2) parts.push("the connection parameter and workflow are in place");
  else if (checked === 1) parts.push(connection.action === "present" ? "the connection parameter is in place" : "the workflow is in place");
  const line = parts.join("; ");
  return `${line.charAt(0).toUpperCase()}${line.slice(1)}.`;
}
