import { useState, useMemo } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { PencilLine, ArrowRight, X } from "lucide-react";
import toast from "react-hot-toast";
import { updateRole } from "../lib/sailpoint";
import { PrimaryButton, OutlineButton, Field, Input } from "./ui";

// Applies an old->new prefix/suffix swap to one role name. A non-empty
// old prefix/suffix must actually match, or the role is left out of the
// batch entirely (returns null) rather than guessing at a partial rename.
// An empty old prefix/suffix with a non-empty new one just adds it (lets
// this double as "add a prefix/suffix to everything matched", not only
// "replace an existing one").
function computeNewName(name, { oldPrefix, newPrefix, oldSuffix, newSuffix }) {
  if (oldPrefix && !name.startsWith(oldPrefix)) return null;
  if (oldSuffix && !name.endsWith(oldSuffix)) return null;
  const start = oldPrefix ? oldPrefix.length : 0;
  const end = oldSuffix ? name.length - oldSuffix.length : name.length;
  if (start > end) return null; // prefix/suffix overlap on a short name
  const core = name.slice(start, end);
  return `${newPrefix || ""}${core}${newSuffix || ""}`;
}

// Bulk rename by prefix/suffix pattern, applied to whatever roles are
// selected on the Roles list — no search or selection of its own, unlike
// the old dedicated Role Rename screen this replaced.
export function RoleRenameModal({ roles, onClose }) {
  const queryClient = useQueryClient();
  const [oldPrefix, setOldPrefix] = useState("");
  const [newPrefix, setNewPrefix] = useState("");
  const [oldSuffix, setOldSuffix] = useState("");
  const [newSuffix, setNewSuffix] = useState("");
  const [preview, setPreview] = useState(null); // [{id, name, newName}] | null
  const [selected, setSelected] = useState(new Set());

  const hasPattern = !!(oldPrefix || newPrefix || oldSuffix || newSuffix);

  function handlePreview() {
    const rows = roles
      .map((r) => ({ id: r.id, name: r.name, newName: computeNewName(r.name, { oldPrefix, newPrefix, oldSuffix, newSuffix }) }))
      .filter((r) => r.newName != null && r.newName !== r.name);
    setPreview(rows);
    setSelected(new Set(rows.map((r) => r.id)));
    if (rows.length === 0) toast("No role names would change with this pattern");
  }

  const toggle = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleAll = () => {
    setSelected((prev) => (prev.size === preview.length ? new Set() : new Set(preview.map((r) => r.id))));
  };

  const applyRename = useMutation({
    mutationFn: (rows) => Promise.all(rows.map((r) => updateRole(r.id, { name: r.newName }))),
    onSuccess: (_result, rows) => {
      toast.success(`${rows.length} role${rows.length === 1 ? "" : "s"} renamed`);
      queryClient.invalidateQueries({ queryKey: ["roles"] });
      onClose();
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const selectedRows = useMemo(
    () => (preview || []).filter((r) => selected.has(r.id)),
    [preview, selected]
  );

  return (
    <div
      className="fixed inset-0 bg-black/30 z-30 flex items-end md:items-center justify-center"
      onClick={(e) => e.target === e.currentTarget && !applyRename.isPending && onClose()}
    >
      <div className="bg-white w-full max-w-lg md:mx-4 rounded-t-2xl md:rounded-2xl shadow-xl max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 pt-5">
          <h2 className="text-base font-semibold text-gray-900 flex items-center gap-2">
            <PencilLine size={16} className="text-gray-500" />
            Rename {roles.length} role{roles.length === 1 ? "" : "s"} selected
          </h2>
          <button onClick={onClose} disabled={applyRename.isPending} className="text-gray-400 hover:text-gray-600 disabled:opacity-50">
            <X size={18} />
          </button>
        </div>

        <div className="px-5 pt-3 pb-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Old prefix">
              <Input value={oldPrefix} onChange={(e) => setOldPrefix(e.target.value)} placeholder="e.g. Draft " />
            </Field>
            <Field label="New prefix">
              <Input value={newPrefix} onChange={(e) => setNewPrefix(e.target.value)} placeholder="Blank removes it" />
            </Field>
            <Field label="Old suffix">
              <Input value={oldSuffix} onChange={(e) => setOldSuffix(e.target.value)} placeholder="e.g.  (Draft)" />
            </Field>
            <Field label="New suffix">
              <Input value={newSuffix} onChange={(e) => setNewSuffix(e.target.value)} placeholder="Blank removes it" />
            </Field>
          </div>
          <p className="text-xs text-gray-400">
            A role only changes if it actually has the old prefix/suffix — leave an "old" field blank to add its
            "new" counterpart to every role selected instead of replacing something.
          </p>
          <PrimaryButton onClick={handlePreview} disabled={!hasPattern} className="!w-auto">
            <PencilLine size={16} />
            Preview changes
          </PrimaryButton>
        </div>

        {/* Every selected role, listed up front so it's clear what this
            will apply to before a pattern is even entered — capped at
            10 rows, since this is just a "here's what's in scope" glance,
            not something that needs to be individually reviewed here (the
            actual computed renames get their own checkbox list below,
            uncapped, once a pattern is entered). */}
        {!preview && (
          <div className="px-5 pb-5">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
              Roles selected ({roles.length})
            </p>
            <div className="border border-gray-100 rounded-xl overflow-hidden">
              {roles.slice(0, 10).map((r, i) => (
                <div
                  key={r.id}
                  className={`px-3 py-2.5 text-sm text-gray-700 ${i < Math.min(roles.length, 10) - 1 ? "border-b border-gray-100" : ""}`}
                >
                  {r.name}
                </div>
              ))}
            </div>
            {roles.length > 10 && (
              <p className="text-xs text-gray-400 mt-1.5">+ {roles.length - 10} more</p>
            )}
          </div>
        )}

        {preview && (
          <div className="px-5 pb-5">
            <div className="flex items-center justify-between mb-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={preview.length > 0 && selected.size === preview.length}
                  onChange={toggleAll}
                  className="w-4 h-4 rounded border-gray-300 accent-blue-600"
                />
                <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                  Changes ({preview.length})
                </span>
              </label>
            </div>

            {preview.length === 0 ? (
              <p className="text-sm text-gray-400 py-4">No role names match this pattern.</p>
            ) : (
              <div className="border border-gray-100 rounded-xl overflow-hidden">
                {preview.map((r, i) => (
                  <label
                    key={r.id}
                    className={`flex items-center gap-3 px-3 py-2.5 cursor-pointer ${i < preview.length - 1 ? "border-b border-gray-100" : ""}`}
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(r.id)}
                      onChange={() => toggle(r.id)}
                      className="w-4 h-4 rounded border-gray-300 accent-blue-600 flex-shrink-0"
                    />
                    <div className="min-w-0 flex-1 flex items-center gap-2 text-sm">
                      <span className="text-gray-500 truncate">{r.name}</span>
                      <ArrowRight size={13} className="text-gray-300 flex-shrink-0" />
                      <span className="text-gray-900 font-medium truncate">{r.newName}</span>
                    </div>
                  </label>
                ))}
              </div>
            )}

            <div className="flex gap-2 mt-4">
              <PrimaryButton
                onClick={() => applyRename.mutate(selectedRows)}
                loading={applyRename.isPending}
                disabled={selectedRows.length === 0}
                className="!w-auto flex-1"
              >
                Apply rename ({selectedRows.length})
              </PrimaryButton>
              <OutlineButton onClick={() => setPreview(null)} disabled={applyRename.isPending} className="!w-auto flex-1">
                Cancel
              </OutlineButton>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
