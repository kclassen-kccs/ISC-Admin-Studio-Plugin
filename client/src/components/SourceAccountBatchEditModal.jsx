import { useState } from "react";
import { X } from "lucide-react";
import { Field, Input, PrimaryButton, OutlineButton } from "./ui";

// Batch edit for the selected records of a Delimited File / Generic source
// (client/src/pages/SourceEditAccountsPage.jsx) — the same schema-driven
// form as SourceAccountFormModal, but every field starts EMPTY and means
// "leave alone": only a field with a value typed in is set, to that same
// value, on every selected record. A field's Remove toggle instead blanks
// that field on every selected record (an empty cell in the rebuilt CSV,
// which is how a flat-file source says "no value"). Everything else on each
// record is untouched.
//
// The schema's identity attribute is locked: it's the column ISC correlates
// uploaded rows to existing accounts by, so one shared value would collapse
// the selection into colliding rows and a blank one would orphan them.
export function SourceAccountBatchEditModal({ schema, identityAttribute, count, onApply, onClose }) {
  const [values, setValues] = useState({});
  const [removing, setRemoving] = useState(() => new Set());

  function setField(name, value) {
    setValues((prev) => ({ ...prev, [name]: value }));
  }

  function toggleRemove(name) {
    setRemoving((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  const editable = schema.attributes.filter((a) => a.name !== identityAttribute);
  const setNames = editable.filter((a) => !removing.has(a.name) && (values[a.name] ?? "").trim() !== "").map((a) => a.name);
  const removeNames = editable.filter((a) => removing.has(a.name)).map((a) => a.name);
  const changeCount = setNames.length + removeNames.length;

  // Multi-valued attributes are typed comma-separated and split at apply
  // time, same convention (and same reason) as SourceAccountFormModal.
  function handleApply() {
    const changes = {};
    for (const attr of editable) {
      if (removing.has(attr.name)) {
        changes[attr.name] = attr.isMulti ? [] : "";
      } else {
        const text = values[attr.name] ?? "";
        if (text.trim() === "") continue;
        changes[attr.name] = attr.isMulti ? text.split(",").map((v) => v.trim()).filter(Boolean) : text;
      }
    }
    onApply(changes);
  }

  return (
    <div
      className="fixed inset-0 bg-black/30 z-30 flex items-end md:items-center justify-center"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-white w-full max-w-lg md:mx-4 rounded-t-2xl md:rounded-2xl shadow-xl max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 pt-5">
          <h2 className="text-base font-semibold text-gray-900">
            Edit {count} record{count === 1 ? "" : "s"}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X size={18} />
          </button>
        </div>

        <div className="px-5 pt-2 pb-5">
          <p className="text-xs text-gray-500 mb-3">
            Anything you type is set on every selected record. Fields left blank are not changed. Select Remove to clear a
            field on every selected record instead. This changes this edit session only, until you Save &amp; Run Aggregation.
          </p>

          {schema.attributes.map((attr) => {
            const locked = attr.name === identityAttribute;
            const isRemoving = removing.has(attr.name);
            return (
              <Field key={attr.name} label={attr.name + (attr.isMulti ? " (comma-separated)" : "")}>
                <div className="flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <Input
                      value={isRemoving || locked ? "" : values[attr.name] ?? ""}
                      onChange={(e) => setField(attr.name, e.target.value)}
                      disabled={isRemoving || locked}
                      placeholder={locked ? "Identity column — edit one record at a time" : isRemoving ? "Will be cleared" : "Leave blank to keep each record's value"}
                    />
                  </div>
                  {!locked && (
                    <label className={`flex items-center gap-1.5 text-xs flex-shrink-0 cursor-pointer ${isRemoving ? "text-red-600 font-medium" : "text-gray-500"}`}>
                      <input
                        type="checkbox"
                        checked={isRemoving}
                        onChange={() => toggleRemove(attr.name)}
                        aria-label={`Remove ${attr.name} from every selected record`}
                        className="w-4 h-4 rounded border-gray-300"
                      />
                      Remove
                    </label>
                  )}
                </div>
              </Field>
            );
          })}

          <p className="text-xs text-gray-500 mt-1 mb-3">
            {changeCount === 0
              ? "Nothing to apply yet."
              : [
                  setNames.length > 0 && `Set: ${setNames.join(", ")}`,
                  removeNames.length > 0 && `Clear: ${removeNames.join(", ")}`,
                ].filter(Boolean).join(" · ")}
          </p>

          <PrimaryButton onClick={handleApply} disabled={changeCount === 0}>
            Apply to {count} record{count === 1 ? "" : "s"}
          </PrimaryButton>
          <OutlineButton onClick={onClose} className="mt-2">
            Cancel
          </OutlineButton>
        </div>
      </div>
    </div>
  );
}
