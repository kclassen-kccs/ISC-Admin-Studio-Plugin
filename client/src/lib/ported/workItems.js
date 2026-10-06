/**
 * ported/workItems.js
 * Browser-side port of the old Express /api/work-items routes (list,
 * pending-count, get one, complete), which proxied SailPoint's v3 Work
 * Items API. GET /v3/work-items only ever returns Pending items, so a
 * completed one just stops appearing — no local filtering needed.
 *
 * Each export returns the same body the route used to send. Failures throw
 * routeError() so callers still read err.response.data.error.
 */

import { iscGet, iscPost, routeError } from "../isc";
import { getCredentials } from "../sailpoint";

// The server scoped the list to the signed-in identity (session.identity.id).
function ownerId() {
  return getCredentials()?.identityId;
}

/** GET /api/work-items — the signed-in identity's pending manual work items. */
export async function listWorkItems() {
  try {
    return await iscGet("/v3/work-items", { "owner-id": ownerId(), limit: 100 });
  } catch (err) {
    console.error("[work-items] list failed:", err.response?.data || err.message);
    throw routeError(err);
  }
}

/** GET /api/work-items/pending-count — { count } for the at-a-glance box. */
export async function getPendingWorkItemsCount() {
  try {
    const items = await iscGet("/v3/work-items", { "owner-id": ownerId(), limit: 100 });
    return { count: items.length };
  } catch (err) {
    console.error("[work-items] pending-count failed:", err.response?.data || err.message);
    throw routeError(err);
  }
}

/** GET /api/work-items/:id — one work item's full detail. */
export async function getWorkItem(id) {
  try {
    return await iscGet(`/v3/work-items/${id}`);
  } catch (err) {
    console.error("[work-items] get failed:", err.response?.data || err.message);
    throw routeError(err);
  }
}

/**
 * POST /api/work-items/:id/complete.
 * Not /v3/work-items/:id/complete — that path 404s with an internal gateway
 * routing bug (verified live: duplicated "work-items/work-items/:id/complete"
 * path, never reaches a handler, regardless of body/content-type). The real
 * working endpoint is the legacy v1 API's own item URL, POST with no suffix
 * and no body — verified live end-to-end: 200 response with the item's
 * state flipped to "Finished", and it then disappears from the v3 pending list.
 */
export async function completeWorkItem(id) {
  try {
    const data = await iscPost(`/work-items/v1/${id}`, {});
    return data || { id, completed: true };
  } catch (err) {
    console.error("[work-items] complete failed:", err.response?.data || err.message);
    throw routeError(err);
  }
}
