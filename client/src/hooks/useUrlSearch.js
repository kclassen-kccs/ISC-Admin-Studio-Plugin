import { useState, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { updateUrlParams } from "./urlParamsBuffer";

/**
 * A debounced search box's text, backed by a URL query param instead of
 * plain useState. Navigating to a detail page and clicking Back unmounts
 * the list page — a local useState resets to "" on that remount, silently
 * dropping whatever the user had typed; keeping it in the URL (via
 * useSearchParams, replaced not pushed so typing doesn't spam history)
 * means the remounted page reads the same query string back out and the
 * filter is still there.
 *
 * Returns { search, debouncedSearch, handleSearch } — same shape every
 * listing page already used with its own local useState pair, so adopting
 * this is a near drop-in swap.
 */
export function useUrlSearch(param = "q", delay = 350) {
  const [searchParams, setSearchParams] = useSearchParams();
  const initial = searchParams.get(param) || "";
  const [search, setSearch] = useState(initial);
  const [debouncedSearch, setDebouncedSearch] = useState(initial);
  const timerRef = useRef(null);

  function handleSearch(value) {
    setSearch(value);
    // Shared buffer: a search usually also resets the page in the same
    // handler, and without it that second write erased this one.
    updateUrlParams(setSearchParams, (next) => {
      if (value) next.set(param, value);
      else next.delete(param);
    });
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setDebouncedSearch(value), delay);
  }

  return { search, debouncedSearch, handleSearch };
}
