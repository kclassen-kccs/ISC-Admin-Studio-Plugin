/**
 * ported/identityProfiles.js
 * Browser-side port of the old Express /api/identity-profiles routes (list,
 * delete, process-identities).
 *
 * Each export returns the same body the route used to send. Failures throw
 * routeError()/badRequest() so callers still read err.response.data.error.
 */

import { iscGet, iscPost, iscDelete, withApiRetry, describeError, routeError, badRequest } from "../isc";

// The server reported ISC's own message text ahead of the generic one for
// the two write routes (delete / process-identities).
function iscMessageError(err) {
  const text = err?.response?.data?.messages?.[0]?.text;
  if (!text) return routeError(err);
  const out = routeError(err);
  out.message = text;
  out.response.data.error = text;
  return out;
}

/**
 * GET /api/identity-profiles — minimal id/name list, used to populate the
 * Identities list's Identity Profile filter pill. The option list comes
 * straight from ISC's own profile registry, not derived by scanning
 * identities.
 */
export async function listIdentityProfiles() {
  try {
    const profiles = await withApiRetry(
      () => iscGet("/v2026/identity-profiles", { limit: 250, sorters: "name" }),
      { label: "identity-profiles: list" }
    );
    return profiles.map((p) => ({ id: p.id, name: p.name })).sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    console.error("[identity-profiles] list failed:", err.response?.data || err.message);
    throw routeError(err);
  }
}

/**
 * DELETE /api/identity-profiles/:id — used by the Source Detail delete flow
 * to remove a source's Identity Profile first: ISC won't delete a Source at
 * all while an Identity Profile still names it as authoritativeSource.
 */
export async function deleteIdentityProfile(id) {
  try {
    await iscDelete(`/v2026/identity-profiles/${id}`);
  } catch (err) {
    console.error("[identity-profiles] delete failed:", err.response?.data || err.message);
    throw iscMessageError(err);
  }
}

/**
 * POST /api/identity-profiles/:id/process-identities — ISC's own "Apply
 * Changes" for an Identity Profile: re-evaluates every identity under the
 * profile against its current attribute mappings and lifecycle states.
 * Asynchronous: a 202 means ISC accepted the job, not that identities are
 * updated yet. Resolves { accepted: true }.
 */
export async function processIdentityProfile(id) {
  if (!/^[A-Za-z0-9-]+$/.test(String(id))) throw badRequest("Invalid identity profile id.");
  try {
    await iscPost(`/v2026/identity-profiles/${id}/process-identities`, {});
    console.log(`[identity-profiles] process-identities started for ${id}`);
    return { accepted: true };
  } catch (err) {
    console.error("[identity-profiles] process-identities failed:", describeError(err));
    throw iscMessageError(err);
  }
}
