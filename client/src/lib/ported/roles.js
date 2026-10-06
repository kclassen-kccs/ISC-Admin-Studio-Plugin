/**
 * ported/roles.js
 * Client-side ports of the retired Express server's /api/roles/* routes
 * (get / by-ids / delete / enabled / patch fields / certify / entitlements /
 * members / role propagation). Same arguments and return values as the
 * functions in lib/sailpoint.js that used to call those routes; failures
 * throw route-shaped errors (err.response.status, err.response.data.error).
 *
 * Related ports live beside this file:
 *   roleDimensions.js   dimension CRUD + dimension entitlement patching
 *   roleMembers.js      live membership-rule evaluation (rule-members)
 *   roleCommonAccess.js Common Access flag / unflag / ids
 *   roleEvaluation.js   evaluate, composition, SOD mitigations
 */

import { iscGet, iscPost, iscPatch, iscDelete, withApiRetry, routeError, badRequest, describeError } from "../isc";
import {
  mapWithConcurrency,
  currentUser,
  extractAllCriteriaLeaves,
  criteriaLeavesSubsetOf,
} from "./roleShared";
import {
  getCommonAccessRoleIdSet,
  fetchCommonAccessRoleSummaries,
  filterApplicableCommonAccessEntIds,
  getFlaggedCommonAccessRoleIds,
  forgetFlaggedCommonAccessRole,
  triggerCommonAccessAnalysis,
} from "./roleCommonAccess";
import { patchRoleEntitlements, patchDimensionEntitlements } from "./roleDimensions";
import { tagEntitlementsWithRoleBoundaryValues } from "./metadataTagging";

// Role Propagation lives on a separate root, not /v2026, and requires the
// Experimental opt-in header. Verified live:
//   POST /role-propagation/v1 (empty body) -> 202 { rolePropagationId }
//     -> 400 "role propagation already in progress" if one is already running
//   GET  /role-propagation/v1/{id}/status
//     -> { id, status: "RUNNING"|..., executionStage, launched, launchedBy }
const ROLE_PROPAGATION_HEADERS = { "X-SailPoint-Experimental": "true" };

/**
 * GET /api/roles/:id
 * Retried with backoff so a transient 429/5xx doesn't fail outright — backs
 * Role Detail's page load and the Roles list's bulk Detail Report print (which
 * fetches every listed role's full detail back-to-back, exactly the burst that
 * trips ISC's rate limiting).
 */
export async function getRole(id) {
  try {
    return await withApiRetry(() => iscGet(`/v2026/roles/${id}`), { label: `get role ${id}` });
  } catch (err) {
    console.error(`[roles] get ${id} failed:`, err.response?.data || err.message);
    throw routeError(err);
  }
}

/**
 * GET /api/roles/by-ids?ids=id1,id2,... — bulk fetch via an `id in (...)`
 * filter (verified live) rather than one request per role.
 */
export async function getRolesByIds(ids) {
  const list = Array.isArray(ids) ? ids.filter(Boolean) : [];
  if (list.length === 0) return [];
  try {
    const filters = `id in (${list.map((id) => `"${id}"`).join(",")})`;
    return await withApiRetry(() => iscGet("/v2026/roles", { filters, limit: list.length }), { label: "roles by-ids" });
  } catch (err) {
    console.error("[roles] by-ids failed:", err.response?.data || err.message);
    throw routeError(err);
  }
}

/**
 * DELETE /api/roles/:id
 * Retried with backoff (honoring Retry-After) — a bulk delete loop over many
 * roles treated every 429 as a hard per-role failure under real ISC rate
 * limiting. A deleted role that was tracked as flagged Common Access also drops
 * out of that persisted list.
 */
export async function deleteRole(id) {
  try {
    await withApiRetry(() => iscDelete(`/v2026/roles/${id}`), { label: `delete role ${id}` });
    await forgetFlaggedCommonAccessRole(id);
    return "";
  } catch (err) {
    console.error("[roles] delete failed:", err.response?.data || err.message);
    throw routeError(err);
  }
}

/**
 * PATCH /api/roles/:id/enabled
 * SailPoint requires the JSON Patch content type (application/json-patch+json)
 * for this PATCH — verified live that the same call with a plain
 * application/json body is rejected with 415.
 */
export async function setRoleEnabled(id, enabled) {
  if (typeof enabled !== "boolean") {
    throw badRequest("enabled must be a boolean.");
  }
  try {
    const data = await iscPatch(`/v2026/roles/${id}`, [{ op: "replace", path: "/enabled", value: enabled }]);
    // Activating (not just creating) a Common Access role is also a trigger
    // point — a Skeleton scan's Common Access role, for one, is always created
    // disabled, so its analysis never ran at create time. Tracked-role check is
    // a cheap local lookup, not a live ISC call.
    if (enabled && (await getFlaggedCommonAccessRoleIds()).includes(id)) {
      try {
        await triggerCommonAccessAnalysis();
      } catch (err) {
        console.error(`[roles] common-access analysis trigger failed after enabling role ${id}:`, err.response?.data || err.message);
      }
    }
    return data;
  } catch (err) {
    console.error("[roles] enabled toggle failed:", err.response?.data || err.message);
    throw routeError(err);
  }
}

// additionalOwners on roles and access profiles: several IDENTITY entries, or
// exactly one GOVERNANCE_GROUP — never mixed. Returns an error message, or null
// when valid. Shared with ported/accessProfiles.js.
export function additionalOwnersError(additionalOwners) {
  if (!Array.isArray(additionalOwners)) return "additionalOwners must be an array.";
  if (additionalOwners.some((o) => !o?.id || !["IDENTITY", "GOVERNANCE_GROUP"].includes(o.type))) {
    return "Each additional owner needs an id and a type of IDENTITY or GOVERNANCE_GROUP.";
  }
  const groups = additionalOwners.filter((o) => o.type === "GOVERNANCE_GROUP");
  if (groups.length > 0 && additionalOwners.length > 1) {
    return "additionalOwners can be several users, or a single governance group, not both.";
  }
  return null;
}

/**
 * PATCH /api/roles/:id
 * fields: any of { name, description, owner: {id,name}, additionalOwners:
 * [{type,id,name}], dimensional: boolean, requestable: boolean } — only the
 * fields present are changed, combined into one JSON Patch call.
 */
export async function updateRole(roleId, fields) {
  const { name, description, owner, additionalOwners, dimensional, requestable } = fields || {};

  const ops = [];
  if (name !== undefined) {
    if (!name || !String(name).trim()) throw badRequest("name can't be empty.");
    ops.push({ op: "replace", path: "/name", value: name });
  }
  if (description !== undefined) {
    ops.push({ op: "replace", path: "/description", value: description });
  }
  if (owner !== undefined) {
    if (!owner?.id) throw badRequest("owner must have an id.");
    ops.push({ op: "replace", path: "/owner", value: { type: "IDENTITY", id: owner.id, name: owner.name } });
  }
  if (additionalOwners !== undefined) {
    const err = additionalOwnersError(additionalOwners);
    if (err) throw badRequest(err);
    ops.push({
      op: "replace",
      path: "/additionalOwners",
      value: additionalOwners.map((o) => ({ type: o.type, id: o.id, name: o.name })),
    });
  }
  if (dimensional !== undefined) {
    if (typeof dimensional !== "boolean") throw badRequest("dimensional must be a boolean.");
    ops.push({ op: "replace", path: "/dimensional", value: dimensional });
  }
  if (requestable !== undefined && typeof requestable !== "boolean") {
    throw badRequest("requestable must be a boolean.");
  }
  if (ops.length === 0 && requestable === undefined) {
    throw badRequest("Provide at least one field to update.");
  }

  try {
    // requestable only makes sense on a role nobody already gets automatically
    // — a dimensional (dynamic) role or one with a membership rule is assigned
    // by ISC itself, not requested, so this checks the role's *current* state
    // (before any dimensional change in this same call).
    if (requestable !== undefined) {
      const currentRole = await iscGet(`/v2026/roles/${roleId}`);
      if (currentRole.dimensional || currentRole.membership?.criteria) {
        throw badRequest("requestable can only be changed for a standard role with no membership rule.");
      }
      ops.push({ op: "replace", path: "/requestable", value: requestable });
    }
    return await iscPatch(`/v2026/roles/${roleId}`, ops);
  } catch (err) {
    if (err.isRouteError) throw err;
    console.error("[roles] edit failed:", err.response?.data || err.message);
    throw routeError(err);
  }
}

// ─── Certify ─────────────────────────────────────────────────────────────────

const CAMPAIGN_STAGE_POLL_INTERVAL_MS = 2000;
const CAMPAIGN_STAGE_POLL_TIMEOUT_MS = 60000;
// Only reachable, in normal operation, via an explicit activate call —
// legitimately "already running," nothing left to do. COMPLETED/ARCHIVED are
// deliberately NOT included even though a campaign can reach them without ever
// being activated — a certification nobody actually got assigned to review is
// a failure to report, not a silent success.
const CAMPAIGN_ALREADY_ACTIVATED_STATUSES = new Set(["ACTIVATING", "ACTIVE", "COMPLETING"]);

/**
 * A freshly created campaign starts PENDING while ISC generates its actual
 * certifications in the background, and only becomes STAGED (activatable) once
 * that finishes — calling activate immediately after create races this and
 * 400s with ISC's generic "semantically invalid" (verified live). Polls until
 * the campaign is either STAGED or has already moved past that point on its own
 * via a genuine activation. Throws for COMPLETED/ARCHIVED/ERROR or a timeout.
 */
async function waitForCampaignStageable(campaignId) {
  const start = Date.now();
  while (Date.now() - start < CAMPAIGN_STAGE_POLL_TIMEOUT_MS) {
    const campaign = await withApiRetry(
      () => iscGet(`/v2026/campaigns/${campaignId}`),
      { label: `certify: poll campaign ${campaignId} status` }
    );
    if (campaign.status === "STAGED") return "STAGED";
    if (CAMPAIGN_ALREADY_ACTIVATED_STATUSES.has(campaign.status)) return campaign.status;
    if (campaign.status === "ERROR") {
      throw new Error(`Campaign ${campaignId} entered ERROR status before it could be activated.`);
    }
    if (campaign.status === "COMPLETED" || campaign.status === "ARCHIVED") {
      throw new Error(
        `Campaign ${campaignId} reached ${campaign.status} without ever being activated — ` +
        "it likely had nothing certifiable to review (e.g. only birthright/common-access entitlements), " +
        "so no one was actually assigned to review it. Check the role's own composition in ISC."
      );
    }
    await new Promise((resolve) => setTimeout(resolve, CAMPAIGN_STAGE_POLL_INTERVAL_MS));
  }
  throw new Error(
    `Campaign ${campaignId} did not finish staging within ${CAMPAIGN_STAGE_POLL_TIMEOUT_MS / 1000}s — ` +
    "it may still become activatable on its own; check it directly in ISC."
  );
}

/**
 * POST /api/roles/certify
 * Creates and activates one ROLE_COMPOSITION certification campaign per
 * distinct role owner among the given roles, named "<owner> Role Composition
 * Review" — SailPoint's campaign API takes a single reviewer per campaign
 * (roleCompositionCampaignInfo.reviewer), so roles sharing an owner are bundled
 * into that owner's one campaign.
 * Returns { results, skippedNoOwner, skippedDimensional, fetchErrors }.
 */
export async function certifyRoles(roleIds) {
  const ids = Array.isArray(roleIds) ? roleIds.filter((id) => typeof id === "string" && id) : [];
  if (ids.length === 0) throw badRequest("roleIds must be a non-empty array.");

  try {
    // Fresh owner per role, not whatever the client's own (possibly stale,
    // possibly paginated-out) list data says.
    const roles = [];
    const fetchErrors = [];
    await mapWithConcurrency(ids, 5, async (id) => {
      try {
        roles.push(await withApiRetry(() => iscGet(`/v2026/roles/${id}`), { label: `certify: fetch role ${id}` }));
      } catch (err) {
        fetchErrors.push({ id, error: describeError(err) });
      }
    });

    const byOwner = new Map(); // ownerId -> { owner, roles: [] }
    const skippedNoOwner = [];
    const skippedDimensional = [];
    for (const role of roles) {
      // Verified live: a ROLE_COMPOSITION campaign scoped to a dimensional
      // (dynamic) role generates zero certifications (totalCertifications: 0)
      // and jumps straight from PENDING to COMPLETED with no one ever assigned
      // to review it. Looks like an ISC platform limitation, so these are
      // skipped up front rather than silently producing an empty "completed"
      // campaign.
      if (role.dimensional) {
        skippedDimensional.push({ id: role.id, name: role.name });
        continue;
      }
      if (!role.owner?.id) {
        skippedNoOwner.push({ id: role.id, name: role.name });
        continue;
      }
      if (!byOwner.has(role.owner.id)) byOwner.set(role.owner.id, { owner: role.owner, roles: [] });
      byOwner.get(role.owner.id).roles.push(role);
    }

    const me = await currentUser();
    const deadline = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
    const results = [];
    for (const { owner, roles: ownerRoles } of byOwner.values()) {
      const campaignName = `${owner.name} Role Composition Review`;
      let campaignId = null;
      try {
        const created = await withApiRetry(
          () => iscPost("/v2026/campaigns", {
            name: campaignName,
            description: "This Role review will help us ensure these Roles are valid for our user base.",
            deadline,
            type: "ROLE_COMPOSITION",
            emailNotificationEnabled: true,
            roleCompositionCampaignInfo: {
              reviewer: { type: "IDENTITY", id: owner.id, name: owner.name },
              roleIds: ownerRoles.map((r) => r.id),
              // Who "revoke" decisions in this campaign get assigned to — ISC
              // requires this to be a Role Admin or Org Admin, which the role
              // owner isn't necessarily; the signed-in user (who has permission
              // to trigger this action at all) is used instead.
              remediatorRef: { type: "IDENTITY", id: me.id, name: me.username },
            },
          }),
          { label: `certify: create campaign for owner ${owner.id}` }
        );
        campaignId = created.id;

        const readyStatus = await waitForCampaignStageable(campaignId);
        if (readyStatus === "STAGED") {
          await withApiRetry(
            () => iscPost(`/v2026/campaigns/${campaignId}/activate`, {}),
            { label: `certify: activate campaign ${campaignId}` }
          );
        }
        // Any other returned status (ACTIVATING/ACTIVE/COMPLETING) means it's
        // already running via a genuine activation — nothing left to do.
        // waitForCampaignStageable itself throws for COMPLETED/ARCHIVED/ERROR/
        // timeout, so reaching this line means the campaign really is active.

        results.push({ ownerId: owner.id, ownerName: owner.name, ok: true, campaignId, campaignName, roleCount: ownerRoles.length });
      } catch (err) {
        console.error(`[roles] certify: campaign failed for owner ${owner.id} (${owner.name}):`, err.response?.data || err.message);
        results.push({
          ownerId: owner.id,
          ownerName: owner.name,
          ok: false,
          // A campaignId here means creation succeeded but activation never
          // happened — the campaign object still exists in ISC, just not
          // actually running, worth saying explicitly.
          campaignId,
          error: campaignId
            ? `Campaign "${campaignName}" was created but failed to activate: ${describeError(err)}`
            : describeError(err),
          roleCount: ownerRoles.length,
        });
      }
    }

    return { results, skippedNoOwner, skippedDimensional, fetchErrors };
  } catch (err) {
    console.error("[roles] certify failed:", err.response?.data || err.message);
    throw routeError(err);
  }
}

// ─── Entitlements ────────────────────────────────────────────────────────────

/**
 * Accept-time cascade for Common Access roles: entitlements just ADDED to a
 * common role are removed from every other role "in the same context" — any
 * candidate role whose membership criteria are a superset of the common role's
 * (its population sits entirely inside the common scope). Covers base-role
 * entitlements and dimensions. Best-effort per role — a single role's failure
 * is logged and skipped, never unwinding the accept that triggered it.
 * Returns [{ roleId, roleName, removed: [names] }].
 */
export async function removeAcceptedCommonEntsFromContextRoles(commonRoleId, addedEntIds, candidateRoleIds) {
  const added = new Set(addedEntIds);
  if (added.size === 0 || candidateRoleIds.length === 0) return [];
  const commonRole = await iscGet(`/v2026/roles/${commonRoleId}`);
  const commonLeaves = extractAllCriteriaLeaves(commonRole.membership?.criteria);
  if (commonLeaves.length === 0) return [];

  const removedFrom = [];
  for (const rid of candidateRoleIds) {
    if (rid === commonRoleId) continue;
    try {
      const role = await withApiRetry(() => iscGet(`/v2026/roles/${rid}`), { label: `common-accept cascade: fetch role ${rid}` });
      const leaves = extractAllCriteriaLeaves(role.membership?.criteria);
      if (leaves.length === 0 || !criteriaLeavesSubsetOf(commonLeaves, leaves)) continue;

      const removedNames = [];
      const baseRemove = (role.entitlements || []).filter((e) => added.has(e.id));
      if (baseRemove.length > 0) {
        await patchRoleEntitlements(rid, { remove: baseRemove.map((e) => e.id) });
        removedNames.push(...baseRemove.map((e) => e.name));
      }
      if (role.dimensional) {
        const dims = await withApiRetry(() => iscGet(`/v2026/roles/${rid}/dimensions`), { label: `common-accept cascade: fetch role ${rid} dimensions` });
        for (const d of dims || []) {
          const dimRemove = (d.entitlements || []).filter((e) => added.has(e.id));
          if (dimRemove.length > 0) {
            await patchDimensionEntitlements(rid, d.id, { remove: dimRemove.map((e) => e.id) });
            removedNames.push(...dimRemove.map((e) => e.name));
          }
        }
      }
      if (removedNames.length > 0) {
        removedFrom.push({ roleId: rid, roleName: role.name, removed: removedNames });
      }
    } catch (err) {
      console.error(`[insights] common-accept cascade: role ${rid} failed:`, err.response?.data || err.message);
    }
  }
  return removedFrom;
}

// Every role in the tenant, fully — /v2026/roles already returns each role's
// own membership.criteria inline (verified live), so no per-role detail fetch
// is needed.
async function fetchAllRolesWithCriteria() {
  const all = [];
  let offset = 0;
  const pageSize = 250;
  while (true) {
    const page = await withApiRetry(
      () => iscGet("/v2026/roles", { limit: pageSize, offset }),
      { label: "segment-role-match: roles page" }
    );
    if (!Array.isArray(page) || page.length === 0) break;
    all.push(...page);
    if (page.length < pageSize) break;
    offset += pageSize;
  }
  return all;
}

/**
 * PATCH /api/roles/:id/entitlements
 * { remove?: [entitlementId, ...], add?: [{ id, name }, ...] }
 */
async function patchRoleEntitlementsRoute(roleId, { add, remove } = {}) {
  const hasRemove = Array.isArray(remove) && remove.length > 0;
  const hasAdd = Array.isArray(add) && add.length > 0;
  if (!hasRemove && !hasAdd) {
    throw badRequest("Provide a non-empty remove and/or add array.");
  }
  if (hasAdd && add.some((e) => !e?.id || !e?.name)) {
    throw badRequest("Each item in add must have an id and a name.");
  }

  try {
    // Invariant: non-common roles never carry entitlements a common role grants
    // for the same users.
    //  - Adding to a NON-common role: entries an applicable common role already
    //    grants are dropped from the add (they're birthright).
    //  - Adding to a COMMON role: the added entitlements are removed from every
    //    role whose population the common role covers.
    let effectiveAdd = add;
    let isCommonTarget = false;
    if (hasAdd) {
      const commonIds = await getCommonAccessRoleIdSet().catch(() => new Set());
      isCommonTarget = commonIds.has(roleId);
      if (!isCommonTarget && commonIds.size > 0) {
        const targetRole = await iscGet(`/v2026/roles/${roleId}`);
        const summaries = await fetchCommonAccessRoleSummaries().catch(() => []);
        const birthright = filterApplicableCommonAccessEntIds(targetRole.membership, summaries, roleId);
        effectiveAdd = add.filter((e) => !birthright.has(e.id));
        if (effectiveAdd.length < add.length) {
          console.log(`[roles] add to ${roleId}: dropped ${add.length - effectiveAdd.length} entitlement(s) already granted by common access`);
        }
      }
    }
    const hasEffective = (effectiveAdd?.length || 0) > 0 || hasRemove;
    const result = hasEffective
      ? await patchRoleEntitlements(roleId, { add: effectiveAdd, remove })
      : await iscGet(`/v2026/roles/${roleId}`);
    if ((effectiveAdd?.length || 0) > 0) {
      await tagEntitlementsWithRoleBoundaryValues(roleId, effectiveAdd.map((e) => e.id));
    }
    if (isCommonTarget && (effectiveAdd?.length || 0) > 0) {
      const all = await fetchAllRolesWithCriteria().catch(() => []);
      const commonIds = await getCommonAccessRoleIdSet().catch(() => new Set());
      const candidates = all.map((r) => r.id).filter((id) => !commonIds.has(id));
      await removeAcceptedCommonEntsFromContextRoles(roleId, effectiveAdd.map((e) => e.id), candidates);
    }
    return result;
  } catch (err) {
    if (err.isRouteError) throw err;
    console.error("[roles] update entitlements failed:", err.response?.data || err.message);
    throw routeError(err);
  }
}

export function removeRoleEntitlements(roleId, entitlementIds) {
  return patchRoleEntitlementsRoute(roleId, { remove: entitlementIds });
}

// entitlements: [{ id, name }, ...]
export function addRoleEntitlements(roleId, entitlements) {
  return patchRoleEntitlementsRoute(roleId, { add: entitlements });
}

// Combined add+remove in one call — so the two don't race each other as
// separate PATCH replaces against the same array.
export function updateRoleEntitlements(roleId, { add, remove }) {
  return patchRoleEntitlementsRoute(roleId, { add, remove });
}

// ─── Members ─────────────────────────────────────────────────────────────────

/**
 * PATCH /api/roles/:id/members
 * { add?: [{id,name}, ...], remove?: [identityId, ...] }
 *
 * Only works for a role with no membership rule (criteria) — SailPoint's
 * IDENTITY_LIST membership type, the explicit-list alternative to a
 * criteria-based STANDARD rule. A criteria-driven role's members are computed
 * automatically; PATCHing /membership on one of those would replace the rule
 * itself, not just add/remove people, so this refuses to touch a role that has
 * one.
 */
export async function updateRoleMembers(roleId, { add, remove } = {}) {
  const hasAdd = Array.isArray(add) && add.length > 0;
  const hasRemove = Array.isArray(remove) && remove.length > 0;
  if (!hasAdd && !hasRemove) {
    throw badRequest("Provide a non-empty add and/or remove array.");
  }
  if (hasAdd && add.some((i) => !i?.id)) {
    throw badRequest("Each item in add must have an id.");
  }

  try {
    const role = await iscGet(`/v2026/roles/${roleId}`);
    if (role.membership?.criteria) {
      throw badRequest("This role has a membership rule — members are computed automatically and can't be edited directly.");
    }
    const removeSet = new Set(hasRemove ? remove : []);
    let nextIdentities = (role.membership?.identities || []).filter((i) => !removeSet.has(i.id));
    if (hasAdd) {
      const existingIds = new Set(nextIdentities.map((i) => i.id));
      const toAdd = add.filter((i) => !existingIds.has(i.id)).map((i) => ({ type: "IDENTITY", id: i.id, name: i.name || null }));
      nextIdentities = [...nextIdentities, ...toAdd];
    }
    // ISC rejects an IDENTITY_LIST membership with an empty identities array
    // ("Required field membership.identities was missing or empty") — removing
    // the last member has to drop membership back to null (no rule at all)
    // instead, verified live.
    const membershipValue = nextIdentities.length > 0
      ? { type: "IDENTITY_LIST", criteria: null, identities: nextIdentities }
      : null;
    return await iscPatch(`/v2026/roles/${roleId}`, [{ op: "replace", path: "/membership", value: membershipValue }]);
  } catch (err) {
    if (err.isRouteError) throw err;
    console.error("[roles] members patch failed:", err.response?.data || err.message);
    throw routeError(err);
  }
}

// ─── Apply role changes (Role Propagation) ───────────────────────────────────
// Creating, editing, enabling/disabling, or deleting a role takes effect
// immediately in the role's own definition, but a member's actual granted
// access only catches up once SailPoint's Role Propagation job runs — that's
// when role/dimension membership criteria get (re-)evaluated tenant-wide and
// access is provisioned or revoked accordingly.

/** POST /api/roles/apply-changes -> { rolePropagationId } */
export async function applyRoleChanges() {
  try {
    return await iscPost("/role-propagation/v1", {}, { headers: ROLE_PROPAGATION_HEADERS });
  } catch (err) {
    console.error("[roles] apply-changes failed:", err.response?.data || err.message);
    const out = routeError(err);
    const text = err.response?.data?.messages?.[0]?.text;
    if (text) {
      out.message = text;
      out.response.data.error = text;
    }
    throw out;
  }
}

/** GET /api/roles/apply-changes/:id/status -> { id, status, executionStage, launched, launchedBy } */
export async function getApplyRoleChangesStatus(rolePropagationId) {
  try {
    return await iscGet(`/role-propagation/v1/${rolePropagationId}/status`, undefined, ROLE_PROPAGATION_HEADERS);
  } catch (err) {
    console.error("[roles] apply-changes status failed:", err.response?.data || err.message);
    throw routeError(err);
  }
}

/**
 * GET /api/roles/propagation-running -> { isRunning, rolePropagationDetails? }
 * Whether a tenant-wide Role Propagation run is in progress — regardless of
 * whether it was started from this app or ISC's own UI.
 */
export async function getRolePropagationRunning() {
  try {
    return await iscGet("/role-propagation/v1/is-running", undefined, ROLE_PROPAGATION_HEADERS);
  } catch (err) {
    console.error("[roles] propagation-running check failed:", err.response?.data || err.message);
    throw routeError(err);
  }
}
