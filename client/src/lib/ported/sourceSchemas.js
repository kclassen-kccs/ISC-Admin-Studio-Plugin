/**
 * ported/sourceSchemas.js
 * Browser-side port of the /api/sources/:id/{account-schema,schemas,
 * sync-provisioning-policies,detect-schema,schemas/:schemaId/uid} routes.
 */

import { iscGet, iscPut, iscRaw, withApiRetry, routeError, badRequest } from "../isc";
import { routeErrorMessages, routeErrorCauses, base64ToBlob } from "./sourceErrors";

// The account schema's attributes, in ISC's own defined order.
export async function getSourceAccountSchema(sourceId) {
  try {
    const schemas = await iscGet(`/v2026/sources/${sourceId}/schemas`);
    const accountSchema = (Array.isArray(schemas) ? schemas : []).find((s) => s.name === "account") || schemas?.[0];
    if (!accountSchema) throw badRequest("No account schema found for this source.", 404);
    const attributes = (accountSchema.attributes || []).map((a) => ({
      name: a.name,
      type: a.type,
      isMulti: !!a.isMulti,
      isEntitlement: !!a.isEntitlement,
      description: a.description || null,
    }));
    return { attributes, identityAttribute: accountSchema.identityAttribute, displayAttribute: accountSchema.displayAttribute };
  } catch (err) {
    throw routeError(err);
  }
}

// Every schema on the source, as ISC returns them — getSourceAccountSchema
// trims to a display shape, but the Entitlement Schema tab edits the raw
// object, so nothing is dropped here. Sorted with "account" first, then by
// name, so the order is stable across refetches.
export async function listSourceSchemas(sourceId) {
  try {
    const schemas = await iscGet(`/v2026/sources/${sourceId}/schemas`);
    return (Array.isArray(schemas) ? schemas : []).slice().sort((a, b) => {
      if (a.name === "account") return -1;
      if (b.name === "account") return 1;
      return String(a.name || "").localeCompare(String(b.name || ""));
    });
  } catch (err) {
    throw routeError(err);
  }
}

// Replaces one schema wholesale. PUT is the proven write for schemas on this
// tenant (verified live: PUT requires the whole object), and the editor holds
// the complete GET representation, so it's sent back as-is. `id` is taken
// from the path, not the body, so an edit can't retarget another schema.
export async function updateSourceSchema(sourceId, schemaId, schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw badRequest("The full schema object is required as the request body.");
  }
  try {
    return await iscPut(`/v2026/sources/${sourceId}/schemas/${schemaId}`, { ...schema, id: schemaId });
  } catch (err) {
    console.error("[sources] schema update failed:", JSON.stringify(err.response?.data || err.message, null, 2));
    // messages[] is the generic text; causes[] (when present) the specific reason.
    throw routeErrorCauses(err);
  }
}

// Keeps every provisioning policy this source has (CREATE/UPDATE/ENABLE/
// DISABLE, whichever exist) in step with a just-edited account schema: drops
// any field whose name matches an attribute that was just removed from the
// schema, and adds a plain, unconfigured field for each newly added attribute
// it doesn't already have. Every other field — including one not tied to any
// of THIS edit's changed names, like a synthetic "password" field on a CREATE
// policy that was never a schema attribute — is left untouched. Only writes a
// policy whose fields actually change. { policiesUpdated: string[] }
export async function syncSourceProvisioningPolicies(sourceId, { removedNames, added } = {}) {
  const removed = Array.isArray(removedNames) ? removedNames : [];
  const addedAttrs = Array.isArray(added) ? added : [];
  if (removed.length === 0 && addedAttrs.length === 0) {
    return { policiesUpdated: [] };
  }
  try {
    const policies = await withApiRetry(
      () => iscGet(`/v2026/sources/${sourceId}/provisioning-policies`),
      { label: "sync-provisioning-policies: list" }
    );
    const removedSet = new Set(removed);
    const updated = [];
    for (const policy of policies || []) {
      const existingNames = new Set((policy.fields || []).map((f) => f.name));
      const keptFields = (policy.fields || []).filter((f) => !removedSet.has(f.name));
      const newFields = addedAttrs
        .filter((a) => !existingNames.has(a.name))
        .map((a) => ({ name: a.name, transform: null, attributes: {}, isRequired: false, type: "string", isMultiValued: !!a.isMulti }));
      if (keptFields.length === (policy.fields || []).length && newFields.length === 0) continue;

      // PATCH .../provisioning-policies/:usageType rejects a JSON-Patch op
      // at the bare "/fields" path (verified live: 400 "Invalid path" — ISC
      // only accepts indexed paths like /fields/0 there) — this endpoint
      // also takes a plain PUT of the whole object, same pattern as the
      // schema UID-confirm write.
      await iscPut(`/v2026/sources/${sourceId}/provisioning-policies/${policy.usageType}`, { ...policy, fields: [...keptFields, ...newFields] });
      updated.push(policy.usageType);
    }
    return { policiesUpdated: updated };
  } catch (err) {
    throw routeErrorMessages(err);
  }
}

// Uploads the CSV to ISC's schema-detection endpoint (note: /sources/v1, not
// /v2026), which both infers the column list AND saves it as the source's
// live "account" schema in one step, including its own best-guess UID/Account
// Name attributes — reviewed/overridden by the caller in the next step.
export async function detectSourceSchema(sourceId, { filename, csvBase64 } = {}) {
  if (typeof csvBase64 !== "string" || !csvBase64) throw badRequest("csvBase64 is required.");
  const safeFilename = typeof filename === "string" && filename ? filename : "accounts.csv";
  try {
    const form = new FormData();
    form.append("file", base64ToBlob(csvBase64), safeFilename);
    const resp = await iscRaw("post", `/sources/v1/${sourceId}/schemas/accounts`, { data: form });
    const schema = resp.data;
    return {
      schemaId: schema.id,
      identityAttribute: schema.identityAttribute,
      displayAttribute: schema.displayAttribute,
      attributes: (schema.attributes || []).map((a) => ({ name: a.name, type: a.type, description: a.description || null })),
      raw: schema,
    };
  } catch (err) {
    throw routeErrorMessages(err);
  }
}

// Applies the reviewer's confirmed UID + Account Name attributes on top of
// the schema detect-schema already saved — refetches the full schema first
// since PUT .../schemas/:schemaId requires the whole object, not a patch
// (verified live).
export async function setSourceSchemaUid(sourceId, schemaId, { identityAttribute, displayAttribute, entitlementAttributes } = {}) {
  if (!identityAttribute || !displayAttribute) {
    throw badRequest("identityAttribute and displayAttribute are required.");
  }
  if (entitlementAttributes !== undefined && !Array.isArray(entitlementAttributes)) {
    throw badRequest("entitlementAttributes must be an array of attribute names.");
  }
  try {
    const current = await iscGet(`/v2026/sources/${sourceId}/schemas/${schemaId}`);
    // When the caller sends the entitlement list, it is authoritative for
    // the whole schema: named attributes get isEntitlement (+ isManaged, so
    // they surface in the Access Model), all others are cleared. Entries
    // may be plain names or { name, isMulti } — the object form also sets
    // the attribute's single/multi-valued flag (Entitlement - Single Value
    // vs Entitlement - Multi-value in the editor). Omitting the field
    // leaves the schema's existing flags untouched.
    const entMap = entitlementAttributes === undefined
      ? null
      : new Map(entitlementAttributes.map((e) => (typeof e === "string" ? [e, undefined] : [e?.name, !!e?.isMulti])));
    const attributes = entMap === null
      ? current.attributes
      : (current.attributes || []).map((a) => {
          const on = entMap.has(a.name);
          const isMulti = on && entMap.get(a.name) !== undefined ? entMap.get(a.name) : a.isMulti;
          // isManaged is the real field name (verified live on this
          // tenant's own delimited schemas) — ISC forces it false here
          // regardless, so isEntitlement alone is what takes effect.
          return { ...a, isEntitlement: on, isManaged: on, isMulti };
        });
    return await iscPut(`/v2026/sources/${sourceId}/schemas/${schemaId}`, { ...current, attributes, identityAttribute, displayAttribute });
  } catch (err) {
    throw routeErrorMessages(err);
  }
}
