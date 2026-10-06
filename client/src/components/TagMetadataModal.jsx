import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { listMetadataAttributes, listMetadataAttributeValues } from "../lib/sailpoint";
import { Field, Input, PrimaryButton, OutlineButton, SkeletonList, ErrorBox, SegmentedPill } from "./ui";

// Pick one Access Model Metadata attribute + value (or type a brand-new
// value for ad-hoc attributes, registered with a display name + technical
// slug, same convention as Segments by Metadata). Submission is the
// caller's: onConfirm({ key, value, name? }) runs the actual tagging, so
// the same dialog serves both an object's own Metadata tab and the bulk Tag
// Metadata action on a list selection. `noun` names what's selected
// ("roles"); `allowRemove` adds an Add / Remove switch, and onConfirm then
// also gets `operation` ("add" | "remove"). Removing only ever picks an
// existing value — there's nothing to untag a brand-new one from.
export function TagMetadataModal({ count = 1, noun = "entitlements", allowRemove = false, onConfirm, onClose, pending }) {
  const [operation, setOperation] = useState("add");
  const removing = allowRemove && operation === "remove";
  const attrsQuery = useQuery({ queryKey: ["metadata-attributes"], queryFn: listMetadataAttributes });
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [newValue, setNewValue] = useState("");
  const valuesQuery = useQuery({
    queryKey: ["metadata-attribute-values", key],
    queryFn: () => listMetadataAttributeValues(key),
    enabled: !!key,
  });
  const attrs = Array.isArray(attrsQuery.data) ? attrsQuery.data : [];
  const chosenAttr = attrs.find((a) => a.key === key);
  const values = Array.isArray(valuesQuery.data) ? valuesQuery.data : [];

  function submit() {
    const trimmed = removing ? "" : newValue.trim();
    if (trimmed) {
      const slug = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
      onConfirm({ key, value: slug, name: trimmed, operation });
    } else {
      onConfirm({ key, value, operation });
    }
  }

  const canSubmit = !!key && (removing ? !!value : !!newValue.trim() || !!value);

  return (
    <div
      className="fixed inset-0 bg-black/30 z-30 flex items-end md:items-center justify-center"
      onClick={(e) => e.target === e.currentTarget && !pending && onClose()}
    >
      <div className="bg-white w-full max-w-lg md:mx-4 rounded-t-2xl md:rounded-2xl shadow-xl max-h-[85vh] overflow-y-auto">
        <div className="px-5 pt-5 pb-5">
          <h2 className="text-base font-semibold text-gray-900 mb-3">
            {count === 1 && !allowRemove ? "Add Metadata" : `Tag Metadata (${count.toLocaleString()} ${noun})`}
          </h2>
          {allowRemove && (
            <div className="mb-3">
              <SegmentedPill
                label="Add or remove"
                options={[{ value: "add", label: "Add a value" }, { value: "remove", label: "Remove a value" }]}
                active={operation}
                onChange={(op) => { setOperation(op); setNewValue(""); }}
              />
              <p className="text-xs text-gray-500 mt-2">
                {removing
                  ? `Removes the value from every selected ${noun.replace(/s$/, "")} that has it. Ones that don't are left alone.`
                  : `Adds the value to every selected ${noun.replace(/s$/, "")}. It checks first which ones already have it and skips those.`}
              </p>
            </div>
          )}
          {attrsQuery.isLoading && <SkeletonList rows={2} />}
          {attrsQuery.error && <ErrorBox message={attrsQuery.error.message} />}
          {!attrsQuery.isLoading && !attrsQuery.error && (
            <>
              <Field label="Attribute">
                <select
                  value={key}
                  onChange={(e) => { setKey(e.target.value); setValue(""); setNewValue(""); }}
                  className="w-full bg-white border border-gray-200 rounded-xl px-3 py-2.5 text-sm text-gray-900 outline-none focus:border-blue-400"
                >
                  <option value="">Choose an attribute…</option>
                  {attrs.map((a) => (
                    <option key={a.key} value={a.key}>{a.name || a.key}</option>
                  ))}
                </select>
              </Field>
              {key && (
                <>
                  <Field label="Value">
                    <select
                      value={value}
                      onChange={(e) => { setValue(e.target.value); setNewValue(""); }}
                      className="w-full bg-white border border-gray-200 rounded-xl px-3 py-2.5 text-sm text-gray-900 outline-none focus:border-blue-400"
                    >
                      <option value="">{valuesQuery.isLoading ? "Loading values…" : "Choose a value…"}</option>
                      {values.map((v) => (
                        <option key={v.value} value={v.value}>{v.name || v.value}</option>
                      ))}
                    </select>
                  </Field>
                  {!removing && chosenAttr?.isAdhoc !== false && (
                    <Field label="Or create a new value">
                      <Input
                        value={newValue}
                        onChange={(e) => { setNewValue(e.target.value); if (e.target.value) setValue(""); }}
                        placeholder="New value display name"
                      />
                    </Field>
                  )}
                </>
              )}
              <PrimaryButton onClick={submit} loading={pending} disabled={!canSubmit}>
                {count === 1 && !allowRemove ? "Add" : removing ? `Remove from ${count.toLocaleString()} ${noun}` : `Add to ${count.toLocaleString()} ${noun}`}
              </PrimaryButton>
              <OutlineButton onClick={onClose} disabled={pending} className="mt-2">
                Cancel
              </OutlineButton>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
