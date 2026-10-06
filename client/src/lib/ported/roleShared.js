/**
 * ported/roleShared.js
 * Small helpers shared by the ported /api/roles/* routes (roles.js,
 * roleDimensions.js, roleMembers.js, roleCommonAccess.js, roleEvaluation.js,
 * metadataTagging.js) — ports of the server helpers of the same names
 * (mapWithConcurrency, getTenantSettings, criteria-leaf extraction, ...).
 */

import { getCredentials } from "../sailpoint";
import { whenPluginReady } from "../pluginSdk";
import { iscGet, withApiRetry } from "../isc";
import { recordStore } from "../store";

/** The record key the server used for per-tenant records (the stores are already tenant-namespaced). */
export function tenantKey() {
  return getCredentials()?.tenant || "_";
}

/** The signed-in user — id from credentials, username from the plugin handshake (server: session.identity). */
export async function currentUser() {
  const id = getCredentials()?.identityId || null;
  let username = null;
  try {
    const ctx = await whenPluginReady();
    const user = ctx?.user || {};
    username = user.uid || user.username || user.email || user.id || null;
  } catch {
    // not inside ISC — leave the username empty
  }
  return { id, username };
}

/** Runs `fn` over `items` with at most `concurrency` in flight at once. */
export async function mapWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

// ─── Tenant settings (store "tenant-settings", keyed by tenant) ──────────────

export const DEFAULT_TENANT_SETTINGS = {
  createDynamicRoles: true, rolePrefix: "The ", roleSuffix: " Role", attributeSeparator: " - ",
  allowDuplicateRoles: true, nameScope: "attributes.cloudLifecycleState:active",
  considerCommonRoles: true, checkSodViolations: true, allowSodMitigations: true,
  // Global Metadata attribute Segments by Metadata tags and filters on.
  segmentMetadataAttribute: "Segments",
  // Which roles Role Evaluation tasks actually evaluate — "ALL", "ENABLED_ONLY"
  // (default), or "DISABLED_ONLY".
  roleFilterMode: "ENABLED_ONLY",
  // How commonly an entitlement must be held (percentage of a group's/role's
  // members) to count as "shared" — used both when a Role Draft scan decides
  // which entitlements go on a group's base/dimensions, and when Role
  // Evaluation decides an existing role's held-but-not-granted gaps.
  entitlementCommonalityThreshold: 80,
  // How many past Role Evaluation scan records (results included) to keep.
  roleEvalRetention: 10,
};

export async function getTenantSettings() {
  return { ...DEFAULT_TENANT_SETTINGS, ...((await recordStore("tenant-settings").get(tenantKey())) || {}) };
}

export const DEFAULT_SEGMENT_METADATA_ATTRIBUTE = "Segments";

// ─── Membership-criteria leaf helpers ────────────────────────────────────────

export const PEER_GROUP_STATUS_ATTRIBUTE_KEYS = new Set([
  "status", "cloudStatus", "internalCloudStatus", "identityState",
  "cloudLifecycleState", "lifecycleState",
]);

/**
 * Unwraps a dimension's membership.criteria down to its one distinguishing
 * leaf — each dimension's criteria is a chain of single-child AND wrappers
 * around one EQUALS(attribute.X, value) leaf. Returns { attrKey, value } or
 * null if the shape doesn't match.
 */
export function extractSingleAttributeCriterion(node) {
  if (!node) return null;
  if (node.operation === "AND") {
    const children = (node.children || []).filter(Boolean);
    if (children.length !== 1) return null;
    return extractSingleAttributeCriterion(children[0]);
  }
  if (node.operation !== "EQUALS") return null;
  if (node.key?.type !== "IDENTITY" || !node.key.property?.startsWith("attribute.")) return null;
  const value = Array.isArray(node.values) && node.values.length ? node.values[0] : node.stringValue;
  if (!value) return null;
  return { attrKey: node.key.property.slice("attribute.".length), value };
}

/**
 * Collects every EQUALS(attribute.X, value) leaf of a criteria tree, ignoring
 * boolean structure. Status/lifecycle leaves (cloudLifecycleState etc.) are
 * excluded since every generated role's criteria includes one.
 */
export function extractAllIdentityEqualsLeaves(node, out = []) {
  if (!node) return out;
  if (node.children?.length) {
    for (const child of node.children) extractAllIdentityEqualsLeaves(child, out);
    return out;
  }
  if (node.operation !== "EQUALS") return out;
  if (node.key?.type !== "IDENTITY" || !node.key.property?.startsWith("attribute.")) return out;
  const attrKey = node.key.property.slice("attribute.".length);
  if (PEER_GROUP_STATUS_ATTRIBUTE_KEYS.has(attrKey)) return out;
  const value = Array.isArray(node.values) && node.values.length ? node.values[0] : node.stringValue;
  if (value) out.push({ attrKey, value });
  return out;
}

// Same leaf-extraction, but WITHOUT dropping cloudLifecycleState-type leaves —
// a role like "All Active Users" whose only real constraint IS
// cloudLifecycleState=active needs that leaf represented, or every
// applicability check against it would see an empty criteria set.
export function extractAllCriteriaLeaves(node, out = []) {
  if (!node) return out;
  if (node.children?.length) {
    for (const child of node.children) extractAllCriteriaLeaves(child, out);
    return out;
  }
  if (node.operation !== "EQUALS") return out;
  if (node.key?.type !== "IDENTITY" || !node.key.property?.startsWith("attribute.")) return out;
  const attrKey = node.key.property.slice("attribute.".length);
  const value = Array.isArray(node.values) && node.values.length ? node.values[0] : node.stringValue;
  if (value) out.push({ attrKey, value });
  return out;
}

/**
 * True when every constraint `subLeaves` imposes also appears in `superLeaves`
 * (same attrKey AND value). An empty `subLeaves` can't be confirmed to apply
 * to anything, so it's treated as not applicable rather than guessed at.
 */
export function criteriaLeavesSubsetOf(subLeaves, superLeaves) {
  if (subLeaves.length === 0) return false;
  const superSet = new Set(superLeaves.map((l) => `${l.attrKey}=${l.value}`));
  return subLeaves.every((l) => superSet.has(`${l.attrKey}=${l.value}`));
}

// ─── Entitlement helpers ─────────────────────────────────────────────────────

export const ROLE_SCAN_COMMON_THRESHOLD = 0.8;

/** Entitlement ids held by at least `threshold` of `members` (by count, not a strict intersection). */
export function commonlyHeldEntitlementIds(members, threshold = ROLE_SCAN_COMMON_THRESHOLD) {
  const counts = new Map();
  for (const m of members) {
    for (const e of m.entitlements) counts.set(e.id, (counts.get(e.id) || 0) + 1);
  }
  const minCount = Math.ceil(members.length * threshold);
  const ids = new Set();
  for (const [id, count] of counts) {
    if (count >= minCount) ids.add(id);
  }
  return ids;
}

const ENTITLEMENT_ID_BATCH = 50;

/**
 * Which of `ids` still exist in ISC. A batch that fails (permissions,
 * throttling that outlived its retries) resolves as "all of these exist", so
 * a transient error can never make a live entitlement look deleted.
 */
export async function existingEntitlementIds(ids) {
  const found = new Set();
  for (let i = 0; i < ids.length; i += ENTITLEMENT_ID_BATCH) {
    const chunk = ids.slice(i, i + ENTITLEMENT_ID_BATCH);
    try {
      const page = await withApiRetry(
        () => iscGet("/v2026/entitlements", {
          filters: `id in (${chunk.map((id) => `"${id}"`).join(",")})`,
          limit: chunk.length,
        }),
        { label: `entitlement existence check (${chunk.length})` }
      );
      for (const e of page || []) if (e?.id) found.add(e.id);
    } catch (err) {
      console.warn(`[entitlements] existence check failed for ${chunk.length} ids (${err.response?.status || err.message}) — treating them as present`);
      for (const id of chunk) found.add(id);
    }
  }
  return found;
}

export async function filterExistingEntitlements(ents) {
  if (!ents.length) return ents;
  const alive = await existingEntitlementIds(ents.map((e) => e.id));
  return ents.filter((e) => alive.has(e.id));
}

/**
 * Peer-group entitlements come back from the per-identity fetch as bare
 * {id, name} — but for many sources that "name" is the raw attribute value
 * (an AD group GUID, a Salesforce ProfileId). The real name — and source —
 * only comes back from the bulk-by-id lookup; this resolves both per batch.
 */
export async function resolveEntitlementDisplayInfo(ids) {
  const uniqueIds = [...new Set(ids)];
  const infoById = new Map();
  for (let i = 0; i < uniqueIds.length; i += ENTITLEMENT_ID_BATCH) {
    const batch = uniqueIds.slice(i, i + ENTITLEMENT_ID_BATCH);
    const filters = `id in (${batch.map((id) => `"${id}"`).join(",")})`;
    try {
      const results = await withApiRetry(
        () => iscGet("/v2026/entitlements", { filters, limit: batch.length }),
        { label: "resolveEntitlementDisplayInfo: entitlements batch lookup" }
      );
      for (const e of results) infoById.set(e.id, { name: e.name, source: e.source?.name || null });
    } catch (err) {
      console.error("[insights] entitlement display-info lookup batch failed:", err.response?.data || err.message);
    }
  }
  return infoById;
}
