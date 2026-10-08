/**
 * ported/roleScans.js
 * Role Model Draft (peer-group discovery / role mining) — ports of
 *   POST   /api/insights/role-scans                                   (startRoleScan)
 *   GET    /api/insights/role-scans                                   (listRoleScans)
 *   GET    /api/insights/role-scans/:id                               (getRoleScan)
 *   POST   /api/insights/role-scans/:id/cancel                        (cancelRoleScan)
 *   DELETE /api/insights/role-scans/:id                               (deleteRoleScan)
 *   POST   /api/insights/role-scans/:id/groups/:groupId/create-role   (createRoleForPeerGroup)
 *   POST   /api/insights/role-scans/:id/groups/:groupId/merge-into-existing-role
 *                                                                     (mergeRoleGroupIntoExisting)
 * plus runRoleScan and its helpers (searchAllIdentities, fetchScopeIds,
 * buildPeerGroups, ...), which the old server shared with Schema Analysis and
 * the DL/Skeleton scans.
 *
 * Groups identities that hold near-identical entitlement sets, names each
 * group from its members' most common department + location, and can
 * provision a real requestable Role from the access every member shares — so
 * a new hire who matches the peer group gets the common items in one grant.
 *
 * Records live in the tenant-namespaced "role-scans" store with the server's
 * exact record shape (the Role Model Draft pages poll scanned /
 * totalIdentities / entitlementFetchFailures / status / groups). The scan
 * runner keeps going while the tab is open, exactly like the server's async
 * runner did; a "running" record left behind by a reload shows as failed the
 * next time the store is read (see scanJobs.failInterrupted).
 */

import { iscGet, iscPost, withApiRetry, badRequest, describeError } from "../isc";
import { recordStore } from "../store";
import { applyRoleNaming } from "../roleNaming";
import {
  tenantKey,
  mapWithConcurrency,
  getTenantSettings,
  DEFAULT_TENANT_SETTINGS,
  PEER_GROUP_STATUS_ATTRIBUTE_KEYS,
  extractAllIdentityEqualsLeaves,
  criteriaLeavesSubsetOf,
  commonlyHeldEntitlementIds,
  resolveEntitlementDisplayInfo,
  ROLE_SCAN_COMMON_THRESHOLD,
} from "./roleShared";
import { fetchCommonAccessRoleSummaries, enableRoleCommonAccess } from "./roleCommonAccess";
import { patchRoleEntitlements } from "./roleDimensions";
import { evaluateRoleAlgorithmic } from "./roleEvaluation";
import { ensureRoleSegmentMetadata } from "./metadataTagging";
import { startJob, patchRecord, failInterrupted, requestCancel, isCancelled, newScanId } from "./scanJobs";

const STORE = "role-scans";
const roleScans = () => recordStore(STORE);

async function updateRoleScan(scanId, patch) {
  return patchRecord(STORE, scanId, patch);
}

// ─── Shared Insights helpers ──────────────────────────────────────────────────

/**
 * Pages through every identity matching `query` (default "*" = every
 * identity) via SailPoint's searchAfter cursor pagination against the
 * Search API's identities index — the only way to page an
 * Elasticsearch-backed index past its 10,000-record offset+limit window.
 *
 * Normalizes each Search identity document into the exact shape
 * /v2026/public-identities returns, so every caller (the
 * attrs.find(a => a.key === X)?.value || "Unknown" pattern used throughout)
 * works unchanged:
 *  - Search's own top-level `name` is the USERNAME — `displayName` is the
 *    real display name (public-identities' own `name`).
 *  - public-identities' `status`/`identityState` line up with Search's
 *    `attributes.cloudLifecycleState`/`attributes.identityState`.
 *  - `attributes` is restricted to public-identities' 5 fixed keys.
 *
 * onPage(normalizedPage, totalSoFar), if given, runs after each page is
 * normalized — return `false` from it to stop paging early (cancellation).
 * includeAccess: true also requests each identity's full `access` array and
 * narrows the response via queryResultFilter, so a caller like Role Scan can
 * read every member's held entitlements straight off the page it already
 * fetched instead of a separate per-identity REST call for each one.
 */
const PUBLIC_IDENTITY_ATTRIBUTE_KEYS = ["manager", "jobTitle", "department", "country", "location"];

export async function searchAllIdentities({ query = "*", pageSize = 250, onPage, includeAccess = false, accessTypes = null } = {}) {
  const identities = [];
  let searchAfter = null;
  while (true) {
    const body = { indices: ["identities"], query: { query }, sort: ["id"] };
    if (searchAfter) body.searchAfter = searchAfter;
    if (includeAccess || accessTypes) {
      body.queryResultFilter = { includes: ["id", "name", "displayName", "email", "manager", "attributes", "access"] };
    }
    const page = await withApiRetry(
      () => iscPost("/v2026/search", body, { params: { limit: pageSize } }),
      { label: "searchAllIdentities: search page" }
    );
    const docs = Array.isArray(page) ? page : [];
    if (docs.length === 0) break;
    const normalizedPage = docs.map((doc) => {
      const attrsMap = doc.attributes || {};
      const normalized = {
        id: doc.id,
        name: doc.displayName || doc.name,
        email: doc.email || null,
        status: attrsMap.cloudLifecycleState || null,
        identityState: attrsMap.identityState || null,
        manager: doc.manager ? { id: doc.manager.id, name: doc.manager.name } : null,
        attributes: PUBLIC_IDENTITY_ATTRIBUTE_KEYS.map((key) => ({ key, value: attrsMap[key] ?? null })),
      };
      if (accessTypes) {
        const wanted = new Set(accessTypes);
        normalized.access = (doc.access || [])
          .filter((a) => wanted.has(a.type))
          .map((a) => ({ id: a.id, type: a.type, name: a.displayName || a.name, source: a.source?.name || null, sourceId: a.source?.id || null }));
      } else if (includeAccess) {
        normalized.access = (doc.access || [])
          .filter((a) => a.type === "ENTITLEMENT")
          .map((e) => ({ id: e.id, name: e.name }));
      }
      return normalized;
    });
    identities.push(...normalizedPage);
    if (onPage) {
      const keepGoing = await onPage(normalizedPage, identities.length);
      if (keepGoing === false) break;
    }
    if (docs.length < pageSize) break;
    searchAfter = [docs[docs.length - 1].id];
  }
  return identities;
}

/**
 * Every id matching a raw ISC Search `query` against `indices`, paged via
 * searchAfter (offset paging hard-fails past 10,000). Returns null for an
 * empty/whitespace query, meaning "no scope" — callers should treat that as
 * "don't filter" rather than "matches nothing."
 */
export async function fetchScopeIds(indices, query) {
  if (!query || !query.trim()) return null;
  const ids = new Set();
  let searchAfter = null;
  const pageSize = 250;
  while (true) {
    const body = { indices, query: { query }, sort: ["id"] };
    if (searchAfter) body.searchAfter = searchAfter;
    const page = await withApiRetry(
      () => iscPost("/v2026/search", body, { params: { limit: pageSize } }),
      { label: "fetchScopeIds: search page" }
    );
    const docs = Array.isArray(page) ? page : [];
    for (const doc of docs) ids.add(doc.id);
    if (docs.length < pageSize) break;
    searchAfter = [docs[docs.length - 1].id];
  }
  return ids;
}

/** Canonical, order-independent key for a set of {attrKey, value} pairs, for exact-set comparison. */
function criteriaSetKey(leaves) {
  return leaves
    .map((l) => `${l.attrKey}=${l.value}`)
    .sort()
    .join("|");
}

// ─── Role Insight: peer-group discovery ──────────────────────────────────────

const ROLE_SCAN_IDENTITY_PAGE_SIZE = 250; // SailPoint's documented max page size

// Identity attributes used to define peer groups, when no Schema Analysis
// has been run for the tenant yet (see getRoleScanAttributeKeys below).
// Status/lifecycle-type attributes are excluded on purpose: active/disabled
// is handled separately as the always-on lifecycleState-ACTIVE criterion
// (see createRoleForPeerGroup), not as a peer-grouping dimension.
export const DEFAULT_PEER_GROUP_ATTRIBUTE_KEYS = ["department", "location"]
  .filter((k) => !PEER_GROUP_STATUS_ATTRIBUTE_KEYS.has(k));

// The attribute keys a role scan should bucket by: Schema Analysis's chosen
// top attributes for this tenant if it's been run, otherwise the
// department/location default. Computed once per scan and persisted on the
// scan record (see startRoleScan) so a later create-role call uses the exact
// same keys the scan actually grouped by, even if Schema Analysis is re-run
// or re-ordered in between.
export async function getRoleScanAttributeKeys() {
  const configured = ((await recordStore("schema-analysis").get(tenantKey()))?.topAttributes || [])
    .filter((k) => !PEER_GROUP_STATUS_ATTRIBUTE_KEYS.has(k));
  return configured.length > 0 ? configured : DEFAULT_PEER_GROUP_ATTRIBUTE_KEYS;
}

// Entitlements come bundled on each identity's own Search API document (see
// searchAllIdentities's includeAccess option) instead of a separate
// per-identity REST call — a page that fails is retried as a whole by
// searchAllIdentities's own withApiRetry.
function buildIdentityRoleProfileFromAccess(idn, attributeKeys) {
  const attrs = {};
  for (const key of attributeKeys) {
    attrs[key] = idn.attributes?.find((a) => a.key === key)?.value || "Unknown";
  }
  return {
    id: idn.id,
    name: idn.name,
    email: idn.email || null,
    managerName: idn.manager?.name || null,
    attrs,
    entitlements: idn.access || [],
    entitlementsFailed: false,
  };
}

// Mining Config's Scope field is a raw ISC Search query (arbitrary Lucene),
// used as-is against the Search API to narrow which identities a scan
// considers (see fetchScopeIds). A role's own membership criteria can't
// express arbitrary Lucene, though — only a structured tree of IDENTITY
// attribute EQUALS leaves. Only the common case (a single attribute=value
// equality, however it's punctuated — "attributes.key:value" or
// "key=value.") can be translated; anything else isn't supported and the
// Common Access proposal falls back rather than guessing.
// Identity attribute keys are case-sensitive in ISC's own criteria schema,
// but a scope typed by hand isn't guaranteed to match that casing — only
// worth normalizing the one key this app actually defaults Scope to.
const KNOWN_IDENTITY_ATTRIBUTE_KEYS = ["cloudLifecycleState"];
function normalizeScopeAttrKey(attrKey) {
  const known = KNOWN_IDENTITY_ATTRIBUTE_KEYS.find((k) => k.toLowerCase() === attrKey.toLowerCase());
  return known || attrKey;
}

export function parseSimpleScopeCriteria(scopeQuery) {
  if (!scopeQuery || !scopeQuery.trim()) return null;
  const match = scopeQuery.trim().match(/^(?:attributes\.)?([\w.]+)\s*[:=]\s*"?([^".]+?)"?\.?$/i);
  if (!match) return null;
  return { attrKey: normalizeScopeAttrKey(match[1]), value: match[2] };
}

/**
 * Buckets profiles by the exact-match combination of every boundaryKey's
 * value (all keys together — a Multi-Company/Division Boundary of
 * [company, division] partitions by the (company, division) pair). Profiles
 * missing any boundary key's value are left out of every partition.
 */
function partitionProfilesByBoundary(profiles, boundaryKeys) {
  const buckets = new Map();
  for (const p of profiles) {
    const values = boundaryKeys.map((k) => p.attrs[k]);
    if (values.some((v) => !v || v === "Unknown")) continue;
    const key = values.join("||");
    if (!buckets.has(key)) buckets.set(key, { values, profiles: [] });
    buckets.get(key).profiles.push(p);
  }
  return [...buckets.values()];
}

/** All non-empty subsets of `keys`, e.g. [a,b] -> [[a],[b],[a,b]]. */
function nonEmptySubsets(keys) {
  const subsets = [];
  for (let mask = 1; mask < 1 << keys.length; mask++) {
    const subset = keys.filter((_, i) => mask & (1 << i));
    subsets.push(subset);
  }
  return subsets;
}

// Within a tier of equal-size combinations, department+location is tried
// before any other pair (e.g. department+jobTitle).
const PREFERRED_2ATTR_PAIR = ["department", "location"];
function comboPreferenceScore(combo) {
  return combo.length === 2 && PREFERRED_2ATTR_PAIR.every((k) => combo.includes(k)) ? 1 : 0;
}

/**
 * Buckets identities into peer groups by exact match on some combination of
 * `attributeKeys`, then — within each bucket — narrows to the entitlements
 * every member shares. EVERY bucket becomes a group: no minimum size, and
 * no requirement that its members share any access at all. A group with
 * empty commonAccess simply produces a membership-only role.
 *
 * With createDynamicRoles on, tries the BROADEST combination first (a single
 * shared attribute, e.g. just department) up to the most specific (all
 * attributes matching), so that members who share one attribute but vary on
 * the others are combined into one group — becoming a Dynamic role with a
 * dimension per varying attribute. A more specific combination is only tried
 * for members left over once a broader one didn't claim them at all.
 *
 * With createDynamicRoles off, only the single most-specific combination
 * (every attribute together) is tried — one group per unique combination of
 * values across all selected attributes, so every group becomes a plain
 * (Standard) role.
 */
export function buildPeerGroups(profiles, attributeKeys, createDynamicRoles = true, commonRoleEntIds = new Set(), commonalityThreshold = ROLE_SCAN_COMMON_THRESHOLD) {
  const combos = createDynamicRoles
    ? nonEmptySubsets(attributeKeys).sort((a, b) => {
        if (a.length !== b.length) return a.length - b.length;
        return comboPreferenceScore(b) - comboPreferenceScore(a);
      })
    : [attributeKeys];

  const assigned = new Set();
  const groups = [];
  let groupCounter = 0;

  for (const comboKeys of combos) {
    const buckets = new Map();
    for (const p of profiles) {
      if (assigned.has(p.id)) continue;
      const values = comboKeys.map((k) => p.attrs[k]);
      if (values.some((v) => v === "Unknown")) continue;
      const key = values.join("||");
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(p);
    }

    for (const members of buckets.values()) {
      // No minimum group size gate — a peer group of 1 still gets a role. A
      // solo member has no peers to compute "commonly held" from, so their
      // own actual entitlements are used directly instead.
      //
      // Membership uses every member — a department or title is real
      // regardless of how sparse its access is. The entitlement-commonality
      // math, though, excludes members holding EXACTLY one entitlement (a
      // test/service account's single trivial shared entitlement otherwise
      // gets proposed for the whole group) AND members holding ZERO (a
      // brand-new identity that hasn't been provisioned yet is not evidence
      // that access ISN'T commonly held). Doesn't apply to a solo member.
      let commonSig;
      if (members.length === 1) {
        commonSig = new Set(members[0].entitlements.map((e) => e.id));
      } else {
        const eligibleForProposal = members.filter((m) => m.entitlements.length > 1);
        commonSig = commonlyHeldEntitlementIds(eligibleForProposal, commonalityThreshold);
      }
      // Entitlements every member shares only because a common-access role
      // already grants them to everyone don't belong on a purpose-built
      // peer-group role — they're birthright access.
      commonSig = new Set([...commonSig].filter((id) => !commonRoleEntIds.has(id)));
      for (const m of members) assigned.add(m.id);
      const attributeCriteria = comboKeys.map((key) => ({ key, value: members[0].attrs[key] }));
      // commonSig is a threshold, not a strict intersection, so a
      // held-by-most-but-not-all entitlement may be missing from any one
      // member — resolve names from whichever member actually has each one.
      const groupNameById = new Map();
      for (const m of members) for (const e of m.entitlements) groupNameById.set(e.id, e.name);

      // Work out now what each dimension would grant, so the UI can show it
      // before anyone commits to creating the role. A dimension's
      // entitlements are those every member sharing that value holds, minus
      // what the base role already grants.
      const varyingKeys = attributeKeys.filter((k) => !comboKeys.includes(k));
      // Every distinct value `key` takes among identities who actually share
      // THIS group's own comboKeys values — scanned from the full population
      // (not just this bucket's own `members`) so a value doesn't disappear
      // from the domain just because its only holder was assigned elsewhere.
      const peersInScope = profiles.filter((p) =>
        attributeCriteria.every(({ key: ck, value: cv }) => p.attrs[ck] === cv)
      );
      const dimensionPreview = [];
      for (const key of varyingKeys) {
        const values = [...new Set(peersInScope.map((p) => p.attrs[key]).filter((v) => v && v !== "Unknown"))];
        for (const value of values) {
          const subs = members.filter((m) => m.attrs[key] === value);
          // Same split as the base role's commonSig above: memberCount
          // reflects everyone sharing this dimension value, but only members
          // with more than one entitlement feed the proposal.
          const shared = commonlyHeldEntitlementIds(subs.filter((m) => m.entitlements.length > 1), commonalityThreshold);
          const nameById = new Map();
          for (const m of subs) for (const e of m.entitlements) nameById.set(e.id, e.name);
          dimensionPreview.push({
            attribute: key,
            value,
            memberCount: subs.length,
            entitlements: [...shared]
              .filter((id) => !commonSig.has(id) && !commonRoleEntIds.has(id))
              .map((id) => ({ id, name: nameById.get(id) })),
          });
        }
      }

      // "Dynamic Peer Group" is only earned once a role — and its dimensions
      // — actually exist (see the default name in createRoleForPeerGroup);
      // at scan time no role exists yet, so the group itself stays plain.
      groupCounter += 1;
      groups.push({
        id: `group_${groupCounter}`,
        name: `${attributeCriteria.map((c) => c.value).join(" ")} Peer Group`,
        attributeCriteria,
        members: members.map((m) => ({
          id: m.id,
          name: m.name,
          email: m.email,
          managerName: m.managerName,
          ...m.attrs,
          entitlementCount: m.entitlements.length,
        })),
        commonAccess: [...commonSig].map((id) => ({ id, name: groupNameById.get(id) })),
        dimensionPreview,
        roleCreated: null,
      });
    }
  }
  return groups;
}

async function runRoleScan(scanId) {
  // Locked in when the scan was created (see startRoleScan) so it stays
  // consistent even if Schema Analysis is re-run, re-ordered, or the
  // Create Dynamic Roles / Scope / Boundary settings change mid-scan.
  const scanConfig = await roleScans().get(scanId);
  const attributeKeys = scanConfig.attributeKeys;
  const createDynamicRoles = scanConfig.createDynamicRoles;
  const entitlementCommonalityThreshold = scanConfig.entitlementCommonalityThreshold;
  const scopeQuery = scanConfig.scopeQuery;
  // Multi-Company/Division Boundary — when on, the scan runs its full
  // pipeline once per distinct combination of these attributes' values
  // instead of once across the whole scope.
  const roleBoundaryEnabled = scanConfig.roleBoundaryEnabled;
  const roleBoundaryAttributes = scanConfig.roleBoundaryAttributes || [];
  // Profiles need boundary attribute values too (to partition by), on top of
  // the peer-group attributeKeys — only when boundary is actually on.
  const profileAttributeKeys = roleBoundaryEnabled && roleBoundaryAttributes.length > 0
    ? [...new Set([...attributeKeys, ...roleBoundaryAttributes])]
    : attributeKeys;
  try {
    const scopeIds = await fetchScopeIds(["identities"], scopeQuery);

    const profiles = [];
    let entitlementFetchFailures = 0;

    // No built-in "active identities only" filter here — which identities
    // qualify is entirely up to the tenant's Role Scan Scope setting
    // (scopeIds). Paginated via searchAllIdentities (searchAfter, not
    // offset) — a tenant's identity count can exceed 10,000.
    await searchAllIdentities({
      pageSize: ROLE_SCAN_IDENTITY_PAGE_SIZE,
      includeAccess: true,
      onPage: async (identities, totalScanned) => {
        if (isCancelled(STORE, scanId)) return false;

        // scopeIds is null when no Role Scan Scope is configured — every
        // identity qualifies in that case.
        const pageProfiles = identities
          .filter((idn) => !scopeIds || scopeIds.has(idn.id))
          .map((idn) => buildIdentityRoleProfileFromAccess(idn, profileAttributeKeys));
        entitlementFetchFailures += pageProfiles.filter((p) => p.entitlementsFailed).length;
        // Every identity in scope counts toward Roles and Dimensions — a
        // brand-new department or title with no (or sparse) entitlements yet
        // must still be visible to the scan. A failed entitlement fetch IS
        // still excluded — it isn't a real "zero entitlements" identity.
        profiles.push(...pageProfiles.filter((p) => !p.entitlementsFailed));

        await updateRoleScan(scanId, {
          scanned: totalScanned,
          totalIdentities: totalScanned,
          entitlementFetchFailures,
        });
      },
    });

    if (isCancelled(STORE, scanId)) {
      await updateRoleScan(scanId, { status: "cancelled", completedAt: new Date().toISOString() });
      return;
    }

    // Every confirmed common-access role's own criteria + entitlements, same
    // summaries Role Evaluation fetches — used below to find which existing
    // common-access roles' criteria actually applies to a given partition's
    // scope. Retried, and the scan itself is flagged
    // (commonAccessExclusionFailed) so the gap is visible instead of silent
    // if every attempt still fails.
    let commonAccessSummaries = [];
    let commonAccessExclusionFailed = false;
    try {
      commonAccessSummaries = await withApiRetry(
        () => fetchCommonAccessRoleSummaries(),
        { label: `role scan ${scanId}: fetch common-access role summaries` }
      );
    } catch (err) {
      // Common-access is a beta API — if it's unavailable on this tenant,
      // scanning should still work, just without this particular filter.
      console.error(`[insights] role scan ${scanId}: failed to fetch common-access entitlements after retries:`, err.response?.data || err.message);
      commonAccessExclusionFailed = true;
    }

    // Locked in at scan start so a later Configuration change never
    // retroactively changes an already-running or already-reported scan.
    const allowDuplicateRoles = (await roleScans().get(scanId)).allowDuplicateRoles;

    const commonalityThreshold = (entitlementCommonalityThreshold ?? 80) / 100;
    const scopeCriteria = parseSimpleScopeCriteria(scopeQuery);
    const settingsForNaming = await getTenantSettings();

    // Every existing role's membership criteria, keyed for exact-set
    // comparison — built once, used twice: below, to make sure the Common
    // Access proposal for each partition never duplicates a role that
    // already has that exact scope+boundary criteria, and after the
    // partition loop, for peer groups' own existing-role check. A failure
    // here isn't fatal to the scan — it just means neither check can flag
    // anything this run (rolesByCriteriaKey stays empty).
    let rolesByCriteriaKey = new Map();
    try {
      // Paginated (a tenant easily clears 250 roles) and retried, same as
      // Role Evaluation's own roles-list fetch.
      let offset = 0;
      while (true) {
        const pageOffset = offset;
        const page = await withApiRetry(
          () => iscGet("/v2026/roles", { limit: 250, offset: pageOffset, sorters: "name" }),
          { label: `role scan ${scanId}: existing-roles page` }
        );
        if (!Array.isArray(page) || page.length === 0) break;
        for (const r of page) {
          const leaves = extractAllIdentityEqualsLeaves(r.membership?.criteria);
          if (leaves.length === 0) continue;
          const key = criteriaSetKey(leaves);
          if (!rolesByCriteriaKey.has(key)) {
            rolesByCriteriaKey.set(key, { id: r.id, name: r.name, enabled: !!r.enabled });
          }
        }
        offset += page.length;
        if (page.length < 250) break;
      }
    } catch (err) {
      console.error(`[insights] role scan ${scanId}: existing-roles fetch failed:`, err.response?.data || err.message);
    }

    // With Multi-Company/Division Boundary off, this is exactly one
    // "partition" covering the whole scope, with no extra criteria. With it
    // on, one partition per distinct combination of the boundary attributes'
    // values, each running the exact same pipeline below independently.
    const partitions = roleBoundaryEnabled && roleBoundaryAttributes.length > 0
      ? partitionProfilesByBoundary(profiles, roleBoundaryAttributes)
      : [{ values: [], profiles }];

    let groups = [];
    for (const partition of partitions) {
      // Gated on the same condition `partitions` itself used above — with
      // Boundary off, mapping roleBoundaryAttributes unconditionally produced
      // a leaf with value: undefined for each stored-but-unused boundary
      // attribute, which SailPoint rejects on role creation.
      const boundaryLeaves = roleBoundaryEnabled && roleBoundaryAttributes.length > 0
        ? roleBoundaryAttributes.map((key, i) => ({ key, value: partition.values[i], isBoundary: true }))
        : [];

      /*
       * First task of this partition: propose a "Common Access" role for it
       * — Standard, common-access flagged. Its entitlements are whatever's
       * held by at least the tenant's own commonality threshold of the
       * partition, which may end up empty — an empty-entitlement Common
       * Access role is still proposed.
       *
       * Allow Duplicates governs this differently than it governs peer
       * groups:
       *   - ON: always propose a brand new Common Access role for this
       *     scope. Only ITS OWN entitlements are excluded from this
       *     partition's peer groups.
       *   - OFF: find every ACTIVE common-access role whose own membership
       *     is a superset of this scope and exclude the union of THEIR
       *     entitlements instead. If none match, a new one is proposed
       *     exactly as in the ON case.
       */
      let commonAccessGroup = null;
      let partitionCommonRoleEntIds = new Set();
      try {
        if (partition.profiles.length > 0) {
          const attributeCriteria = [
            ...(scopeCriteria ? [{ key: scopeCriteria.attrKey, value: scopeCriteria.value }] : []),
            ...boundaryLeaves,
          ];
          // Exactly ONE Common Access proposal always exists per partition.
          // Boundary off with no parseable Role Scan Scope falls back to
          // cloudLifecycleState = active, the scope setting's own default,
          // since a Standard role can't be created with no criteria at all.
          if (attributeCriteria.length === 0) {
            attributeCriteria.push({ key: "cloudLifecycleState", value: "active" });
          }
          if (attributeCriteria.length > 0) {
            // Computed from partition.profiles — the scan's own complete,
            // already-fetched population for this exact partition (same data
            // buildPeerGroups uses) — so this can never disagree with the
            // peer groups it's meant to be excluded from.
            const eligibleForCommonAccess = partition.profiles.filter((p) => p.entitlements.length > 1);
            const scopeCommonEntIds = commonlyHeldEntitlementIds(eligibleForCommonAccess, commonalityThreshold);
            const boundaryNamePart = boundaryLeaves.map((l) => l.value).join(" ");
            // This partition's own scope in the {attrKey, value} shape
            // criteriaLeavesSubsetOf expects.
            const scopeLeaves = attributeCriteria.map(({ key, value }) => ({ attrKey: key, value }));
            const newCommonAccessGroup = () => ({
              id: `common_access_scope_${groups.length}`,
              // "Common Access" sits right before the suffix (boundary
              // value(s), if any, come first — right after the prefix).
              name: applyRoleNaming(
                [boundaryNamePart, "Common Access"].filter(Boolean).join(" - "),
                settingsForNaming.rolePrefix, settingsForNaming.roleSuffix
              ),
              attributeCriteria,
              members: partition.profiles.map((p) => ({
                id: p.id, name: p.name, email: p.email, managerName: p.managerName,
                ...p.attrs, entitlementCount: p.entitlements.length,
              })),
              commonAccess: [...scopeCommonEntIds].map((id) => ({ id, name: null })),
              dimensionPreview: [],
              roleCreated: null,
              existingRole: null,
              isCommonAccessScope: true,
            });

            // With a boundary set, a subset-of-scope match alone isn't
            // enough: reuse is only valid when the candidate's own criteria
            // pins every boundary attribute to exactly this partition's
            // values.
            const boundaryKeySet = new Set(roleBoundaryAttributes);
            const matchingSummaries = allowDuplicateRoles
              ? []
              : commonAccessSummaries.filter((s) => {
                  if (!criteriaLeavesSubsetOf(s.criteriaLeaves, scopeLeaves)) return false;
                  if (boundaryKeySet.size === 0) return true;
                  const existingBoundaryLeaves = s.criteriaLeaves.filter((l) => boundaryKeySet.has(l.attrKey));
                  if (existingBoundaryLeaves.length !== boundaryKeySet.size) return false;
                  return boundaryLeaves.every((bl) =>
                    existingBoundaryLeaves.some((el) => el.attrKey === bl.key && el.value === bl.value)
                  );
                });

            if (matchingSummaries.length > 0) {
              // Defer to what's already covering this scope — don't propose
              // a duplicate. Every matching role's entitlements are excluded
              // (not just the first), even though only one can be shown as
              // "the" existing role here.
              partitionCommonRoleEntIds = new Set(matchingSummaries.flatMap((s) => [...s.entIds]));
              commonAccessGroup = {
                id: `common_access_scope_${groups.length}`,
                name: matchingSummaries[0].name,
                attributeCriteria,
                members: [],
                commonAccess: [],
                dimensionPreview: [],
                roleCreated: null,
                existingRole: { id: matchingSummaries[0].id, name: matchingSummaries[0].name, enabled: true },
                isCommonAccessScope: true,
              };
            } else {
              commonAccessGroup = newCommonAccessGroup();
              if (scopeCommonEntIds.size > 0) {
                // Every peer group in this partition excludes this — it's
                // birthright access this new role will grant everyone in the
                // partition. Scoped to this partition only.
                partitionCommonRoleEntIds = scopeCommonEntIds;
              }
            }
          }
        }
      } catch (err) {
        console.error(`[insights] role scan ${scanId}: Common Access proposal failed for partition ${boundaryLeaves.map((l) => l.value).join("/")}:`, err.response?.data || err.message);
      }

      const partitionGroups = buildPeerGroups(
        partition.profiles, attributeKeys, createDynamicRoles, partitionCommonRoleEntIds, commonalityThreshold
      );
      // buildPeerGroups assigns ids ("group_1", "group_2", ...) starting
      // fresh on every call, but every partition's groups end up in this
      // same flat `groups` array — renumbered here to stay globally unique
      // across the scan, since scan.groups[].id is how the client and
      // create-role look up a specific group afterward.
      partitionGroups.forEach((g, i) => { g.id = `group_${groups.length + i}`; });
      if (boundaryLeaves.length > 0) {
        for (const g of partitionGroups) {
          g.attributeCriteria = [...boundaryLeaves, ...(g.attributeCriteria || [])];
          g.name = `${g.attributeCriteria.map((c) => c.value).join(" ")} Peer Group`;
        }
      }
      if (commonAccessGroup) partitionGroups.unshift(commonAccessGroup);
      groups.push(...partitionGroups);
    }

    // Flag any group whose exact attribute combination already matches an
    // existing role's membership criteria, using the same rolesByCriteriaKey
    // fetched before the partition loop. A matched group is always kept in
    // the results (never dropped, regardless of allowDuplicateRoles) — with
    // duplicates off, create-role itself refuses it, but the report still
    // needs to show it so its own merge-into-existing-role action is
    // reachable.
    for (const g of groups) {
      // The Common Access scope proposal already resolved its own
      // existingRole (if any) above.
      if (g.isCommonAccessScope) continue;
      if (!g.attributeCriteria?.length) continue;
      const key = criteriaSetKey(g.attributeCriteria.map((c) => ({ attrKey: c.key, value: c.value })));
      g.existingRole = rolesByCriteriaKey.get(key) || null;
    }

    // Replace each entitlement's name (which for many sources is actually a
    // raw attribute value, not a human name) with its real name, and attach
    // its source, so the report can show "source:name". Non-fatal if it
    // fails: the report falls back to whatever the identity fetch returned.
    try {
      const allIds = groups.flatMap((g) => [
        ...g.commonAccess.map((e) => e.id),
        ...g.dimensionPreview.flatMap((d) => d.entitlements.map((e) => e.id)),
      ]);
      const infoById = await resolveEntitlementDisplayInfo(allIds);
      const relabel = (e) => {
        const info = infoById.get(e.id);
        return { ...e, name: info?.name || e.name, source: info?.source || null };
      };
      for (const g of groups) {
        g.commonAccess = g.commonAccess.map(relabel);
        g.dimensionPreview = g.dimensionPreview.map((d) => ({
          ...d,
          entitlements: d.entitlements.map(relabel),
        }));
      }
    } catch (err) {
      console.error(`[insights] role scan ${scanId}: entitlement source resolution failed:`, err.response?.data || err.message);
    }

    await updateRoleScan(scanId, {
      status: "completed",
      completedAt: new Date().toISOString(),
      groups,
      commonAccessExclusionFailed,
    });
  } catch (err) {
    console.error(`[insights] role scan ${scanId} failed:`, err.response?.data || err.message);
    await updateRoleScan(scanId, {
      status: "failed",
      completedAt: new Date().toISOString(),
      error: describeError(err),
    });
  }
}

// ─── Routes ──────────────────────────────────────────────────────────────────

/**
 * POST /api/insights/role-scans
 * Starts an asynchronous peer-group discovery scan across every identity in
 * the tenant's scope. Returns immediately with a scan ID — poll getRoleScan
 * for progress and the resulting groups.
 */
export async function startRoleScan() {
  const scanId = newScanId("rolescan");
  const startSettings = await getTenantSettings();
  const boundarySchema = await recordStore("schema-analysis").get(tenantKey());
  await updateRoleScan(scanId, {
    id: scanId,
    tenant: tenantKey(),
    status: "running",
    startedAt: new Date().toISOString(),
    completedAt: null,
    scopeQuery: startSettings.nameScope || null,
    scanned: 0,
    totalIdentities: 0,
    groups: [],
    error: null,
    attributeKeys: await getRoleScanAttributeKeys(),
    createDynamicRoles: startSettings.createDynamicRoles,
    allowDuplicateRoles: startSettings.allowDuplicateRoles,
    entitlementCommonalityThreshold: startSettings.entitlementCommonalityThreshold,
    roleBoundaryEnabled: !!boundarySchema?.roleBoundaryEnabled,
    roleBoundaryAttributes: boundarySchema?.roleBoundaryAttributes || [],
    entitlementFetchFailures: 0,
  });

  startJob(STORE, scanId, () => runRoleScan(scanId));

  return { scanId };
}

/** GET /api/insights/role-scans — list past/running role scans, newest first */
export async function listRoleScans() {
  await failInterrupted(STORE);
  return Object.values(await roleScans().all())
    .map(({ groups, ...meta }) => ({ ...meta, groupCount: groups?.length || 0 }))
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
}

async function requireRoleScan(scanId) {
  const scan = await roleScans().get(scanId);
  if (!scan) throw badRequest("Role scan not found.", 404);
  return scan;
}

/** GET /api/insights/role-scans/:id — full record including peer groups */
export async function getRoleScan(scanId) {
  await failInterrupted(STORE);
  return requireRoleScan(scanId);
}

/** POST /api/insights/role-scans/:id/cancel — stops a running peer-group scan. */
export async function cancelRoleScan(scanId) {
  await failInterrupted(STORE);
  const scan = await requireRoleScan(scanId);
  if (scan.status !== "running") {
    throw badRequest(`Scan is already ${scan.status}.`);
  }
  requestCancel(STORE, scanId);
  await updateRoleScan(scanId, { status: "cancelled", completedAt: new Date().toISOString() });
  return roleScans().get(scanId);
}

/** DELETE /api/insights/role-scans/:id — purges a past scan record. */
export async function deleteRoleScan(scanId) {
  await failInterrupted(STORE);
  const scan = await requireRoleScan(scanId);
  if (scan.status === "running") {
    throw badRequest("Cancel the scan before removing it.");
  }
  await roleScans().delete(scanId);
}

// The old create-role/merge routes reported ISC write failures with this
// precedence (detailCode, then message, then the axios message) rather than
// describeError's — kept so the toasts read the same.
function roleWriteError(err) {
  if (err?.isRouteError) return err;
  const status = err?.response?.status || 500;
  return badRequest(err?.response?.data?.detailCode || err?.response?.data?.message || err?.message, status);
}

/**
 * POST /api/insights/role-scans/:id/groups/:groupId/create-role
 * Body: { name?, description?, ownerId, ownerName }
 * Creates a real requestable SailPoint role from a peer group's common
 * entitlements, so a new member of that peer group can request the role and
 * be provisioned the same shared access in one grant.
 */
export async function createRoleForPeerGroup(scanId, groupId, { name, description, ownerId, ownerName } = {}) {
  if (!ownerId) {
    throw badRequest("ownerId is required to create a role.");
  }

  const scan = await roleScans().get(scanId);
  const group = scan?.groups?.find((g) => g.id === groupId);
  if (!group) throw badRequest("Peer group not found.", 404);
  // Current setting, not scan time — with Allow Duplicate Roles on, Mining
  // Config has already said "create whatever's asked for".
  const allowDuplicateRoles = (await getTenantSettings()).allowDuplicateRoles;
  // The report keeps duplicate groups visible (so merge-into-existing-role
  // is reachable), so this needs its own real guard.
  if (!allowDuplicateRoles && group.existingRole) {
    throw badRequest(
      `A role with this exact attribute combination already exists ("${group.existingRole.name}") — Allow Duplicate Roles is off. Merge into the existing role instead.`
    );
  }
  // No "has no common access to provision" refusal. A peer group whose
  // members share nothing is still a real combination that needs a role —
  // its access may live entirely in its dimensions, or the role may exist
  // purely as a membership-only placeholder to hang access on later.

  // Membership criteria so a new identity matching the peer group's chosen
  // attributes is automatically eligible for the role. Shape (OR wrapping an
  // AND of EQUALS leaves, values as arrays) matches SailPoint's own criteria
  // format. lifecycleState-ACTIVE is always included so the role never
  // matches a disabled/inactive identity — unless the group's own criteria
  // already covers it (the Common Access proposal's criteria includes the
  // scan's Scope itself, which is commonly cloudLifecycleState=active).
  const hasCloudLifecycleStateCriteria = (group.attributeCriteria || [])
    .some((c) => c.key.toLowerCase() === "cloudlifecyclestate");
  const criteriaChildren = [
    ...(hasCloudLifecycleStateCriteria ? [] : [{
      operation: "EQUALS",
      key: { type: "IDENTITY", property: "attribute.cloudLifecycleState", sourceId: null },
      values: ["active"],
      stringValue: null,
      children: null,
    }]),
    ...(group.attributeCriteria || []).map(({ key, value }) => ({
      operation: "EQUALS",
      key: { type: "IDENTITY", property: `attribute.${key}`, sourceId: null },
      values: [value],
      stringValue: null,
      children: null,
    })),
  ];
  const membership = criteriaChildren.length
    ? {
        type: "STANDARD",
        criteria: {
          operation: "OR",
          key: null,
          values: null,
          stringValue: null,
          children: [
            {
              operation: "AND",
              key: null,
              values: null,
              stringValue: null,
              children: criteriaChildren,
            },
          ],
        },
      }
    : undefined;

  // Every candidate attribute the group did NOT match on varies across its
  // members by definition — build the role as a SailPoint Dynamic
  // (dimensional) role using all of them as dimensions, one Dimension per
  // distinct value per attribute (independent per attribute, not a
  // cross-product). A match on every one of the scan's attribute keys has no
  // varying attributes left, so it stays a plain (simple) role instead.
  const matchedKeys = new Set((group.attributeCriteria || []).map((c) => c.key));
  const scanAttributeKeys = scan.attributeKeys || DEFAULT_PEER_GROUP_ATTRIBUTE_KEYS;
  // Uses the scan's own locked-in Create Dynamic Roles setting, not a fresh
  // Configuration lookup — with it off, the scan itself only ever grouped by
  // the full attribute combination, so varyingKeys is already empty.
  const scanCreateDynamicRoles = scan.createDynamicRoles ?? DEFAULT_TENANT_SETTINGS.createDynamicRoles;
  // The Common Access scope proposal is always Standard, regardless of the
  // scan's Create Dynamic Roles setting — its one "attribute" is the scope
  // itself, not one of the scan's peer-group attributeKeys.
  const varyingKeys = group.isCommonAccessScope
    ? []
    : scanCreateDynamicRoles
    ? scanAttributeKeys.filter((k) => !matchedKeys.has(k))
    : [];
  const isDynamic = varyingKeys.length > 0;
  const labelize = (k) => k.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());

  // The group's own name stays plain ("... Peer Group") until a role with
  // dimensions actually exists — this is where "Dynamic Peer Group" is
  // earned, as the default name of the role actually being created here.
  const defaultRoleName = isDynamic ? group.name.replace(/ Peer Group$/, " Dynamic Peer Group") : group.name;

  try {
    const rolePayload = {
      name: name || defaultRoleName,
      description: description || `Auto-generated from peer group "${group.name}" — provisions the access common to its members.`,
      owner: { type: "IDENTITY", id: ownerId, name: ownerName },
      entitlements: group.commonAccess.map((e) => ({ id: e.id, type: "ENTITLEMENT", name: e.name })),
      // Created disabled so a Role Draft never actually grants access the
      // moment it's created — someone needs to review it in ISC and enable
      // it deliberately first.
      enabled: false,
      // Dimensional roles are auto-assigned via their membership criteria,
      // not individually requestable. Common Access is birthright access
      // every in-scope identity gets automatically too — never individually
      // requestable, regardless of dimensionality.
      requestable: group.isCommonAccessScope ? false : !isDynamic,
      ...(membership ? { membership } : {}),
      ...(isDynamic
        ? {
            dimensional: true,
            accessRequestConfig: {
              dimensionSchema: {
                dimensionAttributes: varyingKeys.map((k) => ({ name: k, displayName: labelize(k), derived: true })),
              },
            },
          }
        : {}),
    };

    const role = await iscPost("/v2026/roles", rolePayload);

    // The role itself is already created at this point — a failure flagging
    // it as common access shouldn't be reported as the whole create having
    // failed, just noted so the caller knows to flag it manually in ISC's
    // own UI if this didn't succeed.
    let commonAccessFlagged = false;
    let commonAccessError = null;
    if (group.isCommonAccessScope) {
      try {
        await enableRoleCommonAccess(role.id);
        commonAccessFlagged = true;
      } catch (caErr) {
        console.error(`[insights] create-role: common-access flag failed for role ${role.id}:`, caErr.response?.data || caErr.message);
        commonAccessError = describeError(caErr);
      }

      // Reconcile with a live evaluation right after creation. The scan's
      // own commonAccess computation (at proposal time) and Role
      // Evaluation's own commonly-held-but-not-granted check can disagree;
      // Evaluation's check is the one already trusted everywhere else in
      // this app, so it's used here as the final authority on what a
      // freshly-created Common Access role should grant, applied
      // immediately rather than left for someone to notice later.
      try {
        const evaluation = await evaluateRoleAlgorithmic(role.id);
        const missing = evaluation.addCandidates || [];
        if (missing.length > 0) {
          const updated = await patchRoleEntitlements(role.id, {
            add: missing.map((c) => ({ id: c.entitlementId, name: c.entitlement })),
          });
          role.entitlements = updated.entitlements;
          // group.commonAccess is what the scan report itself shows for this
          // group, and what baseEntIds (below) is built from — both need to
          // reflect what the role actually ended up with after reconciling.
          group.commonAccess = updated.entitlements.map((e) => ({ id: e.id, name: e.name }));

          // The reconciled additions are birthright access every identity
          // in this partition now gets automatically — every sibling peer
          // group's own base/dimension entitlements need to drop them too,
          // or a peer group created afterward from the same scan ends up
          // carrying the same items redundantly. Only touches groups not
          // yet turned into an actual role.
          const deltaIds = new Set(missing.map((c) => c.entitlementId));
          const boundaryKeyOf = (ac) =>
            JSON.stringify((ac || []).filter((c) => c.isBoundary).map((c) => `${c.key}=${c.value}`).sort());
          const thisBoundaryKey = boundaryKeyOf(group.attributeCriteria);
          for (const sibling of scan.groups) {
            if (sibling.id === group.id || sibling.isCommonAccessScope || sibling.roleCreated) continue;
            if (boundaryKeyOf(sibling.attributeCriteria) !== thisBoundaryKey) continue;
            if (Array.isArray(sibling.commonAccess)) {
              sibling.commonAccess = sibling.commonAccess.filter((e) => !deltaIds.has(e.id));
            }
            for (const d of sibling.dimensionPreview || []) {
              d.entitlements = (d.entitlements || []).filter((e) => !deltaIds.has(e.id));
            }
          }
        }
      } catch (reconcileErr) {
        console.error(`[insights] create-role: common-access reconcile-with-evaluation failed for role ${role.id}:`, reconcileErr.response?.data || reconcileErr.message);
      }
    }

    const baseEntIds = new Set(group.commonAccess.map((e) => e.id));

    // One dimension-creation task per (attribute, distinct value) pair
    // across all varying attributes, flattened into a single sequential
    // queue — sequential because SailPoint's dimension-create endpoint
    // returns intermittent 500s when hit with parallel writes against the
    // same parent role.
    //
    // The scan already computed every dimension's entitlements
    // (dimensionPreview), so reuse it when present — that guarantees the
    // role created matches the breakdown that was reviewed and approved.
    // Scans predating the preview fall back to computing it live.
    const preview = group.dimensionPreview || [];
    const dimensionTasks = [];

    if (preview.length) {
      for (const d of preview) {
        dimensionTasks.push({
          attrKey: d.attribute,
          value: d.value,
          entitlements: d.entitlements.map((e) => ({ id: e.id, type: "ENTITLEMENT", name: e.name })),
        });
      }
    } else {
      for (const attrKey of varyingKeys) {
        const values = [...new Set(group.members.map((m) => m[attrKey]).filter((v) => v && v !== "Unknown"))];
        for (const value of values) dimensionTasks.push({ attrKey, value });
      }
      // Each dimension carries the access unique to that slice of the group,
      // not just a membership-scoping criterion.
      for (const task of dimensionTasks) {
        const subMemberIds = group.members
          .filter((m) => m[task.attrKey] === task.value)
          .map((m) => m.id);
        const subEntitlementLists = await mapWithConcurrency(subMemberIds, 4, async (memberId) => {
          try {
            return await withApiRetry(
              () => iscGet(`/v2026/entitlements/identities/${memberId}/entitlements`, { limit: 100 }),
              { label: `create-role dimension sub-member entitlements for ${memberId}` }
            );
          } catch {
            return [];
          }
        });
        const nameById = new Map();
        for (const list of subEntitlementLists) for (const e of list) nameById.set(e.id, e.name);
        let subCommonIds = new Set((subEntitlementLists[0] || []).map((e) => e.id));
        for (const list of subEntitlementLists.slice(1)) {
          const ids = new Set(list.map((e) => e.id));
          subCommonIds = new Set([...subCommonIds].filter((id) => ids.has(id)));
        }
        task.entitlements = [...subCommonIds]
          .filter((id) => !baseEntIds.has(id))
          .map((id) => ({ id, type: "ENTITLEMENT", name: nameById.get(id) }));
      }

      // Drop anything granted by more than one dimension — it doesn't
      // distinguish any of them.
      const counts = new Map();
      for (const t of dimensionTasks) {
        for (const e of t.entitlements) counts.set(e.id, (counts.get(e.id) || 0) + 1);
      }
      for (const t of dimensionTasks) {
        t.entitlements = t.entitlements.filter((e) => counts.get(e.id) === 1);
      }
    }

    const dimensionsCreated = await mapWithConcurrency(dimensionTasks, 1, async ({ attrKey, value, entitlements }) => {
      const uniqueEntitlements = entitlements || [];

      try {
        const dim = await iscPost(`/v2026/roles/${role.id}/dimensions`, {
          name: value,
          description: `${labelize(attrKey)}: ${value}`,
          entitlements: uniqueEntitlements,
          accessProfiles: [],
          membership: {
            type: "STANDARD",
            criteria: {
              operation: "AND",
              key: null,
              stringValue: "",
              children: [{
                operation: "EQUALS",
                key: { type: "IDENTITY", property: `attribute.${attrKey}`, sourceId: null },
                stringValue: value,
                children: null,
              }],
            },
          },
        });
        return { attribute: attrKey, value, id: dim.id, ok: true, entitlements: uniqueEntitlements };
      } catch (dimErr) {
        console.error(`[insights] dimension create failed for ${attrKey}=${value}:`, dimErr.response?.data || dimErr.message);
        return { attribute: attrKey, value, ok: false, error: dimErr.response?.data?.detailCode || dimErr.message };
      }
    });

    // Tag the new role — and every entitlement on it, dimensions included —
    // with its data-segment metadata value, the same check Role Evaluation
    // runs (ensureRoleSegmentMetadata). Only when this tenant manages data
    // segments; best-effort, never fails the create.
    let segmentMetadata = null;
    try {
      const segSchema = await recordStore("schema-analysis").get(tenantKey());
      if (segSchema?.roleBoundaryEnabled && segSchema.createDataSegments) {
        segmentMetadata = await ensureRoleSegmentMetadata(
          { ...role, entitlements: role.entitlements || group.commonAccess || [] },
          dimensionsCreated.filter((d) => d.ok).map((d) => ({ entitlements: d.entitlements || [] })),
          segSchema.roleBoundaryAttributes || []
        );
      }
    } catch (tagErr) {
      console.error(`[insights] create-role: segment metadata tagging failed for role ${role.id}:`, tagErr.response?.data || tagErr.message);
      segmentMetadata = { error: describeError(tagErr), values: [] };
    }

    group.roleCreated = {
      id: role.id,
      name: role.name,
      createdAt: new Date().toISOString(),
      dimensional: isDynamic,
      dimensionAttributes: varyingKeys,
      dimensions: dimensionsCreated,
    };
    await updateRoleScan(scanId, { groups: scan.groups });

    return { role, dimensions: dimensionsCreated, commonAccessFlagged, commonAccessError, segmentMetadata };
  } catch (err) {
    console.error("[insights] create-role failed:", err.response?.data || err.message);
    throw roleWriteError(err);
  }
}

/**
 * POST /api/insights/role-scans/:id/groups/:groupId/merge-into-existing-role
 * When a peer group's exact attribute combination already matches an
 * existing role (group.existingRole — set in runRoleScan), this adds the
 * group's own proposed common access (group.commonAccess) onto that role
 * instead of creating a duplicate. Meant for use when Allow Duplicate Roles
 * is off and the scan found access the existing role doesn't grant yet;
 * nothing stops it being used with duplicates allowed too. A Common Access
 * scope proposal that already matched an existing role reports [] (see
 * runRoleScan), so there's nothing here to merge for it.
 */
export async function mergeRoleGroupIntoExisting(scanId, groupId) {
  const scan = await roleScans().get(scanId);
  const group = scan?.groups?.find((g) => g.id === groupId);
  if (!group) throw badRequest("Peer group not found.", 404);
  if (!group.existingRole) {
    throw badRequest("This peer group has no matching existing role to merge into.");
  }
  if (!group.commonAccess?.length) {
    throw badRequest("This peer group has no proposed access to merge.");
  }

  try {
    // Diffed against the role's own current entitlements (not just handed to
    // patchRoleEntitlements' own internal add-if-missing dedup) so the
    // response can report how many were actually new — merging a group that
    // turns out to already be fully covered should say "0 added".
    const before = await withApiRetry(
      () => iscGet(`/v2026/roles/${group.existingRole.id}`),
      { label: `merge-into-existing-role: fetch role ${group.existingRole.id}` }
    );
    const beforeIds = new Set((before.entitlements || []).map((e) => e.id));
    const toAdd = group.commonAccess.filter((e) => !beforeIds.has(e.id));

    if (toAdd.length > 0) {
      await patchRoleEntitlements(group.existingRole.id, { add: toAdd });
    }

    group.mergedIntoExisting = {
      roleId: group.existingRole.id,
      roleName: group.existingRole.name,
      mergedAt: new Date().toISOString(),
      addedCount: toAdd.length,
    };
    await updateRoleScan(scanId, { groups: scan.groups });

    return { roleId: group.existingRole.id, roleName: group.existingRole.name, addedCount: toAdd.length };
  } catch (err) {
    console.error(`[insights] merge-into-existing-role failed for group ${groupId}:`, err.response?.data || err.message);
    throw roleWriteError(err);
  }
}
