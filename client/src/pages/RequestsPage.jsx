import { useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Send, Plus, Clock, CheckCircle2, XCircle, X, ChevronRight } from "lucide-react";
import {
  listAccessRequests, submitAccessRequest,
  listRoles, listAccessProfiles, listIdentities,
} from "../lib/sailpoint";
import { useAuth } from "../hooks/useAuth";
import { TopBar } from "../components/TopBar";
import {
  FilterBar, SkeletonList, EmptyState, ErrorBox, StatusBadge, InfoRow,
  SectionLabel, Field, Select, Textarea, PrimaryButton, SearchBar,
} from "../components/ui";
import toast from "react-hot-toast";
import { usePagedList } from "../hooks/usePagedList";

function fmtDate(d) {
  if (!d) return "";
  try { return new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric" }); }
  catch { return ""; }
}

function fmtDateTime(d) {
  if (!d) return "";
  try { return new Date(d).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" }); }
  catch { return ""; }
}

function labelizeKey(key) {
  return key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/^./, (c) => c.toUpperCase());
}

// ─── Request detail sheet ───────────────────────────────────────────────────────

const REQUEST_SKIP_KEYS = new Set([
  "id", "name", "type", "state", "requestType", "created", "modified",
  "approvalDetails", "approvalIds", "errorMessages", "manualWorkItemDetails",
  "cancelledRequestDetails",
]);

function RequestDetailSheet({ request, onClose }) {
  const r = request;
  const extraFields = Object.entries(r).filter(
    ([key, value]) =>
      value != null && value !== "" &&
      typeof value !== "object" &&
      !REQUEST_SKIP_KEYS.has(key)
  );

  return (
    <div className="fixed inset-0 bg-black/30 z-30 flex items-end md:items-center justify-center" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="bg-white w-full max-w-md md:mx-4 rounded-t-2xl md:rounded-2xl shadow-xl max-h-[90vh] flex flex-col">
        <div className="flex justify-center pt-3 pb-1">
          <div className="w-10 h-1 bg-gray-200 rounded-full" />
        </div>
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
          <h2 className="text-base font-semibold text-gray-900">Request details</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={20} /></button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4">
          <h3 className="text-base font-semibold text-gray-900 mb-3">{r.name || r.id}</h3>
          <div className="border border-gray-100 rounded-xl overflow-hidden">
            <InfoRow label="Type" value={r.type} />
            <InfoRow label="Request type" value={r.requestType} />
            <InfoRow label="State" value={r.state} />
            <InfoRow label="Created" value={fmtDateTime(r.created)} />
            <InfoRow label="Modified" value={fmtDateTime(r.modified)} />
            {extraFields.map(([key, value]) => (
              <InfoRow key={key} label={labelizeKey(key)} value={String(value)} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── New Request Sheet ────────────────────────────────────────────────────────

function NewRequestSheet({ onClose }) {
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const [accessType, setAccessType] = useState("ACCESS_PROFILE");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(null);
  const [justification, setJustification] = useState("");
  const [beneficiarySearch, setBeneficiarySearch] = useState("");
  // Default to the signed-in user so a self-request needs no searching.
  const [beneficiaries, setBeneficiaries] = useState(() =>
    session?.identity
      ? [{ id: session.identity.id, name: session.identity.username }]
      : []
  );

  const beneficiaryQuery = useQuery({
    queryKey: ["identities", beneficiarySearch],
    queryFn: () => listIdentities({ limit: 15, query: beneficiarySearch }),
    enabled: beneficiarySearch.length > 0,
  });
  const beneficiaryResults = (Array.isArray(beneficiaryQuery.data) ? beneficiaryQuery.data : [])
    .filter((idn) => !beneficiaries.some((b) => b.id === idn.id));

  function addBeneficiary(idn) {
    setBeneficiaries((prev) => [...prev, idn]);
    setBeneficiarySearch("");
  }

  function removeBeneficiary(idnId) {
    setBeneficiaries((prev) => prev.filter((b) => b.id !== idnId));
  }

  const roles = useQuery({
    queryKey: ["roles", search],
    queryFn: () => listRoles({ limit: 40, query: search || undefined }),
    enabled: accessType === "ROLE",
  });

  const aps = useQuery({
    queryKey: ["access-profiles", search],
    queryFn: () => listAccessProfiles({ limit: 40, query: search || undefined }),
    enabled: accessType === "ACCESS_PROFILE",
  });

  const items = Array.isArray(accessType === "ROLE" ? roles.data : aps.data)
    ? (accessType === "ROLE" ? roles.data : aps.data)
    : [];
  const loading = accessType === "ROLE" ? roles.isLoading : aps.isLoading;

  const mutation = useMutation({
    mutationFn: () =>
      submitAccessRequest({
        requestedFor: beneficiaries.map((b) => b.id),
        itemId: selected.id,
        itemType: accessType,
        comment: justification,
      }),
    onSuccess: () => {
      toast.success("Request submitted");
      queryClient.invalidateQueries(["access-requests"]);
      onClose();
    },
    onError: (err) => {
      toast.error(err.response?.data?.messages?.[0]?.text || err.message);
    },
  });

  function handleSubmit() {
    if (beneficiaries.length === 0) { toast.error("Select who this request is for"); return; }
    if (!selected) { toast.error("Select an item to request"); return; }
    if (!justification.trim()) { toast.error("Justification is required"); return; }
    mutation.mutate();
  }

  return (
    <div className="fixed inset-0 bg-black/30 z-30 flex items-end md:items-center justify-center" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="bg-white w-full max-w-md md:mx-4 rounded-t-2xl md:rounded-2xl shadow-xl max-h-[90vh] flex flex-col">
        {/* Handle */}
        <div className="flex justify-center pt-3 pb-1">
          <div className="w-10 h-1 bg-gray-200 rounded-full" />
        </div>
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
          <h2 className="text-base font-semibold text-gray-900">New access request</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={20} /></button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4">
          <div className="mb-4">
            <p className="text-xs font-medium text-gray-500 mb-2">Who is this request for?</p>
            {beneficiaries.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-2">
                {beneficiaries.map((b) => (
                  <div key={b.id} className="flex items-center gap-1.5 bg-blue-50 border border-blue-200 rounded-full pl-3 pr-1.5 py-1">
                    <span className="text-sm font-medium text-blue-800">{b.name}</span>
                    <button onClick={() => removeBeneficiary(b.id)} className="text-blue-400 hover:text-blue-600">
                      <X size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <SearchBar value={beneficiarySearch} onChange={setBeneficiarySearch} placeholder="Search by name, email, or username…" />
            {beneficiarySearch.length > 0 && (
              <div className="border border-gray-200 rounded-xl overflow-hidden max-h-48 overflow-y-auto mt-2">
                {beneficiaryQuery.isLoading && <div className="p-4 text-sm text-gray-400 text-center">Loading…</div>}
                {!beneficiaryQuery.isLoading && beneficiaryResults.length === 0 && (
                  <div className="p-4 text-sm text-gray-400 text-center">No identities found</div>
                )}
                {beneficiaryResults.map((idn) => (
                  <button
                    key={idn.id}
                    onClick={() => addBeneficiary(idn)}
                    className="w-full text-left px-4 py-3 border-b border-gray-100 last:border-0 hover:bg-gray-50 transition-colors"
                  >
                    <p className="text-sm font-medium text-gray-900 truncate">{idn.name}</p>
                    {(idn.alias || idn.email) && (
                      <p className="text-xs text-gray-500 mt-0.5 truncate">{idn.alias || idn.email}</p>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

          <Field label="Access type">
            <Select value={accessType} onChange={(e) => { setAccessType(e.target.value); setSelected(null); setSearch(""); }}>
              <option value="ACCESS_PROFILE">Access profile</option>
              <option value="ROLE">Role</option>
            </Select>
          </Field>

          {selected ? (
            <div className="mb-4 bg-blue-50 border border-blue-200 rounded-xl px-3 py-2.5 flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-blue-800">{selected.name}</p>
                <p className="text-xs text-blue-600 mt-0.5">{accessType === "ROLE" ? "Role" : "Access profile"}</p>
              </div>
              <button onClick={() => setSelected(null)} className="text-blue-400 hover:text-blue-600 ml-2">
                <X size={16} />
              </button>
            </div>
          ) : (
            <>
              <p className="text-xs font-medium text-gray-500 mb-2">Select item</p>
              <SearchBar value={search} onChange={setSearch} placeholder="Search…" />
              <div className="border border-gray-200 rounded-xl overflow-hidden max-h-48 overflow-y-auto">
                {loading && <div className="p-4 text-sm text-gray-400 text-center">Loading…</div>}
                {!loading && items.length === 0 && (
                  <div className="p-4 text-sm text-gray-400 text-center">No items found</div>
                )}
                {items.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => setSelected(item)}
                    className="w-full text-left px-4 py-3 border-b border-gray-100 last:border-0 hover:bg-gray-50 transition-colors"
                  >
                    <p className="text-sm font-medium text-gray-900 truncate">{item.name}</p>
                    {item.description && (
                      <p className="text-xs text-gray-500 mt-0.5 truncate">{item.description}</p>
                    )}
                  </button>
                ))}
              </div>
            </>
          )}

          <div className="mt-4">
            <Field label="Business justification">
              <Textarea
                value={justification}
                onChange={(e) => setJustification(e.target.value)}
                placeholder="Why is this access needed?"
              />
            </Field>
          </div>
        </div>

        <div className="px-4 pb-6 pt-2 border-t border-gray-100">
          <PrimaryButton onClick={handleSubmit} loading={mutation.isPending}>
            <Send size={16} />
            Submit request
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

const FILTERS = [
  { label: "All", value: "" },
  { label: "Pending", value: "EXECUTING" },
  { label: "Completed", value: "REQUEST_COMPLETED" },
  { label: "Denied", value: "REJECTED" },
  { label: "Cancelled", value: "CANCELLED" },
];

export default function RequestsPage() {
  const [filter, setFilter] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [selectedRequest, setSelectedRequest] = useState(null);
  const location = useLocation();

  // Allow HomePage to deep-link to the new-request sheet
  useState(() => {
    if (location.pathname === "/requests/new") setShowNew(true);
  });

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["access-requests"],
    queryFn: () => listAccessRequests({ limit: 30 }),
  });

  const list = (Array.isArray(data) ? data : [])
    .filter((r) => !filter || (r.status || r.requestStatus || r.state || "").toUpperCase() === filter)
    .sort((a, b) => new Date(b.created || 0) - new Date(a.created || 0));
  const { page, pager } = usePagedList(list, { noun: "request", resetKey: String(filter) });

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <TopBar
        title="My requests"
        action={
          <button
            onClick={() => setShowNew(true)}
            className="flex items-center gap-1 text-sm font-medium text-blue-600"
          >
            <Plus size={18} /> New
          </button>
        }
      />

      <div className="flex-1 overflow-y-auto pb-24">
        <FilterBar options={FILTERS} active={filter} onChange={setFilter} />
        {error && <ErrorBox message={error.message} onRetry={refetch} />}
        {isLoading && <SkeletonList rows={6} />}
        {!isLoading && !error && list.length === 0 && (
          <EmptyState
            icon={Send}
            title="No requests"
            subtitle={filter ? "No requests match this filter" : "You haven't made any requests yet"}
            action={
              <button
                onClick={() => setShowNew(true)}
                className="mt-4 flex items-center gap-2 bg-blue-600 text-white text-sm font-medium px-4 py-2 rounded-xl"
              >
                <Plus size={16} /> New request
              </button>
            }
          />
        )}
        {pager}
        {page.map((r) => {
          const name = r.name || r.requestedItems?.[0]?.name || r.id || "Request";
          const status = (r.status || r.requestStatus || r.state || "UNKNOWN").toUpperCase();
          const date = fmtDate(r.created || r.requestedDate);
          return (
            <button
              key={r.id}
              onClick={() => setSelectedRequest(r)}
              className="w-full flex items-center gap-3 px-4 py-3.5 border-b border-gray-100 text-left hover:bg-gray-50 transition-colors"
            >
              <div className="w-10 h-10 rounded-full bg-gray-100 flex items-center justify-center flex-shrink-0">
                {status === "APPROVED" || status === "REQUEST_COMPLETED" || status === "COMPLETED" ? <CheckCircle2 size={16} className="text-green-500" />
                 : status.includes("REJ") || status.includes("DEN") ? <XCircle size={16} className="text-red-400" />
                 : <Clock size={16} className="text-amber-500" />}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-900 truncate">{name}</p>
                {date && <p className="text-xs text-gray-500 mt-0.5">{date}</p>}
              </div>
              <StatusBadge status={status} />
              <ChevronRight size={16} className="text-gray-300 flex-shrink-0" />
            </button>
          );
        })}
        {pager}
      </div>

      {showNew && <NewRequestSheet onClose={() => setShowNew(false)} />}
      {selectedRequest && (
        <RequestDetailSheet request={selectedRequest} onClose={() => setSelectedRequest(null)} />
      )}
    </div>
  );
}
