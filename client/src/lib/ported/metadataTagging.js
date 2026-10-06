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
 * tagEntitlementsWithRoleBoundaryValues, ensureRoleSegmentMetadata.
 */

import { iscGet, iscPost, iscPatch, iscDelete, withApiRetry, describeError } from "../isc";
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
