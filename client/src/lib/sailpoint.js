/**
 * sailpoint.js
 * All SailPoint API calls in Admin Studio.
 *
 * Admin Studio runs as an ISC UI plugin, so there is no proxy server and no
 * sign-in. Requests addressed to /api/isc/<version>/<path> are sent straight
 * to the tenant's API from the browser, carrying the plugin-scoped access
 * token the App Shell issued to the signed-in user (see the request
 * interceptor below and lib/pluginSdk). Anything else under /api/ was a
 * route of the old Express server and is not available in the plugin until
 * that logic is ported into the client.
 */

import axios from "axios";
import { getApiConfig } from "./pluginSdk";
import * as PortedRoles from "./ported/roles";
import * as PortedRoleDimensions from "./ported/roleDimensions";
import * as PortedRoleMembers from "./ported/roleMembers";
import * as PortedCommonAccess from "./ported/roleCommonAccess";
import * as PortedRoleEvaluation from "./ported/roleEvaluation";
import * as PortedSources from "./ported/sources";
import * as PortedSchemas from "./ported/sourceSchemas";
import * as PortedIdProfile from "./ported/sourceIdentityProfile";
import * as PortedCustomizers from "./ported/connectorCustomizers";
import * as identitiesPort from "./ported/identities";
import * as PortedAi from "./ported/aiDescriptions";
import * as PortedSettings from "./ported/settings";
import * as PortedSegments from "./ported/segments";
import * as PortedIdentityProfiles from "./ported/identityProfiles";
import * as PortedWorkgroups from "./ported/workgroups";
import * as PortedLaunchers from "./ported/launchers";
import * as PortedTenantInfo from "./ported/tenantInfo";
import * as PortedEntitlements from "./ported/entitlements";
import * as PortedAccessProfiles from "./ported/accessProfiles";
import * as PortedMetadata from "./ported/metadataTagging";
import * as PortedWorkflows from "./ported/workflows";
import * as PortedJsonEdit from "./ported/jsonEdit";
import * as PortedReports from "./ported/reports";
import * as PortedCampaignReports from "./ported/campaignReports";
import * as PortedSpConfig from "./ported/spConfig";
import * as PortedRoleEvalScans from "./ported/roleEvalScans";
import * as PortedCertRuns from "./ported/certificationRuns";

// Kept for call sites that still prefix URLs with it; same-origin, so empty.
const API_BASE = "";

/** The tenant API host this app talks to — for display only. */
export function apiServerHost() {
  try {
    return new URL(_apiBase || window.location.origin).host;
  } catch {
    return window.location.host;
  }
}

// Browse list screens (Roles, Access Profiles, Sources, ...) used to fetch
// a single fixed-size page and stop there — anything past that page (e.g.
// roles 101-155 in a tenant with 155 defined) was silently invisible to the
// whole screen: not just unlisted, but also absent from Select All, bulk
// actions, and print, with nothing indicating the list was incomplete.
// Pages this size (100) with a query that returns fewer than `pageSize`
// results.
export async function fetchAllPages(fetchPage, { pageSize = 100 } = {}) {
  const all = [];
  let offset = 0;
  while (true) {
    const page = await fetchPage({ limit: pageSize, offset });
    if (!Array.isArray(page) || page.length === 0) break;
    all.push(...page);
    if (page.length < pageSize) break;
    offset += pageSize;
  }
  return all;
}

let _creds = null; // { tenant, identityId }
let _apiBase = null;

export function setCredentials(creds) {
  _creds = creds;
}

export function getCredentials() {
  return _creds;
}

export function clearCredentials() {
  _creds = null;
}

// The scoped token is attached centrally by the request interceptor.
function authHeaders() {
  return {};
}

const ISC_PREFIX = "/api/isc/";

axios.interceptors.request.use(async (config) => {
  const url = String(config.url || "");
  if (url.startsWith(ISC_PREFIX)) {
    const { baseUrl, token } = await getApiConfig();
    _apiBase = baseUrl;
    config.url = `${baseUrl}/${url.slice(ISC_PREFIX.length)}`;
    config.headers = config.headers || {};
    config.headers.Authorization = `Bearer ${token}`;
    return config;
  }
  if (url.startsWith("/api/")) {
    // Not an ISC call: a route of the retired Express server.
    const error = new Error("This feature is not yet available in the Identity Security Cloud plugin.");
    error.config = config;
    error.response = { status: 501, data: { error: error.message }, headers: {} };
    error.isPluginUnavailable = true;
    throw error;
  }
  return config;
});


/**
 * Every list this app shows is sorted. Server-paginated lists are sorted by
 * ISC (sorters / search sort); full lists fetched in one go are sorted here,
 * once, so pages and pickers never have to remember to. Case-insensitive,
 * locale-aware, by the first of `keys` present on each item.
 */
export function sortByName(items, keys = ["name"]) {
  // A missing/non-array list sorts to [] — callers render the result
  // directly (dimensions.length, entitlements.map, ...), as they always did.
  if (!Array.isArray(items)) return [];
  const label = (x) => {
    for (const k of keys) {
      const v = k.split(".").reduce((o, p) => (o == null ? o : o[p]), x);
      if (v != null && v !== "") return String(v);
    }
    return "";
  };
  return items.slice().sort((a, b) => label(a).localeCompare(label(b), undefined, { sensitivity: "base", numeric: true }));
}

/** Low-level request — all ISC paths are prefixed with /v2026 */
async function req(method, path, { params, data } = {}) {
  const resp = await axios({
    method,
    url: `${API_BASE}/api/isc/v2026${path}`,
    params,
    data,
    headers: authHeaders(),
  });
  return resp.data;
}

/** Real total via the X-Total-Count header — limit:1 + count:true avoids
 *  fetching every row just to know how many there are. */
async function getCount(path, params = {}) {
  const resp = await axios({
    method: "GET",
    url: `${API_BASE}/api/isc/v2026${path}`,
    params: { ...params, limit: 1, count: true },
    headers: authHeaders(),
  });
  const header = resp.headers["x-total-count"];
  return header != null ? Number(header) : (Array.isArray(resp.data) ? resp.data.length : 0);
}

// ─── Identities ───────────────────────────────────────────────────────────────

// Backed by the server's own /api/identities (Search API under the hood,
// not /public-identities) so it can filter by Identity Profile, lifecycle
// state, and arbitrary attribute=value — /public-identities rejects all of
// those as "not queryable".
export async function listIdentities({ limit = 20, offset = 0, query, identityProfileId, lifecycleState, attributeKey, attributeValue } = {}) {
  return identitiesPort.listIdentities({ limit, offset, query, identityProfileId, lifecycleState, attributeKey, attributeValue });
}

// Same list, plus the total for that search/filter combination from the
// server's X-Total-Count header: { identities, total } (total null if the
// header is missing). For the paged Identities list; pickers use
// listIdentities above.
export async function listIdentitiesPage(params) {
  return identitiesPort.listIdentitiesPage(params);
}

// The full list of the tenant's Identity Profiles (id/name), used to
// populate the Identities list's Identity Profile filter pill directly —
// not derived by scanning identities for the profiles they happen to use.
export async function listIdentityProfiles() {
  return sortByName(await PortedIdentityProfiles.listIdentityProfiles());
}

// ISC's "Apply Changes" — re-evaluates every identity under the profile
// against its current mappings. Asynchronous: resolves once ISC accepts it.
export async function processIdentityProfile(id) {
  return PortedIdentityProfiles.processIdentityProfile(id);
}

export async function deleteIdentityProfile(id) {
  await PortedIdentityProfiles.deleteIdentityProfile(id);
}

export async function getIdentity(id) {
  return req("GET", `/identities/${id}`);
}

// The identity/user schema (name + displayName for every configured
// attribute, standard and custom) — used to populate the attribute picker
// when defining a role dimension's membership criterion.
export async function listIdentityAttributes() {
  return sortByName(await req("GET", "/identity-attributes", { params: { limit: 250 } }), ["displayName", "name"]);
}

// Not an ISC passthrough — hits the server's own lifecycle-state helper,
// which resolves the identity's profile/lifecycle states then calls
// /identities/{id}/set-lifecycle-state.
export async function setIdentityLifecycleState(id, state) {
  return identitiesPort.setIdentityLifecycleState(id, state);
}

// The lifecycle states this identity can be moved to — its own identity
// profile's — with the current one and what each does on entry (account
// enable / disable / DELETE per source, remove-all-access, notifications),
// and whether the profile calculates the state from source data (then a
// manual change only holds until the next refresh). See the server route.
export async function getIdentityLifecycleStates(id) {
  return identitiesPort.getIdentityLifecycleStates(id);
}

// Moves the identity to one specific lifecycle state of its profile.
export async function moveIdentityToLifecycleState(id, lifecycleStateId) {
  return identitiesPort.moveIdentityToLifecycleState(id, lifecycleStateId);
}

// View-only: the roles/access profiles this identity currently holds
// (per the Search API's denormalized identity document), for the Identity
// Detail Roles/Access Profiles tabs.
export async function getIdentityAccess(identityId, type) {
  return identitiesPort.getIdentityAccess(identityId, type);
}

export async function getIdentityAccounts(identityId) {
  // Sorting by the account's own "name" is a no-op in practice — an
  // identity's accounts are almost always all named after the person, so
  // every row ties and the list looks unsorted. What the panel actually
  // displays as each row's primary label is the source name, so that's
  // what's sorted (verified against a real multi-account identity).
  return reqAccountsV2025({ filters: `identityId eq "${identityId}"`, sorters: "source.displayableName", limit: 50 });
}

// GET /accounts pinned to v2025. On this tenant the v2026 endpoint no longer
// matches its own spec: depending on the backend that answers, it rejects the
// documented filters ("identityId", "sourceId" → 400 "Properties are not
// queryable") and returns a different schema (source{} / correlatedIdentity{}
// and epoch timestamps instead of sourceId / sourceName / identity{} and ISO
// dates). v2025 still behaves as documented — verified live — and returns the
// shape the app's account panels were written against.
async function reqAccountsV2025(params) {
  const resp = await axios.get(`${API_BASE}/api/isc/v2025/accounts`, { params, headers: authHeaders() });
  return resp.data;
}

// Not the generic /api/isc proxy — routed through a dedicated server route
// that resolves each entitlement's real name and source, since the raw ISC
// endpoint returns a raw attribute value as "name" for many sources.
export async function getIdentityEntitlements(identityId, { limit = 50 } = {}) {
  return identitiesPort.getIdentityEntitlements(identityId, { limit });
}

export async function getEntitlement(id) {
  return req("GET", `/entitlements/${id}`);
}

// Not a plain REST filter — /v2026/entitlements/... has no "who has this"
// sub-resource. Uses the Search API's nested @access query against the
// identities index instead (verified live: @access(id:"...") — no ".exact"
// suffix — correctly matches identities whose access array contains this
// entitlement id; x-total-count on the response gives the real total even
// though only `limit` rows come back; offset paging verified to return
// distinct, correctly-sorted pages; @access(...) AND name:*term* verified
// live to combine correctly for the search box).
export async function listEntitlementMembers(entitlementId, { limit = 50, offset = 0, query } = {}) {
  // Strips anything that could break the Lucene-style query syntax (quotes,
  // parens, colons, wildcards) before wrapping it in our own wildcards —
  // this is a search box, not a security boundary, but a stray character
  // shouldn't be able to turn "search by name" into "search by something else".
  const term = (query || "").replace(/[^\w\s'-]/g, "").trim();
  const searchClause = term ? ` AND name:*${term}*` : "";
  const resp = await axios({
    method: "POST",
    url: `${API_BASE}/api/isc/v2026/search`,
    params: { limit, offset, count: true },
    data: {
      indices: ["identities"],
      query: { query: `@access(id:"${entitlementId}")${searchClause}` },
      sort: ["name"],
    },
    headers: authHeaders(),
  });
  const total = resp.headers["x-total-count"];
  return { members: resp.data, total: total != null ? Number(total) : resp.data.length };
}

// Fallback member list read straight from the source's accounts — used
// when @access() search finds nobody (fresh delimited-source grants that
// haven't been indexed yet). Returns { members, total, uncorrelated }.
export async function listEntitlementAccountMembers(entitlementId) {
  return PortedEntitlements.listEntitlementAccountMembers(entitlementId);
}

// Global Access Model Metadata attributes and their registered values.
export async function listMetadataAttributes() {
  return sortByName(await req("GET", "/access-model-metadata/attributes", { params: { limit: 250 } }), ["name", "key"]);
}
export async function getMetadataAttribute(key) {
  return req("GET", `/access-model-metadata/attributes/${encodeURIComponent(key)}`);
}
export async function listMetadataAttributeValues(key) {
  return sortByName(await req("GET", `/access-model-metadata/attributes/${encodeURIComponent(key)}/values`, { params: { limit: 250 } }), ["name", "value"]);
}

// Assign / remove one metadata value on an entitlement (server handles the
// v2026->beta root probe and ad-hoc value registration).
export async function addEntitlementMetadata(entitlementId, { key, value, name }) {
  return PortedMetadata.addEntitlementMetadata(entitlementId, { key, value, name });
}
// Workflow action schemas — every action's typed input fields (formFields),
// the same schema SailPoint's own builder renders from. Cached per session.
export async function listWorkflowLibraryActions() {
  return req("GET", "/workflow-library/actions", { params: { limit: 100 } });
}

// ─── Forms (Custom Forms API) ────────────────────────────────────────────
export async function listFormDefinitions() {
  const data = await req("GET", "/form-definitions", { params: { limit: 250 } });
  return sortByName(data?.results || data || []);
}
export async function getFormDefinition(id) {
  return req("GET", `/form-definitions/${id}`);
}
export async function deleteFormDefinition(id) {
  return req("DELETE", `/form-definitions/${id}`);
}

// ─── Mail Distribution Group mining ─────────────────────────────────────
export async function listAdOus(sourceId) {
  // The route answers { ous: [{ dn, count }] } (already ordered by count) —
  // DistributionGroupsPage reads `.ous`.
  return PortedSources.listAdOus(sourceId);
}
export async function startDlScan({ targetType, sourceId, sourceName, ou }) {
  const resp = await axios.post(`${API_BASE}/api/insights/dl-scans`, { targetType, sourceId, sourceName, ou }, { headers: authHeaders() });
  return resp.data;
}
export async function getDlScan(id) {
  const resp = await axios.get(`${API_BASE}/api/insights/dl-scans/${id}`, { headers: authHeaders() });
  return resp.data;
}
export async function createDlGroups(id, suggestionIds) {
  const resp = await axios.post(`${API_BASE}/api/insights/dl-scans/${id}/create`, { suggestionIds }, { headers: authHeaders() });
  return resp.data;
}
// After the groups exist and aggregation ran: attach each DL entitlement to
// its matching mined role so role membership provisions the DL's members.
export async function addDlGroupsToRoles(id, suggestionIds) {
  const resp = await axios.post(`${API_BASE}/api/insights/dl-scans/${id}/add-to-roles`, { suggestionIds }, { headers: authHeaders() });
  return resp.data;
}

// Assign / remove one metadata value on a role, access profile or
// entitlement — kind: "roles" | "access-profiles" | "entitlements". The
// server registers an ad-hoc value first when `name` is given, and probes
// which API root serves the per-item route on this tenant.
export async function addObjectMetadata(kind, id, { key, value, name }) {
  return PortedMetadata.addObjectMetadata(kind, id, { key, value, name });
}
export async function removeObjectMetadata(kind, id, key, value) {
  return PortedMetadata.removeObjectMetadata(kind, id, key, value);
}

// Adds one metadata value to — or removes it from — every listed object.
// kind: "roles" | "access-profiles" | "entitlements"; operation: "add" |
// "remove". { done, skipped, failed: [{ id, error }] } — on remove, objects
// that don't carry the value are `skipped`, not failed.
export async function bulkTagMetadata(kind, { operation, key, value, name, ids }) {
  return PortedMetadata.bulkTagMetadata(kind, { operation, key, value, name, ids });
}

// Tag many entitlements with one metadata value in a single server call.
export async function bulkTagEntitlementMetadata({ key, value, name, entitlementIds }) {
  return PortedMetadata.bulkTagEntitlementMetadata({ key, value, name, entitlementIds });
}

export async function removeEntitlementMetadata(entitlementId, key, value) {
  return PortedMetadata.removeEntitlementMetadata(entitlementId, key, value);
}

// Same reasoning as listEntitlementMembers — /v2026/roles and
// /v2026/access-profiles both reject "entitlements.id eq ..." as not
// queryable, but the Search API's roles/accessprofiles indices carry a
// denormalized `entitlements` array and DO support filtering on it
// (verified live: entitlements.id:"<id>" correctly matched roles/access
// profiles known to include that entitlement).
export async function listRolesByEntitlement(entitlementId, { limit = 100 } = {}) {
  const resp = await axios({
    method: "POST",
    url: `${API_BASE}/api/isc/v2026/search`,
    params: { limit },
    data: {
      indices: ["roles"],
      query: { query: `entitlements.id:"${entitlementId}"` },
      sort: ["name"],
    },
    headers: authHeaders(),
  });
  return resp.data;
}

export async function listAccessProfilesByEntitlement(entitlementId, { limit = 100 } = {}) {
  const resp = await axios({
    method: "POST",
    url: `${API_BASE}/api/isc/v2026/search`,
    params: { limit },
    data: {
      indices: ["accessprofiles"],
      query: { query: `entitlements.id:"${entitlementId}"` },
      sort: ["name"],
    },
    headers: authHeaders(),
  });
  return resp.data;
}

// Verified against the live tenant: "source.id eq" is the queryable filter —
// "sourceId eq" is rejected as non-queryable despite looking equally plausible.
// "co" (contains) on name combines with it fine (verified live) for the
// search box on Source Detail's Entitlements panel.
export async function listEntitlementsBySource(sourceId, { limit = 100, offset = 0, query } = {}) {
  const filters = `source.id eq "${sourceId}"` + (query ? ` and name co "${query}"` : "");
  return req("GET", "/entitlements", {
    params: { filters, sorters: "name", limit, offset },
  });
}

/** How many entitlements a source has (optionally matching a name search) — from ISC's count header, no rows fetched. */
export function countEntitlementsBySource(sourceId, { query } = {}) {
  const filters = `source.id eq "${sourceId}"` + (query ? ` and name co "${query}"` : "");
  return getCount("/entitlements", { filters });
}

/** Every entitlement on a source, for a printout — pages of 250 until exhausted. */
export function listAllEntitlementsBySource(sourceId, { query } = {}) {
  return fetchAllPages((page) => listEntitlementsBySource(sourceId, { ...page, query }), { pageSize: 250 });
}

// Sentinel passed as `ownerId` to mean "no owner set" rather than a real
// identity id — used by the Owner filter's "No Owner" option (Entitlements
// today; the same constant is meant to be reused by any other list that
// grows an owner filter later, so there's one shared meaning for it instead
// of each page inventing its own).
export const NO_OWNER = "__NO_OWNER__";

// Tenant-wide entitlement list for the Entitlements browse page — same
// "source.id eq" + "name co" filter shape as listEntitlementsBySource
// above, just without the source clause, plus offset so the page can be
// paged rather than bulk-fetched (a tenant's entitlement count routinely
// dwarfs its identity count — every group on every source is one — so this
// follows IdentitiesPage's paginated pattern, not Roles'/Access Profiles'
// fetchAllPages one).
// "No owner" genuinely can't be expressed as a server-side filter on this
// endpoint — verified live, in order: bare "owner" isn't queryable at all
// (400 "Invalid filter properties: [owner]"); "owner.id" is queryable but
// only for EQ (400 "Invalid filter operations [NOTNULL/PR] for property
// owner.id — Allowed operations: [EQ]" on both "not owner.id pr" and a bare
// "owner.id pr"); and "owner.id eq null" 400s too ("Illegal value... for
// field..." — null isn't accepted as an EQ operand either). ISC's filter
// grammar has no operator left that means "not set" for this field. So
// `ownerId === NO_OWNER` is deliberately NOT turned into a filter clause
// here — EntitlementsPage instead fetches every page matching the other
// filters and filters out `owner` client-side (see its noOwnerQuery).
function entitlementListFilters({ query, sourceId, ownerId, requestable } = {}) {
  const clauses = [];
  if (sourceId) clauses.push(`source.id eq "${sourceId}"`);
  if (ownerId && ownerId !== NO_OWNER) clauses.push(`owner.id eq "${ownerId}"`);
  if (requestable === true) clauses.push(`requestable eq true`);
  if (requestable === false) clauses.push(`requestable eq false`);
  if (query) clauses.push(`name co "${String(query).replace(/"/g, '\\"')}"`);
  return clauses.join(" and ") || undefined;
}

export async function listEntitlements({ limit = 50, offset = 0, query, sourceId, ownerId, requestable } = {}) {
  return req("GET", "/entitlements", {
    params: { filters: entitlementListFilters({ query, sourceId, ownerId, requestable }), sorters: "name", limit, offset },
  });
}

export async function getEntitlementsCount({ query, sourceId, ownerId, requestable } = {}) {
  const filters = entitlementListFilters({ query, sourceId, ownerId, requestable });
  return getCountOrNoAccess("/entitlements", filters ? { filters } : undefined);
}

// Entitlements have no direct app link in ISC's model — an Application
// only grants access through the Access Profiles assigned to it — so this
// hits a dedicated server route that joins access-profiles-containing-this-
// entitlement against apps-on-this-entitlement's-source, rather than
// something reachable as a plain filter.
export async function listEntitlementApplications(entitlementId) {
  return PortedEntitlements.listEntitlementApplications(entitlementId);
}

// Hierarchical entitlements (e.g. nested AD groups via memberOf) — ISC's
// own dedicated sub-resources for this, not something derivable from the
// plain entitlement GET. Same generic-proxy pattern as getEntitlement.
export async function listEntitlementParents(entitlementId) {
  return req("GET", `/entitlements/${entitlementId}/parents`);
}

export async function listEntitlementChildren(entitlementId) {
  return req("GET", `/entitlements/${entitlementId}/children`);
}

// fields: any of { name, description, owner: {id,name}, requestable }
export async function updateEntitlement(id, fields) {
  return PortedEntitlements.updateEntitlement(id, fields);
}

// Returns a suggested description only — never writes to the entitlement
// itself. Same shape as generateAccessProfileDescription.
export async function generateEntitlementDescription(id) {
  return PortedAi.generateEntitlementDescription(id);
}

// { results: [{ roleId, description } | { roleId, error }] } — keyed
// "roleId" server-side (not "entitlementId") so the result feeds
// BulkDescriptionReviewSheet unchanged — same shape as
// generateAllAccessProfileDescriptions.
export async function generateAllEntitlementDescriptions(entitlementIds) {
  return PortedAi.generateAllEntitlementDescriptions(entitlementIds);
}

// Not an ISC passthrough — hits the server's own endpoint. Which property
// actually filters /v2026/accounts by source (source.id vs sourceId) and
// which accepts "co" for name search both vary by the source's connector
// type (verified live: the same filter that worked for one source 400'd for
// another) — the server tries several combinations so this always works
// regardless of connector type.
// One page of a source's accounts: { accounts, total, totalIsExact }. total
// is ISC's own count; totalIsExact is false when a name search had to be
// applied client-side on the server (then total is just this page's count).
export async function listAccountsBySource(sourceId, { query, limit = 100, offset = 0 } = {}) {
  const data = await PortedSources.listAccountsBySource(sourceId, { limit, offset, ...(query ? { query } : {}) });
  // Older servers returned the bare array.
  return Array.isArray(data) ? { accounts: data, total: null, totalIsExact: false } : data;
}

/** Every account on a source, for a printout — pages of 250 until exhausted. */
export async function listAllAccountsBySource(sourceId, { query } = {}) {
  return fetchAllPages(async (page) => (await listAccountsBySource(sourceId, { ...page, query })).accounts, { pageSize: 250 });
}

// Delimited File / Generic sources are the only connector types whose
// accounts come from a flat file rather than a live directory — these are
// the only ones this app lets an admin hand-edit and re-load. ISC returns
// two different `type` strings for the same Delimited File connector
// depending on how the source was created — "DelimitedFile" and "Delimited
// File" (with a space) — verified live: a real source ("Koch Fake
// Employees") came back as "Delimited File" and was silently excluded here.
export function isEditableAccountSourceType(type) {
  return type === "DelimitedFile" || type === "Delimited File" || type === "Generic";
}

// Every schema on the source, raw (GET /api/sources/:id/schemas) — the
// Entitlement Schema tab shows and edits each non-account one as JSON.
export async function listSourceSchemas(sourceId) {
  return sortByName(await PortedSchemas.listSourceSchemas(sourceId));
}

// Replaces one schema with the full edited object (PUT — the proven write
// for schemas on this tenant; see the server route).
export async function updateSourceSchema(sourceId, schemaId, schema) {
  return PortedSchemas.updateSourceSchema(sourceId, schemaId, schema);
}

export async function getSourceAccountSchema(sourceId) {
  return PortedSchemas.getSourceAccountSchema(sourceId);
}

// Keeps this source's provisioning policies (CREATE/UPDATE/ENABLE/DISABLE)
// in step with a just-edited account schema — drops fields for
// removedNames, adds a plain field for each of `added` not already present.
// { policiesUpdated: string[] }
export async function syncSourceProvisioningPolicies(sourceId, { removedNames, added }) {
  return PortedSchemas.syncSourceProvisioningPolicies(sourceId, { removedNames, added });
}

// Every account on the source, unpaginated client-side (the server already
// pages through all of them) — used to seed the account-editing screen.
// ─── LDAP user lookup (ISC Admins source) ───────────────────────────────────
// The server searches its fixed domain controller with the caller's own
// directory credentials (one bind + search; never stored).
// { reachable, host, error? } — whether the server can reach its DC now.
export async function getLdapStatus() {
  const resp = await axios.get(`${API_BASE}/api/ldap/status`, { headers: authHeaders() });
  return resp.data;
}
export async function getLdapInfo() {
  const resp = await axios.get(`${API_BASE}/api/ldap/info`, { headers: authHeaders() });
  return resp.data; // { host, base, domain } | { host, error }
}
export async function searchLdapUsers({ username, password, query }) {
  const resp = await axios.post(`${API_BASE}/api/ldap/search`, { username, password, query }, { headers: authHeaders() });
  return resp.data; // { users: [...], truncated, host }
}

export async function exportSourceAccounts(sourceId) {
  return PortedSources.exportSourceAccounts(sourceId);
}

// Uploads an edited accounts CSV and triggers a real ISC load-accounts run
// against it (see server's POST .../load-accounts-file).
export async function loadAccountsFile(sourceId, { filename, csvBase64, disableOptimization }) {
  return PortedSources.loadAccountsFile(sourceId, { filename, csvBase64, disableOptimization });
}

// ─── Disconnected Source creation wizard ───────────────────────────────────

export async function createDisconnectedSource({ name }) {
  return PortedSources.createDisconnectedSource({ name });
}

// { schemaId, identityAttribute, displayAttribute, attributes: [{name,type,description}] }
// AI-modify the source's account CSV per the user's instructions — returns
// { csv, rows }; nothing is saved until the caller uploads it.
export async function generateSourceData(sourceId, { prompt, csvBase64 }) {
  return PortedAi.generateSourceData(sourceId, { prompt, csvBase64 });
}

export async function detectSourceSchema(sourceId, { filename, csvBase64 }) {
  return PortedSchemas.detectSourceSchema(sourceId, { filename, csvBase64 });
}

export async function setSourceSchemaUid(sourceId, schemaId, { identityAttribute, displayAttribute, entitlementAttributes }) {
  return PortedSchemas.setSourceSchemaUid(sourceId, schemaId, { identityAttribute, displayAttribute, entitlementAttributes });
}

// AI-matches the source's remaining schema attributes to the Identity
// Schema and creates "<source name> Profile" — { profile, mapping }.
export async function createIdentityProfileForSource(sourceId) {
  return PortedIdProfile.createIdentityProfileForSource(sourceId);
}

// Reconciles the profile's mappings against the source's current account
// schema — adds mappings for new attributes, drops mappings whose account
// attribute no longer exists, leaves every unaffected mapping untouched.
// { changed, added, removed, applied? }
export async function syncSourceIdentityProfile(sourceId) {
  return PortedIdProfile.syncSourceIdentityProfile(sourceId);
}

export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(reader.error || new Error("Couldn't read that file."));
    reader.readAsDataURL(file);
  });
}

// Not ISC passthroughs — hit the server's own dedicated endpoints, since
// aggregation lives on a different path shape than the generic proxy
// forwards, and history needs server-side filtering the ISC API itself
// doesn't support.
export async function aggregateSourceAccounts(sourceId, disableOptimization = false) {
  return PortedSources.aggregateSourceAccounts(sourceId, disableOptimization);
}

export async function aggregateSourceEntitlements(sourceId) {
  return PortedSources.aggregateSourceEntitlements(sourceId);
}

// Runs the connector's "test configuration" check. Resolves with ISC's
// StatusResponse ({ status: "SUCCESS" | "FAILURE", elapsedMillis, details })
// for both outcomes — only transport/auth problems reject.
export async function testSourceConfiguration(sourceId) {
  return PortedSources.testSourceConfiguration(sourceId);
}

export async function resetSource(sourceId) {
  return PortedSources.resetSource(sourceId);
}

export async function resetSourceAccounts(sourceId) {
  return PortedSources.resetSourceAccounts(sourceId);
}

export async function resetSourceEntitlements(sourceId) {
  return PortedSources.resetSourceEntitlements(sourceId);
}

export async function getSourceAggregationHistory(sourceId) {
  return PortedSources.getSourceAggregationHistory(sourceId);
}

// A source's provisioning policies are keyed by usageType (CREATE, UPDATE,
// ENABLE, DISABLE, CREATE_GROUP, ...), not a generated id — that's what
// Get Provisioning Policy expects too, verified live against this tenant's
// own sources (Active Directory, Airgap, Badging).
export async function listSourceProvisioningPolicies(sourceId) {
  return sortByName(await req("GET", `/sources/${sourceId}/provisioning-policies`), ["usageType", "name"]);
}

export async function getSourceProvisioningPolicy(sourceId, usageType) {
  return req("GET", `/sources/${sourceId}/provisioning-policies/${usageType}`);
}

// PUT the whole policy object — provisioning policies don't accept
// JSON-Patch on /fields ("Invalid path", verified live), so edits replace
// the full document, same mechanism the server's sync-provisioning-policies
// route uses.
export async function updateSourceProvisioningPolicy(sourceId, usageType, body) {
  return req("PUT", `/sources/${sourceId}/provisioning-policies/${usageType}`, { data: body });
}

// Bulk fetch full entitlement objects (with source info) for a set of IDs —
// the per-identity list endpoint only returns {id, name, type}. Dedicated
// server route (not the generic /api/isc/* proxy) so a transient 429/5xx
// is retried instead of failing outright — verified live: this call,
// alongside getRole below, was the actual source of a "Request failed
// with status code 429" reported printing Role Details, since the bulk
// Detail Report print fires both for every listed role in quick succession.
export async function getEntitlementsByIds(ids) {
  if (!ids.length) return [];
  return PortedEntitlements.getEntitlementsByIds(ids);
}

// ─── Access Requests (grant/revoke from a role or access profile) ─────────────

export async function submitAccessRequest({ requestedFor, itemId, itemType, comment, requestType = "GRANT_ACCESS" }) {
  return req("POST", "/access-requests", {
    data: {
      requestedFor,
      requestType,
      requestedItems: [{ type: itemType, id: itemId, comment }],
    },
  });
}

// Same request/approval workflow as submitAccessRequest, just the revoke
// direction — verified against SailPoint's own docs: REVOKE_ACCESS takes
// the identical requestedItems shape as GRANT_ACCESS. This is a real ISC
// access request, not an instant edit — it's queued and may need approval
// depending on the item's own revocationRequestConfig, same as granting.
export async function revokeAccessRequest({ requestedFor, itemId, itemType, comment }) {
  return submitAccessRequest({ requestedFor, itemId, itemType, comment, requestType: "REVOKE_ACCESS" });
}

// ─── Roles & Access Profiles ─────────────────────────────────────────────────

// Deliberately not filtered by "requestable" — every dimensional (dynamic)
// role observed in this tenant has requestable=false (SailPoint requires it:
// a dimensional role's dimensions are what's actually requestable, not the
// base role), so filtering on it hid every dynamic role from ever being
// browsed to, which is where Dimensions are shown. This list is for viewing,
// not for "can I request this" — that distinction belongs on the request flow.
export async function listRoles({ limit = 50, offset = 0, query } = {}) {
  // Verified "co" (contains) works on /roles' name field — "enabled" isn't a
  // filterable field at all, so a query only narrows by name.
  const filters = query ? `name co "${query}"` : undefined;
  return req("GET", "/roles", { params: { limit, offset, sorters: "name", ...(filters ? { filters } : {}) } });
}

// Dedicated server route (not the generic /api/isc/* proxy this used to go
// through) so a transient 429/5xx is retried instead of failing outright —
// backs Role Detail's own page load and the Roles list's bulk Detail
// Report print, the latter firing this for every listed role in quick
// succession (see getEntitlementsByIds above for the same fix).
export async function getRole(id) {
  return PortedRoles.getRole(id);
}

// Dedicated server route (not the generic /api/isc/* proxy this used to go
// through) so a transient 429/5xx from ISC is retried with backoff
// (honoring Retry-After) instead of failing outright — a bulk delete loop
// over many roles (RolesPage) treated every such failure as a hard
// per-role failure under real ISC rate limiting, with no retry at all.
export async function deleteRole(id) {
  return PortedRoles.deleteRole(id);
}

// Not an ISC passthrough — hits the server's own dedicated endpoint, since
// toggling enabled requires a JSON Patch content type the generic proxy
// doesn't send (see server's PATCH /api/roles/:id/enabled).
export async function setRoleEnabled(id, enabled) {
  return PortedRoles.setRoleEnabled(id, enabled);
}

// fields: any of { name, description, owner: {id,name}, additionalOwners:
// [{type,id,name}], dimensional: boolean } — only send what changed.
export async function updateRole(roleId, fields) {
  return PortedRoles.updateRole(roleId, fields);
}

// A role's own `owner` field only ever carries {id, name}, never an email
// address — needed before the Roles list's Email Report action can build
// a mailto: link for that owner.
export async function getIdentityEmail(id) {
  return identitiesPort.getIdentityEmail(id);
}

// Stores a PDF (base64, built client-side via jsPDF) on the server and
// returns a link to it — see server's POST /api/role-reports. Used by the
// Roles list's Email Report action instead of an attachment, since
// mailto: links can't carry one.
export async function createRoleReport({ filename, pdfBase64 }) {
  return PortedReports.createRoleReport({ filename, pdfBase64 });
}

// Saves a private, per-user copy of a generated PDF — shown on the
// signed-in user's own "My Reports" list (see server's POST /api/reports).
export async function saveReport({ filename, title, pdfBase64 }) {
  return PortedReports.saveReport({ filename, title, pdfBase64 });
}

export async function listMyReports() {
  return PortedReports.listMyReports();
}

// Fetched as a blob rather than opened by bare URL — the route requires
// the x-sp-session header, which a plain <a href>/window.open(url) can't
// send (unlike the public role-reports links, which need no auth).
export async function getReportBlob(id) {
  return PortedReports.getReportBlob(id);
}

// Creates and activates one ROLE_COMPOSITION certification campaign per
// distinct owner among roleIds (see server's POST /api/roles/certify) —
// returns { results: [{ownerId, ownerName, ok, campaignId?, campaignName?,
// error?, roleCount}], skippedNoOwner: [{id,name}], skippedDimensional:
// [{id,name}] (dynamic roles — ISC's Role Composition certification
// doesn't generate anything to review for them), fetchErrors: [{id,error}] }.
export async function certifyRoles(roleIds) {
  return PortedRoles.certifyRoles(roleIds);
}

// Returns a suggested description only — never writes to the role itself.
// The caller shows it alongside the current one and applies it via
// updateRole, same as any manual edit, once the user confirms.
export async function generateRoleDescription(roleId) {
  return PortedAi.generateRoleDescription(roleId);
}

// { results: [{ roleId, description } | { roleId, error }] } — suggestions
// only, nothing written.
export async function generateAllRoleDescriptions(roleIds) {
  return PortedAi.generateAllRoleDescriptions(roleIds);
}

// Only succeeds when the role has no common-access record yet (fresh
// create) — see server route comment for why there's no "disable" or
// "change an existing one" counterpart.
export async function enableRoleCommonAccess(roleId) {
  return PortedCommonAccess.enableRoleCommonAccess(roleId);
}

// Unflag — DENIES the ISC common-access record and records a local denial
// so scan bookkeeping can't resurrect it.
export async function disableRoleCommonAccess(roleId) {
  return PortedCommonAccess.disableRoleCommonAccess(roleId);
}

export async function listGovernanceGroups({ limit = 25, query } = {}) {
  const filters = query ? `name sw "${query}"` : undefined;
  return sortByName(await req("GET", "/workgroups", { params: { limit, sorters: "name", ...(filters ? { filters } : {}) } }));
}

// Not an ISC passthrough — hits the server's own AI evaluation endpoint,
// which compares the role's entitlements against what its current members
// actually hold, then asks Claude to assess staleness/gaps.
// considerCommonAccessRoleIds: optional explicit list from the "Evaluate"
// picker — omit entirely to keep the server's automatic common-access
// matching (e.g. Repair Role's own re-evaluate calls).
export async function evaluateRole(id, considerCommonAccessRoleIds) {
  return PortedRoleEvaluation.evaluateRole(id, considerCommonAccessRoleIds);
}


// Every role id this app considers a Common Access role for this tenant —
// backs the Roles list's "Common Access" filter toggle.
export async function getCommonAccessRoleIds() {
  return PortedCommonAccess.getCommonAccessRoleIds();
}

// items: [{ policyId, policyName, dimensionId?, dimensionName? }], expiresAt: ISO date string.
// Returns the freshly re-evaluated role (same shape as evaluateRole).
export async function applyRoleSodMitigation(roleId, { items, expiresAt, roleName }) {
  return PortedRoleEvaluation.applyRoleSodMitigation(roleId, { items, expiresAt, roleName });
}

export async function listRoleSodMitigations(roleId) {
  return PortedRoleEvaluation.listRoleSodMitigations(roleId);
}

// Returns the freshly re-evaluated role (same shape as evaluateRole).
export async function removeRoleSodMitigation(roleId, mitigationId) {
  return PortedRoleEvaluation.removeRoleSodMitigation(roleId, mitigationId);
}

// Tenant-wide mitigation list/edit/delete — backs Evaluation Config's
// "Manage Mitigations" screen, not scoped to one role's evaluation sheet.
export async function listTenantSodMitigations() {
  const resp = await axios.get(`${API_BASE}/api/insights/sod-mitigations`, { headers: authHeaders() });
  return sortByName(resp.data, ["roleName", "policyName"]);
}

export async function updateSodMitigation(mitigationId, { expiresAt }) {
  const resp = await axios.patch(
    `${API_BASE}/api/insights/sod-mitigations/${mitigationId}`,
    { expiresAt },
    { headers: authHeaders() }
  );
  return resp.data;
}

export async function deleteSodMitigation(mitigationId) {
  const resp = await axios.delete(`${API_BASE}/api/insights/sod-mitigations/${mitigationId}`, { headers: authHeaders() });
  return resp.data;
}

// { commonAccess: boolean, status: "CONFIRMED" | "DENIED" | null }
export async function getRoleCommonAccess(id) {
  return PortedCommonAccess.getRoleCommonAccess(id);
}

// Not an ISC passthrough — same JSON Patch requirement as setRoleEnabled.
export async function removeRoleEntitlements(roleId, entitlementIds) {
  return PortedRoles.removeRoleEntitlements(roleId, entitlementIds);
}

// entitlements: [{ id, name }, ...]
export async function addRoleEntitlements(roleId, entitlements) {
  return PortedRoles.addRoleEntitlements(roleId, entitlements);
}

// Combined add+remove in one call — used by "Accept all" so the two don't
// race each other as separate PATCH replaces against the same array.
// Role > Composition: the role against the people it covers — members,
// in-scope Common Access roles, and per level (base + each dimension) how
// common every entitlement is, split into included and excluded.
export async function getRoleComposition(roleId) {
  return PortedRoleEvaluation.getRoleComposition(roleId);
}

// What the tenant's commonality threshold says this role should look like,
// with an AI review of the proposal. Computes only — nothing is saved.
export async function suggestRoleComposition(roleId) {
  return PortedRoleEvaluation.suggestRoleComposition(roleId);
}

export async function updateRoleEntitlements(roleId, { add, remove }) {
  return PortedRoles.updateRoleEntitlements(roleId, { add, remove });
}

// Identities that actually MATCH the role's membership rule, evaluated live
// server-side against current identity attributes — not SailPoint's search
// index of "who currently has this access" (listAccessMembers below), which
// can disagree with the rule itself (search-index lag, or access simply not
// provisioned/deprovisioned yet). The membership rule is the live,
// authoritative definition of who belongs to the role.
export async function listRoleMembers(roleId, { limit = 50, offset = 0, query, fresh = false } = {}) {
  return PortedRoleMembers.listRoleMembers(roleId, { limit, offset, query });
}

// Same shape as listRoleMembers, scoped to one dimension — the server
// intersects the base role's own membership with the dimension's, so this
// is genuinely "who belongs to this specific dimension," not everyone
// tenant-wide who happens to match the dimension's own single-attribute
// criteria in isolation.
export async function listDimensionMembers(roleId, dimensionId, { limit = 50, offset = 0, query, fresh = false } = {}) {
  return PortedRoleMembers.listDimensionMembers(roleId, dimensionId, { limit, offset, query });
}

// Every member of a role / dimension in one call, for the printout — the
// server re-evaluates the membership rule against every identity on each
// request, so paging would re-scan the tenant once per page. MEMBER_PRINT_MAX
// matches the route's ceiling; `total` comes back regardless, so a caller can
// say when a very large role has been truncated rather than quietly printing
// a partial list.
//
// Both request `fresh`, which makes the call unconditional. Express ETags
// these routes, so printing a role a second time sends If-None-Match and can
// come back 304 with an empty body — and axios's default validateStatus
// REJECTS 304, so the fetch throws and that section is lost. Observed live on
// a 7-dimension role: every member request came back 304 and a dimension's
// identities went missing from the printout.
export const MEMBER_PRINT_MAX = 2500;

export async function listAllRoleMembers(roleId) {
  const { members = [], total = 0 } = await listRoleMembers(roleId, { limit: MEMBER_PRINT_MAX, offset: 0, fresh: true });
  return { members, total };
}

export async function listAllDimensionMembers(roleId, dimensionId) {
  const { members = [], total = 0 } = await listDimensionMembers(roleId, dimensionId, { limit: MEMBER_PRINT_MAX, offset: 0, fresh: true });
  return { members, total };
}

// Every identity currently holding some access item (role, access profile,
// or entitlement) via the Search API's @access query — same pattern for
// all three since they all appear the same way in an identity's `access`
// array (verified live for each type).
export async function listAccessMembers(accessId, { limit = 50, offset = 0, query } = {}) {
  const term = (query || "").replace(/[^\w\s'-]/g, "").trim();
  const searchClause = term ? ` AND name:*${term}*` : "";
  const resp = await axios({
    method: "POST",
    url: `${API_BASE}/api/isc/v2026/search`,
    params: { limit, offset, count: true },
    data: {
      indices: ["identities"],
      query: { query: `@access(id:"${accessId}")${searchClause}` },
      sort: ["name"],
    },
    headers: authHeaders(),
  });
  const total = resp.headers["x-total-count"];
  return { members: resp.data, total: total != null ? Number(total) : resp.data.length };
}

// Bulk identity lookup by id — /public-identities has no per-id GET, and a
// role's membership.identities only ever stores bare ids, so this resolves
// them to full profile rows (name, email) for display in one call.
export async function getIdentitiesByIds(ids) {
  if (!ids.length) return [];
  const idList = ids.map((id) => `"${id}"`).join(",");
  return req("GET", "/public-identities", { params: { filters: `id in (${idList})`, limit: ids.length } });
}

// add: [{id,name}, ...], remove: [identityId, ...] — only works on a role
// with no membership rule (server refuses otherwise).
export async function updateRoleMembers(roleId, { add, remove }) {
  return PortedRoles.updateRoleMembers(roleId, { add, remove });
}

// fields: { name? } and/or { attrKey, value } (must be provided together).
export async function updateRoleDimension(roleId, dimensionId, fields) {
  return PortedRoleDimensions.updateRoleDimension(roleId, dimensionId, fields);
}

export async function removeDimensionEntitlements(roleId, dimensionId, entitlementIds) {
  return PortedRoleDimensions.removeDimensionEntitlements(roleId, dimensionId, entitlementIds);
}

// entitlements: [{ id, name }, ...]
export async function addDimensionEntitlements(roleId, dimensionId, entitlements) {
  return PortedRoleDimensions.addDimensionEntitlements(roleId, dimensionId, entitlements);
}

// Combined add+remove in one call — same reasoning as updateRoleEntitlements:
// two independent PATCH replaces against the same dimension's /entitlements
// array would race and could clobber each other.
export async function updateDimensionEntitlements(roleId, dimensionId, { add, remove }) {
  return PortedRoleDimensions.updateDimensionEntitlements(roleId, dimensionId, { add, remove });
}

// entitlements: [{ id, name }, ...]
export async function createRoleDimension(roleId, { name, description, attrKey, value, entitlements }) {
  return PortedRoleDimensions.createRoleDimension(roleId, { name, description, attrKey, value, entitlements });
}

export async function deleteRoleDimension(roleId, dimensionId) {
  await PortedRoleDimensions.deleteRoleDimension(roleId, dimensionId);
}

// General entitlement name search — verified live that "name co" works
// standalone (no source filter required), unlike listEntitlementsBySource's
// combined filter. Used for the "add entitlements to a dimension" picker.
export async function searchEntitlements({ limit = 15, query } = {}) {
  const filters = query ? `name co "${query}"` : undefined;
  return req("GET", "/entitlements", { params: { limit, sorters: "name", ...(filters ? { filters } : {}) } });
}

// Not an ISC passthrough — hits the server's own endpoints, which start and
// poll a tenant-wide Role Propagation run (SailPoint's real mechanism for
// re-evaluating role/dimension membership and provisioning/revoking access).
export async function applyRoleChanges() {
  return PortedRoles.applyRoleChanges(); // { rolePropagationId }
}

export async function getApplyRoleChangesStatus(rolePropagationId) {
  return PortedRoles.getApplyRoleChangesStatus(rolePropagationId); // { id, status, executionStage, launched, launchedBy }
}

// Whether a tenant-wide Role Propagation run is in progress right now,
// regardless of who/what started it — used to banner the Roles list, since
// role changes aren't reflected in identities' actual access until this
// completes.
export async function getRolePropagationRunning() {
  return PortedRoles.getRolePropagationRunning(); // { isRunning, rolePropagationDetails? }
}

// ─── Configuration: tenant settings ────────────────────────────────────────────

export async function getTenantSettings() {
  return PortedSettings.getTenantSettings();
}

export async function setTenantSettings(settings) {
  return PortedSettings.setTenantSettings(settings);
}

// ─── Studio Settings: Preferences ──────────────────────────────────────────

export async function getStudioPreferences() {
  return PortedSettings.getStudioPreferences();
}

export async function setStudioPreferences(preferences) {
  return PortedSettings.setStudioPreferences(preferences);
}

// ─── User Preferences ──────────────────────────────────────────────────────
// USER data (per signed-in user within this tenant), not tenant data — see
// the server-side comment above USER_PREFERENCES_FILE. Currently just dark
// mode; distinct from getStudioPreferences/setStudioPreferences above, which
// are shared tenant-wide.

export async function getUserPreferences() {
  return PortedSettings.getUserPreferences();
}

export async function setUserPreferences(preferences) {
  return PortedSettings.setUserPreferences(preferences);
}

// Runs the Role Statistics Refresh job immediately, as the signed-in user —
// counts toward the Home screen's stats the same as a real scheduled run.
export async function runRoleStatsRefreshNow() {
  const resp = await axios.post(`${API_BASE}/api/insights/role-stats-refresh/run-now`, {}, { headers: authHeaders() });
  return resp.data; // { scanId }
}

// The Home screen's pass/needs-update role counts, from the most recent
// completed Role Statistics Refresh scan — { available: false } if none has
// ever run.
export async function getRoleStatsSummary() {
  const resp = await axios.get(`${API_BASE}/api/insights/role-stats-summary`, { headers: authHeaders() });
  return resp.data;
}

// Runs a raw ISC Search query (identities index) and returns how many
// identities match — used to validate the Name Scope setting before saving
// it, and to show "how many users" it currently covers. Verified live: a
// malformed query 400s with a real message (surfaced via err.response.data),
// a well-formed one returns 200 with the real count in x-total-count even
// though `limit` caps the rows actually returned.
export async function validateNameScope(query) {
  const resp = await axios({
    method: "POST",
    url: `${API_BASE}/api/isc/v2026/search`,
    params: { limit: 1, count: true },
    data: { indices: ["identities"], query: { query } },
    headers: authHeaders(),
  });
  const total = resp.headers["x-total-count"];
  return total != null ? Number(total) : 0;
}


// Only dimensional (dynamic) roles have these — each dimension carries its
// own entitlements/access profiles on top of whatever the base role grants.
export async function listRoleDimensions(roleId) {
  return req("GET", `/roles/${roleId}/dimensions`);
}

// Dashboard "At a glance" extras. Both degrade rather than throw: the API
// Usage service is experimental and permission-gated, and not every tenant
// has branding configured, so each returns an "unavailable" shape the card
// can render instead of breaking the whole dashboard.
export async function getApiUsageCount({ days = 30 } = {}) {
  return PortedTenantInfo.getApiUsageCount({ days });
}

// The tenant's instance badge (Sandbox / Production / ...). Lives on the UI
// metadata service, not on branding — see the server route. Returns
// { badge: null } when the tenant has none or this account can't read it.
// The stored Access Model Metadata value -> GUID map, reversed, so a
// segment's ROLE filter (which ISC records by GUID) can be shown by name.
// { byGuid: { "<guid>": { key, value, name } } }.
export async function getMetadataValueGuids() {
  return PortedMetadata.getMetadataValueGuids();
}

export async function getTenantUiMetadata() {
  return PortedTenantInfo.getTenantUiMetadata();
}

export async function getBranding() {
  return PortedTenantInfo.getBranding();
}

// The ISC logo URL needs the tenant token, which an <img src> can't send —
// so the image is fetched as a blob (with the plugin's token) and handed to
// the tag as an object URL. Callers must revoke it when they're done with it.
export async function fetchBrandingLogoObjectUrl() {
  return URL.createObjectURL(await PortedTenantInfo.fetchBrandingLogoBlob());
}

// Matches listRoles: total roles, not just requestable ones.
export async function getRolesCount() {
  return getCountOrNoAccess("/roles");
}

// includeNonRequestable: the Access Profiles browse list and most pickers
// only want requestable ones, but assigning a profile to a source
// Application has nothing to do with requestability — a profile can be
// perfectly valid to attach there while not being directly requestable
// (verified live: several real access profiles on this tenant are
// requestable:false and were invisible to this search before this param
// existed).
export async function listAccessProfiles({ limit = 50, offset = 0, query, includeNonRequestable = false } = {}) {
  // Verified "co" (contains) works on /access-profiles' name field.
  const requestableClause = includeNonRequestable ? null : "requestable eq true";
  const nameClause = query ? `name co "${query}"` : null;
  const filters = [requestableClause, nameClause].filter(Boolean).join(" and ") || undefined;
  return req("GET", "/access-profiles", { params: { limit, offset, sorters: "name", ...(filters ? { filters } : {}) } });
}

export async function getAccessProfile(id) {
  return req("GET", `/access-profiles/${id}`);
}

// Enabled and Requestable both default false server-side — this form
// doesn't collect either, matching new access profiles starting
// inactive/non-requestable until deliberately turned on.
export async function createAccessProfile({ name, owner, sourceId, entitlementIds }) {
  return PortedAccessProfiles.createAccessProfile({ name, owner, sourceId, entitlementIds });
}

// Verified live: DELETE /v2026/access-profiles/:id is a real endpoint (404
// "not found" for a bogus id), matching REST convention for the other list
// resources here.
export async function deleteAccessProfile(id) {
  return req("DELETE", `/access-profiles/${id}`);
}

export async function setAccessProfileEnabled(id, enabled) {
  return PortedAccessProfiles.setAccessProfileEnabled(id, enabled);
}

// fields: any of { name, description, owner: {id,name} }
export async function updateAccessProfile(id, fields) {
  return PortedAccessProfiles.updateAccessProfile(id, fields);
}

// Returns a suggested description only — never writes to the access
// profile itself. Same shape as generateRoleDescription.
export async function generateAccessProfileDescription(id) {
  return PortedAi.generateAccessProfileDescription(id);
}

// { results: [{ roleId, description } | { roleId, error }] } — suggestions
// only, nothing written. Keyed "roleId" server-side (not "profileId") so
// the result feeds BulkDescriptionReviewSheet unchanged — same shape as
// generateAllRoleDescriptions.
export async function generateAllAccessProfileDescriptions(accessProfileIds) {
  return PortedAi.generateAllAccessProfileDescriptions(accessProfileIds);
}

// ─── Source Applications ────────────────────────────────────────────────────
// ISC's "Applications" (Access Model > Applications) — each belongs to
// exactly one source.

export async function listSourceApps(sourceId) {
  return sortByName(await PortedSources.listSourceApps(sourceId));
}

// A source's datasets — the sample data ISC retains from account/group
// aggregation (GET /sources/v1/{id}/datasets, proxied server-side).
export async function listSourceDatasets(sourceId) {
  return sortByName(await PortedSources.listSourceDatasets(sourceId));
}

// Saves edits to a dataset as JSON-Patch ops (PATCH .../datasets/{id}).
export async function updateSourceDataset(sourceId, datasetId, ops) {
  return PortedSources.updateSourceDataset(sourceId, datasetId, ops);
}

// A source's resources — the objects its datasets are made of
// (GET /sources/v1/{id}/resources, proxied server-side).
export async function listSourceResources(sourceId) {
  return sortByName(await PortedSources.listSourceResources(sourceId));
}

// Saves edits to a resource as JSON-Patch ops (PATCH .../resources/{id}).
export async function updateSourceResource(sourceId, resourceId, ops) {
  return PortedSources.updateSourceResource(sourceId, resourceId, ops);
}

// Runs aggregation for a single dataset (POST .../datasets/{id}/aggregate).
export async function aggregateSourceDataset(sourceId, datasetId) {
  return PortedSources.aggregateSourceDataset(sourceId, datasetId);
}

// Every Application tenant-wide (across all sources) — Browse > Applications.
export async function listAllSourceApps() {
  return sortByName(await PortedSources.listAllSourceApps());
}

export async function getSourceApp(id) {
  return PortedSources.getSourceApp(id);
}

export async function createSourceApp(sourceId, { name, description, owner, matchAllAccounts }) {
  return PortedSources.createSourceApp(sourceId, { name, description, owner, matchAllAccounts });
}

export async function deleteSourceApp(id) {
  await PortedSources.deleteSourceApp(id);
}

// fields: { description }
export async function updateSourceApp(id, fields) {
  return PortedSources.updateSourceApp(id, fields);
}

export async function generateSourceAppDescription(id) {
  return PortedAi.generateSourceAppDescription(id);
}

// { results: [{ roleId, description } | { roleId, error }] } — keyed
// "roleId" server-side so the result feeds BulkDescriptionReviewSheet
// unchanged, same shape as generateAllRoleDescriptions.
export async function generateAllSourceAppDescriptions(appIds) {
  return PortedAi.generateAllSourceAppDescriptions(appIds);
}

// An Application's access, in ISC's own model, is granted via the Access
// Profiles assigned to it (not raw entitlements held on the app itself).
export async function listSourceAppAccessProfiles(appId) {
  return sortByName(await PortedSources.listSourceAppAccessProfiles(appId));
}

// add/remove: access profile id arrays. Returns the app's resulting
// access profile list.
export async function updateSourceAppAccessProfiles(appId, { add, remove }) {
  return PortedSources.updateSourceAppAccessProfiles(appId, { add, remove });
}

// add: [{id,name}, ...], remove: [entitlementId, ...]
export async function updateAccessProfileEntitlements(id, { add, remove }) {
  return PortedAccessProfiles.updateAccessProfileEntitlements(id, { add, remove });
}

// ─── Sources ─────────────────────────────────────────────────────────────────

export async function listSources({ limit = 50, offset = 0, query } = {}) {
  // Verified "co" (contains) works on /sources' name field.
  const filters = query ? `name co "${query}"` : undefined;
  return req("GET", "/sources", { params: { limit, offset, sorters: "name", ...(filters ? { filters } : {}) } });
}

export async function getSource(id) {
  return req("GET", `/sources/${id}`);
}

// How a source's connector runs. SaaS (sp-connect) connectors are hosted by
// ISC; VA-based ones run on a customer Virtual Appliance cluster. A cluster
// is NOT the tell for VA — SaaS sources sit on one too
// (sp_connect_proxy_cluster) — so SaaS goes by the connector attributes the
// SaaS connectivity framework stamps on the source, and VA is "on a cluster
// and not SaaS". Sources that are neither (delimited file, no cluster) are
// neither kind.
export function isSaasSource(source) {
  const attrs = source?.connectorAttributes || {};
  return attrs.idnProxyType === "sp-connect" || !!attrs.spConnectorSpecId;
}

export function isVaSource(source) {
  return !isSaasSource(source) && !!source?.cluster?.id;
}

// A source's Virtual Appliance (VA) status lives on its managed cluster, not
// on the source itself: the cluster carries the rolled-up status, and each
// managed client under it is one VA with its own status, version and
// last-seen time. Disconnected/Delimited File sources have no cluster.
export async function getManagedCluster(clusterId) {
  return req("GET", `/managed-clusters/${clusterId}`);
}

export async function listManagedClientsForCluster(clusterId) {
  return sortByName(await req("GET", "/managed-clients", { params: { filters: `clusterId eq "${clusterId}"`, limit: 50 } }), ["name", "ipAddress", "id"]);
}

export async function deleteSource(id) {
  await PortedSources.deleteSource(id);
}

// { hasProfile, profile: {id, name, description} | null, mappings: [{name, displayName, mapping}] }
// mappings only includes identity attributes this profile actually maps —
// unmapped attributes are already excluded server-side.
export async function getSourceIdentityProfile(id) {
  return PortedIdProfile.getSourceIdentityProfile(id);
}

export async function generateSourceDescription(id) {
  return PortedAi.generateSourceDescription(id);
}

export async function generateAllSourceDescriptions(sourceIds) {
  return PortedAi.generateAllSourceDescriptions(sourceIds);
}

// fields: any of { name, description, owner: {id,name},
// managementWorkgroup: {id,name} | null } — only send what changed.
export async function updateSource(id, fields) {
  return PortedSources.updateSource(id, fields);
}

export async function updateSourceDescription(id, description) {
  return PortedSources.updateSourceDescription(id, description);
}

// A 403 on a dashboard metric isn't an app failure — it's the tenant telling
// us the signed-in account lacks that capability (e.g. /sources for
// non-admins). Return this sentinel so the UI can say "no access" instead of
// rendering an ambiguous dash and retrying an error.
export const NO_ACCESS = "NO_ACCESS";

async function getCountOrNoAccess(path, params) {
  try {
    return await getCount(path, params);
  } catch (err) {
    if (err.response?.status === 403) return NO_ACCESS;
    throw err;
  }
}

export async function getIdentitiesCount() {
  return getCountOrNoAccess("/public-identities");
}

export async function getSourcesCount() {
  return getCountOrNoAccess("/sources");
}

export async function getAccessProfilesCount() {
  return getCountOrNoAccess("/access-profiles", { filters: "requestable eq true" });
}

// ─── Certifications ───────────────────────────────────────────────────────────

export async function listCampaigns({ limit = 20 } = {}) {
  return req("GET", "/campaigns", { params: { limit } });
}

// ─── SOD ─────────────────────────────────────────────────────────────────────

export async function listSodViolations({ limit = 20 } = {}) {
  return req("GET", "/sod-violations", { params: { limit } });
}

// ─── Configuration: schema analysis ────────────────────────────────────────────

// Not an ISC passthrough — hits the server's own analysis endpoint directly.
// Runs fresh and persists (and returns) the result for the current tenant.
export async function runSchemaAnalysis() {
  const resp = await axios.post(
    `${API_BASE}/api/insights/schema-analysis`,
    {},
    { headers: authHeaders() }
  );
  return resp.data;
}

// The persisted result for the current tenant, or null if none has run yet.
export async function getSchemaAnalysis() {
  const resp = await axios.get(`${API_BASE}/api/insights/schema-analysis`, { headers: authHeaders() });
  return resp.data;
}

// Overrides the algorithm's top-3 pick with a manually chosen, ordered list
// (first = highest priority). 1 to 3 keys, each must be one of this
// analysis's candidates.
export async function setSchemaTopAttributes(topAttributes) {
  const resp = await axios.put(
    `${API_BASE}/api/insights/schema-analysis/top-attributes`,
    { topAttributes },
    { headers: authHeaders() }
  );
  return resp.data;
}

// Persists the Multi-Company/Division Boundary — whether it's on, and
// which 0-2 candidate attributes define it. createDataSegments is a
// sibling toggle (only meaningful, and only ever persisted true, while
// enabled is also true) that also gates the Data Segments menu.
export async function setSchemaRoleBoundary({ enabled, attributes, createDataSegments }) {
  const resp = await axios.put(
    `${API_BASE}/api/insights/schema-analysis/role-boundary`,
    { enabled, attributes, createDataSegments },
    { headers: authHeaders() }
  );
  return resp.data;
}

// ─── Data Segments ──────────────────────────────────────────────────────────

export async function listSegments() {
  return sortByName(await PortedSegments.listSegments());
}

export async function getSegment(id) {
  return PortedSegments.getSegment(id);
}

/**
 * Roles assigned to a segment, plus the entitlements they grant.
 *
 * Entitlements here are reachable-through, not assigned-to: ISC cannot query
 * entitlements by segment, so the server derives them from the segment's roles
 * and access profiles. The response carries `derived: true` and each row lists
 * the paths it arrived by.
 */
export async function getSegmentAccess(id) {
  const d = (await PortedSegments.getSegmentAccess(id)) || {};
  return { ...d, roles: sortByName(d.roles), accessProfiles: sortByName(d.accessProfiles), entitlements: sortByName(d.entitlements) };
}

// Identities that actually fall inside a segment's boundary — evaluated
// server-side from the segment's own memberFilter criteria since ISC never
// denormalizes segment membership anywhere. Same { members, total } shape
// as listEntitlementMembers.
export async function listSegmentMembers(id, { limit = 50, offset = 0, query } = {}) {
  return PortedSegments.listSegmentMembers(id, { limit, offset, query });
}

// The reverse direction of getSegmentAccess — given an identity/role/
// entitlement, which data segments include it. Each returns [{id, name,
// active}]. Roles/entitlements read straight off a segment's own scope
// selection (the only mechanism confirmed to reflect real membership, same
// as getSegmentAccess); identities are matched by evaluating the segment's
// own membership criteria against the identity's attributes, since segment
// membership is never denormalized onto the identity itself.
export async function getIdentitySegments(identityId) {
  return identitiesPort.getIdentitySegments(identityId);
}

export async function getRoleSegments(roleId) {
  return PortedSegments.getRoleSegments(roleId);
}

export async function getEntitlementSegments(entitlementId) {
  return PortedSegments.getEntitlementSegments(entitlementId);
}

export async function deleteSegment(id) {
  await PortedSegments.deleteSegment(id);
}

export async function setSegmentActive(id, active) {
  return PortedSegments.setSegmentActive(id, active);
}

// Ensures this segment has an editable draft, creating one (copied from
// the published record) if it doesn't already have one. A no-op — not an
// error — if it's already a draft or already has one.
export async function createSegmentDraft(id) {
  return PortedSegments.createSegmentDraft(id); // { draftId, segmentName, created, wasAlreadyDraft }
}

// A segment's criteria has no effect on real identities until published —
// enabled alone isn't enough.
export async function publishSegments(ids) {
  return PortedSegments.publishSegments(ids);
}

// "Assign Matching Roles" — proposes which existing roles AND entitlements
// look like they belong to each of the given segments (roles by comparing
// membership criteria; entitlements via a Search API query built from the
// segment's own criteria, same mechanism the Segments scan uses), without
// writing anything. Poll getSegmentRoleMatch for progress/results — each
// result carries `matches` (roles) and `entitlementMatches`.
export async function startSegmentRoleMatch(segmentIds) {
  const resp = await axios.post(
    `${API_BASE}/api/insights/segment-role-matches`,
    { segmentIds },
    { headers: authHeaders() }
  );
  return resp.data; // { matchId }
}

export async function getSegmentRoleMatch(matchId) {
  const resp = await axios.get(`${API_BASE}/api/insights/segment-role-matches/${matchId}`, { headers: authHeaders() });
  return resp.data;
}

// items: [{ segmentId, type: "ROLE" | "ENTITLEMENT", id }, ...] — assigns
// each accepted suggestion. type defaults to ROLE if omitted.
export async function assignSegmentRoleMatches(matchId, items) {
  const resp = await axios.post(
    `${API_BASE}/api/insights/segment-role-matches/${matchId}/assign`,
    { items },
    { headers: authHeaders() }
  );
  return resp.data; // { results }
}

// ─── Role Insight: peer groups ────────────────────────────────────────────────

export async function startRoleScan() {
  const resp = await axios.post(
    `${API_BASE}/api/insights/role-scans`,
    {},
    { headers: authHeaders() }
  );
  return resp.data; // { scanId }
}

// ─── Skeleton role generation ──────────────────────────────────────────────────

// rolePrefix/roleSuffix are optional one-off overrides for this run only —
// never persisted to Mining Config (see the Skeleton Roles screen's own
// Role Naming box). Omit either to fall back to Mining Config's saved value.
// useBoundary: this run's own opt-in for the Multi-Company/Division
// Boundary (see the screen's own checkbox) — omit to fall back to Schema
// Analysis's persisted roleBoundaryEnabled, same as every other caller.
// attributeSeparator: this run's own one-off delimiter (also never
// persisted) joining a Boundary partition's attribute value(s) and the
// primary bucket's own value into one role name — e.g. "Tokyo - Auto
// Sales" instead of "Tokyo Auto Sales" for " - ". Omit to fall back to
// Mining Config's saved default, same as rolePrefix/roleSuffix.
export async function startSkeletonScan({ rolePrefix, roleSuffix, useBoundary, attributeSeparator } = {}) {
  const resp = await axios.post(
    `${API_BASE}/api/insights/skeleton-scans`,
    { rolePrefix, roleSuffix, useBoundary, attributeSeparator },
    { headers: authHeaders() }
  );
  return resp.data; // { scanId }
}

export async function getSkeletonScan(scanId) {
  const resp = await axios.get(`${API_BASE}/api/insights/skeleton-scans/${scanId}`, { headers: authHeaders() });
  return resp.data;
}

export async function cancelSkeletonScan(scanId) {
  await axios.post(`${API_BASE}/api/insights/skeleton-scans/${scanId}/cancel`, {}, { headers: authHeaders() });
}

export async function listSkeletonScans() {
  const resp = await axios.get(`${API_BASE}/api/insights/skeleton-scans`, { headers: authHeaders() });
  return resp.data;
}

export async function deleteSkeletonScan(scanId) {
  await axios.delete(`${API_BASE}/api/insights/skeleton-scans/${scanId}`, { headers: authHeaders() });
}

// Creates one proposed role from a Skeleton Role Model draft in ISC.
export async function createSkeletonScanRole(scanId, index) {
  const resp = await axios.post(`${API_BASE}/api/insights/skeleton-scans/${scanId}/results/${index}/create`, {}, { headers: authHeaders() });
  return resp.data;
}

export async function listRoleScans() {
  const resp = await axios.get(`${API_BASE}/api/insights/role-scans`, { headers: authHeaders() });
  return resp.data;
}

export async function getRoleScan(scanId) {
  const resp = await axios.get(`${API_BASE}/api/insights/role-scans/${scanId}`, { headers: authHeaders() });
  return resp.data;
}

export async function cancelRoleScan(scanId) {
  const resp = await axios.post(
    `${API_BASE}/api/insights/role-scans/${scanId}/cancel`,
    {},
    { headers: authHeaders() }
  );
  return resp.data;
}

export async function deleteRoleScan(scanId) {
  await axios.delete(`${API_BASE}/api/insights/role-scans/${scanId}`, { headers: authHeaders() });
}

// ─── Attribute Sync scan ────────────────────────────────────────────────────

export async function startAttributeSyncScan() {
  const resp = await axios.post(`${API_BASE}/api/insights/attribute-sync-scans`, {}, { headers: authHeaders() });
  return resp.data; // { scanId }
}

export async function listAttributeSyncScans() {
  const resp = await axios.get(`${API_BASE}/api/insights/attribute-sync-scans`, { headers: authHeaders() });
  return resp.data;
}

export async function getAttributeSyncScan(scanId) {
  const resp = await axios.get(`${API_BASE}/api/insights/attribute-sync-scans/${scanId}`, { headers: authHeaders() });
  return resp.data;
}

export async function deleteAttributeSyncScan(scanId) {
  await axios.delete(`${API_BASE}/api/insights/attribute-sync-scans/${scanId}`, { headers: authHeaders() });
}

// The roles / access profiles / entitlements tagged with one metadata value,
// by name: { items, total }. type: "roles" | "accessprofiles" | "entitlements".
export async function listAccessByMetadataValue(key, value, type, { limit = 100, offset = 0 } = {}) {
  return PortedMetadata.listAccessByMetadataValue(key, value, type, { limit, offset });
}

// Deletes values of a custom metadata attribute, one ISC call per value (ISC
// has no batch delete): { deleted: [value], failed: [{ value, error }] }.
export async function deleteMetadataValues(key, values) {
  return PortedMetadata.deleteMetadataValues(key, values);
}

// ─── Access Model Metadata search ───────────────────────────────────────────
// Every id on one search index ("roles" | "accessprofiles" | "entitlements")
// tagged with the given metadata attribute value, via ISC Search's verified
// @accessModelMetadata() nested query. searchAfter-paginated and capped.
// `value` picks the match: a value string → items tagged with it; null → items
// with ANY value for `key`; METADATA_NOT_SET → items with NO value for `key`.
export const METADATA_NOT_SET = "__not_set__";

function metadataQuery(key, value) {
  if (value === METADATA_NOT_SET) return `NOT @accessModelMetadata(key:${key})`;
  if (value == null) return `@accessModelMetadata(key:${key})`;
  return `@accessModelMetadata(key:${key} AND value:"${String(value).replace(/"/g, '\\"')}")`;
}

export async function searchAccessIdsByMetadata(index, key, value) {
  const ids = new Set();
  let searchAfter = null;
  const limit = 250;
  while (ids.size < 20000) {
    const resp = await axios({
      method: "POST",
      url: `${API_BASE}/api/isc/v2026/search`,
      params: { limit },
      data: {
        indices: [index],
        query: { query: metadataQuery(key, value) },
        sort: ["id"],
        queryResultFilter: { includes: ["id"] },
        ...(searchAfter ? { searchAfter } : {}),
      },
      headers: authHeaders(),
    });
    const page = Array.isArray(resp.data) ? resp.data : [];
    if (page.length === 0) break;
    for (const d of page) if (d.id) ids.add(d.id);
    if (page.length < limit) break;
    searchAfter = [page[page.length - 1].id];
  }
  return ids;
}

// ─── Connector rules (Source > Connector Rules) ─────────────────────────────
// Tenant-wide BeanShell rules executed on the VA as connector extensions.

export async function listConnectorRules() {
  const all = [];
  let offset = 0;
  const limit = 250;
  while (true) {
    const page = await req("GET", "/connector-rules", { params: { limit, offset } });
    if (!Array.isArray(page) || page.length === 0) break;
    all.push(...page);
    if (page.length < limit) break;
    offset += limit;
  }
  return sortByName(all);
}

export async function getConnectorRule(id) {
  return req("GET", `/connector-rules/${id}`);
}

export async function createConnectorRule(body) {
  return req("POST", "/connector-rules", { data: body });
}

export async function updateConnectorRule(id, body) {
  return req("PUT", `/connector-rules/${id}`, { data: body });
}

// { state: "OK" | "ERROR", details: [{ line, column, message }] }
export async function validateConnectorRule({ version = "1.0", script }) {
  return req("POST", "/connector-rules/validate", { data: { version, script } });
}

// ─── Connector customizers (Source > Connector Customizers) ─────────────────
// SaaS connectivity customizers — cloud-hosted counterparts of VA connector
// rules. Tenant-wide; a source runs one via connectorAttributes.connectorCustomizerId.

export async function listConnectorCustomizers() {
  const all = [];
  let offset = 0;
  const limit = 250;
  while (true) {
    const page = await req("GET", "/connector-customizers", { params: { limit, offset } });
    if (!Array.isArray(page) || page.length === 0) break;
    all.push(...page);
    if (page.length < limit) break;
    offset += limit;
  }
  return sortByName(all);
}

export async function getConnectorCustomizer(id) {
  return req("GET", `/connector-customizers/${id}`);
}

export async function createConnectorCustomizer({ name }) {
  return req("POST", "/connector-customizers", { data: { name } });
}

export async function updateConnectorCustomizer(id, { name }) {
  return req("PUT", `/connector-customizers/${id}`, { data: { name } });
}

export async function deleteConnectorCustomizer(id) {
  return req("DELETE", `/connector-customizers/${id}`);
}

// ISC stores only a customizer's built image, never its source, so the
// script lives with the app's server. { script, stored, deployed, dirty } —
// the starter template when nothing is stored ("new", or a customizer that
// was built outside the app).
export async function getConnectorCustomizerSource(id) {
  return PortedCustomizers.getConnectorCustomizerSource(id);
}

// Saves a draft of the script without touching ISC.
export async function saveConnectorCustomizerSource(id, script) {
  return PortedCustomizers.saveConnectorCustomizerSource(id, script);
}

export async function deleteConnectorCustomizerSource(id) {
  await PortedCustomizers.deleteConnectorCustomizerSource(id);
}

// { state: "OK" | "ERROR", details: [{ line, column, message }], handlers: [] }
// — syntax + static checks on the server; the script is never executed.
export async function validateConnectorCustomizerScript(script) {
  return PortedCustomizers.validateConnectorCustomizerScript(script);
}

// Builds the script into a customizer ZIP and uploads it to ISC as the
// customizer's next version: { version: { customizerID, imageID, version,
// created }, source }. A 422 carries { validation } when the script fails.
export async function deployConnectorCustomizer(id, script) {
  return PortedCustomizers.deployConnectorCustomizer(id, script);
}

// Assigns (or, with null, clears) the customizer a SaaS source runs —
// JSON-Patch on the source's connectorAttributes via the json-edit route.
export async function setSourceConnectorCustomizer(sourceId, customizerId) {
  const ops = customizerId
    ? [{ op: "add", path: "/connectorAttributes/connectorCustomizerId", value: customizerId }]
    : [{ op: "remove", path: "/connectorAttributes/connectorCustomizerId" }];
  return patchObjectJson("sources", sourceId, ops);
}

// ─── SaaS connector logs (Source > Logs) ────────────────────────────────────
// What `sail conn logs` reads: the SaaS connectivity runtime's log lines,
// oldest first from filter.startTime, a page at a time. Records are keyed by
// the source's NAME (targetName) — targetID is the runtime's own id, not the
// source id or spConnectorInstanceId. VA connectors don't log here (their
// ccg.log stays on the appliance). { logs: [...], nextToken }; the stream is
// exhausted when a page is empty or hands back the token it was given.
export async function querySaasConnectorLogs({ targetName, startTime, endTime, logLevels, requestID, nextToken }) {
  const filter = { startTime, targetName };
  if (endTime) filter.endTime = endTime;
  if (logLevels?.length) filter.logLevels = logLevels;
  if (requestID) filter.requestID = requestID;
  return req("POST", "/platform-logs/query", { data: { filter, nextToken: nextToken || "" } });
}

// Sets a source's delete threshold — the percentage of accounts an
// aggregation may remove before ISC skips the deletion phase entirely
// (deleteThreshold, 0–100). Sources that also carry the connector-level copy
// (connectorAttributes.deleteThresholdPercentage — Delimited File sources
// do) get it updated to match, so the two can't disagree.
export async function setSourceDeleteThreshold(source, percent) {
  const value = Math.max(0, Math.min(100, Math.round(Number(percent))));
  const ops = [{ op: source.deleteThreshold != null ? "replace" : "add", path: "/deleteThreshold", value }];
  if (source.connectorAttributes && "deleteThresholdPercentage" in source.connectorAttributes) {
    ops.push({ op: "replace", path: "/connectorAttributes/deleteThresholdPercentage", value });
  }
  return patchObjectJson("sources", source.id, ops);
}

// Turns the SaaS connector's DEBUG logging on or off for a source — the
// spConnDebugLoggingEnabled connector attribute the runtime reads per command.
export async function setSourceDebugLogging(sourceId, enabled) {
  return patchObjectJson("sources", sourceId, [{ op: "add", path: "/connectorAttributes/spConnDebugLoggingEnabled", value: !!enabled }]);
}

// ─── Source activity (Source > Activity) ────────────────────────────────────
// ISC's audit events for one source, newest first: aggregations (started /
// passed / failed, and who ran them), provisioning results with the
// connector's error text, and configuration changes. Events carry the
// source's NAME (attributes.sourceName) — only some also have a sourceId.
// This is the closest the API gets to a VA connector's log: its ccg.log
// stays on the appliance.
export const SOURCE_ACTIVITY_CATEGORIES = {
  all: null,
  provisioning: "(type:PROVISIONING OR type:ACCESS_ITEM)",
  aggregation: "technicalName.exact:SOURCE_*_AGGREGATE_*",
  // Defined by exclusion — ISC types these inconsistently (SOURCE_MANAGEMENT,
  // SOURCE_SUBTYPE_CREATED, or no real type at all for provisioning-policy
  // and correlation-config changes), so no positive match catches them all.
  // What's excluded besides the other categories is machine account /
  // identity data churn, which can run to thousands of events per aggregation.
  // Left un-parenthesized on purpose: a group of only NOTs matches nothing.
  configuration:
    "NOT type:PROVISIONING AND NOT type:ACCESS_ITEM AND NOT technicalName.exact:SOURCE_*_AGGREGATE_*" +
    " AND NOT technicalName.exact:MACHINE_ACCOUNT_CREATE_* AND NOT technicalName.exact:MACHINE_ACCOUNT_UPDATE_*" +
    " AND NOT technicalName.exact:MACHINE*IDENTITY_*",
};

// failuresOnly narrows whichever category is chosen to what didn't succeed;
// eventNames (technical names) narrows it to those event types — how the
// Activity tabs' "Retryable only" filter is applied by the search itself.
const eventNamesClause = (names) => `technicalName.exact:(${names.map(luceneQuote).join(" OR ")})`;

export async function searchSourceActivity({ sourceName, days = 7, category = "all", failuresOnly = false, eventNames, limit = 100, offset = 0 }) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const name = String(sourceName).replace(/(["\\])/g, "\\$1");
  const clauses = [`attributes.sourceName.exact:"${name}"`, `created:[${since} TO now]`];
  if (SOURCE_ACTIVITY_CATEGORIES[category]) clauses.push(SOURCE_ACTIVITY_CATEGORIES[category]);
  if (failuresOnly) clauses.push("(status:FAILED OR status:ERROR OR status:INCOMPLETE)");
  if (eventNames?.length) clauses.push(eventNamesClause(eventNames));
  return req("POST", "/search", {
    params: { limit, offset },
    data: { indices: ["events"], query: { query: clauses.join(" AND ") }, sort: ["-created"] },
  });
}

// ─── Identity activity (Identity > Activity) ────────────────────────────────
const FAILED_EVENTS_CLAUSE = "(status:FAILED OR status:ERROR OR status:INCOMPLETE)";
const luceneQuote = (v) => `"${String(v).replace(/(["\\])/g, "\\$1")}"`;

// Provisioning done FOR an identity — ISC's account activities, newest
// first: access requests, identity refreshes, lifecycle changes, each with
// its per-account operations, attribute changes and results. Matched by
// identity id (recipient.id), so it survives renames.
export async function searchIdentityAccountActivity({ identityId, days = 30, failuresOnly = false, retryableOnly = false, limit = 100, offset = 0 }) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const clauses = [`recipient.id:${identityId}`, `created:[${since} TO now]`];
  // Anything that didn't simply finish: failed / incomplete activities, and
  // ones still pending or retrying.
  if (failuresOnly || retryableOnly) clauses.push("NOT status:Complete");
  // Still in flight — nothing to retry until ISC is done with it.
  if (retryableOnly) clauses.push("NOT status:Pending", "NOT status:Retrying");
  return req("POST", "/search", {
    params: { limit, offset },
    data: { indices: ["accountactivities"], query: { query: clauses.join(" AND ") }, sort: ["-created"] },
  });
}

// ISC's audit events naming an identity, newest first — role "target" is
// what happened TO them (sign-ins, provisioning, certifications), "actor"
// is what they did (admin changes, requests). Events only carry the
// identity's NAME, so every name it might be recorded under is matched.
export async function searchIdentityEvents({ names, role = "target", days = 30, failuresOnly = false, eventNames, limit = 100, offset = 0 }) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const field = role === "actor" ? "actor.name.exact" : "target.name.exact";
  const clauses = [`${field}:(${names.map(luceneQuote).join(" OR ")})`, `created:[${since} TO now]`];
  if (failuresOnly) clauses.push(FAILED_EVENTS_CLAUSE);
  if (eventNames?.length) clauses.push(eventNamesClause(eventNames));
  return req("POST", "/search", {
    params: { limit, offset },
    data: { indices: ["events"], query: { query: clauses.join(" AND ") }, sort: ["-created"] },
  });
}

// ─── Retrying failed activity (Activity tabs > Retry) ───────────────────────
// ISC has no "retry this transaction" call — a retry is a fresh, equivalent
// operation. lib/activityRetry.js decides which (if any) fits a failure;
// these are the operations themselves.

// Has ISC reprocess one identity: recalculates its attributes, re-evaluates
// role assignments and — the part that makes it a retry — enforces
// provisioning for assigned access that hasn't been fulfilled. 202 + a task.
export async function processIdentity(identityId) {
  return req("POST", "/identities/process", { data: { identityIds: [identityId] } });
}

// Re-runs attribute sync for one identity (ISC allows it once per 10s each).
export async function synchronizeIdentityAttributes(identityId) {
  return req("POST", `/identities/${identityId}/synchronize-attributes`, { data: {} });
}

// Audit events name an identity but don't carry its id. Resolves only on an
// unambiguous match — a retry must never land on the wrong person.
export async function findIdentityIdByName(name) {
  const hits = await req("POST", "/search", {
    params: { limit: 2 },
    data: { indices: ["identities"], query: { query: `name.exact:${luceneQuote(name)}` }, queryResultFilter: { includes: ["id", "name"] } },
  });
  return Array.isArray(hits) && hits.length === 1 ? hits[0].id : null;
}

export async function findSourceIdByName(name) {
  const hits = await req("GET", "/sources", { params: { limit: 2, filters: `name eq "${String(name).replace(/"/g, '\\"')}"` } });
  return Array.isArray(hits) && hits.length === 1 ? hits[0].id : null;
}

export async function findAccountId({ sourceId, nativeIdentity }) {
  // v2025, not v2026 — see reqAccountsV2025.
  const hits = await reqAccountsV2025({ limit: 2, filters: `sourceId eq "${sourceId}" and nativeIdentity eq "${String(nativeIdentity).replace(/"/g, '\\"')}"` });
  return Array.isArray(hits) && hits.length === 1 ? hits[0].id : null;
}

// Removes an account from ISC ONLY — nothing is provisioned to the source, the
// account there is untouched, and it comes back at the next aggregation if it
// still exists. (ISC has no API that deletes one account on its source; that
// happens through a lifecycle state's DELETE action or by revoking the access
// that created it.) For accounts that are gone from the source, or to force
// ISC to rebuild one. 202 + a task result.
export async function removeAccountFromIsc(accountId) {
  const resp = await axios.post(`${API_BASE}/api/isc/v2025/accounts/${accountId}/remove`, {}, { headers: authHeaders() });
  return resp.data;
}

// 202 + an async result id; the outcome shows up as a new activity.
// v2025, like every other /accounts call here (see reqAccountsV2025): this
// tenant's v2026 accounts API returns the account on GET but answers 404 for
// POST …/enable and …/disable, though its own spec lists them.
export async function setAccountEnabled(accountId, enabled) {
  const resp = await axios.post(`${API_BASE}/api/isc/v2025/accounts/${accountId}/${enabled ? "enable" : "disable"}`, {}, { headers: authHeaders() });
  return resp.data;
}

// ─── JSON editors — AI syntax repair ────────────────────────────────────────
// { fixed, explanation } for text that doesn't parse — `fixed` is verified
// by the server to parse. `error` is JSON.parse's own message for the text.
export async function fixJsonWithAi(text, error) {
  const resp = await axios.post(`${API_BASE}/api/ai/fix-json`, { text, error }, { headers: authHeaders() });
  return resp.data;
}

// ─── Launchers (Browse > Launchers) ─────────────────────────────────────────
// ISC Launchers: a named button that starts a workflow as an interactive
// process. Replaced whole on update (PUT) — no JSON-Patch.

export async function listLaunchers() {
  const all = [];
  let offset = 0;
  const limit = 250;
  while (true) {
    const page = await req("GET", "/launchers", { params: { limit, offset } });
    const items = Array.isArray(page) ? page : page?.items || [];
    if (items.length === 0) break;
    all.push(...items);
    if (items.length < limit) break;
    offset += limit;
  }
  return sortByName(all);
}

export async function getLauncher(id) {
  return req("GET", `/launchers/${id}`);
}

// { entitlement | null, matchedBy } — the entitlement ISC created for this
// launcher on its internal IdentityNow source (see the server route).
export async function getLauncherEntitlement(id) {
  return PortedLaunchers.getLauncherEntitlement(id);
}

// An entitlement's request config: approval steps for access and
// revocation requests, comment/end-date rules, max duration, request form.
export async function getEntitlementRequestConfig(id) {
  return req("GET", `/entitlements/${id}/entitlement-request-config`);
}

// Replaces it whole (PUT) — send the full object.
export async function putEntitlementRequestConfig(id, config) {
  return req("PUT", `/entitlements/${id}/entitlement-request-config`, { data: config });
}

// Approval timeouts, reminders and escalations (ISC's generic approval
// config) for one access item. scope: ENTITLEMENT | ACCESS_PROFILE | ROLE.
// GET falls back to the tenant default (scope "TENANT") when the item has
// no settings of its own; PUT creates/replaces the item's own; DELETE
// reverts it to the tenant default.
export async function getItemApprovalConfig(objectId) {
  return req("GET", `/generic-approvals/config/${objectId}`);
}
export async function putItemApprovalConfig(objectId, scope, config) {
  return req("PUT", `/generic-approvals/config/${objectId}/${scope}`, { data: config });
}
export async function deleteItemApprovalConfig(objectId, scope) {
  return req("DELETE", `/generic-approvals/config/${objectId}/${scope}`);
}

// Makes the launcher's entitlement requestable — now if ISC has created it,
// otherwise the server waits for it in the background. { status: "done" | "pending" }
export async function makeLauncherEntitlementRequestable(id) {
  return PortedLaunchers.makeLauncherEntitlementRequestable(id);
}

// body: { name, description, type: "INTERACTIVE_PROCESS", disabled,
// reference: { type: "WORKFLOW", id }, config: "{}" } — ISC's spec only
// accepts an empty JSON object for config on create.
export async function createLauncher(body) {
  return req("POST", "/launchers", { data: body });
}

export async function updateLauncher(id, body) {
  return req("PUT", `/launchers/${id}`, { data: body });
}

// One call per launcher (ISC has no bulk delete); each outcome reported.
export async function deleteLaunchers(ids) {
  let ok = 0;
  const failures = [];
  for (const id of ids) {
    try { await req("DELETE", `/launchers/${id}`); ok += 1; }
    catch (err) { failures.push({ id, error: err.response?.data?.messages?.[0]?.text || err.response?.data?.error || err.message }); }
  }
  return { ok, failures };
}

// Starts the launcher in ISC; resolves with { id } of the interactive process.
export async function launchLauncher(id) {
  return req("POST", `/launchers/${id}/launch`, { data: {} });
}

// ─── Operations (Tools > Operations) ────────────────────────────────────────

// Recent failed events from ISC's events search index, newest first.
// The tenant's audit events (the events index), newest first, within the
// last `days`. failedOnly narrows to status Failed / Error / Incomplete.
export async function searchEvents({ days = 7, failedOnly = false, limit = 250 } = {}) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const range = `created:[${since} TO now]`;
  return req("POST", "/search", {
    params: { limit },
    data: {
      indices: ["events"],
      query: { query: failedOnly ? `(status:FAILED OR status:ERROR OR status:INCOMPLETE) AND ${range}` : range },
      sort: ["-created"],
    },
  });
}

export async function searchFailedEvents({ days = 7, limit = 250 } = {}) {
  return searchEvents({ days, failedOnly: true, limit });
}

// The saved suggestion for one event ({ suggestion: null } when none yet).
export async function getEventFixSuggestion(eventId) {
  const resp = await axios.get(`${API_BASE}/api/insights/ops/suggest/${encodeURIComponent(eventId)}`, { headers: authHeaders() });
  return resp.data;
}

// [{ eventId, generatedAt }] — every event with a saved suggestion.
export async function listEventFixSuggestions() {
  const resp = await axios.get(`${API_BASE}/api/insights/ops/suggestions`, { headers: authHeaders() });
  return resp.data;
}

// { suggestion, cached } — the server's AI analysis of one failed event.
export async function suggestEventFix(event, { refresh = false } = {}) {
  const resp = await axios.post(`${API_BASE}/api/insights/ops/suggest`, { event, refresh }, { headers: authHeaders() });
  return resp.data;
}

// The same analysis for the other things that can fail — kind is "event"
// (an audit event), "accountActivity" (an account-activities document) or
// "connectorLog" ({ id, sourceName, connector, requestID, lines }). Saved
// suggestions are read back with getEventFixSuggestion(aiSuggestionCacheId(…)).
export async function suggestFix(kind, item, { refresh = false } = {}) {
  const resp = await axios.post(`${API_BASE}/api/insights/ops/suggest`, { kind, item, refresh }, { headers: authHeaders() });
  return resp.data;
}

// An audit event keeps its bare id, so it shares its saved suggestion with
// Tools > Operations; the other kinds are prefixed (mirrors the server).
export const aiSuggestionCacheId = (kind, id) => (kind === "event" ? String(id) : `${kind}:${id}`);

// ─── Certification campaigns (Browse > Certifications) ──────────────────────
// ISC's campaign objects themselves (any type, however created), via the
// generic proxy. Only a STAGED campaign can be activated.

export async function listAllCampaigns() {
  const all = [];
  let offset = 0;
  const limit = 250;
  while (true) {
    const page = await req("GET", "/campaigns", { params: { limit, offset, sorters: "-created" } });
    if (!Array.isArray(page) || page.length === 0) break;
    all.push(...page);
    if (page.length < limit) break;
    offset += limit;
  }
  return all;
}

export async function getCampaign(id) {
  return req("GET", `/campaigns/${id}`, { params: { detail: "FULL" } });
}

// ISC's bulk delete: POST /campaigns/delete { ids }. Accepted (202) and
// processed asynchronously — the list may take a moment to reflect it.
export async function deleteCampaigns(ids) {
  return req("POST", "/campaigns/delete", { data: { ids } });
}

export async function activateCampaign(id) {
  return req("POST", `/campaigns/${id}/activate`, { data: { timeZone: "Z" } });
}

// ISC's remediation scan for a COMPLETED campaign: re-checks each revoked
// item against the source and updates its remediation status. Accepted (202)
// and run in the background; ISC refuses a campaign that isn't completed.
export async function runCampaignRemediationScan(id) {
  return req("POST", `/campaigns/${id}/run-remediation-scan`, { data: {} });
}

// ISC's four per-campaign reports, in the order ISC lists them.
export const CAMPAIGN_REPORT_TYPES = [
  { value: "CAMPAIGN_STATUS_REPORT", label: "Campaign Status Report" },
  { value: "CAMPAIGN_COMPOSITION_REPORT", label: "Campaign Composition Report" },
  { value: "CAMPAIGN_REMEDIATION_STATUS_REPORT", label: "Campaign Remediation Status Report" },
  { value: "CERTIFICATION_SIGNOFF_REPORT", label: "Certification Signoff Report" },
];

// Asks ISC to generate a fresh copy of one report for one campaign. Accepted
// (202) and built in the background — it replaces the campaign's previous
// result for that report once it finishes.
export async function runCampaignReport(id, reportType) {
  return req("POST", `/campaigns/${id}/run-report/${reportType}`, { data: {} });
}

// Fetches the chosen reports for the chosen campaigns (running any that were
// never run, or whose file has expired — so this can take a while):
// { zip?: { name, contentBase64 }, files: [...], failures: [{ campaign, reportType, error }] }.
// consolidate (CSV only) merges every campaign into one file per report type.
export async function downloadCampaignReports({ campaignIds, reportTypes, format, zip = true, consolidate = false }) {
  return PortedCampaignReports.downloadCampaignReports({ campaignIds, reportTypes, format, zip, consolidate });
}

// The individual reviewer certifications generated for one campaign.
export async function listCampaignCertifications(campaignId) {
  return sortByName(await req("GET", "/certifications", { params: { filters: `campaign.id eq "${campaignId}"`, limit: 250 } }), ["name", "reviewer.name"]);
}

// Every access review item across a campaign's certifications, each tagged
// with the certification (and reviewer) it belongs to. ISC only generates
// these once the campaign leaves PENDING, so a draft returns []. Capped so a
// huge campaign can't pin the browser.
const REVIEW_ITEMS_CAP = 20000;
export async function listCampaignReviewItems(campaignId) {
  const certs = await listCampaignCertifications(campaignId);
  const items = [];
  for (const cert of Array.isArray(certs) ? certs : []) {
    let offset = 0;
    const limit = 250;
    while (items.length < REVIEW_ITEMS_CAP) {
      const page = await req("GET", `/certifications/${cert.id}/access-review-items`, { params: { limit, offset } });
      if (!Array.isArray(page) || page.length === 0) break;
      for (const it of page) items.push({ ...it, certification: { id: cert.id, name: cert.name, reviewer: cert.reviewer || null, phase: cert.phase, completed: cert.completed } });
      if (page.length < limit) break;
      offset += limit;
    }
  }
  return items;
}

// ─── Certification runs (Mining > Certifications) ───────────────────────────
// One run = one draft certification campaign per distinct value of each Role
// Creation Priority Order attribute, using the defaults from Studio Settings
// > User Certifications (cert* keys on studio preferences).

export async function startCertificationRun() {
  return PortedCertRuns.startCertificationRun(); // { runId }
}

export async function listCertificationRuns() {
  return PortedCertRuns.listCertificationRuns();
}

// full: true also returns every campaign's member list with each member's
// access items (large) — needed only by the detailed printout.
export async function getCertificationRun(runId, { full = false } = {}) {
  return PortedCertRuns.getCertificationRun(runId, { full });
}

// { run, index, campaign } — one campaign with its members and their access.
export async function getCertificationRunCampaign(runId, index) {
  return PortedCertRuns.getCertificationRunCampaign(runId, index);
}

// Creates one planned campaign from the run in ISC (as a draft). Resolves
// with the updated result row (members stripped); rejects with ISC's error.
export async function createCertificationCampaign(runId, index) {
  return PortedCertRuns.createCertificationCampaign(runId, index);
}

// Re-reads every created campaign's status/alerts from ISC; returns the run
// (members stripped). Cheap enough to poll while any campaign is PENDING.
export async function syncCertificationRunStatus(runId) {
  return PortedCertRuns.syncCertificationRunStatus(runId);
}

export async function cancelCertificationRun(runId) {
  return PortedCertRuns.cancelCertificationRun(runId);
}

export async function deleteCertificationRun(runId) {
  await PortedCertRuns.deleteCertificationRun(runId);
}

// ─── Segment scans (Mining > Data Segments) ─────────────────────────────────

// mode: "selection" (default — segments get an explicit Access Model
// selection of the suggested items) or "metadata" (suggested items are
// tagged with the Boundary metadata attribute and the segment's Access
// Model is a FILTER on it — see Segments by Metadata).
// The "server" is now this bundle, so its version is the client package's.
export async function getServerVersion() {
  return PortedTenantInfo.getVersion()?.version || null;
}

export async function startSegmentScan({ includeRoles = true, includeEntitlements = true, mode } = {}) {
  const resp = await axios.post(
    `${API_BASE}/api/insights/segment-scans`,
    { includeRoles, includeEntitlements, mode },
    { headers: authHeaders() }
  );
  return resp.data; // { scanId }
}

export async function listSegmentScans() {
  const resp = await axios.get(`${API_BASE}/api/insights/segment-scans`, { headers: authHeaders() });
  return resp.data;
}

export async function getSegmentScan(scanId) {
  const resp = await axios.get(`${API_BASE}/api/insights/segment-scans/${scanId}`, { headers: authHeaders() });
  return resp.data;
}

export async function cancelSegmentScan(scanId) {
  const resp = await axios.post(`${API_BASE}/api/insights/segment-scans/${scanId}/cancel`, {}, { headers: authHeaders() });
  return resp.data;
}

export async function deleteSegmentScan(scanId) {
  await axios.delete(`${API_BASE}/api/insights/segment-scans/${scanId}`, { headers: authHeaders() });
}

// Live progress of a create run — { done, total }, zeroes when nothing is
// running. Creating segments tags every suggested entitlement one at a time
// and ISC rate-limits that hard, so a run can take minutes; this is what the
// drafts screen counts off against.
export async function getSegmentCreateProgress(scanId) {
  const resp = await axios.get(`${API_BASE}/api/insights/segment-scans/${scanId}/create-progress`, { headers: authHeaders() });
  return resp.data;
}

// ─── Parameter Storage (Browse > Parameters) ────────────────────────────────
// Reads/deletes use the generic proxy. Specifications, create and update go
// through dedicated server routes: the spec has to be requested in English,
// and private fields (passwords, client secrets, header values) are
// encrypted server-side, end to end to SailPoint's enclave, before they're
// sent — see server/parameterCrypto.js. Private values never come back from
// ISC; a parameter only ever returns its public fields.

export async function listParameters() {
  return fetchAllPages((page) => req("GET", "/parameter-storage/parameters", { params: page }), { pageSize: 250 });
}
export async function getParameter(id) {
  return req("GET", `/parameter-storage/parameters/${id}`);
}
export async function deleteParameter(id) {
  return req("DELETE", `/parameter-storage/parameters/${id}`);
}
export async function getParameterReferences(id) {
  return fetchAllPages((page) => req("GET", `/parameter-storage/parameters/${id}/references`, { params: page }), { pageSize: 250 });
}
export async function getParameterSpecifications() {
  const resp = await axios.get(`${API_BASE}/api/parameters/specifications`, { headers: authHeaders() });
  return resp.data;
}
// body: { type, name, description, ownerId, publicFields: {}, privateFields: {} }
export async function createParameter(body) {
  const resp = await axios.post(`${API_BASE}/api/parameters`, body, { headers: authHeaders() });
  return resp.data;
}
// body: any of { name, description, ownerId, publicFields, privateFields } —
// empty private values are left unchanged.
// Tries OAuth client credentials with a real client_credentials token
// request from the server. body: { kind: "oauth2" | "entra", tokenURL,
// tenantId, clientId, clientSecret, credentialLocation, scope }. Returns
// { ok, status, ms, host, tokenType, expiresIn, scope, error, errorDescription }
// — never the token itself.
// Web tests for the other parameter types, from the server. body:
// { kind: "web" | "basic" | "header" | "entra-tenant", url, username,
// password, headerName, headerValue, tenantId }. Returns { ok, status, ms,
// host, location, contentType, tenantGuid, wwwAuthenticate, error } — no
// response body, no credential.
export async function testParameterHttp(body) {
  const resp = await axios.post(`${API_BASE}/api/parameters/test-http`, body, { headers: authHeaders() });
  return resp.data;
}

export async function testParameterOAuth(body) {
  const resp = await axios.post(`${API_BASE}/api/parameters/test-oauth`, body, { headers: authHeaders() });
  return resp.data;
}

export async function updateParameter(id, body) {
  const resp = await axios.patch(`${API_BASE}/api/parameters/${id}`, body, { headers: authHeaders() });
  return resp.data;
}

// ─── Identity: user levels & governance groups (Identity detail tabs) ──────
// User levels are the identity's auth-user capabilities: built-in levels
// (ORG_ADMIN, HELPDESK, CERT_ADMIN, …) plus individual rights granted by
// custom user levels ("sp:…"). Empty means the standard User level.
export async function getIdentityUserLevels(identityId) {
  const authUser = await req("GET", `/auth-users/${identityId}`);
  return { capabilities: Array.isArray(authUser?.capabilities) ? authUser.capabilities : [], enabled: authUser?.enabled };
}

// Governance groups (workgroups) the identity is a member of — one filtered
// query (memberships.identityId). If a tenant rejects that filter, falls
// back to checking each group's member list.
export async function listIdentityGovernanceGroups(identityId) {
  try {
    return await fetchAllPages(
      (page) => req("GET", "/workgroups", { params: { ...page, filters: `memberships.identityId eq "${identityId}"` } }),
      { pageSize: 250 }
    );
  } catch (err) {
    if (err.response?.status !== 400) throw err;
    const groups = await fetchAllPages((page) => req("GET", "/workgroups", { params: page }), { pageSize: 250 });
    const mine = [];
    for (const g of groups) {
      if (!g.memberCount) continue;
      const members = await fetchAllPages((page) => req("GET", `/workgroups/${g.id}/members`, { params: page }), { pageSize: 250 });
      if (members.some((m) => m.id === identityId)) mine.push(g);
    }
    return mine;
  }
}

// Sends ISC's registration invitation to an unregistered identity (server
// route: the invite endpoint is experimental).
export async function inviteIdentity(identityId) {
  return identitiesPort.inviteIdentity(identityId);
}

// Replaces the identity's capabilities (built-in levels + "sp:" rights).
export async function setIdentityUserLevels(identityId, capabilities) {
  return identitiesPort.setIdentityUserLevels(identityId, capabilities);
}

// Adds/removes the identity as a member of governance groups.
// Resolves to { results: [{ groupId, op, ok, error }] }.
export async function updateIdentityGovernanceGroups(identityId, { add = [], remove = [], name } = {}) {
  return identitiesPort.updateIdentityGovernanceGroups(identityId, { add, remove, name });
}

// ─── Governance groups (Browse > Governance Groups) ─────────────────────────
export async function listAllGovernanceGroups() {
  return fetchAllPages((page) => req("GET", "/workgroups", { params: { ...page, sorters: "name" } }), { pageSize: 250 });
}

export async function getGovernanceGroup(id) {
  return req("GET", `/workgroups/${id}`);
}

export async function listGovernanceGroupMembers(id) {
  return fetchAllPages((page) => req("GET", `/workgroups/${id}/members`, { params: page }), { pageSize: 50 });
}

// fields: { name, description, owner: {id,name} }
export async function createGovernanceGroup(fields) {
  return PortedWorkgroups.createGovernanceGroup(fields);
}

// fields: any of { name, description, owner: {id,name} } — only what changed.
export async function updateGovernanceGroup(id, fields) {
  return PortedWorkgroups.updateGovernanceGroup(id, fields);
}

export async function deleteGovernanceGroup(id) {
  await PortedWorkgroups.deleteGovernanceGroup(id);
}

// { add: [{id,name}], remove: [{id,name}] } → { added, removed, errors }
export async function updateGovernanceGroupMembers(id, { add = [], remove = [] } = {}) {
  return PortedWorkgroups.updateGovernanceGroupMembers(id, { add, remove });
}

// { usage: [{ type, id, name, how: [labels] }], errors }
export async function getGovernanceGroupUsage(id) {
  return PortedWorkgroups.getGovernanceGroupUsage(id);
}

// ─── Org config (Browse > Org Info) ─────────────────────────────────────────
// GET /v2026/org-config — the tenant's org-level settings: name, time zone,
// feature flags, AI recommendation switches, SoD report columns, ARM.
export async function getOrgConfig() {
  return req("GET", "/org-config");
}

// ─── Segments (ISC access-request Segments, not Data Segments) ─────────────
// /v2026/segments. Items assigned to a Segment carry its id in their own
// `segments` list; the list endpoints return exactly those items with
// for-segment-ids=<id>&include-unsegmented=false (verified live — without
// include-unsegmented=false they also return every unsegmented item).

export async function listIscSegments() {
  return fetchAllPages((page) => req("GET", "/segments", { params: page }), { pageSize: 250 });
}
export async function getIscSegment(id) {
  return req("GET", `/segments/${id}`);
}
export async function deleteIscSegment(id) {
  return req("DELETE", `/segments/${id}`);
}
// PATCH needs application/json-patch+json, which the generic proxy doesn't
// send — so it goes through the JSON-edit route instead.
export async function setIscSegmentActive(id, active) {
  return patchObjectJson("segments", id, [{ op: "replace", path: "/active", value: !!active }]);
}
// A Segment's member definition as an identities-index search query: each
// EQUALS leaf becomes attributes.<attr>:"<value>" (the same form the Segments
// mining scan uses to find members), joined by the expression's AND/OR.
export function iscSegmentMemberQuery(expr) {
  if (!expr) return null;
  if ((expr.operator === "AND" || expr.operator === "OR") && expr.children?.length) {
    const parts = expr.children.map(iscSegmentMemberQuery).filter(Boolean);
    return parts.length ? `(${parts.join(` ${expr.operator} `)})` : null;
  }
  if (expr.operator === "EQUALS" && expr.attribute) {
    return `attributes.${expr.attribute}:"${String(expr.value?.value ?? "").replace(/(["\\])/g, "\\$1")}"`;
  }
  return null;
}

// One page of the identities a Segment's member definition matches, with the
// real total from X-Total-Count. `search` narrows by name.
export async function searchIscSegmentIdentities(expression, { limit = 50, offset = 0, search } = {}) {
  const base = iscSegmentMemberQuery(expression);
  if (!base) return { identities: [], total: 0 };
  // Letters, digits and . @ - only, with spaces escaped so "jane doe"
  // stays one term for the prefix match.
  const term = String(search || "").trim().replace(/[^\w.@ -]/g, "").replace(/ /g, "\\ ");
  const query = term ? `${base} AND (name:${term}* OR displayName:${term}*)` : base;
  const resp = await axios.post(
    `${API_BASE}/api/isc/v2026/search`,
    {
      indices: ["identities"],
      query: { query },
      sort: ["displayName", "id"],
      queryResultFilter: { includes: ["id", "name", "displayName", "email", "attributes.jobTitle", "attributes.department"] },
    },
    { params: { limit, offset, count: true }, headers: authHeaders() }
  );
  const header = resp.headers["x-total-count"];
  const identities = Array.isArray(resp.data) ? resp.data : [];
  return { identities, total: header != null ? Number(header) : identities.length };
}

// The ISC Segments whose member definition matches this identity — one
// identity search per Segment (id:<identity> AND <member rule>), the same
// matching the Segment screen's Identities tab uses, a few at a time.
export async function getIdentityIscSegments(identityId) {
  const segments = await listIscSegments();
  const matches = [];
  for (let i = 0; i < segments.length; i += 5) {
    const batch = await Promise.all(segments.slice(i, i + 5).map(async (sg) => {
      const rule = iscSegmentMemberQuery(sg.visibilityCriteria?.expression);
      if (!rule) return null;
      const resp = await axios.post(
        `${API_BASE}/api/isc/v2026/search`,
        { indices: ["identities"], query: { query: `id:${identityId} AND ${rule}` }, queryResultFilter: { includes: ["id"] } },
        { params: { limit: 1 }, headers: authHeaders() }
      );
      return Array.isArray(resp.data) && resp.data.length > 0 ? sg : null;
    }));
    matches.push(...batch.filter(Boolean));
  }
  return matches.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
}

const ISC_SEGMENT_ITEM_PATHS = { roles: "/roles", accessProfiles: "/access-profiles", entitlements: "/entitlements" };
export async function listIscSegmentItems(type, segmentId) {
  const path = ISC_SEGMENT_ITEM_PATHS[type];
  return fetchAllPages(
    (page) => req("GET", path, { params: { ...page, "for-segment-ids": segmentId, "include-unsegmented": false } }),
    { pageSize: 250 }
  );
}

// ─── Segments mining (ISC access-request Segments, not Data Segments) ──────
const ACCESS_SEGMENT_SCANS = "/api/insights/access-segment-scans";

export async function startAccessSegmentScan() {
  const resp = await axios.post(`${API_BASE}${ACCESS_SEGMENT_SCANS}`, {}, { headers: authHeaders() });
  return resp.data; // { scanId }
}
export async function listAccessSegmentScans() {
  const resp = await axios.get(`${API_BASE}${ACCESS_SEGMENT_SCANS}`, { headers: authHeaders() });
  return resp.data;
}
export async function getAccessSegmentScan(scanId) {
  const resp = await axios.get(`${API_BASE}${ACCESS_SEGMENT_SCANS}/${scanId}`, { headers: authHeaders() });
  return resp.data;
}
export async function cancelAccessSegmentScan(scanId) {
  const resp = await axios.post(`${API_BASE}${ACCESS_SEGMENT_SCANS}/${scanId}/cancel`, {}, { headers: authHeaders() });
  return resp.data;
}
export async function deleteAccessSegmentScan(scanId) {
  await axios.delete(`${API_BASE}${ACCESS_SEGMENT_SCANS}/${scanId}`, { headers: authHeaders() });
}
export async function getAccessSegmentCreateProgress(scanId) {
  const resp = await axios.get(`${API_BASE}${ACCESS_SEGMENT_SCANS}/${scanId}/create-progress`, { headers: authHeaders() });
  return resp.data;
}
// Creates each chosen Segment in ISC (or uses the existing one of the same
// name) and assigns its roles, access profiles and entitlements.
export async function createAccessSegmentsFromScan(scanId, suggestionIds, { activate = true } = {}) {
  const resp = await axios.post(
    `${API_BASE}${ACCESS_SEGMENT_SCANS}/${scanId}/create`,
    { suggestionIds, activate },
    { headers: authHeaders(), timeout: 0 }
  );
  return resp.data; // { results: [{ id, ok, merged, segmentId, segmentName, assigned, error }] }
}

export async function createSegmentsFromScan(scanId, suggestionIds) {
  const resp = await axios.post(
    `${API_BASE}/api/insights/segment-scans/${scanId}/create`,
    { suggestionIds },
    { headers: authHeaders() }
  );
  return resp.data; // { results: [{ id, ok, segmentId?, segmentName?, error? }] }
}

// For a suggestion whose name already matches a real segment (nothing was
// created for it), merges its suggested roles/entitlements into that
// EXISTING segment's own Access Model instead.
export async function addScanSuggestionsToExistingSegments(scanId, suggestionIds) {
  const resp = await axios.post(
    `${API_BASE}/api/insights/segment-scans/${scanId}/add-to-existing`,
    { suggestionIds },
    { headers: authHeaders() }
  );
  return resp.data; // { results: [{ id, ok, segmentId?, segmentName?, error? }] }
}

// Runs a full SP-Config export (server polls the async job to completion —
// see server's POST /api/sp-config/backup) and returns the finished export
// JSON plus a suggested filename. Can take a while for a large tenant, hence
// the generous timeout override on top of the shared axios instance's default.
export async function backupSpConfig() {
  return PortedSpConfig.backupSpConfig(); // { filename, data }
}

// Imports a selected subset of a previously exported sp-config JSON — see
// server's POST /api/sp-config/restore. `data` should match the shape of
// the original export (e.g. { objects: [...] }), just narrowed to whatever
// the user selected in the Restore screen's JSON browser.
export async function restoreSpConfig(data) {
  return PortedSpConfig.restoreSpConfig(data); // { result, details }
}

// Writes the recommended mappings back to ISC — every source in the scan
// with proposed changes, or just one (pass sourceId) to deploy a single
// source independently, same idea as the Role Scan page's per-group Create
// Role alongside its bulk Create All Roles. See server's POST .../:id/deploy.
export async function deployAttributeSyncScan(scanId, sourceId) {
  const resp = await axios.post(
    `${API_BASE}/api/insights/attribute-sync-scans/${scanId}/deploy`,
    sourceId ? { sourceId } : {},
    { headers: authHeaders() }
  );
  return resp.data;
}

// items: [{ key, name, dimensional, facts: string[] }, ...]
// Returns { results: [{ key, description } | { key, error }] } — suggestions
// only, nothing written; used to seed each proposed role's description
// before Create All Roles actually creates anything.
export async function generateRoleScanDescriptions(items) {
  return PortedAi.generateRoleScanDescriptions(items);
}

export async function createRoleForPeerGroup(scanId, groupId, { name, description, ownerId, ownerName }) {
  const resp = await axios.post(
    `${API_BASE}/api/insights/role-scans/${scanId}/groups/${groupId}/create-role`,
    { name, description, ownerId, ownerName },
    { headers: authHeaders() }
  );
  return resp.data;
}

// For a peer group whose exact attribute combination already matches an
// existing role (group.existingRole), merges the group's own proposed
// common access into that role instead of creating a duplicate.
export async function mergeRoleGroupIntoExisting(scanId, groupId) {
  const resp = await axios.post(
    `${API_BASE}/api/insights/role-scans/${scanId}/groups/${groupId}/merge-into-existing-role`,
    {},
    { headers: authHeaders() }
  );
  return resp.data; // { roleId, roleName, addedCount }
}

// ─── Role Evaluation scan ──────────────────────────────────────────────────────

// query: an ad-hoc role-name search for this one scan, not a persisted setting.
// considerCommonAccessRoles: optional explicit [{id, name}] list from the
// Roles list "Evaluate" picker (or auto-selected when exactly one common
// role overlaps) — applied to every role this scan evaluates, and shown at
// the top of the scan report. Omit to keep each role's own automatic
// common-access matching.
// roleIds: optional explicit scope (exactly these roles, nothing else) —
// used when the caller already has a specific filtered/selected set on
// screen (e.g. RolesPage's Evaluate icon, which applies Active/Disabled,
// Standard/Dynamic, and Common Access Only filters client-side that a
// name-contains query alone can't reproduce). Omit to scope by `query`
// instead (Role Evaluation's own Start button).
export async function startRoleEvalScan(query, considerCommonAccessRoles, roleIds) {
  return PortedRoleEvalScans.startRoleEvalScan(query, considerCommonAccessRoles, roleIds); // { scanId }
}

export async function listRoleEvalScans() {
  return PortedRoleEvalScans.listRoleEvalScans();
}

export async function getRoleEvalScan(scanId) {
  return PortedRoleEvalScans.getRoleEvalScan(scanId);
}

export async function cancelRoleEvalScan(scanId) {
  return PortedRoleEvalScans.cancelRoleEvalScan(scanId);
}

export async function deleteRoleEvalScan(scanId) {
  await PortedRoleEvalScans.deleteRoleEvalScan(scanId);
}

export async function acceptRoleEvalResult(scanId, roleId) {
  return PortedRoleEvalScans.acceptRoleEvalResult(scanId, roleId);
}

export async function acceptAllRoleEvalResults(scanId) {
  return PortedRoleEvalScans.acceptAllRoleEvalResults(scanId);
}

// Marks a scan result accepted without re-applying it — used after the
// per-item detail sheet already applied everything directly against ISC.
export async function markRoleEvalResultHandled(scanId, roleId) {
  return PortedRoleEvalScans.markRoleEvalResultHandled(scanId, roleId);
}

// ─── Workflows ──────────────────────────────────────────────────────────────
// ISC Workflows, read through the generic proxy (/v2026/workflows). Updates
// use PUT with the full editable object — ISC has no partial-update
// tolerance for read-only fields, so callers strip id/created/modified/
// creator/modifiedBy/executionCount/failureCount before saving.

export async function listWorkflows() {
  return sortByName(await req("GET", "/workflows", { params: { limit: 250 } }));
}

export async function getWorkflow(id) {
  return req("GET", `/workflows/${id}`);
}

// ─── Create a workflow with AI (Workflows > +) ──────────────────────────────
// { outline } from plain-language requirements — or, with a previous outline
// and feedback, that outline revised. Every trigger / step id in it is a real
// id from the tenant's workflow library. Can take a minute.
export async function draftWorkflowOutline({ requirements, outline, feedback }) {
  const resp = await axios.post(`${API_BASE}/api/workflows/ai/outline`, { requirements, outline, feedback }, { headers: authHeaders() });
  return resp.data.outline;
}

// Builds the approved outline into a full workflow and saves it DISABLED:
// { workflow, placeholders } — placeholders are REPLACE_WITH_… values still to
// fill in. A 422 carries { problems } when it couldn't be made valid.
export async function createWorkflowFromOutline({ requirements, outline }) {
  const resp = await axios.post(`${API_BASE}/api/workflows/ai/create`, { requirements, outline }, { headers: authHeaders() });
  return resp.data;
}

// The app's own structural check of a workflow ({ workflow }) or an AI-create
// outline ({ outline }) against the tenant's workflow library — instant, and
// touches nothing in ISC (which has no validate call: it only validates when
// a workflow is ENABLED). { state: "OK" | "ERROR", problems: [] }.
export async function validateWorkflowDraft(payload) {
  return PortedWorkflows.validateWorkflowDraft(payload);
}

// Proposes a modified version of a workflow from a plain-language change —
// changes nothing in ISC. { workflow: { name, description, trigger,
// definition }, summary, notes, diff, placeholders }; `diff` is computed by
// the server, not claimed by the model. proposal + feedback revise a previous
// proposal. A 422 carries { problems }. Save it with updateWorkflow().
// `base` ({ name, description, trigger, definition }) proposes against UNSAVED
// editor content instead of the saved workflow — the diff is then against it.
export async function proposeWorkflowModification(id, { instructions, proposal, feedback, base }) {
  const resp = await axios.post(`${API_BASE}/api/workflows/${id}/ai/modify`, { instructions, proposal, feedback, base }, { headers: authHeaders() });
  return resp.data;
}

// Deletes a workflow. ISC won't delete an enabled one, so the server disables
// it first (and re-enables it if the delete then fails).
export async function deleteWorkflow(id) {
  await PortedWorkflows.deleteWorkflow(id);
}

// Turns a workflow on or off; resolves the updated workflow. ISC validates
// on enable and refuses an incomplete workflow with its own message.
export async function setWorkflowEnabled(id, enabled) {
  return PortedWorkflows.setWorkflowEnabled(id, enabled);
}

// A workflow's runs, newest first as ISC returns them — kept for 90 days.
// status: "Completed" | "Failed" | "Canceled" | "Running" | "Queued" (the
// only filterable field besides start_time).
export async function listWorkflowExecutions(workflowId, { status, limit = 50, offset = 0 } = {}) {
  return req("GET", `/workflows/${workflowId}/executions`, {
    params: { limit, offset, ...(status ? { filters: `status eq "${status}"` } : {}) },
  });
}

// One run's event history, oldest first: [{ type, timestamp, attributes }] —
// types ending in "Failed" carry the error.
export async function getWorkflowExecutionHistory(executionId) {
  return req("GET", `/workflow-executions/${executionId}/history`);
}

// ISC refuses to update a workflow while it's enabled, so saves go through
// the server's own route: with allowDisable it disables, saves and re-enables
// (restoring even if the save is rejected); without it an enabled workflow
// comes back 409 { code: "WORKFLOW_ENABLED" }. Resolves
// { workflow, wasDisabledToSave, reenabled, reenableError? }.
export async function updateWorkflow(id, body, { allowDisable = false } = {}) {
  return PortedWorkflows.updateWorkflow(id, body, { allowDisable });
}

// Raw-JSON tab saves — RFC 6902 ops go through a dedicated server route
// because JSON-Patch endpoints need Content-Type application/json-patch+json
// (the generic /api/isc proxy always sends plain JSON) and data-segments
// need the revert-to-draft flow. resource ∈ roles | entitlements |
// access-profiles | source-apps | sources | data-segments.
export async function patchObjectJson(resource, id, ops) {
  return PortedJsonEdit.patchObjectJson(resource, id, ops);
}

// { svg } — Claude renders the workflow's step graph as a flowchart SVG
// (server-side; see POST /api/workflows/:id/flowchart).
export async function generateWorkflowFlowchart(id) {
  const resp = await axios.post(`${API_BASE}/api/workflows/${id}/flowchart`, {}, { headers: authHeaders() });
  return resp.data;
}

// ─── Transforms ─────────────────────────────────────────────────────────────
// ISC Transforms via the generic proxy. Updates PUT the full object — ISC
// treats name/type as immutable on update (its own error surfaces if an
// edit tries to change them); id/internal are read-only and stripped by
// callers before saving.

export async function listTransforms({ limit = 250, offset = 0 } = {}) {
  return sortByName(await req("GET", "/transforms", { params: { limit, offset } }));
}

// ISC transforms carry no dates, so "last updated" comes from ISC's audit
// events instead: { updated: { [transformId]: { at, by } }, scanned, truncated }.
// A transform with no entry hasn't changed within ISC's audit retention.
export async function getTransformsLastUpdated() {
  return PortedTenantInfo.getTransformsLastUpdated();
}

export async function getTransform(id) {
  return req("GET", `/transforms/${id}`);
}

export async function updateTransform(id, body) {
  return req("PUT", `/transforms/${id}`, { data: body });
}

export async function createTransform(body) {
  return req("POST", "/transforms", { data: body });
}
