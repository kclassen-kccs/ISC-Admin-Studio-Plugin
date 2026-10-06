import { useState } from "react";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckSquare, CheckCircle2, XCircle, Clock, ChevronRight, X, ShieldAlert } from "lucide-react";
import {
  listPendingApprovals, listCompletedApprovals,
  approveRequest, rejectRequest,
} from "../lib/sailpoint";
import { TopBar } from "../components/TopBar";
import {
  FilterBar, SkeletonList, EmptyState, ErrorBox, StatusBadge,
  InfoRow, SectionLabel, Textarea, Field,
} from "../components/ui";
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

// ─── SOD violation detail sheet ────────────────────────────────────────────────

function criteriaNames(criteria) {
  return (criteria?.criteriaList || []).map((c) => c.name).filter(Boolean).join(", ") || "—";
}

function SodDetailSheet({ context, onClose }) {
  const result = context?.violationCheckResult;
  const policies = result?.violatedPolicies || [];
  const violationContexts = result?.violationContexts || [];

  return (
    <div className="fixed inset-0 bg-black/30 z-30 flex items-end md:items-center justify-center" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="bg-white w-full max-w-md md:mx-4 rounded-t-2xl md:rounded-2xl shadow-xl max-h-[90vh] flex flex-col">
        <div className="flex justify-center pt-3 pb-1">
          <div className="w-10 h-1 bg-gray-200 rounded-full" />
        </div>
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
          <h2 className="text-base font-semibold text-gray-900 flex items-center gap-2">
            <ShieldAlert size={18} className="text-amber-500" />
            SOD violation
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={20} /></button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4">
          <SectionLabel>Violated policies</SectionLabel>
          {policies.length === 0 && <p className="text-sm text-gray-400 px-1">No policy details available.</p>}
          {policies.map((p) => (
            <div key={p.id} className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 mb-2">
              <p className="text-sm font-medium text-amber-900">{p.name}</p>
            </div>
          ))}

          {violationContexts.length > 0 && (
            <>
              <SectionLabel>Conflicting access</SectionLabel>
              {violationContexts.map((vc, i) => (
                <div key={i} className="bg-gray-50 rounded-xl px-4 py-3 mb-2 space-y-2">
                  {vc.policy?.name && (
                    <p className="text-xs font-medium text-gray-500">{vc.policy.name}</p>
                  )}
                  <div>
                    <p className="text-xs text-gray-400">Has</p>
                    <p className="text-sm text-gray-800">{criteriaNames(vc.conflictingAccessCriteria?.leftCriteria)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-400">Conflicts with</p>
                    <p className="text-sm text-gray-800">{criteriaNames(vc.conflictingAccessCriteria?.rightCriteria)}</p>
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Approval detail page ─────────────────────────────────────────────────────

export function ApprovalDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [comment, setComment] = useState("");
  const [showSod, setShowSod] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ["pending-approval", id],
    queryFn: async () => {
      const list = await listPendingApprovals({ limit: 50 });
      return Array.isArray(list) ? list.find((r) => r.id === id) || null : null;
    },
  });

  const approve = useMutation({
    mutationFn: () => approveRequest(id, comment || "Approved via ISC app"),
    onSuccess: () => {
      toast.success("Request approved ✓");
      queryClient.invalidateQueries(["pending-approvals"]);
      queryClient.invalidateQueries(["pending-approval", id]);
      navigate("/approvals");
    },
    onError: (err) => toast.error(err.response?.data?.messages?.[0]?.text || err.message),
  });

  const reject = useMutation({
    mutationFn: () => rejectRequest(id, comment || "Rejected via ISC app"),
    onSuccess: () => {
      toast.success("Request rejected");
      queryClient.invalidateQueries(["pending-approvals"]);
      navigate("/approvals");
    },
    onError: (err) => toast.error(err.response?.data?.messages?.[0]?.text || err.message),
  });

  const acting = approve.isPending || reject.isPending;

  if (isLoading) {
    return (
      <div className="flex flex-col min-h-screen bg-white">
        <TopBar title="Review request" onBack={() => navigate(-1)} />
        <SkeletonList rows={5} />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex flex-col min-h-screen bg-white">
        <TopBar title="Review request" onBack={() => navigate(-1)} />
        <ErrorBox message={error?.message || "Approval not found or already actioned"} />
      </div>
    );
  }

  const r = data;
  const name = r.name || r.accessRequestId || "Access request";
  const requester = r.requester?.name || "Unknown";
  const requestedFor = r.requestedFor?.name || (typeof r.requestedFor === "string" ? r.requestedFor : "—");

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <TopBar title="Review request" onBack={() => navigate(-1)} />
      <div className="flex-1 overflow-y-auto pb-32">
        {/* Header */}
        <div className="px-4 py-5 border-b border-gray-100">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-lg font-semibold text-gray-900">{name}</h2>
              <p className="text-sm text-gray-500 mt-1">{fmtDate(r.created || r.requestedDate)}</p>
            </div>
            <StatusBadge status="PENDING" />
          </div>
        </div>

        <SectionLabel>Request details</SectionLabel>
        <div className="bg-white border-t border-b border-gray-100 px-4">
          <InfoRow label="Requested by" value={requester} />
          <InfoRow label="Requested for" value={requestedFor} />
          <InfoRow label="Request type" value={r.requestType} />
          <InfoRow label="Request ID" value={r.accessRequestId || r.id} />
        </div>

        {(() => {
          const commentDto = r.requesterComment || r.comment;
          const text = typeof commentDto === "string" ? commentDto : commentDto?.comment;
          if (!text) return null;
          return (
            <>
              <SectionLabel>Justification</SectionLabel>
              <div className="mx-4 bg-gray-50 rounded-xl px-4 py-3">
                <p className="text-sm text-gray-700 leading-relaxed">{text}</p>
              </div>
            </>
          );
        })()}
        )}

        {r.sodViolationContext && (
          <>
            <SectionLabel>SOD notice</SectionLabel>
            <button
              onClick={() => setShowSod(true)}
              className="w-full mx-4 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 flex items-center justify-between gap-2 text-left hover:bg-amber-100 transition-colors"
              style={{ width: "calc(100% - 2rem)" }}
            >
              <p className="text-sm text-amber-800">Potential separation-of-duties conflict detected. View details.</p>
              <ChevronRight size={16} className="text-amber-500 flex-shrink-0" />
            </button>
          </>
        )}

        <div className="px-4 pt-4">
          <Field label="Decision comment (optional)">
            <Textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Add a note to your decision…"
            />
          </Field>
        </div>
      </div>

      {/* Fixed action bar */}
      <div className="sticky bottom-0 bg-white border-t border-gray-200 p-4 grid grid-cols-2 gap-3">
        <button
          onClick={() => approve.mutate()}
          disabled={acting}
          className="flex items-center justify-center gap-2 bg-green-50 text-green-800 border border-green-200 font-semibold text-sm py-3.5 rounded-xl hover:bg-green-100 disabled:opacity-50 transition-colors"
        >
          <CheckCircle2 size={17} />
          {approve.isPending ? "Approving…" : "Approve"}
        </button>
        <button
          onClick={() => reject.mutate()}
          disabled={acting}
          className="flex items-center justify-center gap-2 bg-red-50 text-red-800 border border-red-200 font-semibold text-sm py-3.5 rounded-xl hover:bg-red-100 disabled:opacity-50 transition-colors"
        >
          <XCircle size={17} />
          {reject.isPending ? "Rejecting…" : "Reject"}
        </button>
      </div>

      {showSod && (
        <SodDetailSheet context={r.sodViolationContext} onClose={() => setShowSod(false)} />
      )}
    </div>
  );
}

// ─── Approvals list page ──────────────────────────────────────────────────────

const FILTERS = [
  { label: "Pending", value: "PENDING" },
  { label: "Approved", value: "APPROVED" },
  { label: "Rejected", value: "REJECTED" },
];

function queryFnForStatus(status) {
  // "approved" and "rejected" aren't separate endpoints — both live in the
  // single "completed" bucket, split client-side by the item's "state".
  if (status === "APPROVED" || status === "REJECTED") {
    return () => listCompletedApprovals({ limit: 50 });
  }
  return () => listPendingApprovals({ limit: 30 });
}

export default function ApprovalsPage() {
  // URL-backed (not useState) so it survives navigating to an approval's
  // detail page and clicking Back — that unmounts this page, and a plain
  // useState would silently reset to "PENDING" on remount.
  const [searchParams, setSearchParams] = useSearchParams();
  const filter = searchParams.get("filter") || "PENDING";
  const setFilter = (value) => setSearchParams(value === "PENDING" ? {} : { filter: value }, { replace: true });
  const navigate = useNavigate();

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["pending-approvals", filter],
    queryFn: queryFnForStatus(filter),
  });

  const list = (Array.isArray(data) ? data : [])
    .filter((r) => filter === "PENDING" || (r.state || "").toUpperCase() === filter)
    .sort((a, b) => new Date(b.created || b.requestedDate || 0) - new Date(a.created || a.requestedDate || 0));
  const { page, pager } = usePagedList(list, { noun: "approval", resetKey: String(filter) });

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <TopBar title="Approvals" />
      <div className="flex-1 overflow-y-auto pb-24">
        <FilterBar options={FILTERS} active={filter} onChange={setFilter} />
        {error && <ErrorBox message={error.message} onRetry={refetch} />}
        {isLoading && <SkeletonList rows={5} />}
        {!isLoading && !error && list.length === 0 && (
          <EmptyState
            icon={CheckSquare}
            title={filter === "PENDING" ? "No pending approvals" : `No ${filter.toLowerCase()} approvals`}
            subtitle={filter === "PENDING" ? "You're all caught up" : undefined}
          />
        )}
        {pager}
        {page.map((r) => {
          const name = r.name || r.accessRequestId || "Request";
          const requester = r.requester?.name || "Unknown";
          const date = fmtDate(r.created || r.requestedDate);
          return (
            <div
              key={r.id}
              className="w-full flex items-start gap-3 px-4 py-4 border-b border-gray-100 hover:bg-gray-50 transition-colors"
            >
              <div className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5" style={{ background: filter === "PENDING" ? "#FFFBEB" : filter === "APPROVED" ? "#F0FDF4" : "#FEF2F2" }}>
                {filter === "APPROVED" ? <CheckCircle2 size={16} className="text-green-500" />
                 : filter === "REJECTED" ? <XCircle size={16} className="text-red-400" />
                 : <Clock size={16} className="text-amber-500" />}
              </div>
              <button
                onClick={() => filter === "PENDING" && navigate(`/approvals/${r.id}`)}
                className="flex-1 min-w-0 text-left"
              >
                <p className="text-sm font-medium text-gray-900 truncate">{name}</p>
                <p className="text-xs text-gray-500 mt-0.5">From {requester} · {date}</p>
              </button>
              {filter === "PENDING" && (
                <button onClick={() => navigate(`/approvals/${r.id}`)} className="mt-0.5 flex-shrink-0">
                  <StatusBadge status="PENDING" />
                </button>
              )}
            </div>
          );
        })}
        {pager}
      </div>
    </div>
  );
}
