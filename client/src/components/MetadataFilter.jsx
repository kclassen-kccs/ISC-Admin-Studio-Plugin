import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { X, Tags } from "lucide-react";
import { listMetadataAttributes, listMetadataAttributeValues, searchAccessIdsByMetadata, METADATA_NOT_SET } from "../lib/sailpoint";
import { useUrlState } from "../hooks/useUrlState";
import { Field, PrimaryButton, OutlineButton, SkeletonList, ErrorBox } from "./ui";

// ─── Access Model Metadata filter for the Roles / Access Profiles /
// Entitlements lists ──────────────────────────────────────────────────────
// One attribute + one value. Matching is done through ISC Search's
// @accessModelMetadata() nested query (the same one Segments by Metadata
// uses, verified live) on the list's own index, which yields the matching
// ids; the list is then narrowed to those ids client-side — the REST list
// endpoints can't filter on metadata at all.
//
// The value can also be "(Not Set)" (METADATA_NOT_SET): items with no value
// at all for the attribute, matched with NOT @accessModelMetadata(key:…).

export { METADATA_NOT_SET };
export const NOT_SET_LABEL = "(Not Set)";

// Packed into ONE url param (key|value|attrName|valueName) so applying it
// is a single URL write — see EntitlementsPage's owner filter for why two
// back-to-back useUrlState writes race each other.
export function useMetadataFilter(param = "metadata") {
  const [raw, setRaw] = useUrlState(param, "");
  let filter = null;
  if (raw) {
    const [key, value, attributeName, valueName] = raw.split("|").map((p) => decodeURIComponent(p || ""));
    if (key && value) filter = { key, value, attributeName: attributeName || key, valueName: valueName || value };
  }
  const set = (f) => setRaw(f ? [f.key, f.value, f.attributeName || "", f.valueName || ""].map(encodeURIComponent).join("|") : "");
  return { filter, set, clear: () => setRaw("") };
}

// The Set of ids on `index` ("roles" | "accessprofiles" | "entitlements")
// tagged with the filter's value — null while no filter is set.
export function useMetadataMatchIds(index, filter) {
  const q = useQuery({
    queryKey: ["metadata-match-ids", index, filter?.key, filter?.value],
    queryFn: () => searchAccessIdsByMetadata(index, filter.key, filter.value),
    enabled: !!filter,
    staleTime: 60_000,
  });
  return { ids: filter ? q.data || null : null, isLoading: !!filter && q.isLoading, error: filter ? q.error : null };
}

function MetadataFilterDialog({ current, onApply, onClear, onClose }) {
  const attrsQuery = useQuery({ queryKey: ["metadata-attributes"], queryFn: listMetadataAttributes });
  const [key, setKey] = useState(current?.key || "");
  const [value, setValue] = useState(current?.value || "");
  const valuesQuery = useQuery({
    queryKey: ["metadata-attribute-values", key],
    queryFn: () => listMetadataAttributeValues(key),
    enabled: !!key,
  });
  const attrs = Array.isArray(attrsQuery.data) ? attrsQuery.data : [];
  const values = Array.isArray(valuesQuery.data) ? valuesQuery.data : [];
  const selectClass = "w-full bg-white border border-gray-200 rounded-xl px-3 py-2.5 text-sm text-gray-900 outline-none focus:border-blue-400";

  return (
    <div className="fixed inset-0 bg-black/30 z-30 flex items-end md:items-center justify-center" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="bg-white w-full max-w-lg md:mx-4 rounded-t-2xl md:rounded-2xl shadow-xl p-5 max-h-[85vh] overflow-y-auto">
        <h2 className="text-base font-semibold text-gray-900 mb-1">Filter by Metadata</h2>
        <p className="text-xs text-gray-500 mb-4">Show only items tagged with this Access Model Metadata value, or pick {NOT_SET_LABEL} for items with no value for the attribute.</p>
        {attrsQuery.isLoading && <SkeletonList rows={2} />}
        {attrsQuery.error && <ErrorBox message={attrsQuery.error.response?.data?.error || attrsQuery.error.message} />}
        {!attrsQuery.isLoading && !attrsQuery.error && (
          <>
            <Field label="Attribute">
              <select value={key} onChange={(e) => { setKey(e.target.value); setValue(""); }} className={selectClass}>
                <option value="">Choose an attribute…</option>
                {attrs.map((a) => <option key={a.key} value={a.key}>{a.name || a.key}</option>)}
              </select>
            </Field>
            <Field label="Value">
              <select value={value} onChange={(e) => setValue(e.target.value)} disabled={!key} className={selectClass}>
                <option value="">{!key ? "Pick an attribute first" : valuesQuery.isLoading ? "Loading values…" : "Choose a value…"}</option>
                {key && <option value={METADATA_NOT_SET}>{NOT_SET_LABEL}</option>}
                {values.map((v) => <option key={v.value} value={v.value}>{v.name || v.value}</option>)}
              </select>
            </Field>
            <PrimaryButton
              onClick={() => {
                const attr = attrs.find((a) => a.key === key);
                const val = values.find((v) => v.value === value);
                const valueName = value === METADATA_NOT_SET ? NOT_SET_LABEL : val?.name || value;
                onApply({ key, value, attributeName: attr?.name || key, valueName });
              }}
              disabled={!key || !value}
            >
              Apply
            </PrimaryButton>
            <OutlineButton onClick={onClose} className="mt-2">Cancel</OutlineButton>
            {current && (
              <button type="button" onClick={onClear} className="w-full mt-3 text-xs font-medium text-red-600 hover:text-red-700">
                Clear metadata filter
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// The pill for a filter bar's right slot: "Metadata…" when unset, a blue
// chip naming the attribute and value (with an X to clear) when set.
export function MetadataFilterControl({ filter, onApply, onClear }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {filter ? (
        <span className="flex-shrink-0 inline-flex items-center gap-1 text-xs font-medium pl-3 pr-1.5 py-1.5 rounded-full border bg-blue-600 text-white border-blue-600">
          <button type="button" onClick={() => setOpen(true)} className="hover:underline truncate max-w-[10rem] text-left" title={`${filter.attributeName}: ${filter.valueName}`}>
            {filter.attributeName}: {filter.valueName}
          </button>
          <button type="button" onClick={onClear} title="Clear metadata filter" className="p-0.5 rounded-full hover:bg-blue-700 transition-colors flex-shrink-0">
            <X size={12} />
          </button>
        </span>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex-shrink-0 inline-flex items-center gap-1 text-xs font-medium px-3 py-1.5 rounded-full border border-gray-200 bg-white text-gray-600 hover:border-gray-300 transition-colors"
        >
          <Tags size={12} />
          Metadata…
        </button>
      )}
      {open && (
        <MetadataFilterDialog
          current={filter}
          onApply={(f) => { onApply(f); setOpen(false); }}
          onClear={() => { onClear(); setOpen(false); }}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
