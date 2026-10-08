/**
 * ported/skeletonScans.js
 * Skeleton Role Model drafts — ports of
 *   POST   /api/insights/skeleton-scans                          (startSkeletonScan)
 *   GET    /api/insights/skeleton-scans                          (listSkeletonScans)
 *   GET    /api/insights/skeleton-scans/:id                      (getSkeletonScan)
 *   POST   /api/insights/skeleton-scans/:id/cancel               (cancelSkeletonScan)
 *   DELETE /api/insights/skeleton-scans/:id                      (deleteSkeletonScan)
 *   POST   /api/insights/skeleton-scans/:id/results/:index/create (createSkeletonScanRole)
 *
 * A lighter-weight relative of the peer-group scan: no entitlement fetching
 * at all — skeleton roles carry membership and dimensions only. Buckets by
 * the top attribute (Schema Analysis / Mining Config), one role per distinct
 * value, plus a dimension per distinct value of the second attribute when
 * Create Dynamic Roles is on. Records live in the per-tenant
 * "skeleton-scans" store; planning runs in this page (see scanJobs).
 */

import { iscPost, describeError, routeError, badRequest } from "../isc";
import { recordStore } from "../store";
import { applyRoleNaming } from "../roleNaming";
import { tenantKey, currentUser, getTenantSettings } from "./roleShared";
import {
  searchAllIdentities,
  fetchScopeIds,
  getRoleScanAttributeKeys,
  parseSimpleScopeCriteria,
  partitionProfilesByBoundary,
} from "./roleMiningShared";
import { enableRoleCommonAccess } from "./roleCommonAccess";
import { createRoleDimensionOnServer } from "./roleDimensions";
import { startJob, patchRecord, failInterrupted, requestCancel, isCancelled, newScanId } from "./scanJobs";

const STORE = "skeleton-scans";
const skeletonScans = () => recordStore(STORE);
const updateSkeletonScan = (scanId, patch) => patchRecord(STORE, scanId, patch);

const notFound = () => badRequest("Skeleton scan not found.", 404);

async function loadScan(id) {
  await failInterrupted(STORE);
  const scan = await skeletonScans().get(id);
  if (!scan) throw notFound();
  return scan;
}

/**
 * Plans a Skeleton Role Model draft: one proposed role per distinct value
 * of the primary attribute (per Boundary partition when on), plus a Common
 * Access role per partition when the Scan Scope is a simple attribute=value
 * query. Stored as a DRAFT and created in ISC only on demand.
 */
async function runSkeletonScan(scanId, namingOverrides) {
  const cancelledNow = () => isCancelled(STORE, scanId);
  const settings = await getTenantSettings();
  // The caller's own naming (typed on the Skeleton Roles screen, never
  // persisted) wins when provided, otherwise Mining Config's saved defaults.
  const rolePrefix = namingOverrides?.rolePrefix ?? settings.rolePrefix;
  const roleSuffix = namingOverrides?.roleSuffix ?? settings.roleSuffix;
  const attributeSeparator = namingOverrides?.attributeSeparator ?? settings.attributeSeparator ?? " - ";
  const attributeKeys = await getRoleScanAttributeKeys();
  const primaryKey = attributeKeys[0];
  const secondaryKey = settings.createDynamicRoles ? attributeKeys[1] : null;

  // Multi-Company/Division Boundary — same setting Role Scan partitions by.
  // useBoundary lets this one run opt in/out regardless of the persisted
  // setting; undefined falls back to Schema Analysis's roleBoundaryEnabled.
  const boundaryAnalysis = await recordStore("schema-analysis").get(tenantKey());
  const roleBoundaryEnabled = namingOverrides?.useBoundary !== undefined
    ? !!namingOverrides.useBoundary
    : !!boundaryAnalysis?.roleBoundaryEnabled;
  const roleBoundaryAttributes = roleBoundaryEnabled ? (boundaryAnalysis?.roleBoundaryAttributes || []) : [];
  const profileAttributeKeys = roleBoundaryAttributes.length > 0
    ? [...new Set([...attributeKeys, ...roleBoundaryAttributes])]
    : attributeKeys;

  await updateSkeletonScan(scanId, {
    attributeKeys, primaryKey, secondaryKey, rolePrefix, roleSuffix, attributeSeparator,
    roleBoundaryEnabled: roleBoundaryAttributes.length > 0, roleBoundaryAttributes,
    scopeQuery: settings.nameScope || null, createDynamicRoles: !!settings.createDynamicRoles,
  });

  try {
    const scopeIds = await fetchScopeIds(["identities"], settings.nameScope);

    const profiles = [];
    await searchAllIdentities({
      pageSize: 250,
      onPage: async (page, totalScanned) => {
        if (cancelledNow()) return false;
        for (const idn of page) {
          if (scopeIds && !scopeIds.has(idn.id)) continue;
          const attrs = {};
          for (const key of profileAttributeKeys) attrs[key] = idn.attributes?.find((a) => a.key === key)?.value || "Unknown";
          profiles.push({ id: idn.id, name: idn.name, email: idn.email || null, manager: idn.manager?.name || null, attrs });
        }
        await updateSkeletonScan(scanId, { scanned: totalScanned });
      },
    });

    if (cancelledNow()) {
      await updateSkeletonScan(scanId, { status: "cancelled", completedAt: new Date().toISOString() });
      return;
    }

    const planned = [];
    // Only supported when the scope query is a simple single attribute=value
    // query (see parseSimpleScopeCriteria) — same across every partition.
    const scopeCriteria = parseSimpleScopeCriteria(settings.nameScope);
    const partitions = roleBoundaryAttributes.length > 0
      ? partitionProfilesByBoundary(profiles, roleBoundaryAttributes)
      : [{ values: [], profiles }];

    for (const partition of partitions) {
      if (cancelledNow()) break;
      const boundaryLeaves = roleBoundaryAttributes.map((key, i) => ({ key, value: partition.values[i] }));
      const boundaryNamePart = boundaryLeaves.map((l) => l.value).join(attributeSeparator);
      const boundaryDescPart = boundaryLeaves.length
        ? ` and ${boundaryLeaves.map((l) => `${l.key} = "${l.value}"`).join(", ")}`
        : "";
      const boundaryCriteriaLeaves = boundaryLeaves.map((l) => ({
        operation: "EQUALS",
        key: { type: "IDENTITY", property: `attribute.${l.key}`, sourceId: null },
        values: [l.value], stringValue: null, children: null,
      }));
      const members = (list) => list.map((p) => ({ id: p.id, name: p.name, email: p.email || null, manager: p.manager || null })).sort((a, b) => String(a.name).localeCompare(String(b.name)));

      // Common Access role for this partition: membership is the scope plus
      // the partition's boundary values; never any entitlements.
      if (scopeCriteria) {
        const commonAccessName = applyRoleNaming(
          [boundaryNamePart, "Common Access"].filter(Boolean).join(" - "),
          rolePrefix, roleSuffix
        );
        const scopeLeaf = {
          operation: "EQUALS",
          key: { type: "IDENTITY", property: `attribute.${scopeCriteria.attrKey}`, sourceId: null },
          values: [scopeCriteria.value], stringValue: null, children: null,
        };
        planned.push({
          kind: "commonAccess", isCommonAccess: true,
          roleName: commonAccessName,
          description: `Skeleton Common Access role for scope ${scopeCriteria.attrKey} = "${scopeCriteria.value}"${boundaryDescPart} — membership only, no entitlements assigned yet.`,
          criteria: [{ key: scopeCriteria.attrKey, value: scopeCriteria.value }, ...boundaryLeaves],
          boundary: boundaryLeaves,
          membership: {
            type: "STANDARD",
            criteria: boundaryCriteriaLeaves.length > 0
              ? { operation: "AND", key: null, values: null, stringValue: null, children: [scopeLeaf, ...boundaryCriteriaLeaves] }
              : scopeLeaf,
          },
          memberCount: partition.profiles.length,
          members: members(partition.profiles),
          dimensional: false, dimensionAttribute: null, dimensionValues: [],
          entitlements: [],
        });
      }

      const buckets = new Map();
      for (const p of partition.profiles) {
        const value = p.attrs[primaryKey];
        if (!value || value === "Unknown") continue;
        if (!buckets.has(value)) buckets.set(value, []);
        buckets.get(value).push(p);
      }
      for (const [value, bucket] of [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        if (cancelledNow()) break;
        // Skeleton roles never carry entitlements — membership and dimensions only.
        const roleName = applyRoleNaming([...boundaryLeaves.map((l) => l.value), value].join(attributeSeparator), rolePrefix, roleSuffix);
        const dimValues = secondaryKey
          ? [...new Set(bucket.map((m) => m.attrs[secondaryKey]).filter((v) => v && v !== "Unknown"))].sort()
          : [];
        const isDynamic = dimValues.length > 0;
        // Members per dimension value — for the draft screen and printout.
        const dimensionCounts = isDynamic
          ? dimValues.map((dv) => ({ value: dv, members: bucket.filter((m) => m.attrs[secondaryKey] === dv).length }))
          : [];
        const membership = {
          type: "STANDARD",
          criteria: {
            operation: "OR", key: null, values: null, stringValue: null,
            children: [{
              operation: "AND", key: null, values: null, stringValue: null,
              children: [
                { operation: "EQUALS", key: { type: "IDENTITY", property: "attribute.cloudLifecycleState", sourceId: null }, values: ["active"], stringValue: null, children: null },
                { operation: "EQUALS", key: { type: "IDENTITY", property: `attribute.${primaryKey}`, sourceId: null }, values: [value], stringValue: null, children: null },
                ...boundaryCriteriaLeaves,
              ],
            }],
          },
        };
        planned.push({
          kind: "role", isCommonAccess: false,
          roleName,
          description: `Skeleton role auto-generated for ${primaryKey} = "${value}"${boundaryDescPart} — membership and dimensions only, no entitlements assigned yet.`,
          criteria: [...boundaryLeaves, { key: primaryKey, value }],
          boundary: boundaryLeaves,
          membership,
          memberCount: bucket.length,
          members: members(bucket),
          dimensional: isDynamic, dimensionAttribute: isDynamic ? secondaryKey : null, dimensionValues: dimValues, dimensionCounts,
          entitlements: [],
        });
        await updateSkeletonScan(scanId, { planned: planned.length });
      }
    }

    if (cancelledNow()) {
      await updateSkeletonScan(scanId, { status: "cancelled", completedAt: new Date().toISOString() });
      return;
    }

    const results = planned.map((p, index) => ({ ...p, index, status: "planned", roleId: null, error: null }));
    await updateSkeletonScan(scanId, {
      status: "completed", completedAt: new Date().toISOString(),
      results, planned: results.length, created: 0, failed: 0,
    });
  } catch (err) {
    console.error(`[insights] skeleton scan ${scanId} failed:`, err.response?.data || err.message);
    await updateSkeletonScan(scanId, { status: "failed", completedAt: new Date().toISOString(), error: describeError(err) });
  }
}

/** Creates one planned skeleton role in ISC (disabled, not requestable) with its dimensions and Common Access flag. */
async function createSkeletonRoleInIsc(item) {
  const labelize = (k) => (k || "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
  const me = await currentUser();
  const role = await iscPost("/v2026/roles", {
    name: item.roleName,
    description: item.description,
    owner: { type: "IDENTITY", id: me.id, name: me.username },
    entitlements: [],
    enabled: false,
    requestable: false,
    membership: item.membership,
    ...(item.dimensional
      ? {
          dimensional: true,
          accessRequestConfig: {
            dimensionSchema: { dimensionAttributes: [{ name: item.dimensionAttribute, displayName: labelize(item.dimensionAttribute), derived: true }] },
          },
        }
      : {}),
  });
  const out = { roleId: role.id, roleName: role.name || item.roleName, dimensions: [], commonAccessFlagged: null, commonAccessError: null };
  if (item.isCommonAccess) {
    try {
      await enableRoleCommonAccess(role.id);
      out.commonAccessFlagged = true;
    } catch (caErr) {
      console.error(`[insights] skeleton: common-access flag failed for role ${role.id}:`, caErr.response?.data || caErr.message);
      out.commonAccessFlagged = false;
      out.commonAccessError = describeError(caErr);
    }
  }
  if (item.dimensional) {
    for (const dv of item.dimensionValues || []) {
      try {
        await createRoleDimensionOnServer(role.id, { name: dv, attrKey: item.dimensionAttribute, value: dv, entitlements: [] });
        out.dimensions.push({ value: dv, ok: true });
      } catch (err) {
        out.dimensions.push({ value: dv, ok: false, error: describeError(err) });
      }
    }
  }
  return out;
}

/**
 * POST /api/insights/skeleton-scans
 * { rolePrefix?, roleSuffix?, attributeSeparator?, useBoundary? } -> { scanId }
 * One-off overrides for this draft only, never persisted. Nothing is created in ISC.
 */
export async function startSkeletonScan({ rolePrefix, roleSuffix, attributeSeparator, useBoundary } = {}) {
  const scanId = newScanId("skeletonscan");
  await updateSkeletonScan(scanId, {
    id: scanId,
    tenant: tenantKey(),
    status: "running",
    startedAt: new Date().toISOString(),
    completedAt: null,
    scanned: 0,
    planned: 0,
    created: 0,
    failed: 0,
    results: [],
    error: null,
  });
  startJob(STORE, scanId, () => runSkeletonScan(scanId, { rolePrefix, roleSuffix, attributeSeparator, useBoundary }));
  return { scanId };
}

/** GET /api/insights/skeleton-scans — drafts, newest first (results stripped for size). */
export async function listSkeletonScans() {
  await failInterrupted(STORE);
  return Object.values(await skeletonScans().all())
    .map(({ results, ...meta }) => ({ ...meta, planned: meta.planned ?? (results || []).length, created: meta.created ?? (results || []).filter((r) => r.roleId || r.ok).length }))
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
}

/** GET /api/insights/skeleton-scans/:id — full draft with every proposed role and its members. */
export async function getSkeletonScan(scanId) {
  return loadScan(scanId);
}

/**
 * POST /api/insights/skeleton-scans/:id/results/:index/create — creates ONE
 * planned role from the draft in ISC. A failed row can be retried; an
 * already-created row is refused. Returns the updated row without its
 * members/membership.
 */
export async function createSkeletonScanRole(scanId, index) {
  const scan = await loadScan(scanId);
  if (scan.status === "running") throw badRequest("Wait for planning to finish first.");
  const idx = Number(index);
  const item = Number.isInteger(idx) ? (scan.results || [])[idx] : null;
  if (!item) throw badRequest("Role not found in this draft.", 404);
  if (item.roleId) throw badRequest("This role has already been created in ISC.");
  const wasFailed = item.status === "failed";
  try {
    const created = await createSkeletonRoleInIsc(item);
    const updated = { ...item, ...created, status: "created", ok: true, error: null, createdAt: new Date().toISOString() };
    const results = scan.results.map((r, i) => (i === idx ? updated : r));
    await updateSkeletonScan(scan.id, { results, created: (scan.created || 0) + 1, failed: Math.max(0, (scan.failed || 0) - (wasFailed ? 1 : 0)) });
    const { members, membership, ...slim } = updated;
    return slim;
  } catch (err) {
    console.error(`[insights] skeleton: role "${item.roleName}" failed:`, err.response?.data || err.message);
    const updated = { ...item, status: "failed", ok: false, error: describeError(err) };
    const results = scan.results.map((r, i) => (i === idx ? updated : r));
    await updateSkeletonScan(scan.id, { results, failed: (scan.failed || 0) + (wasFailed ? 0 : 1) });
    throw routeError(err);
  }
}

/** POST /api/insights/skeleton-scans/:id/cancel -> { ok: true } */
export async function cancelSkeletonScan(scanId) {
  const scan = await loadScan(scanId);
  if (scan.status === "running") requestCancel(STORE, scanId);
  return { ok: true };
}

/** DELETE /api/insights/skeleton-scans/:id — removes the draft record only; roles already created stay in ISC. */
export async function deleteSkeletonScan(scanId) {
  const scan = await loadScan(scanId);
  if (scan.status === "running") throw badRequest("Wait for planning to finish (or cancel it) before removing it.");
  await skeletonScans().delete(scanId);
}
