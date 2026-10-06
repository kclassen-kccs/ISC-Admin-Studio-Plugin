/**
 * ported/roleEvaluation.js
 * Role Evaluation, Role Composition and SOD mitigations — ports of
 *   POST /api/roles/:id/evaluate                (evaluateRole)
 *   GET  /api/roles/:id/composition             (getRoleComposition)
 *   POST /api/roles/:id/composition/suggest     (suggestRoleComposition)
 *   POST/GET/DELETE /api/roles/:id/sod-mitigations
 * plus evaluateRoleAlgorithmic and its helpers, which the old server shared
 * with its bulk Role Evaluation scan.
 *
 * AI: the old suggest route asked Claude to review the computed proposal. There
 * is no AI provider in the plugin, so suggestRoleComposition returns the
 * computed proposal with ai.error set to the same "AI isn't configured" message
 * the server used when no provider was configured. Evaluation itself never used
 * AI (aiUsed is always false).
 */

import { iscGet, iscPost, withApiRetry, routeError, badRequest } from "../isc";
import { recordStore } from "../store";
import {
  tenantKey,
  currentUser,
  mapWithConcurrency,
  getTenantSettings,
  extractSingleAttributeCriterion,
  extractAllCriteriaLeaves,
  criteriaLeavesSubsetOf,
  commonlyHeldEntitlementIds,
  existingEntitlementIds,
  resolveEntitlementDisplayInfo,
} from "./roleShared";
import {
  identityMatchesCriteria,
  findRoleMembers,
  ROLE_EVAL_MAX_MATCHES,
  ROLE_EVAL_IDENTITY_PAGE_SIZE,
  ROLE_EVAL_ENTITLEMENT_CONCURRENCY,
  ROLE_EVAL_MIN_MEMBERS_FOR_COMMONALITY,
  ROLE_MEMBERS_MAX_SCANNED,
} from "./roleMembers";
import {
  fetchCommonAccessRoleSummaries,
  filterApplicableCommonAccessEntIds,
  applicableCommonAccessRoles,
} from "./roleCommonAccess";
import { ensureRoleSegmentMetadata } from "./metadataTagging";

const ROLE_EVAL_DIMENSION_CONCURRENCY = 2; // bound cost — each dimension does its own identity scan

// ─── SOD mitigations ─────────────────────────────────────────────────────────
// This app's own record, not an ISC resource. ISC's own mitigation concept
// lives at the identity level; this app's SOD check instead compares a role
// definition's own granted entitlements against policy, which has no ISC-side
// equivalent to attach a mitigation to. One entry = one (role, policy,
// dimension) triple with an expiration; past expiresAt it's simply ignored
// (never actively purged). Store "sod-mitigations": an array per tenant.

const sodStore = () => recordStore("sod-mitigations");

export async function getAllSodMitigations() {
  return (await sodStore().get(tenantKey())) || [];
}
async function getActiveSodMitigations(roleId) {
  const now = Date.now();
  return (await getAllSodMitigations()).filter((m) => m.roleId === roleId && new Date(m.expiresAt).getTime() > now);
}
async function addSodMitigation(mitigation) {
  const list = await getAllSodMitigations();
  list.push(mitigation);
  await sodStore().put(tenantKey(), list);
}
export async function removeSodMitigation(mitigationId) {
  const list = await getAllSodMitigations();
  await sodStore().put(tenantKey(), list.filter((m) => m.id !== mitigationId));
}

// Splits a raw findSodViolations() result into what's still actively flagged
// vs. what's currently covered by a live mitigation for this exact (policy,
// dimension) pair — dimensionId is null for the base-role check, or a
// dimension's own id for a per-dimension check.
function splitMitigatedSodViolations(violations, mitigations, dimensionId = null) {
  const active = [];
  const mitigated = [];
  for (const v of violations) {
    const m = mitigations.find((mm) => mm.policyId === v.policyId && (mm.dimensionId || null) === dimensionId);
    if (m) mitigated.push({ policyId: v.policyId, policyName: v.policyName, expiresAt: m.expiresAt });
    else active.push(v);
  }
  return { active, mitigated };
}

/**
 * Fetches every CONFLICTING_ACCESS_BASED SOD policy (list-A-vs-list-B
 * entitlement conflicts) — the only policy type checkable against a role's
 * static entitlement set. GENERAL policies use an arbitrary search query
 * evaluated per-identity and can't be meaningfully tested against a role
 * definition alone.
 */
async function fetchConflictingAccessSodPolicies() {
  const policies = await withApiRetry(() => iscGet("/v2026/sod-policies", { limit: 250 }), { label: "fetchConflictingAccessSodPolicies: sod-policies" });
  return (policies || []).filter((p) => p.type === "CONFLICTING_ACCESS_BASED" && p.conflictingAccessCriteria);
}

/**
 * Checks one entitlement-id set against every conflicting-access SOD policy: a
 * violation exists when the set contains at least one entitlement from each
 * side of the policy's list A / list B. Only ENTITLEMENT-type criteria are
 * checkable this way. `resolveOrigin(id)` tells the caller where a matched
 * entitlement actually lives (base role vs. a specific dimension).
 */
function findSodViolations(entIds, policies, resolveOrigin = () => ({ type: "base" })) {
  const violations = [];
  for (const p of policies) {
    const left = p.conflictingAccessCriteria.leftCriteria?.criteriaList || [];
    const right = p.conflictingAccessCriteria.rightCriteria?.criteriaList || [];
    const toMatch = (c) => ({ id: c.id, name: c.name, origin: resolveOrigin(c.id) });
    const leftMatch = left.filter((c) => c.type === "ENTITLEMENT" && entIds.has(c.id)).map(toMatch);
    const rightMatch = right.filter((c) => c.type === "ENTITLEMENT" && entIds.has(c.id)).map(toMatch);
    if (leftMatch.length > 0 && rightMatch.length > 0) {
      violations.push({
        policyId: p.id,
        policyName: p.name,
        level: p.level,
        state: p.state,
        leftEntitlements: leftMatch,
        rightEntitlements: rightMatch,
      });
    }
  }
  return violations;
}

/**
 * Checks each of a role's own entitlements still resolves in ISC — fetching a
 * deleted/bogus entitlement id 404s, so a missing one means the entitlement no
 * longer exists in the source and the role is holding a dangling reference.
 * Fail-open: a batch that errors counts as present.
 */
async function findUnavailableEntitlements(roleEntitlements) {
  if (!roleEntitlements?.length) return [];
  const alive = await existingEntitlementIds(roleEntitlements.map((e) => e.id));
  return roleEntitlements.filter((e) => !alive.has(e.id)).map((e) => ({ id: e.id, name: e.name }));
}

// ─── Evaluation ──────────────────────────────────────────────────────────────

/**
 * For one dimension of a dynamic role: finds the identities matching the
 * dimension's own membership rule, then flags entitlements most of those
 * members hold that the dimension does NOT grant — the same
 * commonly-held-but-missing check used for the base role, scoped to the
 * dimension's own membership and entitlement set. roleEntIds (the base role's
 * own granted entitlements) are excluded from candidates too.
 */
async function evaluateDimensionEntitlements(
  dimension, roleEntIds, commonRoleEntIds = new Set(), commonalityThreshold = 0.8,
  baseMemberIds = null, baseAddCandidateIds = new Set(), precomputed = null, populationCache = null
) {
  const dimEntitlements = dimension.entitlements || [];

  // A dimension that grants something the base role already grants is pure
  // redundancy — every member of the role gets the base role's entitlements
  // regardless of dimension. This is a static comparison, independent of
  // membership data, so it's included even when the membership scan can't run.
  const removeCandidates = [
    ...dimEntitlements
      .filter((e) => roleEntIds.has(e.id))
      .map((e) => ({
        entitlementId: e.id,
        entitlement: e.name,
        reason: "Already granted by the base role — redundant on this dimension.",
      })),
    // Same redundancy idea, against common-access entitlements instead of the
    // base role — every relevant member already gets these regardless of
    // dimension.
    ...dimEntitlements
      .filter((e) => !roleEntIds.has(e.id) && commonRoleEntIds.has(e.id))
      .map((e) => ({
        entitlementId: e.id,
        entitlement: e.name,
        reason: "Already granted automatically by a common-access role — redundant here.",
      })),
  ];

  let dimensionMatches, entitlementLists, totalScanned, partial;

  if (precomputed) {
    // The caller already scanned this exact population — every one of these
    // members is a base-role member who also matches this dimension's own
    // attrKey=value, with entitlements already fetched during that same base
    // scan. Reusing it cuts a role with N dimensions from N+1 full membership
    // scans down to 1.
    ({ matches: dimensionMatches, entitlementLists, totalScanned, partial } = precomputed);
    if (dimensionMatches.length === 0) {
      return { dimensionId: dimension.id, dimensionName: dimension.name, memberProfile: null, addCandidates: [], removeCandidates };
    }
  } else {
    const membershipResult = await findRoleMembers(dimension.membership, null, populationCache);

    if (!membershipResult.supported || membershipResult.matches.length === 0) {
      return { dimensionId: dimension.id, dimensionName: dimension.name, memberProfile: null, addCandidates: [], removeCandidates };
    }

    // A dimension's own membership criteria only ever encodes the one attribute
    // it varies by — it says nothing about the base role's own criteria.
    // Matching against the dimension's criteria alone therefore pulls in every
    // identity tenant-wide with that job title, not just the ones who actually
    // have this role (verified live). Real dimension access only applies to
    // identities who qualify for the base role AND match the dimension, so
    // intersect with the base role's own membership when it's known.
    dimensionMatches = baseMemberIds
      ? membershipResult.matches.filter((m) => baseMemberIds.has(m.id))
      : membershipResult.matches;
    if (dimensionMatches.length === 0) {
      return { dimensionId: dimension.id, dimensionName: dimension.name, memberProfile: null, addCandidates: [], removeCandidates };
    }

    // A member whose entitlement fetch fails is silently treated as holding
    // nothing at all — one flaky fetch can flip an entitlement sitting right at
    // the commonality threshold. Retried before giving up, to make that rarer.
    entitlementLists = await mapWithConcurrency(
      dimensionMatches, ROLE_EVAL_ENTITLEMENT_CONCURRENCY,
      async (m) => {
        try {
          return await withApiRetry(
            () => iscGet(`/v2026/entitlements/identities/${m.id}/entitlements`, { limit: 100 }),
            { label: `dimension ${dimension.id}: fetch entitlements for identity ${m.id}` }
          );
        } catch {
          return [];
        }
      }
    );
    totalScanned = membershipResult.totalScanned;
    partial = !!membershipResult.partial;
  }
  const memberCount = dimensionMatches.length;
  const dimEntIds = new Set(dimEntitlements.map((e) => e.id));

  // Same algorithm Draft creation uses for a dimension's own entitlements: a
  // percentage of members (the tenant's entitlementCommonalityThreshold),
  // computed only from members holding more than one entitlement: exactly one
  // is excluded, and zero is excluded too (an unprovisioned new hire isn't
  // evidence against commonality, just not there yet).
  const memberEntitlementObjs = dimensionMatches.map((m, i) => ({ entitlements: entitlementLists[i] || [] }));
  const eligibleForProposal = memberEntitlementObjs.filter((m) => m.entitlements.length > 1);
  const commonEntIds = commonlyHeldEntitlementIds(eligibleForProposal, commonalityThreshold);
  const nameAndCountById = new Map();
  for (const list of entitlementLists) {
    for (const e of list) {
      const entry = nameAndCountById.get(e.id) || { name: e.name, count: 0 };
      entry.count += 1;
      nameAndCountById.set(e.id, entry);
    }
  }
  const commonlyHeldNotGranted = [...commonEntIds]
    .filter((entId) =>
      !dimEntIds.has(entId) && !roleEntIds.has(entId) && !commonRoleEntIds.has(entId) &&
      !baseAddCandidateIds.has(entId)
    )
    .map((entId) => ({ id: entId, ...nameAndCountById.get(entId) }));

  return {
    dimensionId: dimension.id,
    dimensionName: dimension.name,
    memberProfile: {
      memberCount,
      totalScanned,
      partial,
    },
    addCandidates: commonlyHeldNotGranted.map((e) => ({
      entitlementId: e.id,
      entitlement: e.name,
      reason: `Held by ${e.count} of ${memberCount} current members of this dimension (>=${Math.round(commonalityThreshold * 100)}%) but not granted by it.`,
    })),
    removeCandidates,
  };
}

/**
 * Runs the full algorithmic role evaluation (member-comparison,
 * entitlement-availability, dimension gap/missing-dimension detection) for one
 * role. options: { considerCommonAccessRoleIds, sharedSodPolicies,
 * sharedCommonAccessSummaries, populationCache } — see the comments below.
 */
export async function evaluateRoleAlgorithmic(roleId, options = {}) {
  // considerCommonAccessRoleIds: explicit opt-in list from the "Evaluate" picker
  // on Role Detail — when provided (even as an empty array), it's the FINAL say
  // on which common-access roles' entitlements are excluded, replacing the
  // automatic subset-of-criteria matching entirely. undefined keeps the
  // automatic behavior.
  // sharedSodPolicies/sharedCommonAccessSummaries: an optional pre-fetch a batch
  // caller hands down so this tenant-wide, largely static data is fetched once
  // per scan run instead of once per role. populationCache: an optional shared
  // {} (see fetchActiveIdentityPopulation) so every role's findRoleMembers call
  // draws from one paged fetch of the tenant's active identities.
  const { considerCommonAccessRoleIds, sharedSodPolicies, sharedCommonAccessSummaries, populationCache } = options;
  const role = await withApiRetry(() => iscGet(`/v2026/roles/${roleId}`), { label: `evaluateRoleAlgorithmic: fetch role ${roleId}` });
  const roleEntitlements = role.entitlements || [];

  const roleEntIds = new Set(roleEntitlements.map((e) => e.id));

  // Fetched up front so the dimension-splitting attribute(s) can be resolved
  // before the base membership scan runs — that lets the scan capture each
  // match's value of every such attribute in the same pass, instead of a second
  // full identity scan just for missing/stale-dimension detection.
  const dimensions = role.dimensional
    ? await withApiRetry(() => iscGet(`/v2026/roles/${roleId}/dimensions`), { label: `evaluateRoleAlgorithmic: fetch role ${roleId} dimensions` })
    : [];
  // The role's own declared dimension-splitting attribute(s) —
  // accessRequestConfig.dimensionSchema.dimensionAttributes — is authoritative
  // and checked even when the role currently has zero dimensions. Falls back to
  // inferring from existing dimensions' own criteria only when that field isn't
  // populated and every existing dimension agrees on one attribute.
  const existingDimensionInfo = dimensions
    .map((d) => ({ id: d.id, name: d.name, criterion: extractSingleAttributeCriterion(d.membership?.criteria) }))
    .filter((d) => d.criterion);
  const declaredDimensionAttrKeys = (role.accessRequestConfig?.dimensionSchema?.dimensionAttributes || [])
    .map((a) => a.name)
    .filter(Boolean);
  const dimensionAttrKeys = declaredDimensionAttrKeys.length > 0
    ? [...new Set(declaredDimensionAttrKeys)]
    : dimensions.length > 0 &&
      existingDimensionInfo.length === dimensions.length &&
      new Set(existingDimensionInfo.map((d) => d.criterion.attrKey)).size === 1
    ? [existingDimensionInfo[0].criterion.attrKey]
    : [];
  // Existing dimension values, grouped per attribute — a role's
  // dimensionAttributes can list more than one, where each individual
  // dimension is scoped by just one of them, not a cross-product of both.
  const existingDimensionValuesByAttr = new Map(); // attrKey -> Set(value)
  for (const d of existingDimensionInfo) {
    if (!existingDimensionValuesByAttr.has(d.criterion.attrKey)) existingDimensionValuesByAttr.set(d.criterion.attrKey, new Set());
    existingDimensionValuesByAttr.get(d.criterion.attrKey).add(d.criterion.value);
  }

  // Both togglable on the Evaluation Config screen (default on for each).
  // Leaving sodPolicies/commonRoleEntIds empty when their toggle is off is
  // enough to disable each feature everywhere downstream.
  const evalSettings = await getTenantSettings();
  const commonalityThreshold = (evalSettings.entitlementCommonalityThreshold ?? 80) / 100;
  // Boundary config lives on the Schema Analysis record, same place the role
  // scan reads it from at scan start.
  const evalBoundarySchema = await recordStore("schema-analysis").get(tenantKey());
  const evalBoundaryAttributes = evalBoundarySchema?.roleBoundaryEnabled
    ? evalBoundarySchema.roleBoundaryAttributes || []
    : [];
  // Read fresh for every role evaluated. Only common-access roles whose own
  // membership is a superset of (or equal to) THIS role's membership are
  // actually applicable — see filterApplicableCommonAccessEntIds.
  const [membershipResult, unavailableEntitlements, sodPolicies, commonAccessSummaries] = await Promise.all([
    findRoleMembers(role.membership, dimensionAttrKeys, populationCache),
    findUnavailableEntitlements(roleEntitlements),
    sharedSodPolicies !== undefined
      ? Promise.resolve(sharedSodPolicies)
      : evalSettings.checkSodViolations ? fetchConflictingAccessSodPolicies() : Promise.resolve([]),
    sharedCommonAccessSummaries !== undefined
      ? Promise.resolve(sharedCommonAccessSummaries)
      : evalSettings.considerCommonRoles
      ? withApiRetry(() => fetchCommonAccessRoleSummaries(), { label: `role ${roleId}: fetch common-access role summaries` }).catch((err) => {
          console.error(`[insights] role ${roleId}: failed to fetch common-access role summaries after retries:`, err.response?.data || err.message);
          return [];
        })
      : Promise.resolve([]),
  ]);
  // A role that is itself common access gets NO common-access exclusion,
  // INCLUDING when it is one of the picker's considered roles. Otherwise, after
  // an accept added the population-wide birthright to every boundary Common
  // Access role, the next scan flagged each one's grants as "redundant with
  // common access" (granted by its siblings) and recommended removing them, and
  // the run after that recommended adding them back: a permanent
  // accept-flip-flop (verified from three consecutive scan records).
  const isThisRoleCommonAccess =
    commonAccessSummaries.some((s) => s.id === roleId) ||
    (Array.isArray(considerCommonAccessRoleIds) && considerCommonAccessRoleIds.includes(roleId));
  const commonRoleEntIds = isThisRoleCommonAccess
    ? new Set()
    : considerCommonAccessRoleIds
    ? new Set(
        commonAccessSummaries
          .filter((s) => s.id !== roleId && considerCommonAccessRoleIds.includes(s.id))
          .flatMap((s) => [...s.entIds])
      )
    : filterApplicableCommonAccessEntIds(role.membership, commonAccessSummaries, roleId, evalBoundaryAttributes);

  // Only for a common-access role evaluating itself: every OTHER active
  // common-access role whose own criteria nests with this one's — either is a
  // subset of the other — has an overlapping population. Purely informational:
  // surfaced as a possible duplicate to review.
  let overlappingCommonAccessRoles = [];
  if (isThisRoleCommonAccess) {
    const roleLeaves = extractAllCriteriaLeaves(role.membership?.criteria);
    if (roleLeaves.length > 0) {
      overlappingCommonAccessRoles = commonAccessSummaries
        .filter((s) => s.id !== roleId)
        .filter((s) => criteriaLeavesSubsetOf(s.criteriaLeaves, roleLeaves) || criteriaLeavesSubsetOf(roleLeaves, s.criteriaLeaves))
        .map((s) => ({ id: s.id, name: s.name }));
    }
  }

  // Base role's own entitlements against each other — catches a role that is
  // itself internally in conflict. Anything currently mitigated is pulled out
  // of the active list — still surfaced, just not as an actionable violation
  // until the mitigation expires. Turning "Allow SOD Mitigations" off doesn't
  // just hide the button — an existing mitigation stops being honored too.
  const activeSodMitigations = evalSettings.allowSodMitigations === false ? [] : await getActiveSodMitigations(roleId);
  const { active: sodViolations, mitigated: mitigatedSodViolations } =
    splitMitigatedSodViolations(findSodViolations(roleEntIds, sodPolicies), activeSodMitigations, null);

  let memberProfile = null;
  const missingDimensions = [];
  const staleDimensions = [];
  // Hoisted so evaluateDimensionEntitlements can reuse it per dimension instead
  // of each dimension re-fetching this exact same population's entitlements.
  let baseEntitlementLists = [];
  if (membershipResult.supported && membershipResult.matches.length > 0) {
    // A member whose entitlement fetch fails this call is silently treated as
    // holding nothing, which can flip an entitlement sitting right at the
    // commonality threshold in or out of the results between runs.
    const entitlementLists = baseEntitlementLists = await mapWithConcurrency(
      membershipResult.matches, ROLE_EVAL_ENTITLEMENT_CONCURRENCY,
      async (m) => {
        try {
          return await withApiRetry(
            () => iscGet(`/v2026/entitlements/identities/${m.id}/entitlements`, { limit: 100 }),
            { label: `role ${roleId}: fetch entitlements for identity ${m.id}` }
          );
        } catch {
          return [];
        }
      }
    );
    const counts = new Map(); // entitlement id -> { name, count }
    for (const list of entitlementLists) {
      for (const e of list) {
        const entry = counts.get(e.id) || { name: e.name, count: 0 };
        entry.count += 1;
        counts.set(e.id, entry);
      }
    }
    const memberCount = membershipResult.matches.length;
    const sampleTooSmall = memberCount < ROLE_EVAL_MIN_MEMBERS_FOR_COMMONALITY;

    const rarelyHeldRaw = sampleTooSmall ? [] : roleEntitlements
      .map((e) => ({ id: e.id, name: e.name, count: counts.get(e.id)?.count || 0 }))
      .filter((e) => e.count / memberCount < 0.1);

    const commonlyHeldNotGrantedRaw = sampleTooSmall ? [] : [...counts.entries()]
      .filter(([id, entry]) => !roleEntIds.has(id) && !commonRoleEntIds.has(id) && entry.count / memberCount >= commonalityThreshold)
      .map(([id, entry]) => ({ id, ...entry }));

    // Currently-granted entitlements that DON'T meet the commonality bar
    // against this role's own population — used only when a Role Evaluation
    // batch scan's entire selection is Common Access roles.
    const nonCommonGrantedRaw = sampleTooSmall ? [] : roleEntitlements
      .map((e) => ({ id: e.id, name: e.name, count: counts.get(e.id)?.count || 0 }))
      .filter((e) => e.count / memberCount < commonalityThreshold);

    memberProfile = {
      memberCount,
      totalScanned: membershipResult.totalScanned,
      partial: !!membershipResult.partial,
      sampleTooSmall,
      rarelyHeld: rarelyHeldRaw.map((e) => `${e.name} (held by ${e.count} of ${memberCount} current members)`),
      commonlyHeldNotGranted: commonlyHeldNotGrantedRaw.map((e) => `${e.name} (held by ${e.count} of ${memberCount} current members)`),
      rarelyHeldRaw,
      commonlyHeldNotGrantedRaw,
      nonCommonGrantedRaw,
    };

    // Missing-dimension detection: runs for every one of the role's declared
    // dimension-splitting attributes, always — including a dynamic role with
    // zero dimensions yet — using the entitlement data already fetched above.
    for (const attrKey of dimensionAttrKeys) {
      const existingValuesForAttr = existingDimensionValuesByAttr.get(attrKey) || new Set();

      // Missing: a value with real members that isn't covered by an existing
      // dimension for this attribute — flagged with the entitlements most of
      // those members hold that the base role doesn't already grant. Same
      // commonlyHeldEntitlementIds algorithm Draft creation uses.
      const groups = new Map(); // value -> [entitlement list]
      membershipResult.matches.forEach((m, i) => {
        const value = m.attrValues?.[attrKey];
        if (!value || value === "Unknown" || existingValuesForAttr.has(value)) return;
        if (!groups.has(value)) groups.set(value, []);
        groups.get(value).push(entitlementLists[i] || []);
      });
      for (const [value, lists] of groups.entries()) {
        const eligibleForProposal = lists.filter((list) => list.length > 1).map((entitlements) => ({ entitlements }));
        const groupCommonEntIds = commonlyHeldEntitlementIds(eligibleForProposal, commonalityThreshold);
        const groupCounts = new Map();
        for (const list of lists) {
          for (const e of list) {
            const entry = groupCounts.get(e.id) || { name: e.name, count: 0 };
            entry.count += 1;
            groupCounts.set(e.id, entry);
          }
        }
        const groupAddCandidates = [...groupCommonEntIds]
          .filter((entId) => !roleEntIds.has(entId) && !commonRoleEntIds.has(entId))
          .map((entId) => ({
            entitlementId: entId,
            entitlement: groupCounts.get(entId)?.name,
            reason: `Held by ${groupCounts.get(entId)?.count} of ${lists.length} members with ${attrKey}="${value}" (>=${Math.round(commonalityThreshold * 100)}%).`,
          }));
        missingDimensions.push({
          attrKey,
          value,
          memberCount: lists.length,
          addCandidates: groupAddCandidates,
        });
      }

      // Deliberately NOT flagging a dimension as stale just because no CURRENT
      // role member happens to have its value right now. An empty dimension
      // whose attrKey=value combination is still a real, valid identity
      // attribute is a placeholder waiting to be populated (verified live: a
      // role got 31 such dimensions flagged for removal purely because none of
      // its current members happened to be in those cities yet). Explicit user
      // instruction: don't propose removing dimensions the identity attributes
      // indicate are valid. staleDimensions stays wired through (always empty)
      // in case a real signal for it is reintroduced later.
    }
  }

  // Algorithmic findings — computed unconditionally, independent of AI.
  // A role that explicitly grants something a common-access role already grants
  // everyone is carrying redundant baggage. Pulled out to its own variable so
  // summarizeAlgorithmic can count it too.
  const redundantWithCommonAccess = roleEntitlements
    .filter((e) => commonRoleEntIds.has(e.id))
    .map((e) => ({
      entitlementId: e.id,
      entitlement: e.name,
      reason: "Already granted automatically by a common-access role — redundant here.",
    }));
  // A Common Access role's own grants are meant to track its population's
  // actual commonality exactly — an entitlement it holds that's held by FEWER
  // than the commonality threshold of its own current members isn't common
  // anymore and should come off, not just be flagged as "rare".
  const nonCommonOnCommonAccessRole = isThisRoleCommonAccess && memberProfile
    // >= 10% excluded here — those already show up via rarelyHeldRaw below with
    // their own "may be stale" reason; no need to flag the same entitlement
    // twice with two different explanations.
    ? memberProfile.nonCommonGrantedRaw
        .filter((e) => e.count / memberProfile.memberCount >= 0.1)
        .map((e) => ({
          entitlementId: e.id,
          entitlement: e.name,
          reason: `Held by only ${e.count} of ${memberProfile.memberCount} current members (<${Math.round(commonalityThreshold * 100)}%) — no longer common enough for this Common Access role.`,
        }))
    : [];
  const algorithmicRemoveCandidates = [
    ...unavailableEntitlements.map((e) => ({
      entitlementId: e.id,
      entitlement: e.name,
      reason: "This entitlement no longer exists in its source system — the role is holding a dangling reference to it.",
    })),
    ...redundantWithCommonAccess,
    ...nonCommonOnCommonAccessRole,
    ...(memberProfile
      ? memberProfile.rarelyHeldRaw.map((e) => ({
          entitlementId: e.id,
          entitlement: e.name,
          reason: `Held by only ${e.count} of ${memberProfile.memberCount} current members (<10%) — may be stale.`,
        }))
      : []),
  ];
  const algorithmicAddCandidates = memberProfile
    ? memberProfile.commonlyHeldNotGrantedRaw.map((e) => ({
        entitlementId: e.id,
        entitlement: e.name,
        reason: `Held by ${e.count} of ${memberProfile.memberCount} current members (>=${Math.round(commonalityThreshold * 100)}%) but not granted by this role.`,
      }))
    : [];

  function summarizeAlgorithmic() {
    const parts = [];
    if (unavailableEntitlements.length > 0) {
      parts.push(`${unavailableEntitlements.length} entitlement(s) no longer exist in their source and should be removed`);
    }
    if (redundantWithCommonAccess.length > 0) {
      parts.push(`${redundantWithCommonAccess.length} entitlement(s) are redundant with a common-access role`);
    }
    if (memberProfile?.sampleTooSmall) {
      parts.push(
        `only ${memberProfile.memberCount} current member(s) — too few to reliably tell what's ` +
        `commonly held, so member-based comparisons were skipped`
      );
    } else if (memberProfile) {
      if (memberProfile.rarelyHeldRaw.length > 0) {
        parts.push(`${memberProfile.rarelyHeldRaw.length} entitlement(s) are rarely held by current members`);
      }
      if (memberProfile.commonlyHeldNotGrantedRaw.length > 0) {
        parts.push(`${memberProfile.commonlyHeldNotGrantedRaw.length} commonly-held entitlement(s) aren't granted by this role`);
      }
    } else {
      parts.push("current membership couldn't be reliably determined, so member-based comparisons were skipped");
    }
    // Member count isn't restated here — the client already shows it once
    // alongside these results (result.memberProfile.memberCount).
    return parts.length ? `${parts.join("; ")}.` : "No clear staleness or gaps found.";
  }

  // Dynamic (dimensional) roles: check each existing dimension's own membership
  // for commonly-held entitlements it doesn't grant, same idea as the base role
  // check above but scoped per-dimension. Intersected with the base role's own
  // matched members (see evaluateDimensionEntitlements).
  const baseMemberIds = membershipResult.supported ? new Set(membershipResult.matches.map((m) => m.id)) : null;
  const baseAddCandidateIds = new Set((memberProfile?.commonlyHeldNotGrantedRaw || []).map((e) => e.id));
  // Only reused when the base scan captured the WHOLE matching population (not
  // truncated by ROLE_EVAL_MAX_MATCHES) — otherwise a dimension whose own
  // narrower criteria could reach further into the tenant before hitting the
  // cap would silently lose real members.
  const baseSampleComplete = membershipResult.supported && membershipResult.matches.length < ROLE_EVAL_MAX_MATCHES;
  const dimensionCriterionById = new Map(
    dimensions.map((d) => [d.id, extractSingleAttributeCriterion(d.membership?.criteria)])
  );
  const dimensionEvaluations = role.dimensional
    ? await mapWithConcurrency(
        dimensions, ROLE_EVAL_DIMENSION_CONCURRENCY,
        async (d) => {
          // Reuse the base role's own already-fetched membership + entitlements
          // for this dimension instead of a second, independent full-tenant
          // scan for what's provably the same population. Falls back to that
          // independent scan (precomputed: null) whenever reuse isn't safe: the
          // base sample was capped, or this dimension's criterion isn't one of
          // the attributes the base scan itself captured (dimensionAttrKeys).
          let precomputed = null;
          if (baseSampleComplete) {
            const criterion = dimensionCriterionById.get(d.id);
            if (criterion && dimensionAttrKeys.includes(criterion.attrKey)) {
              const matches = [];
              const entitlementLists = [];
              membershipResult.matches.forEach((m, i) => {
                if (m.attrValues?.[criterion.attrKey] === criterion.value) {
                  matches.push(m);
                  entitlementLists.push(baseEntitlementLists[i] || []);
                }
              });
              precomputed = { matches, entitlementLists, totalScanned: membershipResult.totalScanned, partial: !!membershipResult.partial };
            }
          }
          const evaluation = await evaluateDimensionEntitlements(d, roleEntIds, commonRoleEntIds, commonalityThreshold, baseMemberIds, baseAddCandidateIds, precomputed, populationCache);
          // A dimension's members get the base role's entitlements plus this
          // dimension's own — so the SOD check runs against that combined set.
          const dimEntIds = new Set((d.entitlements || []).map((e) => e.id));
          const combined = new Set([...roleEntIds, ...dimEntIds]);
          const rawDimSodViolations = findSodViolations(combined, sodPolicies, (entId) =>
            roleEntIds.has(entId) ? { type: "base" } : { type: "dimension", dimensionId: d.id, dimensionName: d.name }
          );
          const dimSplit = splitMitigatedSodViolations(rawDimSodViolations, activeSodMitigations, d.id);
          evaluation.sodViolations = dimSplit.active;
          evaluation.mitigatedSodViolations = dimSplit.mitigated;
          return evaluation;
        }
      )
    : [];
  const dimensionGapCount = dimensionEvaluations.filter((d) => d.addCandidates.length > 0).length;
  const dimensionRedundantCount = dimensionEvaluations.filter((d) => (d.removeCandidates || []).length > 0).length;
  const dimensionSodCount = dimensionEvaluations.filter((d) => (d.sodViolations || []).length > 0).length;
  const mitigatedSodCount = mitigatedSodViolations.length +
    dimensionEvaluations.reduce((n, d) => n + (d.mitigatedSodViolations?.length || 0), 0);

  function summarizeAlgorithmicWithDimensions() {
    const parts = [];
    if (sodViolations.length > 0) {
      parts.push(`${sodViolations.length} SOD policy violation(s) found on the base role`);
    }
    if (dimensionSodCount > 0) {
      parts.push(`${dimensionSodCount} dimension(s) combine with the base role to violate an SOD policy`);
    }
    if (mitigatedSodCount > 0) {
      parts.push(`${mitigatedSodCount} SOD policy violation(s) currently mitigated`);
    }
    if (dimensionGapCount > 0) {
      parts.push(`${dimensionGapCount} dimension(s) have commonly-held entitlements they don't grant`);
    }
    if (dimensionRedundantCount > 0) {
      parts.push(`${dimensionRedundantCount} dimension(s) redundantly grant entitlements already on the base role`);
    }
    if (missingDimensions.length > 0) {
      parts.push(`${missingDimensions.length} new dimension(s) may need to be created`);
    }
    if (staleDimensions.length > 0) {
      parts.push(`${staleDimensions.length} existing dimension(s) may no longer be valid`);
    }
    if (overlappingCommonAccessRoles.length > 0) {
      parts.push(`${overlappingCommonAccessRoles.length} other common-access role(s) have an overlapping membership rule — possible duplicates`);
    }
    const base = summarizeAlgorithmic();
    // A fully clean result (no findings of any kind, including no SOD
    // violations) is worth stating explicitly rather than just staying silent on
    // the SOD check.
    if (parts.length === 0) {
      return base === "No clear staleness or gaps found." && evalSettings.checkSodViolations
        ? "No clear staleness or gaps found. No SOD policy violations detected."
        : base;
    }
    const note = `${parts.join("; ")}.`;
    return base === "No clear staleness or gaps found." ? note : `${base} ${note}`;
  }

  // "Add" candidates all come from the per-identity member scan above, whose
  // "name" is the same raw attribute value bug fixed for the role scan report
  // (verified live, same underlying ISC endpoint). "Remove" candidates already
  // carry the real name, but neither carries "source" — this resolves both
  // categories in one pass, at the end, so every category goes through the
  // exact same fix.
  const candidateIds = [
    ...algorithmicAddCandidates.map((c) => c.entitlementId),
    ...algorithmicRemoveCandidates.map((c) => c.entitlementId),
    ...dimensionEvaluations.flatMap((d) => [
      ...d.addCandidates.map((c) => c.entitlementId),
      ...(d.removeCandidates || []).map((c) => c.entitlementId),
    ]),
    ...missingDimensions.flatMap((md) => md.addCandidates.map((c) => c.entitlementId)),
  ];
  if (candidateIds.length > 0) {
    try {
      const infoById = await resolveEntitlementDisplayInfo(candidateIds);
      const relabel = (c) => {
        const info = infoById.get(c.entitlementId);
        if (!info) return c;
        return { ...c, entitlement: info.name || c.entitlement, source: info.source || null };
      };
      algorithmicAddCandidates.forEach((c, i) => { algorithmicAddCandidates[i] = relabel(c); });
      algorithmicRemoveCandidates.forEach((c, i) => { algorithmicRemoveCandidates[i] = relabel(c); });
      dimensionEvaluations.forEach((d) => {
        d.addCandidates = d.addCandidates.map(relabel);
        d.removeCandidates = (d.removeCandidates || []).map(relabel);
      });
      missingDimensions.forEach((md) => { md.addCandidates = md.addCandidates.map(relabel); });
    } catch (err) {
      console.error(`[insights] role evaluation ${roleId}: candidate name/source resolution failed:`, err.response?.data || err.message);
    }
  }

  // Only derive a value from boundary criteria when this tenant actually
  // manages data segments; a role already tagged is checked regardless.
  const segmentMetadata = await ensureRoleSegmentMetadata(
    role, dimensions,
    evalBoundarySchema?.createDataSegments ? evalBoundaryAttributes : []
  );

  // AI-assisted analysis is disabled for evaluation — always the algorithmic
  // result.
  return {
    role: { id: role.id, name: role.name },
    segmentMetadata,
    // The role's own base entitlements (not the missing/redundant candidates
    // above) — used by the batch scan to find entitlements common to every role
    // in scope.
    roleEntitlements,
    memberProfile,
    unavailableEntitlements,
    dimensionEvaluations,
    missingDimensions,
    staleDimensions,
    sodViolations,
    mitigatedSodViolations,
    overlappingCommonAccessRoles,
    aiUsed: false,
    summary: summarizeAlgorithmicWithDimensions(),
    removeCandidates: algorithmicRemoveCandidates,
    addCandidates: algorithmicAddCandidates,
    // Whether the role's membership rule (or its IDENTITY_LIST) could actually
    // be tested as valid search criteria against real identity data — false
    // means findRoleMembers couldn't evaluate it at all, so every member-based
    // comparison above was skipped.
    membershipRuleEvaluated: membershipResult.supported,
  };
}

/**
 * POST /api/roles/:id/evaluate
 * Compares the role's entitlements against what its current members actually
 * hold. considerCommonAccessRoleIds is optional — omit it to keep the automatic
 * common-access matching.
 */
export async function evaluateRole(id, considerCommonAccessRoleIds) {
  try {
    return await evaluateRoleAlgorithmic(id, {
      considerCommonAccessRoleIds: Array.isArray(considerCommonAccessRoleIds) ? considerCommonAccessRoleIds : undefined,
    });
  } catch (err) {
    console.error("[roles] evaluate failed:", err.response?.data || err.message);
    throw routeError(err);
  }
}

// ─── SOD mitigation routes ───────────────────────────────────────────────────

function roleEvalResultHasSuggestions(evaluation) {
  return (
    (evaluation.removeCandidates?.length || 0) > 0 ||
    (evaluation.addCandidates?.length || 0) > 0 ||
    (evaluation.dimensionEvaluations || []).some((d) => d.addCandidates.length > 0 || (d.removeCandidates || []).length > 0) ||
    (evaluation.missingDimensions?.length || 0) > 0 ||
    (evaluation.staleDimensions?.length || 0) > 0
  );
}

// SOD violations are surfaced separately from "suggestions" — there's no
// automated fix for a policy conflict, so this must never make a role eligible
// for the bulk Accept All action.
function roleEvalResultHasSodViolations(evaluation) {
  return (
    (evaluation.sodViolations?.length || 0) > 0 ||
    (evaluation.dimensionEvaluations || []).some((d) => (d.sodViolations || []).length > 0)
  );
}

function roleEvalResultHasMitigatedSodViolations(evaluation) {
  return (
    (evaluation.mitigatedSodViolations?.length || 0) > 0 ||
    (evaluation.dimensionEvaluations || []).some((d) => (d.mitigatedSodViolations || []).length > 0)
  );
}

/**
 * The Home screen's Roles Needing Updates / SOD Violation counts come from a
 * snapshot stored on the most recent scheduled Role Evaluation scan.
 * Applying, editing, or deleting a mitigation doesn't re-run that scan, so this
 * patches just this one role's row in place. Best-effort: no scheduled scan yet
 * (or the scan store not populated), or the role not being in the latest one's
 * results, is a normal no-op, not an error.
 */
export async function syncRoleIntoLatestStatsScan(roleId) {
  try {
    const store = recordStore("role-eval-scans");
    const tenant = tenantKey();
    const scans = Object.values(await store.all())
      .filter((s) => (!s.tenant || s.tenant === tenant) && s.triggeredBy === "scheduled" && s.status === "completed")
      .sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt));
    const latest = scans[0];
    if (!latest) return;
    const results = latest.results || [];
    const idx = results.findIndex((r) => r.roleId === roleId);
    if (idx === -1) return;
    const evaluation = await evaluateRoleAlgorithmic(roleId);
    results[idx] = {
      ...results[idx],
      evaluation,
      hasSuggestions: roleEvalResultHasSuggestions(evaluation),
      hasSodViolations: roleEvalResultHasSodViolations(evaluation),
      mitigatedViolationPresent: roleEvalResultHasMitigatedSodViolations(evaluation),
      error: null,
    };
    await store.put(latest.id, { ...((await store.get(latest.id)) || latest), results });
  } catch (err) {
    console.error(`[insights] sync role ${roleId} into latest stats scan failed:`, err.response?.data || err.message);
  }
}

/**
 * POST /api/roles/:id/sod-mitigations
 * { items: [{ policyId, policyName, dimensionId?, dimensionName? }], expiresAt, roleName }
 * Records a time-limited mitigation for each listed (policy, dimension)
 * violation occurrence — no ISC resource backs this, it's purely this app's own
 * record. Re-evaluates the role afterward so the response immediately reflects
 * the violation moving from "active" to "mitigated."
 */
export async function applyRoleSodMitigation(roleId, { items, expiresAt, roleName } = {}) {
  if ((await getTenantSettings()).allowSodMitigations === false) {
    throw badRequest("SOD mitigations are disabled for this tenant (Evaluation Config).");
  }
  if (!Array.isArray(items) || items.length === 0) {
    throw badRequest("items is required — at least one policy violation to mitigate.");
  }
  if (!expiresAt || Number.isNaN(Date.parse(expiresAt))) {
    throw badRequest("A valid expiresAt date is required.");
  }
  const appliedAt = new Date().toISOString();
  const me = await currentUser();
  for (const it of items) {
    if (!it.policyId) continue;
    await addSodMitigation({
      id: `sodmit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      roleId,
      roleName: roleName || null,
      policyId: it.policyId,
      policyName: it.policyName || null,
      dimensionId: it.dimensionId || null,
      dimensionName: it.dimensionName || null,
      appliedAt,
      expiresAt: new Date(expiresAt).toISOString(),
      appliedBy: me.username || null,
    });
  }
  try {
    const result = await evaluateRoleAlgorithmic(roleId);
    syncRoleIntoLatestStatsScan(roleId);
    return result;
  } catch (err) {
    console.error("[roles] sod-mitigations create: re-evaluate failed:", err.response?.data || err.message);
    throw routeError(err);
  }
}

/**
 * GET /api/roles/:id/sod-mitigations
 * Every mitigation on record for this role, active or expired.
 */
export async function listRoleSodMitigations(roleId) {
  return (await getAllSodMitigations()).filter((m) => m.roleId === roleId);
}

/**
 * DELETE /api/roles/:id/sod-mitigations/:mitigationId
 * Revokes a mitigation early — the violation goes back to being flagged as
 * active on the next evaluation. Returns the freshly re-evaluated role.
 */
export async function removeRoleSodMitigation(roleId, mitigationId) {
  await removeSodMitigation(mitigationId);
  try {
    const result = await evaluateRoleAlgorithmic(roleId);
    syncRoleIntoLatestStatsScan(roleId);
    return result;
  } catch (err) {
    console.error("[roles] sod-mitigations delete: re-evaluate failed:", err.response?.data || err.message);
    throw routeError(err);
  }
}

// ─── Role Composition (Role > Composition tab) ───────────────────────────────
// One picture of a role against the people it actually covers: who matches the
// membership rule, which Common Access roles are in scope, and — for the base
// role and each dimension — how common every entitlement is among that
// population, split into what the role already grants ("included") and what its
// people hold that it doesn't ("excluded").
//
// Everything comes from ONE scan of the identities index (each document carries
// its `attributes` for rule matching and its `access` array for what it holds),
// so base and dimension populations are all cut from the same snapshot and
// their percentages are comparable. Roles in this app are built from
// entitlements, so "access items" here are entitlements.

/**
 * Pure commonality maths for one level (base role or a dimension).
 *   members:      [{ entIds: Set<string> }]  (the level's population)
 *   includedIds:  ids the level currently grants
 *   info:         Map<id, { name, source: { id, name } | null }>
 *   flagsFor(id): extra per-item flags (inCommonAccess, inBase, inDimensions)
 * -> { memberCount, included: [...], excluded: [...] } — each item
 *    { id, name, source, holders, percent, holderIdx, ...flags }, where
 *    holderIdx indexes into `members`. percent is of THIS level's members.
 */
function summarizeCompositionLevel(members, includedIds, info, flagsFor = () => ({})) {
  const holdersOf = new Map(); // entId -> [member index]
  members.forEach((m, i) => {
    for (const id of m.entIds) {
      if (!holdersOf.has(id)) holdersOf.set(id, []);
      holdersOf.get(id).push(i);
    }
  });
  const n = members.length;
  const item = (id) => {
    const holderIdx = holdersOf.get(id) || [];
    const meta = info.get(id) || {};
    return {
      id,
      name: meta.name || id,
      source: meta.source || null,
      holders: holderIdx.length,
      percent: n > 0 ? Math.round((holderIdx.length / n) * 1000) / 10 : 0,
      holderIdx,
      ...flagsFor(id),
    };
  };
  const includedSet = new Set(includedIds);
  const byCommonality = (a, b) => b.percent - a.percent || String(a.name).localeCompare(String(b.name));
  const included = [...includedSet].map(item).sort(byCommonality);
  const excluded = [...holdersOf.keys()].filter((id) => !includedSet.has(id)).map(item).sort(byCommonality);
  return { memberCount: n, included, excluded };
}

/** Everyone the role's membership covers, each with attributes (for dimension rules) and the entitlements they hold. */
async function scanRolePopulationWithAccess(membership) {
  const members = [];
  const info = new Map(); // entId -> { name, source }
  const take = (doc) => {
    const attrs = doc.attributes || {};
    const entIds = new Set();
    for (const a of doc.access || []) {
      if (a.type !== "ENTITLEMENT" || !a.id) continue;
      entIds.add(a.id);
      if (!info.has(a.id)) info.set(a.id, { name: a.displayName || a.name || a.id, source: a.source?.id ? { id: a.source.id, name: a.source.name || null } : null });
    }
    members.push({
      id: doc.id,
      displayName: attrs.displayName || doc.displayName || doc.name,
      email: doc.email || attrs.email || null,
      jobTitle: attrs.jobTitle || null,
      department: attrs.department || null,
      manager: doc.manager?.name || null,
      lifecycleState: attrs.cloudLifecycleState || null,
      attrs,
      entIds,
    });
  };
  const includes = ["id", "name", "displayName", "email", "manager", "attributes", "access"];
  const search = (body) => withApiRetry(
    () => iscPost("/v2026/search", body, { params: { limit: ROLE_EVAL_IDENTITY_PAGE_SIZE } }),
    { label: "role composition: identity scan" }
  );

  let scanned = 0;
  let truncated = false;
  if (membership?.criteria) {
    let searchAfter = null;
    while (true) {
      if (scanned >= ROLE_MEMBERS_MAX_SCANNED) { truncated = true; break; }
      const body = { indices: ["identities"], query: { query: "*" }, sort: ["id"], queryResultFilter: { includes } };
      if (searchAfter) body.searchAfter = searchAfter;
      const page = (await search(body)) || [];
      if (page.length === 0) break;
      for (const doc of page) {
        const attrs = doc.attributes || {};
        if (attrs.identityState !== "ACTIVE") continue;
        if (identityMatchesCriteria(membership.criteria, attrs)) take(doc);
      }
      scanned += page.length;
      if (page.length < ROLE_EVAL_IDENTITY_PAGE_SIZE) break;
      searchAfter = [page[page.length - 1].id];
    }
  } else {
    // An explicit identity list: look those people up directly.
    const ids = (membership?.identities || []).map((i) => i.id).filter((id) => /^[A-Za-z0-9-]+$/.test(String(id)));
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const body = { indices: ["identities"], query: { query: `id:(${chunk.map((id) => `"${id}"`).join(" OR ")})` }, sort: ["id"], queryResultFilter: { includes } };
      for (const doc of (await search(body)) || []) take(doc);
      scanned += chunk.length;
    }
  }
  members.sort((a, b) => String(a.displayName || "").localeCompare(String(b.displayName || "")));
  return { members, info, scanned, truncated };
}

/**
 * Names and sources for entitlement ids the scan never saw (nobody in the
 * population holds them). "Missing" means no SOURCE yet: a role's own
 * entitlement refs give a name but never a source, and the screen groups by
 * source, so a name-only placeholder is looked up and overwritten too.
 */
export async function fillMissingEntitlementInfo(ids, info) {
  const missing = ids.filter((id) => !info.get(id)?.source && /^[A-Za-z0-9-]+$/.test(String(id)));
  for (let i = 0; i < missing.length; i += 100) {
    const chunk = missing.slice(i, i + 100);
    try {
      const found = await withApiRetry(
        () => iscPost(
          "/v2026/search",
          { indices: ["entitlements"], query: { query: `id:(${chunk.map((id) => `"${id}"`).join(" OR ")})` }, queryResultFilter: { includes: ["id", "name", "displayName", "source.id", "source.name"] } },
          { params: { limit: 250 } }
        ),
        { label: "role composition: entitlement lookup" }
      );
      for (const e of found || []) info.set(e.id, { name: e.displayName || e.name || e.id, source: e.source?.id ? { id: e.source.id, name: e.source.name || null } : null });
    } catch (err) {
      console.warn("[roles] composition: entitlement lookup failed:", err.response?.status || err.message);
    }
  }
}

async function buildRoleComposition(roleId) {
  const role = await iscGet(`/v2026/roles/${roleId}`);
  const dimensions = role.dimensional
    ? ((await withApiRetry(() => iscGet(`/v2026/roles/${roleId}/dimensions`, { limit: 250 }), { label: "role composition: dimensions" })) || [])
    : [];
  const settings = await getTenantSettings();
  const thresholdPercent = Number(settings.entitlementCommonalityThreshold) || 80;
  const analysis = await recordStore("schema-analysis").get(tenantKey());
  const boundaryAttributes = analysis?.roleBoundaryEnabled ? (analysis.roleBoundaryAttributes || []) : [];

  // Common Access roles in scope — and which of them grants each entitlement.
  let commonAccessWarning = null;
  let commonRoles = [];
  try {
    const summaries = await fetchCommonAccessRoleSummaries();
    commonRoles = applicableCommonAccessRoles(role.membership, summaries, roleId, boundaryAttributes);
  } catch (err) {
    commonAccessWarning = `Common Access roles couldn't be read (${routeError(err).message}), so none are shown and no item is flagged as already granted by one.`;
  }
  const commonByEnt = new Map(); // entId -> [role name]
  for (const c of commonRoles) for (const id of c.entIds) {
    if (!commonByEnt.has(id)) commonByEnt.set(id, []);
    commonByEnt.get(id).push(c.name);
  }

  const { members, info, scanned, truncated } = await scanRolePopulationWithAccess(role.membership);
  const baseIncluded = (role.entitlements || []).map((e) => e.id);
  for (const e of role.entitlements || []) if (!info.has(e.id) && e.name) info.set(e.id, { name: e.name, source: null });
  const dimIncluded = new Map(dimensions.map((d) => [d.id, (d.entitlements || []).map((e) => e.id)]));
  for (const d of dimensions) for (const e of d.entitlements || []) if (!info.has(e.id) && e.name) info.set(e.id, { name: e.name, source: null });
  await fillMissingEntitlementInfo([...new Set([...baseIncluded, ...[...dimIncluded.values()].flat()])], info);

  const baseSet = new Set(baseIncluded);
  const dimsHolding = new Map(); // entId -> [dimension name]
  for (const d of dimensions) for (const id of dimIncluded.get(d.id)) {
    if (!dimsHolding.has(id)) dimsHolding.set(id, []);
    dimsHolding.get(id).push(d.name);
  }

  const base = summarizeCompositionLevel(members, baseIncluded, info, (id) => ({
    inCommonAccess: commonByEnt.get(id) || [],
    inDimensions: dimsHolding.get(id) || [],
  }));

  const memberIndex = new Map(members.map((m, i) => [m.id, i]));
  const dimensionViews = dimensions.map((d) => {
    const dimMembers = d.membership?.criteria
      ? members.filter((m) => identityMatchesCriteria(d.membership.criteria, m.attrs))
      : members.filter((m) => (d.membership?.identities || []).some((i) => i.id === m.id));
    const level = summarizeCompositionLevel(dimMembers, dimIncluded.get(d.id), info, (id) => ({
      inCommonAccess: commonByEnt.get(id) || [],
      inBase: baseSet.has(id),
    }));
    // holderIdx is relative to the level's own members; re-point it at the
    // role-wide member list so the client needs only one roster.
    const toRoleIdx = dimMembers.map((m) => memberIndex.get(m.id));
    for (const list of [level.included, level.excluded]) for (const it of list) it.holderIdx = it.holderIdx.map((i) => toRoleIdx[i]);
    return { id: d.id, name: d.name, description: d.description || null, membership: d.membership || null, memberIdx: toRoleIdx, ...level };
  }).sort((a, b) => String(a.name).localeCompare(String(b.name)));

  return {
    role: { id: role.id, name: role.name, enabled: !!role.enabled, dimensional: !!role.dimensional, membership: role.membership || null },
    thresholdPercent,
    scanned,
    truncated,
    commonAccessWarning,
    commonAccessRoles: commonRoles.map((c) => ({ id: c.id, name: c.name, enabled: c.enabled, entitlementCount: c.entIds.size })).sort((a, b) => String(a.name).localeCompare(String(b.name))),
    // Every entitlement an in-scope Common Access role grants -> the role names.
    // The per-item flags only cover items someone holds or a level grants; an
    // item added by SEARCH may be neither, and still has to be checked against
    // Common Access.
    commonAccessByEntitlement: Object.fromEntries(commonByEnt),
    members: members.map(({ attrs, entIds, ...m }) => ({ ...m, entitlementCount: entIds.size })),
    base,
    dimensions: dimensionViews,
  };
}

/**
 * Pure: what the commonality threshold says this role should look like.
 *  - Base role: every entitlement held by >= threshold% of the role's people,
 *    except what an in-scope Common Access role already grants.
 *  - Each dimension: every entitlement held by >= threshold% of THAT dimension's
 *    people, except Common Access items and anything the (proposed) base role
 *    grants — access belongs at the highest level that justifies it, never at
 *    two.
 * Returns only the DIFFERENCE from today, each change with a plain reason:
 * { base: { add, remove }, dimensions: [{ id, name, add, remove }] }.
 */
function proposeRoleComposition(comp, thresholdPercent) {
  const T = thresholdPercent;
  const change = (it, reason, extra = {}) => ({ id: it.id, name: it.name, source: it.source, percent: it.percent, holders: it.holders, reason, ...extra });
  const isCommon = (it) => (it.inCommonAccess || []).length > 0;
  const commonNames = (it) => it.inCommonAccess.join(", ");

  const baseAll = [...comp.base.included, ...comp.base.excluded];
  const baseTarget = new Set(baseAll.filter((it) => it.percent >= T && !isCommon(it)).map((it) => it.id));
  const N = comp.base.memberCount;
  const base = {
    add: comp.base.excluded.filter((it) => baseTarget.has(it.id))
      .map((it) => change(it, `Held by ${it.holders} of ${N} members (${it.percent}%), at or above the ${T}% threshold.`)),
    remove: comp.base.included.filter((it) => !baseTarget.has(it.id))
      .map((it) => isCommon(it)
        ? change(it, `Already granted by Common Access role ${commonNames(it)} — a role shouldn't repeat it.`, { becauseCommonAccess: true })
        : change(it, `Held by only ${it.holders} of ${N} members (${it.percent}%), below the ${T}% threshold.`)),
  };

  const dimensions = comp.dimensions.map((d) => {
    const all = [...d.included, ...d.excluded];
    const target = new Set(all.filter((it) => it.percent >= T && !isCommon(it) && !baseTarget.has(it.id)).map((it) => it.id));
    const n = d.memberCount;
    return {
      id: d.id,
      name: d.name,
      memberCount: n,
      add: d.excluded.filter((it) => target.has(it.id))
        .map((it) => change(it, `Held by ${it.holders} of ${n} members of this dimension (${it.percent}%), at or above ${T}%, and not granted by the base role.`)),
      remove: d.included.filter((it) => !target.has(it.id))
        .map((it) => isCommon(it)
          ? change(it, `Already granted by Common Access role ${commonNames(it)}.`, { becauseCommonAccess: true })
          : baseTarget.has(it.id)
          ? change(it, "Granted by the base role (as proposed), so it doesn't belong on a dimension too.", { becauseBase: true })
          : change(it, `Held by only ${it.holders} of ${n} members of this dimension (${it.percent}%), below the ${T}% threshold.`)),
    };
  });
  return { base, dimensions };
}

/** GET /api/roles/:id/composition — the whole Composition picture. */
export async function getRoleComposition(roleId) {
  if (!/^[A-Za-z0-9-]+$/.test(String(roleId))) throw badRequest("Invalid role id.");
  try {
    return await buildRoleComposition(roleId);
  } catch (err) {
    console.error("[roles] composition failed:", err.response?.data || err.message);
    throw routeError(err);
  }
}

/**
 * POST /api/roles/:id/composition/suggest
 * { thresholdPercent, changeCount, proposal, smallPopulations, commonAccessWarning, ai }
 *
 * The CHANGES come from proposeRoleComposition — arithmetic against the
 * tenant's Entitlement Commonality setting, so they're reproducible and every
 * id is real. The old server also asked Claude for a review of the proposal;
 * there is no AI provider in the plugin, so `ai` carries the same "AI isn't
 * configured" message the server returned when no provider was set up. Nothing
 * is saved here.
 */
export async function suggestRoleComposition(roleId) {
  if (!/^[A-Za-z0-9-]+$/.test(String(roleId))) throw badRequest("Invalid role id.");
  try {
    const comp = await buildRoleComposition(roleId);
    const T = comp.thresholdPercent;
    const proposal = proposeRoleComposition(comp, T);
    const changeCount = proposal.base.add.length + proposal.base.remove.length +
      proposal.dimensions.reduce((n, d) => n + d.add.length + d.remove.length, 0);
    // A percentage over a handful of people isn't evidence of anything.
    const smallPopulations = [
      ...(comp.base.memberCount < ROLE_EVAL_MIN_MEMBERS_FOR_COMMONALITY ? [{ level: "Base role", memberCount: comp.base.memberCount }] : []),
      ...comp.dimensions.filter((d) => d.memberCount < ROLE_EVAL_MIN_MEMBERS_FOR_COMMONALITY).map((d) => ({ level: d.name, memberCount: d.memberCount })),
    ];

    const ai = { used: false, summary: null, cautions: [] };
    if (changeCount > 0) {
      ai.error = "AI isn't configured on this server, so the proposal below is the computed one without an AI review.";
    }

    return {
      thresholdPercent: T,
      changeCount,
      proposal,
      smallPopulations,
      commonAccessWarning: comp.commonAccessWarning,
      ai,
    };
  } catch (err) {
    console.error("[roles] composition suggest failed:", err.response?.data || err.message);
    throw routeError(err);
  }
}
