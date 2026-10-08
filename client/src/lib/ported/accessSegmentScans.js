/**
 * ported/accessSegmentScans.js
 * Port of the server's Segments mining routes (ISC access-request Segments,
 * /v2026/segments — NOT Data Segments):
 *
 *   POST   /api/insights/access-segment-scans                     startAccessSegmentScan
 *   GET    /api/insights/access-segment-scans                     listAccessSegmentScans
 *   GET    /api/insights/access-segment-scans/:id                 getAccessSegmentScan
 *   POST   /api/insights/access-segment-scans/:id/cancel          cancelAccessSegmentScan
 *   DELETE /api/insights/access-segment-scans/:id                 deleteAccessSegmentScan
 *   GET    /api/insights/access-segment-scans/:id/create-progress getAccessSegmentCreateProgress
 *   POST   /api/insights/access-segment-scans/:id/create          createAccessSegmentsFromScan
 *
 * An ISC Segment is a member definition (visibilityCriteria) plus a set of
 * access items, each of which lists the segment in its own `segments` array.
 * The mining task proposes one Segment per Multi-Company/Division Boundary
 * value combination: members = the boundary filter, access = every role,
 * access profile and entitlement those members currently hold (identity
 * search). The draft is reviewed before anything is created in ISC.
 *
 * The scan runs in the page (see scanJobs.js). Record shapes, progress
 * fields (scanned / searched) and error messages are the server's.
 */

import { iscGet, iscPost, iscPatch, withApiRetry, describeError, badRequest } from "../isc";
import { recordStore } from "../store";
import { tenantKey, mapWithConcurrency, currentUser } from "./roleShared";
import { startJob, patchRecord, failInterrupted, requestCancel, isCancelled, newScanId } from "./scanJobs";
import { SegmentScanCancelledError, getBoundaryKeys, collectBoundaryCombos, fetchAssignedAccessForCriteria } from "./segmentScans";

const SCANS = "access-segment-scans";
const CREATE_PROGRESS = "access-segment-create-progress";
const accessSegmentScans = () => recordStore(SCANS);
const accessSegmentCreateProgress = () => recordStore(CREATE_PROGRESS);

const NOT_FOUND = "Segments draft not found.";
const BOUNDARY_REQUIRED = "Enable the Multi-Company/Division Boundary with at least one attribute first.";

// The Segment's member definition: one EQUALS per boundary attribute, ANDed
// when there's more than one — ISC's Segment expression shape (operator /
// attribute / value{type,value} / children).
function accessSegmentVisibilityCriteria(boundaryKeys, values) {
  const leaves = boundaryKeys.map((k, i) => ({
    operator: "EQUALS",
    attribute: k,
    value: { type: "STRING", value: String(values[i]) },
    children: null,
  }));
  return { expression: leaves.length === 1 ? leaves[0] : { operator: "AND", attribute: null, value: null, children: leaves } };
}

async function fetchAllIscSegments() {
  const all = [];
  for (let offset = 0; ; offset += 250) {
    const page = await withApiRetry(
      () => iscGet("/v2026/segments", { limit: 250, offset }),
      { label: "segments: list page" }
    );
    if (!Array.isArray(page) || page.length === 0) break;
    all.push(...page);
    if (page.length < 250) break;
  }
  return all;
}

async function runAccessSegmentScan(scanId) {
  try {
    const boundaryKeys = await getBoundaryKeys();
    const combos = await collectBoundaryCombos(boundaryKeys, {
      onScanned: (n) => patchRecord(SCANS, scanId, { scanned: n }),
      isCancelled: () => isCancelled(SCANS, scanId),
    });
    const existing = await fetchAllIscSegments();
    const existingByName = new Map(existing.map((sg) => [String(sg.name || "").trim().toLowerCase(), sg]));

    const suggestions = combos
      .map(({ values, memberCount }, i) => {
        const name = `${values.join(" ")} Segment`;
        const match = existingByName.get(name.trim().toLowerCase());
        return {
          id: `seg-${i}`,
          name,
          description: `Access for identities where ${boundaryKeys.map((k, idx) => `${k} = "${values[idx]}"`).join(" and ")}.`,
          values,
          memberCount,
          visibilityCriteria: accessSegmentVisibilityCriteria(boundaryKeys, values),
          existingSegment: match ? { id: match.id, name: match.name } : null,
          roles: [],
          accessProfiles: [],
          entitlements: [],
          segmentCreated: null,
          addedToExisting: null,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    // What the members actually hold — one identity search per combination.
    let done = 0;
    await mapWithConcurrency(suggestions, 4, async (s) => {
      if (isCancelled(SCANS, scanId)) throw new SegmentScanCancelledError();
      const criteria = boundaryKeys.map((k, idx) => ({ attrKey: k, value: s.values[idx] }));
      try {
        const held = await fetchAssignedAccessForCriteria(criteria);
        s.roles = held.roles;
        s.accessProfiles = held.accessProfiles;
        s.entitlements = held.entitlements;
      } catch (err) {
        console.warn(`[segments-isc] access search failed for "${s.name}":`, err.response?.status || err.message);
        s.searchError = describeError(err);
      }
      done += 1;
      await patchRecord(SCANS, scanId, { searched: done });
    });

    await patchRecord(SCANS, scanId, {
      status: "completed",
      completedAt: new Date().toISOString(),
      boundaryKeys,
      totalCombinations: combos.length,
      suggestions,
    });
  } catch (err) {
    if (err instanceof SegmentScanCancelledError) {
      await patchRecord(SCANS, scanId, { status: "cancelled", completedAt: new Date().toISOString() });
      return;
    }
    console.error(`[segments-isc] scan ${scanId} failed:`, err.response?.data || err.message);
    await patchRecord(SCANS, scanId, { status: "failed", completedAt: new Date().toISOString(), error: describeError(err) });
  }
}

// Adds `segmentId` to each item's own `segments` list. Current lists are
// read in batches (id in (…), 50 per call) so an item's other segments are
// kept and an item already carrying this one is skipped; each change is a
// JSON Patch replace of /segments.
const ACCESS_SEGMENT_ITEM_TYPES = {
  roles: { path: "/v2026/roles", label: "role" },
  accessProfiles: { path: "/v2026/access-profiles", label: "access profile" },
  entitlements: { path: "/v2026/entitlements", label: "entitlement" },
};
async function assignItemsToIscSegment(segmentId, itemsByType) {
  const result = {};
  for (const [type, { path, label }] of Object.entries(ACCESS_SEGMENT_ITEM_TYPES)) {
    const ids = [...new Set((itemsByType[type] || []).filter(Boolean))];
    const out = { requested: ids.length, assigned: 0, alreadyAssigned: 0, failed: [] };
    const current = new Map(); // id -> segments[]
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      const page = await withApiRetry(
        () => iscGet(path, { filters: `id in (${chunk.map((id) => `"${id}"`).join(",")})`, limit: 250 }),
        { label: `segments: read ${label} segments` }
      ).catch(() => []);
      for (const item of page || []) current.set(item.id, Array.isArray(item.segments) ? item.segments : []);
    }
    await mapWithConcurrency(ids, 4, async (id) => {
      const segs = current.get(id) || [];
      if (segs.includes(segmentId)) { out.alreadyAssigned += 1; return; }
      try {
        await withApiRetry(
          () => iscPatch(`${path}/${id}`, [{ op: "replace", path: "/segments", value: [...segs, segmentId] }]),
          { label: `segments: assign ${label} ${id}` }
        );
        out.assigned += 1;
      } catch (err) {
        out.failed.push({ id, error: describeError(err) });
      }
    });
    if (out.failed.length) {
      console.warn(`[segments-isc] ${out.failed.length} ${label}(s) not assigned to ${segmentId} — first:`, out.failed[0].error);
    }
    result[type] = out;
  }
  return result;
}

// ─── Routes ──────────────────────────────────────────────────────────────────

/** POST /api/insights/access-segment-scans — start a Segments scan. Returns { scanId }. */
export async function startAccessSegmentScan() {
  const boundaryKeys = await getBoundaryKeys();
  if (boundaryKeys.length === 0) throw badRequest(BOUNDARY_REQUIRED);

  const scanId = newScanId("accsegscan");
  await accessSegmentScans().put(scanId, {
    id: scanId,
    tenant: tenantKey(),
    status: "running",
    startedAt: new Date().toISOString(),
    completedAt: null,
    scanned: 0,
    searched: 0,
    boundaryKeys,
    totalCombinations: 0,
    suggestions: [],
    error: null,
  });
  startJob(SCANS, scanId, () => runAccessSegmentScan(scanId));
  return { scanId };
}

/** GET /api/insights/access-segment-scans — this tenant's drafts, newest first, without their suggestions. */
export async function listAccessSegmentScans() {
  await failInterrupted(SCANS);
  return Object.values(await accessSegmentScans().all())
    .map(({ suggestions, ...meta }) => ({ ...meta, suggestionCount: suggestions?.length || 0 }))
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
}

async function loadScan(scanId) {
  await failInterrupted(SCANS);
  const scan = await accessSegmentScans().get(scanId);
  if (!scan) throw badRequest(NOT_FOUND, 404);
  return scan;
}

/** GET /api/insights/access-segment-scans/:id */
export async function getAccessSegmentScan(scanId) {
  return loadScan(scanId);
}

/** POST /api/insights/access-segment-scans/:id/cancel */
export async function cancelAccessSegmentScan(scanId) {
  const scan = await loadScan(scanId);
  if (scan.status !== "running") throw badRequest(`Scan is already ${scan.status}.`);
  requestCancel(SCANS, scanId);
  return { cancelling: true };
}

/** DELETE /api/insights/access-segment-scans/:id */
export async function deleteAccessSegmentScan(scanId) {
  const scan = await loadScan(scanId);
  if (scan.status === "running") throw badRequest("Cancel the scan before removing it.");
  await accessSegmentScans().delete(scanId);
}

/** GET /api/insights/access-segment-scans/:id/create-progress -> { done, total } */
export async function getAccessSegmentCreateProgress(scanId) {
  await loadScan(scanId);
  const p = await accessSegmentCreateProgress().get(scanId);
  return { done: p?.done ?? 0, total: p?.total ?? 0 };
}

/**
 * POST /api/insights/access-segment-scans/:id/create
 * For each suggestion: creates the ISC Segment (member definition = the
 * boundary filter) — or, when one with that name already exists, uses it —
 * then assigns the suggestion's roles, access profiles and entitlements.
 * Returns { results: [{ id, ok, merged, segmentId, segmentName, assigned, error }] }.
 */
export async function createAccessSegmentsFromScan(scanId, suggestionIds, { activate = true } = {}) {
  const scan = await loadScan(scanId);
  if (!Array.isArray(suggestionIds) || suggestionIds.length === 0) {
    throw badRequest("suggestionIds must be a non-empty array.");
  }
  const chosen = (scan.suggestions || []).filter((s) => suggestionIds.includes(s.id) && !s.segmentCreated && !s.addedToExisting);
  if (chosen.length === 0) throw badRequest("Nothing to do — the selected segments were already created.");

  const owner = await currentUser();
  await accessSegmentCreateProgress().put(scanId, { done: 0, total: chosen.length, startedAt: Date.now() });
  const results = [];
  let done = 0;
  await mapWithConcurrency(chosen, 2, async (s) => {
    try {
      let segmentId = s.existingSegment?.id || null;
      let segmentName = s.existingSegment?.name || s.name;
      const merged = !!segmentId;
      if (!segmentId) {
        const created = await withApiRetry(
          () => iscPost("/v2026/segments", {
            name: s.name,
            description: s.description,
            owner: owner.id ? { type: "IDENTITY", id: owner.id, name: owner.username } : null,
            visibilityCriteria: s.visibilityCriteria,
            active: !!activate,
          }),
          { label: `segments: create "${s.name}"` }
        );
        segmentId = created.id;
        segmentName = created.name || s.name;
      }
      const assigned = await assignItemsToIscSegment(segmentId, {
        roles: (s.roles || []).map((x) => x.id),
        accessProfiles: (s.accessProfiles || []).map((x) => x.id),
        entitlements: (s.entitlements || []).map((x) => x.id),
      });
      const record = { segmentId, segmentName, at: new Date().toISOString(), assigned };
      if (merged) s.addedToExisting = record;
      else s.segmentCreated = record;
      results.push({ id: s.id, ok: true, merged, segmentId, segmentName, assigned });
    } catch (err) {
      console.error(`[segments-isc] "${s.name}" failed:`, err.response?.data || err.message);
      results.push({ id: s.id, ok: false, error: describeError(err) });
    } finally {
      done += 1;
      await accessSegmentCreateProgress().put(scanId, { done, total: chosen.length, startedAt: Date.now() });
    }
  });
  await patchRecord(SCANS, scanId, { suggestions: scan.suggestions });
  await accessSegmentCreateProgress().put(scanId, { done: 0, total: 0 });
  return { results };
}
