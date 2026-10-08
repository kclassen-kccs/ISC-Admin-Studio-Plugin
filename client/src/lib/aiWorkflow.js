/**
 * aiWorkflow.js
 * The alternate way for the plugin to reach Claude: an ISC workflow named
 * "Admin Studio AI Query" that runs on the tenant and makes the HTTP call
 * the plugin iframe itself is not allowed to make.
 *
 *   plugin ──(test execution, user's own session)──▶ workflow "Admin Studio AI Query"
 *            input { url, request }                    │ HTTP Request step, POST {{$.trigger.url}}
 *                                                      │ auth: parameter "Admin Studio AI Key" (x-api-key)
 *                                                      ▼ body: request passed through as-is
 *   plugin ◀──(execution history: the step's statusCode + body)── api.anthropic.com
 *
 * `url` comes from the "Admin Studio AI Connection" parameter (type Web App,
 * public field `url`), read here and handed to the workflow, because an HTTP
 * Request step can take a parameter for its authentication but not for its
 * URL. The API key never reaches the browser: only the workflow engine reads
 * the "Admin Studio AI Key" parameter's private value.
 *
 * Why the test endpoint: the trigger is an External Trigger, and
 * POST /workflows/execute/external/{id} accepts only the trigger's own OAuth
 * client, whose secret would otherwise have to live in the browser. The test
 * endpoint runs the same steps for real with the signed-in user's session; it
 * only requires the workflow to stay DISABLED, which is how it is created.
 *
 * isc/admin-studio-ai-query.workflow.json and scripts/setup-ai-workflow.mjs
 * create the parameters and the workflow on a tenant.
 */

import { iscGet, iscPost, badRequest, routeError } from "./isc";

export const AI_WORKFLOW_NAME = "Admin Studio AI Query";
export const AI_CONNECTION_PARAMETER = "Admin Studio AI Connection";
export const AI_KEY_PARAMETER = "Admin Studio AI Key";

const LOOKUP_TTL_MS = 10 * 60 * 1000;
const POLL_MS = 1000;
const DEFAULT_TIMEOUT_MS = 190_000;

const sameName = (a, b) => String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One iframe serves one tenant, so a plain module cache is per tenant.
const cache = { workflow: null, url: null, at: 0 };

async function lookups() {
  if (cache.workflow && cache.url && Date.now() - cache.at < LOOKUP_TTL_MS) return cache;
  const [workflows, parameters] = await Promise.all([
    iscGet("/v2026/workflows", { limit: 250 }),
    iscGet("/v2026/parameter-storage/parameters", { limit: 250 }),
  ]);
  const workflow = (Array.isArray(workflows) ? workflows : []).find((w) => sameName(w.name, AI_WORKFLOW_NAME)) || null;
  const connection = (Array.isArray(parameters) ? parameters : []).find((p) => sameName(p.name, AI_CONNECTION_PARAMETER)) || null;
  const url = String(connection?.publicFields?.url || "").trim() || null;
  Object.assign(cache, { workflow, url, at: Date.now() });
  return cache;
}

/** Forgets the cached lookups (tests, or after the tenant's setup changed). */
export function resetAiWorkflowCache() {
  Object.assign(cache, { workflow: null, url: null, at: 0 });
}

/** True when the tenant has the workflow and the connection parameter. */
export async function aiWorkflowAvailable() {
  try {
    const { workflow, url } = await lookups();
    return !!(workflow && url);
  } catch {
    return false;
  }
}

function describeExecutionFailure(history, status) {
  const failed = history.find((e) => e.type === "ActivityTaskFailed" || e.type === "WorkflowExecutionFailed");
  const raw = failed?.attributes?.error;
  if (typeof raw === "string" && raw) return raw.split(" (type:")[0];
  return `The ${AI_WORKFLOW_NAME} workflow ended with status ${status || "unknown"}.`;
}

/**
 * Runs one Claude Messages API request through the workflow and returns the
 * provider's JSON body (the Message object). Throws route-shaped errors.
 */
export async function runAiWorkflow(request, { timeoutMs = DEFAULT_TIMEOUT_MS, pollMs = POLL_MS } = {}) {
  let found;
  try {
    found = await lookups();
  } catch (err) {
    throw routeError(err);
  }
  const { workflow, url } = found;
  if (!workflow) throw badRequest(`This tenant has no "${AI_WORKFLOW_NAME}" workflow. Create it with scripts/setup-ai-workflow.mjs.`, 503);
  if (!url) throw badRequest(`This tenant has no "${AI_CONNECTION_PARAMETER}" parameter with a URL.`, 503);
  if (workflow.enabled) {
    throw badRequest(
      `The "${AI_WORKFLOW_NAME}" workflow must stay disabled: Admin Studio runs it as a test execution with your own session, and ISC refuses that for an enabled workflow.`,
      503
    );
  }

  let executionId;
  try {
    const started = await iscPost(`/v2026/workflows/${workflow.id}/test`, { input: { url, request } });
    executionId = started?.workflowExecutionId;
  } catch (err) {
    cache.at = 0; // the workflow may have changed; look it up again next time
    throw routeError(err);
  }
  if (!executionId) throw badRequest("ISC accepted the workflow run but returned no execution id.", 502);

  const deadline = Date.now() + timeoutMs;
  let execution;
  for (;;) {
    await sleep(pollMs);
    try {
      execution = await iscGet(`/v2026/workflow-executions/${executionId}`);
    } catch (err) {
      if (err?.response?.status !== 404) throw routeError(err); // 404: not indexed yet
    }
    const status = execution?.status;
    if (status && status !== "Executing" && status !== "Running" && status !== "Pending") break;
    if (Date.now() > deadline) throw badRequest(`The ${AI_WORKFLOW_NAME} workflow didn't finish in time.`, 504);
  }

  let history;
  try {
    history = await iscGet(`/v2026/workflow-executions/${executionId}/history`);
  } catch (err) {
    throw routeError(err);
  }
  const events = Array.isArray(history) ? history : [];
  const step = events.find((e) => e.type === "ActivityTaskCompleted" && e.attributes?.task === "sp:http");
  if (!step) throw badRequest(describeExecutionFailure(events, execution?.status), 502);
  const { statusCode, body } = step.attributes.result || {};
  if (Number(statusCode) >= 400) {
    const message = body?.error?.message || `Model provider returned ${statusCode}.`;
    throw badRequest(Number(statusCode) === 401 ? `The model provider rejected the "${AI_KEY_PARAMETER}" parameter's value: ${message}` : message, Number(statusCode) === 429 ? 429 : 502);
  }
  return body;
}
