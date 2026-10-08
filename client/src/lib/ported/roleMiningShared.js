/**
 * ported/roleMiningShared.js
 * Peer-group discovery building blocks the old server shared between its
 * Role Scan, Skeleton Roles and Distribution Group scans — ports of
 * searchAllIdentities, fetchScopeIds, getRoleScanAttributeKeys,
 * buildIdentityRoleProfileFromAccess, buildPeerGroups,
 * parseSimpleScopeCriteria and partitionProfilesByBoundary.
 */

import { withApiRetry, iscSearchPage } from "../isc";
import { recordStore } from "../store";
import {
  tenantKey,
  PEER_GROUP_STATUS_ATTRIBUTE_KEYS,
  ROLE_SCAN_COMMON_THRESHOLD,
  commonlyHeldEntitlementIds,
} from "./roleShared";

export const PUBLIC_IDENTITY_ATTRIBUTE_KEYS = ["manager", "jobTitle", "department", "country", "location"];

export const ROLE_SCAN_IDENTITY_PAGE_SIZE = 250; // SailPoint's documented max page size

/**
 * Pages through every identity matching `query` (Search API, searchAfter
 * cursor on id). includeAccess: true also requests each identity's `access`
 * array, narrowed to ENTITLEMENT items as bare {id, name}; accessTypes
 * keeps every listed access type with its type and granting source.
 * onPage(page, totalScanned) may return false to stop early.
 */
export async function searchAllIdentities({ query = "*", pageSize = 250, onPage, includeAccess = false, accessTypes = null } = {}) {
  const identities = [];
  let searchAfter = null;
  while (true) {
    const body = { indices: ["identities"], query: { query }, sort: ["id"] };
    if (searchAfter) body.searchAfter = searchAfter;
    if (includeAccess || accessTypes) {
      body.queryResultFilter = { includes: ["id", "name", "displayName", "email", "manager", "attributes", "access"] };
    }
    const { items: page } = await withApiRetry(
      () => iscSearchPage(body, { limit: pageSize }),
      { label: "searchAllIdentities: search page" }
    );
    if (page.length === 0) break;
    const normalizedPage = page.map((doc) => {
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
    if (page.length < pageSize) break;
    searchAfter = [page[page.length - 1].id];
  }
  return identities;
}

/**
 * The ids of every document in `indices` matching the raw Search `query`
 * (searchAfter on a stable id sort). Returns null for an empty/whitespace
 * query, meaning "no scope" — callers treat that as "don't filter".
 */
export async function fetchScopeIds(indices, query) {
  if (!query || !query.trim()) return null;
  const ids = new Set();
  let searchAfter = null;
  const pageSize = 250;
  while (true) {
    const body = { indices, query: { query }, sort: ["id"] };
    if (searchAfter) body.searchAfter = searchAfter;
    const { items: page } = await withApiRetry(
      () => iscSearchPage(body, { limit: pageSize }),
      { label: "fetchScopeIds: search page" }
    );
    for (const doc of page) ids.add(doc.id);
    if (page.length < pageSize) break;
    searchAfter = [page[page.length - 1].id];
  }
  return ids;
}

// Identity attributes used to define peer groups when no Schema Analysis has
// been run for the tenant yet. Status/lifecycle attributes are excluded on
// purpose: active/disabled is the always-on lifecycleState criterion, not a
// peer-grouping dimension.
export const DEFAULT_PEER_GROUP_ATTRIBUTE_KEYS = ["department", "location"]
  .filter((k) => !PEER_GROUP_STATUS_ATTRIBUTE_KEYS.has(k));

/**
 * The attribute keys a scan buckets by: Schema Analysis's chosen top
 * attributes for this tenant if it has been run, otherwise the default.
 */
export async function getRoleScanAttributeKeys() {
  const analysis = await recordStore("schema-analysis").get(tenantKey());
  const configured = (analysis?.topAttributes || []).filter((k) => !PEER_GROUP_STATUS_ATTRIBUTE_KEYS.has(k));
  return configured.length > 0 ? configured : DEFAULT_PEER_GROUP_ATTRIBUTE_KEYS;
}

/** One identity's mining profile, entitlements read straight off its search document's `access`. */
export function buildIdentityRoleProfileFromAccess(idn, attributeKeys) {
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

// Mining Config's Scope field is a raw ISC Search query. Only the simple
// case (a single attribute=value equality, however punctuated) can be
// translated into a role's structured criteria; anything else returns null.
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
 * value. Profiles missing any boundary key's value are left out of every
 * partition.
 */
export function partitionProfilesByBoundary(profiles, boundaryKeys) {
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

// Within a tier of equal-size combinations, department+location is tried first.
const PREFERRED_2ATTR_PAIR = ["department", "location"];
function comboPreferenceScore(combo) {
  return combo.length === 2 && PREFERRED_2ATTR_PAIR.every((k) => combo.includes(k)) ? 1 : 0;
}

/**
 * Buckets identities into peer groups by exact match on some combination of
 * `attributeKeys`, then — within each bucket — narrows to the entitlements
 * commonly held by its members. Every bucket becomes a group (no minimum
 * size, no "must share access" gate). With createDynamicRoles on, the
 * broadest combination is tried first and more specific ones only for
 * members no broader combination claimed; with it off only the single
 * most-specific combination (every attribute together) is tried.
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
      // A solo member has no peers to compute "commonly held" from, so their
      // own entitlements are used directly. Otherwise members holding zero or
      // exactly one entitlement are left out of the commonality math (but
      // still count as members).
      let commonSig;
      if (members.length === 1) {
        commonSig = new Set(members[0].entitlements.map((e) => e.id));
      } else {
        const eligibleForProposal = members.filter((m) => m.entitlements.length > 1);
        commonSig = commonlyHeldEntitlementIds(eligibleForProposal, commonalityThreshold);
      }
      // Access a common-access role already grants everyone is birthright,
      // not what makes this group distinct.
      commonSig = new Set([...commonSig].filter((id) => !commonRoleEntIds.has(id)));
      for (const m of members) assigned.add(m.id);
      const attributeCriteria = comboKeys.map((key) => ({ key, value: members[0].attrs[key] }));
      const groupNameById = new Map();
      for (const m of members) for (const e of m.entitlements) groupNameById.set(e.id, e.name);

      // What each dimension would grant: entitlements commonly held by the
      // members sharing that value, minus what the base role already grants.
      const varyingKeys = attributeKeys.filter((k) => !comboKeys.includes(k));
      const peersInScope = profiles.filter((p) =>
        attributeCriteria.every(({ key: ck, value: cv }) => p.attrs[ck] === cv)
      );
      const dimensionPreview = [];
      for (const key of varyingKeys) {
        const values = [...new Set(peersInScope.map((p) => p.attrs[key]).filter((v) => v && v !== "Unknown"))];
        for (const value of values) {
          const subs = members.filter((m) => m.attrs[key] === value);
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

/** Canonical, order-independent key for a set of {attrKey, value} pairs, for exact-set comparison. */
export function criteriaSetKey(leaves) {
  return leaves
    .map((l) => `${l.attrKey}=${l.value}`)
    .sort()
    .join("|");
}
