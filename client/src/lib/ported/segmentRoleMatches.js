/**
 * ported/segmentRoleMatches.js
 * Port of the server's "Assign Matching Roles" routes:
 *   POST /api/insights/segment-role-matches            (start a match run)
 *   GET  /api/insights/segment-role-matches/:id         (poll)
 *   POST /api/insights/segment-role-matches/:id/assign  (accept suggestions)
 *
 * Proposes which existing roles AND entitlements look like they belong to
 * each of the given Data Segments (roles by comparing membership criteria
 * plus every role actually held by a matching identity; entitlements via a
 * Search API query built from the segment's own criteria), without writing
 * anything until the admin accepts specific suggestions — which are then
 * assigned via the Segments by Metadata tagging method only.
 *
 * Also carries the server's metadata-only segment assignment helper
 * (assignItemsToSegmentViaMetadata) and the GUID resolution it depends on.
 *
 * Store "segment-role-matches": one record per run, keyed by match id, in
 * the server's record shape.
 */

import { iscPost, iscPatch, fetchAllPaged, withApiRetry, describeError, badRequest } from "../isc";
import { recordStore } from "../store";
import {
  tenantKey,
  mapWithConcurrency,
  getTenantSettings,
  extractAllIdentityEqualsLeaves,
  DEFAULT_SEGMENT_METADATA_ATTRIBUTE,
} from "./roleShared";
import { fetchAllDataSegments, extractSegmentEqualsLeaves, findSegmentEqualsLeaf, getSegmentPatchTargetId } from "./segments";
import {
  ensureBoundaryMetadataAttribute,
  ensureBoundaryMetadataValue,
  boundaryValueSlug,
  tagAccessWithBoundaryValue,
} from "./metadataTagging";
import { startJob, patchRecord, failInterrupted, newScanId } from "./scanJobs";

const STORE = "segment-role-matches";
const EXPERIMENTAL = { "X-SailPoint-Experimental": "true" };

const segmentRoleMatches = () => recordStore(STORE);
const metadataValueIds = () => recordStore("metadata-value-ids");

// ─── Matching ────────────────────────────────────────────────────────────────

/** Every role in the tenant — /v2026/roles returns each role's membership.criteria inline. */
async function fetchAllRolesWithCriteria() {
  return fetchAllPaged("/v2026/roles");
}

/**
 * Runs the given attrKey=value pairs as a Search API query against the
 * identities index (a Lucene AND of attributes.<key>:"<value>" terms — the
 * same attributes a segment's own memberFilter EQUALS leaves check) and
 * collects, deduplicated by id, the ENTITLEMENT, ROLE and ACCESS_PROFILE
 * entries from every matching identity's `access` array — every item held
 * by ANY matching identity, with no commonality requirement.
 */
export async function fetchAssignedAccessForCriteria(criteria) {
  if (criteria.length === 0) return { entitlements: [], roles: [], accessProfiles: [] };
  const query = criteria
    .map(({ attrKey, value }) => `attributes.${attrKey}:"${String(value).replace(/"/g, '\\"')}"`)
    .join(" AND ");

  const seen = new Map();
  const seenRoles = new Map();
  const seenProfiles = new Map();
  let searchAfter = null;
  const pageSize = 250;
  while (true) {
    const body = { indices: ["identities"], query: { query }, sort: ["id"], queryResultFilter: { includes: ["id", "access"] } };
    if (searchAfter) body.searchAfter = searchAfter;
    const page = (await withApiRetry(
      () => iscPost("/v2026/search", body, { params: { limit: pageSize } }),
      { label: "segment scan: entitlement search page" }
    )) || [];
    if (page.length === 0) break;
    for (const doc of page) {
      for (const item of doc.access || []) {
        if (!item.id) continue;
        if (item.type === "ENTITLEMENT" && !seen.has(item.id)) {
          seen.set(item.id, { id: item.id, name: item.name, source: item.source?.name || null });
        } else if (item.type === "ROLE" && !seenRoles.has(item.id)) {
          seenRoles.set(item.id, { id: item.id, name: item.name });
        } else if (item.type === "ACCESS_PROFILE" && !seenProfiles.has(item.id)) {
          seenProfiles.set(item.id, { id: item.id, name: item.name, source: item.source?.name || null });
        }
      }
    }
    if (page.length < pageSize) break;
    searchAfter = [page[page.length - 1].id];
  }
  const byName = (a, b) => (a.name || "").localeCompare(b.name || "");
  return {
    entitlements: [...seen.values()].sort(byName),
    roles: [...seenRoles.values()].sort(byName),
    accessProfiles: [...seenProfiles.values()].sort(byName),
  };
}

// Criteria-matched roles plus every role actually assigned to a matching
// identity, deduplicated by id. enabled/dimensional come from the full role
// list when the role is in it; an assigned role missing from that list
// (deleted mid-scan) keeps just its id and name.
export function mergeSegmentRoles(criteriaRoles, assignedRoles, allRoles) {
  const roleById = new Map(allRoles.map((r) => [r.id, r]));
  const merged = new Map(criteriaRoles.map((r) => [r.id, r]));
  for (const r of assignedRoles) {
    if (merged.has(r.id)) continue;
    const full = roleById.get(r.id);
    merged.set(r.id, { id: r.id, name: full?.name || r.name, enabled: full ? full.enabled : null, dimensional: !!full?.dimensional });
  }
  return [...merged.values()].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
}

// A role "matches" a segment when EVERY one of the segment's own
// attribute=value pairs is also present among the role's own criteria
// leaves (subset match, not exact-set). On top of that, every role actually
// assigned to ANY identity matching the segment's criteria is included too.
// A role already present in the segment's own ROLE-scope selection is
// excluded; entitlements already in its ENTITLEMENT-scope selection likewise.
async function computeMatchingAccessForSegments(segments) {
  const allRoles = await fetchAllRolesWithCriteria();
  return mapWithConcurrency(segments, 4, async (segment) => {
    const criteria = extractSegmentEqualsLeaves(segment.memberFilter?.expression);
    const roleScope = (segment.scopes || []).find((s) => s.scope === "ROLE");
    const alreadySelectedRoles = new Set((roleScope?.scopeSelection || []).map((r) => r.id));
    const criteriaRoles = criteria.length === 0 ? [] : allRoles
      .filter((role) => {
        const roleLeaves = extractAllIdentityEqualsLeaves(role.membership?.criteria);
        if (roleLeaves.length === 0) return false;
        const roleSet = new Set(roleLeaves.map((l) => `${l.attrKey}=${l.value}`));
        return criteria.every((l) => roleSet.has(`${l.attrKey}=${l.value}`));
      })
      .map((role) => ({ id: role.id, name: role.name, enabled: role.enabled, dimensional: !!role.dimensional }));

    const entScope = (segment.scopes || []).find((s) => s.scope === "ENTITLEMENT");
    const alreadySelectedEnts = new Set((entScope?.scopeSelection || []).map((e) => e.id));
    let entitlementMatches = [];
    let assignedRoles = [];
    if (criteria.length > 0) {
      try {
        const found = await fetchAssignedAccessForCriteria(criteria);
        entitlementMatches = found.entitlements.filter((e) => !alreadySelectedEnts.has(e.id)).map((e) => ({ ...e, assigned: false }));
        assignedRoles = found.roles;
      } catch (err) {
        console.warn(`[insights] segment-role-match: access search failed for segment "${segment.name}":`, err.response?.status || err.message);
      }
    }
    const matches = mergeSegmentRoles(criteriaRoles, assignedRoles, allRoles)
      .filter((role) => !alreadySelectedRoles.has(role.id))
      .map((role) => ({ ...role, assigned: false }));

    return { segmentId: segment.id, segmentName: segment.name, criteria, matches, entitlementMatches };
  });
}

// ─── Metadata-only segment assignment ────────────────────────────────────────
// Roles/entitlements are NEVER written into a segment's scopeSelection —
// assignment always goes through the Segments by Metadata tagging method.

const isGuidishValue = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s));

// Finds the metadata FILTER target on a segment's scopes: a FILTER scope
// whose EQUALS leaf names a metadata attribute. The leaf's value is the
// technical name on the ENTITLEMENT scope; the ROLE scope's may be the
// internal GUID, so ENTITLEMENT is preferred.
export function segmentMetadataTarget(segment) {
  const filterScopes = (segment.scopes || []).filter((s) => s.visibility === "FILTER");
  const ordered = [...filterScopes].sort((a, b) => (a.scope === "ENTITLEMENT" ? -1 : 0) - (b.scope === "ENTITLEMENT" ? -1 : 0));
  for (const s of ordered) {
    const leaf = findSegmentEqualsLeaf(s.scopeFilter?.expression);
    if (leaf?.attribute && leaf.value?.value != null && !isGuidishValue(leaf.value.value)) {
      return { key: leaf.attribute, value: String(leaf.value.value) };
    }
  }
  return null;
}

// The standard isAMM FILTER scope: a double AND wrapper around one EQUALS
// leaf on the metadata attribute. `value` is the technical name for
// ENTITLEMENT scopes, but must be the value's internal GUID for ROLE scopes
// (the role picker/engine only dereferences GUIDs).
function boundaryFilterScope(scopeType, key, value) {
  return {
    scope: scopeType,
    visibility: "FILTER",
    scopeFilter: {
      expression: {
        operator: "AND", attribute: null, value: { type: "NULL", value: null }, metadata: null,
        children: [{
          operator: "AND", attribute: null, value: { type: "NULL", value: null }, metadata: null,
          children: [{
            operator: "EQUALS",
            attribute: key,
            value: { type: "STRING", value },
            children: [],
            metadata: { sourceId: null, schemaId: null, schemaName: null, extraExpression: null, isAMM: true },
          }],
        }],
      },
    },
    scopeSelection: [],
  };
}

const GUID_RE = /^[0-9a-f]{32}$|^[0-9a-f-]{36}$/i;
let loggedSearchLiteShape = false;

/** Every AMM value recorded against `key` on one object, as search-lite has it. */
function ammValuesFromSearchLiteRow(row, key) {
  const attrs = row?.accessModelMetadata?.attributes || row?.accessModelMetadata || [];
  const list = Array.isArray(attrs) ? attrs : [];
  const attr = list.find((a) => a?.key === key || a?.name === key);
  const values = attr?.values || attr?.value || [];
  return (Array.isArray(values) ? values : [values])
    .map((v) => (typeof v === "string" ? v : v?.id || v?.valueId || v?.guid || v?.value))
    .filter((v) => typeof v === "string" && v);
}

/**
 * The GUID ISC uses for one AMM value, read back from search-lite via an
 * object that carries it. `index` MATTERS: the same value has a different
 * GUID in the roles index than in the entitlements index, so a segment's
 * ROLE filter needs the one from ["roles"], read off a tagged role. Returns
 * null rather than guessing when the object holds several values for the
 * key and none can be told apart.
 */
async function resolveAmmValueGuidViaSearchLite({ index, objectId, key }) {
  try {
    const data = await iscPost("/v2025/search-lite", {
      queryType: "ATLAS",
      atlasQuery: { filter: { property: "id", operation: "IN", value: [objectId] } },
      indices: [index],
      includeNested: true,
      sort: ["name"],
    });
    const rows = Array.isArray(data) ? data : data?.items || data?.results || [];
    if (!loggedSearchLiteShape) {
      loggedSearchLiteShape = true;
      console.log(`[segments] search-lite raw row shape: ${JSON.stringify(rows[0] || data)?.slice(0, 600)}`);
    }
    const values = ammValuesFromSearchLiteRow(rows[0], key);
    const guids = values.filter((v) => GUID_RE.test(v));
    if (guids.length === 1) return guids[0];
    if (guids.length > 1) {
      console.warn(`[segments] search-lite returned ${guids.length} GUIDs for "${key}" on ${index}/${objectId} — can't tell which is which, leaving the ROLE filter unresolved`);
    }
    return null;
  } catch (err) {
    console.warn(`[segments] search-lite GUID lookup failed for ${index}/${objectId}:`, err.response?.status || err.message);
    return null;
  }
}

/** Any one role already tagged with this metadata value (Search matches on the technical NAME). */
async function findRoleTaggedWithValue(key, value) {
  try {
    const page = await withApiRetry(
      () => iscPost("/v2026/search", {
        indices: ["roles"],
        query: { query: `@accessModelMetadata(key:${key} AND value:"${String(value).replace(/"/g, '\\"')}")` },
        sort: ["name"],
      }, { params: { limit: 1 } }),
      { label: `find role tagged with ${key}:${value}` }
    );
    return (page || [])[0]?.id || null;
  } catch (err) {
    console.warn(`[segments] role search for ${key}:${value} failed:`, err.response?.status || err.message);
    return null;
  }
}

/**
 * The value's ROLE-index GUID, waiting for search-lite to catch up. Roles
 * are tagged moments before this runs and search-lite indexes
 * asynchronously, so the first look frequently misses; every fallback is
 * wrong (a technical name produces a filter ISC can't resolve, and an
 * explicit role SELECTION is capped at 50), so this waits for it.
 */
async function resolveRoleValueGuid({ key, value, roleIds }) {
  const waits = [0, 1500, 3000, 5000, 8000, 12000];
  const startedAt = Date.now();
  for (let i = 0; i < waits.length; i += 1) {
    if (waits[i]) await new Promise((r) => setTimeout(r, waits[i]));
    const probeRoleId = roleIds?.[0] || await findRoleTaggedWithValue(key, value);
    if (!probeRoleId) continue;
    const guid = await resolveAmmValueGuidViaSearchLite({ index: "roles", objectId: probeRoleId, key });
    if (guid) {
      const mapKey = `${key}:${value}`;
      const tenant = tenantKey();
      const stored = (await metadataValueIds().get(tenant)) || {};
      await metadataValueIds().put(tenant, { ...stored, [mapKey]: guid });
      console.log(
        `[segments][guid-timing] resolved "${mapKey}" on attempt ${i + 1}/${waits.length} ` +
        `after ${((Date.now() - startedAt) / 1000).toFixed(1)}s — GUID ${guid} (role ${probeRoleId})`
      );
      return guid;
    }
  }
  console.warn(
    `[segments][guid-timing] NO ROLE GUID for "${key}:${value}" after ${waits.length} attempts ` +
    `/ ${((Date.now() - startedAt) / 1000).toFixed(1)}s — the ROLE filter can't be written`
  );
  return null;
}

/**
 * Assigns roles/entitlements to a segment purely via the Segments by
 * Metadata method — no scopeSelection writes, ever:
 *
 * - Segment already metadata-driven (FILTER criteria on a metadata
 *   attribute): the items are tagged with the segment's own value and the
 *   live filter picks them up. No draft is created.
 * - Any other segment (SELECTION/ALL/empty Access Model): it is CONVERTED
 *   to the metadata pattern first — the boundary value is derived from the
 *   segment's name (minus the scan's " Segment" suffix), registered on the
 *   configured attribute (created if missing), the chosen items AND every
 *   ref already in the segment's scopeSelection are tagged with it, and the
 *   scopes are replaced with the standard isAMM FILTER pair (ENTITLEMENT by
 *   technical name, ROLE by the value's GUID when known). The conversion
 *   patches the segment's draft (reverting a published one to draft).
 *
 * `segment` must be the ORIGINAL record (pre-draft). Returns
 * { value, converted, roleFilterUnresolved }.
 */
export async function assignItemsToSegmentViaMetadata(segment, { roleIds = [], entIds = [] } = {}) {
  const existingTarget = segmentMetadataTarget(segment);
  if (existingTarget) {
    await tagAccessWithBoundaryValue({
      key: existingTarget.key,
      entitlementIds: entIds,
      roleIds,
      value: existingTarget.value,
      // Best display name available if the value has to be (re)registered.
      name: String(segment.name || "").replace(/\s+segment$/i, "").trim() || existingTarget.value,
    });
    return { value: existingTarget.value, converted: false, roleFilterUnresolved: false };
  }

  const metadataKey =
    (await getTenantSettings()).segmentMetadataAttribute?.trim() || DEFAULT_SEGMENT_METADATA_ATTRIBUTE;
  const boundaryName = String(segment.name || "").replace(/\s+segment$/i, "").trim() || String(segment.name || "");
  const boundaryValue = boundaryValueSlug(boundaryName);
  if (!boundaryValue) throw new Error(`Can't derive a metadata value from segment name "${segment.name}".`);
  await ensureBoundaryMetadataAttribute(metadataKey);
  const valueGuid = await ensureBoundaryMetadataValue(metadataKey, { value: boundaryValue, name: boundaryName });

  // Current SELECTION refs keep their membership by being tagged too.
  const selectedIds = (type) =>
    (segment.scopes || [])
      .filter((s) => s.scope === type && s.visibility === "SELECTION")
      .flatMap((s) => (s.scopeSelection || []).map((r) => r.id))
      .filter(Boolean);
  const allEntIds = [...new Set([...entIds, ...selectedIds("ENTITLEMENT")])];
  const allRoleIds = [...new Set([...roleIds, ...selectedIds("ROLE")])];
  await tagAccessWithBoundaryValue({
    key: metadataKey,
    entitlementIds: allEntIds,
    roleIds: allRoleIds,
    value: boundaryValue,
    name: boundaryName,
  });

  // The ROLE scope must be a metadata filter carrying the value's GUID —
  // wait for it rather than settle for a technical name or a SELECTION.
  const roleGuid = valueGuid || await resolveRoleValueGuid({ key: metadataKey, value: boundaryValue, roleIds: allRoleIds });

  const draftId = await getSegmentPatchTargetId(segment.id);
  const scopes = [boundaryFilterScope("ENTITLEMENT", metadataKey, boundaryValue)];
  if (roleGuid) {
    scopes.push(boundaryFilterScope("ROLE", metadataKey, roleGuid));
  } else {
    console.warn(`[segments] no ROLE GUID for "${metadataKey}:${boundaryValue}" — no ROLE scope written on the converted segment`);
  }
  await withApiRetry(
    () => iscPatch(`/v2026/data-segments/${draftId}`, [{ op: "replace", path: "/scopes", value: scopes }], { headers: EXPERIMENTAL }),
    { label: `assignItemsToSegmentViaMetadata: convert "${segment.name}"` }
  );
  return { value: boundaryValue, converted: true, roleFilterUnresolved: !roleGuid };
}

// ─── Routes ──────────────────────────────────────────────────────────────────

async function runSegmentRoleMatch(matchId) {
  try {
    const record = await segmentRoleMatches().get(matchId);
    const allSegments = await fetchAllDataSegments();
    const targetSegments = allSegments.filter((s) => record.segmentIds.includes(s.id));
    const results = await computeMatchingAccessForSegments(targetSegments);
    await patchRecord(STORE, matchId, { status: "completed", completedAt: new Date().toISOString(), results });
  } catch (err) {
    console.error(`[insights] segment-role-match ${matchId} failed:`, err.response?.data || err.message);
    await patchRecord(STORE, matchId, { status: "failed", completedAt: new Date().toISOString(), error: describeError(err) });
  }
}

/**
 * POST /api/insights/segment-role-matches
 * { segmentIds: string[] } -> { matchId }
 * Starts a match run in the background; poll getSegmentRoleMatch for
 * progress and the resulting per-segment suggestions (matches for roles,
 * entitlementMatches for entitlements). Nothing is written until the admin
 * accepts specific suggestions via assignSegmentRoleMatches.
 */
export async function startSegmentRoleMatch(segmentIds) {
  if (!Array.isArray(segmentIds) || segmentIds.length === 0) {
    throw badRequest("segmentIds must be a non-empty array.");
  }
  const matchId = newScanId("segrolematch");
  await segmentRoleMatches().put(matchId, {
    id: matchId,
    tenant: tenantKey(),
    status: "running",
    startedAt: new Date().toISOString(),
    completedAt: null,
    segmentIds,
    results: [],
    error: null,
  });
  startJob(STORE, matchId, () => runSegmentRoleMatch(matchId));
  return { matchId };
}

async function matchForTenant(matchId) {
  const record = await segmentRoleMatches().get(matchId);
  if (!record || (record.tenant && record.tenant !== tenantKey())) {
    throw badRequest("Data segment/role match run not found.", 404);
  }
  return record;
}

/** GET /api/insights/segment-role-matches/:id — full record including per-segment suggestions. */
export async function getSegmentRoleMatch(matchId) {
  await failInterrupted(STORE);
  return matchForTenant(matchId);
}

/**
 * POST /api/insights/segment-role-matches/:id/assign
 * { items: [{ segmentId, type?: "ROLE" | "ENTITLEMENT", id }, ...] } -> { results }
 * Assigns each selected role/entitlement to its matched segment via the
 * Segments by Metadata tagging method ONLY. Batched per segment; continues
 * past individual segment failures; each successful item is marked on the
 * persisted match record so reopening it shows what's already assigned.
 * type defaults to ROLE; { segmentId, roleId } items still work.
 */
export async function assignSegmentRoleMatches(matchId, items) {
  const record = await matchForTenant(matchId);
  if (!Array.isArray(items) || items.length === 0) {
    throw badRequest("items must be a non-empty array.");
  }

  const bySegment = new Map();
  for (const item of items) {
    const segmentId = item.segmentId;
    const type = item.type === "ENTITLEMENT" ? "ENTITLEMENT" : "ROLE";
    const itemId = item.id ?? item.roleId;
    if (!bySegment.has(segmentId)) bySegment.set(segmentId, { roleIds: [], entIds: [] });
    const bucket = bySegment.get(segmentId);
    (type === "ENTITLEMENT" ? bucket.entIds : bucket.roleIds).push(itemId);
  }

  const results = [];
  for (const [segmentId, { roleIds, entIds }] of bySegment) {
    try {
      // The segment is inspected on the ORIGINAL record, before any draft
      // dance — assignItemsToSegmentViaMetadata only creates a draft when
      // it has to convert a non-metadata segment.
      const preAll = await fetchAllDataSegments();
      const original = preAll.find((s) => s.id === segmentId);
      if (!original) throw new Error("Data segment not found.");
      const outcome = await assignItemsToSegmentViaMetadata(original, { roleIds, entIds });
      for (const roleId of roleIds) results.push({ segmentId, type: "ROLE", id: roleId, ok: true, tagged: true, ...(outcome.converted ? { converted: true } : {}) });
      for (const entId of entIds) results.push({ segmentId, type: "ENTITLEMENT", id: entId, ok: true, tagged: true, ...(outcome.converted ? { converted: true } : {}) });
    } catch (err) {
      console.error(`[insights] segment-role-match assign segment ${segmentId} failed:`, err.response?.data || err.message);
      const message = describeError(err);
      for (const roleId of roleIds) results.push({ segmentId, type: "ROLE", id: roleId, ok: false, error: message });
      for (const entId of entIds) results.push({ segmentId, type: "ENTITLEMENT", id: entId, ok: false, error: message });
    }
  }

  const updatedResults = (record.results || []).map((seg) => ({
    ...seg,
    matches: seg.matches.map((m) => {
      const result = results.find((r) => r.segmentId === seg.segmentId && r.type === "ROLE" && r.id === m.id);
      return result?.ok ? { ...m, assigned: true } : m;
    }),
    entitlementMatches: (seg.entitlementMatches || []).map((m) => {
      const result = results.find((r) => r.segmentId === seg.segmentId && r.type === "ENTITLEMENT" && r.id === m.id);
      return result?.ok ? { ...m, assigned: true } : m;
    }),
  }));
  await patchRecord(STORE, record.id, { results: updatedResults });

  return { results };
}
