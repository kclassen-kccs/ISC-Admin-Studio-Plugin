import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { UploadCloud, CheckCircle2, Clock } from "lucide-react";
import toast from "react-hot-toast";
import { applyRoleChanges, getApplyRoleChangesStatus } from "../lib/sailpoint";
import { PrimaryButton, OutlineButton, Spinner } from "./ui";

// Confirm, then start and track a tenant-wide Role Propagation run, all in
// one dialog — replaces the old dedicated Apply in ISC screen (see
// RolesPage's Apply Changes icon).
export function ApplyChangesModal({ onClose }) {
  const [propagationId, setPropagationId] = useState(null);

  const apply = useMutation({
    mutationFn: applyRoleChanges,
    onSuccess: (result) => {
      setPropagationId(result.rolePropagationId);
      toast.success("Applying role changes across the tenant");
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const statusQuery = useQuery({
    queryKey: ["role-propagation-status", propagationId],
    queryFn: () => getApplyRoleChangesStatus(propagationId),
    enabled: !!propagationId,
    refetchInterval: (query) => (query.state.data?.status === "RUNNING" ? 3000 : false),
  });

  const status = statusQuery.data;
  const running = status?.status === "RUNNING";
  const started = !!propagationId;

  return (
    <div
      className="fixed inset-0 bg-black/30 z-30 flex items-end md:items-center justify-center"
      onClick={(e) => e.target === e.currentTarget && !apply.isPending && !running && onClose()}
    >
      <div className="bg-white w-full max-w-md md:mx-4 rounded-t-2xl md:rounded-2xl shadow-xl p-5">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-10 h-10 rounded-full bg-violet-50 flex items-center justify-center flex-shrink-0">
            <UploadCloud size={18} className="text-violet-600" />
          </div>
          <h2 className="text-base font-semibold text-gray-900">Apply role changes tenant-wide?</h2>
        </div>

        {!started ? (
          <>
            <p className="text-sm text-gray-600 mb-4 leading-relaxed">
              This starts SailPoint's Role Propagation job, re-evaluating who matches every role
              and dimension and provisioning/revoking access to match. It runs across the whole
              tenant and can't be undone once started.
            </p>
            <div className="flex gap-2">
              <PrimaryButton onClick={() => apply.mutate()} loading={apply.isPending}>
                <UploadCloud size={16} />
                Apply Changes
              </PrimaryButton>
              <OutlineButton onClick={onClose} disabled={apply.isPending}>
                Cancel
              </OutlineButton>
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2 mb-2">
              {running ? <Spinner size={16} /> : <CheckCircle2 size={16} className="text-emerald-600" />}
              <p className="text-sm font-medium text-gray-900">
                {running ? "Propagating role changes…" : `Propagation ${(status?.status || "").toLowerCase()}`}
              </p>
            </div>
            {status?.executionStage && (
              <p className="text-xs text-gray-500 mb-1">Stage: {status.executionStage}</p>
            )}
            {status?.launched && (
              <p className="text-xs text-gray-400 flex items-center gap-1 mb-4">
                <Clock size={12} />
                Started {new Date(status.launched).toLocaleString()}
                {status.launchedBy?.name && ` by ${status.launchedBy.name}`}
              </p>
            )}
            <OutlineButton onClick={onClose}>Close</OutlineButton>
          </>
        )}
      </div>
    </div>
  );
}
