import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { RotateCcw, Ban } from "lucide-react";
import toast from "react-hot-toast";
import { retryPlan } from "../lib/activityRetry";
import { ConfirmModal, Spinner } from "./ui";

// Retry for one failed activity — or, where ISC has no equivalent operation,
// a line saying so and why. What a retry actually runs is decided in
// lib/activityRetry.js; it always goes through a confirm that spells it out,
// because a retry is a new operation against the tenant, not a replay.
// kind: "event" | "accountActivity". context: { sourceId?, identityId? }.
export function RetryAction({ kind, item, context }) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const plan = useMemo(() => retryPlan(kind, item, context), [kind, item, context]);

  const run = useMutation({
    mutationFn: () => plan.run(),
    onSuccess: (message) => {
      toast.success(message, { duration: 6000 });
      setConfirming(false);
      // The retry's outcome lands as new activity / history.
      for (const key of ["source-activity", "identity-activity", "source-aggregation-history"]) {
        queryClient.invalidateQueries({ queryKey: [key] });
      }
    },
    onError: (err) => {
      toast.error(err.response?.data?.messages?.[0]?.text || err.response?.data?.error || err.message, { duration: 8000 });
      setConfirming(false);
    },
  });

  if (!plan.retryable) {
    return (
      <p className="text-[11px] text-gray-500 flex items-start gap-1.5 basis-full">
        <Ban size={12} className="flex-shrink-0 mt-0.5 text-gray-400" />
        <span><span className="font-medium text-gray-600">Not retryable.</span> {plan.reason}</span>
      </p>
    );
  }
  return (
    <>
      {/* Same size and weight as the Explain button it sits beside — filled,
          so it reads as an action rather than a label. */}
      <button
        onClick={() => setConfirming(true)}
        disabled={run.isPending}
        className="inline-flex items-center justify-center gap-1.5 bg-blue-600 hover:bg-blue-700 active:bg-blue-800 disabled:opacity-60 text-white font-semibold text-xs px-3.5 py-2 rounded-lg shadow-sm transition-colors"
      >
        {run.isPending ? <Spinner size={14} className="!text-white" /> : <RotateCcw size={14} />}
        {plan.label}
      </button>
      {confirming && (
        <ConfirmModal
          title={plan.title}
          message={plan.message}
          confirmLabel={plan.confirmLabel}
          danger={plan.danger}
          pending={run.isPending}
          onConfirm={() => run.mutate()}
          onCancel={() => !run.isPending && setConfirming(false)}
        />
      )}
    </>
  );
}
