/**
 * ported/roleMembers.js
 * Live membership-rule evaluation for roles and dimensions — ports of
 * GET /api/roles/:id/rule-members and GET /api/roles/:id/dimensions/:dimId/
 * rule-members, plus the helpers Role Evaluation shares with them
 * (identityMatchesCriteria, findRoleMembers, fetchActiveIdentityPopulation).
 *
 * /v2026/public-identities doesn't accept filters on custom attributes
 * (verified live), so the role's own membership criteria tree is evaluated in
 * memory against each active identity.
 */

import { iscGet, iscPost, withApiRetry, routeError } from "../isc";

export const ROLE_EVAL_OPERATION_TEST = {
  EQUALS: (attrValue, leafValue) => attrValue === leafValue,
  NOT_EQUALS: (attrValue, leafValue) => attrValue !== leafValue,
  CONTAINS: (attrValue, leafValue) => typeof attrValue === "string" && attrValue.includes(leafValue),
  DOES_NOT_CONTAIN: (attrValue, leafValue) => !(typeof attrValue === "string" && attrValue.includes(leafValue)),
};

/**
 * Evaluates a membership criteria node against one identity's attributes.
 * Returns a boolean, or null if the tree uses something this can't evaluate
 * (an ACCOUNT-scoped condition, or an operation not in the map above) — the
 * caller treats null as "give up on membership evaluation for this role"
 * rather than silently guessing.
 */
export function identityMatchesCriteria(node, attrs) {
  if (!node) return true;
  const children = (node.children || []).filter(Boolean);
  if (node.operation === "AND") {
    if (children.length === 0) return true;
    const results = children.map((c) => identityMatchesCriteria(c, attrs));
    if (results.some((r) => r === null)) return null;
    return results.every(Boolean);
  }
  if (node.operation === "OR") {
    if (children.length === 0) return true;
    const results = children.map((c) => identityMatchesCriteria(c, attrs));
    if (results.every((r) => r === false)) return false;
    if (results.some((r) => r === true)) return true;
    return null; // mixed false/null with no true — can't be sure
  }
  if (node.key?.type !== "IDENTITY" || !node.key.property?.startsWith("attribute.")) return null;
  const test = ROLE_EVAL_OPERATION_TEST[node.operation];
  if (!test) return null;
  const attrKey = node.key.property.slice("attribute.".length);
  const attrValue = attrs[attrKey];
  const leafValues = Array.isArray(node.values) && node.values.length ? node.values : [node.stringValue];
  return leafValues.some((v) => test(attrValue, v));
}

export const ROLE_EVAL_IDENTITY_PAGE_SIZE = 250;
export const ROLE_EVAL_MAX_MATCHES = 150; // bound cost/time on a large tenant
export const ROLE_EVAL_MAX_SCANNED = 3000; // give up looking for matches past this many identities
export const ROLE_EVAL_ENTITLEMENT_CONCURRENCY = 8;
// Below this many members, "held by X% of members" is noise rather than a real
// signal (verified live: a 1-member role had every one of that member's own
// unrelated entitlements flagged as "commonly held but not granted").
export const ROLE_EVAL_MIN_MEMBERS_FOR_COMMONALITY = 3;

// Unlike findRoleMembers (bounded to ROLE_EVAL_MAX_MATCHES — a sample), the
// Members tab needs the actual full list, paginated and searchable, so it
// scans a much higher ceiling before giving up on a huge tenant.
export const ROLE_MEMBERS_MAX_SCANNED = 20000;

/**
 * Evaluates a role's membership rule against every active identity, live —
 * this is the "who actually belongs to this role" ISC's own criteria defines,
 * independent of whatever its search index currently has recorded. Falls back
 * to the role's own IDENTITY_LIST (membership.identities) when it has no
 * criteria at all. `query` is a case-insensitive name-contains filter applied
 * after evaluating; total/members are the query-filtered, pre-pagination count
 * and the requested page respectively.
 */
export async function evaluateRoleMembershipMembers(membership, { query, limit = 50, offset = 0 } = {}) {
  const matchesQuery = (name) => !query || (name || "").toLowerCase().includes(query.toLowerCase());

  if (!membership?.criteria) {
    const list = (membership?.identities || []).filter((i) => matchesQuery(i.name));
    list.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    return { total: list.length, members: list.slice(offset, offset + limit) };
  }

  // Paginated via searchAfter against the Search API (not offset against
  // /v2026/identities) — offset pagination hard-fails once offset+limit passes
  // 10,000 (verified live). Search's identity documents carry `attributes` as
  // the same plain key-value map /v2026/identities does, so
  // identityMatchesCriteria works unchanged.
  const matches = [];
  let scanned = 0;
  let searchAfter = null;
  while (scanned < ROLE_MEMBERS_MAX_SCANNED) {
    const body = { indices: ["identities"], query: { query: "*" }, sort: ["id"] };
    if (searchAfter) body.searchAfter = searchAfter;
    // Retried like every other multi-page ISC scan — a scan this size is 40+
    // sequential calls, and a single transient 429/5xx used to fail the whole
    // Members tab outright.
    const page = (await withApiRetry(
      () => iscPost("/v2026/search", body, { params: { limit: ROLE_EVAL_IDENTITY_PAGE_SIZE } }),
      { label: "role/dimension members scan" }
    )) || [];
    if (page.length === 0) break;
    for (const idn of page) {
      const attrs = idn.attributes || {};
      if (attrs.identityState !== "ACTIVE") continue;
      if (identityMatchesCriteria(membership.criteria, attrs)) {
        matches.push({
          id: idn.id,
          name: idn.name,
          displayName: attrs.displayName || idn.displayName || idn.name,
          email: idn.email || attrs.email || null,
          attributes: { jobTitle: attrs.jobTitle || null, department: attrs.department || null },
        });
      }
    }
    scanned += page.length;
    if (page.length < ROLE_EVAL_IDENTITY_PAGE_SIZE) break;
    searchAfter = [page[page.length - 1].id];
  }

  // matchesQuery/sort use displayName, not Search's own top-level `name` (that's
  // the USERNAME) — sorting by username would silently misbehave.
  const filtered = matches
    .filter((m) => matchesQuery(m.displayName))
    .sort((a, b) => (a.displayName || "").localeCompare(b.displayName || ""));
  return { total: filtered.length, members: filtered.slice(offset, offset + limit) };
}

function pagingArgs({ limit, offset, query } = {}) {
  // Each call re-evaluates the rule against every identity and then slices, so
  // paging through a big role costs a full scan per page. The printout needs
  // every member at once, hence the higher ceiling.
  return {
    limit: Math.min(Number(limit) || 50, 2500),
    offset: Math.max(Number(offset) || 0, 0),
    query: typeof query === "string" ? query.trim() : "",
  };
}

/** GET /api/roles/:id/rule-members */
export async function listRoleMembers(roleId, opts = {}) {
  const { limit, offset, query } = pagingArgs(opts);
  try {
    const role = await iscGet(`/v2026/roles/${roleId}`);
    return await evaluateRoleMembershipMembers(role.membership, { query, limit, offset });
  } catch (err) {
    console.error("[roles] rule-members failed:", err.response?.data || err.message);
    throw routeError(err);
  }
}

/**
 * GET /api/roles/:id/dimensions/:dimensionId/rule-members
 * A dimension's own membership criteria only ever encodes the one attribute it
 * varies by — evaluating it alone would pull in identities outside the base
 * role's actual population entirely. Real dimension membership is the base
 * role's own membership AND this dimension's, so both are intersected here
 * when both are criteria-based.
 */
export async function listDimensionMembers(roleId, dimensionId, opts = {}) {
  const { limit, offset, query } = pagingArgs(opts);
  try {
    const [role, dimension] = await Promise.all([
      iscGet(`/v2026/roles/${roleId}`),
      iscGet(`/v2026/roles/${roleId}/dimensions/${dimensionId}`),
    ]);
    const combinedMembership = (role.membership?.criteria && dimension.membership?.criteria)
      ? {
          criteria: {
            operation: "AND", key: null, values: null, stringValue: null,
            children: [role.membership.criteria, dimension.membership.criteria],
          },
        }
      : dimension.membership;
    return await evaluateRoleMembershipMembers(combinedMembership, { query, limit, offset });
  } catch (err) {
    console.error("[roles] dimension rule-members failed:", err.response?.data || err.message);
    throw routeError(err);
  }
}

/**
 * Pages through /v2026/identities up to ROLE_EVAL_MAX_SCANNED once, kept on
 * `cache` (a plain {} the caller owns) so many findRoleMembers calls against
 * the SAME population share this one paged fetch.
 */
export async function fetchActiveIdentityPopulation(cache) {
  if (cache.promise) return cache.promise;
  cache.promise = (async () => {
    const identities = [];
    let offset = 0;
    let totalScanned = 0;
    while (totalScanned < ROLE_EVAL_MAX_SCANNED) {
      const page = await withApiRetry(
        () => iscGet("/v2026/identities", {
          limit: ROLE_EVAL_IDENTITY_PAGE_SIZE,
          offset,
          sorters: "name",
        }),
        { label: "fetchActiveIdentityPopulation: identities page" }
      );
      if (page.length === 0) break;
      for (const idn of page) {
        if (idn.attributes?.identityState === "ACTIVE") identities.push(idn);
      }
      totalScanned += page.length;
      offset += page.length;
      if (page.length < ROLE_EVAL_IDENTITY_PAGE_SIZE) break;
    }
    return { identities, totalScanned };
  })();
  return cache.promise;
}

/**
 * Finds up to ROLE_EVAL_MAX_MATCHES active identities matching a role's
 * membership criteria. When captureAttrKeys is given, each match also carries
 * those attributes' values (attrValues) — used to group a dynamic role's
 * base-eligible population by its dimension-splitting attribute without a
 * second identity scan. populationCache (optional) shares one paged fetch of
 * the active identities across many calls.
 */
export async function findRoleMembers(membership, captureAttrKeys, populationCache) {
  const captureKeys = Array.isArray(captureAttrKeys) ? captureAttrKeys : captureAttrKeys ? [captureAttrKeys] : [];
  // Prefer the membership rule (criteria) when the role has one — it's the
  // live, authoritative definition of who belongs. Only fall back to the
  // explicitly-assigned identities list (IDENTITY_LIST membership) when no
  // rule exists at all.
  if (!membership?.criteria) {
    if (membership?.identities?.length) {
      return { supported: true, matches: membership.identities.slice(0, ROLE_EVAL_MAX_MATCHES), totalScanned: membership.identities.length };
    }
    return { supported: false };
  }

  if (populationCache) {
    const { identities, totalScanned } = await fetchActiveIdentityPopulation(populationCache);
    const matches = [];
    let sawUnsupported = false;
    for (const idn of identities) {
      const attrs = idn.attributes || {};
      const result = identityMatchesCriteria(membership.criteria, attrs);
      if (result === null) sawUnsupported = true;
      else if (result) {
        matches.push({
          id: idn.id,
          name: idn.name,
          ...(captureKeys.length ? { attrValues: Object.fromEntries(captureKeys.map((k) => [k, attrs[k]])) } : {}),
        });
      }
      if (matches.length >= ROLE_EVAL_MAX_MATCHES) break;
    }
    if (sawUnsupported && matches.length === 0) return { supported: false };
    return { supported: true, matches, totalScanned, partial: sawUnsupported };
  }

  const matches = [];
  let offset = 0;
  let totalScanned = 0;
  let sawUnsupported = false;
  while (totalScanned < ROLE_EVAL_MAX_SCANNED && matches.length < ROLE_EVAL_MAX_MATCHES) {
    // Uses /v2026/identities, not /v2026/public-identities — verified live that
    // public-identities only ever carries 5 fixed attributes and NEVER
    // cloudLifecycleState, so criteria referencing anything outside that set
    // would silently evaluate to "no matches". /v2026/identities carries the
    // identity's full attributes map. sorters is required, not cosmetic —
    // without it pagination order isn't stable between calls, so a role whose
    // population exceeds ROLE_EVAL_MAX_MATCHES would get a DIFFERENT partial
    // sample each run. "id" isn't sortable on this endpoint (400 semantically
    // invalid) — "name" is.
    const page = await withApiRetry(
      () => iscGet("/v2026/identities", {
        limit: ROLE_EVAL_IDENTITY_PAGE_SIZE,
        offset,
        sorters: "name",
      }),
      { label: "findRoleMembers: identities page" }
    );
    if (page.length === 0) break;
    for (const idn of page.filter((i) => i.attributes?.identityState === "ACTIVE")) {
      const attrs = idn.attributes || {};
      const result = identityMatchesCriteria(membership.criteria, attrs);
      if (result === null) sawUnsupported = true;
      else if (result) {
        matches.push({
          id: idn.id,
          name: idn.name,
          ...(captureKeys.length ? { attrValues: Object.fromEntries(captureKeys.map((k) => [k, attrs[k]])) } : {}),
        });
      }
      if (matches.length >= ROLE_EVAL_MAX_MATCHES) break;
    }
    totalScanned += page.length;
    offset += page.length;
    if (page.length < ROLE_EVAL_IDENTITY_PAGE_SIZE) break;
  }
  // Only bail entirely if evaluation never once resolved cleanly — a mix of
  // matches and unsupported reads is still a useful (if partial) sample.
  if (sawUnsupported && matches.length === 0) return { supported: false };
  return { supported: true, matches, totalScanned, partial: sawUnsupported };
}
