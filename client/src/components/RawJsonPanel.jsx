import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Pencil } from "lucide-react";
import toast from "react-hot-toast";
import { patchObjectJson } from "../lib/sailpoint";
import { IconButton, PrimaryButton, OutlineButton } from "./ui";
import { JSON_EDITOR_STYLE, highlightJson, escapeHtml, jsonParseError } from "./JsonEditor";
import { JsonEditTabs } from "./JsonTree";

// Fields ISC never accepts back on any object — everything else is left to
// the diff: only fields the user actually CHANGED are sent, so untouched
// read-only fields never appear in the patch at all.
const NEVER_PATCH = new Set(["id", "created", "modified", "creator", "modifiedBy", "synced", "hasCounterpart"]);

// Top-level diff → RFC 6902 ops. Changed keys become replace (or add, for
// keys the original didn't have); removed keys become remove. Exported so
// other raw-JSON editors (the source Datasets tab) produce the same patch
// shape; `neverPatch` lets them pass their own server-owned key set.
export function buildPatchOps(original, edited, neverPatch = NEVER_PATCH) {
  const ops = [];
  for (const key of Object.keys(edited)) {
    if (neverPatch.has(key)) continue;
    if (!(key in original)) ops.push({ op: "add", path: `/${key}`, value: edited[key] });
    else if (JSON.stringify(original[key]) !== JSON.stringify(edited[key])) {
      ops.push({ op: "replace", path: `/${key}`, value: edited[key] });
    }
  }
  for (const key of Object.keys(original)) {
    if (!neverPatch.has(key) && !(key in edited)) ops.push({ op: "remove", path: `/${key}` });
  }
  return ops;
}

// The shared "raw JSON" tab body — same view/edit contract as the Workflow
// and Transform JSON tabs: highlighted read view, pencil to edit in the
// validated overlay editor, Save dimmed while invalid. Saving sends only
// the changed top-level fields as JSON-Patch ops; ISC's own error surfaces
// if an edited field turns out to be unpatchable for this object type.
// initialEditing opens straight into the editor — for a caller that jumped
// here from an "Edit JSON" action elsewhere on the page, where landing on
// the read view and having to click the pencil again would be a wasted step.
// readOnly: view only, no Edit button — for records ISC never lets you
// change (e.g. audit events).
export function RawJsonPanel({ data, resource, objectId, invalidateKeys = [], initialEditing = false, readOnly = false }) {
  const queryClient = useQueryClient();
  const pretty = useMemo(() => JSON.stringify(data, null, 2), [data]);
  const [editing, setEditing] = useState(!!initialEditing && !readOnly);
  const [text, setText] = useState(pretty);
  const parseError = editing ? jsonParseError(text) : null;

  const save = useMutation({
    mutationFn: () => {
      const edited = JSON.parse(text);
      const ops = buildPatchOps(data, edited);
      if (ops.length === 0) return Promise.resolve(null);
      return patchObjectJson(resource, objectId, ops);
    },
    onSuccess: (result) => {
      toast.success(result === null ? "No changes to save" : "Saved");
      setEditing(false);
      for (const key of invalidateKeys) queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  return (
    <div className="px-4 py-4">
      <div className="flex items-center justify-between mb-3 gap-3">
        <p className="text-xs text-gray-500">
          {editing
            ? "Only fields you change are sent (as JSON-Patch); read-only fields are ignored."
            : readOnly ? "The record as ISC returns it (read-only)." : "The object's full definition as ISC returns it."}
        </p>
        {!editing && !readOnly ? (
          <IconButton icon={Pencil} title="Edit JSON" onClick={() => { setText(pretty); setEditing(true); }} />
        ) : null}
      </div>

      {!editing ? (
        <pre
          className="border border-gray-200 rounded-xl overflow-auto text-gray-800 bg-gray-50"
          style={JSON_EDITOR_STYLE}
          dangerouslySetInnerHTML={{ __html: highlightJson(escapeHtml(pretty)) }}
        />
      ) : (
        <>
          <JsonEditTabs
            text={text}
            onChange={setText}
            readOnlyKeys={[...NEVER_PATCH]}
            minHeight="240px"
            /* Names the printout. Derived here rather than threaded through
               every RawJsonPanel call site — `resource` and the object's own
               name are already both in scope. */
            title={`${data?.name || data?.displayName || objectId} — ${resource}`}
          />
          <div className="flex gap-2 mt-3">
            <PrimaryButton onClick={() => save.mutate()} loading={save.isPending} disabled={!!parseError} className="!w-auto flex-1">
              Save
            </PrimaryButton>
            <OutlineButton onClick={() => setEditing(false)} disabled={save.isPending} className="!w-auto flex-1">
              Cancel
            </OutlineButton>
          </div>
        </>
      )}
    </div>
  );
}
