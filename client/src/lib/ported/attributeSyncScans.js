/**
 * ported/attributeSyncScans.js
 * Attribute Sync model scans — ports of
 *   POST   /api/insights/attribute-sync-scans            (startAttributeSyncScan)
 *   GET    /api/insights/attribute-sync-scans            (listAttributeSyncScans)
 *   GET    /api/insights/attribute-sync-scans/:id        (getAttributeSyncScan)
 *   DELETE /api/insights/attribute-sync-scans/:id        (deleteAttributeSyncScan)
 *   POST   /api/insights/attribute-sync-scans/:id/deploy (deployAttributeSyncScan)
 *
 * For every source: reads its CREATE provisioning policy, account schema and
 * live attribute-sync-config, and proposes which identity->account mappings
 * to keep in continuous sync. Records live in the per-tenant
 * "attribute-sync-scans" store; the scan runs in this page (see scanJobs).
 */

import { iscGet, iscPut, withApiRetry, describeError, routeError, badRequest } from "../isc";
import { recordStore } from "../store";
import { tenantKey, mapWithConcurrency } from "./roleShared";
import { startJob, patchRecord, failInterrupted, newScanId } from "./scanJobs";

const STORE = "attribute-sync-scans";
const attributeSyncScans = () => recordStore(STORE);
const updateAttributeSyncScan = (scanId, patch) => patchRecord(STORE, scanId, patch);

const EXPERIMENTAL = { "X-SailPoint-Experimental": "true" };
const ATTRIBUTE_SYNC_SOURCE_CONCURRENCY = 5;

const notFound = () => badRequest("Attribute sync scan not found.", 404);

async function loadScan(id) {
  await failInterrupted(STORE);
  const scan = await attributeSyncScans().get(id);
  if (!scan) throw notFound();
  return scan;
}

/** Pages through every source in the tenant. */
async function fetchAllSources() {
  const all = [];
  let offset = 0;
  const pageSize = 250;
  while (true) {
    const page = await iscGet("/v2026/sources", { limit: pageSize, offset, sorters: "name" });
    if (!Array.isArray(page) || page.length === 0) break;
    all.push(...page);
    if (page.length < pageSize) break;
    offset += pageSize;
  }
  return all;
}

// Builds the proposed attribute-sync mapping list for one source. Skipped
// (not an error) for sources with no CREATE provisioning policy at all or
// whose connector doesn't support attribute sync (the config GET 404s/400s).
async function scanSourceForAttributeSync(source) {
  let policies, schemas, currentConfig;
  try {
    [policies, schemas] = await Promise.all([
      withApiRetry(() => iscGet(`/v2026/sources/${source.id}/provisioning-policies`), { label: `provisioning-policies ${source.name}` }),
      withApiRetry(() => iscGet(`/v2026/sources/${source.id}/schemas`), { label: `schemas ${source.name}` }),
    ]);
  } catch (err) {
    return { sourceId: source.id, sourceName: source.name, sourceType: source.type, skipped: true, reason: "Could not read schema or provisioning policies." };
  }

  const createPolicy = (Array.isArray(policies) ? policies : []).find((p) => p.usageType === "CREATE");
  const identityMappedFields = (createPolicy?.fields || []).filter((f) => f.transform?.type === "identityAttribute" && f.transform?.attributes?.name);
  if (identityMappedFields.length === 0) {
    return { sourceId: source.id, sourceName: source.name, sourceType: source.type, skipped: true, reason: "No CREATE provisioning policy with identity-attribute-mapped fields." };
  }

  const accountSchema = (Array.isArray(schemas) ? schemas : []).find((s) => s.name === "account") || schemas?.[0];
  const nativeFields = new Set([accountSchema?.identityAttribute, accountSchema?.displayAttribute].filter(Boolean));

  try {
    currentConfig = await withApiRetry(
      () => iscGet(`/beta/sources/${source.id}/attribute-sync-config`, undefined, EXPERIMENTAL),
      { label: `attribute-sync-config ${source.name}` }
    );
  } catch (err) {
    return { sourceId: source.id, sourceName: source.name, sourceType: source.type, skipped: true, reason: "This connector doesn't support Attribute Sync." };
  }
  const currentByPair = new Map((currentConfig?.attributes || []).map((a) => [`${a.name} ${a.target}`, a]));

  const proposed = identityMappedFields.map((f) => {
    const name = f.transform.attributes.name; // identity attribute
    const target = f.name; // account attribute
    const key = `${name} ${target}`;
    const existing = currentByPair.get(key);
    const isNativeField = nativeFields.has(target);
    return {
      name,
      target,
      recommended: !isNativeField,
      reason: isNativeField ? "Native identity/naming attribute for this source — excluded from continuous sync by default." : null,
      existsInLiveConfig: !!existing,
      currentlyEnabled: existing ? existing.enabled : false,
    };
  });

  return {
    sourceId: source.id,
    sourceName: source.name,
    sourceType: source.type,
    skipped: false,
    proposed,
    // existsInLiveConfig is informational only, not a deploy gate: deploy
    // adds a new entry for a recommended pair ISC hasn't enumerated yet.
    changeCount: proposed.filter((p) => p.recommended && !p.currentlyEnabled).length,
  };
}

async function runAttributeSyncScan(scanId) {
  try {
    const sources = await fetchAllSources();
    await updateAttributeSyncScan(scanId, { totalSources: sources.length });

    let scanned = 0;
    const results = await mapWithConcurrency(sources, ATTRIBUTE_SYNC_SOURCE_CONCURRENCY, async (source) => {
      const result = await scanSourceForAttributeSync(source);
      scanned += 1;
      await updateAttributeSyncScan(scanId, { scanned });
      return result;
    });

    const usable = results.filter((r) => !r.skipped);
    await updateAttributeSyncScan(scanId, {
      status: "completed",
      completedAt: new Date().toISOString(),
      results,
      sourceCount: usable.length,
      skippedCount: results.length - usable.length,
      proposedChangeCount: usable.reduce((sum, r) => sum + (r.changeCount || 0), 0),
    });
  } catch (err) {
    console.error("[attribute-sync-scan] failed:", err.response?.data || err.message);
    await updateAttributeSyncScan(scanId, {
      status: "failed",
      completedAt: new Date().toISOString(),
      error: describeError(err),
    });
  }
}

/** POST /api/insights/attribute-sync-scans — starts a scan, returns { scanId } immediately. */
export async function startAttributeSyncScan() {
  const scanId = newScanId("attrsync");
  await updateAttributeSyncScan(scanId, {
    id: scanId,
    tenant: tenantKey(),
    status: "running",
    startedAt: new Date().toISOString(),
    completedAt: null,
    totalSources: 0,
    scanned: 0,
    results: [],
    error: null,
  });
  startJob(STORE, scanId, () => runAttributeSyncScan(scanId));
  return { scanId };
}

/** GET /api/insights/attribute-sync-scans — list, newest first (results stripped for size). */
export async function listAttributeSyncScans() {
  await failInterrupted(STORE);
  return Object.values(await attributeSyncScans().all())
    .map(({ results, ...meta }) => meta)
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
}

/** GET /api/insights/attribute-sync-scans/:id — full record, including per-source results. */
export async function getAttributeSyncScan(scanId) {
  return loadScan(scanId);
}

/** DELETE /api/insights/attribute-sync-scans/:id */
export async function deleteAttributeSyncScan(scanId) {
  const scan = await loadScan(scanId);
  if (scan.status === "running") throw badRequest("Wait for the scan to finish before removing it.");
  await attributeSyncScans().delete(scanId);
}

/**
 * POST /api/insights/attribute-sync-scans/:id/deploy
 * { sourceId? } -> { outcomes: [{ sourceId, sourceName, ok, error? }], failedCount }
 * For every source in the scan with recommended changes (or just `sourceId`),
 * re-fetches that source's LIVE attribute-sync-config, flips enabled: true on
 * exactly the mappings this scan recommended (adding entries ISC hasn't
 * enumerated yet), and PUTs the merged list back.
 */
export async function deployAttributeSyncScan(scanId, sourceId) {
  const scan = await loadScan(scanId);
  if (scan.status !== "completed") throw badRequest("Only a completed scan can be deployed.");
  if (sourceId && !(scan.results || []).some((r) => r.sourceId === sourceId)) {
    throw badRequest("That source isn't part of this scan.", 404);
  }

  try {
    const targets = (scan.results || []).filter(
      (r) => !r.skipped && r.changeCount > 0 && (!sourceId || r.sourceId === sourceId)
    );
    if (sourceId && targets.length === 0) {
      throw badRequest("This source has no recommended changes to deploy.");
    }

    // attribute-sync-config entries carry a human displayName for the
    // identity attribute, taken from /v2026/identity-attributes — a brand-new
    // entry needs this lookup rather than a blank displayName.
    let identityAttrDisplayNames = new Map();
    try {
      const attrs = await iscGet("/v2026/identity-attributes", { limit: 250 });
      identityAttrDisplayNames = new Map((attrs || []).map((a) => [a.name, a.displayName]));
    } catch {
      // Non-fatal — new entries fall back to the attribute's technical name.
    }

    const outcomes = await mapWithConcurrency(targets, ATTRIBUTE_SYNC_SOURCE_CONCURRENCY, async (r) => {
      try {
        const live = await iscGet(`/beta/sources/${r.sourceId}/attribute-sync-config`, undefined, EXPERIMENTAL);
        const recommended = r.proposed.filter((p) => p.recommended);
        const existingByPair = new Map((live.attributes || []).map((a) => [`${a.name} ${a.target}`, a]));

        const updatedExisting = (live.attributes || []).map((a) => {
          const isRecommended = recommended.some((p) => p.name === a.name && p.target === a.target);
          return isRecommended ? { ...a, enabled: true } : a;
        });
        const newEntries = recommended
          .filter((p) => !existingByPair.has(`${p.name} ${p.target}`))
          .map((p) => ({
            enabled: true,
            name: p.name,
            target: p.target,
            displayName: identityAttrDisplayNames.get(p.name) || p.name,
          }));

        const merged = { ...live, attributes: [...updatedExisting, ...newEntries] };
        await iscPut(`/beta/sources/${r.sourceId}/attribute-sync-config`, merged, { headers: EXPERIMENTAL });
        return { sourceId: r.sourceId, sourceName: r.sourceName, ok: true };
      } catch (err) {
        console.error(`[attribute-sync-scan] deploy failed for ${r.sourceName}:`, err.response?.data || err.message);
        return { sourceId: r.sourceId, sourceName: r.sourceName, ok: false, error: describeError(err) };
      }
    });

    // Merged by sourceId, not overwritten — deploying one source at a time
    // shouldn't erase the deploy record of sources handled in an earlier call.
    const priorResults = (await attributeSyncScans().get(scanId))?.deployResults || [];
    const bySourceId = new Map(priorResults.map((o) => [o.sourceId, o]));
    for (const o of outcomes) bySourceId.set(o.sourceId, o);

    const failed = outcomes.filter((o) => !o.ok);
    await updateAttributeSyncScan(scanId, {
      deployedAt: new Date().toISOString(),
      deployResults: [...bySourceId.values()],
    });
    return { outcomes, failedCount: failed.length };
  } catch (err) {
    if (!err.isRouteError) console.error("[attribute-sync-scan] deploy failed:", err.response?.data || err.message);
    throw routeError(err);
  }
}
