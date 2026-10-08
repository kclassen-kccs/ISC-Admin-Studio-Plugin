/**
 * ported/certificationRuns.js
 * Certification runs (Mining > Certifications) — ports of
 *   POST   /api/insights/certification-runs                         (startCertificationRun)
 *   GET    /api/insights/certification-runs                         (listCertificationRuns)
 *   GET    /api/insights/certification-runs/:id[?full=1]            (getCertificationRun)
 *   GET    /api/insights/certification-runs/:id/campaigns/:index    (getCertificationRunCampaign)
 *   POST   /api/insights/certification-runs/:id/campaigns/:index/create (createCertificationCampaign)
 *   POST   /api/insights/certification-runs/:id/sync-status         (syncCertificationRunStatus)
 *   POST   /api/insights/certification-runs/:id/cancel              (cancelCertificationRun)
 *   DELETE /api/insights/certification-runs/:id                     (deleteCertificationRun)
 * plus the planning runner (runCertificationDrafts) and the campaign item
 * filter resolution the old server shared with it.
 *
 * A run plans one STAGED campaign draft per combination of the Certification
 * Attributes' values (or a single "All users" campaign with none chosen) and
 * stores the plan in the "certification-runs" record store; each campaign is
 * then created in ISC on demand from the drafts screen. The planner runs in
 * the page (see scanJobs.js): it keeps going while the tab is open and a run
 * interrupted by a reload is marked failed the next time the store is read.
 */

import { iscGet, iscPost, withApiRetry, fetchAllPaged, describeError, routeError, badRequest } from "../isc";
import { recordStore } from "../store";
import { isBirthrightRole } from "../roleMembership";
import { tenantKey, getTenantSettings, PEER_GROUP_STATUS_ATTRIBUTE_KEYS } from "./roleShared";
import { getStudioPreferences, DEFAULT_STUDIO_PREFERENCES, certificationCampaignName } from "./settings";
import { getCommonAccessRoleIdSet } from "./roleCommonAccess";
import { startJob, patchRecord, failInterrupted, requestCancel, isCancelled, newScanId } from "./scanJobs";

const STORE = "certification-runs";
const runs = () => recordStore(STORE);

// Root name for the single campaign planned when no Certification
// Attributes are chosen — there is no attribute value to name it after.
const ALL_USERS_BASE_NAME = "All users";

const CERT_ACCESS_INDICES = [
  { index: "entitlements", type: "ENTITLEMENT" },
  { index: "roles", type: "ROLE" },
  { index: "accessprofiles", type: "ACCESS_PROFILE" },
];
const CERT_ACCESS_ITEM_TYPES = ["ROLE", "ACCESS_PROFILE", "ENTITLEMENT"];
const CERT_ACCESS_ITEM_TYPE_LABELS = { ROLE: "Roles", ACCESS_PROFILE: "Access Profiles", ENTITLEMENT: "Entitlements" };
const CERT_FILTER_ID_CAP = 20000;
const SEARCH_PAGE_SIZE = 250;

const NOT_FOUND = "Certification run not found.";
const CAMPAIGN_NOT_FOUND = "Campaign not found in this run.";

async function updateCertificationRun(runId, patch) {
  return patchRecord(STORE, runId, patch);
}
/** The run, if it belongs to this tenant (the store is tenant-namespaced, but the record carries the tenant as before). */
async function runForTenant(runId) {
  const run = await runs().get(runId);
  return run && run.tenant === tenantKey() ? run : null;
}
const stripMembers = (results) => (results || []).map(({ members, ...rest }) => rest);

// ─── Identity helpers (ports of the server's search helpers) ─────────────────

function sanitizeAttributeKey(key) {
  return String(key).replace(/[^a-zA-Z0-9_.]/g, "");
}
function isActiveIdentity(idn) {
  return idn.status === "active" || idn.identityState === "ACTIVE";
}

// Search's `attributes` map omits null keys; the old server restricted the
// normalized identity to the five keys /public-identities always returns.
const PUBLIC_IDENTITY_ATTRIBUTE_KEYS = ["manager", "jobTitle", "department", "country", "location"];

/**
 * Every identity matching `query`, searchAfter-paginated through the Search
 * API's identities index and normalized to the /public-identities shape.
 * With `accessTypes`, each identity also carries its `access` list (id, type,
 * name, source, sourceId) restricted to those types.
 */
async function searchAllIdentities({ query = "*", pageSize = SEARCH_PAGE_SIZE, accessTypes = null } = {}) {
  const identities = [];
  let searchAfter = null;
  while (true) {
    const body = { indices: ["identities"], query: { query }, sort: ["id"] };
    if (searchAfter) body.searchAfter = searchAfter;
    if (accessTypes) {
      body.queryResultFilter = { includes: ["id", "name", "displayName", "email", "manager", "attributes", "access"] };
    }
    const page = (await withApiRetry(
      () => iscPost("/v2026/search", body, { params: { limit: pageSize } }),
      { label: "searchAllIdentities: search page" }
    )) || [];
    if (page.length === 0) break;
    for (const doc of page) {
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
      }
      identities.push(normalized);
    }
    if (page.length < pageSize) break;
    searchAfter = [page[page.length - 1].id];
  }
  return identities;
}

/** Ids of every document `query` matches on `indices`, or null for a blank query. */
async function fetchScopeIds(indices, query) {
  if (!query || !query.trim()) return null;
  const ids = new Set();
  let searchAfter = null;
  while (true) {
    const body = { indices, query: { query }, sort: ["id"] };
    if (searchAfter) body.searchAfter = searchAfter;
    const page = (await withApiRetry(
      () => iscPost("/v2026/search", body, { params: { limit: SEARCH_PAGE_SIZE } }),
      { label: "fetchScopeIds: search page" }
    )) || [];
    for (const doc of page) ids.add(doc.id);
    if (page.length < SEARCH_PAGE_SIZE) break;
    searchAfter = [page[page.length - 1].id];
  }
  return ids;
}

// ─── Campaign item filters ───────────────────────────────────────────────────

/** Every id one search query matches on one index (searchAfter-paginated, capped). */
async function searchAccessIdsAll(index, query) {
  const ids = new Set();
  let searchAfter = null;
  while (ids.size < CERT_FILTER_ID_CAP) {
    const body = { indices: [index], query: { query }, sort: ["id"], queryResultFilter: { includes: ["id"] } };
    if (searchAfter) body.searchAfter = searchAfter;
    const page = (await withApiRetry(
      () => iscPost("/v2026/search", body, { params: { limit: SEARCH_PAGE_SIZE } }),
      { label: `certifications: filter search ${index}` }
    )) || [];
    if (page.length === 0) break;
    for (const d of page) if (d.id) ids.add(d.id);
    if (page.length < SEARCH_PAGE_SIZE) break;
    searchAfter = [page[page.length - 1].id];
  }
  return ids;
}

/** Union of one query's matches across all three access indices; a failing index is skipped with a warning. */
async function searchAccessIdsAcrossIndices(queryFor, warnings, label) {
  const all = new Set();
  for (const { index } of CERT_ACCESS_INDICES) {
    const query = queryFor(index);
    if (!query) continue;
    try {
      for (const id of await searchAccessIdsAll(index, query)) all.add(id);
    } catch (err) {
      warnings.push(`${label}: search on ${index} failed (${describeError(err)}) — no ${index} matched this filter.`);
    }
  }
  return all;
}

/**
 * The Search Filter as an identity-query clause: the query itself for
 * INCLUDE, its negation for EXCLUDE, or null when blank. Used both to scan
 * identities and inside every campaign's search query, so the users this
 * app plans for and the users ISC certifies are the same set.
 */
function certificationIdentityFilterClause(settings) {
  const q = String(settings.certSearchFilter || "").trim();
  if (!q) return null;
  return settings.certSearchMode === "EXCLUDE" ? `NOT (${q})` : `(${q})`;
}
function certificationIdentityFilterSummary(settings) {
  const q = String(settings.certSearchFilter || "").trim();
  if (!q) return null;
  return `${settings.certSearchMode === "EXCLUDE" ? "Identities excluding" : "Identities matching"} "${q}"`;
}

/**
 * Resolves the configured filters to { active, allowed: Set<id>|null, summary, warnings }.
 * heldIds is every access-item id any scanned identity holds — the universe
 * an exclude filter subtracts from and an include filter is intersected with.
 */
async function resolveCertificationItemFilters(settings, heldIds, heldTypes = new Map(), heldSources = new Map()) {
  const warnings = [];
  const summary = [];
  const includes = [];
  const excludes = [];

  // Access Item Types — first, since it's the coarsest cut. All three chosen
  // (or the setting absent) means no type filter at all.
  const chosenTypes = Array.isArray(settings.certAccessItemTypes) && settings.certAccessItemTypes.length
    ? CERT_ACCESS_ITEM_TYPES.filter((t) => settings.certAccessItemTypes.includes(t))
    : CERT_ACCESS_ITEM_TYPES;
  if (chosenTypes.length < CERT_ACCESS_ITEM_TYPES.length) {
    const wrongType = new Set();
    for (const id of heldIds) if (!chosenTypes.includes(heldTypes.get(id))) wrongType.add(id);
    excludes.push(wrongType);
    summary.push(`Only ${chosenTypes.map((t) => CERT_ACCESS_ITEM_TYPE_LABELS[t]).join(" and ")}`);
  }

  // Birthright roles — only meaningful while Roles are being certified. A
  // birthright role is any role with a membership rule. Common Access roles
  // usually have one too, so they'd be swept out with the rest; the Include
  // Common Access Roles option pulls them back in.
  if (chosenTypes.includes("ROLE") && settings.certExcludeBirthrightRoles === true) {
    try {
      const roles = await fetchAllPaged("/v2026/roles");
      const birthright = new Set(roles.filter(isBirthrightRole).map((r) => r.id));
      let keptCommon = 0;
      if (settings.certIncludeCommonAccessRoles === true) {
        const common = await getCommonAccessRoleIdSet();
        for (const id of common) if (birthright.delete(id) && heldIds.has(id)) keptCommon += 1;
      }
      const heldBirthright = new Set([...birthright].filter((id) => heldIds.has(id)));
      excludes.push(heldBirthright);
      summary.push(
        settings.certIncludeCommonAccessRoles === true
          ? `Exclude birthright roles (roles with a membership rule), but keep Common Access roles — ${heldBirthright.size} excluded, ${keptCommon} Common Access kept`
          : `Exclude birthright roles (roles with a membership rule) — ${heldBirthright.size} excluded`
      );
    } catch (err) {
      // Failing open would silently certify roles the admin asked to leave
      // out; failing closed would silently drop every role. Neither is
      // acceptable unannounced, so the filter is skipped AND flagged.
      warnings.push(`Birthright roles: couldn't read the tenant's roles (${describeError(err)}) — birthright roles were NOT excluded from this run.`);
    }
  }

  // Included Sources — drops access profiles and entitlements that come from
  // a source the admin unticked. Roles have no source, so they never match;
  // an item whose source isn't known is kept rather than guessed at.
  const excludedSources = Array.isArray(settings.certExcludedSources) ? settings.certExcludedSources.filter((x) => x?.id) : [];
  if (excludedSources.length > 0) {
    const excludedIds = new Set(excludedSources.map((x) => x.id));
    const fromExcluded = new Set();
    for (const id of heldIds) {
      const type = heldTypes.get(id);
      if ((type === "ACCESS_PROFILE" || type === "ENTITLEMENT") && excludedIds.has(heldSources.get(id))) fromExcluded.add(id);
    }
    excludes.push(fromExcluded);
    const names = excludedSources.map((x) => x.name || x.id);
    summary.push(
      `Exclude access profiles and entitlements from ${excludedSources.length} source${excludedSources.length === 1 ? "" : "s"} ` +
      `(${names.slice(0, 5).join(", ")}${names.length > 5 ? `, +${names.length - 5} more` : ""}) — ${fromExcluded.size} item${fromExcluded.size === 1 ? "" : "s"} excluded`
    );
  }

  // One privilege filter per level, each with its own mode; the legacy
  // single level/mode pair still counts while the list is empty.
  const privFilters = Array.isArray(settings.certPrivilegeFilters) && settings.certPrivilegeFilters.length
    ? settings.certPrivilegeFilters
    : (settings.certPrivilegeLevel && settings.certPrivilegeLevel !== "IGNORE"
      ? [{ level: settings.certPrivilegeLevel, mode: settings.certPrivilegeMode }] : []);
  if (privFilters.length > 0) {
    const pooled = { INCLUDE: new Set(), EXCLUDE: new Set() };
    const titleCase = (l) => l.charAt(0) + l.slice(1).toLowerCase();
    // "High or Medium privilege items", "items with no value set for privilege (null)", or both.
    const privilegePhrase = (entries) => {
      const levels = entries.filter((p) => String(p.level).toUpperCase() !== "NOT_SET").map((p) => titleCase(String(p.level)));
      const parts = [];
      if (levels.length) parts.push(`${levels.join(" or ")} privilege items`);
      if (entries.some((p) => String(p.level).toUpperCase() === "NOT_SET")) parts.push("items with no value set for privilege (null)");
      return parts.join(" or ");
    };
    const warnedIndices = new Set();
    // Ids at one real level across the three indices (memoised — NOT_SET
    // needs all three levels even when only it is configured). Entitlements
    // carry privilegeLevel.effective in the search index; roles and access
    // profiles carry a flat privilegeLevel — try the nested form first
    // everywhere and fall back to the flat one.
    const levelCache = new Map();
    const idsAtLevel = async (level) => {
      if (levelCache.has(level)) return levelCache.get(level);
      const ids = new Set();
      for (const { index } of CERT_ACCESS_INDICES) {
        let matched = null;
        for (const q of [`privilegeLevel.effective:${level}`, `privilegeLevel:${level}`]) {
          try { matched = await searchAccessIdsAll(index, q); break; } catch { matched = null; }
        }
        if (!matched) {
          if (!warnedIndices.has(index)) { warnedIndices.add(index); warnings.push(`Access Privilege: ${index} don't expose a privilege level to search on this tenant — none matched.`); }
        } else for (const id of matched) ids.add(id);
      }
      levelCache.set(level, ids);
      return ids;
    };
    for (const p of privFilters) {
      const level = String(p.level || "").toUpperCase();
      const mode = p.mode === "EXCLUDE" ? "EXCLUDE" : "INCLUDE";
      if (level === "NOT_SET") {
        // "No Value Set for Privilege (null)" is the complement: every held
        // item that is not High, Medium or Low — which covers both an
        // explicit NONE and a missing privilegeLevel field.
        const classified = new Set();
        for (const l of ["HIGH", "MEDIUM", "LOW"]) for (const id of await idsAtLevel(l)) classified.add(id);
        for (const id of heldIds) if (!classified.has(id)) pooled[mode].add(id);
      } else {
        for (const id of await idsAtLevel(level)) pooled[mode].add(id);
      }
    }
    const inc = privFilters.filter((p) => p.mode !== "EXCLUDE");
    const exc = privFilters.filter((p) => p.mode === "EXCLUDE");
    if (inc.length) { includes.push(pooled.INCLUDE); summary.push(`Only ${privilegePhrase(inc)}`); }
    if (exc.length) { excludes.push(pooled.EXCLUDE); summary.push(`Exclude ${privilegePhrase(exc)}`); }
  }

  // Each metadata pair carries its own mode. Include pairs pool into one
  // set (an item needs any one of them); Exclude pairs pool into another
  // and are subtracted afterwards, so Exclude wins where both apply.
  const pairs = Array.isArray(settings.certMetadataFilters) ? settings.certMetadataFilters.filter((p) => p?.key && p?.value != null) : [];
  if (pairs.length > 0) {
    const legacyMode = settings.certMetadataMode === "EXCLUDE" ? "EXCLUDE" : "INCLUDE";
    const modeOf = (p) => (p.mode ? (p.mode === "EXCLUDE" ? "EXCLUDE" : "INCLUDE") : legacyMode);
    const pairText = (p) => `${p.attributeName || p.key} = ${p.valueName || p.value}`;
    const pooled = { INCLUDE: new Set(), EXCLUDE: new Set() };
    for (const p of pairs) {
      const matched = await searchAccessIdsAcrossIndices(
        () => `@accessModelMetadata(key:${p.key} AND value:"${String(p.value).replace(/"/g, '\\"')}")`,
        warnings, `Metadata ${p.key}=${p.value}`
      );
      for (const id of matched) pooled[modeOf(p)].add(id);
    }
    const incPairs = pairs.filter((p) => modeOf(p) === "INCLUDE");
    const excPairs = pairs.filter((p) => modeOf(p) === "EXCLUDE");
    if (incPairs.length) { includes.push(pooled.INCLUDE); summary.push(`Only items tagged ${incPairs.map(pairText).join(" or ")}`); }
    if (excPairs.length) { excludes.push(pooled.EXCLUDE); summary.push(`Exclude items tagged ${excPairs.map(pairText).join(" or ")}`); }
  }

  if (includes.length === 0 && excludes.length === 0) return { active: false, allowed: null, summary, warnings };
  let allowed = new Set(heldIds);
  for (const inc of includes) allowed = new Set([...allowed].filter((id) => inc.has(id)));
  for (const exc of excludes) for (const id of exc) allowed.delete(id);
  return { active: true, allowed, summary, warnings };
}

// ─── Campaign naming / description ───────────────────────────────────────────

/** "jobTitle" -> "job title", "cost_center" -> "cost center" — for prose. */
function humanizeAttributeKey(key) {
  return String(key || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase()
    .trim();
}

/** [{key, value}] -> 'department is "Engineering" and whose location is "Austin"' */
function certificationCriteriaProse(values) {
  return values
    .map((v) => (v.missing ? `has no ${humanizeAttributeKey(v.key)}` : `${humanizeAttributeKey(v.key)} is "${v.value}"`))
    .join(" and whose ");
}

function certificationCampaignDescription({ values, settings }) {
  const undecided = settings.certUndecidedAccess === "REVOKE"
    ? "Any access still undecided when the campaign closes will be revoked automatically, so please make an explicit decision on every item."
    : "Any access still undecided when the campaign closes will be kept in place, so an item you do not act on stays with the user.";
  const comments =
    settings.certCommentRequirement === "ALL_DECISIONS" ? "A comment is required on every decision."
    : settings.certCommentRequirement === "REVOKE_ONLY_DECISIONS" ? "A comment is required whenever access is revoked."
    : "Comments are optional.";
  const covers = values.length > 0
    ? `This user access review covers every user whose ${certificationCriteriaProse(values)}. `
    : "This user access review covers every user in scope. ";
  return (
    covers +
    "Each user's manager reviews all of the access their direct reports currently hold — roles, access " +
    "profiles and entitlements — confirming that each item is still needed for the person's job and " +
    `revoking anything that is not. ${undecided} ${comments} ` +
    "Please complete your reviews before the deadline."
  );
}

// ─── Planning runner ─────────────────────────────────────────────────────────

async function runCertificationDrafts(runId) {
  // Cancel is asked for both ways: the in-page flag (scanJobs) and the
  // record's own cancelRequested, as the server's runner read it.
  const cancelled = async () => isCancelled(STORE, runId) || !!(await runs().get(runId))?.cancelRequested;

  try {
    const settings = await getStudioPreferences();
    // Certification Attributes chosen on Studio Settings > User
    // Certifications are what the population is split on — one campaign per
    // combination of their values. With none chosen there is nothing to
    // split on, so the run plans a SINGLE campaign covering every user the
    // rest of the criteria (scope, identity filters, item filters) selects,
    // rather than silently splitting on some other attribute.
    const attributeKeys = (settings.certAttributeKeys || []).filter((k) => !PEER_GROUP_STATUS_ATTRIBUTE_KEYS.has(k));
    const attributeSource = attributeKeys.length > 0 ? "certification-settings" : "all-users";
    const scopeQuery = (await getTenantSettings()).nameScope;
    const scopeIds = await fetchScopeIds(["identities"], scopeQuery);
    // Every identity's effective access comes back on the same search page
    // (roles, access profiles and entitlements — the item types an identity
    // certification reviews), so each campaign can report how many access
    // items its reviewers will see and list them on its detail page without
    // a second pass against ISC.
    const CERT_ACCESS_TYPES = ["ROLE", "ACCESS_PROFILE", "ENTITLEMENT"];
    const identityClause = certificationIdentityFilterClause(settings);
    const all = await searchAllIdentities({ pageSize: SEARCH_PAGE_SIZE, accessTypes: CERT_ACCESS_TYPES, query: identityClause || "*" });
    const identities = all.filter((idn) => isActiveIdentity(idn) && (!scopeIds || scopeIds.has(idn.id)));

    // One planned campaign per distinct COMBINATION of the certification
    // attributes' values (department × location when two are chosen), so
    // adding an attribute sub-divides the campaigns — the remedy offered
    // when one exceeds the Size Limit. An identity missing a value for an
    // attribute lands in a "(no <attribute>)" bucket rather than being
    // dropped, so every active in-scope user still gets reviewed. Buckets
    // are sorted by value so the results (and ISC's campaign list) read
    // alphabetically. Each carries its member list (with access) for the
    // campaign detail page and the detailed printout.
    const valueOf = (idn, key) => {
      const raw = idn.attributes.find((a) => a.key === key)?.value;
      return raw == null || String(raw).trim() === "" ? null : String(raw).trim();
    };
    // With no attributes every identity maps to the same empty tuple, so
    // this naturally yields exactly one bucket holding everyone.
    const byCombo = new Map(); // JSON tuple -> { values: [{key, value, missing}], group: [] }
    for (const idn of identities) {
      const values = attributeKeys.map((key) => {
        const v = valueOf(idn, key);
        return { key, value: v ?? `(no ${humanizeAttributeKey(key)})`, missing: v == null };
      });
      const tupleKey = JSON.stringify(values.map((v) => v.value));
      if (!byCombo.has(tupleKey)) byCombo.set(tupleKey, { values, group: [] });
      byCombo.get(tupleKey).group.push(idn);
    }
    const combos = [...byCombo.values()].sort((a, b) => {
      for (let i = 0; i < a.values.length; i += 1) {
        const c = a.values[i].value.localeCompare(b.values[i].value);
        if (c !== 0) return c;
      }
      return 0;
    });

    // Item filters resolve once per run against every access item any
    // scanned identity holds, then trim each member's list below.
    const heldIds = new Set();
    const heldTypes = new Map(); // id -> ROLE | ACCESS_PROFILE | ENTITLEMENT
    const heldSources = new Map(); // id -> granting source id (access profiles and entitlements only)
    for (const idn of identities) for (const a of idn.access || []) if (a.id) {
      heldIds.add(a.id);
      heldTypes.set(a.id, a.type);
      if (a.sourceId) heldSources.set(a.id, a.sourceId);
    }
    const filters = await resolveCertificationItemFilters(settings, heldIds, heldTypes, heldSources);
    const identitySummary = certificationIdentityFilterSummary(settings);
    await updateCertificationRun(runId, {
      filters: {
        active: filters.active,
        summary: [...(identitySummary ? [identitySummary] : []), ...filters.summary],
        warnings: filters.warnings,
        heldItems: heldIds.size,
        allowedItems: filters.allowed ? filters.allowed.size : heldIds.size,
        identityFilter: identityClause,
      },
    });

    const planned = [];
    for (const { values, group } of combos) {
      const members = group
        .map((idn) => {
          const held = idn.access || [];
          const kept = filters.allowed ? held.filter((a) => filters.allowed.has(a.id)) : held.slice();
          return {
            id: idn.id,
            name: idn.name,
            email: idn.email,
            manager: idn.manager?.name || null,
            access: kept.sort((a, b) => a.type.localeCompare(b.type) || String(a.name).localeCompare(String(b.name))),
            excludedAccessCount: held.length - kept.length,
          };
        })
        .sort((a, b) => String(a.name).localeCompare(String(b.name)));
      const countType = (t) => members.reduce((n, m) => n + m.access.filter((a) => a.type === t).length, 0);
      const roleCount = countType("ROLE");
      const accessProfileCount = countType("ACCESS_PROFILE");
      const entitlementCount = countType("ENTITLEMENT");
      planned.push({
        // attributeKey/value stay for the row label ("department > location"
        // / "Engineering - Austin"); `values` is the structured criteria.
        attributeKey: attributeKeys.join(" > "),
        value: values.map((v) => v.value).join(" - ") || ALL_USERS_BASE_NAME,
        values,
        identityCount: members.length,
        accessCount: roleCount + accessProfileCount + entitlementCount,
        excludedAccessCount: members.reduce((n, m) => n + (m.excludedAccessCount || 0), 0),
        roleCount, accessProfileCount, entitlementCount,
        members,
      });
    }

    // For the "too large" remedy: Schema Analysis candidates not already
    // in use, best-scoring first — the attribute(s) to add next.
    const analysis = await recordStore("schema-analysis").get(tenantKey());
    const unusedCandidates = (analysis?.candidates || [])
      .map((c) => c.key)
      .filter((k) => !attributeKeys.includes(k) && !PEER_GROUP_STATUS_ATTRIBUTE_KEYS.has(k));
    const sizeLimit = Number(settings.certSizeLimit) || 10000;

    await updateCertificationRun(runId, {
      attributeKeys,
      attributeSource,
      scopeQuery: scopeIds ? scopeQuery : null,
      totalIdentities: identities.length,
      planned: planned.length,
      settings: {
        certNotificationsEnabled: settings.certNotificationsEnabled,
        certUndecidedAccess: settings.certUndecidedAccess,
        certCommentRequirement: settings.certCommentRequirement,
        certDurationDays: settings.certDurationDays,
        certCampaignPrefix: typeof settings.certCampaignPrefix === "string" ? settings.certCampaignPrefix : "",
        certCampaignSuffix: typeof settings.certCampaignSuffix === "string" ? settings.certCampaignSuffix : "",
        certSizeLimit: sizeLimit,
        certAccessItemTypes: settings.certAccessItemTypes,
        certExcludedSources: Array.isArray(settings.certExcludedSources) ? settings.certExcludedSources : [],
        certExcludeBirthrightRoles: settings.certExcludeBirthrightRoles === true,
        certIncludeCommonAccessRoles: settings.certIncludeCommonAccessRoles === true,
        certPrivilegeFilters: settings.certPrivilegeFilters,
        certPrivilegeLevel: settings.certPrivilegeLevel,
        certPrivilegeMode: settings.certPrivilegeMode,
        certMetadataFilters: settings.certMetadataFilters,
        certMetadataMode: settings.certMetadataMode,
        certSearchFilter: settings.certSearchFilter,
        certSearchMode: settings.certSearchMode,
      },
    });

    // Planning only — nothing is sent to ISC here. Each campaign is fully
    // prepared (name, description, query, members, counts) and then created
    // in ISC on demand from the drafts screen (createCertificationCampaign),
    // one at a time or all at once, so a reviewer can vet the plan first.
    const results = [];
    let tooLarge = 0;
    for (const item of planned) {
      if (await cancelled()) {
        await updateCertificationRun(runId, { status: "cancelled", completedAt: new Date().toISOString(), results, tooLarge });
        return;
      }
      // Root name is just the attribute value(s); "user access review" now
      // lives in the (editable) Campaign Suffix default.
      const name = certificationCampaignName(item.value || ALL_USERS_BASE_NAME, settings);
      const description = certificationCampaignDescription({ values: item.values, settings });
      // One exact-match clause per attribute; a "(no X)" bucket becomes a
      // NOT-exists clause so the campaign still selects exactly those users.
      const clauses = item.values.map(({ key, value, missing }) => {
        const k = sanitizeAttributeKey(key);
        return missing ? `NOT attributes.${k}:*` : `attributes.${k}:"${value.replace(/"/g, '\\"')}"`;
      });
      // No attributes means no value clause at all — the campaign selects on
      // scope and the identity filters alone.
      const valueClause = clauses.length === 0 ? null : clauses.length === 1 ? clauses[0] : `(${clauses.join(" AND ")})`;
      // The same Scan Scope Mining Config applies to role mining narrows the
      // campaign too, so a scoped tenant never certifies out-of-scope users.
      // With no attributes, no scope and no identity filter there is nothing
      // left to narrow on, so match everyone rather than send ISC an empty
      // query.
      const query = [
        scopeIds && scopeQuery ? `(${scopeQuery})` : null,
        identityClause,
        valueClause,
      ].filter(Boolean).join(" AND ") || "*";

      // Size Limit (Studio Settings > User Certifications): a campaign whose
      // total access items exceed it is flagged and can't be created, with
      // the remedy of adding another attribute to sub-divide it.
      if (item.accessCount > sizeLimit) {
        tooLarge += 1;
        const another = attributeKeys.length > 0 ? "another " : "a ";
        const suggestion = unusedCandidates.length > 0
          ? `Add ${another}Certification Attribute (e.g. ${unusedCandidates.slice(0, 2).join(" or ")}) in Studio Settings → User Certifications to sub-divide this campaign so each part fits within the limit.`
          : "No further Schema Analysis attribute is available to sub-divide by — narrow the Scan Scope in Mining Config, or raise the Size Limit.";
        results.push({
          ...item, name, description, query,
          status: "too-large", ok: false, tooLarge: true, campaignId: null,
          error: `Too large — ${item.accessCount.toLocaleString()} access items exceeds the Size Limit of ${sizeLimit.toLocaleString()}. ${suggestion}`,
        });
      } else if (filters.active && item.accessCount === 0) {
        results.push({
          ...item, name, description, query,
          status: "empty", ok: false, tooLarge: false, campaignId: null,
          error: `Nothing to certify — the campaign filters exclude every access item these ${item.identityCount} user${item.identityCount === 1 ? "" : "s"} hold.`,
        });
      } else {
        results.push({ ...item, name, description, query, status: "planned", ok: false, tooLarge: false, campaignId: null, error: null });
      }
    }

    await updateCertificationRun(runId, {
      status: "completed",
      completedAt: new Date().toISOString(),
      results, tooLarge, created: 0, failed: 0,
    });
  } catch (err) {
    console.error("[certifications] run failed:", err.response?.data || err.message);
    await updateCertificationRun(runId, {
      status: "failed",
      completedAt: new Date().toISOString(),
      error: describeError(err),
    });
  }
}

// ─── Routes ──────────────────────────────────────────────────────────────────

/** POST /api/insights/certification-runs — start planning campaign drafts; { runId }. */
export async function startCertificationRun() {
  const runId = newScanId("cert");
  await updateCertificationRun(runId, {
    id: runId,
    tenant: tenantKey(),
    status: "running",
    startedAt: new Date().toISOString(),
    completedAt: null,
    cancelRequested: false,
    attributeKeys: [],
    planned: 0,
    created: 0,
    failed: 0,
    tooLarge: 0,
    results: [],
    error: null,
  });
  startJob(STORE, runId, () => runCertificationDrafts(runId));
  return { runId };
}

/** GET /api/insights/certification-runs — list, newest first (results stripped for size). */
export async function listCertificationRuns() {
  await failInterrupted(STORE);
  const tenant = tenantKey();
  return Object.values(await runs().all())
    .filter((r) => r.tenant === tenant)
    .map(({ results, ...meta }) => meta)
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
}

/**
 * GET /api/insights/certification-runs/:id — full record, including
 * per-campaign results. Member lists (every user's every access item) are
 * the bulk of a run; the drafts screen only needs the per-campaign counts,
 * so they're stripped unless `full` asks for them (the detailed printout does).
 */
export async function getCertificationRun(runId, { full = false } = {}) {
  await failInterrupted(STORE);
  const run = await runForTenant(runId);
  if (!run) throw badRequest(NOT_FOUND, 404);
  if (full) return run;
  return { ...run, results: stripMembers(run.results) };
}

/**
 * GET /api/insights/certification-runs/:id/campaigns/:index
 * One campaign from the run, members and their access included, plus the
 * run's own settings/metadata (results stripped) for the detail header.
 */
export async function getCertificationRunCampaign(runId, index) {
  await failInterrupted(STORE);
  const run = await runForTenant(runId);
  if (!run) throw badRequest(NOT_FOUND, 404);
  const i = Number(index);
  const campaign = Number.isInteger(i) ? (run.results || [])[i] : null;
  if (!campaign) throw badRequest(CAMPAIGN_NOT_FOUND, 404);
  const { results, ...meta } = run;
  return { run: meta, index: i, campaign };
}

/** The surviving access-item ids of a planned campaign, one SELECTED constraint per type present. */
function certificationAccessConstraints(item) {
  const byType = new Map();
  for (const m of item.members || []) {
    for (const a of m.access || []) {
      if (!a.id || !a.type) continue;
      if (!byType.has(a.type)) byType.set(a.type, new Set());
      byType.get(a.type).add(a.id);
    }
  }
  return [...byType.entries()].map(([type, ids]) => ({ type, operator: "SELECTED", ids: [...ids] }));
}

/**
 * POST /api/insights/certification-runs/:id/campaigns/:index/create
 * Creates ONE planned campaign from the run in ISC, as a STAGED draft
 * (never activated from here), using the settings snapshot the run was
 * planned with; the deadline is Duration from now, since creation can
 * happen well after planning. "Create All" on the drafts screen calls this
 * once per eligible campaign, sequentially, so each has its own outcome and
 * a failed one can simply be retried. Refuses a too-large campaign and one
 * that already exists in ISC. Resolves with the updated row (members
 * stripped); rejects with ISC's error.
 */
export async function createCertificationCampaign(runId, index) {
  const run = await runForTenant(runId);
  if (!run) throw badRequest(NOT_FOUND, 404);
  if (run.status === "running") throw badRequest("Wait for planning to finish first.");
  const i = Number(index);
  const item = Number.isInteger(i) ? (run.results || [])[i] : null;
  if (!item) throw badRequest(CAMPAIGN_NOT_FOUND, 404);
  if (item.tooLarge) throw badRequest("This campaign exceeds the Size Limit — sub-divide it first.");
  if (item.status === "empty") throw badRequest("Nothing to certify — the campaign filters exclude every access item here.");
  if (item.campaignId) throw badRequest("This campaign has already been created in ISC.");

  const settings = { ...DEFAULT_STUDIO_PREFERENCES, ...(run.settings || {}) };
  const deadline = new Date(Date.now() + (Number(settings.certDurationDays) || 30) * 24 * 60 * 60 * 1000).toISOString();
  const wasFailed = item.status === "failed";
  try {
    const created = await withApiRetry(
      () => iscPost("/v2026/campaigns", {
        name: item.name,
        description: item.description,
        deadline,
        type: "SEARCH",
        emailNotificationEnabled: !!settings.certNotificationsEnabled,
        autoRevokeAllowed: settings.certUndecidedAccess === "REVOKE",
        recommendationsEnabled: false,
        mandatoryCommentRequirement: settings.certCommentRequirement,
        searchCampaignInfo: {
          type: "IDENTITY",
          description: item.description,
          query: item.query,
          // With item filters active, the campaign is limited to exactly
          // the access items that survived them (per type). Without
          // filters the constraints are omitted, i.e. all access.
          ...(run.filters?.active ? { accessConstraints: certificationAccessConstraints(item) } : {}),
        },
      }),
      { label: `certifications: create campaign "${item.name}"` }
    );
    const updated = {
      ...item,
      status: "created", ok: true, error: null,
      campaignId: created?.id || null,
      campaignStatus: created?.status || null,
      deadline,
      createdAt: new Date().toISOString(),
    };
    const results = run.results.map((r, idx) => (idx === i ? updated : r));
    await updateCertificationRun(run.id, {
      results,
      created: (run.created || 0) + 1,
      failed: Math.max(0, (run.failed || 0) - (wasFailed ? 1 : 0)),
    });
    const { members, ...slim } = updated;
    return slim;
  } catch (err) {
    console.error(`[certifications] campaign "${item.name}" failed:`, err.response?.data || err.message);
    const updated = { ...item, status: "failed", ok: false, error: describeError(err) };
    const results = run.results.map((r, idx) => (idx === i ? updated : r));
    await updateCertificationRun(run.id, { results, failed: (run.failed || 0) + (wasFailed ? 0 : 1) });
    throw routeError(err);
  }
}

/**
 * POST /api/insights/certification-runs/:id/sync-status
 * Re-reads every created campaign from ISC and records its current status
 * (PENDING while ISC generates certifications → STAGED once it's a real
 * draft; ERROR/COMPLETED when nothing was certifiable), certification
 * counts and ISC's own alerts. A campaign that no longer exists in ISC is
 * marked deleted. Returns the run with members stripped, like getCertificationRun.
 */
export async function syncCertificationRunStatus(runId) {
  const run = await runForTenant(runId);
  if (!run) throw badRequest(NOT_FOUND, 404);

  try {
    const checkedAt = new Date().toISOString();
    const results = await Promise.all((run.results || []).map(async (r) => {
      if (!r.campaignId) return r;
      try {
        const c = await withApiRetry(() => iscGet(`/v2026/campaigns/${r.campaignId}`), { label: `certifications: status ${r.campaignId}` });
        return {
          ...r,
          campaignStatus: c.status || r.campaignStatus || null,
          totalCertifications: c.totalCertifications ?? null,
          completedCertifications: c.completedCertifications ?? null,
          iscAlerts: Array.isArray(c.alerts) ? c.alerts.map((a) => a.localizations?.[0]?.text || a.text || a.level || JSON.stringify(a)) : [],
          iscDeadline: c.deadline || r.deadline || null,
          statusCheckedAt: checkedAt,
        };
      } catch (err) {
        if (err.response?.status === 404) {
          return { ...r, campaignStatus: "DELETED", iscAlerts: ["This campaign no longer exists in ISC."], statusCheckedAt: checkedAt };
        }
        return { ...r, iscAlerts: [`Status check failed: ${describeError(err)}`], statusCheckedAt: checkedAt };
      }
    }));
    const fresh = await updateCertificationRun(run.id, { results });
    return { ...fresh, results: stripMembers(fresh.results) };
  } catch (err) {
    console.error("[certifications] sync-status failed:", err.response?.data || err.message);
    throw routeError(err);
  }
}

/** POST /api/insights/certification-runs/:id/cancel — stop before the next campaign is planned. */
export async function cancelCertificationRun(runId) {
  const run = await runForTenant(runId);
  if (!run) throw badRequest(NOT_FOUND, 404);
  if (run.status !== "running") throw badRequest("This run is no longer running.");
  requestCancel(STORE, runId);
  await updateCertificationRun(run.id, { cancelRequested: true });
  return { ok: true };
}

/** DELETE /api/insights/certification-runs/:id — removes this app's record only; campaigns stay in ISC. */
export async function deleteCertificationRun(runId) {
  const run = await runForTenant(runId);
  if (!run) throw badRequest(NOT_FOUND, 404);
  if (run.status === "running") {
    throw badRequest("Wait for the run to finish (or cancel it) before removing it.");
  }
  await runs().delete(runId);
}
