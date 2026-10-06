/**
 * ported/entitlements.js
 * Client-side ports of the retired Express server's /api/entitlements/*
 * routes (by-ids / account-members / patch fields / applications). Same
 * arguments and return values as the functions in lib/sailpoint.js that used
 * to call those routes; failures throw route-shaped errors
 * (err.response.status, err.response.data.error).
 *
 * The metadata routes under /api/entitlements/* live in metadataTagging.js;
 * generate-description needs the server's AI key and is not ported.
 */

import { iscGet, iscPost, iscPatch, withApiRetry, routeError, badRequest } from "../isc";
import { mapWithConcurrency } from "./roleShared";
import { EXPERIMENTAL_HEADERS } from "./sourceErrors";

const SOURCE_APPS_V1 = "/source-apps/v1";

/**
 * GET /api/entitlements/by-ids?ids=id1,id2,...
 * Bulk fetch via an `id in (...)` filter, retried with backoff so a transient
 * 429/5xx (the bulk Detail Report print fires this for every listed role in
 * quick succession) is retried instead of failing outright.
 */
export async function getEntitlementsByIds(ids) {
  const list = Array.isArray(ids) ? ids.filter(Boolean) : [];
  if (list.length === 0) return [];
  try {
    const filters = `id in (${list.map((id) => `"${id}"`).join(",")})`;
    return await withApiRetry(
      () => iscGet("/v2026/entitlements", { filters, limit: list.length }),
      { label: "entitlements by-ids" }
    );
  } catch (err) {
    console.error("[entitlements] by-ids failed:", err.response?.data || err.message);
    throw routeError(err);
  }
}

/**
 * GET /api/entitlements/:id/account-members
 * Fallback "who holds this" for entitlements the search index doesn't show
 * yet — fresh delimited-source grants only reach @access() after
 * aggregation + identity refresh + search indexing all land. Reads the
 * source's own accounts and matches the entitlement's attribute/value
 * directly, so the Members tab reflects account data immediately.
 * Uncorrelated accounts (no identity) are counted but not listed — there's
 * no identity screen to open for them. { members, total, uncorrelated }.
 */
export async function listEntitlementAccountMembers(entitlementId) {
  try {
    const ent = await iscGet(`/v2026/entitlements/${entitlementId}`);
    const sourceId = ent.source?.id;
    if (!sourceId || !ent.attribute) return { members: [], total: 0, uncorrelated: 0 };
    const value = String(ent.value ?? "");
    const members = new Map();
    let uncorrelated = 0;
    for (let offset = 0; offset < 2000; offset += 250) {
      const page = await withApiRetry(
        () => iscGet("/v2025/accounts", { filters: `sourceId eq "${sourceId}"`, limit: 250, offset }),
        { label: "entitlements: account-members page" }
      );
      for (const acct of page) {
        const v = acct.attributes?.[ent.attribute];
        const has = Array.isArray(v)
          ? v.map(String).includes(value)
          : typeof v === "string"
          ? v === value || v.split(",").map((x) => x.trim()).includes(value)
          : v != null && String(v) === value;
        if (!has) continue;
        if (!acct.identityId) { uncorrelated += 1; continue; }
        if (!members.has(acct.identityId)) {
          members.set(acct.identityId, { id: acct.identityId, name: acct.name, displayName: acct.name, attributes: {} });
        }
      }
      if (page.length < 250) break;
    }
    const list = [...members.values()].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    return { members: list, total: list.length, uncorrelated };
  } catch (err) {
    console.error("[entitlements] account-members failed:", err.response?.data || err.message);
    throw routeError(err);
  }
}

/**
 * PATCH /api/entitlements/:id
 * fields: any of { name, description, owner: {id,name}, requestable,
 * privilegeLevel } — JSON Patch (ISC requires the json-patch content type).
 * Backs the Entitlement Detail edit modal and the Entitlements list's bulk
 * Generate Descriptions, Change Owner, and Make Requestable/No Requests
 * actions. Returns the entitlement as ISC now reports it, plus `unapplied`:
 * the requested fields ISC accepted but did not keep (read-only source).
 */
export async function updateEntitlement(id, fields) {
  const { name, description, owner, requestable, privilegeLevel } = fields || {};

  const ops = [];
  if (name !== undefined) {
    if (!name || !name.trim()) throw badRequest("name can't be empty.");
    ops.push({ op: "replace", path: "/name", value: name });
  }
  if (description !== undefined) {
    ops.push({ op: "replace", path: "/description", value: description });
  }
  if (owner !== undefined) {
    if (!owner?.id) throw badRequest("owner must have an id.");
    ops.push({ op: "replace", path: "/owner", value: { type: "IDENTITY", id: owner.id, name: owner.name } });
  }
  if (requestable !== undefined) {
    ops.push({ op: "replace", path: "/requestable", value: !!requestable });
  }
  // Privilege level is set as an override (ISC's patchable
  // privilegeOverride/level) — it becomes privilegeLevel.direct with
  // setByType OVERRIDE, and the effective level follows it. NONE is a real
  // level ("no privilege"), not "clear the override". "add" rather than
  // "replace" so it works whether or not an override already exists.
  if (privilegeLevel !== undefined) {
    const level = String(privilegeLevel || "").toUpperCase();
    if (!["HIGH", "MEDIUM", "LOW", "NONE"].includes(level)) {
      throw badRequest("privilegeLevel must be HIGH, MEDIUM, LOW, or NONE.");
    }
    ops.push({ op: "add", path: "/privilegeOverride/level", value: level });
  }
  if (ops.length === 0) {
    throw badRequest("Provide at least one field to update.");
  }

  try {
    const path = `/v2026/entitlements/${id}`;
    console.log(`[entitlements] patch ${id}:`, JSON.stringify(ops));
    // ISC documents privilege as patchable at privilegeOverride/level but is
    // vague about the operation, so a rejected first form is retried with
    // the alternatives before giving up. Every other field goes as-is.
    const privilegeOp = ops.find((o) => o.path === "/privilegeOverride/level");
    const otherOps = ops.filter((o) => o !== privilegeOp);
    if (otherOps.length) await iscPatch(path, otherOps);
    if (privilegeOp) {
      const attempts = [
        [{ op: "replace", path: "/privilegeOverride/level", value: privilegeOp.value }],
        [{ op: "add", path: "/privilegeOverride/level", value: privilegeOp.value }],
        [{ op: "add", path: "/privilegeOverride", value: { level: privilegeOp.value } }],
        [{ op: "replace", path: "/privilegeLevel/direct", value: privilegeOp.value }],
      ];
      let lastErr = null;
      let applied = false;
      for (const attempt of attempts) {
        try {
          const accepted = await iscPatch(path, attempt);
          console.log(`[entitlements] privilege patch accepted: ${JSON.stringify(attempt)} -> privilegeLevel=${JSON.stringify(accepted?.privilegeLevel)}`);
          applied = true;
          break;
        } catch (err) {
          lastErr = err;
          const status = err.response?.status;
          console.warn(`[entitlements] privilege patch ${JSON.stringify(attempt)} -> ${status}: ${JSON.stringify(err.response?.data || err.message).slice(0, 300)}`);
          if (status !== 400 && status !== 404 && status !== 422) break;
        }
      }
      if (!applied) throw lastErr;
    }
    // Confirm what ISC now reports rather than trusting the patch response:
    // ISC answers 200 and then silently keeps the old values for an
    // entitlement whose source is read-only (verified live), and the
    // effective privilege level can lag its override. Every requested field
    // ISC didn't keep is named in `unapplied` so the caller can say so.
    const fresh = await iscGet(path);
    const unapplied = [];
    if (name !== undefined && (fresh?.name || "") !== name) unapplied.push("name");
    if (description !== undefined && (fresh?.description || "") !== (description || "")) unapplied.push("description");
    if (owner !== undefined && fresh?.owner?.id !== owner.id) unapplied.push("owner");
    if (requestable !== undefined && !!fresh?.requestable !== !!requestable) unapplied.push("requestable");
    if (privilegeOp) {
      const now = String(fresh?.privilegeLevel?.direct || fresh?.privilegeLevel?.effective || "").toUpperCase();
      console.log(`[entitlements] privilege after patch: ${JSON.stringify(fresh?.privilegeLevel)}`);
      if (now !== privilegeOp.value) unapplied.push("privilege level");
    }
    if (unapplied.length) console.warn(`[entitlements] patch ${id}: ISC accepted but did not keep: ${unapplied.join(", ")} (read-only source?)`);
    return { ...fresh, unapplied };
  } catch (err) {
    console.error("[entitlements] edit failed:", err.response?.data || err.message);
    throw routeError(err);
  }
}

/**
 * GET /api/entitlements/:id/applications
 * Entitlements have no direct app link in ISC's model — an Application only
 * grants access through the Access Profiles assigned to it — so this joins
 * access-profiles-containing-this-entitlement against apps-on-this-
 * entitlement's-source. [{ id, name, description, via: [profile names] }].
 */
export async function listEntitlementApplications(entitlementId) {
  try {
    const entitlement = await withApiRetry(
      () => iscGet(`/v2026/entitlements/${entitlementId}`),
      { label: "entitlement applications: get entitlement" }
    );
    const sourceId = entitlement?.source?.id;
    if (!sourceId) return [];

    const [profileHits, apps] = await Promise.all([
      withApiRetry(
        () =>
          iscPost(
            "/v2026/search",
            { indices: ["accessprofiles"], query: { query: `entitlements.id:"${entitlementId}"` }, sort: ["name"] },
            { params: { limit: 250 } }
          ).then((d) => d || []),
        { label: "entitlement applications: access profiles containing entitlement" }
      ),
      withApiRetry(
        () => iscGet(`${SOURCE_APPS_V1}/all`, { filters: `accountSource.id eq "${sourceId}"` }, EXPERIMENTAL_HEADERS).then((d) => d || []),
        { label: "entitlement applications: apps for source" }
      ),
    ]);
    const profileIds = new Set(profileHits.map((p) => p.id));
    if (profileIds.size === 0 || apps.length === 0) return [];

    const appsWithMatches = await mapWithConcurrency(apps, 4, async (app) => {
      const profiles = await withApiRetry(
        () => iscGet(`${SOURCE_APPS_V1}/${app.id}/access-profiles`, undefined, EXPERIMENTAL_HEADERS).then((d) => d || []),
        { label: `entitlement applications: access profiles for app ${app.id}` }
      );
      return { app, matched: profiles.filter((p) => profileIds.has(p.id)) };
    });

    return appsWithMatches
      .filter(({ matched }) => matched.length > 0)
      .map(({ app, matched }) => ({
        id: app.id,
        name: app.name,
        description: app.description,
        via: matched.map((p) => p.name),
      }))
      .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  } catch (err) {
    console.error("[entitlements] applications failed:", err.response?.data || err.message);
    throw routeError(err);
  }
}
