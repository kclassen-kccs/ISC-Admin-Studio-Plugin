/**
 * ported/sourceIdentityProfile.js
 * Browser-side port of /api/sources/:id/{identity-profile,
 * create-identity-profile,sync-identity-profile}.
 *
 * The old routes asked Claude to match a source's schema attributes to the
 * tenant's Identity Attributes (mapSourceAttributesToIdentitySchema). With no
 * AI available in the plugin that helper behaves exactly as it did on a
 * server where AI wasn't configured: it returns no mappings. So create
 * wires just uid/displayName, and sync reports every new schema attribute in
 * `unmatchedNames` rather than auto-mapping it.
 */

import { iscGet, iscPost, iscPatch, withApiRetry, routeError, badRequest } from "../isc";
import { routeErrorMessages } from "./sourceErrors";
import { getCredentials } from "../sailpoint";

// Renders a transform definition down to one short line.
function describeIdentityAttributeTransform(transform) {
  if (!transform) return "";
  const attrs = transform.attributes || {};
  if (transform.type === "accountAttribute") {
    return [attrs.sourceName, attrs.attributeName].filter(Boolean).join(" → ") || "Account Attribute";
  }
  if (transform.type === "reference" && attrs.id) return attrs.id;
  if (transform.type === "static" && attrs.value != null) return `Static: ${attrs.value}`;
  if (attrs.name) return `${transform.type}: ${attrs.name}`;
  return transform.type || "Mapped";
}

// No AI in the plugin — see the file header.
async function mapSourceAttributesToIdentitySchema() {
  return [];
}

// The Identity Profile whose authoritative source is this one (there's at
// most one — /identity-profiles rejects filtering on authoritativeSource.id as
// semantically invalid, so this lists all profiles and matches client-side),
// plus a concise list of ONLY the identity attributes this profile actually
// maps — an attribute with no configured mapping simply has no entry in
// attributeTransforms at all.
export async function getSourceIdentityProfile(sourceId) {
  try {
    const profiles = await withApiRetry(
      () => iscGet("/v2026/identity-profiles", { limit: 250 }),
      { label: "sources: identity-profile lookup" }
    );
    const profile = profiles.find((p) => p.authoritativeSource?.id === sourceId);
    if (!profile) return { hasProfile: false, profile: null, mappings: [] };

    const [detail, identityAttrs] = await Promise.all([
      withApiRetry(
        () => iscGet(`/v2026/identity-profiles/${profile.id}`),
        { label: `sources: identity-profile ${profile.id} detail` }
      ),
      withApiRetry(
        () => iscGet("/v2026/identity-attributes", { limit: 250 }),
        { label: "sources: identity-attributes catalog" }
      ).catch(() => []),
    ]);

    const displayNames = new Map((identityAttrs || []).map((a) => [a.name, a.displayName]));
    const transforms = detail.identityAttributeConfig?.attributeTransforms || [];
    const mappings = transforms
      .filter((t) => t.transformDefinition)
      .map((t) => ({
        name: t.identityAttributeName,
        displayName: displayNames.get(t.identityAttributeName) || t.identityAttributeName,
        mapping: describeIdentityAttributeTransform(t.transformDefinition),
      }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));

    return {
      hasProfile: true,
      profile: { id: profile.id, name: profile.name, description: detail.description || null },
      mappings,
    };
  } catch (err) {
    throw routeError(err);
  }
}

// Creates the Identity Profile "<source name> Profile" from the source's own
// confirmed UID/Account Name attributes — { profile, mapping, applied }.
export async function createIdentityProfileForSource(sourceId) {
  try {
    const source = await withApiRetry(() => iscGet(`/v2026/sources/${sourceId}`), { label: "create-identity-profile: fetch source" });
    const schemas = await withApiRetry(() => iscGet(`/v2026/sources/${sourceId}/schemas`), { label: "create-identity-profile: fetch schemas" });
    const accountSchema = (schemas || []).find((s) => s.name === "account");
    if (!accountSchema) throw badRequest("This source has no account schema yet — upload a CSV first.", 422);
    if (!accountSchema.identityAttribute || !accountSchema.displayAttribute) {
      throw badRequest("This source's UID/Account Name attributes aren't set yet.", 422);
    }

    const identityAttrs = await withApiRetry(
      () => iscGet("/v2026/identity-attributes", { limit: 250 }),
      { label: "create-identity-profile: identity-attributes catalog" }
    ).catch(() => []);

    // priority must be unique tenant-wide (verified live: a hardcoded 100
    // collided with an existing profile and 400'd "Value of priority should
    // be unique") — one past the current highest keeps every new profile
    // out of the way of whatever's already there.
    const existingProfiles = await withApiRetry(
      () => iscGet("/v2026/identity-profiles", { limit: 250 }),
      { label: "create-identity-profile: existing profiles for priority" }
    ).catch(() => []);
    const nextPriority = Math.max(0, ...existingProfiles.map((p) => (typeof p.priority === "number" ? p.priority : 0))) + 10;

    const mappedSchemaAttrNames = new Set([accountSchema.identityAttribute, accountSchema.displayAttribute]);
    const remainingSchemaAttrs = (accountSchema.attributes || []).filter((a) => !mappedSchemaAttrNames.has(a.name));
    const aiMapping = await mapSourceAttributesToIdentitySchema(remainingSchemaAttrs, identityAttrs);

    const attributeTransforms = [
      {
        identityAttributeName: "uid",
        transformDefinition: { type: "accountAttribute", attributes: { sourceName: source.name, attributeName: accountSchema.identityAttribute, sourceId: source.id } },
      },
      {
        identityAttributeName: "displayName",
        transformDefinition: { type: "accountAttribute", attributes: { sourceName: source.name, attributeName: accountSchema.displayAttribute, sourceId: source.id } },
      },
      ...aiMapping.map((m) => ({
        identityAttributeName: m.identityAttribute,
        transformDefinition: { type: "accountAttribute", attributes: { sourceName: source.name, attributeName: m.sourceAttribute, sourceId: source.id } },
      })),
    ];

    const profile = await iscPost("/v2026/identity-profiles", {
      name: `${source.name} Profile`,
      description: `Identity Profile for ${source.name}`,
      owner: { type: "IDENTITY", id: getCredentials()?.identityId },
      priority: nextPriority,
      authoritativeSource: { type: "SOURCE", id: source.id },
      identityAttributeConfig: { enabled: true, attributeTransforms },
    });

    // Creating the profile only saves its attribute mapping config — the
    // mapping isn't actually applied to any identity until Process
    // Identities runs (verified live: POST .../process-identities -> 202).
    // Without this, "<source name> Profile" would sit there fully
    // configured but every identity attribute it maps would stay empty
    // until ISC's own next scheduled refresh got around to it.
    let applied = true;
    try {
      await withApiRetry(
        () => iscPost(`/v2026/identity-profiles/${profile.id}/process-identities`, {}),
        { label: `create-identity-profile: process-identities ${profile.id}` }
      );
    } catch (applyErr) {
      applied = false;
      console.error("[sources] process-identities failed after profile create:", applyErr.response?.data || applyErr.message);
    }

    return { profile, mapping: aiMapping, applied };
  } catch (err) {
    throw routeErrorMessages(err);
  }
}

// Reconciles this source's Identity Profile's attribute mappings against its
// CURRENT account schema, rather than requiring a full recreate: any schema
// attribute with no mapping yet gets one proposed (AI in the old server; none
// here), and any existing mapping that points at an account attribute the
// schema no longer has gets dropped. Everything else — mappings still backed
// by a real schema attribute, and any mapping that isn't an accountAttribute
// transform from this source at all (manager, static values, rules, ...) —
// is left completely untouched.
//
// The uid/displayName mappings created at profile-creation time are treated
// as fixed, not synced: schema editing already refuses to let those columns
// be deleted, so they can't go stale this way.
//
// Sent as a single JSON-Patch "replace" of the whole attributeTransforms
// array rather than per-item add/remove ops — much simpler than juggling
// shifting array indices for a mix of removals and additions in one request.
//
// A new schema attribute that can't be matched is reported back as
// unmatchedNames rather than silently counted as "nothing to do" — it found
// something real, it just couldn't act on it automatically.
// { changed, added, removed, unmatchedNames, applied? }
export async function syncSourceIdentityProfile(sourceId) {
  try {
    const source = await withApiRetry(() => iscGet(`/v2026/sources/${sourceId}`), { label: "sync-identity-profile: fetch source" });
    const profiles = await withApiRetry(
      () => iscGet("/v2026/identity-profiles", { limit: 250 }),
      { label: "sync-identity-profile: lookup" }
    );
    const profileStub = profiles.find((p) => p.authoritativeSource?.id === sourceId);
    if (!profileStub) throw badRequest("This source has no Identity Profile.", 404);

    const [detail, schemas, identityAttrs] = await Promise.all([
      withApiRetry(() => iscGet(`/v2026/identity-profiles/${profileStub.id}`), { label: "sync-identity-profile: profile detail" }),
      withApiRetry(() => iscGet(`/v2026/sources/${sourceId}/schemas`), { label: "sync-identity-profile: schemas" }),
      withApiRetry(
        () => iscGet("/v2026/identity-attributes", { limit: 250 }),
        { label: "sync-identity-profile: identity-attributes catalog" }
      ).catch(() => []),
    ]);

    const accountSchema = (schemas || []).find((s) => s.name === "account");
    if (!accountSchema) throw badRequest("This source has no account schema.", 422);

    const isThisSourceAccountAttr = (t) =>
      t.transformDefinition?.type === "accountAttribute" && t.transformDefinition.attributes?.sourceId === sourceId;

    const currentTransforms = detail.identityAttributeConfig?.attributeTransforms || [];
    const currentSchemaAttrNames = new Set((accountSchema.attributes || []).map((a) => a.name));

    // Stale: mapped from one of this source's account attributes, but that
    // attribute isn't on the schema anymore.
    const staleSet = new Set(
      currentTransforms.filter((t) => isThisSourceAccountAttr(t) && !currentSchemaAttrNames.has(t.transformDefinition.attributes.attributeName))
    );
    const kept = currentTransforms.filter((t) => !staleSet.has(t));

    // New: schema attributes with no existing mapping from this source yet,
    // excluding the identityAttribute/displayAttribute columns already wired
    // to uid/displayName at profile-creation time.
    const mappedSourceAttrNames = new Set(kept.filter(isThisSourceAccountAttr).map((t) => t.transformDefinition.attributes.attributeName));
    const mappedIdentityAttrNames = new Set(kept.map((t) => t.identityAttributeName));
    const skipNames = new Set([accountSchema.identityAttribute, accountSchema.displayAttribute].filter(Boolean));
    const newSchemaAttrs = (accountSchema.attributes || []).filter((a) => !skipNames.has(a.name) && !mappedSourceAttrNames.has(a.name));

    let added = [];
    if (newSchemaAttrs.length > 0) {
      const candidateIdentityAttrs = (identityAttrs || []).filter((a) => !mappedIdentityAttrNames.has(a.name));
      const aiMapping = await mapSourceAttributesToIdentitySchema(newSchemaAttrs, candidateIdentityAttrs);
      added = aiMapping.map((m) => ({
        identityAttributeName: m.identityAttribute,
        transformDefinition: { type: "accountAttribute", attributes: { sourceName: source.name, attributeName: m.sourceAttribute, sourceId } },
      }));
    }

    const addedNames = new Set(added.map((t) => t.transformDefinition.attributes.attributeName));
    const unmatchedNames = newSchemaAttrs.filter((a) => !addedNames.has(a.name)).map((a) => a.name);

    if (staleSet.size === 0 && added.length === 0) {
      return { changed: false, added: 0, removed: 0, unmatchedNames };
    }

    const attributeTransforms = [...kept, ...added];
    await iscPatch(`/v2026/identity-profiles/${profileStub.id}`, [
      { op: "replace", path: "/identityAttributeConfig/attributeTransforms", value: attributeTransforms },
    ]);

    // Same as profile creation — a newly-added mapping sits configured but
    // empty on every identity until Process Identities actually runs.
    let applied = true;
    try {
      await withApiRetry(
        () => iscPost(`/v2026/identity-profiles/${profileStub.id}/process-identities`, {}),
        { label: `sync-identity-profile: process-identities ${profileStub.id}` }
      );
    } catch (applyErr) {
      applied = false;
      console.error("[sources] process-identities failed after sync:", applyErr.response?.data || applyErr.message);
    }

    return { changed: true, added: added.length, removed: staleSet.size, unmatchedNames, applied };
  } catch (err) {
    throw routeErrorMessages(err);
  }
}
