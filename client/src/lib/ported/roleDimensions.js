/**
 * ported/roleDimensions.js
 * Role / dimension entitlement patching and dimension CRUD — ports of the
 * server's patchRoleEntitlements, patchDimensionEntitlements,
 * createRoleDimensionOnServer and the /api/roles/:id/dimensions routes.
 *
 * SailPoint requires the JSON Patch content type (application/json-patch+json)
 * for PATCH on roles and dimensions — verified live that a plain
 * application/json body is rejected with 415 — which iscPatch always sends.
 */

import { iscGet, iscPost, iscPatch, iscDelete, withApiRetry, routeError, badRequest } from "../isc";
import { tagEntitlementsWithRoleBoundaryValues } from "./metadataTagging";

/**
 * Shared by PATCH /api/roles/:id/entitlements and the Role Evaluation scan's
 * per-role/accept-all actions. Adds/removes entitlements directly granted by a
 * (non-dimensional) role via one JSON Patch replace — verified live with a
 * no-op replace against a real role's /entitlements array; the "add" path
 * reuses the exact same replace mechanism, just with a longer array.
 */
export async function patchRoleEntitlements(roleId, { add, remove }) {
  const hasRemove = Array.isArray(remove) && remove.length > 0;
  const hasAdd = Array.isArray(add) && add.length > 0;
  const role = await withApiRetry(() => iscGet(`/v2026/roles/${roleId}`), { label: `patch role ${roleId}: fetch role` });
  const removeSet = new Set(hasRemove ? remove : []);
  let nextEntitlements = (role.entitlements || []).filter((e) => !removeSet.has(e.id));
  if (hasAdd) {
    const existingIds = new Set(nextEntitlements.map((e) => e.id));
    const toAdd = add
      .filter((e) => !existingIds.has(e.id))
      .map((e) => ({ id: e.id, name: e.name, type: "ENTITLEMENT" }));
    nextEntitlements = [...nextEntitlements, ...toAdd];
  }
  return withApiRetry(
    () => iscPatch(`/v2026/roles/${roleId}`, [{ op: "replace", path: "/entitlements", value: nextEntitlements }]),
    { label: `patch role ${roleId} entitlements` }
  );
}

/** Same as patchRoleEntitlements, scoped to one dimension of a dynamic role. */
export async function patchDimensionEntitlements(roleId, dimensionId, { add, remove }) {
  const hasRemove = Array.isArray(remove) && remove.length > 0;
  const hasAdd = Array.isArray(add) && add.length > 0;
  const dimension = await withApiRetry(
    () => iscGet(`/v2026/roles/${roleId}/dimensions/${dimensionId}`),
    { label: `patch role ${roleId} dimension ${dimensionId}: fetch dimension` }
  );
  const removeSet = new Set(hasRemove ? remove : []);
  let nextEntitlements = (dimension.entitlements || []).filter((e) => !removeSet.has(e.id));
  if (hasAdd) {
    const existingIds = new Set(nextEntitlements.map((e) => e.id));
    const toAdd = add
      .filter((e) => !existingIds.has(e.id))
      .map((e) => ({ id: e.id, name: e.name, type: "ENTITLEMENT" }));
    nextEntitlements = [...nextEntitlements, ...toAdd];
  }
  return withApiRetry(
    () => iscPatch(
      `/v2026/roles/${roleId}/dimensions/${dimensionId}`,
      [{ op: "replace", path: "/entitlements", value: nextEntitlements }]
    ),
    { label: `patch role ${roleId} dimension ${dimensionId} entitlements` }
  );
}

/**
 * Creates a new dimension on a dynamic role, scoped to identities where
 * attribute.<attrKey> equals value. Verified live (create then delete a test
 * dimension against a real dimensional role) that this exact payload shape
 * and the DELETE counterpart both work.
 */
export async function createRoleDimensionOnServer(roleId, { name, description, attrKey, value, entitlements }) {
  return withApiRetry(
    () => iscPost(`/v2026/roles/${roleId}/dimensions`, {
      name,
      description: description || `${attrKey.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase())}: ${value}`,
      entitlements: (entitlements || []).map((e) => ({ id: e.id, type: "ENTITLEMENT", name: e.name })),
      accessProfiles: [],
      membership: {
        type: "STANDARD",
        criteria: {
          operation: "AND",
          key: null,
          stringValue: "",
          children: [{
            operation: "EQUALS",
            key: { type: "IDENTITY", property: `attribute.${attrKey}`, sourceId: null },
            stringValue: value,
            children: null,
          }],
        },
      },
    }),
    { label: `create dimension "${name}" on role ${roleId}` }
  );
}

/**
 * PATCH /api/roles/:id/dimensions/:dimensionId
 * fields: { name? } and/or { attrKey, value } (must be provided together —
 * rebuilds the dimension's membership as a single STANDARD/EQUALS rule).
 */
export async function updateRoleDimension(roleId, dimensionId, fields) {
  const { name, attrKey, value } = fields || {};
  if (name === undefined && attrKey === undefined && value === undefined) {
    throw badRequest("Provide name and/or attrKey+value.");
  }
  if ((attrKey === undefined) !== (value === undefined)) {
    throw badRequest("attrKey and value must be provided together.");
  }
  if (name !== undefined && (typeof name !== "string" || !name.trim())) {
    throw badRequest("name can't be empty.");
  }

  const ops = [];
  if (name !== undefined) ops.push({ op: "replace", path: "/name", value: name });
  if (attrKey !== undefined) {
    ops.push({
      op: "replace",
      path: "/membership",
      value: {
        type: "STANDARD",
        criteria: {
          operation: "AND",
          key: null,
          stringValue: "",
          children: [{
            operation: "EQUALS",
            key: { type: "IDENTITY", property: `attribute.${attrKey}`, sourceId: null },
            stringValue: value,
            children: null,
          }],
        },
      },
    });
  }

  try {
    return await iscPatch(`/v2026/roles/${roleId}/dimensions/${dimensionId}`, ops);
  } catch (err) {
    console.error("[roles] edit dimension failed:", err.response?.data || err.message);
    throw routeError(err);
  }
}

/** Shared by remove/add/updateDimensionEntitlements — PATCH .../dimensions/:id/entitlements. */
export async function updateDimensionEntitlements(roleId, dimensionId, { add, remove } = {}) {
  const hasRemove = Array.isArray(remove) && remove.length > 0;
  const hasAdd = Array.isArray(add) && add.length > 0;
  if (!hasRemove && !hasAdd) {
    throw badRequest("Provide a non-empty remove and/or add array.");
  }
  if (hasAdd && add.some((e) => !e?.id || !e?.name)) {
    throw badRequest("Each item in add must have an id and a name.");
  }

  try {
    const result = await patchDimensionEntitlements(roleId, dimensionId, { add, remove });
    if (hasAdd) {
      await tagEntitlementsWithRoleBoundaryValues(roleId, add.map((e) => e.id));
    }
    return result;
  } catch (err) {
    console.error("[roles] update dimension entitlements failed:", err.response?.data || err.message);
    throw routeError(err);
  }
}

export function removeDimensionEntitlements(roleId, dimensionId, entitlementIds) {
  return updateDimensionEntitlements(roleId, dimensionId, { remove: entitlementIds });
}

export function addDimensionEntitlements(roleId, dimensionId, entitlements) {
  return updateDimensionEntitlements(roleId, dimensionId, { add: entitlements });
}

/** POST /api/roles/:id/dimensions — entitlements: [{ id, name }, ...] */
export async function createRoleDimension(roleId, { name, description, attrKey, value, entitlements } = {}) {
  if (!name || !attrKey || !value) {
    throw badRequest("name, attrKey, and value are required.");
  }
  if (entitlements && (!Array.isArray(entitlements) || entitlements.some((e) => !e?.id || !e?.name))) {
    throw badRequest("entitlements must be an array of { id, name }.");
  }

  try {
    const result = await createRoleDimensionOnServer(roleId, { name, description, attrKey, value, entitlements });
    if (Array.isArray(entitlements) && entitlements.length > 0) {
      await tagEntitlementsWithRoleBoundaryValues(roleId, entitlements.map((e) => e.id));
    }
    return result;
  } catch (err) {
    console.error("[roles] create dimension failed:", err.response?.data || err.message);
    throw routeError(err);
  }
}

/**
 * DELETE /api/roles/:id/dimensions/:dimensionId
 * Verified live against a throwaway test dimension: ISC returns 204 and the
 * dimension is gone from the role's /dimensions list immediately.
 */
export async function deleteRoleDimension(roleId, dimensionId) {
  try {
    await iscDelete(`/v2026/roles/${roleId}/dimensions/${dimensionId}`);
  } catch (err) {
    console.error("[roles] delete dimension failed:", err.response?.data || err.message);
    throw routeError(err);
  }
}
