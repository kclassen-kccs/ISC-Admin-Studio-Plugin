import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { RotateCcw } from "lucide-react";
import { retryPlan, runBulkRetry } from "../lib/activityRetry";
import { ConfirmModal, Spinner } from "./ui";
import { ResultDialog } from "./ResultDialog";

// Selection over the retryable items of an Activity list. `items` is what's
// loaded; only those with a retry (lib/activityRetry.js) can be selected.
// The selection resets whenever `resetKey` changes (a different filter or
// view is a different list).
export function useRetrySelection(kind, items, context, resetKey) {
  const [selected, setSelected] = useState(() => new Set());
  useEffect(() => { setSelected(new Set()); }, [resetKey]);

  const entries = useMemo(
    () => items.map((item) => ({ item, plan: retryPlan(kind, item, context) })).filter((e) => e.plan.retryable),
    [kind, items, context]
  );
  const retryableIds = useMemo(() => new Set(entries.map((e) => e.item.id)), [entries]);
  const allSelected = entries.length > 0 && entries.every((e) => selected.has(e.item.id));

  return {
    entries,
    retryableIds,
    selected,
    allSelected,
    toggle: (id) =>
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    toggleAll: () => setSelected(allSelected ? new Set() : new Set(entries.map((e) => e.item.id))),
    clear: () => setSelected(new Set()),
  };
}

const plural = (n, one, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

// "Select all" header + the Retry button for the selection. Retrying runs
// oldest first, one operation at a time, each distinct operation once —
// many failures share one retry (every failed change for a person is
// retried by reprocessing that person once).
export function BulkRetryBar({ selection, noun = "event", hasMore }) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [progress, setProgress] = useState(null);
  const [result, setResult] = useState(null);
  const { entries, selected, allSelected, toggleAll, clear } = selection;

  const chosen = useMemo(() => entries.filter((e) => selected.has(e.item.id)), [entries, selected]);
  // What will actually run: distinct operations, grouped by what they do.
  const operations = useMemo(() => {
    const byKey = new Map();
    for (const e of chosen) if (!byKey.has(e.plan.key)) byKey.set(e.plan.key, e.plan);
    const byLabel = new Map();
    for (const plan of byKey.values()) {
      const label = plan.label.replace(/^Retry\s*(—\s*)?/, "");
      byLabel.set(label, (byLabel.get(label) || 0) + 1);
    }
    return { count: byKey.size, lines: [...byLabel.entries()].map(([label, n]) => `${n.toLocaleString()} × ${label}`) };
  }, [chosen]);

  const run = useMutation({
    mutationFn: () => runBulkRetry(chosen, (done, total) => setProgress({ done, total })),
    onSuccess: (r) => {
      setConfirming(false);
      setProgress(null);
      setResult(r);
      clear();
      for (const key of ["source-activity", "identity-activity", "source-aggregation-history"]) {
        queryClient.invalidateQueries({ queryKey: [key] });
      }
    },
    onError: () => { setConfirming(false); setProgress(null); },
  });

  // Keep rendering while there's an outcome to show — the refresh after a
  // run can leave the list empty.
  if (entries.length === 0 && !result) return null;

  const resultMessage = result && [
    `${plural(result.ran.length, "operation")} started, oldest first.`,
    result.covered.length ? `${plural(result.covered.length, `more ${noun}`)} needed no separate retry — the same operation was already run for an older failure.` : null,
    result.failed.length ? `\n${plural(result.failed.length, "operation")} couldn't be started:\n${result.failed.map((f) => `• ${f.plan.label.replace(/^Retry\s*(—\s*)?/, "")}: ${f.error}`).join("\n")}` : null,
    result.ran.length ? "\nOutcomes appear here as new activity in a minute or two." : null,
  ].filter(Boolean).join("\n");

  return (
    <>
      <div className="flex items-center justify-between gap-3 px-4 py-2 flex-wrap">
        <label className="flex items-center gap-2 text-xs text-gray-500">
          <input type="checkbox" checked={allSelected} onChange={toggleAll} className="w-4 h-4 rounded border-gray-300" />
          Select all{hasMore ? " loaded" : ""}
          {selected.size > 0 && <span className="text-gray-400">· {selected.size.toLocaleString()} selected</span>}
        </label>
        <button
          onClick={() => setConfirming(true)}
          disabled={chosen.length === 0 || run.isPending}
          className="inline-flex items-center justify-center gap-1.5 bg-blue-600 hover:bg-blue-700 active:bg-blue-800 disabled:opacity-40 text-white font-semibold text-xs px-3.5 py-2 rounded-lg shadow-sm transition-colors"
        >
          {run.isPending ? <Spinner size={14} className="!text-white" /> : <RotateCcw size={14} />}
          Retry selected{chosen.length ? ` (${chosen.length.toLocaleString()})` : ""}
        </button>
      </div>

      {confirming && (
        <ConfirmModal
          title={`Retry ${plural(chosen.length, `failed ${noun}`)}?`}
          confirmLabel={`Retry ${operations.count.toLocaleString()}`}
          pending={run.isPending}
          progressText={progress ? `${progress.done} of ${progress.total} done…` : undefined}
          onConfirm={() => run.mutate()}
          onCancel={() => !run.isPending && setConfirming(false)}
        >
          {/* As children, not `message` — ConfirmModal's message collapses line breaks. */}
          <p className="text-sm text-gray-600 mb-4 whitespace-pre-wrap">
            {`This runs ${plural(operations.count, "operation")}, oldest failure first, one at a time:\n${operations.lines.join("\n")}\n\n` +
              (operations.count < chosen.length ? "Several of the selected failures share one retry — every failed change for a person is retried by reprocessing that person once.\n\n" : "") +
              "Each is a new operation against the tenant, not a replay. Anything whose cause hasn't been fixed will fail the same way."}
          </p>
        </ConfirmModal>
      )}
      {result && (
        <ResultDialog
          title={result.failed.length ? (result.ran.length ? "Retry finished with errors" : "Nothing could be retried") : "Retry started"}
          success={result.failed.length === 0}
          message={resultMessage}
          onClose={() => setResult(null)}
        />
      )}
    </>
  );
}

// The per-row checkbox, left of a retryable row.
export function RetryCheckbox({ checked, onChange }) {
  return (
    <input
      type="checkbox"
      checked={checked}
      onChange={onChange}
      onClick={(e) => e.stopPropagation()}
      aria-label="Select for retry"
      className="w-4 h-4 rounded border-gray-300 flex-shrink-0 mt-3.5 ml-4"
    />
  );
}
