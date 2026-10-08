/**
 * ported/jsonEdit.js
 * Browser-side port of the old Express PATCH /api/json-edit/:resource/:id
 * route — the detail screens' Raw JSON tab saves: RFC 6902 JSON-Patch ops
 * sent with the application/json-patch+json content type ISC requires.
 * Data segments go through the revert-to-draft-in-place flow (with the
 * experimental header) and Access Model Metadata attributes refuse any op
 * that would delete a built-in attribute's values.
 *
 * Returns the PATCHed object as ISC sends it back. Failures throw
 * routeError()/badRequest() so callers still read err.response.data.error.
 */

import { iscGet, iscPost, iscPatch, withApiRetry, describeError, badRequest } from "../isc";

const JSON_EDIT_RESOURCES = new Set(["roles", "entitlements", "access-profiles", "source-apps", "sources", "data-segments", "segments", "form-definitions", "metadata-attributes"]);
// Resources whose ISC path differs from the client-facing resource segment.
const JSON_EDIT_PATHS = { "metadata-attributes": "access-model-metadata/attributes" };

// ─── Data segments ──────────────────────────────────────────────────────────

const DATA_SEGMENTS_HEADERS = { "X-SailPoint-Experimental": "true" };
// This experimental endpoint's own max limit is 50 (51 and up 400, verified live).
const DATA_SEGMENTS_PAGE_SIZE = 50;

async function fetchAllForCombo(params) {
  const all = [];
  for (let offset = 0; ; offset += DATA_SEGMENTS_PAGE_SIZE) {
    const page = await withApiRetry(
      () => iscGet("/v2026/data-segments", { ...params, count: true, limit: DATA_SEGMENTS_PAGE_SIZE, offset }, DATA_SEGMENTS_HEADERS),
      { label: "fetchAllForCombo: data-segments page" }
    );
    if (!Array.isArray(page) || page.length === 0) break;
    all.push(...page);
    if (page.length < DATA_SEGMENTS_PAGE_SIZE) break;
  }
  return all;
}

// ISC's list endpoint filters "enabled" and "published" to an exact value
// each — there's no single combination that means "all". The only way to see
// every segment regardless of state is to fetch all 4 true/false combinations
// and merge by id (count:true required, or the endpoint silently drops some).
async function fetchAllDataSegments() {
  const combos = [
    { enabled: true, published: true },
    { enabled: true, published: false },
    { enabled: false, published: true },
    { enabled: false, published: false },
  ];
  const pages = await Promise.all(combos.map((params) => fetchAllForCombo(params)));
  const byId = new Map();
  for (const page of pages) {
    for (const s of page) byId.set(s.id, s);
  }
  return [...byId.values()];
}

// A published Data Segment can't be PATCHed directly (ISC 404s on the exact
// same id a GET succeeded on). If it already has an unpublished draft
// counterpart (matched by name) that draft is the target; otherwise the
// published record is reverted to draft in place the way ISC's own UI does
// it — POSTing its full current representation (id included) back to
// /beta/data-segments, which comes back as the same id with published:false.
export async function getSegmentPatchTargetId(segmentId) {
  const all = await fetchAllDataSegments();
  const target = all.find((s) => s.id === segmentId);
  if (!target) throw badRequest("Data segment not found.", 404);
  if (!target.published) return target.id;

  const existingDraft = all.find((s) => s.id !== target.id && s.name === target.name && !s.published);
  if (existingDraft) return existingDraft.id;

  try {
    const updated = await withApiRetry(
      () =>
        iscPost("/beta/data-segments", {
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
    console.error(`[segments] getSegmentPatchTargetId: revert-to-draft failed for "${target.name}":`, err.response?.data || err.message);
    throw badRequest(
      `"${target.name}" is published with no draft, and ISC refused to revert it to draft: ${describeError(err)}`,
      err.response?.status || 500
    );
  }
}

// ─── Access Model Metadata ──────────────────────────────────────────────────

// Values may only be deleted from a CUSTOM Access Model Metadata attribute
// (type exactly "custom" — an allowlist, so a missing or unrecognised type
// counts as built-in). Enforced here because every metadata write — the
// Values tab's batch delete, the value JSON editor, the attribute's Raw JSON
// tab — goes through this one path. Editing a built-in attribute's values in
// place (same technical names) stays allowed; only an op that would drop one
// is refused.
async function assertNoBuiltInMetadataValueRemoval(key, ops) {
  const touchesValues = ops.some((op) => typeof op?.path === "string" && (op.path === "/values" || op.path.startsWith("/values/")));
  if (!touchesValues) return;
  const attribute = await iscGet(`/v2026/access-model-metadata/attributes/${encodeURIComponent(key)}`);
  if (String(attribute?.type || "").toLowerCase() === "custom") return;

  const refuse = () => {
    throw badRequest(`"${attribute?.name || key}" is a built-in metadata attribute — its values can't be deleted.`, 403);
  };
  const existing = new Set((attribute?.values || []).map((v) => v.value));
  for (const op of ops) {
    if (typeof op?.path !== "string") continue;
    const onValues = op.path === "/values";
    const underValues = op.path.startsWith("/values/");
    if (!onValues && !underValues) continue;
    if (op.op === "remove" || op.op === "move") refuse();
    if (onValues && (op.op === "replace" || op.op === "add")) {
      const kept = new Set((Array.isArray(op.value) ? op.value : []).map((v) => v?.value));
      for (const v of existing) if (!kept.has(v)) refuse();
    }
    // Replacing one entry's technical name drops the old value just the same.
    if (underValues && op.op === "replace" && /^\/values\/\d+(\/value)?$/.test(op.path)) {
      const idx = Number(op.path.split("/")[2]);
      const before = attribute?.values?.[idx]?.value;
      const after = op.path.endsWith("/value") ? op.value : op.value?.value;
      if (before !== undefined && after !== before) refuse();
    }
  }
}

// ─── Route ──────────────────────────────────────────────────────────────────

/**
 * PATCH /api/json-edit/:resource/:id — { ops: [...] }
 * resource ∈ roles | entitlements | access-profiles | source-apps | sources |
 * data-segments | segments | form-definitions | metadata-attributes.
 */
export async function patchObjectJson(resource, id, ops) {
  if (!JSON_EDIT_RESOURCES.has(resource)) throw badRequest(`Editing "${resource}" isn't supported.`);
  if (!Array.isArray(ops) || ops.length === 0) throw badRequest("ops must be a non-empty JSON-Patch array.");
  try {
    let targetId = id;
    const extraHeaders = resource === "data-segments" ? DATA_SEGMENTS_HEADERS : {};
    if (resource === "data-segments") {
      targetId = await getSegmentPatchTargetId(id);
    }
    if (resource === "metadata-attributes") {
      await assertNoBuiltInMetadataValueRemoval(id, ops);
    }
    return await iscPatch(`/v2026/${JSON_EDIT_PATHS[resource] || resource}/${targetId}`, ops, { headers: extraHeaders });
  } catch (err) {
    if (err?.isRouteError) throw err;
    console.error(`[json-edit] ${resource}/${id} failed:`, err.response?.data || err.message);
    throw badRequest(err.response?.data?.messages?.[0]?.text || describeError(err), err.response?.status || 500);
  }
}
