/**
 * ported/segments.js
 * Port of the server's Data Segments routes (/api/segments/*,
 * /api/roles/:id/segments, /api/entitlements/:id/segments): list, detail,
 * access, members, delete, enable/disable, draft, publish.
 *
 * ISC Data Segments (v2026 /data-segments) are distinct from the older
 * /v2026/segments Access Request segments. Every call needs the
 * X-SailPoint-Experimental header. The segment scans and role-match
 * features that build on these helpers are not ported yet.
 */

import { iscGet, iscPost, iscPatch, iscDelete, iscSearchPage, withApiRetry, routeError, badRequest } from "../isc";
import { recordStore } from "../store";
import { tenantKey } from "./roleShared";
import { fillMissingEntitlementInfo } from "./roleEvaluation";

const EXPERIMENTAL = { "X-SailPoint-Experimental": "true" };

// This experimental endpoint's own max limit is 50 (verified live: 51+ 400s
// "semantically invalid"). enabled and published each filter to an exact
// value — there's no combination meaning "all" — so all 4 combos are fetched
// and merged by id. count:true is required, or the endpoint silently drops
// some matching segments (verified live).
const DATA_SEGMENTS_PAGE_SIZE = 50;

async function fetchAllForCombo(params) {
  const all = [];
  for (let offset = 0; ; offset += DATA_SEGMENTS_PAGE_SIZE) {
    const page = await withApiRetry(
      () => iscGet("/v2026/data-segments", { ...params, count: true, limit: DATA_SEGMENTS_PAGE_SIZE, offset }, EXPERIMENTAL),
      { label: "fetchAllForCombo: data-segments page" }
    );
    if (!Array.isArray(page) || page.length === 0) break;
    all.push(...page);
    if (page.length < DATA_SEGMENTS_PAGE_SIZE) break;
  }
  return all;
}

export async function fetchAllDataSegments() {
  const combos = [
    { enabled: true, published: true },
    { enabled: true, published: false },
    { enabled: false, published: true },
    { enabled: false, published: false },
  ];
  const pages = await Promise.all(combos.map((params) => fetchAllForCombo(params)));
  const byId = new Map();
  for (const page of pages) for (const s of page) byId.set(s.id, s);
  return [...byId.values()];
}

// ─── Criteria helpers ────────────────────────────────────────────────────────

/** Every EQUALS leaf of a memberFilter expression as { attrKey, value }. */
export function extractSegmentEqualsLeaves(expr, out = []) {
  if (!expr) return out;
  if (expr.operator === "EQUALS" && expr.attribute) {
    out.push({ attrKey: expr.attribute, value: expr.value?.value });
    return out;
  }
  for (const child of expr.children || []) extractSegmentEqualsLeaves(child, out);
  return out;
}

/** The first EQUALS node (depth-first) of a scope filter expression. */
export function findSegmentEqualsLeaf(expr) {
  if (!expr) return null;
  if (expr.operator === "EQUALS") return expr;
  for (const child of expr.children || []) {
    const leaf = findSegmentEqualsLeaf(child);
    if (leaf) return leaf;
  }
  return null;
}

/** Segment membership is never denormalized, so evaluate memberFilter against the identity's attributes. */
export function identityMatchesSegment(segment, attrs) {
  const leaves = extractSegmentEqualsLeaves(segment.memberFilter?.expression);
  if (leaves.length === 0) return false;
  return leaves.every((l) => String((attrs || {})[l.attrKey] ?? "") === String(l.value ?? ""));
}

const summarizeSegmentForObject = (seg) => ({ id: seg.id, name: seg.name, active: seg.active !== false });
const isGuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v));
const metadataValueIds = () => recordStore("metadata-value-ids");

/**
 * Learns Access Model Metadata value GUIDs from segments someone edited in
 * ISC's own editor: ISC writes the GUID into the ROLE leaf while the same
 * segment's ENTITLEMENT leaf names the value by technical name, so the pair
 * sits side by side. Only ROLE-index GUIDs are stored. Returns how many
 * pairs were new.
 */
export async function harvestMetadataValueGuids(segments) {
  const stored = (await metadataValueIds().get(tenantKey())) || {};
  const found = {};
  for (const seg of Array.isArray(segments) ? segments : []) {
    const leafOf = (scopeType) => {
      const scope = (seg.scopes || []).find((sc) => sc.scope === scopeType && sc.visibility === "FILTER");
      return findSegmentEqualsLeaf(scope?.scopeFilter?.expression);
    };
    const role = leafOf("ROLE");
    const ent = leafOf("ENTITLEMENT");
    // Only an unambiguous pair: same attribute on both scopes, a GUID on the
    // ROLE side and a plain technical name on the ENTITLEMENT side.
    if (!role?.attribute || role.attribute !== ent?.attribute) continue;
    const guid = role.value?.value;
    const technical = ent.value?.value;
    if (!isGuid(guid) || technical == null || isGuid(technical)) continue;
    const mapKey = `${role.attribute}:${technical}`;
    if (stored[mapKey] !== guid) found[mapKey] = String(guid);
  }
  const count = Object.keys(found).length;
  if (count) await metadataValueIds().put(tenantKey(), { ...stored, ...found });
  return count;
}

// ─── Routes ──────────────────────────────────────────────────────────────────

/** GET /api/segments — every Data Segment in the tenant. */
export async function listSegments() {
  try {
    const segments = await fetchAllDataSegments();
    // Every listing is a free chance to learn a GUID; never allowed to fail the listing.
    await harvestMetadataValueGuids(segments).catch((err) => console.warn("[segments] GUID harvest failed:", err.message));
    return segments;
  } catch (err) {
    throw routeError(err);
  }
}

/**
 * GET /api/segments/:id. The single-id GET has the same exact-match
 * enabled/published filtering as the list and unpublished ids can drift
 * between requests, so the id is resolved through a fresh list. `drafts` are
 * the other unpublished records sharing this segment's name.
 */
export async function getSegment(id) {
  try {
    const segments = await fetchAllDataSegments();
    const segment = segments.find((s) => s.id === id);
    if (!segment) throw badRequest("Data segment not found.", 404);
    const drafts = segments.filter((s) => s.id !== segment.id && s.name === segment.name && !s.published);
    return { ...segment, drafts };
  } catch (err) {
    throw routeError(err);
  }
}

async function fetchAllAccessProfiles() {
  const all = [];
  for (let offset = 0; ; offset += 250) {
    const page = await withApiRetry(
      () => iscGet("/v3/access-profiles", { limit: 250, offset }),
      { label: "segment-access: access-profiles page" }
    );
    if (!Array.isArray(page) || page.length === 0) break;
    all.push(...page);
    if (page.length < 250) break;
  }
  return all;
}

// Chunked id-in fetch — a metadata filter can match far more than a
// SELECTION's 50-item cap, and one `id in (...)` filter with 250 ids overruns
// sane URL lengths.
async function fetchByIds(resource, ids, label) {
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const page = await withApiRetry(
      () => iscGet(`/v2026/${resource}`, { filters: `id in (${chunk.map((x) => `"${x}"`).join(",")})`, limit: chunk.length }),
      { label }
    );
    out.push(...(page || []));
  }
  return out;
}

// Best-effort: metadata search is a phased tenant rollout, so an unsupported
// tenant just yields an empty list rather than an error.
async function searchIdsByMetadata(index, key, value) {
  if (!key || value == null) return [];
  try {
    const data = await withApiRetry(
      () => iscPost(
        "/v2026/search",
        { indices: [index], query: { query: `@accessModelMetadata(key:${key} AND value:"${value}")` }, sort: ["name"] },
        { params: { limit: 250 } }
      ),
      { label: `segment-access: metadata search ${index}` }
    );
    return (data || []).map((d) => d.id).filter(Boolean);
  } catch (err) {
    console.warn(`[segments] metadata search (${index}) failed:`, err.response?.data || err.message);
    return [];
  }
}

/**
 * GET /api/segments/:id/access — roles selected on the segment's Access
 * Model (or matched by its metadata filter) and the entitlements reachable
 * through them. Read from the segment's own `scopes`: a role's own
 * `segments` field is never populated (verified live).
 */
export async function getSegmentAccess(segmentId) {
  try {
    const segment = (await fetchAllDataSegments()).find((s) => s.id === segmentId);
    if (!segment) throw badRequest("Data segment not found.", 404);

    const roleScope = (segment.scopes || []).find((s) => s.scope === "ROLE");
    const entScope = (segment.scopes || []).find((s) => s.scope === "ENTITLEMENT");
    const selectedRoleIds = (roleScope?.scopeSelection || []).map((r) => r.id).filter(Boolean);
    const directEntitlementIds =
      entScope?.visibility === "SELECTION" ? (entScope.scopeSelection || []).map((r) => r.id).filter(Boolean) : [];

    // The ROLE scope's leaf value may be the metadata value's GUID, which the
    // search index doesn't match; the ENTITLEMENT leaf always carries the
    // technical name for the same value, so it covers both.
    const entLeaf = entScope?.visibility === "FILTER" ? findSegmentEqualsLeaf(entScope.scopeFilter?.expression) : null;
    const roleLeaf = roleScope?.visibility === "FILTER" ? findSegmentEqualsLeaf(roleScope.scopeFilter?.expression) : null;
    const roleSearchValue = entLeaf?.attribute === roleLeaf?.attribute ? entLeaf?.value?.value : roleLeaf?.value?.value;
    const [roleFilterIds, entFilterIds] = await Promise.all([
      roleLeaf ? searchIdsByMetadata("roles", roleLeaf.attribute, roleSearchValue ?? roleLeaf.value?.value) : [],
      entLeaf ? searchIdsByMetadata("entitlements", entLeaf.attribute, entLeaf.value?.value) : [],
    ]);
    const roleIds = [...new Set([...selectedRoleIds, ...roleFilterIds])];
    const entIds = [...new Set([...directEntitlementIds, ...entFilterIds])];
    const entFilterIdSet = new Set(entFilterIds);

    const [roles, profiles, directEntitlements] = await Promise.all([
      roleIds.length ? fetchByIds("roles", roleIds, "segment-access: roles by id") : [],
      fetchAllAccessProfiles(),
      entIds.length ? fetchByIds("entitlements", entIds, "segment-access: entitlements by id") : [],
    ]);
    const profileById = new Map((profiles || []).map((p) => [p.id, p]));

    // One entitlement can arrive by several paths; record which.
    const entitlements = new Map();
    const add = (ent, via) => {
      if (!ent?.id) return;
      const row = entitlements.get(ent.id) ?? { id: ent.id, name: ent.name, via: [] };
      if (!row.via.includes(via)) row.via.push(via);
      entitlements.set(ent.id, row);
    };
    for (const role of roles) {
      for (const ent of role.entitlements || []) add(ent, `Role: ${role.name}`);
      for (const ref of role.accessProfiles || []) {
        const profile = profileById.get(ref.id);
        for (const ent of profile?.entitlements || []) {
          add(ent, `Access profile: ${ref.name || profile?.name} (via role ${role.name})`);
        }
      }
    }
    for (const ent of directEntitlements) {
      add(ent, entFilterIdSet.has(ent.id) ? "Matches metadata filter" : "Directly selected on segment");
    }

    // Source per entitlement, so the client can roll the list up by source.
    // Only direct ones arrive as full objects; the rest are looked up.
    const entInfo = new Map();
    for (const e of directEntitlements || []) {
      if (e?.id) entInfo.set(e.id, { name: e.name, source: e.source?.id ? { id: e.source.id, name: e.source.name || null } : null });
    }
    await fillMissingEntitlementInfo([...entitlements.keys()], entInfo);

    // Access profiles reach a segment only through its roles.
    const accessProfiles = new Map();
    for (const role of roles) {
      for (const ref of role.accessProfiles || []) {
        if (!ref?.id) continue;
        const row = accessProfiles.get(ref.id) ?? { id: ref.id, name: ref.name || profileById.get(ref.id)?.name || ref.id, via: [] };
        const via = `Role: ${role.name}`;
        if (!row.via.includes(via)) row.via.push(via);
        accessProfiles.set(ref.id, row);
      }
    }

    const byName = (a, b) => (a.name || "").localeCompare(b.name || "");
    return {
      roles: roles.map((r) => ({
        id: r.id, name: r.name, description: r.description, enabled: r.enabled, requestable: r.requestable,
        entitlementCount: (r.entitlements || []).length,
      })),
      accessProfiles: [...accessProfiles.values()].sort(byName),
      entitlements: [...entitlements.values()]
        .map((e) => ({ ...e, sourceName: entInfo.get(e.id)?.source?.name || null }))
        .sort(byName),
      derived: true,
    };
  } catch (err) {
    throw routeError(err);
  }
}

/** GET /api/segments/:id/members — identities inside the segment's boundary, via the Search API. */
export async function listSegmentMembers(id, { limit = 50, offset = 0, query: searchTerm } = {}) {
  try {
    const segment = (await fetchAllDataSegments()).find((s) => s.id === id);
    if (!segment) throw badRequest("Data segment not found.", 404);

    const criteria = extractSegmentEqualsLeaves(segment.memberFilter?.expression);
    if (criteria.length === 0) return { members: [], total: 0 };

    const term = String(searchTerm || "").replace(/[^\w\s'-]/g, "").trim();
    const query = criteria
      .map(({ attrKey, value }) => `attributes.${attrKey}:"${String(value).replace(/"/g, '\\"')}"`)
      .join(" AND ") + (term ? ` AND name:*${term}*` : "");

    const { items, total } = await withApiRetry(
      () => iscSearchPage({ indices: ["identities"], query: { query }, sort: ["name"] }, { limit, offset, count: true }),
      { label: "segment members page" }
    );
    return { members: items, total: total != null ? total : items.length };
  } catch (err) {
    throw routeError(err);
  }
}

/**
 * Segments that select a role/entitlement, by two mechanisms:
 * 1. SELECTION scopes list the id in scopeSelection.
 * 2. FILTER scopes (Segments by Metadata) match on the object's own Access
 *    Model Metadata; a ROLE leaf may name the value by GUID, which maps back
 *    via the harvested store or the same segment's ENTITLEMENT leaf.
 */
async function computeSegmentsContainingScope(scopeType, objectId) {
  const allSegments = await fetchAllDataSegments();

  const selectionMatches = allSegments.filter((seg) => {
    const scope = (seg.scopes || []).find((s) => s.scope === scopeType);
    return scope?.visibility === "SELECTION" && (scope.scopeSelection || []).some((r) => r.id === objectId);
  });

  // The object's metadata as "key:value" pairs — technical value and display
  // name both, since hand-authored filters have been seen using either.
  const ammPairs = new Set();
  try {
    const resource = scopeType === "ROLE" ? "roles" : "entitlements";
    const obj = await withApiRetry(
      () => iscGet(`/v2026/${resource}/${objectId}`),
      { label: `segments-for-object: get ${resource} ${objectId}` }
    );
    for (const attr of obj?.accessModelMetadata?.attributes || []) {
      for (const v of attr.values || []) {
        if (v.value != null) ammPairs.add(`${attr.key}:${v.value}`);
        if (v.name != null) ammPairs.add(`${attr.key}:${v.name}`);
      }
    }
  } catch (err) {
    console.warn(`[segments] metadata read for ${scopeType} ${objectId} failed:`, err.response?.data || err.message);
  }

  const stored = (await metadataValueIds().get(tenantKey())) || {};
  const guidToPair = new Map(Object.entries(stored).map(([pair, guid]) => [guid, pair]));

  const filterMatches = ammPairs.size === 0 ? [] : allSegments.filter((seg) => {
    const scope = (seg.scopes || []).find((s) => s.scope === scopeType && s.visibility === "FILTER");
    const leaf = findSegmentEqualsLeaf(scope?.scopeFilter?.expression);
    if (!leaf?.attribute || leaf.value?.value == null) return false;
    let key = leaf.attribute;
    let value = String(leaf.value.value);
    if (isGuid(value)) {
      const mapped = guidToPair.get(value);
      if (mapped) {
        const idx = mapped.indexOf(":");
        key = mapped.slice(0, idx);
        value = mapped.slice(idx + 1);
      } else {
        // Fall back to the sibling scope's leaf: same segment, same value, by technical name.
        const sibling = (seg.scopes || []).find((s) => s.scope !== scopeType && s.visibility === "FILTER");
        const sibLeaf = findSegmentEqualsLeaf(sibling?.scopeFilter?.expression);
        if (sibLeaf?.attribute === key && sibLeaf.value?.value && !isGuid(String(sibLeaf.value.value))) {
          value = String(sibLeaf.value.value);
        }
      }
    }
    return ammPairs.has(`${key}:${value}`);
  });

  const byId = new Map();
  for (const seg of [...selectionMatches, ...filterMatches]) byId.set(seg.id, seg);
  return [...byId.values()];
}

/** GET /api/roles/:id/segments */
export async function getRoleSegments(roleId) {
  try {
    return (await computeSegmentsContainingScope("ROLE", roleId)).map(summarizeSegmentForObject);
  } catch (err) {
    throw routeError(err);
  }
}

/** GET /api/entitlements/:id/segments */
export async function getEntitlementSegments(entitlementId) {
  try {
    return (await computeSegmentsContainingScope("ENTITLEMENT", entitlementId)).map(summarizeSegmentForObject);
  } catch (err) {
    throw routeError(err);
  }
}

/**
 * DELETE /api/segments/:id. A segment can be a draft and a published version
 * at once, and ISC's `published` param picks which one is removed, so both are
 * tried; only fails if neither existed. The segment's value in the Global
 * Metadata attribute is deliberately left alone: tagged roles/entitlements keep
 * their tags, and a re-created value would get a new GUID.
 */
export async function deleteSegment(id) {
  try {
    const attempts = await Promise.allSettled([
      iscDelete(`/v2026/data-segments/${id}`, { params: { published: false }, headers: EXPERIMENTAL }),
      iscDelete(`/v2026/data-segments/${id}`, { params: { published: true }, headers: EXPERIMENTAL }),
    ]);
    if (!attempts.some((a) => a.status === "fulfilled")) throw attempts[0].reason;
  } catch (err) {
    throw routeError(err);
  }
}

/**
 * The record to PATCH for a segment: a published segment can't be patched
 * directly (ISC 404s), so use its same-named draft if there is one, else
 * revert it to draft in place the way ISC's own UI does — POST its full
 * current representation, id included, to /beta/data-segments with
 * published:false (verified live from a captured request).
 */
export async function getSegmentPatchTargetId(segmentId) {
  const all = await fetchAllDataSegments();
  const target = all.find((s) => s.id === segmentId);
  if (!target) throw badRequest("Data segment not found.", 404);
  if (!target.published) return target.id;

  const existingDraft = all.find((s) => s.id !== target.id && s.name === target.name && !s.published);
  if (existingDraft) return existingDraft.id;

  try {
    const updated = await withApiRetry(
      () => iscPost("/beta/data-segments", {
        id: target.id,
        name: target.name,
        description: target.description,
        membership: target.membership,
        memberFilter: target.memberFilter,
        memberSelection: target.memberSelection || [],
        scopes: Array.isArray(target.scopes) ? target.scopes : [],
        enabled: !!target.enabled,
        published: false,
        created: target.created,
        modified: target.modified,
        hasCounterpart: target.hasCounterpart ?? false,
      }),
      { label: `getSegmentPatchTargetId: revert "${target.name}" to draft` }
    );
    return updated.id;
  } catch (err) {
    const wrapped = routeError(err);
    wrapped.message = `"${target.name}" is published with no draft, and ISC refused to revert it to draft: ${wrapped.message}`;
    wrapped.response.data = { error: wrapped.message };
    throw wrapped;
  }
}

/** PATCH /api/segments/:id/active — maps to the segment's own `enabled`. */
export async function setSegmentActive(id, active) {
  if (typeof active !== "boolean") throw badRequest("active must be a boolean.");
  try {
    const draftId = await getSegmentPatchTargetId(id);
    return await iscPatch(`/v2026/data-segments/${draftId}`, [{ op: "replace", path: "/enabled", value: active }], { headers: EXPERIMENTAL });
  } catch (err) {
    throw routeError(err);
  }
}

/** POST /api/segments/:id/create-draft — ensures an editable draft exists; a no-op if one does. */
export async function createSegmentDraft(id) {
  try {
    const target = (await fetchAllDataSegments()).find((s) => s.id === id);
    if (!target) throw badRequest("Data segment not found.", 404);
    const wasAlreadyDraft = !target.published;
    const draftId = await getSegmentPatchTargetId(target.id);
    // Reverting reuses the same id, so "created" is a published record whose
    // draft id is unchanged; a separately-id'd draft found by name is the
    // other real outcome.
    const foundExistingDraft = target.published && draftId !== target.id;
    return { draftId, segmentName: target.name, created: target.published && !foundExistingDraft, wasAlreadyDraft };
  } catch (err) {
    throw routeError(err);
  }
}

/** POST /api/segments/publish — a segment's memberFilter has no effect on real identities until published. */
export async function publishSegments(ids) {
  if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => typeof id !== "string")) {
    throw badRequest("ids must be a non-empty array of data segment id strings.");
  }
  try {
    await iscPost("/v2026/data-segments/publish", ids, { params: { publishAll: false }, headers: EXPERIMENTAL });
    return { published: ids.length };
  } catch (err) {
    throw routeError(err);
  }
}

/**
 * GET /api/metadata-value-guids — the stored value -> GUID map reversed, so a
 * segment's ROLE filter (which ISC records by GUID) can be shown by name.
 * Display names come from the attribute's own values list, one call per
 * distinct attribute; a name that can't be fetched falls back to the
 * technical value. Never fails: an error yields an empty map.
 */
export async function getMetadataValueGuids() {
  try {
    const stored = (await metadataValueIds().get(tenantKey())) || {};
    // "key:technicalValue" -> guid; attribute keys can't contain ":", so the first colon splits.
    const parsed = Object.entries(stored)
      .filter(([, guid]) => typeof guid === "string" && guid)
      .map(([mapKey, guid]) => {
        const i = mapKey.indexOf(":");
        return { guid, key: i === -1 ? mapKey : mapKey.slice(0, i), value: i === -1 ? "" : mapKey.slice(i + 1) };
      });
    const names = {};
    for (const key of [...new Set(parsed.map((p) => p.key))]) {
      const values = await iscGet(
        `/v2026/access-model-metadata/attributes/${encodeURIComponent(key)}/values`,
        { limit: 250 }
      ).catch(() => []);
      for (const v of values || []) if (v?.value) names[`${key}:${v.value}`] = v.name || v.value;
    }
    const byGuid = {};
    for (const { guid, key, value } of parsed) byGuid[guid] = { key, value, name: names[`${key}:${value}`] || value };
    return { byGuid, count: Object.keys(byGuid).length };
  } catch (err) {
    console.warn("[segments] metadata-value-guids failed:", err.response?.status || err.message);
    return { byGuid: {}, count: 0 };
  }
}
