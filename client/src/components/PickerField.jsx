import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { Field, Input, Spinner } from "./ui";

// Debounced search-and-pick over identities or governance groups (or
// anything else with an {id, name} shape) — `multi` controls whether
// picking replaces the current selection or adds to it. Originally local
// to RoleDetailPage's EditRoleModal, extracted for reuse (e.g. the source
// Application create/edit dialog's owner field).
// cacheKey keeps two pickers that share a label (e.g. an unlabeled users
// picker and an unlabeled governance-group picker) from sharing results.
export function PickerField({ label, placeholder, searchFn, multi, selected, onChange, cacheKey }) {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [open, setOpen] = useState(false);

  const handleSearch = (value) => {
    setQuery(value);
    setOpen(true);
    clearTimeout(window.__pickerFieldTimer);
    window.__pickerFieldTimer = setTimeout(() => setDebounced(value), 350);
  };

  const resultsQuery = useQuery({
    queryKey: ["picker-field", cacheKey || label, debounced],
    queryFn: () => searchFn(debounced),
    enabled: open,
  });
  // While the 350ms debounce timer hasn't yet caught up to the latest
  // keystroke, `resultsQuery.data` is still serving whatever was fetched
  // for the PREVIOUS (or, right after opening, empty) query term — not what
  // the input currently shows. Rendering those as clickable was a real bug:
  // typing quickly and clicking the first result could pick someone whose
  // name has nothing to do with what was typed, because the visible list
  // hadn't actually caught up yet. Treating that window as "still loading"
  // (no clickable rows) keeps what's on screen always in sync with what a
  // click would actually select.
  const stale = query !== debounced;
  const selectedIds = new Set(selected.map((s) => s.id));
  const results = stale ? [] : (resultsQuery.data || []).filter((r) => !selectedIds.has(r.id));
  const resultsLoading = stale || resultsQuery.isLoading;

  const pick = (item) => {
    onChange(multi ? [...selected, item] : [item]);
    setQuery("");
    setDebounced("");
    setOpen(false);
  };
  const remove = (id) => onChange(selected.filter((s) => s.id !== id));

  return (
    <Field label={label}>
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {selected.map((s) => (
            <span key={s.id} className="inline-flex items-center gap-1 text-xs bg-blue-50 text-blue-700 border border-blue-100 rounded-full pl-2.5 pr-1.5 py-1">
              {s.name}
              <button type="button" onClick={() => remove(s.id)} className="hover:text-blue-900">
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      {/* The search box always shows, even for single-select once something's
          already picked — hiding it forced a remove-then-search-again dance
          to change an existing value (the common case when editing something
          that already has an owner), and picking a replacement already
          works correctly via pick()'s multi ? append : replace branch. */}
      <div className="relative">
        <Input
          value={query}
          onChange={(e) => handleSearch(e.target.value)}
          onFocus={() => setOpen(true)}
          placeholder={placeholder}
        />
        {open && (
          <div className="absolute z-10 left-0 right-0 mt-1 bg-white border border-gray-200 rounded-xl shadow-lg max-h-96 overflow-y-auto">
            {resultsLoading && (
              <div className="flex items-center justify-center py-3"><Spinner size={14} /></div>
            )}
            {!resultsLoading && results.length === 0 && (
              <p className="text-xs text-gray-400 text-center py-3">No results</p>
            )}
            {results.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => pick(r)}
                className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
              >
                {r.name}
              </button>
            ))}
          </div>
        )}
      </div>
    </Field>
  );
}
