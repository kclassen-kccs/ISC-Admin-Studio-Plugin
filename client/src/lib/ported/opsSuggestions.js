/**
 * ported/opsSuggestions.js
 * Browser port of the retired server's /api/insights/ops routes: the AI
 * "explain and suggest a fix" for a failed audit event (Tools > Operations /
 * Event Log), an account activity, a run of connector log lines, or a failed
 * workflow execution. The prompt, the facts chosen per kind, and the secret
 * redaction are the server's; the model call goes through lib/aiProxy.js,
 * so by default it runs on the tenant's "Admin Studio AI Query" workflow.
 *
 * Suggestions are saved per tenant + item id in IndexedDB (store
 * "ops-suggestions", as the server's file was named) so re-opening an item
 * never re-spends an AI call; an event is immutable once logged. Same
 * return shapes as the routes; failures throw routeError()/badRequest().
 */

import { badRequest, routeError } from "../isc";
import { recordStore } from "../store";
import { tenantKey } from "./roleShared";
import { generateText } from "../aiProxy";

const store = () => recordStore("ops-suggestions");
const cacheKey = (cacheId) => `${tenantKey()}:${cacheId}`;

const OPS_EVENT_FACT_KEYS = [
  "id", "created", "name", "type", "action", "operation", "status", "technicalName", "objects", "actor", "target",
  "stack", "trackingNumber", "ipAddress", "details", "attributes", "errors", "warnings", "message",
];
const OPS_ACTIVITY_FACT_KEYS = [
  "id", "created", "modified", "action", "status", "stage", "sources", "requester", "recipient", "errors", "warnings",
  "accountRequests", "originalRequests", "expansionItems", "approvals", "trackingNumber",
];

function summarizeEventForAi(event, factKeys = OPS_EVENT_FACT_KEYS) {
  const lines = [];
  for (const key of factKeys) {
    const v = event?.[key];
    if (v == null || v === "" || (Array.isArray(v) && v.length === 0)) continue;
    const text = typeof v === "string" ? v : JSON.stringify(v);
    lines.push(`${key}: ${text.length > 1500 ? `${text.slice(0, 1500)}…` : text}`);
  }
  return lines.join("\n");
}

// Connector logs — DEBUG ones especially — can carry credentials. Nothing
// leaves for the AI provider without the obvious shapes scrubbed.
const SECRET_KEY_PATTERN = "(?:pass(?:word|wd)?|secret|token|api[-_]?key|authorization|credential|private[-_]?key|client[-_]?secret|refresh[-_]?token|access[-_]?token|cookie|session[-_]?id)";
export function redactSecrets(text) {
  return String(text)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, "[REDACTED_JWT]")
    .replace(new RegExp(`("?[\\w.-]*${SECRET_KEY_PATTERN}[\\w.-]*"?\\s*[:=]\\s*)("[^"]*"|'[^']*'|[^\\s,;}&]+)`, "gi"), "$1[REDACTED]");
}

const OPS_LOG_MAX_LINES = 60;
const OPS_LOG_MAX_LINE_CHARS = 1200;
function summarizeLogLinesForAi(item) {
  const head = [`source: ${item.sourceName || "unknown"}`, item.connector ? `connector: ${item.connector}` : null, item.requestID ? `request id: ${item.requestID}` : null].filter(Boolean);
  const lines = (Array.isArray(item.lines) ? item.lines : []).slice(-OPS_LOG_MAX_LINES).map((l) => {
    const raw = typeof l?.message === "string" ? l.message : JSON.stringify(l?.message ?? "");
    const text = redactSecrets(raw);
    return `${l?.focus ? ">>> " : "    "}${l?.timestamp || ""} ${l?.level || ""} ${l?.event || ""} ${text.length > OPS_LOG_MAX_LINE_CHARS ? `${text.slice(0, OPS_LOG_MAX_LINE_CHARS)}…` : text}`;
  });
  return [...head, "", ...lines].join("\n");
}

const OPS_WF_MAX_EVENTS = 80;
const OPS_WF_MAX_FAILURE_CHARS = 3000;
function summarizeWorkflowExecutionForAi(item) {
  const clip = (text, n) => (text.length > n ? `${text.slice(0, n)}…` : text);
  const head = [
    `workflow: ${item.workflowName || "unknown"}`,
    item.trigger ? `trigger: ${clip(JSON.stringify(item.trigger), 600)}` : null,
    `execution: ${item.id} · status ${item.status || "?"} · started ${item.startTime || "?"} · ended ${item.closeTime || "?"}`,
  ].filter(Boolean);
  const steps = (Array.isArray(item.steps) ? item.steps : []).slice(0, 60).map((st) => `  ${st.name} — ${st.type || "?"}${st.actionId ? ` (${st.actionId})` : ""}`);
  const events = (Array.isArray(item.events) ? item.events : []).slice(-OPS_WF_MAX_EVENTS).map((e) => {
    const failed = /Failed$/.test(e?.type || "");
    const attrs = redactSecrets(JSON.stringify(e?.attributes ?? {}));
    return `${failed ? ">>> " : "    "}${e?.timestamp || ""} ${e?.type || ""} ${clip(attrs, failed ? OPS_WF_MAX_FAILURE_CHARS : 240)}`;
  });
  return [...head, "", "steps as defined:", ...steps, "", "event history:", ...events].join("\n");
}

const OPS_SUGGEST_KINDS = {
  event: {
    factKeys: OPS_EVENT_FACT_KEYS,
    intro: "Below is one failed event from the tenant's audit/event log, as ISC's search API returns it.",
  },
  accountActivity: {
    factKeys: OPS_ACTIVITY_FACT_KEYS,
    intro:
      "Below is one account activity (a provisioning transaction carried out for one identity) that did not complete " +
      "cleanly, as ISC's search API returns it. accountRequests are the per-account operations ISC attempted, each " +
      "with its own result; originalRequests are what was asked for before ISC expanded it.",
  },
  connectorLog: {
    intro:
      "Below are log lines from a SaaS (cloud-hosted, sp-connect) connector in the tenant, oldest first, all from the " +
      "same connector command where a request id is shown. The admin asked about the line marked >>>. Lines are " +
      "as the connector wrote them; secrets have been redacted.",
    summarize: (item) => summarizeLogLinesForAi(item),
  },
  workflowExecution: {
    intro:
      "Below is one failed run (execution) of an ISC workflow: the run itself, the workflow's steps as defined, and the " +
      "run's event history oldest first — events whose type ends in Failed carry the error. Secrets have been redacted. " +
      "In the fix, name the workflow step involved and what to change in it (its inputs, a JSONPath expression, the " +
      "trigger's filter, a missing loop/condition, credentials of an HTTP step, and so on).",
    summarize: (item) => summarizeWorkflowExecutionForAi(item),
  },
};

/** An audit event keeps its bare id; the other kinds are prefixed. */
export const aiSuggestionCacheId = (kind, id) => (kind === "event" ? String(id) : `${kind}:${id}`);

/** GET /api/insights/ops/suggestions — [{ eventId, generatedAt }] for this tenant. */
export async function listEventFixSuggestions() {
  const prefix = `${tenantKey()}:`;
  return Object.entries(await store().all())
    .filter(([key, rec]) => key.startsWith(prefix) && rec?.suggestion)
    .map(([, rec]) => ({ eventId: rec.eventId, generatedAt: rec.generatedAt }));
}

/** GET /api/insights/ops/suggest/:id — the saved suggestion, or { suggestion: null }. */
export async function getEventFixSuggestion(cacheId) {
  const cached = await store().get(cacheKey(cacheId));
  if (!cached?.suggestion) return { suggestion: null };
  return { suggestion: cached.suggestion, cached: true, generatedAt: cached.generatedAt };
}

/** The prompt the server sent, for one kind and item. */
export function buildFixPrompt(kind, item) {
  const kindConfig = OPS_SUGGEST_KINDS[kind];
  return (
    `You are a senior SailPoint Identity Security Cloud (ISC) administrator. ${kindConfig.intro} Explain, in plain ` +
    "prose for another ISC admin, " +
    "(1) what most likely went wrong, based only on the facts given, and (2) the concrete steps to correct it — " +
    "which ISC screen or API to use, what to check on the source/connector, identity, role or workflow involved, " +
    "and how to confirm the fix. If the facts alone can't determine the cause, say what to look at next. " +
    "Keep it under 220 words, no markdown, no headings, no preamble.\n\n" +
    (kindConfig.summarize ? kindConfig.summarize(item) : summarizeEventForAi(item, kindConfig.factKeys))
  );
}

/**
 * POST /api/insights/ops/suggest — { suggestion, cached, generatedAt }.
 * kind: "event" | "accountActivity" | "connectorLog" | "workflowExecution".
 */
export async function suggestFix(kind = "event", item, { refresh = false } = {}) {
  if (!OPS_SUGGEST_KINDS[kind]) throw badRequest(`Unknown kind "${kind}".`);
  if (!item || typeof item !== "object" || !item.id) throw badRequest("An item with an id is required (event: an ISC event document).");
  if (kind === "connectorLog" && !(Array.isArray(item.lines) && item.lines.length)) throw badRequest("connectorLog needs at least one log line.");
  if (kind === "workflowExecution" && !(Array.isArray(item.events) && item.events.length)) throw badRequest("workflowExecution needs the run's event history.");

  const cacheId = aiSuggestionCacheId(kind, item.id);
  const key = cacheKey(cacheId);
  const cached = await store().get(key);
  if (cached?.suggestion && !refresh) return { suggestion: cached.suggestion, cached: true, generatedAt: cached.generatedAt };

  let suggestion;
  try {
    suggestion = await generateText(buildFixPrompt(kind, item), { maxTokens: 600 });
  } catch (err) {
    throw routeError(err);
  }
  if (!suggestion) throw badRequest("Empty response from the AI provider.", 502);
  const record = { tenant: tenantKey(), eventId: cacheId, suggestion, generatedAt: new Date().toISOString() };
  await store().put(key, record);
  return { suggestion, cached: false, generatedAt: record.generatedAt };
}
