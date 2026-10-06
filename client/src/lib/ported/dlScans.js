/**
 * ported/dlScans.js
 * Mail Distribution Group mining — ports of
 *   POST /api/insights/dl-scans                   (startDlScan)
 *   GET  /api/insights/dl-scans/:id               (getDlScan)
 *   POST /api/insights/dl-scans/:id/create        (createDlGroups)
 *   POST /api/insights/dl-scans/:id/add-to-roles  (addDlGroupsToRoles)
 *
 * Same peer-group discovery as role mining, but each peer group becomes a
 * proposed mail distribution group. ISC's public API has no way to create a
 * group on an AD or Entra source, so "create" emits a ready-to-run
 * PowerShell provisioning script. Records live in the per-tenant
 * "dl-scans" store and the scan itself runs in this page (see scanJobs).
 */

import { iscGet, withApiRetry, routeError, badRequest, describeError, fetchAllPaged } from "../isc";
import { recordStore } from "../store";
import { tenantKey, getTenantSettings, extractAllIdentityEqualsLeaves } from "./roleShared";
import {
  searchAllIdentities,
  fetchScopeIds,
  getRoleScanAttributeKeys,
  buildIdentityRoleProfileFromAccess,
  buildPeerGroups,
  criteriaSetKey,
  ROLE_SCAN_IDENTITY_PAGE_SIZE,
} from "./roleMiningShared";
import { patchRoleEntitlements } from "./roleDimensions";
import { tagEntitlementsWithRoleBoundaryValues } from "./metadataTagging";
import { startJob, patchRecord, failInterrupted, newScanId } from "./scanJobs";

const STORE = "dl-scans";
const dlScans = () => recordStore(STORE);
const updateDlScan = (scanId, patch) => patchRecord(STORE, scanId, patch);

const notFound = () => badRequest("Distribution group scan not found.", 404);

async function loadScan(id) {
  await failInterrupted(STORE);
  const scan = await dlScans().get(id);
  if (!scan) throw notFound();
  // This scan's own vocabulary is "error"/"complete" (not "failed"/
  // "completed"); a run interrupted by a reload is reported the same way.
  if (scan.status === "failed") return updateDlScan(id, { status: "error" });
  return scan;
}

async function runDlScan(scanId) {
  try {
    const settings = await getTenantSettings();
    // DLs group by the FIRST mining attribute only (the one Roles are built
    // from) — the remaining attributes are role DIMENSIONS, so the DL
    // matches the base role's own criteria exactly.
    const attributeKeys = (await getRoleScanAttributeKeys()).slice(0, 1);
    const threshold = (settings.entitlementCommonalityThreshold ?? 80) / 100;
    const scopeIds = await fetchScopeIds(["identities"], settings.nameScope || null);

    const profiles = [];
    await searchAllIdentities({
      pageSize: ROLE_SCAN_IDENTITY_PAGE_SIZE,
      includeAccess: true,
      onPage: async (identities, totalScanned) => {
        const pageProfiles = identities
          .filter((idn) => !scopeIds || scopeIds.has(idn.id))
          .map((idn) => buildIdentityRoleProfileFromAccess(idn, attributeKeys));
        profiles.push(...pageProfiles.filter((p) => !p.entitlementsFailed));
        await updateDlScan(scanId, { scanned: totalScanned });
      },
    });

    // createDynamicRoles=false: one group per distinct value of that attribute.
    const groups = buildPeerGroups(profiles, attributeKeys, false, new Set(), threshold);
    const slug = (t) => String(t).replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    const suggestions = groups.map((g) => ({
      id: g.id,
      name: `DL-${g.attributeCriteria.map((c) => slug(c.value)).join("-")}`,
      displayName: g.attributeCriteria.map((c) => c.value).join(" - "),
      attributeCriteria: g.attributeCriteria,
      memberCount: g.members.length,
      members: g.members.slice(0, 500).map((m) => ({ id: m.id, name: m.name, email: m.email })),
      created: null,
    }));
    await updateDlScan(scanId, { status: "complete", completedAt: new Date().toISOString(), suggestions });
  } catch (err) {
    console.error(`[insights] dl scan ${scanId} failed:`, err.response?.data || err.message);
    await updateDlScan(scanId, { status: "error", completedAt: new Date().toISOString(), error: describeError(err) });
  }
}

/**
 * POST /api/insights/dl-scans
 * { targetType: "ad"|"entra", sourceId, sourceName, ou? } -> { scanId }
 */
export async function startDlScan({ targetType, sourceId, sourceName, ou } = {}) {
  if (targetType !== "ad" && targetType !== "entra") {
    throw badRequest("targetType must be \"ad\" or \"entra\".");
  }
  if (!sourceId) throw badRequest("sourceId is required.");
  if (targetType === "ad" && !ou) throw badRequest("ou is required for Active Directory.");
  const scanId = newScanId("dlscan");
  await updateDlScan(scanId, {
    id: scanId,
    tenant: tenantKey(),
    status: "running",
    startedAt: new Date().toISOString(),
    completedAt: null,
    targetType,
    sourceId,
    sourceName: sourceName || null,
    ou: ou || null,
    scanned: 0,
    suggestions: [],
    error: null,
  });
  startJob(STORE, scanId, () => runDlScan(scanId));
  return { scanId };
}

/** GET /api/insights/dl-scans/:id */
export async function getDlScan(id) {
  return loadScan(id);
}

/**
 * POST /api/insights/dl-scans/:id/create
 * { suggestionIds } -> { script, count } — one PowerShell provisioning
 * script covering every selected group; marks them created on the record.
 */
export async function createDlGroups(id, suggestionIds) {
  const scan = await loadScan(id);
  if (!Array.isArray(suggestionIds) || suggestionIds.length === 0) {
    throw badRequest("suggestionIds must be a non-empty array.");
  }
  const chosen = (scan.suggestions || []).filter((g) => suggestionIds.includes(g.id));
  if (chosen.length === 0) throw badRequest("No matching suggestions.");

  // EMPTY groups only, deliberately: membership is populated by ISC, not
  // this script — after aggregation, Add to Roles attaches each DL
  // entitlement to its matching mined role, and the role's own membership
  // criteria provisions the members through the connector.
  const lines = [];
  lines.push(`# Mail distribution groups mined by Admin Studio (${new Date().toISOString()})`);
  if (scan.targetType === "ad") {
    lines.push(`# Target: Active Directory source "${scan.sourceName}" — OU: ${scan.ou}`);
    lines.push(`# Run from an Exchange Management Shell with an account holding the Exchange RBAC role for DLs.`);
  } else {
    lines.push(`# Target: Entra / Exchange Online (source "${scan.sourceName}")`);
  }
  lines.push(`# Groups are created EMPTY on purpose — run entitlement aggregation in ISC afterward, then use`);
  lines.push(`# "Add to Roles" on the scan: each role's membership provisions the DL members via the connector.`);
  lines.push("");
  if (scan.targetType !== "ad") lines.push("Connect-ExchangeOnline", "");
  for (const g of chosen) {
    lines.push(
      scan.targetType === "ad"
        ? `New-DistributionGroup -Name "${g.name}" -DisplayName "${g.displayName}" -Type Distribution -OrganizationalUnit "${scan.ou}"`
        : `New-DistributionGroup -Name "${g.name}" -DisplayName "${g.displayName}" -Type Distribution`
    );
  }
  lines.push("");
  const script = lines.join("\n");
  const at = new Date().toISOString();
  const updated = (scan.suggestions || []).map((g) =>
    suggestionIds.includes(g.id) ? { ...g, created: { at } } : g
  );
  await updateDlScan(scan.id, { suggestions: updated });
  return { script, count: chosen.length };
}

/**
 * POST /api/insights/dl-scans/:id/add-to-roles
 * { suggestionIds } -> { results: [{ id, ok, roleId?, roleName?, error? }] }
 * For each selected group: finds the aggregated DL entitlement on the scan's
 * source (by name), finds the role whose membership criteria exactly matches
 * the suggestion's own peer-group criteria, and adds the entitlement to that
 * role. Added entitlements inherit the role's segment-boundary tags.
 */
export async function addDlGroupsToRoles(id, suggestionIds) {
  const scan = await loadScan(id);
  if (!Array.isArray(suggestionIds) || suggestionIds.length === 0) {
    throw badRequest("suggestionIds must be a non-empty array.");
  }
  const chosen = (scan.suggestions || []).filter((g) => suggestionIds.includes(g.id));
  if (chosen.length === 0) throw badRequest("No matching suggestions.");

  try {
    // The scan's source's entitlements, fetched once — DLs land here after
    // group aggregation.
    const sourceEnts = [];
    for (let offset = 0; offset < 2000; offset += 250) {
      const page = await withApiRetry(
        () => iscGet("/v2026/entitlements", { filters: `source.id eq "${scan.sourceId}"`, limit: 250, offset }),
        { label: "dl add-to-roles: entitlements page" }
      );
      sourceEnts.push(...page);
      if (page.length < 250) break;
    }

    // Every role keyed by its exact membership-criteria set — the mined
    // role for the same peer group has exactly the suggestion's criteria.
    const roles = await fetchAllPaged("/v2026/roles");
    const byCriteria = new Map();
    for (const r of roles) {
      const leaves = extractAllIdentityEqualsLeaves(r.membership?.criteria);
      if (leaves.length) byCriteria.set(criteriaSetKey(leaves), r);
    }

    const results = [];
    const at = new Date().toISOString();
    for (const g of chosen) {
      try {
        const ent = sourceEnts.find(
          (e) => e.name === g.name || e.value === g.name || (typeof e.value === "string" && e.value.startsWith(`CN=${g.name},`))
        );
        if (!ent) {
          results.push({ id: g.id, ok: false, error: `Entitlement "${g.name}" not found on ${scan.sourceName} — create the group and run entitlement aggregation first.` });
          continue;
        }
        const role = byCriteria.get(criteriaSetKey(g.attributeCriteria.map((c) => ({ attrKey: c.key, value: c.value }))));
        if (!role) {
          results.push({ id: g.id, ok: false, error: `No role with membership criteria matching ${g.attributeCriteria.map((c) => `${c.key}=${c.value}`).join(", ")} — create it with Scan for Roles first.` });
          continue;
        }
        await patchRoleEntitlements(role.id, { add: [{ id: ent.id, name: ent.name }] });
        await tagEntitlementsWithRoleBoundaryValues(role.id, [ent.id]);
        g.addedToRole = { roleId: role.id, roleName: role.name, entitlementId: ent.id, at };
        results.push({ id: g.id, ok: true, roleId: role.id, roleName: role.name });
      } catch (err) {
        console.error(`[insights] dl add-to-roles "${g.name}" failed:`, err.response?.data || err.message);
        results.push({ id: g.id, ok: false, error: describeError(err) });
      }
    }
    await updateDlScan(scan.id, { suggestions: scan.suggestions });
    return { results };
  } catch (err) {
    console.error("[insights] dl add-to-roles failed:", err.response?.data || err.message);
    throw routeError(err);
  }
}
