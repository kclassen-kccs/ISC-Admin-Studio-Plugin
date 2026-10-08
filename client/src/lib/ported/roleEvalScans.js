/**
 * ported/roleEvalScans.js
 * Role Evaluation scans — ports of the retired server's
 *   POST   /api/insights/role-eval-scans                          (startRoleEvalScan)
 *   GET    /api/insights/role-eval-scans                          (listRoleEvalScans)
 *   GET    /api/insights/role-eval-scans/overlapping-common-access
 *   GET    /api/insights/role-eval-scans/common-access-in-selection
 *   GET    /api/insights/role-eval-scans/:id                      (getRoleEvalScan)
 *   POST   /api/insights/role-eval-scans/:id/cancel               (cancelRoleEvalScan)
 *   DELETE /api/insights/role-eval-scans/:id                      (deleteRoleEvalScan)
 *   POST   /api/insights/role-eval-scans/:id/results/:roleId/accept
 *   POST   /api/insights/role-eval-scans/:id/accept-all
 *   POST   /api/insights/role-eval-scans/:id/results/:roleId/mark-handled
 * plus runRoleEvalScan itself, which the server also ran for the Role
 * Statistics Refresh schedule / Run Now (see startScheduledRoleEvalScan).
 *
 * Same idea as the Role Mining peer-group scan (persisted record, poll-able
 * status, cancellable) but loops through every existing role and runs
 * evaluateRoleAlgorithmic on each instead of discovering new ones. Records
 * live in the "role-eval-scans" store (per tenant, see lib/store.js); the
 * scan runs in this page (see scanJobs.js) — a reload interrupts it and the
 * record is marked failed the next time the list is read.
 */

import { iscGet, withApiRetry, routeError, badRequest, describeError } from "../isc";
import { recordStore } from "../store";
import {
  tenantKey,
  mapWithConcurrency,
  getTenantSettings,
  DEFAULT_TENANT_SETTINGS,
  PEER_GROUP_STATUS_ATTRIBUTE_KEYS,
  extractAllIdentityEqualsLeaves,
  extractAllCriteriaLeaves,
  criteriaLeavesSubsetOf,
  filterExistingEntitlements,
} from "./roleShared";
import {
  findRoleMembers,
  ROLE_EVAL_ENTITLEMENT_CONCURRENCY,
  ROLE_EVAL_MIN_MEMBERS_FOR_COMMONALITY,
} from "./roleMembers";
import {
  getCommonAccessRoleIdSet,
  getCommonAccessRoleStatus,
  fetchCommonAccessRoleSummaries,
} from "./roleCommonAccess";
import {
  evaluateRoleAlgorithmic,
  fetchConflictingAccessSodPolicies,
  roleEvalResultHasSuggestions,
  roleEvalResultHasSodViolations,
  roleEvalResultHasMitigatedSodViolations,
} from "./roleEvaluation";
import { removeAcceptedCommonEntsFromContextRoles } from "./roles";
import { patchRoleEntitlements, patchDimensionEntitlements, createRoleDimensionOnServer } from "./roleDimensions";
import { tagEntitlementsWithRoleBoundaryValues } from "./metadataTagging";
import { startJob, patchRecord, failInterrupted, requestCancel, isCancelled, newScanId } from "./scanJobs";

const STORE = "role-eval-scans";
const roleEvalScans = () => recordStore(STORE);

// A batch Role Evaluation scan used to evaluate roles strictly one at a
// time — kept modest here rather than matching ROLE_EVAL_ENTITLEMENT_
// CONCURRENCY (8) because each role already fans out its own internal
// concurrency (dimensions, per-member entitlement fetches), so a handful
// of roles in flight at once already multiplies real request concurrency
// well past this number. Tune down if this causes more 429s than it saves
// in wall-clock time on a given tenant's rate limit.
const ROLE_EVAL_SCAN_CONCURRENCY = 3;

const DEFAULT_PEER_GROUP_ATTRIBUTE_KEYS = ["department", "location"]
  .filter((k) => !PEER_GROUP_STATUS_ATTRIBUTE_KEYS.has(k));

async function updateRoleEvalScan(scanId, patch) {
  return patchRecord(STORE, scanId, patch);
}

// The server stamped every record with its tenant and filtered on it; the
// plugin's store is already tenant-namespaced, so a record without the field
// (none are written that way, but be lenient) still belongs to this tenant.
function forThisTenant(scan) {
  return scan && (!scan.tenant || scan.tenant === tenantKey()) ? scan : null;
}

const notFound = () => badRequest("Role evaluation scan not found.", 404);

/**
 * Keeps at most the tenant's Role Evaluation Retention setting worth of
 * scan records (oldest by startedAt purged first) — called at the end of
 * every scan, regardless of how it finished, so the store doesn't grow
 * without bound (each record's results array carries every scanned role's
 * full evaluation). A scan still actively running is never purged even if
 * it's old, so a long-running scan can't have its own record deleted out
 * from under it.
 *
 * Pruned as two SEPARATE pools — scheduled (Role Statistics Refresh's own
 * runs + Run Now) and manual (everything else) — each kept to the same
 * retention count independently, rather than one shared pool ranked purely
 * by recency. Otherwise a burst of manual scans crowds every scheduled scan
 * out of a small retention window and the Home screen's stats — which only
 * ever read the latest scheduled scan — silently go back to "unavailable".
 */
async function pruneRoleEvalScans() {
  const retention = (await getTenantSettings()).roleEvalRetention ?? DEFAULT_TENANT_SETTINGS.roleEvalRetention;
  const tenantScans = Object.values(await roleEvalScans().all()).filter((s) => forThisTenant(s) && s.status !== "running");
  const byStart = (a, b) => new Date(b.startedAt) - new Date(a.startedAt);
  const scheduled = tenantScans.filter((s) => s.triggeredBy === "scheduled").sort(byStart);
  const manual = tenantScans.filter((s) => s.triggeredBy !== "scheduled").sort(byStart);
  const toRemove = [...scheduled.slice(retention), ...manual.slice(retention)];
  for (const s of toRemove) await roleEvalScans().delete(s.id);
}

// The attribute keys a role scan buckets by: Schema Analysis's chosen top
// attributes for this tenant if it's been run, otherwise the
// department/location default (server: getRoleScanAttributeKeys).
async function getRoleScanAttributeKeys() {
  const configured = ((await recordStore("schema-analysis").get(tenantKey()))?.topAttributes || [])
    .filter((k) => !PEER_GROUP_STATUS_ATTRIBUTE_KEYS.has(k));
  return configured.length > 0 ? configured : DEFAULT_PEER_GROUP_ATTRIBUTE_KEYS;
}

/** Canonical, order-independent key for a set of {attrKey, value} pairs, for exact-set comparison. */
function criteriaSetKey(leaves) {
  return leaves
    .map((l) => `${l.attrKey}=${l.value}`)
    .sort()
    .join("|");
}

/**
 * Last step of a Role Evaluation scan: for each Common Access role
 * considered in this scan, uses ITS OWN membership rule to scope the active
 * population, then checks whether that population contains a combination of
 * the tenant's role-scan attribute keys (Schema Analysis's chosen attributes,
 * or the department/location default) that no EXISTING role or dimension's
 * own membership criteria already covers. A combination with no covering
 * role is a peer group riding on Common Access alone with nothing of its own
 * — proposed here, never created. Mirrors Role Scan's exact-set-match
 * duplicate check, extended to also check each dimensional role's own
 * dimensions (a dimension's criteria alone only ever encodes the ONE
 * attribute it varies by, so it's unioned with its base role's own leaves
 * first).
 */
async function findRoleGapProposals(commonRoleStubs, allRoleStubs, populationCache, commonalityThreshold, attributeSeparator) {
  const coveredKeys = new Set();
  for (const role of allRoleStubs) {
    const roleLeaves = extractAllIdentityEqualsLeaves(role.membership?.criteria);
    if (roleLeaves.length > 0) coveredKeys.add(criteriaSetKey(roleLeaves));
    if (!role.dimensional) continue;
    try {
      const dimensions = await withApiRetry(
        () => iscGet(`/v2026/roles/${role.id}/dimensions`),
        { label: `role gap check: fetch role ${role.id} dimensions` }
      );
      for (const d of dimensions || []) {
        const dimLeaves = extractAllIdentityEqualsLeaves(d.membership?.criteria);
        if (dimLeaves.length === 0) continue;
        coveredKeys.add(criteriaSetKey([...roleLeaves, ...dimLeaves]));
      }
    } catch (err) {
      console.error(`[insights] role gap check: dimensions fetch failed for role ${role.id}:`, err.response?.data || err.message);
    }
  }

  const proposals = [];
  for (const commonRole of commonRoleStubs) {
    // Nothing to scope by — without at least one leaf of its own, every
    // identity in the tenant would "match" this common-access role, which
    // would make every existing combination anywhere look uncovered
    // relative to it. Skipped rather than guessed at.
    const commonLeaves = extractAllIdentityEqualsLeaves(commonRole.membership?.criteria);
    if (commonLeaves.length === 0) continue;

    // Bucketing by an attribute the common-access role's own criteria
    // already pins to one value would just reproduce that same value in
    // every combo — only its still-variable attributes are useful here.
    const combineKeys = (await getRoleScanAttributeKeys()).filter(
      (k) => !commonLeaves.some((l) => l.attrKey === k)
    );
    if (combineKeys.length === 0) continue;

    const membershipResult = await findRoleMembers(commonRole.membership, combineKeys, populationCache);
    if (!membershipResult.supported || membershipResult.matches.length === 0) continue;

    const buckets = new Map(); // exact-set key -> { leaves, members }
    for (const m of membershipResult.matches) {
      const values = combineKeys.map((k) => m.attrValues?.[k]);
      if (values.some((v) => !v || v === "Unknown")) continue;
      const leaves = combineKeys.map((k, i) => ({ attrKey: k, value: values[i] }));
      const key = criteriaSetKey([...commonLeaves, ...leaves]);
      if (!buckets.has(key)) buckets.set(key, { leaves, members: [] });
      buckets.get(key).members.push(m);
    }

    for (const [key, { leaves, members }] of buckets) {
      if (coveredKeys.has(key)) continue;

      // Every combination with real members is proposed, even a lone one —
      // no minimum group size gate (a 1-member group still gets flagged,
      // just without a commonality-based entitlement suggestion since
      // there's no peer group to compute it from).
      const memberCount = members.length;
      const sampleTooSmall = memberCount < ROLE_EVAL_MIN_MEMBERS_FOR_COMMONALITY;
      let suggestedEntitlements = [];
      if (!sampleTooSmall) {
        const entitlementLists = await mapWithConcurrency(members, ROLE_EVAL_ENTITLEMENT_CONCURRENCY, async (m) => {
          try {
            return await withApiRetry(
              () => iscGet(`/v2026/entitlements/identities/${m.id}/entitlements`, { limit: 100 }),
              { label: `role gap check: fetch entitlements for identity ${m.id}` }
            );
          } catch {
            return [];
          }
        });
        const counts = new Map();
        for (const list of entitlementLists) {
          for (const e of list) {
            const entry = counts.get(e.id) || { name: e.name, count: 0 };
            entry.count += 1;
            counts.set(e.id, entry);
          }
        }
        const minCount = Math.ceil(memberCount * commonalityThreshold);
        suggestedEntitlements = [...counts.entries()]
          .filter(([, entry]) => entry.count >= minCount)
          .map(([id, entry]) => ({
            entitlementId: id,
            entitlement: entry.name,
            reason: `Held by ${entry.count} of ${memberCount} members with this combination (>=${Math.round(commonalityThreshold * 100)}%).`,
          }));
      }

      proposals.push({
        commonAccessRoleId: commonRole.id,
        commonAccessRoleName: commonRole.name,
        attributes: leaves,
        suggestedName: [...leaves.map((l) => l.value)].join(attributeSeparator || " - "),
        memberCount,
        sampleTooSmall,
        suggestedEntitlements,
      });
    }
  }
  return proposals;
}

// ─── The scan itself ─────────────────────────────────────────────────────────

async function runRoleEvalScan(scanId) {
  const cancelled = () => isCancelled(STORE, scanId);
  // Locked in at scan creation (see startRoleEvalScan) — an ad-hoc search
  // typed in for this one run, not a persisted setting. A plain
  // name-contains filter on the roles list itself (same "co" search the
  // Roles list uses), not a raw ISC Search query.
  const evalScanConfig = await roleEvalScans().get(scanId);
  const searchQuery = evalScanConfig.scopeQuery;
  const rolesFilter = searchQuery ? `name co "${searchQuery}"` : undefined;
  // Explicit scope (see startRoleEvalScan) — exactly these roles, nothing
  // else. When set, roleFilterMode/rolesFilter below are skipped entirely:
  // whatever's already been filtered/selected client-side (e.g. RolesPage's
  // Evaluate icon) IS the scope, full stop.
  const scopeRoleIds = evalScanConfig.scopeRoleIds;
  const triggeredBy = evalScanConfig.triggeredBy;
  // Evaluation Config's Role Filtering setting — applied to a manual Start
  // scan, read fresh at scan time rather than locked in at creation like
  // scopeQuery/considerCommonAccessRoleIds below. Role Statistics Refresh
  // (scheduled runs and Run Now — see triggeredBy) always forces
  // ENABLED_ONLY regardless of this setting: it drives the Home screen's
  // pass/needs-update counts, which only make sense for roles someone could
  // actually be assigned right now. "enabled" isn't a queryable filter on
  // ISC's own /v2026/roles (verified live: 400 "not queryable"), so this is
  // applied while building the role list below rather than as a
  // rolesFilter clause.
  const roleFilterMode =
    triggeredBy === "scheduled" ? "ENABLED_ONLY" : (await getTenantSettings()).roleFilterMode || "ALL";
  // Locked in at scan creation — applied uniformly to every role this scan
  // evaluates. null (every scan except one started from the Roles list
  // picker) keeps each role's own automatic subset-of-criteria matching.
  const considerCommonAccessRoleIds = evalScanConfig.considerCommonAccessRoleIds || null;

  try {
    // Which roles in this scan ARE Common Access. That decides report
    // ordering and — more importantly — scan.commonAccessRolesUsed, which
    // drives the Accept cascade (accepting additions onto a Common Access
    // role removes them from the other roles in the scan it covers).
    //
    // With an explicit list, that list. Without one — the normal case now
    // that nothing prompts for it — the tenant's own flagged Common Access
    // roles, detected here rather than chosen by hand. This is deliberately
    // SEPARATE from how each role is evaluated: considerCommonAccessRoleIds
    // stays null, so every role still gets only the Common Access roles its
    // membership rule overlaps, never a uniform list.
    let commonAccessIds = new Set(considerCommonAccessRoleIds || []);
    if (!considerCommonAccessRoleIds) {
      try {
        commonAccessIds = await getCommonAccessRoleIdSet();
      } catch (err) {
        console.warn(`[insights] role eval scan ${scanId}: couldn't detect Common Access roles for ordering/cascade:`, err.response?.data || err.message);
      }
    }

    // Every role matching this scan's scope, fetched fully up front so
    // Common Access roles can be listed first below.
    const allRoleStubs = [];
    if (Array.isArray(scopeRoleIds) && scopeRoleIds.length > 0) {
      // Explicit scope — fetch exactly these roles, one at a time (this is
      // always a small, already-filtered/selected set, not a bulk query).
      // A role that fails to fetch (deleted since selection, etc.) is
      // silently skipped rather than failing the whole scan.
      for (const id of scopeRoleIds) {
        if (cancelled()) break;
        try {
          allRoleStubs.push(await withApiRetry(() => iscGet(`/v2026/roles/${id}`), { label: `role eval scan ${scanId}: fetch scoped role ${id}` }));
        } catch (err) {
          console.error(`[insights] role eval scan ${scanId}: fetching scoped role ${id} failed:`, err.response?.data || err.message);
        }
      }
    } else {
      let offset = 0;
      while (true) {
        if (cancelled()) break;
        const pageOffset = offset;
        const page = await withApiRetry(
          () => iscGet("/v2026/roles", {
            limit: 250, offset: pageOffset, sorters: "name", ...(rolesFilter ? { filters: rolesFilter } : {}),
          }),
          { label: `role eval scan ${scanId}: roles page` }
        );
        if (page.length === 0) break;
        for (const role of page) {
          const excludedByFilter =
            (roleFilterMode === "ENABLED_ONLY" && !role.enabled) ||
            (roleFilterMode === "DISABLED_ONLY" && role.enabled);
          if (!excludedByFilter) allRoleStubs.push(role);
        }
        offset += page.length;
        if (page.length < 250) break;
      }
    }

    const commonRoleStubs = allRoleStubs.filter((r) => commonAccessIds.has(r.id));
    const otherRoleStubs = allRoleStubs.filter((r) => !commonAccessIds.has(r.id));
    const orderedStubs = [...commonRoleStubs, ...otherRoleStubs];

    await updateRoleEvalScan(scanId, {
      totalRoles: orderedStubs.length,
      commonAccessRolesUsed: commonRoleStubs.map((r) => ({ id: r.id, name: r.name })),
    });

    if (cancelled()) {
      await updateRoleEvalScan(scanId, { status: "cancelled", completedAt: new Date().toISOString() });
      return;
    }

    // SOD policies and common-access role summaries are tenant-wide,
    // largely static data — fetched ONCE here for the whole scan instead
    // of once per role (as evaluateRoleAlgorithmic does by default for its
    // other callers). Trades a small amount of freshness for it — a
    // common-access role edited mid-scan won't be picked up until the next
    // run, same tradeoff already accepted for scopeQuery/
    // considerCommonAccessRoleIds being locked in at scan creation.
    const scanEvalSettings = await getTenantSettings();
    const scanCommonalityThreshold = (scanEvalSettings.entitlementCommonalityThreshold ?? 80) / 100;
    // A failure here used to just fall back to "no common-access roles
    // exist" with nothing to show for it — every role in the scan would
    // then get flagged as missing entitlements a Common Access role already
    // grants tenant-wide, with no indication anything had gone wrong. Same
    // commonAccessExclusionFailed flag Role Scan surfaces for the identical
    // failure mode.
    let commonAccessExclusionFailed = false;
    const [sharedSodPolicies, sharedCommonAccessSummaries] = await Promise.all([
      scanEvalSettings.checkSodViolations
        ? fetchConflictingAccessSodPolicies()
        : Promise.resolve([]),
      scanEvalSettings.considerCommonRoles
        ? withApiRetry(() => fetchCommonAccessRoleSummaries(), { label: `role eval scan ${scanId}: fetch common-access role summaries` }).catch((err) => {
            console.error(`[insights] role eval scan ${scanId}: failed to fetch common-access role summaries after retries:`, err.response?.data || err.message);
            commonAccessExclusionFailed = true;
            return [];
          })
        : Promise.resolve([]),
    ]);

    // Shared across every role (and every dimension that can't reuse its
    // own base role's scan) evaluated by this scan: the tenant's
    // active-identity population is paged from the API once and reused via
    // in-memory criteria matching everywhere else. See
    // fetchActiveIdentityPopulation.
    const populationCache = {};

    // considerCommonAccessRoleIds is passed straight through, exactly as
    // the client sent it (null → automatic criteria-subset matching, []
    // → explicit none, [...ids] → exactly those). This scan's own
    // commonAccessIds (above) is only used for report ordering/display; it
    // does NOT override what gets passed here.
    //
    // Evaluated with bounded concurrency (ROLE_EVAL_SCAN_CONCURRENCY) —
    // results[i] is written at role i's own index regardless of which order
    // roles actually finish in, so the final persisted order still matches
    // orderedStubs (Common Access roles first) once the scan completes.
    // Progress updates mid-scan use whatever's completed so far.
    const results = new Array(orderedStubs.length);
    let completedCount = 0;
    let nextIndex = 0;
    let endIndex = orderedStubs.length;
    // Set between phases: entitlement ids the considered Common Access
    // roles' own evaluations propose ADDING. Ordinary roles evaluated
    // afterward have those suppressed from their own add-candidates, so a
    // single scan never suggests the same birthright gap in two places.
    // Deliberately ADD-only: provisional (not-yet-accepted) grants are
    // never used to mark an ordinary role's existing entitlements
    // "redundant".
    let provisionalCommonAdds = null;
    const stripProvisionalAdds = (evaluation) => {
      if (!provisionalCommonAdds || provisionalCommonAdds.size === 0) return;
      const keep = (c) => !provisionalCommonAdds.has(c.entitlementId);
      evaluation.addCandidates = (evaluation.addCandidates || []).filter(keep);
      for (const d of evaluation.dimensionEvaluations || []) {
        d.addCandidates = (d.addCandidates || []).filter(keep);
      }
      for (const md of evaluation.missingDimensions || []) {
        md.addCandidates = (md.addCandidates || []).filter(keep);
      }
    };
    async function evalWorker() {
      while (nextIndex < endIndex) {
        if (cancelled()) return;
        const i = nextIndex++;
        const role = orderedStubs[i];
        try {
          const evaluation = await evaluateRoleAlgorithmic(role.id, {
            considerCommonAccessRoleIds: considerCommonAccessRoleIds || undefined,
            sharedSodPolicies,
            sharedCommonAccessSummaries,
            populationCache,
          });
          const { roleEntitlements, ...persistedEvaluation } = evaluation;
          stripProvisionalAdds(persistedEvaluation);
          results[i] = {
            roleId: role.id,
            roleName: role.name,
            dimensional: !!role.dimensional,
            enabled: !!role.enabled,
            evaluation: persistedEvaluation,
            hasSuggestions: roleEvalResultHasSuggestions(persistedEvaluation),
            hasSodViolations: roleEvalResultHasSodViolations(persistedEvaluation),
            mitigatedViolationPresent: roleEvalResultHasMitigatedSodViolations(persistedEvaluation),
            error: null,
            accepted: false,
            acceptedAt: null,
          };
        } catch (err) {
          console.error(`[insights] role eval scan ${scanId}: role ${role.id} (${role.name}) failed:`, err.response?.data || err.message);
          results[i] = {
            roleId: role.id,
            roleName: role.name,
            dimensional: !!role.dimensional,
            enabled: !!role.enabled,
            evaluation: null,
            hasSuggestions: false,
            hasSodViolations: false,
            mitigatedViolationPresent: false,
            error: describeError(err),
            accepted: false,
            acceptedAt: null,
          };
        }
        completedCount++;
        await updateRoleEvalScan(scanId, { scanned: completedCount, results: results.filter(Boolean) });
      }
    }
    // Phase 1: the considered Common Access roles alone (they sit at the
    // front of orderedStubs), so their add-candidates are known before any
    // ordinary role is evaluated.
    endIndex = commonRoleStubs.length;
    await Promise.all(
      Array.from({ length: Math.min(ROLE_EVAL_SCAN_CONCURRENCY, commonRoleStubs.length) }, evalWorker)
    );
    provisionalCommonAdds = new Set();
    for (let i = 0; i < commonRoleStubs.length; i++) {
      for (const c of results[i]?.evaluation?.addCandidates || []) {
        if (c.entitlementId) provisionalCommonAdds.add(c.entitlementId);
      }
    }
    // Phase 2: every remaining role, with the same-scan provisional
    // birthright suppressed from their add suggestions.
    endIndex = orderedStubs.length;
    await Promise.all(
      Array.from({ length: Math.min(ROLE_EVAL_SCAN_CONCURRENCY, orderedStubs.length - commonRoleStubs.length) }, evalWorker)
    );

    if (cancelled()) {
      await updateRoleEvalScan(scanId, { status: "cancelled", completedAt: new Date().toISOString() });
      return;
    }

    // Last step: use each Common Access role's own membership rule to look
    // for a combination of attributes with real members that no existing
    // role or dimension covers yet — see findRoleGapProposals. Purely
    // additive to the report; a failure here doesn't fail the scan since
    // every per-role result above is already complete and valid on its own.
    let newRoleProposals = [];
    let roleGapCheckError = null;
    if (commonRoleStubs.length > 0) {
      try {
        newRoleProposals = await findRoleGapProposals(
          commonRoleStubs, allRoleStubs, populationCache,
          scanCommonalityThreshold, scanEvalSettings.attributeSeparator
        );
      } catch (err) {
        console.error(`[insights] role eval scan ${scanId}: role-gap check failed:`, err.response?.data || err.message);
        roleGapCheckError = describeError(err);
      }
    }

    // Also last step: a role this app itself created/flagged as Common
    // Access (locally tracked — see getCommonAccessRoleStatus) but that
    // ISC's own CONFIRMED list doesn't actually show as Common Access is an
    // exception worth surfacing on its own, independent of this scan's own
    // scope/search. A role fetch failure here (e.g. the role was since
    // deleted) just drops it from the list rather than failing the whole
    // scan over stale bookkeeping.
    let commonAccessFlagExceptions = [];
    let commonAccessFlagCheckBetaUnavailable = false;
    try {
      const { confirmed, locallyTracked, betaUnavailable } = await getCommonAccessRoleStatus();
      commonAccessFlagCheckBetaUnavailable = betaUnavailable;
      const unconfirmedIds = [...locallyTracked].filter((id) => !confirmed.has(id));
      const exceptionResults = await mapWithConcurrency(unconfirmedIds, 5, async (id) => {
        try {
          const role = await withApiRetry(() => iscGet(`/v2026/roles/${id}`), { label: `role eval scan ${scanId}: fetch common-access exception role ${id}` });
          return { id: role.id, name: role.name, enabled: !!role.enabled };
        } catch {
          return null; // most likely deleted since being flagged/created — nothing to fix
        }
      });
      commonAccessFlagExceptions = exceptionResults.filter(Boolean);
    } catch (err) {
      console.error(`[insights] role eval scan ${scanId}: common-access flag exception check failed:`, err.response?.data || err.message);
    }

    await updateRoleEvalScan(scanId, {
      status: "completed",
      completedAt: new Date().toISOString(),
      newRoleProposals,
      roleGapCheckError,
      commonAccessExclusionFailed,
      commonAccessFlagExceptions,
      commonAccessFlagCheckBetaUnavailable,
    });
  } catch (err) {
    console.error(`[insights] role eval scan ${scanId} failed:`, err.response?.data || err.message);
    await updateRoleEvalScan(scanId, {
      status: "failed",
      completedAt: new Date().toISOString(),
      error: describeError(err),
    });
  } finally {
    // Runs regardless of how the scan finished (completed/cancelled/failed)
    // — see pruneRoleEvalScans for what "at the end of every scan" means.
    try {
      await pruneRoleEvalScans();
    } catch (err) {
      console.error(`[insights] role eval scan ${scanId}: retention prune failed:`, err.message);
    }
  }
}

// The record every scan starts from; `extra` carries the per-trigger fields.
async function createScanRecord(extra) {
  const scanId = newScanId("roleevalscan");
  await updateRoleEvalScan(scanId, {
    id: scanId,
    tenant: tenantKey(),
    status: "running",
    startedAt: new Date().toISOString(),
    completedAt: null,
    scopeQuery: null,
    scanned: 0,
    totalRoles: 0,
    results: [],
    error: null,
    newRoleProposals: [],
    roleGapCheckError: null,
    commonAccessExclusionFailed: false,
    commonAccessFlagExceptions: [],
    commonAccessFlagCheckBetaUnavailable: false,
    ...extra,
  });
  startJob(STORE, scanId, () => runRoleEvalScan(scanId));
  return { scanId };
}

/**
 * POST /api/insights/role-eval-scans
 * query: an ad-hoc role-name search, not a persisted setting — locked into
 * the scan record so a running scan or its report isn't retroactively
 * affected by anything.
 * considerCommonAccessRoles: optional [{id, name}] from the Roles list
 * "Evaluate" picker, applied uniformly to every role this scan evaluates;
 * omitted keeps the automatic subset-of-criteria matching per role. Sent as
 * {id, name} pairs so the scan report can name them without a lookup.
 * roleIds: optional explicit scope — exactly these roles, nothing else (set
 * by RolesPage's Evaluate icon, whose Active/Disabled, Standard/Dynamic and
 * Common Access Only filters a name-contains query alone can't reproduce).
 * Returns { scanId }.
 */
export async function startRoleEvalScan(query, considerCommonAccessRoles, roleIds) {
  const scopeQuery = typeof query === "string" ? query.trim() : "";
  const consider = Array.isArray(considerCommonAccessRoles)
    ? considerCommonAccessRoles.filter((r) => r && r.id)
    : null;
  const considerIds = consider ? consider.map((r) => r.id) : null;
  const scopeRoleIds = Array.isArray(roleIds) ? roleIds.filter((id) => typeof id === "string" && id) : null;
  return createScanRecord({
    scopeQuery: scopeQuery || null,
    scopeRoleIds,
    considerCommonAccessRoleIds: considerIds,
    considerCommonAccessRoles: consider,
    // Distinguishes this from the Role Statistics Refresh schedule's own
    // runs — the home screen's pass/needs-update counts are only ever based
    // on the latter, so a one-off scoped/manual scan never skews them.
    triggeredBy: "manual",
  });
}

/**
 * The Role Statistics Refresh scan (server: triggerRoleStatsRefresh /
 * POST /api/insights/role-stats-refresh/run-now): every enabled role in the
 * tenant, tagged triggeredBy "scheduled" so it counts toward the Home
 * screen's stats. Returns { scanId }.
 */
export async function startScheduledRoleEvalScan() {
  return createScanRecord({ triggeredBy: "scheduled" });
}

/**
 * GET /api/insights/role-eval-scans/overlapping-common-access?query=...
 * Bulk version of GET /api/roles/:id/overlapping-common-access, for the
 * Roles list "Evaluate" picker — every common-access role (enabled or
 * disabled) whose own criteria nests with ANY role currently matching the
 * same name-contains search the eval scan itself would use, deduplicated.
 * Capped to the first 250 matching roles for cost.
 */
export async function listOverlappingCommonAccessForQuery(query) {
  const q = typeof query === "string" ? query.trim() : "";
  const rolesFilter = q ? `name co "${q}"` : undefined;
  try {
    const roles = await iscGet("/v2026/roles", { limit: 250, ...(rolesFilter ? { filters: rolesFilter } : {}) });
    // The picker honors the same Evaluation Config preference the scan
    // itself applies — with Enabled Roles Only set, a disabled
    // common-access role isn't offered for consideration.
    const pickerFilterMode = (await getTenantSettings()).roleFilterMode || "ALL";
    const summaries = (await fetchCommonAccessRoleSummaries()).filter(
      (s) => pickerFilterMode !== "ENABLED_ONLY" || s.enabled !== false
    );
    const matchedIds = new Set();
    const overlapping = [];
    for (const role of roles || []) {
      const roleLeaves = extractAllCriteriaLeaves(role.membership?.criteria);
      if (roleLeaves.length === 0) continue;
      for (const s of summaries) {
        if (matchedIds.has(s.id) || s.id === role.id) continue;
        if (!(criteriaLeavesSubsetOf(s.criteriaLeaves, roleLeaves) || criteriaLeavesSubsetOf(roleLeaves, s.criteriaLeaves))) continue;
        matchedIds.add(s.id);
        overlapping.push({ id: s.id, name: s.name, enabled: s.enabled });
      }
    }
    return overlapping;
  } catch (err) {
    console.error("[insights] role-eval-scans overlapping-common-access failed:", err.response?.data || err.message);
    throw routeError(err);
  }
}

/**
 * GET /api/insights/role-eval-scans/common-access-in-selection?query=...
 * A literal "is this confirmed Common Access role actually part of what I'm
 * about to evaluate" check, not a criteria-overlap heuristic: pages through
 * every role matching the same name-contains filter the scan itself would
 * use, keeping only the ones already flagged as Common Access. Capped at
 * 2500 roles paged for cost — stops early once every flagged role for this
 * tenant has been accounted for.
 */
export async function listCommonAccessInSelection(query) {
  const q = typeof query === "string" ? query.trim() : "";
  const rolesFilter = q ? `name co "${q}"` : undefined;
  try {
    const commonAccessIds = await getCommonAccessRoleIdSet();
    if (commonAccessIds.size === 0) return [];

    const pickerFilterMode = (await getTenantSettings()).roleFilterMode || "ALL";

    const matches = [];
    let offset = 0;
    while (matches.length < commonAccessIds.size && offset < 2500) {
      const pageOffset = offset;
      const page = await withApiRetry(
        () => iscGet("/v2026/roles", {
          limit: 250, offset: pageOffset, sorters: "name", ...(rolesFilter ? { filters: rolesFilter } : {}),
        }),
        { label: "common-access-in-selection: roles page" }
      );
      if (page.length === 0) break;
      for (const role of page) {
        if (!commonAccessIds.has(role.id)) continue;
        if (role.dimensional) continue; // dynamic roles are never common access
        if (pickerFilterMode === "ENABLED_ONLY" && !role.enabled) continue;
        matches.push({ id: role.id, name: role.name, enabled: !!role.enabled });
      }
      offset += page.length;
      if (page.length < 250) break;
    }
    return matches;
  } catch (err) {
    console.error("[insights] role-eval-scans common-access-in-selection failed:", err.response?.data || err.message);
    throw routeError(err);
  }
}

/** GET /api/insights/role-eval-scans — list past/running scans, newest first (no results payload). */
export async function listRoleEvalScans() {
  await failInterrupted(STORE);
  return Object.values(await roleEvalScans().all())
    .filter((s) => forThisTenant(s))
    .map(({ results, ...meta }) => ({
      ...meta,
      suggestionCount: (results || []).filter((r) => r.hasSuggestions && !r.accepted).length,
    }))
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
}

/** GET /api/insights/role-eval-scans/:id — full record including per-role results. */
export async function getRoleEvalScan(scanId) {
  await failInterrupted(STORE);
  const scan = forThisTenant(await roleEvalScans().get(scanId));
  if (!scan) throw notFound();
  return scan;
}

/** POST /api/insights/role-eval-scans/:id/cancel — returns the updated record. */
export async function cancelRoleEvalScan(scanId) {
  const scan = forThisTenant(await roleEvalScans().get(scanId));
  if (!scan) throw notFound();
  if (scan.status !== "running") {
    throw badRequest(`Scan is already ${scan.status}.`);
  }
  requestCancel(STORE, scanId);
  await updateRoleEvalScan(scanId, { status: "cancelled", completedAt: new Date().toISOString() });
  return roleEvalScans().get(scanId);
}

/** DELETE /api/insights/role-eval-scans/:id */
export async function deleteRoleEvalScan(scanId) {
  const scan = forThisTenant(await roleEvalScans().get(scanId));
  if (!scan) throw notFound();
  if (scan.status === "running") {
    throw badRequest("Cancel the scan before removing it.");
  }
  await roleEvalScans().delete(scanId);
}

/**
 * Applies every actionable suggestion from one role's evaluation result:
 * removes stale/unavailable entitlements and adds commonly-held-but-missing
 * ones in a single combined call (avoids two racing replaces against the
 * same array), adds each existing dimension's own missing entitlements, and
 * creates every "new dimension may be needed" gap with its entitlements.
 * Shared by the per-role and accept-all actions.
 */
async function applyRoleEvaluationSuggestions(roleId, evaluation) {
  const addedEntIds = new Set();
  const removeIds = (evaluation.removeCandidates || []).map((c) => c.entitlementId).filter(Boolean);
  const addEnts = await filterExistingEntitlements(
    (evaluation.addCandidates || []).map((c) => ({ id: c.entitlementId, name: c.entitlement }))
  );
  if (removeIds.length || addEnts.length) {
    await patchRoleEntitlements(roleId, { add: addEnts, remove: removeIds });
    addEnts.forEach((e) => addedEntIds.add(e.id));
  }
  for (const d of evaluation.dimensionEvaluations || []) {
    const dimAddEnts = await filterExistingEntitlements(
      (d.addCandidates || []).map((c) => ({ id: c.entitlementId, name: c.entitlement }))
    );
    const dimRemoveIds = (d.removeCandidates || []).map((c) => c.entitlementId).filter(Boolean);
    if (dimAddEnts.length > 0 || dimRemoveIds.length > 0) {
      await patchDimensionEntitlements(roleId, d.dimensionId, { add: dimAddEnts, remove: dimRemoveIds });
      dimAddEnts.forEach((e) => addedEntIds.add(e.id));
    }
  }
  for (const md of evaluation.missingDimensions || []) {
    md.addCandidates = (md.addCandidates || []);
    const filteredEnts = await filterExistingEntitlements(
      md.addCandidates.map((c) => ({ id: c.entitlementId, name: c.entitlement }))
    );
    await createRoleDimensionOnServer(roleId, {
      name: md.value,
      attrKey: md.attrKey,
      value: md.value,
      entitlements: filteredEnts,
    });
    filteredEnts.forEach((e) => addedEntIds.add(e.id));
  }

  const tagged = await tagEntitlementsWithRoleBoundaryValues(roleId, [...addedEntIds]);
  return { tagged, addedEntIds: [...addedEntIds] };
}

// Applies one result and records it. Invariant: non-common roles never keep
// entitlements a common role grants for the same users — accepting adds onto
// a COMMON role removes those entitlements from every other role in this
// scan whose population the common role covers.
async function acceptOneResult(scan, result) {
  const { tagged, addedEntIds } = await applyRoleEvaluationSuggestions(result.roleId, result.evaluation);
  result.accepted = true;
  result.acceptedAt = new Date().toISOString();
  if (tagged) result.tagged = tagged;
  if ((addedEntIds || []).length > 0 && (scan.commonAccessRolesUsed || []).some((r) => r.id === result.roleId)) {
    const commonIds = new Set((scan.commonAccessRolesUsed || []).map((r) => r.id));
    const candidates = (scan.results || []).map((r) => r.roleId).filter((id) => !commonIds.has(id));
    const cascade = await removeAcceptedCommonEntsFromContextRoles(result.roleId, addedEntIds, candidates);
    if (cascade.length > 0) result.cascadeRemovals = cascade;
  }
}

/**
 * POST /api/insights/role-eval-scans/:id/results/:roleId/accept
 * Applies one role's suggestions (from its already-persisted evaluation —
 * not re-evaluated) and marks that result accepted. Returns the result.
 */
export async function acceptRoleEvalResult(scanId, roleId) {
  const scan = forThisTenant(await roleEvalScans().get(scanId));
  if (!scan) throw notFound();
  const result = scan.results?.find((r) => r.roleId === roleId);
  if (!result) throw badRequest("Role result not found in this scan.", 404);
  if (!result.evaluation) throw badRequest("This role's evaluation failed — nothing to accept.");

  try {
    await acceptOneResult(scan, result);
    await updateRoleEvalScan(scanId, { results: scan.results });
    return result;
  } catch (err) {
    console.error("[insights] role eval accept failed:", err.response?.data || err.message);
    throw routeError(err);
  }
}

/**
 * POST /api/insights/role-eval-scans/:id/accept-all
 * Applies every not-yet-accepted role's suggestions in the scan, one role
 * at a time (sequential — each role's own PATCH/POST calls already run
 * concurrently where safe; running whole roles in parallel risked hitting
 * SailPoint rate limits across dozens of roles at once). Continues past a
 * single role's failure rather than aborting the rest.
 * Returns { attempted, succeeded, failed, failures: [{ roleId, roleName, error }] }.
 */
export async function acceptAllRoleEvalResults(scanId) {
  const scan = forThisTenant(await roleEvalScans().get(scanId));
  if (!scan) throw notFound();

  const toApply = (scan.results || []).filter((r) => !r.accepted && r.evaluation && r.hasSuggestions);
  let succeeded = 0;
  const failures = [];
  try {
    for (const result of toApply) {
      try {
        // Results are ordered with Common Access roles first, so their
        // cascades run before the ordinary roles' own accepts are applied.
        await acceptOneResult(scan, result);
        succeeded += 1;
      } catch (err) {
        console.error(`[insights] role eval accept-all: role ${result.roleId} failed:`, err.response?.data || err.message);
        failures.push({ roleId: result.roleId, roleName: result.roleName, error: describeError(err) });
      }
      await updateRoleEvalScan(scanId, { results: scan.results });
    }
    return { attempted: toApply.length, succeeded, failed: failures.length, failures };
  } catch (err) {
    console.error("[insights] role eval accept-all failed:", err.response?.data || err.message);
    const out = routeError(err);
    out.response.data = { ...out.response.data, attempted: toApply.length, succeeded, failed: failures.length, failures };
    throw out;
  }
}

/**
 * POST /api/insights/role-eval-scans/:id/results/:roleId/mark-handled
 * Marks a result accepted WITHOUT re-applying its suggestions against ISC —
 * for when the client already applied them individually (the per-item
 * detail sheet acts on the real role directly), and just needs to record
 * that this role no longer needs attention in the persisted scan.
 */
export async function markRoleEvalResultHandled(scanId, roleId) {
  const scan = forThisTenant(await roleEvalScans().get(scanId));
  if (!scan) throw notFound();
  const result = scan.results?.find((r) => r.roleId === roleId);
  if (!result) throw badRequest("Role result not found in this scan.", 404);

  result.accepted = true;
  result.acceptedAt = new Date().toISOString();
  await updateRoleEvalScan(scanId, { results: scan.results });
  return result;
}
