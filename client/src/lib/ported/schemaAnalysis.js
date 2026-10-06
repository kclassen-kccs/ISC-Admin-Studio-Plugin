/**
 * ported/schemaAnalysis.js
 * Port of the server's /api/insights/schema-analysis routes (run, read, set
 * Priority Order, set Multi-Company/Division Boundary), plus the identity
 * paging helpers those routes used (searchAllIdentities, fetchScopeIds,
 * isActiveIdentity).
 *
 * Looks at every identity's attributes (not their entitlements — this is
 * about the shape of the identity data itself) and picks the attributes that
 * best divide the tenant's users into peer groups.
 *
 * Store "schema-analysis": one record per tenant, keyed by tenantKey(), in
 * the exact shape the server persisted — other ports read it directly.
 */

import { iscPost, withApiRetry, routeError, badRequest } from "../isc";
import { recordStore } from "../store";
import { tenantKey, getTenantSettings, PEER_GROUP_STATUS_ATTRIBUTE_KEYS } from "./roleShared";

const SCHEMA_ANALYSIS_PAGE_SIZE = 250;
const PEER_GROUP_MIN_SIZE = 3;

const schemaAnalyses = () => recordStore("schema-analysis");

// /public-identities returns "status"/"identityState" as null for
// disabled/service/test accounts and "active"/"ACTIVE" for real active
// identities.
export function isActiveIdentity(idn) {
  return idn.status === "active" || idn.identityState === "ACTIVE";
}

// The 5 fixed attribute keys /v2026/public-identities always returns —
// Search's own attribute map is restricted to this same set so every
// caller sees exactly what public-identities would have given it.
const PUBLIC_IDENTITY_ATTRIBUTE_KEYS = ["manager", "jobTitle", "department", "country", "location"];

/**
 * Pages through every identity matching `query` (default "*" = every
 * identity) via the Search API's searchAfter cursor pagination — the only
 * way to page an Elasticsearch-backed index past its 10,000-record
 * offset+limit window. Each document is normalized into the shape
 * /v2026/public-identities returns ({ id, name, email, status,
 * identityState, manager, attributes: [{ key, value }] }).
 *
 * onPage(normalizedPage, totalSoFar), if given, runs after each page —
 * return `false` from it to stop paging early (cancellation).
 * includeAccess: true adds each identity's ENTITLEMENT access as
 * `access: [{ id, name }]`; accessTypes: [...] instead keeps every listed
 * access type with its type and source.
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
    const page = (await withApiRetry(
      () => iscPost("/v2026/search", body, { params: { limit: pageSize } }),
      { label: "searchAllIdentities: search page" }
    )) || [];
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
 * Every doc id matching a raw ISC Search query against the given index —
 * used to apply Scan Scope (identities) to Schema Analysis/Role Scan, and
 * Evaluation Scope (roles) to the Role Evaluation scan. Paginated via
 * searchAfter. Returns null for an empty/whitespace query, meaning "no
 * scope" — callers should treat that as "don't filter" rather than
 * "matches nothing."
 */
export async function fetchScopeIds(indices, query) {
  if (!query || !query.trim()) return null;
  const ids = new Set();
  let searchAfter = null;
  const pageSize = 250;
  while (true) {
    const body = { indices, query: { query }, sort: ["id"] };
    if (searchAfter) body.searchAfter = searchAfter;
    const page = (await withApiRetry(
      () => iscPost("/v2026/search", body, { params: { limit: pageSize } }),
      { label: "fetchScopeIds: search page" }
    )) || [];
    for (const doc of page) ids.add(doc.id);
    if (page.length < pageSize) break;
    searchAfter = [page[page.length - 1].id];
  }
  return ids;
}

/**
 * Scores each candidate identity attribute by how well it splits the
 * population into peer groups, then returns the candidates ranked best
 * first.
 *
 * An attribute is only a candidate if it clears PEER_GROUP_MIN_SIZE on
 * average — that's what excludes near-unique fields like email or employee
 * ID. Status/lifecycle fields are excluded outright — they describe state,
 * not identity.
 *
 * Among the remaining candidates, score = normalizedEntropy * coverage:
 *   - normalizedEntropy (0-1) rewards attributes whose values are spread
 *     evenly across members over ones dominated by a single value.
 *   - coverage (0-1) rewards attributes most identities actually have a
 *     value for.
 */
export function scoreSchemaAttributes(identities) {
  const valuesByKey = new Map();
  for (const idn of identities) {
    for (const attr of idn.attributes || []) {
      if (PEER_GROUP_STATUS_ATTRIBUTE_KEYS.has(attr.key)) continue;
      if (!attr.value) continue;
      if (!valuesByKey.has(attr.key)) valuesByKey.set(attr.key, new Map());
      const counts = valuesByKey.get(attr.key);
      counts.set(attr.value, (counts.get(attr.value) || 0) + 1);
    }
  }

  const candidates = [];
  for (const [key, counts] of valuesByKey) {
    const distinctValues = counts.size;
    if (distinctValues < 2) continue;

    const coveredCount = [...counts.values()].reduce((a, b) => a + b, 0);
    const avgGroupSize = coveredCount / distinctValues;
    if (avgGroupSize < PEER_GROUP_MIN_SIZE) continue;

    let entropy = 0;
    for (const count of counts.values()) {
      const p = count / coveredCount;
      entropy -= p * Math.log2(p);
    }
    const normalizedEntropy = entropy / Math.log2(distinctValues);
    const coverage = coveredCount / identities.length;

    candidates.push({
      key,
      distinctValues,
      coverage: Math.round(coverage * 1000) / 1000,
      avgGroupSize: Math.round(avgGroupSize * 10) / 10,
      score: Math.round(normalizedEntropy * coverage * 1000) / 1000,
    });
  }

  return candidates.sort((a, b) => b.score - a.score);
}

// ─── Routes ──────────────────────────────────────────────────────────────────

/**
 * POST /api/insights/schema-analysis
 * Pages through every identity in the tenant (scoped to the tenant's Role
 * Scan Scope setting, if one is configured), scores each identity attribute
 * by how well it divides the population into peer groups, and persists the
 * top 2 for this tenant. Returns the persisted record.
 */
export async function runSchemaAnalysis() {
  const tenant = tenantKey();
  try {
    const scopeQuery = (await getTenantSettings()).nameScope;
    const scopeIds = await fetchScopeIds(["identities"], scopeQuery);

    const allIdentities = await searchAllIdentities({ pageSize: SCHEMA_ANALYSIS_PAGE_SIZE });
    const identities = allIdentities.filter((idn) => isActiveIdentity(idn) && (!scopeIds || scopeIds.has(idn.id)));

    const candidates = scoreSchemaAttributes(identities);
    // suggestedTopAttributes is the algorithm's pick, kept alongside
    // topAttributes so a manual selection (see setSchemaTopAttributes) can
    // always be reset back to what the score actually recommended. A fresh
    // run resets any prior manual Priority Order selection, since the
    // candidate set (and therefore which keys are even valid) may have
    // changed.
    const suggestedTopAttributes = candidates.slice(0, 2).map((c) => c.key);

    // The Multi-Company/Division Boundary is a deliberate, explicit setting
    // — carried forward as long as every previously-selected boundary
    // attribute is still a valid candidate in this fresh analysis; reset
    // only when that's no longer true.
    const previous = await schemaAnalyses().get(tenant);
    const validKeys = new Set(candidates.map((c) => c.key));
    const previousBoundaryStillValid =
      !!previous?.roleBoundaryEnabled &&
      (previous.roleBoundaryAttributes || []).length > 0 &&
      previous.roleBoundaryAttributes.every((k) => validKeys.has(k));

    // A tenant's very first analysis defaults the boundary AND Create Data
    // Segments on, seeded with the suggested attributes — only when the
    // analysis actually produced candidates. Re-runs keep honoring the
    // previously-saved choice (or lack of one).
    const firstRunBoundaryOn = !previous && suggestedTopAttributes.length > 0;

    const result = {
      tenant,
      computedAt: new Date().toISOString(),
      totalIdentities: identities.length,
      scopeQuery: scopeIds ? scopeQuery : null,
      candidates,
      suggestedTopAttributes,
      topAttributes: suggestedTopAttributes,
      roleBoundaryEnabled: previousBoundaryStillValid || firstRunBoundaryOn,
      roleBoundaryAttributes: previousBoundaryStillValid ? previous.roleBoundaryAttributes
        : firstRunBoundaryOn ? suggestedTopAttributes : [],
      createDataSegments: firstRunBoundaryOn || (previousBoundaryStillValid && !!previous.createDataSegments),
    };
    await schemaAnalyses().put(tenant, result);
    return result;
  } catch (err) {
    console.error("[insights] schema-analysis failed:", err.response?.data || err.message);
    throw routeError(err);
  }
}

/** GET /api/insights/schema-analysis — the persisted analysis for this tenant, or null if none has run. */
export async function getSchemaAnalysis() {
  return (await schemaAnalyses().get(tenantKey())) || null;
}

/**
 * PUT /api/insights/schema-analysis/top-attributes
 * { topAttributes: string[] } — 1 to 2 candidate keys, in priority order
 * (first = highest priority). Lets a reviewer override the algorithm's
 * automatic pick and reorder it, without re-running the analysis.
 */
export async function setSchemaTopAttributes(topAttributes) {
  const tenant = tenantKey();
  const analysis = await schemaAnalyses().get(tenant);
  if (!analysis) throw badRequest("Run schema analysis first.", 404);

  if (!Array.isArray(topAttributes) || topAttributes.length < 1 || topAttributes.length > 2) {
    throw badRequest("topAttributes must be an array of 1 to 2 attribute keys.");
  }
  const validKeys = new Set(analysis.candidates.map((c) => c.key));
  const unique = new Set(topAttributes);
  if (unique.size !== topAttributes.length || [...unique].some((k) => !validKeys.has(k))) {
    throw badRequest("topAttributes must be unique keys from this analysis's candidates.");
  }

  analysis.topAttributes = topAttributes;
  await schemaAnalyses().put(tenant, analysis);
  return analysis;
}

/**
 * PUT /api/insights/schema-analysis/role-boundary
 * { enabled: boolean, attributes: string[], createDataSegments?: boolean }
 * — 0 to 2 candidate keys. createDataSegments is a sibling toggle, only
 * meaningful (and only ever persisted true) while enabled is also true.
 */
export async function setSchemaRoleBoundary({ enabled, attributes, createDataSegments } = {}) {
  const tenant = tenantKey();
  const analysis = await schemaAnalyses().get(tenant);
  if (!analysis) throw badRequest("Run schema analysis first.", 404);

  if (typeof enabled !== "boolean") {
    throw badRequest("enabled must be a boolean.");
  }
  if (!Array.isArray(attributes) || attributes.length > 2) {
    throw badRequest("attributes must be an array of at most 2 attribute keys.");
  }
  const validKeys = new Set(analysis.candidates.map((c) => c.key));
  const unique = new Set(attributes);
  if (unique.size !== attributes.length || [...unique].some((k) => !validKeys.has(k))) {
    throw badRequest("attributes must be unique keys from this analysis's candidates.");
  }
  if (createDataSegments !== undefined && typeof createDataSegments !== "boolean") {
    throw badRequest("createDataSegments must be a boolean.");
  }

  analysis.roleBoundaryEnabled = enabled;
  analysis.roleBoundaryAttributes = attributes;
  // Never left on without the boundary itself — off automatically whenever
  // enabled is false, regardless of what the client sent, since the
  // Segments menu's own visibility depends on this being a true reflection
  // of "boundary + segments both on."
  analysis.createDataSegments = enabled && !!createDataSegments;
  await schemaAnalyses().put(tenant, analysis);
  return analysis;
}
