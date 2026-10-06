import { useEffect, useRef } from "react";
import { useUrlState } from "./useUrlState";
import { Pager } from "../components/ui";

/**
 * Client-side paging over a list that is already fully in memory — the
 * Browse screens that fetch everything (fetchAllPages) and filter locally
 * (Roles, Access Profiles, Applications, Sources, Transforms, Workflows, …).
 * Server-side paging is for lists too big to fetch whole (Identities,
 * Entitlements); this is for the rest, so every list screen pages the same
 * way without each one re-implementing it.
 *
 *   const { page, pager, total } = usePagedList(filtered, { resetKey: search + status });
 *   …
 *   {pager}            // top of the list
 *   {page.map(…)}
 *   {pager}            // bottom of the list
 *
 * - The page offset lives in the URL (default param "offset"), so Back
 *   returns to the same page and a bookmarked page reopens on it.
 * - `resetKey`: any string that changes when the search or a filter changes.
 *   When it changes (not on first mount) the list goes back to page 1, so
 *   callers don't have to reset in every filter handler.
 * - An offset past the end of a shorter list snaps back to the last page.
 */
export function usePagedList(items, { pageSize = 50, urlKey = "offset", noun = "item", resetKey = "" } = {}) {
  const [offsetStr, setOffsetStr] = useUrlState(urlKey, "0");
  const list = Array.isArray(items) ? items : [];
  const total = list.length;
  const lastPage = Math.max(0, Math.floor(Math.max(total - 1, 0) / pageSize) * pageSize);
  const offset = Math.min(Math.max(Number(offsetStr) || 0, 0), lastPage);
  const setOffset = (n) => setOffsetStr(String(Math.max(0, n)));

  // Back to page 1 when the search/filters change — but not on first mount,
  // where the URL's page is the one to honour. The current offset and setter
  // are read through a ref so this reacts to resetKey alone, rather than
  // re-running on every render (setOffset is a new function each time).
  const latest = useRef({ offset, setOffset, resetKey });
  latest.current.offset = offset;
  latest.current.setOffset = setOffset;
  useEffect(() => {
    if (latest.current.resetKey !== resetKey) {
      latest.current.resetKey = resetKey;
      if (latest.current.offset) latest.current.setOffset(0);
    }
  }, [resetKey]);

  const page = list.slice(offset, offset + pageSize);
  const pager = total > pageSize ? (
    <Pager offset={offset} pageSize={pageSize} total={total} noun={noun} onOffsetChange={setOffset} />
  ) : null;

  return { page, pager, offset, setOffset, total, pageSize };
}
