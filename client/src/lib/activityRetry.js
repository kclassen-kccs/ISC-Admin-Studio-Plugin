import {
  aggregateSourceAccounts, aggregateSourceEntitlements, testSourceConfiguration,
  processIdentity, synchronizeIdentityAttributes, setAccountEnabled,
  findIdentityIdByName, findSourceIdByName, findAccountId,
} from "./sailpoint";

// ─── What "Retry" means for a failed activity ────────────────────────────────
// ISC has no call that re-runs a failed transaction — the event / account
// activity is only a record. A retry is therefore a NEW operation that is
// equivalent to the one that failed, and only some failures have one:
//
//   aggregation, test connection  → run it again (same call, same source)
//   account enable / disable      → make the same call again
//   attribute sync                → re-run attribute sync for the identity
//   provisioning ISC still owes   → reprocess the identity: ISC re-evaluates
//     (account create / modify,     it and "enforces provisioning for any
//      entitlement add / remove)    assigned accesses that haven't been
//                                   fulfilled" (startIdentityProcessing)
//
// Deliberately NOT offered: re-submitting an access request in place of a
// failed entitlement change — it would turn role-driven access into a direct
// assignment and start its own approvals, i.e. a different operation.
//
// retryPlan() returns either
//   { retryable: true, key, label, title, message, confirmLabel, run() → toast text }
//   { retryable: false, reason }
// `key` names the OPERATION, not the failure: sixteen failed entitlement adds
// for one person are all retried by one "reprocess that identity", so a bulk
// retry runs each distinct key once (see runBulkRetry).
// ctx: { sourceId?, identityId? } — whichever the screen already knows.

const REPROCESS_NOTE =
  "ISC recalculates the identity, re-evaluates its roles and re-issues any provisioning it still considers owed — that is how the failed operation is retried. " +
  "It runs as a background task; the outcome appears here as new activity in a minute or two. " +
  "If the cause hasn't been fixed (a connector or configuration error rather than an outage or timeout), it will fail the same way.";

const REMOVAL_CAVEAT =
  " Note: this retries removals ISC still owes (access lost with a role or lifecycle state). A removal that came from a one-off revoke request or a certification isn't re-issued by reprocessing.";

function reprocessPlan({ identityId, identityName, what, removal }) {
  return {
    retryable: true,
    key: `process:${identityId || `name:${identityName}`}`,
    label: "Retry — reprocess identity",
    title: `Reprocess ${identityName || "this identity"}?`,
    message: `${what} ${REPROCESS_NOTE}${removal ? REMOVAL_CAVEAT : ""}`,
    confirmLabel: "Reprocess Identity",
    run: async () => {
      const id = identityId || (identityName ? await findIdentityIdByName(identityName) : null);
      if (!id) throw new Error(`Couldn't match "${identityName}" to exactly one identity, so nothing was run.`);
      await processIdentity(id);
      return "Identity reprocessing started — check back here for the new activity";
    },
  };
}

async function resolveSourceId(ctx, sourceName) {
  const id = ctx.sourceId || (sourceName ? await findSourceIdByName(sourceName) : null);
  if (!id) throw new Error(`Couldn't match "${sourceName}" to exactly one source, so nothing was run.`);
  return id;
}

const NOT_RETRYABLE = {
  AUTHENTICATION_REQUEST_FAILED: "A failed sign-in can't be retried for someone — the person signs in again themselves.",
  "ROLE PROPAGATION_FAILED": "ISC has no API to re-run role propagation. Saving the role again (or reprocessing the affected identities) triggers it.",
};

function eventPlan(event, ctx) {
  const t = String(event.technicalName || "").toUpperCase();
  const a = event.attributes || {};
  const sourceName = a.sourceName;
  // Provisioning events name the identity in target.name (its unique name).
  const identityName = event.target?.name;

  if (t === "SOURCE_ACCOUNT_AGGREGATE_FAILED" || t === "SOURCE_ENTITLEMENT_AGGREGATE_FAILED") {
    const entitlements = t.includes("ENTITLEMENT");
    return {
      retryable: true,
      key: `aggregate-${entitlements ? "entitlements" : "accounts"}:${ctx.sourceId || `name:${sourceName}`}`,
      label: "Retry aggregation",
      title: `Run ${entitlements ? "entitlement" : "account"} aggregation again?`,
      message: `Starts a new ${entitlements ? "entitlement" : "account"} aggregation of ${sourceName || "this source"} — the same operation that failed. Progress shows under Aggregation History.`,
      confirmLabel: "Start Aggregation",
      run: async () => {
        const id = await resolveSourceId(ctx, sourceName);
        await (entitlements ? aggregateSourceEntitlements(id) : aggregateSourceAccounts(id));
        return `${entitlements ? "Entitlement" : "Account"} aggregation started`;
      },
    };
  }
  if (t === "SOURCE_TEST_CONNECTION_FAILED") {
    return {
      retryable: true,
      key: `test-connection:${ctx.sourceId || `name:${sourceName}`}`,
      label: "Retry test connection",
      title: "Test the connection again?",
      message: `Runs the connector's test-connection check on ${sourceName || "this source"} now. It changes nothing on the source.`,
      confirmLabel: "Test Connection",
      run: async () => {
        const result = await testSourceConfiguration(await resolveSourceId(ctx, sourceName));
        if (result?.status === "SUCCESS") return "Test connection succeeded";
        throw new Error(`Test connection failed again${result?.details?.error ? `: ${result.details.error}` : ""}`);
      },
    };
  }
  if (t === "ACCOUNT_ENABLE_FAILED" || t === "ACCOUNT_DISABLE_FAILED") {
    const enable = t === "ACCOUNT_ENABLE_FAILED";
    const nativeIdentity = a.accountNativeIdentity || a.accountName;
    if (!nativeIdentity) return { retryable: false, reason: "The event doesn't say which account it was for, so the same call can't be made again." };
    return {
      retryable: true,
      key: `${enable ? "enable" : "disable"}:${ctx.sourceId || `name:${sourceName}`}:${nativeIdentity}`,
      label: `Retry — ${enable ? "enable" : "disable"} account`,
      title: `${enable ? "Enable" : "Disable"} the account again?`,
      message: `Sends the same ${enable ? "enable" : "disable"} request for account ${nativeIdentity} on ${sourceName || "this source"}. The result appears here as new activity.`,
      confirmLabel: enable ? "Enable Account" : "Disable Account",
      danger: !enable,
      run: async () => {
        const sourceId = await resolveSourceId(ctx, sourceName);
        const accountId = await findAccountId({ sourceId, nativeIdentity });
        if (!accountId) throw new Error(`Couldn't match account "${nativeIdentity}" to exactly one account on the source, so nothing was run.`);
        await setAccountEnabled(accountId, enable);
        return `Account ${enable ? "enable" : "disable"} submitted`;
      },
    };
  }
  if (["ACCOUNT_CREATE_FAILED", "ACCOUNT_MODIFY_FAILED", "ENTITLEMENT_ADD_FAILED", "ENTITLEMENT_REMOVE_FAILED"].includes(t)) {
    if (!ctx.identityId && !identityName) return { retryable: false, reason: "The event doesn't name the identity it was for, so there is nothing to reprocess." };
    return reprocessPlan({
      identityId: ctx.identityId,
      identityName,
      what: `"${event.name || t}"${sourceName ? ` on ${sourceName}` : ""} can't be re-run directly.`,
      removal: t === "ENTITLEMENT_REMOVE_FAILED",
    });
  }
  if (NOT_RETRYABLE[t]) return { retryable: false, reason: NOT_RETRYABLE[t] };
  return { retryable: false, reason: "ISC has no equivalent operation for this kind of event, so it can't be retried from here." };
}

function accountActivityPlan(activity, ctx) {
  const identityId = ctx.identityId || activity.recipient?.id;
  const identityName = activity.recipient?.name;
  if (!identityId) return { retryable: false, reason: "The activity doesn't say which identity it was for, so there is nothing to reprocess." };
  if (activity.status === "Pending" || activity.status === "Retrying") {
    return { retryable: false, reason: `This activity is still ${String(activity.status).toLowerCase()} — ISC hasn't finished with it, so there is nothing to retry yet.` };
  }
  if (/attribute\s*sync/i.test(activity.action || "")) {
    return {
      retryable: true,
      key: `attribute-sync:${identityId}`,
      label: "Retry attribute sync",
      title: `Sync ${identityName || "this identity"}'s attributes again?`,
      message: "Re-runs attribute sync for this identity — the same operation that failed — pushing its synced attributes to its accounts. It runs as a background job; the outcome appears here as new activity.",
      confirmLabel: "Sync Attributes",
      run: async () => {
        await synchronizeIdentityAttributes(identityId);
        return "Attribute sync started";
      },
    };
  }
  const requests = Array.isArray(activity.accountRequests) ? activity.accountRequests : [];
  const onlyRemovals =
    requests.length > 0 &&
    requests.every((r) => r.op === "Delete" || (Array.isArray(r.attributeRequests) && r.attributeRequests.length > 0 && r.attributeRequests.every((x) => x.op === "Remove")));
  return reprocessPlan({
    identityId,
    identityName,
    what: `"${activity.action || "This activity"}" can't be re-run directly.`,
    removal: onlyRemovals,
  });
}

export function retryPlan(kind, item, ctx = {}) {
  return kind === "accountActivity" ? accountActivityPlan(item, ctx) : eventPlan(item, ctx);
}

// The event types eventPlan() has a retry for — lets the "Retryable only"
// filter be applied by ISC's search rather than only to what's loaded.
export const RETRYABLE_EVENT_NAMES = [
  "SOURCE_ACCOUNT_AGGREGATE_FAILED", "SOURCE_ENTITLEMENT_AGGREGATE_FAILED", "SOURCE_TEST_CONNECTION_FAILED",
  "ACCOUNT_ENABLE_FAILED", "ACCOUNT_DISABLE_FAILED",
  "ACCOUNT_CREATE_FAILED", "ACCOUNT_MODIFY_FAILED", "ENTITLEMENT_ADD_FAILED", "ENTITLEMENT_REMOVE_FAILED",
];

/**
 * Retries a selection in one pass: OLDEST FIRST, one operation at a time
 * (order matters — a disable that failed before an enable must be re-sent
 * before it), each distinct operation once. A failure doesn't stop the run.
 * entries: [{ item, plan }]. onProgress(done, total) after each operation.
 * Returns { ran: [{ item, plan, message }], covered: [{ item, plan }], failed: [{ item, plan, error }] }.
 */
export async function runBulkRetry(entries, onProgress) {
  const ordered = [...entries].sort((a, b) => String(a.item.created || "").localeCompare(String(b.item.created || "")));
  const total = new Set(ordered.map((e) => e.plan.key)).size;
  const outcome = new Map(); // key → "ran" | "failed"
  const result = { ran: [], covered: [], failed: [] };
  for (const entry of ordered) {
    const { plan } = entry;
    if (outcome.has(plan.key)) {
      // Same operation as an earlier (older) failure in this run. If that
      // one couldn't be started, this one wouldn't either — report it once.
      if (outcome.get(plan.key) === "ran") result.covered.push(entry);
      continue;
    }
    try {
      const message = await plan.run();
      outcome.set(plan.key, "ran");
      result.ran.push({ ...entry, message });
    } catch (err) {
      outcome.set(plan.key, "failed");
      result.failed.push({ ...entry, error: err.response?.data?.messages?.[0]?.text || err.response?.data?.error || err.message });
    }
    onProgress?.(outcome.size, total);
  }
  return result;
}
