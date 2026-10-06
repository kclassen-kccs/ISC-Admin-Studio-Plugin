import { useState } from "react";
import { X } from "lucide-react";
import { Field, Input, PrimaryButton, OutlineButton } from "./ui";

// Form-fill dialog for one account record, fields driven entirely by the
// source's own account schema (client/src/pages/SourceEditAccountsPage.jsx)
// rather than hard-coded — every schema attribute gets a text field.
// Multi-valued attributes are edited as a comma-separated list rather than a
// full tag editor, which is enough for hand-editing a flat-file source's
// values without building a second picker UI just for this dialog.
export function SourceAccountFormModal({ schema, record, onSave, onClose, onDiscardNew, pending }) {
  // Everything is edited as plain text — multi-valued attributes are only
  // split on commas at SAVE time. Splitting on every keystroke (the old
  // approach) round-tripped the text through split/join per key press, so
  // a just-typed trailing comma was stripped before it could be seen and a
  // comma could effectively never be entered.
  const [values, setValues] = useState(() => {
    const initial = {};
    for (const attr of schema.attributes) {
      const v = record.attributes[attr.name];
      initial[attr.name] = Array.isArray(v) ? v.join(", ") : v ?? "";
    }
    return initial;
  });

  function setField(name, value) {
    setValues((prev) => ({ ...prev, [name]: value }));
  }

  function handleSave() {
    const out = {};
    for (const attr of schema.attributes) {
      const text = values[attr.name] ?? "";
      out[attr.name] = attr.isMulti ? text.split(",").map((v) => v.trim()).filter(Boolean) : text;
    }
    onSave(out);
  }

  return (
    <div
      className="fixed inset-0 bg-black/30 z-30 flex items-end md:items-center justify-center"
      onClick={(e) => e.target === e.currentTarget && !pending && onClose()}
    >
      <div className="bg-white w-full max-w-lg md:mx-4 rounded-t-2xl md:rounded-2xl shadow-xl max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 pt-5">
          <h2 className="text-base font-semibold text-gray-900">
            {record.isNew ? "New Record" : "Edit Record"}
          </h2>
          <button onClick={onClose} disabled={pending} className="text-gray-400 hover:text-gray-600 disabled:opacity-50">
            <X size={18} />
          </button>
        </div>

        <div className="px-5 pt-3 pb-5">
          {schema.attributes.map((attr) => (
            <Field key={attr.name} label={attr.name + (attr.isMulti ? " (comma-separated)" : "")}>
              <Input
                value={values[attr.name] ?? ""}
                onChange={(e) => setField(attr.name, e.target.value)}
                placeholder={attr.description || attr.name}
              />
            </Field>
          ))}

          <PrimaryButton onClick={handleSave} loading={pending}>
            Save Record
          </PrimaryButton>
          {record.isNew && onDiscardNew ? (
            <OutlineButton onClick={onDiscardNew} disabled={pending} className="mt-2 !border-red-200 !text-red-600 hover:!bg-red-50">
              Discard
            </OutlineButton>
          ) : (
            <OutlineButton onClick={onClose} disabled={pending} className="mt-2">
              Cancel
            </OutlineButton>
          )}
        </div>
      </div>
    </div>
  );
}
