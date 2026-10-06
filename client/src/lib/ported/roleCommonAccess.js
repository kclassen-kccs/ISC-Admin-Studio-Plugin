/**
 * ported/roleCommonAccess.js
 * Common Access roles — ports of the /api/roles/:id/common-access routes,
 * /api/roles/common-access-ids, /api/roles/:id/overlapping-common-access and
 * the helpers Role Evaluation / role edits share with them
 * (getCommonAccessRoleIdSet, fetchCommonAccessRoleSummaries,
 * filterApplicableCommonAccessEntIds, ...).
 *
 * Persisted state (same store names / record shapes as the old server's
 * flagged-common-access-roles.json and denied-common-access-roles.json —
 * one array of role ids per tenant, keyed by tenant):
 *
 * GET /beta/common-access doesn't reliably include a role right after it's
 * flagged — verified live: POST succeeds, a repeat POST immediately after
 * correctly 409s, yet the role never appears in a subsequent GET. So every role
 * THIS app successfully flags is recorded in "flagged-common-access-roles" and
 * unioned with whatever the list does contain. Explicit unflags are recorded in
 * "denied-common-access-roles" and subtracted from every common-access id
 * computation so neither ISC's CONFIRMED list nor this app's own scan
 * bookkeeping can resurrect a deliberately unflagged role.
 */

import { iscGet, iscPost, withApiRetry, routeError, badRequest, describeError } from "../isc";
import { recordStore } from "../store";
import {
  tenantKey,
  mapWithConcurrency,
  getTenantSettings,
  extractAllCriteriaLeaves,
  criteriaLeavesSubsetOf,
} from "./roleShared";

// /common-access/v1 (not /beta/common-access) — same "IAI Common Access"
// feature and required scope (iai:access-modeling:manage). Requires the
// Experimental opt-in header.
const EXPERIMENTAL = { "X-SailPoint-Experimental": "true" };

const flaggedStore = () => recordStore("flagged-common-access-roles");
const deniedStore = () => recordStore("denied-common-access-roles");

export async function getFlaggedCommonAccessRoleIds() {
  return (await flaggedStore().get(tenantKey())) || [];
}

export async function rememberFlaggedCommonAccessRole(roleId) {
  const ids = new Set(await getFlaggedCommonAccessRoleIds());
  ids.add(roleId);
  await flaggedStore().put(tenantKey(), [...ids]);
}

// A deleted role can't grant anything, common access or not — dropped here so
// a stale id doesn't sit around forever. No-op (and no write) if the role was
// never tracked to begin with.
export async function forgetFlaggedCommonAccessRole(roleId) {
  const ids = await getFlaggedCommonAccessRoleIds();
  if (!ids.includes(roleId)) return;
  await flaggedStore().put(tenantKey(), ids.filter((id) => id !== roleId));
}

// Kicks off ISC's own common-access analysis job — flagging a role as common
// access (or enabling one that's already flagged) doesn't get picked up
// anywhere else in ISC until this analysis runs. Best-effort at call sites.
export async function triggerCommonAccessAnalysis() {
  await iscPost("/common-access/v1", {}, { headers: EXPERIMENTAL });
}

/**
 * Flags a role as ISC common access — only works when no common-access record
 * exists for it yet (a fresh create, verified live: 201). There is no working
 * API to change an EXISTING record's status in either direction — verified live
 * that DELETE isn't even a registered method on this beta resource, and
 * PATCH/PUT against the record's own id all 404.
 */
async function flagRoleAsCommonAccess(roleId) {
  const data = await iscPost("/common-access/v1", { access: { id: roleId, type: "ROLE" } }, { headers: EXPERIMENTAL });
  await rememberFlaggedCommonAccessRole(roleId);
  const deniedNow = (await deniedStore().get(tenantKey())) || [];
  if (deniedNow.includes(roleId)) {
    await deniedStore().put(tenantKey(), deniedNow.filter((id) => id !== roleId));
  }
  try {
    await triggerCommonAccessAnalysis();
  } catch (err) {
    console.error(`[roles] common-access analysis trigger failed after flagging role ${roleId}:`, err.response?.data || err.message);
  }
  return data;
}

/**
 * POST /api/roles/:id/common-access
 * A 409 here means a record already exists (in any status) and must be changed
 * in ISC's own UI instead — there's no API to update an existing one.
 */
export async function enableRoleCommonAccess(roleId) {
  try {
    return await flagRoleAsCommonAccess(roleId);
  } catch (err) {
    if (err.response?.status === 409) {
      throw badRequest("This role already has a common-access record — change it in ISC's own UI (Admin > Access Model > Roles > Common Access), there's no API to update an existing one.", 409);
    }
    // A bare 401 with no body (verified live) isn't this app's own session —
    // ISC's IAI Common Access API itself is rejecting the token. Per SailPoint's
    // spec, POST /common-access/v1 requires the OAuth scope
    // iai:access-modeling:manage — tied to the AI Access Modeling feature, not
    // a general admin permission — so the scope was never granted or the feature
    // isn't licensed/enabled for this tenant. Worth a specific, actionable
    // message instead of the generic "Request failed with status code 401".
    if (err.response?.status === 401) {
      console.error("[roles] common-access create failed with a bare 401:", err.response?.headers);
      throw badRequest(
        "ISC rejected this with 401 on its own Common Access API (/common-access/v1) — this isn't a sign-in problem (every other action still works). " +
        "This API specifically requires the OAuth scope \"iai:access-modeling:manage\" — check whether this tenant's OAuth client/service credential has been granted it, " +
        "and whether AI Access Modeling / Common Access is licensed and enabled for this tenant. " +
        "You can also flag it directly in ISC's own UI (Admin > Access Model > Roles > Common Access) as a workaround.",
        401
      );
    }
    console.error("[roles] common-access create failed:", err.response?.data || err.message);
    throw routeError(err);
  }
}

/**
 * DELETE /api/roles/:id/common-access — unflag Common Access for a role: sets
 * the role's CONFIRMED record to DENIED in ISC (via the bulk update-status
 * endpoint — the only one that exists; per-item routes 404, verified live) and
 * records a local denial so scan bookkeeping and a stale/unreachable ISC list
 * can't resurrect it. ISC being unreachable (this API 401s on some tenants)
 * doesn't block the local unflag.
 */
export async function disableRoleCommonAccess(roleId) {
  try {
    let iscUpdated = false;
    try {
      const items = await withApiRetry(
        () => iscGet("/common-access/v1", { limit: 250 }, EXPERIMENTAL),
        { label: `unflag common access: list for role ${roleId}` }
      );
      const record = (items || []).find((i) => i.access?.type === "ROLE" && i.access?.id === roleId && i.status === "CONFIRMED");
      if (record) {
        await iscPost("/common-access/v1/update-status", [{ id: record.id, status: "DENIED" }], { headers: EXPERIMENTAL });
        iscUpdated = true;
      }
    } catch (err) {
      console.error(`[roles] unflag: ISC common-access update skipped for ${roleId}:`, err.response?.status || err.message);
    }
    await forgetFlaggedCommonAccessRole(roleId);
    const denied = (await deniedStore().get(tenantKey())) || [];
    if (!denied.includes(roleId)) await deniedStore().put(tenantKey(), [...denied, roleId]);
    return { ok: true, iscUpdated };
  } catch (err) {
    console.error("[roles] unflag common access failed:", err.response?.data || err.message);
    throw routeError(err);
  }
}

/**
 * GET /api/roles/:id/common-access -> { commonAccess: boolean, status }
 * Whether this role currently carries ISC's own "Common Access" designation.
 * Filtered server-side (access.id eq / access.type eq) since a tenant's
 * common-access list can grow.
 */
export async function getRoleCommonAccess(roleId) {
  try {
    const items = await iscGet(
      "/common-access/v1",
      { limit: 1, filters: `access.id eq "${roleId}" and access.type eq "ROLE"` },
      EXPERIMENTAL
    );
    const item = (items || [])[0] || null;
    return { commonAccess: item?.status === "CONFIRMED", status: item?.status || null };
  } catch (err) {
    console.error("[roles] common-access lookup failed:", err.response?.data || err.message);
    throw routeError(err);
  }
}

// Every role this tenant's own Role Scan / Skeleton scan records already know
// was CREATED as a Common Access proposal — a third, fully local source
// alongside the CONFIRMED list and the flagged store. Covers the case the
// flagged store can't: if the flag POST itself failed after the role was
// already created. (The scan stores are read as-is; empty until scans exist.)
async function getPersistedCommonAccessRoleIds() {
  const tenant = tenantKey();
  const ids = new Set();
  for (const scan of Object.values(await recordStore("role-scans").all())) {
    if (scan?.tenant && scan.tenant !== tenant) continue;
    for (const g of scan?.groups || []) {
      if (g.isCommonAccessScope && g.roleCreated?.id) ids.add(g.roleCreated.id);
    }
  }
  for (const scan of Object.values(await recordStore("skeleton-scans").all())) {
    if (scan?.tenant && scan.tenant !== tenant) continue;
    for (const r of scan?.results || []) {
      if (r.isCommonAccess && r.ok && r.roleId) ids.add(r.roleId);
    }
  }
  return ids;
}

// Split out of getCommonAccessRoleIdSet so a caller that needs to tell "ISC's
// own CONFIRMED list" apart from "roles this app only THINKS are Common
// Access" can. A failure reading ISC's list (this beta API 401s on some
// tenants) must not throw away the local fallback sources.
export async function getCommonAccessRoleStatus() {
  let confirmedRoleIds = [];
  let betaUnavailable = false;
  try {
    const items = await withApiRetry(
      () => iscGet("/common-access/v1", { limit: 250 }, EXPERIMENTAL),
      { label: "getCommonAccessRoleStatus: common-access/v1" }
    );
    confirmedRoleIds = (items || [])
      .filter((item) => item.status === "CONFIRMED" && item.access?.type === "ROLE" && item.access?.id)
      .map((item) => item.access.id);
  } catch (err) {
    console.error("[roles] common-access CONFIRMED list unavailable, falling back to locally-known common-access roles only:", err.response?.status || err.message);
    betaUnavailable = true;
  }
  const locallyTracked = new Set([
    ...(await getFlaggedCommonAccessRoleIds()),
    ...(await getPersistedCommonAccessRoleIds()),
  ]);
  return { confirmed: new Set(confirmedRoleIds), locallyTracked, betaUnavailable };
}

// Every role id this app considers a Common Access role — ISC's own CONFIRMED
// list, unioned with every role this app has itself flagged or created as
// Common Access, minus explicit unflags.
export async function getCommonAccessRoleIdSet() {
  const { confirmed, locallyTracked } = await getCommonAccessRoleStatus();
  const denied = new Set((await deniedStore().get(tenantKey())) || []);
  return new Set([...confirmed, ...locallyTracked].filter((id) => !denied.has(id)));
}

/** GET /api/roles/common-access-ids -> [roleId, ...] */
export async function getCommonAccessRoleIds() {
  try {
    return [...(await getCommonAccessRoleIdSet())];
  } catch (err) {
    console.error("[roles] common-access-ids failed:", err.response?.data || err.message);
    throw routeError(err);
  }
}

/**
 * Every common-access role's own membership criteria (as leaves) and granted
 * entitlements (base + every dimension's own) — the raw material
 * criteriaLeavesSubsetOf-based matching is built from.
 */
export async function fetchCommonAccessRoleSummaries() {
  const roleIds = [...(await getCommonAccessRoleIdSet())];

  const summaries = [];
  await mapWithConcurrency(roleIds, 2, async (roleId) => {
    try {
      const role = await withApiRetry(() => iscGet(`/v2026/roles/${roleId}`), { label: `fetchCommonAccessRoleSummaries: fetch role ${roleId}` });
      const entIds = new Set((role.entitlements || []).map((e) => e.id));
      if (role.dimensional) {
        const dimensions = await withApiRetry(() => iscGet(`/v2026/roles/${roleId}/dimensions`), { label: `fetchCommonAccessRoleSummaries: fetch role ${roleId} dimensions` });
        for (const d of dimensions || []) {
          for (const e of d.entitlements || []) entIds.add(e.id);
        }
      }
      // Dynamic (dimensional) roles are never common access — explicit rule. A
      // dimensional role confirmed in ISC's list (bulk-confirm pollution) is
      // ignored rather than trusted.
      if (role.dimensional) return;
      summaries.push({
        id: role.id,
        name: role.name,
        enabled: !!role.enabled,
        criteriaLeaves: extractAllCriteriaLeaves(role.membership?.criteria),
        entIds,
      });
    } catch {
      // A common-access role that 404s or errors just contributes nothing —
      // not worth failing the whole scan/evaluation over.
    }
  });
  return summaries;
}

/**
 * Only the entitlements from common-access roles whose own membership is a
 * superset of (or equal to) the given role's membership — i.e. every identity
 * eligible for this role is also necessarily eligible for that common-access
 * role. excludeRoleId skips the role currently being evaluated (a
 * common-access role's own criteria is trivially a subset of itself).
 * boundaryAttributes: when THIS role's own criteria pin a boundary attribute, a
 * common-access role must pin that attribute too (to the same value) to count.
 */
export function filterApplicableCommonAccessEntIds(roleMembership, summaries, excludeRoleId = null, boundaryAttributes = []) {
  const roleLeaves = extractAllCriteriaLeaves(roleMembership?.criteria);
  if (roleLeaves.length === 0) return new Set();
  const pinnedBoundary = roleLeaves.filter((l) => boundaryAttributes.includes(l.attrKey));
  const entIds = new Set();
  for (const s of summaries) {
    if (excludeRoleId && s.id === excludeRoleId) continue;
    if (!criteriaLeavesSubsetOf(s.criteriaLeaves, roleLeaves)) continue;
    if (!pinnedBoundary.every((bl) => s.criteriaLeaves.some((sl) => sl.attrKey === bl.attrKey && sl.value === bl.value))) continue;
    for (const id of s.entIds) entIds.add(id);
  }
  return entIds;
}

/** The Common Access roles whose scope covers this role — same subset + boundary rule as above, but returning the roles. */
export function applicableCommonAccessRoles(roleMembership, summaries, excludeRoleId = null, boundaryAttributes = []) {
  const roleLeaves = extractAllCriteriaLeaves(roleMembership?.criteria);
  if (roleLeaves.length === 0) return [];
  const pinnedBoundary = roleLeaves.filter((l) => boundaryAttributes.includes(l.attrKey));
  return summaries.filter((s) =>
    !(excludeRoleId && s.id === excludeRoleId) &&
    criteriaLeavesSubsetOf(s.criteriaLeaves, roleLeaves) &&
    pinnedBoundary.every((bl) => s.criteriaLeaves.some((sl) => sl.attrKey === bl.attrKey && sl.value === bl.value))
  );
}

/**
 * GET /api/roles/:id/overlapping-common-access
 * Every common-access role (enabled or disabled) whose own criteria nests with
 * this role's — either is a subset of the other — for the "Evaluate" picker.
 */
export async function listOverlappingCommonAccessRoles(roleId) {
  try {
    const role = await iscGet(`/v2026/roles/${roleId}`);
    const roleLeaves = extractAllCriteriaLeaves(role.membership?.criteria);
    if (roleLeaves.length === 0) return [];
    // Same Enabled Roles Only preference the evaluation itself honors.
    const pickerFilterMode = (await getTenantSettings()).roleFilterMode || "ALL";
    const summaries = await fetchCommonAccessRoleSummaries();
    return summaries
      .filter((s) => s.id !== roleId)
      .filter((s) => pickerFilterMode !== "ENABLED_ONLY" || s.enabled !== false)
      .filter((s) => criteriaLeavesSubsetOf(s.criteriaLeaves, roleLeaves) || criteriaLeavesSubsetOf(roleLeaves, s.criteriaLeaves))
      .map((s) => ({ id: s.id, name: s.name, enabled: s.enabled }));
  } catch (err) {
    console.error("[roles] overlapping-common-access failed:", err.response?.data || err.message, describeError(err));
    throw routeError(err);
  }
}
