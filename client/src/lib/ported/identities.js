/**
 * ported/identities.js
 * Client-side port of the retired Express server's /api/identities/* routes.
 * Each export takes the same arguments and returns the same value as the
 * lib/sailpoint.js function that used to call the route. Failures throw via
 * routeError()/badRequest() so callers still read err.response.data.error.
 */

import { iscGet, iscPost, iscPatch, iscRaw, withApiRetry, describeError, routeError, badRequest } from "../isc";
import { getCredentials } from "../sailpoint";

const EXPERIMENTAL = { "X-SailPoint-Experimental": "true" };

// ─── Identity list / search ────────────────────────────────────────────────

function escapeLuceneText(s) {
  return String(s).replace(/["\\]/g, "\\$&");
}

// For a term dropped in UNQUOTED (e.g. wrapped in our own *wildcards*) —
// escapes every Lucene special character, including * and ? themselves, so
// typed wildcard/operator characters in the value are treated as literal
// text to search for rather than query syntax.
function escapeLuceneWildcardTerm(s) {
  return String(s).replace(/([+\-!(){}[\]^"~*?:\\&|/])/g, "\\$1");
}

// Only letters/digits/underscore/dot survive — this goes straight into an
// unquoted `attributes.<key>:` clause, so anything else could break the
// query (or, unescaped, inject additional clauses).
function sanitizeAttributeKey(key) {
  return String(key).replace(/[^a-zA-Z0-9_.]/g, "");
}

// /public-identities rejects identityProfile/attribute/lifecycle filters as
// "not queryable" (verified live) — the Search API's identities index
// carries the same data and supports filtering on all of it.
function buildIdentitySearchQuery({ query, identityProfileId, lifecycleState, attributeKey, attributeValue }) {
  const clauses = [];
  if (query) {
    const q = escapeLuceneText(query);
    clauses.push(`(name:${q}* OR displayName:${q}* OR email:${q}*)`);
  }
  if (identityProfileId) {
    clauses.push(`identityProfile.id:"${escapeLuceneText(identityProfileId)}"`);
  }
  if (lifecycleState) {
    const state = String(lifecycleState).toLowerCase() === "inactive" ? "inactive" : "active";
    clauses.push(`attributes.cloudLifecycleState:${state}`);
  }
  if (attributeKey && attributeValue) {
    const key = sanitizeAttributeKey(attributeKey);
    // Contains match (verified live: attributes.department:*Operations*
    // matches "Operations - Dept 2", etc.) rather than the exact full value.
    // Case-sensitive (verified live: a lowercase wildcard term matched
    // nothing against mixed-case values).
    if (key) clauses.push(`attributes.${key}:*${escapeLuceneWildcardTerm(attributeValue)}*`);
  }
  return clauses.length > 0 ? clauses.join(" AND ") : "*";
}

// cloudLifecycleState missing/null (common for service/test accounts) is
// treated as active — only an explicit "inactive" value flips it.
function normalizeSearchIdentity(doc) {
  const attrs = doc.attributes || {};
  return {
    id: doc.id,
    name: doc.displayName || doc.name,
    alias: doc.name,
    email: doc.email || null,
    active: (attrs.cloudLifecycleState || "").toLowerCase() !== "inactive",
    identityProfile: doc.identityProfile ? { id: doc.identityProfile.id, name: doc.identityProfile.name } : null,
    attributes: attrs,
  };
}

async function searchIdentitiesPage(params = {}) {
  const limit = Math.min(parseInt(params.limit, 10) || 50, 250);
  // Search's offset paging stops at 10,000 (offset + limit).
  const offset = Math.min(Math.max(parseInt(params.offset, 10) || 0, 0), 10000 - limit);
  try {
    const resp = await withApiRetry(
      () => iscRaw("post", "/v2026/search", {
        data: {
          indices: ["identities"],
          query: { query: buildIdentitySearchQuery(params) },
          // Alphabetical — every list in the app is shown sorted.
          sort: ["name"],
          queryResultFilter: { includes: ["id", "name", "displayName", "email", "attributes", "identityProfile"] },
        },
        params: { limit, offset, count: true },
        headers: { "Content-Type": "application/json" },
      }),
      { label: "identities: search" }
    );
    const total = resp.headers?.["x-total-count"];
    return {
      identities: (Array.isArray(resp.data) ? resp.data : []).map(normalizeSearchIdentity),
      total: total != null ? Number(total) : null,
    };
  } catch (err) {
    throw routeError(err);
  }
}

export async function listIdentities({ limit = 20, offset = 0, query, identityProfileId, lifecycleState, attributeKey, attributeValue } = {}) {
  return (await searchIdentitiesPage({ limit, offset, query, identityProfileId, lifecycleState, attributeKey, attributeValue })).identities;
}

export async function listIdentitiesPage(params) {
  return searchIdentitiesPage(params || {});
}

// ─── Lifecycle states ──────────────────────────────────────────────────────

// An identity's lifecycle states are the ones defined on ITS identity
// profile, found through the identity's authoritative source.
// /identity-profiles doesn't accept filtering on authoritativeSource.id
// (rejected as semantically invalid) — list them all and match here.
// Returns { identity, profile, lifecycleStates } or { error } (a 422 message).
async function resolveIdentityLifecycle(identityId) {
  const identity = await iscGet(`/v2026/identities/${identityId}`);
  const sourceId = identity.attributes?.cloudAuthoritativeSource;
  if (!sourceId) return { error: "This identity has no authoritative source, so its lifecycle state can't be changed." };
  const profiles = await iscGet("/v2026/identity-profiles", { limit: 250 });
  const profile = profiles.find((pr) => pr.authoritativeSource?.id === sourceId);
  if (!profile) return { error: "No identity profile is configured for this identity's authoritative source." };
  const lifecycleStates = await iscGet(`/v2026/identity-profiles/${profile.id}/lifecycle-states`, { limit: 250 });
  return { identity, profile, lifecycleStates: Array.isArray(lifecycleStates) ? lifecycleStates : [] };
}

export async function getIdentityLifecycleStates(id) {
  try {
    const resolved = await resolveIdentityLifecycle(id);
    if (resolved.error) throw badRequest(resolved.error, 422);
    const { identity, profile, lifecycleStates } = resolved;
    return {
      profile: { id: profile.id, name: profile.name },
      current: identity.attributes?.cloudLifecycleState || identity.lifecycleState?.stateName || null,
      // When the profile maps cloudLifecycleState through a transform, ISC
      // recalculates it on every identity refresh — a manual change holds
      // only until the next one, unless the source data agrees with it.
      calculatedFrom: (() => {
        const t = (profile.identityAttributeConfig?.attributeTransforms || []).find((x) => x.identityAttributeName === "cloudLifecycleState");
        if (!t) return null;
        const leaf = (d) => (d?.type === "accountAttribute" ? d.attributes : d?.attributes?.input ? leaf(d.attributes.input) : null);
        const src = leaf(t.transformDefinition);
        return { sourceName: src?.sourceName || null, attributeName: src?.attributeName || null, transform: t.transformDefinition?.type === "reference" ? t.transformDefinition.attributes?.id || null : null };
      })(),
      states: lifecycleStates
        .map((st) => ({
          id: st.id,
          name: st.name,
          technicalName: st.technicalName,
          description: st.description || "",
          enabled: st.enabled !== false,
          identityState: st.identityState || null,
          accountActions: (Array.isArray(st.accountActions) ? st.accountActions : []).map((a) => ({
            action: a.action,
            sourceCount: Array.isArray(a.sourceIds) ? a.sourceIds.length : 0,
            allSources: !!a.allSources,
          })),
          accessProfileCount: Array.isArray(st.accessProfileIds) ? st.accessProfileIds.length : 0,
          removesAllAccess: !!st.accessActionConfiguration?.removeAllAccessEnabled,
          identityCount: st.identityCount ?? null,
          emailsManager: !!st.emailNotificationOption?.notifyManagers,
          emailsOthers: !!(st.emailNotificationOption?.notifyAllAdmins || st.emailNotificationOption?.notifySpecificUsers),
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  } catch (err) {
    if (err?.isRouteError) throw err;
    const out = routeError(err);
    const text = err?.response?.data?.messages?.[0]?.text;
    if (text) { out.message = text; out.response.data.error = text; }
    throw out;
  }
}

/**
 * Disabling/enabling an identity in ISC isn't a direct "disable identity"
 * call — it's done by moving the identity to whichever of its identity
 * profile's lifecycle states carries ACTIVE (enable) or an INACTIVE_*
 * identityState (disable), which cascades the account enable/disable
 * actions configured on that state. `target` is { state } or
 * { lifecycleStateId }; an id must be one of the identity's own profile's
 * states, and an enabled one.
 */
async function setLifecycleState(id, { state, lifecycleStateId }) {
  if (!lifecycleStateId && state !== "enable" && state !== "disable") {
    throw badRequest('state must be "enable" or "disable" (or pass lifecycleStateId).');
  }
  try {
    const resolved = await resolveIdentityLifecycle(id);
    if (resolved.error) throw badRequest(resolved.error, 422);
    const { profile, lifecycleStates } = resolved;

    let target;
    if (lifecycleStateId) {
      target = lifecycleStates.find((s) => s.id === lifecycleStateId);
      if (!target) throw badRequest(`That lifecycle state doesn't belong to this identity's profile ("${profile.name}").`, 422);
      if (target.enabled === false) throw badRequest(`"${target.name}" is disabled on the "${profile.name}" profile, so identities can't be moved to it.`, 422);
    } else {
      target = state === "enable"
        ? lifecycleStates.find((s) => s.identityState === "ACTIVE")
        : lifecycleStates.find((s) => s.technicalName === "inactive") ||
          lifecycleStates.find((s) => (s.identityState || "").startsWith("INACTIVE"));
      if (!target) {
        throw badRequest(`This identity's profile ("${profile.name}") has no ${state === "enable" ? "active" : "inactive"} lifecycle state configured.`, 422);
      }
    }

    const data = await iscPost(`/v2026/identities/${id}/set-lifecycle-state`, { lifecycleStateId: target.id });
    return { accountActivityId: data?.accountActivityId, lifecycleState: target.technicalName, lifecycleStateName: target.name };
  } catch (err) {
    if (err?.isRouteError) throw err;
    const out = routeError(err);
    const msg = err?.response?.data?.messages?.[0]?.text || err?.response?.data?.detailCode || err?.message;
    if (msg) { out.message = msg; out.response.data.error = msg; }
    throw out;
  }
}

export function setIdentityLifecycleState(id, state) {
  return setLifecycleState(id, { state });
}

export function moveIdentityToLifecycleState(id, lifecycleStateId) {
  return setLifecycleState(id, { lifecycleStateId });
}

// ─── Access / entitlements / email ─────────────────────────────────────────

// The transactional GET /identities/:id doesn't carry assigned access — only
// the Search API's denormalized identity document does, as an `access` array
// mixing roles/access profiles/entitlements (each tagged with a `type`).
export async function getIdentityAccess(identityId, type) {
  const t = String(type || "").toUpperCase();
  if (!["ROLE", "ACCESS_PROFILE"].includes(t)) throw badRequest("type must be ROLE or ACCESS_PROFILE.");
  try {
    const data = await iscPost("/v2026/search", { indices: ["identities"], query: { query: `id:"${identityId}"` } });
    const access = (data?.[0]?.access || []).filter((a) => a.type === t);
    access.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    return access;
  } catch (err) {
    throw routeError(err);
  }
}

// The raw ISC endpoint returns each entitlement's raw attribute value as
// "name" for many sources — verified live against Active Directory and
// Salesforce entitlements (an AD group's GUID, a Salesforce ProfileId)
// rather than the human-readable name. The real name and source only come
// from the bulk-by-id entitlement lookup, so resolve them in batches.
const ENTITLEMENT_SOURCE_LOOKUP_BATCH_SIZE = 50;
async function resolveEntitlementDisplayInfo(ids) {
  const uniqueIds = [...new Set(ids)];
  const infoById = new Map();
  for (let i = 0; i < uniqueIds.length; i += ENTITLEMENT_SOURCE_LOOKUP_BATCH_SIZE) {
    const batch = uniqueIds.slice(i, i + ENTITLEMENT_SOURCE_LOOKUP_BATCH_SIZE);
    const filters = `id in (${batch.map((id) => `"${id}"`).join(",")})`;
    try {
      const results = await withApiRetry(
        () => iscGet("/v2026/entitlements", { filters, limit: batch.length }),
        { label: "resolveEntitlementDisplayInfo: entitlements batch lookup" }
      );
      for (const e of results) infoById.set(e.id, { name: e.name, source: e.source?.name || null });
    } catch (err) {
      console.error("[identities] entitlement display-info lookup batch failed:", err.response?.data || err.message);
    }
  }
  return infoById;
}

export async function getIdentityEntitlements(identityId, { limit = 50 } = {}) {
  try {
    const entitlements = await iscGet(`/v2026/entitlements/identities/${identityId}/entitlements`, { limit: Number(limit) || 50 });
    const infoById = await resolveEntitlementDisplayInfo(entitlements.map((e) => e.id));
    return entitlements.map((e) => {
      const info = infoById.get(e.id);
      return { ...e, name: info?.name || e.name, source: info?.source || null };
    });
  } catch (err) {
    throw routeError(err);
  }
}

export async function getIdentityEmail(id) {
  try {
    const identity = await withApiRetry(
      () => iscGet(`/v2026/identities/${id}`),
      { label: `get identity ${id} email` }
    );
    // The identity resource's real top-level field is emailAddress, not
    // email (verified live — a plain .email is always undefined). Falls
    // back to the attributes.email custom attribute some tenants also carry.
    return { id: identity.id, name: identity.name, email: identity.emailAddress || identity.attributes?.email || null };
  } catch (err) {
    throw routeError(err);
  }
}

// ─── Admin actions: invite, user levels, governance groups ─────────────────

// The invite endpoint is experimental (X-SailPoint-Experimental).
export async function inviteIdentity(identityId) {
  try {
    const data = await iscPost("/v2026/identities/invite", { ids: [identityId], uninvited: false }, { headers: EXPERIMENTAL });
    return data || { ok: true };
  } catch (err) {
    console.warn("[identities] invite failed:", err.response?.status, JSON.stringify(err.response?.data || err.message));
    throw routeError(err);
  }
}

// Replaces the identity's auth-user capabilities (built-in levels + any
// "sp:…" rights passed through unchanged) with a JSON Patch.
export async function setIdentityUserLevels(identityId, capabilities) {
  const caps = capabilities;
  if (!Array.isArray(caps) || caps.some((c) => typeof c !== "string" || !c.trim())) {
    throw badRequest("capabilities must be an array of strings.");
  }
  // Removing Admin from yourself would lock this session out of the admin
  // APIs mid-flight — refuse; another admin can do it.
  if (identityId === getCredentials()?.identityId && !caps.includes("ORG_ADMIN")) {
    try {
      const current = await iscGet(`/v2026/auth-users/${identityId}`);
      if ((current?.capabilities || []).includes("ORG_ADMIN")) {
        throw badRequest("You can't remove the Admin user level from your own account — ask another admin to do it.");
      }
    } catch (err) {
      if (err?.isRouteError) throw err;
      /* fall through to the update */
    }
  }
  try {
    return await iscPatch(
      `/v2026/auth-users/${encodeURIComponent(identityId)}`,
      [{ op: "replace", path: "/capabilities", value: [...new Set(caps.map((c) => c.trim()))] }]
    );
  } catch (err) {
    console.warn("[identities] user level update failed:", err.response?.status, JSON.stringify(err.response?.data || err.message));
    throw routeError(err);
  }
}

// Adds/removes this identity as a member of each governance group (bulk-add /
// bulk-delete per group). Continues past individual failures and reports.
export async function updateIdentityGovernanceGroups(identityId, { add = [], remove = [], name } = {}) {
  const addIds = Array.isArray(add) ? add : [];
  const removeIds = Array.isArray(remove) ? remove : [];
  const member = [{ type: "IDENTITY", id: identityId, ...(name ? { name: String(name) } : {}) }];
  const results = [];
  for (const [op, ids] of [["bulk-add", addIds], ["bulk-delete", removeIds]]) {
    for (const groupId of ids) {
      try {
        await withApiRetry(
          () => iscPost(`/v2026/workgroups/${encodeURIComponent(groupId)}/members/${op}`, member),
          { label: `workgroup ${groupId} ${op}` }
        );
        results.push({ groupId, op, ok: true });
      } catch (err) {
        results.push({ groupId, op, ok: false, error: describeError(err) });
      }
    }
  }
  return { results };
}

// ─── Data segments an identity falls into ──────────────────────────────────

// This experimental endpoint's own max limit is 50 (verified live: 51+ 400s
// "semantically invalid"). enabled and published each filter to an exact
// value — there's no combination meaning "all" — so fetch all 4 combos and
// merge by id. count:true is required, or the endpoint silently drops some
// matching segments (verified live).
const DATA_SEGMENTS_PAGE_SIZE = 50;

async function fetchAllForCombo(params) {
  const all = [];
  for (let offset = 0; ; offset += DATA_SEGMENTS_PAGE_SIZE) {
    const page = await withApiRetry(
      () => iscGet("/v2026/data-segments", { ...params, count: true, limit: DATA_SEGMENTS_PAGE_SIZE, offset }, EXPERIMENTAL),
      { label: "fetchAllForCombo: data-segments page" }
    );
    if (!Array.isArray(page) || page.length === 0) break;
    all.push(...page);
    if (page.length < DATA_SEGMENTS_PAGE_SIZE) break;
  }
  return all;
}

async function fetchAllDataSegments() {
  const combos = [
    { enabled: true, published: true },
    { enabled: true, published: false },
    { enabled: false, published: true },
    { enabled: false, published: false },
  ];
  const pages = await Promise.all(combos.map((params) => fetchAllForCombo(params)));
  const byId = new Map();
  for (const page of pages) for (const s of page) byId.set(s.id, s);
  return [...byId.values()];
}

function extractSegmentEqualsLeaves(expr, out = []) {
  if (!expr) return out;
  if (expr.operator === "EQUALS" && expr.attribute) {
    out.push({ attrKey: expr.attribute, value: expr.value?.value });
    return out;
  }
  for (const child of expr.children || []) extractSegmentEqualsLeaves(child, out);
  return out;
}

// Segment membership for an identity is never denormalized anywhere, so this
// evaluates the segment's own memberFilter attribute=value pairs (flat
// AND-of-EQUALS leaves) against the identity's own attributes.
function identityMatchesSegment(segment, attrs) {
  const leaves = extractSegmentEqualsLeaves(segment.memberFilter?.expression);
  if (leaves.length === 0) return false;
  return leaves.every((l) => String((attrs || {})[l.attrKey] ?? "") === String(l.value ?? ""));
}

export async function getIdentitySegments(identityId) {
  try {
    const identity = await withApiRetry(
      () => iscGet(`/v2026/identities/${identityId}`),
      { label: "identity segments: get identity" }
    );
    const allSegments = await fetchAllDataSegments();
    return allSegments
      .filter((seg) => identityMatchesSegment(seg, identity?.attributes))
      .map((seg) => ({ id: seg.id, name: seg.name, active: seg.active !== false }));
  } catch (err) {
    throw routeError(err);
  }
}
