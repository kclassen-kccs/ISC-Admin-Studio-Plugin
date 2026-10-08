/**
 * ported/segmentScans.js
 * Port of the server's Data Segment scan routes (Mining > Segments):
 *
 *   POST   /api/insights/segment-scans                  startSegmentScan
 *   GET    /api/insights/segment-scans                  listSegmentScans
 *   GET    /api/insights/segment-scans/:id              getSegmentScan
 *   POST   /api/insights/segment-scans/:id/cancel       cancelSegmentScan
 *   DELETE /api/insights/segment-scans/:id              deleteSegmentScan
 *   GET    /api/insights/segment-scans/:id/create-progress  getSegmentCreateProgress
 *   POST   /api/insights/segment-scans/:id/create       createSegmentsFromScan
 *   POST   /api/insights/segment-scans/:id/add-to-existing  addScanSuggestionsToExistingSegments
 *
 * Same boundary-combination discovery the removed "Build Segments" button
 * used to run (walks every active identity's boundary attribute value(s)
 * from Schema Analysis's own roleBoundaryAttributes and finds every distinct
 * combination actually present) — persisted as a scan record's suggestions
 * rather than created immediately, modeled on Role Mining's scan -> draft ->
 * selectively-create flow.
 *
 * The scan runs in the page (see scanJobs.js): it keeps going while the tab
 * is open and a "running" record whose runner died with the page is marked
 * failed the next time the store is read. Record shapes, progress fields and
 * error messages are the server's.
 */

import { iscGet, iscPost, iscPatch, withApiRetry, describeError, badRequest } from "../isc";
import { recordStore } from "../store";
import {
  tenantKey,
  mapWithConcurrency,
  getTenantSettings,
  extractAllIdentityEqualsLeaves,
  DEFAULT_SEGMENT_METADATA_ATTRIBUTE,
} from "./roleShared";
import { fetchAllDataSegments, findSegmentEqualsLeaf, getSegmentPatchTargetId } from "./segments";
import {
  ensureBoundaryMetadataAttribute,
  ensureBoundaryMetadataValue,
  boundaryValueSlug,
  tagAccessWithBoundaryValue,
} from "./metadataTagging";
import { startJob, patchRecord, failInterrupted, requestCancel, isCancelled, newScanId } from "./scanJobs";

const SCANS = "segment-scans";
// Live progress for a create run, so the UI can count segments off as they
// go. Deliberately its OWN tiny store rather than a field on the scan
// record: that record carries every suggestion's members, so ticking it once
// per created segment would mean a multi-megabyte read-modify-write per item.
const CREATE_PROGRESS = "segment-create-progress";
const segmentScans = () => recordStore(SCANS);
const segmentCreateProgress = () => recordStore(CREATE_PROGRESS);
// "<attrKey>:<value>" -> internal value GUID (ROLE index). See metadataTagging.js.
const metadataValueIds = () => recordStore("metadata-value-ids");

const DATA_SEGMENTS_HEADERS = { "X-SailPoint-Experimental": "true" };

const NOT_FOUND = "Data segment scan not found.";
const BOUNDARY_REQUIRED = "Enable the Multi-Company/Division Boundary with at least one attribute first.";

export class SegmentScanCancelledError extends Error {}

/** Schema Analysis's boundary attributes (the ones Role Scan partitions by), or [] when the boundary is off. */
export async function getBoundaryKeys() {
  const analysis = await recordStore("schema-analysis").get(tenantKey());
  return analysis?.roleBoundaryEnabled ? (analysis.roleBoundaryAttributes || []) : [];
}

// ─── Data Segment memberFilter DSL ──────────────────────────────────────────

// A single EQUALS leaf in ISC's Data Segment memberFilter DSL: flat
// `attribute` string, typed `value: {type, value}`.
export function segmentEqualsLeaf(attrKey, value) {
  return { operator: "EQUALS", attribute: attrKey, value: { type: "STRING", value }, children: [], metadata: null };
}

// ISC's own "Build Criteria" UI always wraps each condition in its own AND
// "row" node, even when that row has just one condition. A flatter
// single-level AND round-trips fine through the API but isn't a shape the
// UI's own criteria builder can parse back out for editing, so the UI's
// row-wrapping convention is matched here.
function segmentRow(leaf) {
  return { operator: "AND", attribute: null, value: { type: "NULL", value: null }, children: [leaf], metadata: null };
}
export function segmentAndExpression(leaves) {
  return { operator: "AND", attribute: null, value: { type: "NULL", value: null }, children: leaves.map(segmentRow), metadata: null };
}

// ISC hard-caps a data segment's scopes[].scopeSelection at 50 entries —
// verified live: PATCHing/POSTing past that 400s with detailCode
// "400.1.413 Field too large" and creates/changes nothing at all.
export const SCOPE_SELECTION_MAX = 50;

// ─── Discovery helpers ───────────────────────────────────────────────────────

// Every role in the tenant, fully — /v2026/roles already returns each role's
// own membership.criteria inline (verified live).
async function fetchAllRolesWithCriteria() {
  const all = [];
  const pageSize = 250;
  for (let offset = 0; ; offset += pageSize) {
    const page = await withApiRetry(
      () => iscGet("/v2026/roles", { limit: pageSize, offset }),
      { label: "segment-role-match: roles page" }
    );
    if (!Array.isArray(page) || page.length === 0) break;
    all.push(...page);
    if (page.length < pageSize) break;
  }
  return all;
}

/**
 * Every distinct combination of the boundary attributes' values across the
 * tenant's identities, with a member count. Identities missing a value (or
 * "Unknown") are skipped. Shared with the access-request Segments scan.
 */
export async function collectBoundaryCombos(boundaryKeys, { onScanned, isCancelled: cancelled } = {}) {
  const combos = new Map(); // key -> { values, memberCount }
  for (let offset = 0; ; ) {
    if (cancelled?.()) throw new SegmentScanCancelledError();
    const at = offset;
    const page = await withApiRetry(
      () => iscGet("/v2026/public-identities", { limit: 250, offset: at }),
      { label: "segment scan: public-identities page" }
    );
    if (!Array.isArray(page) || page.length === 0) break;
    for (const idn of page) {
      const values = boundaryKeys.map((k) => idn.attributes?.find((a) => a.key === k)?.value);
      if (values.some((v) => !v || v === "Unknown")) continue;
      const key = values.join("||");
      if (!combos.has(key)) combos.set(key, { values, memberCount: 0 });
      combos.get(key).memberCount += 1;
    }
    offset += page.length;
    if (onScanned) await onScanned(offset);
    if (page.length < 250) break;
  }
  return [...combos.values()];
}

/**
 * Runs the given attrKey=value pairs as a Search API query against the
 * identities index (a Lucene AND of attributes.<key>:"<value>" terms — the
 * same attributes a segment's own memberFilter EQUALS leaves check) and
 * collects the ENTITLEMENT, ROLE and ACCESS_PROFILE entries from every
 * matching identity's own `access` array, deduplicated by id. Paginated via
 * searchAfter since a combo can match more identities than one page.
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
function mergeSegmentRoles(criteriaRoles, assignedRoles, allRoles) {
  const roleById = new Map(allRoles.map((r) => [r.id, r]));
  const merged = new Map(criteriaRoles.map((r) => [r.id, r]));
  for (const r of assignedRoles) {
    if (merged.has(r.id)) continue;
    const full = roleById.get(r.id);
    merged.set(r.id, { id: r.id, name: full?.name || r.name, enabled: full ? full.enabled : null, dimensional: !!full?.dimensional });
  }
  return [...merged.values()].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
}

/**
 * One suggestion per distinct boundary combination actually present, with a
 * member count and a stable id so a later create call can target it.
 *
 * includeRoles/includeEntitlements each add a proposal to every suggestion:
 * - suggestedRoles: every role assigned to ANY identity matching the combo
 *   (one holder is enough) plus every existing role whose own membership
 *   criteria carries all of this combo's attrKey=value pairs.
 * - suggestedEntitlements: every entitlement held by anyone matching the
 *   combo's attrKey=value pairs, found by running the same criteria the
 *   segment's membership rule would use as a Search API query.
 */
async function computeSegmentSuggestions({ scanId, includeRoles = true, includeEntitlements = true } = {}) {
  const boundaryKeys = await getBoundaryKeys();
  if (boundaryKeys.length === 0) throw badRequest(BOUNDARY_REQUIRED);

  const combos = await collectBoundaryCombos(boundaryKeys, {
    onScanned: scanId ? (n) => patchRecord(SCANS, scanId, { scanned: n }) : null,
    isCancelled: scanId ? () => isCancelled(SCANS, scanId) : null,
  });

  const existingSegments = await fetchAllDataSegments();
  const existingNames = new Set(existingSegments.map((s) => (s.name || "").trim().toLowerCase()));

  const allRoles = includeRoles ? await fetchAllRolesWithCriteria() : [];

  const suggestions = combos
    .map(({ values, memberCount }, i) => {
      const name = `${values.join(" ")} Segment`;
      const description = `Grants segment access to active identities where ${boundaryKeys
        .map((k, idx) => `${k} = "${values[idx]}"`)
        .join(" and ")}.`;

      let suggestedRoles = null;
      if (includeRoles) {
        const criteria = boundaryKeys.map((k, idx) => ({ attrKey: k, value: values[idx] }));
        suggestedRoles = allRoles
          .filter((role) => {
            const roleLeaves = extractAllIdentityEqualsLeaves(role.membership?.criteria);
            if (roleLeaves.length === 0) return false;
            const roleSet = new Set(roleLeaves.map((l) => `${l.attrKey}=${l.value}`));
            return criteria.every((l) => roleSet.has(`${l.attrKey}=${l.value}`));
          })
          .map((role) => ({ id: role.id, name: role.name, enabled: role.enabled, dimensional: !!role.dimensional }));
      }

      return {
        id: `combo-${i}`,
        name,
        description,
        values,
        memberCount,
        existingSegmentName: existingNames.has(name.trim().toLowerCase()) ? name : null,
        segmentCreated: null,
        suggestedRoles,
        suggestedEntitlements: null, // filled in below, once, for every suggestion
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  if (includeEntitlements || includeRoles) {
    const results = await mapWithConcurrency(suggestions, 4, async (s) => {
      if (scanId && isCancelled(SCANS, scanId)) throw new SegmentScanCancelledError();
      const criteria = boundaryKeys.map((k, idx) => ({ attrKey: k, value: s.values[idx] }));
      try {
        return await fetchAssignedAccessForCriteria(criteria);
      } catch (err) {
        console.warn(`[insights] segment scan: access search failed for "${s.name}":`, err.response?.status || err.message);
        return { entitlements: [], roles: [], accessProfiles: [] };
      }
    });
    suggestions.forEach((s, idx) => {
      if (includeEntitlements) s.suggestedEntitlements = results[idx].entitlements;
      if (includeRoles) s.suggestedRoles = mergeSegmentRoles(s.suggestedRoles || [], results[idx].roles, allRoles);
    });
  }

  return { boundaryKeys, totalCombinations: combos.length, suggestions };
}

async function runSegmentScan(scanId, { includeRoles, includeEntitlements } = {}) {
  try {
    const { boundaryKeys, totalCombinations, suggestions } = await computeSegmentSuggestions({ scanId, includeRoles, includeEntitlements });
    await patchRecord(SCANS, scanId, {
      status: "completed",
      completedAt: new Date().toISOString(),
      boundaryKeys,
      totalCombinations,
      suggestions,
    });
  } catch (err) {
    if (err instanceof SegmentScanCancelledError) {
      await patchRecord(SCANS, scanId, { status: "cancelled", completedAt: new Date().toISOString() });
      return;
    }
    console.error(`[insights] segment scan ${scanId} failed:`, err.response?.data || err.message);
    await patchRecord(SCANS, scanId, {
      status: "failed",
      completedAt: new Date().toISOString(),
      error: describeError(err),
    });
  }
}

// ─── Scan routes ─────────────────────────────────────────────────────────────

/**
 * POST /api/insights/segment-scans
 * Body: { includeRoles?, includeEntitlements?, mode? } — includes default
 * true. "metadata" (default) tags each suggested role/entitlement with the
 * Boundary metadata attribute and creates the segment with a FILTER Access
 * Model on that attribute; "selection" (only when asked for explicitly)
 * writes an explicit SELECTION capped at 50 by ISC. The scan itself is
 * identical either way. Returns { scanId } immediately; poll getSegmentScan.
 */
export async function startSegmentScan({ includeRoles, includeEntitlements, mode } = {}) {
  const boundaryKeys = await getBoundaryKeys();
  if (boundaryKeys.length === 0) throw badRequest(BOUNDARY_REQUIRED);

  const roles = includeRoles !== false;
  const ents = includeEntitlements !== false;
  const scanMode = mode === "selection" ? "selection" : "metadata";

  const scanId = newScanId("segscan");
  await segmentScans().put(scanId, {
    id: scanId,
    tenant: tenantKey(),
    status: "running",
    startedAt: new Date().toISOString(),
    completedAt: null,
    scanned: 0,
    boundaryKeys,
    totalCombinations: 0,
    suggestions: [],
    error: null,
    includeRoles: roles,
    includeEntitlements: ents,
    mode: scanMode,
  });

  startJob(SCANS, scanId, () => runSegmentScan(scanId, { includeRoles: roles, includeEntitlements: ents }));

  return { scanId };
}

/** GET /api/insights/segment-scans — past/running scans, newest first, without their suggestions. */
export async function listSegmentScans() {
  await failInterrupted(SCANS);
  return Object.values(await segmentScans().all())
    .map(({ suggestions, ...meta }) => ({ ...meta, suggestionCount: suggestions?.length || 0 }))
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
}

async function loadScan(scanId) {
  await failInterrupted(SCANS);
  const scan = await segmentScans().get(scanId);
  if (!scan) throw badRequest(NOT_FOUND, 404);
  return scan;
}

/** GET /api/insights/segment-scans/:id — full record including suggestions. */
export async function getSegmentScan(scanId) {
  return loadScan(scanId);
}

/** POST /api/insights/segment-scans/:id/cancel */
export async function cancelSegmentScan(scanId) {
  const scan = await loadScan(scanId);
  if (scan.status !== "running") throw badRequest(`Scan is already ${scan.status}.`);
  requestCancel(SCANS, scanId);
  return { cancelling: true };
}

/** DELETE /api/insights/segment-scans/:id — purges a past scan record. */
export async function deleteSegmentScan(scanId) {
  const scan = await loadScan(scanId);
  if (scan.status === "running") throw badRequest("Cancel the scan before removing it.");
  await segmentScans().delete(scanId);
}

/**
 * GET /api/insights/segment-scans/:id/create-progress
 * -> { done, total } while a create run is in flight, zeroes otherwise.
 */
export async function getSegmentCreateProgress(scanId) {
  await loadScan(scanId);
  const p = await segmentCreateProgress().get(scanId);
  return { done: p?.done ?? 0, total: p?.total ?? 0 };
}

// ─── Boundary metadata (Segments by Metadata mode) ──────────────────────────
// A "metadata"-mode scan creates segments whose Access Model is a FILTER on
// the Access Model Metadata attribute rather than an explicit SELECTION list
// — sidestepping ISC's 50-item scopeSelection cap entirely.

let loggedSearchLiteShape = false;
const GUID_RE = /^[0-9a-f]{32}$|^[0-9a-f-]{36}$/i;

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
 * object that carries it. `index` MATTERS: the same metadata value has a
 * different GUID in the roles index than in the entitlements index, so the
 * index must match the scope the GUID is destined for. Returns null rather
 * than guessing when the object holds several values for the key.
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

/** Any one role already tagged with this metadata value (search matches on the technical name). */
async function findRoleTaggedWithValue(key, value) {
  try {
    const data = await withApiRetry(
      () => iscPost(
        "/v2026/search",
        {
          indices: ["roles"],
          query: { query: `@accessModelMetadata(key:${key} AND value:"${String(value).replace(/"/g, '\\"')}")` },
          sort: ["name"],
        },
        { params: { limit: 1 } }
      ),
      { label: `find role tagged with ${key}:${value}` }
    );
    return (data || [])[0]?.id || null;
  } catch (err) {
    console.warn(`[segments] role search for ${key}:${value} failed:`, err.response?.status || err.message);
    return null;
  }
}

/**
 * The value's ROLE-index GUID, waiting for search-lite to catch up. Roles
 * are tagged moments before this runs and search-lite indexes
 * asynchronously, so the first look frequently misses; every fallback is
 * wrong (a technical name gives a filter ISC can't resolve, a SELECTION is
 * capped at 50), so this waits for the GUID rather than settling for less.
 */
export async function resolveRoleValueGuid({ key, value, roleIds }) {
  const waits = [0, 1500, 3000, 5000, 8000, 12000];
  const startedAt = Date.now();
  for (let i = 0; i < waits.length; i += 1) {
    if (waits[i]) await new Promise((r) => setTimeout(r, waits[i]));
    const probeRoleId = roleIds?.[0] || await findRoleTaggedWithValue(key, value);
    if (!probeRoleId) continue;
    const guid = await resolveAmmValueGuidViaSearchLite({ index: "roles", objectId: probeRoleId, key });
    if (guid) {
      const mapKey = `${key}:${value}`;
      const stored = (await metadataValueIds().get(tenantKey())) || {};
      await metadataValueIds().put(tenantKey(), { ...stored, [mapKey]: guid });
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
 * A segment Access Model scope that is a FILTER on the metadata attribute:
 * ISC's own double AND wrapper carrying metadata.isAMM. `value` is the
 * technical name for ENTITLEMENT scopes but must be the value's internal
 * GUID for ROLE scopes (verified live).
 */
export function boundaryFilterScope(scopeType, key, value) {
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

// ── Metadata-only segment assignment ──────────────────────────────────────
// Roles/entitlements are NEVER written into a segment's scopeSelection any
// more — assignment always goes through the Segments by Metadata tagging
// method.

const isGuidishValue = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s));

// Finds the metadata FILTER target on a segment's scopes. The leaf's value is
// the technical name on the ENTITLEMENT scope; the ROLE scope's may be the
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

/**
 * Assigns roles/entitlements to a segment purely via the Segments by
 * Metadata method:
 * - Segment already metadata-driven: the items are tagged with the
 *   segment's own value and the live filter picks them up.
 * - Any other segment: CONVERTED to the metadata pattern first — the value
 *   is derived from the segment's name (minus " Segment"), registered on the
 *   configured attribute, the chosen items AND every ref already in the
 *   segment's scopeSelection are tagged, and the scopes are replaced with
 *   the standard isAMM FILTER pair (patching the segment's draft).
 *
 * `segment` must be the ORIGINAL record (pre-draft). Returns
 * { value, converted, roleFilterUnresolved }.
 */
export async function assignItemsToSegmentViaMetadata(segment, { roleIds = [], entIds = [] }) {
  const existingTarget = segmentMetadataTarget(segment);
  if (existingTarget) {
    await tagAccessWithBoundaryValue({
      key: existingTarget.key,
      entitlementIds: entIds,
      roleIds,
      value: existingTarget.value,
      name: String(segment.name || "").replace(/\s+segment$/i, "").trim() || existingTarget.value,
    });
    return { value: existingTarget.value, converted: false, roleFilterUnresolved: false };
  }

  const metadataKey = (await getTenantSettings()).segmentMetadataAttribute?.trim() || DEFAULT_SEGMENT_METADATA_ATTRIBUTE;
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

  const roleGuid = valueGuid || await resolveRoleValueGuid({ key: metadataKey, value: boundaryValue, roleIds: allRoleIds });

  const draftId = await getSegmentPatchTargetId(segment.id);
  const scopes = [boundaryFilterScope("ENTITLEMENT", metadataKey, boundaryValue)];
  if (roleGuid) {
    scopes.push(boundaryFilterScope("ROLE", metadataKey, roleGuid));
  } else {
    console.warn(`[segments] no ROLE GUID for "${metadataKey}:${boundaryValue}" — no ROLE scope written on the converted segment`);
  }
  await withApiRetry(
    () => iscPatch(`/v2026/data-segments/${draftId}`, [{ op: "replace", path: "/scopes", value: scopes }], { headers: DATA_SEGMENTS_HEADERS }),
    { label: `assignItemsToSegmentViaMetadata: convert "${segment.name}"` }
  );
  return { value: boundaryValue, converted: true, roleFilterUnresolved: !roleGuid };
}

// ─── Create routes ───────────────────────────────────────────────────────────

/**
 * POST /api/insights/segment-scans/:id/create
 * Creates a real (draft, disabled) Data Segment for each selected suggestion
 * that hasn't already been created. A "metadata"-mode scan first TAGS the
 * suggested roles/entitlements with the Boundary metadata value for the
 * suggestion and gives the segment a FILTER Access Model on that metadata;
 * a "selection" scan writes explicit (50-capped) selections.
 * Returns { results: [{ id, ok, segmentId?, segmentName?, identityScope?, dropped?, tagged?, error? }] }.
 */
export async function createSegmentsFromScan(scanId, suggestionIds) {
  const scan = await loadScan(scanId);
  if (!Array.isArray(suggestionIds) || suggestionIds.length === 0) {
    throw badRequest("suggestionIds must be a non-empty array.");
  }
  const chosen = (scan.suggestions || []).filter(
    (s) => suggestionIds.includes(s.id) && !s.segmentCreated && !s.existingSegmentName
  );
  if (chosen.length === 0) {
    throw badRequest("Nothing to create — the selected suggestions were already created.");
  }

  const metadataMode = scan.mode === "metadata";
  // Which Global Metadata attribute to tag and filter on — configured on
  // Mining Config's Create Data Segments box, "Segments" by default.
  const metadataKey = (await getTenantSettings()).segmentMetadataAttribute?.trim() || DEFAULT_SEGMENT_METADATA_ATTRIBUTE;
  if (metadataMode) {
    // Once per request, not per suggestion — creating the attribute is the
    // only step whose failure should stop everything.
    try {
      await ensureBoundaryMetadataAttribute(metadataKey);
    } catch (err) {
      console.error(`[segments] ensure "${metadataKey}" metadata attribute failed:`, err.response?.data || err.message);
      throw badRequest(
        `Couldn't create the "${metadataKey}" Access Model Metadata attribute: ${describeError(err)}`,
        err.response?.status || 500
      );
    }
  }

  const results = [];
  await segmentCreateProgress().put(scanId, { done: 0, total: chosen.length, startedAt: Date.now() });

  // The attribute's value list, read ONCE for the whole run and updated as
  // values are registered.
  let knownValues = null;
  if (metadataMode) {
    const existing = await iscGet(
      `/v2026/access-model-metadata/attributes/${encodeURIComponent(metadataKey)}/values`,
      { limit: 250 }
    ).catch(() => null);
    if (existing) knownValues = new Set(existing.map((v) => v.value).filter(Boolean));
  }

  // Suggestions are independent, so a few run at a time. Kept low: ISC
  // rate-limits per tenant, so more concurrency just converts wall time into
  // 429 backoff. Failures stay per-suggestion.
  await mapWithConcurrency(chosen, 3, async (suggestion) => {
    try {
      const leaves = scan.boundaryKeys.map((k, i) => segmentEqualsLeaf(k, suggestion.values[i]));
      const suggestedEnts = suggestion.suggestedEntitlements || [];
      const suggestedRoles = suggestion.suggestedRoles || [];

      let scopes;
      let entDropped = 0;
      let roleDropped = 0;
      let tagged = null;

      if (metadataMode) {
        // The boundary value's display name is the combination's raw
        // attribute values joined with " - " (e.g. "BE - Brussels"); the
        // technical name is its slug, registered on the attribute right
        // before the segment is created.
        const boundaryName = (suggestion.values || []).join(" - ");
        const boundaryValue = boundaryValueSlug(boundaryName);
        let valueGuid = await ensureBoundaryMetadataValue(metadataKey, { value: boundaryValue, name: boundaryName, knownValues });

        // The ROLE filter's GUID can only be read off a role that already
        // carries the value, and search-lite indexes asynchronously — so tag
        // ONE role, start the lookup without awaiting it, then tag everything
        // else; the indexing happens DURING the bulk work.
        const allRoleIds = suggestedRoles.map((r) => r.id);
        let guidPending = null;
        if (!valueGuid && allRoleIds.length) {
          await tagAccessWithBoundaryValue({
            key: metadataKey,
            entitlementIds: [],
            roleIds: [allRoleIds[0]],
            value: boundaryValue,
            name: boundaryName,
            skipEnsure: true,
          });
          guidPending = resolveRoleValueGuid({ key: metadataKey, value: boundaryValue, roleIds: [allRoleIds[0]] }).catch(() => null);
        }

        await tagAccessWithBoundaryValue({
          key: metadataKey,
          entitlementIds: suggestedEnts.map((e) => e.id),
          // The pilot role already carries the value.
          roleIds: guidPending ? allRoleIds.slice(1) : allRoleIds,
          value: boundaryValue,
          name: boundaryName,
          skipEnsure: true,
        });
        tagged = { entitlements: suggestedEnts.length, roles: suggestedRoles.length, value: boundaryName };

        // ENTITLEMENT filters resolve by technical name; ROLE filters only by
        // the value's internal GUID (ROLES index only — the entitlements
        // index has a different GUID for the same value).
        if (!valueGuid) {
          valueGuid = guidPending
            ? await guidPending
            : await resolveRoleValueGuid({ key: metadataKey, value: boundaryValue, roleIds: allRoleIds });
        }

        // With no GUID no ROLE scope is written at all, and the result says
        // so — visibly incomplete beats quietly wrong or quietly truncated.
        scopes = [boundaryFilterScope("ENTITLEMENT", metadataKey, boundaryValue)];
        if (valueGuid) {
          scopes.push(boundaryFilterScope("ROLE", metadataKey, valueGuid));
        } else {
          tagged.roleFilterUnresolved = true;
          console.warn(`[segments] no ROLE GUID for "${metadataKey}:${boundaryValue}" — no ROLE scope written; re-pick the value in ISC's segment editor to harvest it`);
        }
      } else {
        // Entitlements: SELECTION of the suggested set if there is one,
        // otherwise UNSEGMENTED. Roles: SELECTION if there is one, otherwise
        // no ROLE scope at all. Both capped at ISC's SCOPE_SELECTION_MAX.
        entDropped = Math.max(0, suggestedEnts.length - SCOPE_SELECTION_MAX);
        roleDropped = Math.max(0, suggestedRoles.length - SCOPE_SELECTION_MAX);

        scopes = [
          suggestedEnts.length
            ? {
                scope: "ENTITLEMENT",
                visibility: "SELECTION",
                scopeFilter: null,
                scopeSelection: suggestedEnts.slice(0, SCOPE_SELECTION_MAX).map((e) => ({ type: "ENTITLEMENT", id: e.id })),
              }
            : { scope: "ENTITLEMENT", visibility: "UNSEGMENTED" },
        ];
        if (suggestedRoles.length) {
          scopes.push({
            scope: "ROLE",
            visibility: "SELECTION",
            scopeFilter: null,
            scopeSelection: suggestedRoles.slice(0, SCOPE_SELECTION_MAX).map((r) => ({ type: "ROLE", id: r.id })),
          });
        }
      }

      // The build criteria decide who is IN the segment (memberFilter). The
      // same criteria also go on the Access Model as an IDENTITY scope, so
      // the segment's members see the identities that match it.
      const identityScope = {
        scope: "IDENTITY",
        visibility: "FILTER",
        scopeFilter: { expression: segmentAndExpression(leaves) },
        scopeSelection: [],
      };
      const createSegment = (withScopes) =>
        iscPost(
          "/v2026/data-segments",
          {
            name: suggestion.name,
            description: suggestion.description,
            membership: "FILTER",
            memberFilter: { expression: segmentAndExpression(leaves) },
            enabled: false,
            published: false,
            scopes: withScopes,
          },
          { headers: DATA_SEGMENTS_HEADERS }
        );
      // If ISC refuses the identity scope specifically (a 400), the segment
      // is still created without it and the result says so.
      let created;
      let identityScopeRejected = null;
      try {
        created = await createSegment([...scopes, identityScope]);
      } catch (err) {
        if (err.response?.status !== 400) throw err;
        identityScopeRejected = err.response?.data?.messages?.[0]?.text || err.response?.data?.detailCode || "rejected by ISC";
        console.warn(`[segments] "${suggestion.name}": ISC refused the IDENTITY scope (${identityScopeRejected}) — creating without it`);
        created = await createSegment(scopes);
      }
      results.push({
        id: suggestion.id, ok: true, segmentId: created?.id, segmentName: created?.name || suggestion.name,
        identityScope: identityScopeRejected ? { applied: false, reason: identityScopeRejected } : { applied: true },
        ...(entDropped || roleDropped ? { dropped: { entitlements: entDropped, roles: roleDropped } } : {}),
        ...(tagged ? { tagged } : {}),
      });
    } catch (err) {
      console.error(
        `[segments] scan create "${suggestion.name}" failed:`,
        err.config?.method?.toUpperCase(), err.config?.url, "->", err.response?.status,
        JSON.stringify(err.response?.data) || err.message
      );
      results.push({ id: suggestion.id, ok: false, error: describeError(err) });
    }
    // Counts attempts, not successes: how far through the run it is.
    await segmentCreateProgress().put(scanId, { done: results.length, total: chosen.length, startedAt: Date.now() });
  });
  await segmentCreateProgress().delete(scanId);

  const updatedSuggestions = (scan.suggestions || []).map((s) => {
    const result = results.find((r) => r.id === s.id);
    if (!result || !result.ok) return s;
    return { ...s, segmentCreated: { segmentId: result.segmentId, segmentName: result.segmentName, createdAt: new Date().toISOString() } };
  });
  await patchRecord(SCANS, scan.id, { suggestions: updatedSuggestions });

  return { results };
}

// Best-effort match of a suggestion's existingSegmentName back to a real
// segment record — prefers the published one if there is one, otherwise any
// record with the name (necessarily a draft-only segment).
function findSegmentIdByName(allSegments, name) {
  const norm = (name || "").trim().toLowerCase();
  if (!norm) return null;
  const published = allSegments.find((s) => (s.name || "").trim().toLowerCase() === norm && s.published);
  if (published) return published.id;
  const any = allSegments.find((s) => (s.name || "").trim().toLowerCase() === norm);
  return any ? any.id : null;
}

/**
 * POST /api/insights/segment-scans/:id/add-to-existing
 * For a suggestion whose name already matches a real segment (nothing was
 * created for it), assigns its suggestedRoles/suggestedEntitlements to the
 * EXISTING segment via the Segments by Metadata tagging method ONLY — a
 * non-metadata segment gets converted to the metadata FILTER pattern.
 * Continues past individual failures; each success is marked on the record.
 */
export async function addScanSuggestionsToExistingSegments(scanId, suggestionIds) {
  const scan = await loadScan(scanId);
  if (!Array.isArray(suggestionIds) || suggestionIds.length === 0) {
    throw badRequest("suggestionIds must be a non-empty array.");
  }
  const chosen = (scan.suggestions || []).filter(
    (s) => suggestionIds.includes(s.id) && s.existingSegmentName && !s.addedToExisting &&
      ((s.suggestedRoles?.length || 0) > 0 || (s.suggestedEntitlements?.length || 0) > 0)
  );
  if (chosen.length === 0) {
    throw badRequest("Nothing to add — the selected suggestions have no existing data segment match, nothing suggested, or were already added.");
  }

  const results = [];
  for (const suggestion of chosen) {
    try {
      const allSegments = await fetchAllDataSegments();
      const matchId = findSegmentIdByName(allSegments, suggestion.existingSegmentName);
      if (!matchId) throw new Error(`Data segment "${suggestion.existingSegmentName}" not found.`);
      const original = allSegments.find((s) => s.id === matchId);

      const outcome = await assignItemsToSegmentViaMetadata(original, {
        roleIds: (suggestion.suggestedRoles || []).map((r) => r.id).filter(Boolean),
        entIds: (suggestion.suggestedEntitlements || []).map((e) => e.id).filter(Boolean),
      });
      results.push({
        id: suggestion.id, ok: true, segmentId: matchId, segmentName: suggestion.existingSegmentName,
        tagged: true, ...(outcome.converted ? { converted: true } : {}),
      });
    } catch (err) {
      console.error(`[segments] scan add-to-existing "${suggestion.existingSegmentName}" failed:`, err.response?.data || err.message);
      results.push({ id: suggestion.id, ok: false, error: describeError(err) });
    }
  }

  const updatedSuggestions = (scan.suggestions || []).map((s) => {
    const result = results.find((r) => r.id === s.id);
    if (!result || !result.ok) return s;
    return { ...s, addedToExisting: { segmentId: result.segmentId, segmentName: result.segmentName, addedAt: new Date().toISOString() } };
  });
  await patchRecord(SCANS, scan.id, { suggestions: updatedSuggestions });

  return { results };
}
