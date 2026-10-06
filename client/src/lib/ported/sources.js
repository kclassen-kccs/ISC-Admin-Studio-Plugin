/**
 * ported/sources.js
 * Browser-side port of the old Express /api/sources/* routes (aggregation,
 * reset, delete, history, accounts, load-accounts file, disconnected-source
 * create, edit, apps, datasets, resources) and /api/apps + /api/source-apps/*.
 *
 * Each export returns the same body the route used to send. Failures throw
 * routeError()/badRequest() so callers still read err.response.data.error.
 */

import {
  iscGet,
  iscPost,
  iscPatch,
  iscDelete,
  iscRaw,
  withApiRetry,
  describeError,
  routeError,
  badRequest,
} from "../isc";
import { getCredentials } from "../sailpoint";
import { routeErrorMessages, routeErrorCauses, EXPERIMENTAL_HEADERS, base64ToBlob } from "./sourceErrors";

const SOURCE_DESCRIPTION_MAX_LENGTH = 255;
const SOURCE_AGGREGATION_HISTORY_LIMIT = 250;
const SOURCE_APPS_V1 = "/source-apps/v1";

// ─── Mail Distribution Group mining ─────────────────────────────────────────

// The OU structure of an AD source, derived from data already aggregated
// into ISC — account distinguishedNames plus group entitlement value DNs.
// (There's no public "browse the directory tree" API.)
export async function listAdOus(sourceId) {
  const ouOf = (dn) => {
    if (typeof dn !== "string" || !/DC=/i.test(dn)) return null;
    const parts = dn.split(",").map((x) => x.trim());
    while (parts.length && /^CN=/i.test(parts[0])) parts.shift();
    if (!parts.length || !parts.some((x) => /^OU=/i.test(x))) return null;
    return parts.join(",");
  };
  try {
    const counts = new Map();
    for (let offset = 0; offset < 1000; offset += 250) {
      const page = await withApiRetry(
        () => iscGet("/v2025/accounts", { filters: `sourceId eq "${sourceId}"`, limit: 250, offset }),
        { label: "ad-ous: accounts page" }
      );
      for (const acct of page) {
        const ou = ouOf(acct.attributes?.distinguishedName || acct.attributes?.dn);
        if (ou) counts.set(ou, (counts.get(ou) || 0) + 1);
      }
      if (page.length < 250) break;
    }
    for (let offset = 0; offset < 1000; offset += 250) {
      const page = await withApiRetry(
        () => iscGet("/v2026/entitlements", { filters: `source.id eq "${sourceId}"`, limit: 250, offset }),
        { label: "ad-ous: entitlements page" }
      );
      for (const ent of page) {
        const ou = ouOf(ent.value) || ouOf(ent.attributes?.distinguishedName);
        if (ou) counts.set(ou, (counts.get(ou) || 0) + 1);
      }
      if (page.length < 250) break;
    }
    const ous = [...counts.entries()]
      .map(([dn, count]) => ({ dn, count }))
      .sort((a, b) => b.count - a.count || a.dn.localeCompare(b.dn));
    return { ous };
  } catch (err) {
    throw routeError(err);
  }
}

// ─── Source aggregation ───────────────────────────────────────────────────────
// Verified live against the tenant:
//   POST /v2026/sources/:id/load-accounts        — real (405 on GET, confirms
//     the route exists; POST-only). Triggers account/user aggregation.
//     ?disableOptimization=true runs it unoptimized (full re-evaluation of
//     every account instead of delta), matching ISC's own "Account
//     Aggregation" vs "Unoptimized Aggregation" admin UI actions.
//   POST /v2026/entitlements/aggregate/sources/:id — real (405 on GET).
//     Triggers entitlement aggregation for the source.
//   GET  /v2026/task-status — real, returns recent tasks including
//     target.id/target.name for source-scoped ones (e.g. "Cloud Account
//     Aggregation") and completionStatus. No server-side filter by target.id
//     is accepted (confirmed: 500s) — filtered client-side instead.

export async function aggregateSourceAccounts(sourceId, disableOptimization = false) {
  try {
    return await iscPost(`/v2026/sources/${sourceId}/load-accounts`, {}, { params: { disableOptimization: disableOptimization === true } });
  } catch (err) {
    throw routeError(err);
  }
}

export async function aggregateSourceEntitlements(sourceId) {
  try {
    return await iscPost(`/v2026/entitlements/aggregate/sources/${sourceId}`, {});
  } catch (err) {
    throw routeError(err);
  }
}

// Runs ISC's connector "test configuration" check against the source and
// returns its StatusResponse verbatim — { id, name, status: SUCCESS|FAILURE,
// elapsedMillis, details }. Read-only. A FAILURE comes back as a 200 with
// status "FAILURE", exactly as ISC reports it.
export async function testSourceConfiguration(sourceId) {
  try {
    return await iscPost(`/v2026/sources/${sourceId}/connector/test-configuration`, {});
  } catch (err) {
    throw routeError(err);
  }
}

// ─── Source reset ──────────────────────────────────────────────────────────────
// ISC has no single "reset everything" endpoint (its old non-public
// POST /api/source/reset/ was deprecated in Nov 2023 with no direct
// replacement). The two real, verified (405-on-GET) routes are:
//   POST /v2026/entitlements/reset/sources/:id — removes every entitlement
//     aggregated for the source.
//   POST /v2026/sources/:id/remove-accounts — removes every account
//     aggregated for the source (a re-aggregation can recreate them).
// "Source Reset" (full) is composed from those two calls in sequence.

const resetEntitlementsUpstream = (sourceId) => iscPost(`/v2026/entitlements/reset/sources/${sourceId}`, {});
const resetAccountsUpstream = (sourceId) => iscPost(`/v2026/sources/${sourceId}/remove-accounts`, {});

export async function resetSourceEntitlements(sourceId) {
  try {
    return await resetEntitlementsUpstream(sourceId);
  } catch (err) {
    throw routeError(err);
  }
}

export async function resetSourceAccounts(sourceId) {
  try {
    return await resetAccountsUpstream(sourceId);
  } catch (err) {
    throw routeError(err);
  }
}

// Deletes every aggregated account AND entitlement for this source.
// Entitlements first: removing accounts first can leave entitlement-to-account
// correlation in a stale state until the next aggregation. If entitlement
// reset succeeds but account removal then fails, that's reported as a partial
// failure ({ entitlements, accountsError } — the old route's 207 body, which
// axios resolved as a success) rather than silently swallowed.
export async function resetSource(sourceId) {
  try {
    const entitlements = await resetEntitlementsUpstream(sourceId);
    try {
      const accounts = await resetAccountsUpstream(sourceId);
      return { entitlements, accounts };
    } catch (accountsErr) {
      console.error("[sources] reset: entitlements reset OK, account removal failed:", accountsErr.response?.data || accountsErr.message);
      return { entitlements, accountsError: describeError(accountsErr) };
    }
  } catch (err) {
    throw routeError(err);
  }
}

// Permanently deletes the source. ISC itself rejects this if the source is
// still referenced (an Identity Profile's authoritative source, roles/access
// profiles with entitlements from it, etc.) — that real error is surfaced
// as-is rather than retried, since it means something else needs cleaning
// up first.
export async function deleteSource(id) {
  try {
    // Right after deleting a dependent Identity Profile, ISC can still
    // reject the source delete for a few seconds with "in use by
    // [identityProfiles]" while that removal finishes propagating
    // (verified live: the exact same delete succeeded on retry once the
    // reference actually cleared) — retried here rather than surfaced as a
    // hard failure, since it isn't one.
    let lastErr;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await iscDelete(`/v2026/sources/${id}`);
        return;
      } catch (err) {
        lastErr = err;
        const stillInUse = err.response?.status === 400 && /in use by/i.test(err.response?.data?.messages?.[0]?.text || "");
        if (!stillInUse || attempt === 4) throw err;
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
    throw lastErr;
  } catch (err) {
    throw routeErrorMessages(err);
  }
}

// Recent aggregation-related tasks for this source.
export async function getSourceAggregationHistory(sourceId) {
  try {
    const tasks = await iscGet("/v2026/task-status", { limit: SOURCE_AGGREGATION_HISTORY_LIMIT, sorters: "-created" });
    return tasks.filter((t) => t.target?.id === sourceId);
  } catch (err) {
    throw routeError(err);
  }
}

// ─── Accounts ─────────────────────────────────────────────────────────────────

/**
 * Fetches a source's accounts, working around a real ISC inconsistency:
 * which property actually filters /v2026/accounts by source ("source.id"
 * vs "sourceId") depends on the source's connector type, and which property
 * accepts the "co" (contains) operator for name search varies too — a
 * combination that worked for one source 400'd for another with either
 * "Invalid filter properties" or "Illegal value \"operation co\"".
 * Verified live against two different real sources in this tenant.
 *
 * Tries source.id/sourceId, each with and without the "co" search clause;
 * once a (field, no-co) combination succeeds, search is applied client-side
 * instead.
 *
 * One page plus the real total (ISC's X-Total-Count via count=true). When the
 * name search has to fall back to filtering client-side, the total is of the
 * filtered PAGE only and `totalIsExact` says so.
 */
export async function listAccountsBySource(sourceId, { query, limit = 100, offset = 0 } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 100, 1), 250);
  const off = Math.max(Number(offset) || 0, 0);
  const fields = ["source.id", "sourceId"];
  const attempts = [];
  for (const field of fields) {
    if (query) attempts.push({ field, filters: `${field} eq "${sourceId}" and name co "${query}"`, clientFilter: false });
  }
  for (const field of fields) {
    attempts.push({ field, filters: `${field} eq "${sourceId}"`, clientFilter: true });
  }

  let lastErr;
  for (const attempt of attempts) {
    try {
      const resp = await iscRaw("get", "/v2026/accounts", {
        params: { filters: attempt.filters, sorters: "name", limit: lim, offset: off, count: true },
      });
      const accounts = Array.isArray(resp.data) ? resp.data : [];
      const header = resp.headers?.["x-total-count"];
      const total = header != null ? Number(header) : null;
      if (attempt !== attempts[0]) {
        console.warn(`[sources] accounts fallback used for source ${sourceId}: ${attempt.filters}`);
      }
      if (attempt.clientFilter && query) {
        const q = query.toLowerCase();
        const filtered = accounts.filter((a) => (a.name || a.displayName || "").toLowerCase().includes(q));
        return { accounts: filtered, total: filtered.length, totalIsExact: false };
      }
      return { accounts, total, totalIsExact: total != null };
    } catch (err) {
      lastErr = err;
    }
  }
  throw routeError(lastErr);
}

// Same source.id/sourceId filter-field inconsistency as above, but paginated
// to the full set (export needs every account, not just the first page) and
// without the "co" search complexity — export never searches.
export async function exportSourceAccounts(sourceId) {
  const fields = ["source.id", "sourceId"];
  const pageSize = 250;
  let lastErr;
  for (const field of fields) {
    try {
      const all = [];
      let offset = 0;
      while (true) {
        const page = await iscGet("/v2026/accounts", {
          filters: `${field} eq "${sourceId}"`,
          sorters: "name",
          limit: pageSize,
          offset,
        });
        if (!Array.isArray(page) || page.length === 0) break;
        all.push(...page);
        if (page.length < pageSize) break;
        offset += pageSize;
      }
      return all;
    } catch (err) {
      lastErr = err;
    }
  }
  throw routeError(lastErr);
}

// Uploads an edited accounts CSV as a real multipart file (matching how ISC's
// own admin UI does a manual account load) to /v2026/sources/:id/load-accounts.
// The file is built in the browser from the base64 payload — nothing is
// written anywhere.
export async function loadAccountsFile(sourceId, { filename, csvBase64, disableOptimization } = {}) {
  if (typeof csvBase64 !== "string" || !csvBase64) throw badRequest("csvBase64 is required.");
  const safeFilename = typeof filename === "string" && filename ? filename : "accounts.csv";
  try {
    const form = new FormData();
    form.append("file", base64ToBlob(csvBase64), safeFilename);
    const resp = await iscRaw("post", `/v2026/sources/${sourceId}/load-accounts`, {
      params: disableOptimization === true ? { disableOptimization: true } : undefined,
      data: form,
    });
    return resp.data;
  } catch (err) {
    throw routeError(err);
  }
}

// ─── Disconnected Source creation wizard ───────────────────────────────────
// Create a DelimitedFile source, POST a sample CSV to ISC's
// /sources/v1/:id/schemas/accounts to auto-detect its schema (a DIFFERENT API
// root than /v2026 or /beta — confirmed live, /v2026 equivalents all 404/405),
// let the reviewer confirm the UID + Account Name attributes, PUT the schema
// back with those set, then reuse loadAccountsFile to aggregate.

// Creates a bare DelimitedFile source with no schema yet — the wizard's next
// step (detect-schema) is what gives it one.
export async function createDisconnectedSource({ name } = {}) {
  const nm = String(name || "").trim();
  if (!nm) throw badRequest("name is required.");
  try {
    return await iscPost("/v2026/sources", {
      name: nm,
      description: nm,
      owner: { type: "IDENTITY", id: getCredentials()?.identityId },
      type: "DelimitedFile",
      connector: "delimited-file-angularsc",
      connectorClass: "sailpoint.connector.delimitedfile.DelimitedFileConnector",
      connectorAttributes: {
        connectionType: "file",
        filetransport: "local",
        host: "local",
        delimiter: ",",
        hasHeader: true,
        indexColumns: ["id"],
        indexColumn: "id",
        mergeRows: true,
        filterEmptyRecords: true,
        deleteThresholdPercentage: 10,
        templateApplication: "DelimitedFile Template",
      },
      deleteThreshold: 10,
    });
  } catch (err) {
    throw routeErrorMessages(err);
  }
}

// ─── Source edit ──────────────────────────────────────────────────────────────

// Same JSON Patch requirement as access profiles (SailPoint rejects a plain
// application/json PATCH here too). Scoped to just description.
export async function updateSourceDescription(id, description) {
  if (description === undefined) throw badRequest("description is required.");
  if (typeof description === "string" && description.length > SOURCE_DESCRIPTION_MAX_LENGTH) {
    throw badRequest(`Source descriptions are limited to ${SOURCE_DESCRIPTION_MAX_LENGTH} characters (this one is ${description.length}).`);
  }
  try {
    return await iscPatch(`/v2026/sources/${id}`, [{ op: "replace", path: "/description", value: description }]);
  } catch (err) {
    throw routeError(err);
  }
}

// fields: any of { name, description, owner: {id,name},
// managementWorkgroup: {id,name} | null } — the Source edit dialog. ISC's
// Source has no additionalOwners list; its one extra-owner slot is the
// management workgroup (a governance group whose members administer the
// source), so that's what the dialog's "Additional owners" edits. null
// clears it.
export async function updateSource(id, fields) {
  const { name, description, owner, managementWorkgroup } = fields || {};
  const ops = [];
  if (name !== undefined) {
    if (!name || !String(name).trim()) throw badRequest("name can't be empty.");
    ops.push({ op: "replace", path: "/name", value: String(name).trim() });
  }
  if (description !== undefined) {
    if (typeof description === "string" && description.length > SOURCE_DESCRIPTION_MAX_LENGTH) {
      throw badRequest(`Source descriptions are limited to ${SOURCE_DESCRIPTION_MAX_LENGTH} characters (this one is ${description.length}).`);
    }
    ops.push({ op: "replace", path: "/description", value: description });
  }
  if (owner !== undefined) {
    if (!owner?.id) throw badRequest("owner must have an id.");
    ops.push({ op: "replace", path: "/owner", value: { type: "IDENTITY", id: owner.id, name: owner.name } });
  }
  if (managementWorkgroup !== undefined) {
    if (managementWorkgroup === null) ops.push({ op: "remove", path: "/managementWorkgroup" });
    else if (!managementWorkgroup?.id) throw badRequest("managementWorkgroup must have an id.");
    // "add" sets the member whether or not the source already has one.
    else ops.push({ op: "add", path: "/managementWorkgroup", value: { type: "GOVERNANCE_GROUP", id: managementWorkgroup.id, name: managementWorkgroup.name } });
  }
  if (ops.length === 0) throw badRequest("Provide at least one field to update.");

  try {
    return await iscPatch(`/v2026/sources/${encodeURIComponent(id)}`, ops);
  } catch (err) {
    throw routeError(err);
  }
}

// ─── Source Applications ────────────────────────────────────────────────────
// ISC's "Applications" (Access Model > Applications in its own UI) — each
// belongs to exactly one source (accountSource). NOT /v2026/source-apps —
// that experimental v2026 surface returns an empty list/count for this
// tenant regardless of query params (verified live), while the legacy
// source-apps/v1/* endpoints (no /v2026 or /beta prefix, just the tenant
// host) return the real data — confirmed live against this tenant's Active
// Directory source, which has real Applications ("Accounting", "Corporate
// Network Access") only visible via v1.

const byName = (a, b) => (a.name || "").localeCompare(b.name || "");

// Every Application configured on this source, sorted by name.
export async function listSourceApps(sourceId) {
  try {
    const data = await iscGet(`${SOURCE_APPS_V1}/all`, { filters: `accountSource.id eq "${sourceId}"` }, EXPERIMENTAL_HEADERS);
    return (data || []).sort(byName);
  } catch (err) {
    throw routeError(err);
  }
}

// Every Application tenant-wide (across all sources), sorted by name.
export async function listAllSourceApps() {
  try {
    const data = await iscGet(`${SOURCE_APPS_V1}/all`, undefined, EXPERIMENTAL_HEADERS);
    return (data || []).sort(byName);
  } catch (err) {
    throw routeError(err);
  }
}

// matchAllAccounts defaults true (an Application with no narrower
// account-matching criteria built here covers every account on the source,
// same as ISC's own "quick create") — the client's Specific Users/All Users
// dropdown can override it to false.
export async function createSourceApp(sourceId, { name, description, owner, matchAllAccounts } = {}) {
  const nm = String(name || "").trim();
  if (!nm) throw badRequest("name is required.");
  try {
    const body = {
      name: nm,
      // Defaults to the name itself — the create dialog doesn't collect a
      // description; Generate Descriptions replaces this with a real one
      // once the app has enough data (access profiles) to ground one in.
      description: description || nm,
      matchAllAccounts: matchAllAccounts !== undefined ? !!matchAllAccounts : true,
      accountSource: { id: sourceId },
    };
    if (owner?.id) body.owner = { id: owner.id };
    return await iscPost(SOURCE_APPS_V1, body, { headers: EXPERIMENTAL_HEADERS });
  } catch (err) {
    throw routeErrorMessages(err);
  }
}

export async function getSourceApp(id) {
  try {
    return await iscGet(`${SOURCE_APPS_V1}/${id}`, undefined, EXPERIMENTAL_HEADERS);
  } catch (err) {
    throw routeError(err);
  }
}

export async function deleteSourceApp(id) {
  try {
    await iscDelete(`${SOURCE_APPS_V1}/${id}`, { headers: EXPERIMENTAL_HEADERS });
  } catch (err) {
    throw routeError(err);
  }
}

// Any of { name, description, owner: {id,name}, matchAllAccounts, enabled,
// appCenterEnabled ("Visible"), provisionRequestEnabled ("Requestable") } —
// one PATCH op per field actually present, so a single-field toggle doesn't
// have to resend the whole record.
export async function updateSourceApp(id, fields) {
  const body = fields || {};
  const ops = [];
  if (body.name !== undefined) ops.push({ op: "replace", path: "/name", value: body.name });
  if (body.description !== undefined) ops.push({ op: "replace", path: "/description", value: body.description });
  if (body.owner?.id) ops.push({ op: "replace", path: "/owner", value: { id: body.owner.id } });
  if (body.matchAllAccounts !== undefined) ops.push({ op: "replace", path: "/matchAllAccounts", value: !!body.matchAllAccounts });
  if (body.enabled !== undefined) ops.push({ op: "replace", path: "/enabled", value: !!body.enabled });
  if (body.appCenterEnabled !== undefined) ops.push({ op: "replace", path: "/appCenterEnabled", value: !!body.appCenterEnabled });
  if (body.provisionRequestEnabled !== undefined) ops.push({ op: "replace", path: "/provisionRequestEnabled", value: !!body.provisionRequestEnabled });
  if (ops.length === 0) throw badRequest("Provide at least one field to update.");
  try {
    return await iscPatch(`${SOURCE_APPS_V1}/${id}`, ops, { headers: EXPERIMENTAL_HEADERS });
  } catch (err) {
    throw routeError(err);
  }
}

// The Access Profiles assigned to this Application.
export async function listSourceAppAccessProfiles(appId) {
  try {
    return await iscGet(`${SOURCE_APPS_V1}/${appId}/access-profiles`, undefined, EXPERIMENTAL_HEADERS);
  } catch (err) {
    throw routeError(err);
  }
}

// add/remove: access profile id arrays. Add uses a plain POST of the id array
// to ISC's own .../access-profiles collection endpoint; remove uses its
// documented bulk-remove sibling. Returns the app's resulting list.
export async function updateSourceAppAccessProfiles(appId, { add, remove } = {}) {
  const addIds = Array.isArray(add) ? add : [];
  const removeIds = Array.isArray(remove) ? remove : [];
  if (addIds.length === 0 && removeIds.length === 0) throw badRequest("Provide add and/or remove access profile ids.");
  try {
    const path = `${SOURCE_APPS_V1}/${appId}/access-profiles`;
    if (addIds.length > 0) {
      // ISC's own POST .../access-profiles REPLACES the app's whole
      // assigned list rather than appending to it (verified live: adding a
      // second profile silently dropped the first) — so this reads the
      // currently-assigned ids first and posts the union, making "add"
      // actually additive from the caller's perspective.
      const current = await iscGet(path, undefined, EXPERIMENTAL_HEADERS);
      const currentIds = (current || []).map((p) => p.id);
      const merged = [...new Set([...currentIds, ...addIds])];
      await iscPost(path, merged, { headers: EXPERIMENTAL_HEADERS });
    }
    if (removeIds.length > 0) {
      await iscPost(`${path}/bulk-remove`, removeIds, { headers: EXPERIMENTAL_HEADERS });
    }
    return await iscGet(path, undefined, EXPERIMENTAL_HEADERS);
  } catch (err) {
    throw routeError(err);
  }
}

// ─── Datasets / resources ────────────────────────────────────────────────────
// Un-versioned /sources/v1 surface (no /v2026 or /beta prefix), gated behind
// the same experimental header source-apps needs — without it the API rejects
// the call outright with 400 "Experimental Header 'X-SailPoint-Experimental'
// is missing or invalid", even though the path and token are fine.

// Either a bare array or a paged {items:[...]}-style envelope, depending on
// what this surface returns for the tenant — normalised to a name-sorted array.
const normalizeList = (data) => {
  const list = Array.isArray(data) ? data : (data?.items || data?.data || []);
  return [...list].sort((a, b) => String(a?.name || a?.id || "").localeCompare(String(b?.name || b?.id || "")));
};

// A source's datasets — the sample data ISC keeps from account/group
// aggregation. Shape per the SailPoint Go SDK's SourceDataset model:
// { id, name, description, aggregationEnabled, resources: [{ id, name, type }] }
export async function listSourceDatasets(sourceId) {
  try {
    return normalizeList(await iscGet(`/sources/v1/${sourceId}/datasets`, undefined, EXPERIMENTAL_HEADERS));
  } catch (err) {
    throw routeError(err);
  }
}

// Runs aggregation for one dataset. POST /sources/v1/{sourceId}/datasets/
// {datasetId}/aggregate with a DatasetAggregationRequest whose only field,
// `config`, is an optional connector-specific map — sent empty, same as
// triggering it from ISC's own UI with no overrides.
export async function aggregateSourceDataset(sourceId, datasetId) {
  try {
    return (await iscPost(`/sources/v1/${sourceId}/datasets/${datasetId}/aggregate`, { config: {} }, { headers: EXPERIMENTAL_HEADERS })) ?? {};
  } catch (err) {
    throw routeError(err);
  }
}

// Body: RFC 6902 ops array (a top-level diff built by the caller). PUT exists
// too, but a patch of only what changed is what every raw-JSON editor sends.
// ISC's `causes` array is half the story for a 400 (the endpoint whitelists
// patchable fields), so both messages[] and causes[] are surfaced.
export async function updateSourceDataset(sourceId, datasetId, ops) {
  if (!Array.isArray(ops) || ops.length === 0) throw badRequest("A non-empty JSON Patch ops array is required.");
  try {
    return (await iscPatch(`/sources/v1/${sourceId}/datasets/${datasetId}`, ops, { headers: EXPERIMENTAL_HEADERS })) ?? {};
  } catch (err) {
    console.error("[sources] dataset update failed:", JSON.stringify({ ops, response: err.response?.data || err.message }, null, 2));
    throw routeErrorCauses(err);
  }
}

// A source's resources — the objects a dataset is made of (per the SDK's
// SourceDatasetResource model: { id, name, type, datasetId, features, schema }).
export async function listSourceResources(sourceId) {
  try {
    return normalizeList(await iscGet(`/sources/v1/${sourceId}/resources`, undefined, EXPERIMENTAL_HEADERS));
  } catch (err) {
    throw routeError(err);
  }
}

// PATCH /sources/v1/{sourceId}/resources/{resourceId}. Its rules are looser on
// paper than the dataset endpoint's — "connectors with the
// supportDatasetCreation label can update additional resource fields", with
// no field promised as always-writable, and schema edits are directed to the
// schema APIs — so the caller keeps the diff to name/type/datasetId/features
// and ISC's own causes are surfaced on a 400.
export async function updateSourceResource(sourceId, resourceId, ops) {
  if (!Array.isArray(ops) || ops.length === 0) throw badRequest("A non-empty JSON Patch ops array is required.");
  try {
    return (await iscPatch(`/sources/v1/${sourceId}/resources/${resourceId}`, ops, { headers: EXPERIMENTAL_HEADERS })) ?? {};
  } catch (err) {
    console.error("[sources] resource update failed:", JSON.stringify({ ops, response: err.response?.data || err.message }, null, 2));
    throw routeErrorCauses(err);
  }
}
