/**
 * ported/accessProfiles.js
 * Client-side ports of the retired Express server's /api/access-profiles/*
 * routes (create / patch fields / entitlements / enabled). Same arguments and
 * return values as the functions in lib/sailpoint.js that used to call those
 * routes; failures throw route-shaped errors (err.response.status,
 * err.response.data.error).
 *
 * generate-description needs the server's AI key and is not ported.
 */

import { iscGet, iscPost, iscPatch, routeError, badRequest } from "../isc";
import { routeErrorMessages } from "./sourceErrors";
import { additionalOwnersError } from "./roles";

/**
 * PATCH /api/access-profiles/:id
 * fields: any of { name, description, owner: {id,name}, additionalOwners:
 * [{type,id,name}], enabled, requestable } — only the fields present are
 * changed, combined into one JSON Patch call.
 */
export async function updateAccessProfile(id, fields) {
  const { name, description, owner, additionalOwners, enabled, requestable } = fields || {};

  const ops = [];
  if (additionalOwners !== undefined) {
    const err = additionalOwnersError(additionalOwners);
    if (err) throw badRequest(err);
    ops.push({ op: "replace", path: "/additionalOwners", value: additionalOwners.map((o) => ({ type: o.type, id: o.id, name: o.name })) });
  }
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
  if (enabled !== undefined) {
    ops.push({ op: "replace", path: "/enabled", value: !!enabled });
  }
  if (requestable !== undefined) {
    ops.push({ op: "replace", path: "/requestable", value: !!requestable });
  }
  if (ops.length === 0) {
    throw badRequest("Provide at least one field to update.");
  }

  try {
    return await iscPatch(`/v2026/access-profiles/${id}`, ops);
  } catch (err) {
    console.error("[access-profiles] edit failed:", err.response?.data || err.message);
    throw routeError(err);
  }
}

/**
 * POST /api/access-profiles
 * { name, owner: {id}, sourceId, entitlementIds?: string[] }
 * Requestable and Enabled both default false — the create form doesn't
 * collect either, so new access profiles start inactive/non-requestable
 * until deliberately turned on.
 */
export async function createAccessProfile({ name: rawName, owner, sourceId, entitlementIds: rawIds } = {}) {
  const name = String(rawName || "").trim();
  const ownerId = owner?.id;
  const entitlementIds = Array.isArray(rawIds) ? rawIds : [];
  if (!name) throw badRequest("name is required.");
  if (!ownerId) throw badRequest("owner is required.");
  if (!sourceId) throw badRequest("source is required.");

  try {
    return await iscPost("/v2026/access-profiles", {
      name,
      owner: { type: "IDENTITY", id: ownerId },
      source: { type: "SOURCE", id: sourceId },
      entitlements: entitlementIds.map((id) => ({ type: "ENTITLEMENT", id })),
      enabled: false,
      requestable: false,
    });
  } catch (err) {
    console.error("[access-profiles] create failed:", err.response?.data || err.message);
    throw routeErrorMessages(err);
  }
}

/**
 * PATCH /api/access-profiles/:id/entitlements
 * { add?: [{id,name}, ...], remove?: [entitlementId, ...] } — reads the
 * profile, applies both lists, and replaces /entitlements in one JSON Patch.
 * Returns the patched access profile.
 */
export async function updateAccessProfileEntitlements(id, { add, remove } = {}) {
  const hasRemove = Array.isArray(remove) && remove.length > 0;
  const hasAdd = Array.isArray(add) && add.length > 0;
  if (!hasRemove && !hasAdd) {
    throw badRequest("Provide a non-empty remove and/or add array.");
  }
  if (hasAdd && add.some((e) => !e?.id || !e?.name)) {
    throw badRequest("Each item in add must have an id and a name.");
  }

  try {
    const profile = await iscGet(`/v2026/access-profiles/${id}`);
    const removeSet = new Set(hasRemove ? remove : []);
    let nextEntitlements = (profile.entitlements || []).filter((e) => !removeSet.has(e.id));
    if (hasAdd) {
      const existingIds = new Set(nextEntitlements.map((e) => e.id));
      const toAdd = add.filter((e) => !existingIds.has(e.id)).map((e) => ({ id: e.id, name: e.name, type: "ENTITLEMENT" }));
      nextEntitlements = [...nextEntitlements, ...toAdd];
    }
    return await iscPatch(`/v2026/access-profiles/${id}`, [{ op: "replace", path: "/entitlements", value: nextEntitlements }]);
  } catch (err) {
    console.error("[access-profiles] update entitlements failed:", err.response?.data || err.message);
    throw routeError(err);
  }
}

/**
 * PATCH /api/access-profiles/:id/enabled
 * Same JSON Patch content-type requirement as roles' own /enabled route —
 * verified live (toggled true then back to false against a real access
 * profile).
 */
export async function setAccessProfileEnabled(id, enabled) {
  if (typeof enabled !== "boolean") {
    throw badRequest("enabled must be a boolean.");
  }
  try {
    return await iscPatch(`/v2026/access-profiles/${id}`, [{ op: "replace", path: "/enabled", value: enabled }]);
  } catch (err) {
    console.error("[access-profiles] enabled toggle failed:", err.response?.data || err.message);
    throw routeError(err);
  }
}
