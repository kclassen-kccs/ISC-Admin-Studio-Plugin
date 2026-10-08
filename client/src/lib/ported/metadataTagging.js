/**
 * ported/metadataTagging.js
 * Access Model Metadata ("Segments by Metadata") tagging — the part of the old
 * server's segment code that role edits depend on: when entitlements are added
 * to a role they inherit the segment-boundary values the role is tagged with
 * (tagEntitlementsWithRoleBoundaryValues), and Role Evaluation checks/repairs a
 * role's own segment tags (ensureRoleSegmentMetadata).
 *
 * Ports of: ensureBoundaryMetadataAttribute, boundaryValueSlug,
 * ensureBoundaryMetadataValue, bulkTagEntitlements, tagAccessWithBoundaryValue,
 * tagEntitlementsWithRoleBoundaryValues, ensureRoleSegmentMetadata — and, at
 * the bottom, the server's metadata ROUTES (per-object add/remove, bulk-tag,
 * value access listing, value delete, metadata-value-guids).
 */

import { iscGet, iscPost, iscPatch, iscDelete, iscRaw, iscSearchPage, withApiRetry, describeError, routeError, badRequest } from "../isc";
import { routeErrorMessages } from "./sourceErrors";
import { recordStore } from "../store";
import {
  tenantKey,
  mapWithConcurrency,
  getTenantSettings,
  extractAllIdentityEqualsLeaves,
  DEFAULT_SEGMENT_METADATA_ATTRIBUTE,
} from "./roleShared";

// "<attrKey>:<value>" -> internal value GUID, captured opportunistically at
// value-create time (a segment's ROLE scope filter needs the GUID).
const metadataValueIds = () => recordStore("metadata-value-ids");

// Get-or-create the Boundary attribute in the tenant's global Access Model
// Metadata list, matching the shape of a hand-created attribute: multi-valued
// (multiselect: true), objectTypes ["general"] (the live API rejects the
// spec's documented "all"), and the UNDOCUMENTED isAdhoc flag set true —
// that field is what ISC's "Allow Ad Hoc Values" toggle actually writes.
export async function ensureBoundaryMetadataAttribute(key) {
  // Looked up via the list endpoint's filter rather than GET-by-key — a
  // missing key there isn't a clean 404, it's a 400 "Referenced object not
  // found" (detailCode 400.1.404, verified live).
  const existing = await iscGet("/v2026/access-model-metadata/attributes", {
    filters: `key eq "${key}"`,
  });
  if (Array.isArray(existing) && existing.length > 0) return existing[0];

  const base = {
    key,
    name: key,
    multiselect: true,
    status: "active",
    type: "custom",
    objectTypes: ["general"],
    description: "This attribute is used to determine data segment assignments.",
  };
  try {
    // Ideal single call — isAdhoc up front, no placeholder values.
    const created = await iscPost("/v2026/access-model-metadata/attributes", { ...base, isAdhoc: true, values: [] });
    console.log(`[segments] created Access Model Metadata attribute "${key}"`);
    return created;
  } catch (err) {
    console.warn(
      `[segments] direct create of "${key}" attribute failed (${err.response?.status}) — using the verified placeholder+patch sequence:`,
      err.response?.data || err.message
    );
  }
  // Verified-live fallback: a create with an empty values list 500s, but one
  // with a placeholder value succeeds, and PATCHing isAdhoc to true afterward
  // both enables ad-hoc AND clears the placeholder automatically.
  await iscPost("/v2026/access-model-metadata/attributes", {
    ...base,
    values: [{ value: "placeholder", name: "Placeholder", status: "active" }],
  });
  const patched = await iscPatch(`/v2026/access-model-metadata/attributes/${key}`, [{ op: "replace", path: "/isAdhoc", value: true }]);
  // Belt and braces — if the PATCH didn't clear the placeholder, remove it via
  // the dedicated value-delete endpoint (PATCH ops against /values are rejected).
  if ((patched?.values || []).some((v) => v.value === "placeholder")) {
    await iscDelete(`/v2026/access-model-metadata/attributes/${key}/values/placeholder`)
      .catch((err) => console.warn("[segments] placeholder value cleanup failed:", err.response?.data || err.message));
  }
  console.log(`[segments] created Access Model Metadata attribute "${key}" (placeholder+patch sequence)`);
  return patched;
}

// A metadata value's technical name is a slug, not free text — registering one
// with a space in the technical name 400s "semantically invalid" (verified
// live with "BE Brussels"). The display name keeps the human form.
export function boundaryValueSlug(display) {
  return String(display).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// Registers one boundary value (technical slug + display name) on the
// attribute. Idempotent — an already-registered value is simply reused.
// Returns the value's internal GUID when one is known, else null.
export async function ensureBoundaryMetadataValue(key, { value, name, knownValues }) {
  const tenant = tenantKey();
  const mapKey = `${key}:${value}`;
  const stored = (await metadataValueIds().get(tenant)) || {};

  // A batch passes knownValues — the attribute's value list read ONCE for the
  // run and updated as values are added.
  if (knownValues) {
    if (knownValues.has(value)) return stored[mapKey] || null;
  } else {
    const existing = await iscGet(`/v2026/access-model-metadata/attributes/${encodeURIComponent(key)}/values`, {
      limit: 250,
    }).catch(() => []);
    if ((existing || []).some((v) => v.value === value)) return stored[mapKey] || null;
  }

  let created;
  try {
    created = await iscPost(
      `/v2026/access-model-metadata/attributes/${encodeURIComponent(key)}/values`,
      { value, name, status: "active" }
    );
  } catch (err) {
    // A concurrent register (or a value the list lookup missed) shows up here
    // as a uniqueness 400 — usually that IS the state this function exists to
    // produce. But the same error also comes back when items still carry a
    // value the attribute itself no longer lists, so confirm it.
    const msg = JSON.stringify(err.response?.data || {});
    if (err.response?.status === 400 && /unique|already exist/i.test(msg)) {
      const after = await iscGet(
        `/v2026/access-model-metadata/attributes/${encodeURIComponent(key)}/values`,
        { limit: 250 }
      ).catch(() => null);
      if (after && !after.some((v) => v.value === value)) {
        console.error(`[segments] "${value}" on "${key}" was refused as a duplicate but is NOT in the attribute's value list — filters referencing it will not resolve`);
        throw err;
      }
      if (knownValues) knownValues.add(value);
      console.log(`[segments] metadata value "${value}" on "${key}" already registered (concurrent create)`);
      return stored[mapKey] || null;
    }
    throw err;
  }
  if (knownValues) knownValues.add(value);
  console.log(`[segments] registered metadata value "${value}" ("${name}") on "${key}"`);
  // The public spec's AttributeValueDTO carries no id, so probe the likely
  // layouts: an id at the top level, or the response echoing the whole
  // attribute with its values list (each possibly carrying one).
  const body = created || {};
  const echoedValue = Array.isArray(body.values) ? body.values.find((v) => v.value === value) : null;
  const guid = body.id || body.valueId || body.guid || echoedValue?.id || echoedValue?.valueId || echoedValue?.guid || null;
  if (guid) {
    await metadataValueIds().put(tenant, { ...stored, [mapKey]: guid });
    console.log(`[segments] captured value GUID ${guid} for "${key}:${value}"`);
  }
  return guid;
}

const BULK_TAG_MAX = 3000;
const bulkTagUsable = new Map(); // tenant -> true | false

async function entitlementHasMetadataValue(id, key, value) {
  try {
    const ent = await iscGet(`/v2026/entitlements/${id}`);
    const attr = (ent?.accessModelMetadata?.attributes || []).find((a) => a.key === key);
    return (attr?.values || []).some((v) => (typeof v === "string" ? v : v?.value) === value);
  } catch {
    return false;
  }
}

/**
 * Bulk-tag entitlements with one AMM value (POST
 * /entitlements/v1/access-model-metadata/bulk-update/ids, up to 3000 ids per
 * call). Not trusted on its word — it's asynchronous and some tenants accept
 * it and silently do nothing — so after submitting, one entitlement is re-read
 * to confirm the value landed; if not, this reports failure and the caller
 * falls back to per-item tagging. Outcome is remembered per tenant.
 */
async function bulkTagEntitlements({ key, value, entitlementIds }) {
  const tenant = tenantKey();
  if (bulkTagUsable.get(tenant) === false) return false;
  try {
    for (let i = 0; i < entitlementIds.length; i += BULK_TAG_MAX) {
      const chunk = entitlementIds.slice(i, i + BULK_TAG_MAX);
      await withApiRetry(
        () => iscPost("/entitlements/v1/access-model-metadata/bulk-update/ids", {
          entitlements: chunk,
          operation: "ADD",
          replaceScope: "ATTRIBUTE",
          values: [{ attribute: key, values: [value] }],
        }),
        { label: `bulk-tag ${chunk.length} entitlements with ${key}` }
      );
    }
  } catch (err) {
    // 403 is the documented "custom metadata needs a suite license" case;
    // anything else here is equally a reason to fall back rather than fail.
    console.warn(`[segments] bulk entitlement tagging unavailable (${err.response?.status || err.message}) — falling back to per-item`);
    bulkTagUsable.set(tenant, false);
    return false;
  }

  if (bulkTagUsable.get(tenant) === true) return true;

  // First use on this tenant: prove it actually applied.
  const probe = entitlementIds[0];
  for (const waitMs of [1200, 2500, 4000, 6000]) {
    await new Promise((r) => setTimeout(r, waitMs));
    if (await entitlementHasMetadataValue(probe, key, value)) {
      console.log(`[segments] bulk entitlement tagging verified on ${tenant} — using it from here`);
      bulkTagUsable.set(tenant, true);
      return true;
    }
  }
  console.warn(`[segments] bulk entitlement tagging accepted the request but the value never appeared on ${probe} — falling back to per-item and not retrying bulk on this tenant`);
  bulkTagUsable.set(tenant, false);
  return false;
}

// ADDs (never replaces — the attribute is multi-valued) one boundary value
// onto every given entitlement and role.
export async function tagAccessWithBoundaryValue({ key, entitlementIds, roleIds, value, name, skipEnsure = false }) {
  // MANDATORY first step: the value must exist on the attribute before any
  // item is tagged with it (idempotent).
  if (!skipEnsure && (entitlementIds?.length || 0) + (roleIds?.length || 0) > 0) {
    await ensureBoundaryMetadataValue(key, { value, name: name || value });
  }
  const encodedPair = `${encodeURIComponent(key)}/values/${encodeURIComponent(value)}`;

  // Which API root actually serves the per-item metadata-assignment routes
  // varies: /v2026 documents them but 404s on some tenants, while /beta is
  // where this API family verifiably works. Probe v2026 then beta on first use
  // and remember the winner. A 404 AFTER the root is settled is a real one.
  let assignRoot = null;
  // "Value of attribute-value should be unique" (400.1.3) means the item
  // ALREADY carries this value — which is the state tagging exists to
  // produce, so it's success, not failure.
  const isAlreadyTagged = (err) =>
    err.response?.status === 400 &&
    JSON.stringify(err.response?.data || {}).includes("should be unique");
  const postAssign = async (kind, id) => {
    const candidates = assignRoot ? [assignRoot] : ["v2026", "beta"];
    let lastErr;
    for (const root of candidates) {
      try {
        await withApiRetry(
          () => iscPost(`/${root}/${kind}/${id}/access-model-metadata/${encodedPair}`, {}),
          { label: `tag ${kind} ${id} with ${key} (${root})` }
        );
        if (assignRoot !== root) console.log(`[segments] metadata assignment served from /${root}`);
        assignRoot = root;
        return;
      } catch (err) {
        if (isAlreadyTagged(err)) {
          if (assignRoot !== root) console.log(`[segments] metadata assignment served from /${root}`);
          assignRoot = root;
          return;
        }
        lastErr = err;
        if (assignRoot || err.response?.status !== 404) throw err;
      }
    }
    throw lastErr;
  };

  // Entitlements are the bulk of the work — try the bulk endpoint first and
  // only fan out per item if it isn't usable or didn't actually apply.
  if (entitlementIds.length > 0) {
    const bulked = entitlementIds.length > 1
      && await bulkTagEntitlements({ key, value, entitlementIds });
    if (!bulked) {
      // First item runs alone to settle the root probe before fanning out.
      await postAssign("entitlements", entitlementIds[0]);
      await mapWithConcurrency(entitlementIds.slice(1), 4, (id) => postAssign("entitlements", id));
    }
  }

  // Roles use the same per-item endpoint. The documented roles BULK endpoint
  // is a trap: it 202s "job created" and then silently does nothing (verified
  // live), so it's not used at all.
  if (roleIds.length > 0) {
    await postAssign("roles", roleIds[0]);
    await mapWithConcurrency(roleIds.slice(1), 4, (id) => postAssign("roles", id));
  }
}

/**
 * Segments-by-Metadata carry-through: entitlements newly added to a role
 * inherit every segment-boundary value the role itself is tagged with (the
 * configured attribute, default "Segments"). Best-effort by design: callers
 * invoke this AFTER the entitlements are already on the role, so a tagging
 * failure is reported (returned/logged), never unwound. Returns null when the
 * role carries no boundary values or there's nothing to tag.
 */
export async function tagEntitlementsWithRoleBoundaryValues(roleId, entitlementIds) {
  if (!entitlementIds || entitlementIds.length === 0) return null;
  try {
    const metadataKey =
      (await getTenantSettings()).segmentMetadataAttribute?.trim() || DEFAULT_SEGMENT_METADATA_ATTRIBUTE;
    const role = await withApiRetry(
      () => iscGet(`/v2026/roles/${roleId}`),
      { label: `tagEntitlementsWithRoleBoundaryValues: fetch role ${roleId}` }
    );
    const attr = (role.accessModelMetadata?.attributes || []).find((a) => a.key === metadataKey);
    const values = (attr?.values || []).filter((v) => v.value);
    if (values.length === 0) return null;
    for (const v of values) {
      await tagAccessWithBoundaryValue({
        key: metadataKey,
        entitlementIds,
        roleIds: [],
        value: v.value,
        name: v.name || v.value,
      });
    }
    return { entitlements: entitlementIds.length, key: metadataKey, values: values.map((v) => v.value) };
  } catch (err) {
    console.warn(`[roles] tagging added entitlements for role ${roleId} failed:`, err.response?.data || err.message);
    return { error: describeError(err) };
  }
}

/**
 * Role Evaluation's segment-metadata check — and fix. A role's data-segment
 * value is derived exactly the way segment creation derives it: the role's own
 * criteria values for the configured boundary attributes, joined with " - ".
 * Any value the role is already tagged with on the attribute counts too. For
 * each value this makes sure the metadata attribute exists, the value is
 * registered, the role carries it, and every entitlement on the role,
 * dimensions included, carries it. Only additive. Returns null when there is
 * nothing to check, otherwise { key, values: [...], error? }.
 */
export async function ensureRoleSegmentMetadata(role, dimensions, boundaryAttributes) {
  const key = (await getTenantSettings()).segmentMetadataAttribute?.trim() || DEFAULT_SEGMENT_METADATA_ATTRIBUTE;
  const wanted = new Map(); // value -> display name

  if (boundaryAttributes.length > 0) {
    const leaves = extractAllIdentityEqualsLeaves(role.membership?.criteria);
    const parts = boundaryAttributes.map((k) => [...new Set(leaves.filter((l) => l.attrKey === k).map((l) => String(l.value)))]);
    // Exactly one value per boundary attribute — a role spanning several (an
    // OR across countries) has no single segment to belong to.
    if (parts.every((vals) => vals.length === 1)) {
      const name = parts.map((vals) => vals[0]).join(" - ");
      const value = boundaryValueSlug(name);
      if (value) wanted.set(value, name);
    }
  }
  const roleAttr = (role.accessModelMetadata?.attributes || []).find((a) => a.key === key);
  const roleValues = new Set((roleAttr?.values || []).map((v) => v.value).filter(Boolean));
  for (const v of roleAttr?.values || []) if (v.value && !wanted.has(v.value)) wanted.set(v.value, v.name || v.value);
  if (wanted.size === 0) return null;

  const entById = new Map();
  for (const e of role.entitlements || []) entById.set(e.id, e.name || e.id);
  for (const d of dimensions || []) for (const e of d.entitlements || []) if (!entById.has(e.id)) entById.set(e.id, e.name || e.id);
  const entIds = [...entById.keys()];

  const out = { key, values: [] };
  try {
    await ensureBoundaryMetadataAttribute(key);
    const existing = await iscGet(`/v2026/access-model-metadata/attributes/${encodeURIComponent(key)}/values`, { limit: 250 }).catch(() => null);
    const knownValues = existing ? new Set(existing.map((v) => v.value).filter(Boolean)) : null;

    for (const [value, name] of wanted) {
      const valueCreated = knownValues ? !knownValues.has(value) : false;
      await ensureBoundaryMetadataValue(key, { value, name, knownValues });

      const roleTagged = !roleValues.has(value);
      if (roleTagged) {
        await tagAccessWithBoundaryValue({ key, entitlementIds: [], roleIds: [role.id], value, name, skipEnsure: true });
      }

      // Which of the role's entitlements already carry the value, 50 ids per
      // search. The index lags a fresh tag by a little, so an item tagged
      // moments ago may be re-tagged — harmless, tagging is idempotent.
      const tagged = new Set();
      const escaped = String(value).replace(/"/g, '\\"');
      for (let i = 0; i < entIds.length; i += 50) {
        const chunk = entIds.slice(i, i + 50);
        const found = await withApiRetry(
          () => iscPost(
            "/v2026/search",
            {
              indices: ["entitlements"],
              query: { query: `id:(${chunk.join(" OR ")}) AND @accessModelMetadata(key:${key} AND value:"${escaped}")` },
              queryResultFilter: { includes: ["id"] },
            },
            { params: { limit: 250 } }
          ),
          { label: `role ${role.id}: entitlements tagged ${key}:${value}` }
        );
        for (const d of found || []) if (d.id) tagged.add(d.id);
      }
      const missing = entIds.filter((id) => !tagged.has(id));
      if (missing.length > 0) {
        await tagAccessWithBoundaryValue({ key, entitlementIds: missing, roleIds: [], value, name, skipEnsure: true });
      }
      out.values.push({
        value,
        name,
        valueCreated,
        roleTagged,
        entitlementsChecked: entIds.length,
        entitlementsTagged: missing.map((id) => ({ id, name: entById.get(id) })),
      });
    }
  } catch (err) {
    console.error(`[insights] role ${role.id}: segment metadata check failed:`, err.response?.data || err.message);
    out.error = describeError(err);
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// Ports of the server's metadata routes:
//   POST   /api/entitlements/:id/metadata
//   DELETE /api/entitlements/:id/metadata/:key/:value
//   POST   /api/entitlements/metadata/bulk
//   POST   /api/:kind(roles|access-profiles|entitlements)/metadata/bulk-tag
//   POST   /api/:kind(roles|access-profiles)/:id/metadata
//   DELETE /api/:kind(roles|access-profiles)/:id/metadata/:key/:value
//   GET    /api/metadata/:key/values/:value/access
//   POST   /api/metadata/:key/values/delete
//   GET    /api/metadata-value-guids
// Failures throw route-shaped errors (err.response.status,
// err.response.data.error) exactly as the routes answered.
// ═══════════════════════════════════════════════════════════════════════════

// What one Access Model Metadata value is attached to is found with ISC
// Search's @accessModelMetadata() nested query (the form already verified
// for searchAccessIdsByMetadata).
export const metadataValueQuery = (key, value) =>
  `@accessModelMetadata(key:${key} AND value:"${String(value).replace(/(["\\])/g, "\\$1")}")`;
// A metadata key goes into the query unquoted; keep it to what ISC allows in one.
export const isSafeMetadataKey = (key) => /^[A-Za-z0-9_.-]+$/.test(String(key));

/**
 * POST /api/entitlements/:id/metadata
 * { key, value, name? } — assigns one metadata value to this entitlement,
 * registering the value on the attribute first when a display `name` is
 * supplied and the value doesn't exist yet (ad-hoc values). Same per-item
 * mechanism (v2026->beta root probe, already-tagged counts as success) as
 * the Segments by Metadata tagging. { ok: true }.
 */
export async function addEntitlementMetadata(entitlementId, { key, value, name } = {}) {
  if (!key || !value) throw badRequest("key and value are required.");
  try {
    if (name) await ensureBoundaryMetadataValue(key, { value, name });
    await tagAccessWithBoundaryValue({ key, entitlementIds: [entitlementId], roleIds: [], value });
    return { ok: true };
  } catch (err) {
    console.error("[entitlements] add metadata failed:", err.response?.data || err.message);
    throw routeError(err);
  }
}

/**
 * POST /api/entitlements/metadata/bulk
 * { key, value, name?, entitlementIds: [] } — tags every listed entitlement
 * with one metadata value in a single pass (already-tagged items count as
 * success). Registers the value first when `name` is given.
 * { ok: true, tagged: n }.
 */
export async function bulkTagEntitlementMetadata({ key, value, name, entitlementIds } = {}) {
  if (!key || !value) throw badRequest("key and value are required.");
  if (!Array.isArray(entitlementIds) || entitlementIds.length === 0) {
    throw badRequest("entitlementIds must be a non-empty array.");
  }
  try {
    if (name) await ensureBoundaryMetadataValue(key, { value, name });
    await tagAccessWithBoundaryValue({ key, entitlementIds, roleIds: [], value });
    return { ok: true, tagged: entitlementIds.length };
  } catch (err) {
    console.error("[entitlements] bulk metadata tag failed:", err.response?.data || err.message);
    throw routeError(err);
  }
}

/**
 * DELETE /api/entitlements/:id/metadata/:key/:value — removes one assigned
 * metadata value from this entitlement. Same v2026->beta root probe as
 * assignment (the per-item metadata routes 404 at /v2026 on some tenants).
 */
export async function removeEntitlementMetadata(entitlementId, key, value) {
  const pair = `${encodeURIComponent(key)}/values/${encodeURIComponent(value)}`;
  try {
    let lastErr;
    for (const root of ["v2026", "beta"]) {
      try {
        await iscDelete(`/${root}/entitlements/${entitlementId}/access-model-metadata/${pair}`);
        return { ok: true };
      } catch (err) {
        lastErr = err;
        if (err.response?.status !== 404 && err.response?.status !== 405) break;
      }
    }
    throw lastErr;
  } catch (err) {
    console.error("[entitlements] remove metadata failed:", err.response?.data || err.message);
    throw routeError(err);
  }
}

// ── Metadata on roles and access profiles (their Metadata tab's + and ×) ─────
// Same per-item mechanism as entitlements: POST / DELETE
// /{kind}/{id}/access-model-metadata/{key}/values/{value}, probing /v2026
// then /beta because which root serves these routes varies by tenant (see
// tagAccessWithBoundaryValue). Roles have had the route since v2025; access
// profiles only gained it in v2026 and have no /beta equivalent — so on a
// tenant whose /v2026 doesn't serve it yet, access profiles can't be tagged
// at all, and the error says that rather than a bare 404.
const METADATA_TAGGABLE_KINDS = { roles: "role", "access-profiles": "access profile", entitlements: "entitlement" };
// Which API root answered for a tenant + kind, so a bulk run of hundreds of
// items probes once instead of paying a 404 round-trip per item.
const itemMetadataRoot = new Map();

// What this role / access profile / entitlement carries for `key` right now,
// read from the object itself: { has: <carries this exact value>, others:
// [display names of other values it holds], multiselect }. null when it can't
// be determined.
async function objectMetadataState(kind, id, key, value) {
  try {
    const obj = await iscGet(`/v2026/${kind}/${id}`);
    const attr = (obj?.accessModelMetadata?.attributes || []).find((a) => a.key === key);
    const values = attr?.values || [];
    return {
      has: values.some((v) => v.value === value),
      others: values.filter((v) => v.value !== value).map((v) => v.name || v.value),
      multiselect: attr?.multiselect !== false,
      attributeName: attr?.name || key,
    };
  } catch {
    return null;
  }
}

// Errors the server raised itself (409 single-valued conflict, 501 route not
// served) carry their own status and message; they're route-shaped here so
// callers read them the same way as any other failure.
const isRouteMissing = (err) => err?.isRouteError && err.response?.status === 501;

// Resolves "already" when an add found the value already in place.
async function callItemMetadata(method, kind, id, key, value) {
  const pair = `${encodeURIComponent(key)}/values/${encodeURIComponent(value)}`;
  const rootKey = `${tenantKey()}:${kind}`;
  let lastErr;
  for (const root of itemMetadataRoot.has(rootKey) ? [itemMetadataRoot.get(rootKey)] : ["v2026", "beta"]) {
    try {
      await withApiRetry(
        () => iscRaw(method, `/${root}/${kind}/${id}/access-model-metadata/${pair}`, {
          ...(method === "post" ? { data: {} } : {}),
          headers: { "Content-Type": "application/json" },
        }),
        { label: `${method} ${kind} ${id} metadata ${key} (${root})` }
      );
      itemMetadataRoot.set(rootKey, root);
      return;
    } catch (err) {
      // Already carrying the value is the state an add exists to produce —
      // not a failure. ISC words that rejection differently per object type
      // ("should be unique" for entitlements; roles say something else), so
      // the wording isn't trusted: on any 400 the object itself is read, and
      // if it has the value the add is done. Reading the object (not Search)
      // also means a tag applied seconds ago counts, index lag or not.
      if (method === "post" && err.response?.status === 400) {
        const state = await objectMetadataState(kind, id, key, value);
        if (state?.has) {
          itemMetadataRoot.set(rootKey, root);
          return "already";
        }
        // The other common rejection: a SINGLE-valued attribute (e.g.
        // Environment) that already holds a different value. Not something to
        // paper over by replacing it — say what's there and let the user choose.
        if (state && !state.multiselect && state.others.length) {
          itemMetadataRoot.set(rootKey, root);
          throw badRequest(
            `"${state.attributeName}" holds one value and this ${METADATA_TAGGABLE_KINDS[kind]} already has "${state.others[0]}". Remove that value first, then add the new one.`,
            409
          );
        }
      }
      lastErr = err;
      if (err.response?.status !== 404 && err.response?.status !== 405) break;
    }
  }
  // Once a root is known to serve the route, a 404 is about THIS item.
  if ([404, 405].includes(lastErr.response?.status) && !itemMetadataRoot.has(rootKey)) {
    throw badRequest(
      `ISC on this tenant doesn't serve the metadata route for ${METADATA_TAGGABLE_KINDS[kind]}s yet (tried /v2026 and /beta), so its metadata can't be changed from here.`,
      501
    );
  }
  throw lastErr;
}

const METADATA_BULK_MAX = 2000;
const METADATA_KIND_INDEX = { roles: "roles", "access-profiles": "accessprofiles", entitlements: "entitlements" };

/**
 * POST /api/:kind(roles|access-profiles|entitlements)/metadata/bulk-tag
 * { operation: "add" | "remove", key, value, name?, ids: [] }
 * Adds one metadata value to — or removes it from — every listed object.
 * Both operations first ask ISC Search which of the ids already carry the
 * value, and only act on the ones that need it — the rest are `skipped`,
 * never failed (a mixed selection is the normal case, and ISC rejects both
 * adding a value an object has and removing one it doesn't):
 *  - add: registers the value on the attribute first (ad-hoc values come with
 *    a display `name`), skips objects that already have it, and — for one
 *    Search hadn't indexed yet — confirms against the object itself.
 *  - remove: only untags the objects that carry it — and because Search's
 *    index lags a tagging by minutes, any object Search doesn't vouch for is
 *    checked against the object itself before being skipped.
 * A few at a time, and one failure doesn't stop the rest.
 * Returns { operation, done, skipped, failed: [{ id, error }] }.
 */
export async function bulkTagMetadata(kind, { operation, key, value, name, ids: rawIds } = {}) {
  if (!METADATA_KIND_INDEX[kind]) throw badRequest("kind must be roles, access-profiles or entitlements.", 404);
  const ids = [...new Set(Array.isArray(rawIds) ? rawIds.filter((x) => typeof x === "string" && x) : [])];
  if (operation !== "add" && operation !== "remove") throw badRequest('operation must be "add" or "remove".');
  if (!key || !value) throw badRequest("key and value are required.");
  if (ids.length === 0) throw badRequest("ids must be a non-empty array.");
  if (ids.length > METADATA_BULK_MAX) throw badRequest(`That's ${ids.length.toLocaleString()} objects — the limit is ${METADATA_BULK_MAX.toLocaleString()} at a time.`);
  try {
    if (!isSafeMetadataKey(key)) throw badRequest("That metadata key can't be searched.");
    if (operation === "add") await ensureBoundaryMetadataValue(key, { value, name: name || value });

    // Which of the selection already carries the value — asked up front for
    // BOTH operations, so nothing is sent that ISC would reject: an add skips
    // the ones that have it, a remove skips the ones that don't. Search can
    // lag a very recent change; callItemMetadata's read-the-object check
    // covers an add that slips through.
    const carrying = new Set();
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const { items } = await iscSearchPage({
        indices: [METADATA_KIND_INDEX[kind]],
        query: { query: `${metadataValueQuery(key, value)} AND id:(${chunk.join(" OR ")})` },
        queryResultFilter: { includes: ["id"] },
      }, { limit: 250 });
      for (const d of items) carrying.add(d.id);
    }
    // Search is only believed when it says YES. Its index runs minutes
    // behind a tagging, so "not carrying" may just mean "not indexed yet" —
    // which for a remove would wrongly skip an object that does have the
    // value (tag 38 roles, remove straight away: Search knew none of them).
    // So for a remove, everything Search didn't vouch for is checked against
    // the object itself. (An add doesn't need this pass: a wrongly-attempted
    // add is caught by callItemMetadata reading the object on rejection.)
    if (operation === "remove") {
      const unsure = ids.filter((id) => !carrying.has(id));
      const checkQueue = [...unsure];
      await Promise.all(Array.from({ length: Math.min(6, checkQueue.length) }, async () => {
        while (checkQueue.length) {
          const id = checkQueue.shift();
          const state = await withApiRetry(() => objectMetadataState(kind, id, key, value), { label: `read ${kind} ${id} metadata` });
          // Couldn't be read → attempt the remove rather than silently skip it.
          if (!state || state.has) carrying.add(id);
        }
      }));
      if (unsure.length) console.log(`[metadata] remove ${key}=${value} on ${kind}: Search vouched for ${ids.length - unsure.length} of ${ids.length}; read ${unsure.length} object(s) directly → ${carrying.size} carry it`);
    }
    const targets = ids.filter((id) => (operation === "add" ? !carrying.has(id) : carrying.has(id)));
    let skipped = ids.length - targets.length;

    const failed = [];
    let done = 0;
    let routeMissing = null;
    const queue = [...targets];
    // The first one alone, so the API-root probe settles before fanning out.
    const runOne = async (id) => {
      try {
        const outcome = await callItemMetadata(operation === "add" ? "post" : "delete", kind, id, key, value);
        if (outcome === "already") skipped++;
        else done++;
      } catch (err) {
        if (isRouteMissing(err)) routeMissing = err.message;
        const error = err.isRouteError ? err.message : err.response?.data?.messages?.[0]?.text || describeError(err);
        // The reason, not just a count — a failure nobody can read can't be fixed.
        console.warn(`[metadata] ${operation} ${key}=${value} on ${kind} ${id} failed: ${err.response?.status || ""} ${JSON.stringify(err.response?.data || err.message).slice(0, 400)}`);
        failed.push({ id, error });
      }
    };
    if (queue.length) await runOne(queue.shift());
    // No point repeating a "this tenant doesn't serve the route" for every item.
    if (routeMissing) throw badRequest(routeMissing, 501);
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
      while (queue.length) await runOne(queue.shift());
    }));
    console.log(`[metadata] ${tenantKey()} bulk ${operation} ${key}=${value} on ${kind}: ${done} done, ${skipped} skipped, ${failed.length} failed`);
    return { operation, done, skipped, failed };
  } catch (err) {
    console.error(`[${kind}] bulk metadata ${operation} failed:`, err.response?.data || err.message);
    throw routeErrorMessages(err);
  }
}

/**
 * POST /api/:kind(roles|access-profiles)/:id/metadata
 * { key, value, name? } — assigns one metadata value, registering it on the
 * attribute first when a display `name` is given (ad-hoc values).
 * { ok: true, already } — `already` when the object had the value.
 * kind "entitlements" is served by the entitlement route (no `already`).
 */
export async function addObjectMetadata(kind, id, { key, value, name } = {}) {
  if (kind === "entitlements") return addEntitlementMetadata(id, { key, value, name });
  if (!METADATA_TAGGABLE_KINDS[kind]) throw badRequest("kind must be roles or access-profiles.", 404);
  if (!key || !value) throw badRequest("key and value are required.");
  try {
    // The value must exist on the attribute before anything is tagged with it.
    await ensureBoundaryMetadataValue(key, { value, name: name || value });
    const outcome = await callItemMetadata("post", kind, id, key, value);
    return { ok: true, already: outcome === "already" };
  } catch (err) {
    console.error(`[${kind}] add metadata failed:`, err.response?.data || err.message);
    throw routeError(err);
  }
}

/** DELETE /api/:kind(roles|access-profiles)/:id/metadata/:key/:value — removes one assigned value. */
export async function removeObjectMetadata(kind, id, key, value) {
  if (kind === "entitlements") return removeEntitlementMetadata(id, key, value);
  if (!METADATA_TAGGABLE_KINDS[kind]) throw badRequest("kind must be roles or access-profiles.", 404);
  try {
    await callItemMetadata("delete", kind, id, key, value);
    return { ok: true };
  } catch (err) {
    console.error(`[${kind}] remove metadata failed:`, err.response?.data || err.message);
    throw routeError(err);
  }
}

// ─── Metadata value detail (Metadata > attribute > value) ───────────────────
// Roles, access profiles and entitlements carry the tag themselves and are
// found with ISC Search. Identities are deliberately not covered — they are
// never tagged, only hold things that are.
const METADATA_ACCESS_INDICES = { roles: "roles", accessprofiles: "accessprofiles", entitlements: "entitlements" };

/**
 * GET /api/metadata/:key/values/:value/access?type=roles|accessprofiles|entitlements&offset&limit
 * The items of one type tagged with this value, by name: { items, total }.
 */
export async function listAccessByMetadataValue(key, value, type, { limit: rawLimit = 100, offset: rawOffset = 0 } = {}) {
  const index = METADATA_ACCESS_INDICES[type];
  if (!index) throw badRequest("type must be roles, accessprofiles or entitlements.");
  if (!isSafeMetadataKey(key)) throw badRequest("That metadata key can't be searched.");
  const limit = Math.min(Math.max(Number(rawLimit) || 100, 1), 250);
  const offset = Math.max(Number(rawOffset) || 0, 0);
  try {
    const { items, total } = await iscSearchPage(
      {
        indices: [index],
        query: { query: metadataValueQuery(key, value) },
        sort: ["name"],
        queryResultFilter: { includes: ["id", "name", "displayName", "description", "enabled", "requestable", "privileged", "source.id", "source.name", "attribute", "value", "owner.name"] },
      },
      { limit, offset, count: true }
    );
    return { items, total: total ?? items.length };
  } catch (err) {
    console.error("[metadata] value access failed:", err.response?.data || err.message);
    throw routeErrorMessages(err);
  }
}

/**
 * POST /api/metadata/:key/values/delete
 * Deletes values of a custom metadata attribute, one ISC call per value (ISC
 * has no batch delete): { deleted: [value], failed: [{ value, error }] }.
 * Built-in attributes (type != custom) are refused with 403.
 */
export async function deleteMetadataValues(key, values) {
  const wanted = [...new Set((Array.isArray(values) ? values : []).filter((v) => typeof v === "string" && v))];
  if (!isSafeMetadataKey(key)) throw badRequest("That metadata key can't be edited.");
  if (wanted.length === 0) throw badRequest("values must be a non-empty array of value names.");
  if (wanted.length > 250) throw badRequest("Delete at most 250 values at a time.");

  try {
    const base = `/v2026/access-model-metadata/attributes/${encodeURIComponent(key)}`;
    const attribute = await iscGet(base);
    if (String(attribute?.type || "").toLowerCase() !== "custom") {
      throw badRequest(`"${attribute?.name || key}" is a built-in metadata attribute — its values can't be deleted.`, 403);
    }

    const deleted = [];
    const failed = [];
    let perValueRouteMissing = false;
    for (const value of wanted) {
      try {
        if (!perValueRouteMissing) {
          try {
            await iscDelete(`${base}/values/${encodeURIComponent(value)}`, { headers: { "X-SailPoint-Experimental": "true" } });
            deleted.push(value);
            continue;
          } catch (err) {
            const status = err.response?.status;
            // 404 is ambiguous: no such route, or no such value. Only treat it
            // as "route missing" when the value really is still on the attribute.
            const current = await iscGet(base);
            const stillThere = (current?.values || []).some((v) => v.value === value);
            if (!stillThere) { deleted.push(value); continue; }
            if (status !== 404 && status !== 405) throw err;
            perValueRouteMissing = true;
            console.warn(`[metadata] per-value delete not served (${status}) — falling back to JSON-Patch remove`);
          }
        }
        const current = await iscGet(base);
        const index = (current?.values || []).findIndex((v) => v.value === value);
        if (index === -1) { deleted.push(value); continue; }
        await iscPatch(base, [{ op: "remove", path: `/values/${index}` }]);
        deleted.push(value);
      } catch (err) {
        console.error(`[metadata] delete value "${key}"/"${value}" failed:`, err.response?.status, JSON.stringify(err.response?.data || err.message));
        failed.push({ value, error: describeError(err) });
      }
    }
    return { deleted, failed };
  } catch (err) {
    console.error("[metadata] delete values failed:", err.response?.data || err.message);
    throw routeError(err);
  }
}

/**
 * GET /api/metadata-value-guids
 * The stored value->GUID map, reversed, so the UI can show a segment's ROLE
 * filter in readable terms (ISC writes the AMM value's internal GUID into
 * that leaf, while the ENTITLEMENT leaf beside it names the same value by
 * its technical name). Display names are filled in from the attribute's own
 * values list — one call per distinct attribute, not per value — and a name
 * that can't be fetched falls back to the technical value.
 * { byGuid: { "<guid>": { key, value, name } }, count }.
 */
export async function getMetadataValueGuids() {
  try {
    const stored = (await metadataValueIds().get(tenantKey())) || {};
    const entries = Object.entries(stored).filter(([, guid]) => typeof guid === "string" && guid);
    const byGuid = {};
    // "key:technicalValue" -> guid. The key itself can't contain ":" (ISC
    // attribute keys are identifier-shaped), so the first colon splits it.
    const parsed = entries.map(([mapKey, guid]) => {
      const i = mapKey.indexOf(":");
      return { guid, key: i === -1 ? mapKey : mapKey.slice(0, i), value: i === -1 ? "" : mapKey.slice(i + 1) };
    });

    const names = {};
    for (const key of [...new Set(parsed.map((p) => p.key))]) {
      const values = await iscGet(
        `/v2026/access-model-metadata/attributes/${encodeURIComponent(key)}/values`,
        { limit: 250 }
      ).catch(() => []);
      for (const v of values || []) if (v?.value) names[`${key}:${v.value}`] = v.name || v.value;
    }

    for (const { guid, key, value } of parsed) {
      byGuid[guid] = { key, value, name: names[`${key}:${value}`] || value };
    }
    return { byGuid, count: Object.keys(byGuid).length };
  } catch (err) {
    console.warn("[segments] metadata-value-guids failed:", err.response?.status || err.message);
    return { byGuid: {}, count: 0 };
  }
}
