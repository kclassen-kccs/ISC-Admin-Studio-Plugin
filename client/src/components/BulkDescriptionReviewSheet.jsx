import { useState } from "react";
import { Wand2 } from "lucide-react";
import { PrimaryButton, OutlineButton, Textarea } from "./ui";

// Bulk review sheet — one card per generated suggestion (or per-role error),
// each independently editable and de-selectable, so a bad suggestion for
// one role doesn't block saving the rest. Nothing saves until "Save
// selected" is clicked. Shared by Role Descriptions and the Roles list's
// own "Generate Descriptions" icon.
export function BulkDescriptionReviewSheet({ items, roleById, onClose, onSaveSelected, pending }) {
  const generatedItems = items.filter((it) => !it.error);
  const [selected, setSelected] = useState(new Set(generatedItems.map((it) => it.roleId)));
  const [edits, setEdits] = useState(() => Object.fromEntries(generatedItems.map((it) => [it.roleId, it.description])));

  const toggle = (roleId) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(roleId)) next.delete(roleId);
      else next.add(roleId);
      return next;
    });
  };

  return (
    <div
      className="fixed inset-0 bg-black/30 z-30 flex items-end md:items-center justify-center"
      onClick={(e) => e.target === e.currentTarget && !pending && onClose()}
    >
      <div className="bg-white w-full max-w-lg md:mx-4 rounded-t-2xl md:rounded-2xl shadow-xl p-5 max-h-[85vh] overflow-y-auto flex flex-col">
        <h2 className="text-base font-semibold text-gray-900 mb-1 flex items-center gap-2">
          <Wand2 size={16} className="text-violet-600" />
          Review generated descriptions
        </h2>
        <p className="text-xs text-gray-400 mb-4">
          Nothing is saved until you confirm — uncheck any you don't want, edit any you'd like to tweak.
        </p>

        <div className="flex-1 overflow-y-auto space-y-3 mb-3">
          {items.map((it) => {
            const role = roleById.get(it.roleId);
            if (it.error) {
              return (
                <div key={it.roleId} className="border border-red-100 bg-red-50 rounded-xl px-3 py-2.5">
                  <p className="text-sm font-medium text-gray-900">{role?.name || it.roleId}</p>
                  <p className="text-xs text-red-600 mt-0.5">{it.error}</p>
                </div>
              );
            }
            return (
              <div key={it.roleId} className="border border-gray-100 rounded-xl px-3 py-2.5">
                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selected.has(it.roleId)}
                    onChange={() => toggle(it.roleId)}
                    className="w-4 h-4 mt-0.5 rounded border-gray-300 accent-blue-600 flex-shrink-0"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-gray-900 mb-1">{role?.name || it.roleId}</p>
                    <Textarea
                      value={edits[it.roleId] ?? ""}
                      onChange={(e) => setEdits((prev) => ({ ...prev, [it.roleId]: e.target.value }))}
                    />
                  </div>
                </label>
              </div>
            );
          })}
        </div>

        <div className="flex gap-2">
          <PrimaryButton
            onClick={() => onSaveSelected([...selected].map((roleId) => ({ roleId, description: edits[roleId] })))}
            loading={pending}
            disabled={selected.size === 0}
            className="!w-auto flex-1"
          >
            Save selected ({selected.size})
          </PrimaryButton>
          <OutlineButton onClick={onClose} disabled={pending} className="!w-auto flex-1">Close</OutlineButton>
        </div>
      </div>
    </div>
  );
}
