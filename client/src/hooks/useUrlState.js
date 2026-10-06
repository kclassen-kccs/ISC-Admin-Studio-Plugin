import { useSearchParams } from "react-router-dom";
import { updateUrlParams } from "./urlParamsBuffer";

/**
 * A single string value backed by a URL query param instead of useState —
 * same reasoning as useUrlSearch (hooks/useUrlSearch.js), but for anything
 * that isn't a debounced search box: which tab is active on a detail
 * screen, a status filter, etc. Navigating away and clicking Back unmounts
 * the page, and a plain useState resets to `defaultValue` on that remount
 * even though the URL correctly returned to the same place — keeping the
 * value in the URL means the remounted page reads it straight back out.
 *
 * Returns [value, setValue], the same shape as useState.
 */
export function useUrlState(param, defaultValue) {
  const [searchParams, setSearchParams] = useSearchParams();
  const value = searchParams.get(param) ?? defaultValue;

  // Through the shared buffer, so this can be called alongside other URL
  // writes in the same handler without either one being lost (see
  // urlParamsBuffer).
  function setValue(next) {
    updateUrlParams(setSearchParams, (params) => {
      if (next === defaultValue || !next) params.delete(param);
      else params.set(param, next);
    });
  }

  return [value, setValue];
}
