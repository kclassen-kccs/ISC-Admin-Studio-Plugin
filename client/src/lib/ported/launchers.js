/**
 * ported/launchers.js
 * Browser-side port of the old Express /api/launchers/:id/entitlement routes
 * (find the launcher's entitlement; make it requestable).
 *
 * ISC creates an entitlement for every launcher on its internal "IdentityNow"
 * source (that's what gets requested/assigned so the launcher shows in the
 * Launchpad). The API has no link from launcher to entitlement and ISC
 * doesn't document the entitlement's attribute/value format, so this finds
 * it on that source: an entitlement whose value carries the launcher's id
 * first, else one named like the launcher that isn't a plain user-level
 * group. The match (and how it matched) is logged so the real format shows.
 *
 * Each export returns the same body the route used to send. Failures throw
 * routeError() so callers still read err.response.data.error.
 */

import { iscGet, iscPatch, iscSearchPage, fetchAllPaged, describeError, routeError } from "../isc";

async function identityNowSourceId() {
  const byName = await iscGet("/v2026/sources", { filters: 'name eq "IdentityNow"', limit: 1 });
  if (Array.isArray(byName) && byName[0]?.id) return byName[0].id;
  const { items } = await iscSearchPage(
    { indices: ["entitlements"], query: { query: 'source.name:"IdentityNow"' }, queryResultFilter: { includes: ["source"] } },
    { limit: 1 }
  );
  return items[0]?.source?.id || null;
}

// Finds the launcher's entitlement on the IdentityNow source — see above.
// Resolves to { entitlement | null, matchedBy, sourceId, reason? }.
async function findLauncherEntitlement(launcher) {
  const sourceId = await identityNowSourceId();
  if (!sourceId) return { entitlement: null, matchedBy: null, sourceId: null, reason: "This tenant's internal IdentityNow source wasn't found." };
  const ents = await fetchAllPaged("/v2026/entitlements", { filters: `source.id eq "${sourceId}"` });
  const id = String(launcher.id || "").toLowerCase();
  const name = String(launcher.name || "").trim().toLowerCase();
  const nameOf = (e) => String(e.displayName || e.name || "").trim().toLowerCase();
  let matchedBy = null;
  let entitlement = ents.find((e) => id && String(e.value || "").toLowerCase().includes(id));
  if (entitlement) matchedBy = "value";
  if (!entitlement) {
    entitlement = ents.find((e) => /launch/i.test(`${e.attribute} ${e.sourceSchemaObjectType} ${e.schema || ""}`) && nameOf(e) === name);
    if (entitlement) matchedBy = "launcher-type name";
  }
  if (!entitlement) {
    entitlement = ents.find((e) => e.attribute !== "assignedGroups" && nameOf(e) === name);
    if (entitlement) matchedBy = "name";
  }
  if (entitlement) {
    console.log(`[launchers] ${launcher.id} entitlement ${entitlement.id} matched by ${matchedBy}: attribute=${entitlement.attribute} type=${entitlement.sourceSchemaObjectType} value=${entitlement.value}`);
  } else {
    console.log(`[launchers] ${launcher.id} ("${launcher.name}"): no entitlement found among ${ents.length} on the IdentityNow source`);
  }
  return { entitlement: entitlement || null, matchedBy, sourceId };
}

// Launchers waiting for ISC to create their entitlement so it can be made
// requestable: launcherId -> { startedAt, until }. The server kept this in
// its own memory; here it lives in the page, so the wait only continues
// while this tab stays open.
const pendingLauncherRequestable = new Map();
const LAUNCHER_ENT_POLL_MS = 20 * 1000;
const LAUNCHER_ENT_WAIT_MS = 10 * 60 * 1000;

/**
 * GET /api/launchers/:id/entitlement —
 * { entitlement | null, matchedBy, sourceId, reason?, pendingRequestable }
 */
export async function getLauncherEntitlement(id) {
  try {
    const launcher = await iscGet(`/v2026/launchers/${encodeURIComponent(id)}`);
    const result = await findLauncherEntitlement(launcher);
    return { ...result, pendingRequestable: pendingLauncherRequestable.has(String(id)) };
  } catch (err) {
    console.error("[launchers] entitlement lookup failed:", err.response?.data || err.message);
    throw routeError(err);
  }
}

async function makeRequestable(launcherId, entitlementId) {
  await iscPatch(`/v2026/entitlements/${encodeURIComponent(entitlementId)}`, [{ op: "replace", path: "/requestable", value: true }]);
  console.log(`[launchers] ${launcherId}: entitlement ${entitlementId} made requestable`);
}

/**
 * POST /api/launchers/:id/entitlement/requestable — make the launcher's
 * entitlement requestable. ISC creates that entitlement a few minutes after
 * the launcher, so when it isn't there yet this keeps checking in the
 * background (every 20 s, up to 10 min) and applies it once it appears.
 * Answers { status: "done" | "pending", entitlementId? }.
 */
export async function makeLauncherEntitlementRequestable(id) {
  const launcherId = String(id);
  try {
    const launcher = await iscGet(`/v2026/launchers/${encodeURIComponent(launcherId)}`);
    const { entitlement } = await findLauncherEntitlement(launcher);
    if (entitlement) {
      if (!entitlement.requestable) await makeRequestable(launcherId, entitlement.id);
      return { status: "done", entitlementId: entitlement.id };
    }
    if (!pendingLauncherRequestable.has(launcherId)) {
      const until = Date.now() + LAUNCHER_ENT_WAIT_MS;
      pendingLauncherRequestable.set(launcherId, { startedAt: Date.now(), until });
      console.log(`[launchers] ${launcherId}: entitlement not there yet — will make it requestable when ISC creates it`);
      (async () => {
        try {
          while (Date.now() < until) {
            await new Promise((r) => setTimeout(r, LAUNCHER_ENT_POLL_MS));
            try {
              const found = await findLauncherEntitlement(launcher);
              if (found.entitlement) {
                if (!found.entitlement.requestable) await makeRequestable(launcherId, found.entitlement.id);
                return;
              }
            } catch (err) {
              console.warn(`[launchers] ${launcherId}: requestable check failed: ${describeError(err)}`);
            }
          }
          console.warn(`[launchers] ${launcherId}: entitlement didn't appear within ${LAUNCHER_ENT_WAIT_MS / 60000} min — not made requestable`);
        } finally {
          pendingLauncherRequestable.delete(launcherId);
        }
      })();
    }
    return { status: "pending" };
  } catch (err) {
    console.error("[launchers] make requestable failed:", err.response?.data || err.message);
    throw routeError(err);
  }
}
