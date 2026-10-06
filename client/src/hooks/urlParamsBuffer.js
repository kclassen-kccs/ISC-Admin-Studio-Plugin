/**
 * Shared by every hook that writes URL query params (useUrlState,
 * useUrlSearch), so several writes in ONE event all land.
 *
 * react-router's setSearchParams hands a functional updater the params from
 * the LAST RENDER, not from an update still pending in the same event. So a
 * filter handler that sets its filter and then resets the page —
 *
 *     setSource(id);   // navigates to ?source=id
 *     setOffset(0);    // starts from the OLD params again, drops `offset`,
 *                      // and navigates there — erasing source=id
 *
 * — silently loses the first write. That made every filter on the
 * Entitlements screen do nothing (its handlers always reset the page), and
 * did the same on Roles, Identities and Source detail whenever you filtered
 * from past page 1.
 *
 * Writes made in the same synchronous tick now build on each other: each
 * starts from the previous one's result rather than from the stale render,
 * and the buffer clears in a microtask, once the handler has finished.
 */
let pending = null;

export function updateUrlParams(setSearchParams, mutate) {
  setSearchParams(
    (prev) => {
      const next = new URLSearchParams(pending ?? prev);
      mutate(next);
      if (!pending) queueMicrotask(() => { pending = null; });
      pending = next;
      return next;
    },
    { replace: true }
  );
}
