import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { bulkTagMetadata } from "../lib/sailpoint";
import { TagMetadataModal } from "./TagMetadataModal";
import { ResultDialog } from "./ResultDialog";

// The "Tag Metadata" action of a list's selection bar: add one metadata value
// to — or remove it from — everything selected. Usage:
//   const tag = useBulkTagMetadata({ kind: "roles", noun: "roles", ids: [...selected], names, invalidateKeys, onDone });
//   …actions={[{ icon: Tags, title: `Tag Metadata (${n})`, onClick: tag.open, loading: tag.pending }]}
//   {tag.element}
// `names` (id → display name) only labels failures in the result dialog.
export function useBulkTagMetadata({ kind, noun, ids, names, invalidateKeys = [], onDone }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState(null);

  const run = useMutation({
    mutationFn: (sel) => bulkTagMetadata(kind, { ...sel, ids }),
    onSuccess: (r, sel) => {
      setOpen(false);
      invalidateKeys.forEach((queryKey) => queryClient.invalidateQueries({ queryKey }));
      const label = sel.name || sel.value;
      const verb = r.operation === "remove" ? "Removed" : "Added";
      // Skipped = nothing to do: an add skips what already has the value, a
      // remove skips what doesn't. Neither is a failure.
      const skippedNote = r.skipped ? ` · ${r.skipped.toLocaleString()} ${r.operation === "remove" ? "didn't have it" : "already had it"}` : "";
      if (r.failed.length === 0 && r.done === 0) {
        toast(`Nothing to do — ${r.operation === "remove" ? `none of the ${r.skipped.toLocaleString()} selected ${noun} have` : `all ${r.skipped.toLocaleString()} selected ${noun} already have`} "${label}"`, { duration: 6000 });
      } else if (r.failed.length === 0) {
        toast.success(`${verb} "${label}" ${r.operation === "remove" ? "from" : "to"} ${r.done.toLocaleString()} ${noun}${skippedNote}`, { duration: 6000 });
      } else {
        setResult({
          title: `${verb} "${label}" — ${r.done.toLocaleString()} of ${(r.done + r.failed.length).toLocaleString()}`,
          message:
            `${r.failed.length.toLocaleString()} ${noun} could not be updated${skippedNote}:\n` +
            r.failed.slice(0, 25).map((f) => `• ${names?.get?.(f.id) || f.id}: ${f.error}`).join("\n") +
            (r.failed.length > 25 ? `\n…and ${(r.failed.length - 25).toLocaleString()} more` : ""),
        });
      }
      onDone?.(r);
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message, { duration: 10000 }),
  });

  return {
    open: () => setOpen(true),
    pending: run.isPending,
    element: (
      <>
        {open && (
          <TagMetadataModal count={ids.length} noun={noun} allowRemove pending={run.isPending} onConfirm={(sel) => run.mutate(sel)} onClose={() => setOpen(false)} />
        )}
        {result && <ResultDialog title={result.title} success={false} message={result.message} onClose={() => setResult(null)} />}
      </>
    ),
  };
}
