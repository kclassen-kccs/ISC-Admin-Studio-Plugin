import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ClipboardList, ClipboardCheck, ChevronRight, CheckCircle2 } from "lucide-react";
import { listWorkItems, getWorkItem, completeWorkItem } from "../lib/sailpoint";
import { TopBar } from "../components/TopBar";
import { SkeletonList, EmptyState, ErrorBox, InfoRow, SectionLabel } from "../components/ui";
import toast from "react-hot-toast";
import { usePagedList } from "../hooks/usePagedList";

function fmtDate(d) {
  if (!d) return "—";
  try {
    return new Date(d).toLocaleString(undefined, {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    });
  } catch { return d; }
}

// A work item's approvalItems are the raw field-level changes an admin needs
// to make by hand in the target system (including any generated password) —
// that's genuinely what SailPoint hands the item owner to act on, not
// something this app is exposing carelessly.
function ApprovalItemRow({ item }) {
  return (
    <div className="bg-gray-50 rounded-lg px-3 py-2.5 mb-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium text-gray-900">{item.application || "—"}</p>
        {item.operation && (
          <span className="text-[10px] font-medium text-blue-700 bg-blue-50 border border-blue-100 px-1.5 py-0.5 rounded-full flex-shrink-0">
            {item.operation}
          </span>
        )}
      </div>
      {(item.name || item.value) && (
        <p className="text-xs text-gray-600 mt-1 break-all">
          {item.name && <span className="font-medium">{item.name}: </span>}
          {item.value ?? "—"}
        </p>
      )}
      {item.account && <p className="text-xs text-gray-400 mt-0.5">Account: {item.account}</p>}
    </div>
  );
}

export function TaskDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isLoading, error } = useQuery({
    queryKey: ["work-item", id],
    queryFn: () => getWorkItem(id),
  });

  const complete = useMutation({
    mutationFn: () => completeWorkItem(id),
    onSuccess: () => {
      toast.success("Task completed");
      queryClient.invalidateQueries({ queryKey: ["work-items"] });
      queryClient.invalidateQueries({ queryKey: ["pending-work-items-count"] });
      navigate("/tasks");
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  if (isLoading) {
    return (
      <div className="flex flex-col min-h-screen bg-white">
        <TopBar title="Task" onBack={() => navigate(-1)} />
        <SkeletonList rows={5} />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex flex-col min-h-screen bg-white">
        <TopBar title="Task" onBack={() => navigate(-1)} />
        <ErrorBox message={error?.message || "Task not found"} />
      </div>
    );
  }

  const t = data;
  const items = t.approvalItems || [];

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <TopBar title="Task" onBack={() => navigate(-1)} />
      <div className="flex-1 overflow-y-auto pb-32">
        <div className="px-4 py-5 border-b border-gray-100">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-full bg-amber-50 flex items-center justify-center flex-shrink-0">
              <ClipboardList size={18} className="text-amber-600" />
            </div>
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-gray-900">{t.name || t.type || "Manual task"}</h2>
              {t.description && <p className="text-sm text-gray-600 mt-1">{t.description}</p>}
            </div>
          </div>
        </div>

        <SectionLabel>Details</SectionLabel>
        <div className="bg-white border-t border-b border-gray-100 px-4">
          <InfoRow label="Type" value={t.type} />
          <InfoRow label="State" value={t.state} />
          <InfoRow label="Requested by" value={t.requesterDisplayName} />
          <InfoRow label="Created" value={fmtDate(t.created)} />
          <InfoRow label="Task ID" value={t.id} />
        </div>

        {items.length > 0 && (
          <>
            <SectionLabel>Changes needed ({items.length})</SectionLabel>
            <div className="px-4">
              {items.map((item) => <ApprovalItemRow key={item.id} item={item} />)}
            </div>
          </>
        )}

      </div>

      <div className="sticky bottom-0 bg-white border-t border-gray-200 p-4">
        <button
          onClick={() => complete.mutate()}
          disabled={complete.isPending}
          className="w-full flex items-center justify-center gap-2 bg-emerald-600 text-white font-semibold text-sm py-3.5 rounded-xl hover:bg-emerald-700 disabled:opacity-50 transition-colors"
        >
          <CheckCircle2 size={17} />
          {complete.isPending ? "Completing…" : "Mark Complete"}
        </button>
      </div>
    </div>
  );
}

export default function TasksPage() {
  const navigate = useNavigate();

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["work-items"],
    queryFn: listWorkItems,
  });

  const list = (Array.isArray(data) ? data : [])
    .sort((a, b) => new Date(b.created || 0) - new Date(a.created || 0));
  const { page, pager } = usePagedList(list, { noun: "task" });

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <TopBar title="Tasks" />
      <div className="flex-1 overflow-y-auto pb-24">
        {error && <ErrorBox message={error.message} onRetry={refetch} />}
        {isLoading && <SkeletonList rows={5} />}
        {!isLoading && !error && list.length === 0 && (
          <EmptyState icon={ClipboardCheck} title="No pending tasks" subtitle="You're all caught up" />
        )}
        {pager}
        {page.map((t) => (
          <button
            key={t.id}
            onClick={() => navigate(`/tasks/${t.id}`)}
            className="w-full flex items-center gap-3 px-4 py-3.5 border-b border-gray-100 hover:bg-gray-50 text-left transition-colors"
          >
            <div className="w-10 h-10 rounded-full bg-amber-50 flex items-center justify-center flex-shrink-0">
              <ClipboardList size={16} className="text-amber-600" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-gray-900 truncate">{t.name || t.type || "Manual task"}</p>
              <p className="text-xs text-gray-500 mt-0.5 truncate">
                {t.description || "—"} · {fmtDate(t.created)}
              </p>
            </div>
            <ChevronRight size={16} className="text-gray-300 flex-shrink-0" />
          </button>
        ))}
        {pager}
      </div>
    </div>
  );
}
