import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, RefreshCw, Sparkles, X, ChevronRight, AlertTriangle, RotateCcw } from "lucide-react";
import toast from "react-hot-toast";
import { searchEvents, suggestEventFix, getEventFixSuggestion, listEventFixSuggestions } from "../../lib/sailpoint";
import { isFailedEvent, retryableReason } from "../../lib/eventRetry";
import { useUrlSearch } from "../../hooks/useUrlSearch";
import { useUrlState } from "../../hooks/useUrlState";
import { TopBar } from "../../components/TopBar";
import { ToolsTitleMenu } from "../../components/ToolsTitleMenu";
import { RawJsonPanel } from "../../components/RawJsonPanel";
import {
  SkeletonList, ErrorBox, EmptyState, SearchBar, FilterBar, IconButton, Spinner,
} from "../../components/ui";

const WINDOWS = [
  { value: "1", label: "24 hours" },
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
];

// All events, only failures, or only failures whose recorded error looks
// transient (see lib/eventRetry) — the ones worth simply trying again.
const SHOW = [
  { value: "ALL", label: "All" },
  { value: "FAILED", label: "Failed" },
  { value: "RETRYABLE", label: "Retryable Failures" },
];

const fmt = (d) => (d ? new Date(d).toLocaleString() : "—");
const text = (v) => (v == null || v === "" ? undefined : typeof v === "string" ? v : JSON.stringify(v, null, 2));

function statusTone(status) {
  const s = String(status || "").toUpperCase();
  if (s === "FAILED" || s === "ERROR") return "bg-red-50 text-red-700";
  if (s === "INCOMPLETE") return "bg-amber-50 text-amber-700";
  if (s === "PASSED" || s === "SUCCESS" || s === "SUCCEEDED") return "bg-emerald-50 text-emerald-700";
  return "bg-gray-100 text-gray-600";
}

// Like InfoRow, but the value wraps in full instead of truncating — an
// event's stack, message or attribute JSON is exactly the part that has to
// be readable end to end.
function WrapRow({ label, value }) {
  if (value == null || value === "") return null;
  return (
    <div className="py-2.5 border-b border-gray-100 last:border-0">
      <p className="text-xs text-gray-500 mb-0.5">{label}</p>
      <p className="text-gray-900 break-words whitespace-pre-wrap font-mono text-[12px] leading-relaxed">{String(value)}</p>
    </div>
  );
}

// One event, in full, plus the AI suggestion. A sheet rather than a route so
// the filtered list (and its 100 loaded rows) stays put underneath.
function EventSheet({ event, onClose }) {
  const [tab, setTab] = useState("details");
  const queryClient = useQueryClient();
  // Suggestions are saved server-side per event, so opening the sheet
  // shows a previous one straight away instead of asking again.
  const saved = useQuery({
    queryKey: ["ops-suggestion", event.id],
    queryFn: () => getEventFixSuggestion(event.id),
    enabled: isFailedEvent(event),
    staleTime: Infinity,
  });
  const suggest = useMutation({
    mutationFn: (refresh) => suggestEventFix(event, { refresh }),
    onSuccess: (data) => {
      queryClient.setQueryData(["ops-suggestion", event.id], data);
      queryClient.invalidateQueries({ queryKey: ["ops-suggestions"] });
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });
  const result = suggest.data || (saved.data?.suggestion ? saved.data : null);
  const errors = [event.errors, event.warnings, event.details, event.attributes?.errors, event.attributes?.errorMessage, event.attributes?.message]
    .flatMap((v) => (Array.isArray(v) ? v : v ? [v] : []))
    .map((v) => (typeof v === "string" ? v : JSON.stringify(v)))
    .filter(Boolean);

  return (
    <div className="fixed inset-0 bg-black/30 z-30 flex items-end md:items-center justify-center" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="bg-white w-full max-w-3xl md:mx-4 rounded-t-2xl md:rounded-2xl shadow-xl max-h-[92vh] flex flex-col">
        <div className="flex items-start justify-between gap-3 px-5 pt-5 pb-3 border-b border-gray-100">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-gray-900 truncate">{event.name || event.technicalName || event.action || "Event"}</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              {fmt(event.created)}{event.type ? ` · ${event.type}` : ""}{event.actor?.name ? ` · by ${event.actor.name}` : ""}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <span className={`text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full ${statusTone(event.status)}`}>{event.status || "—"}</span>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={20} /></button>
          </div>
        </div>

        {isFailedEvent(event) && (
        <div className="px-5 py-4 border-b border-gray-100 bg-violet-50/40">
          {/* The "Suggested fix" heading only appears once there is one;
              before that the panel is just the call-to-action. */}
          {result && (
            <div className="flex items-center justify-between gap-3 mb-2">
              <p className="text-sm font-semibold text-gray-900 flex items-center gap-2"><Sparkles size={16} className="text-violet-600" /> Suggested fix</p>
              <button onClick={() => suggest.mutate(true)} disabled={suggest.isPending} className="text-xs font-medium text-blue-600 hover:text-blue-700 disabled:opacity-50">
                Regenerate
              </button>
            </div>
          )}
          {saved.isLoading && <p className="text-xs text-gray-500 flex items-center gap-2"><Spinner size={14} /> Checking for a saved suggestion…</p>}
          {!saved.isLoading && !result && !suggest.isPending && (
            <button
              onClick={() => suggest.mutate(false)}
              className="w-full md:w-auto inline-flex items-center justify-center gap-2 bg-violet-600 hover:bg-violet-700 active:bg-violet-800 text-white font-semibold text-sm px-5 py-3 rounded-xl shadow-sm transition-colors"
            >
              <Sparkles size={16} />
              Suggest a fix with AI
            </button>
          )}
          {suggest.isPending && <p className="text-xs text-gray-500 flex items-center gap-2"><Spinner size={14} /> Analyzing this event…</p>}
          {result && !suggest.isPending && (
            <>
              <p className="text-sm text-gray-800 leading-relaxed whitespace-pre-wrap">{result.suggestion}</p>
              <p className="text-[11px] text-gray-400 mt-2">
                AI-generated from this event's own fields{result.generatedAt ? ` on ${fmt(result.generatedAt)}` : ""} — saved for this event; verify before acting.
              </p>
            </>
          )}
        </div>

        )}
        <div className="flex border-b border-gray-100 px-2">
          {[{ key: "details", label: "Details" }, { key: "json", label: "JSON" }].map((t) => (
            <button key={t.key} onClick={() => setTab(t.key)} className={`px-3 py-2.5 text-sm font-medium border-b-2 -mb-px ${tab === t.key ? "text-blue-600 border-blue-600" : "text-gray-400 border-transparent hover:text-gray-600"}`}>
              {t.label}
            </button>
          ))}
        </div>
        <div className="flex-1 overflow-y-auto">
          {tab === "details" && (
            <div className="px-5 py-4">
              {errors.length > 0 && (
                <div className="mb-4 border border-red-200 bg-red-50 rounded-xl px-3 py-2.5 text-xs text-red-700 space-y-1">
                  {errors.map((e, i) => <p key={i} className="break-words whitespace-pre-wrap">{e}</p>)}
                </div>
              )}
              <div className="border border-gray-100 rounded-xl overflow-hidden px-4">
                <WrapRow label="Status" value={event.status} />
                <WrapRow label="Type" value={event.type} />
                <WrapRow label="Action" value={event.action} />
                <WrapRow label="Operation" value={event.operation} />
                <WrapRow label="Technical name" value={event.technicalName} />
                <WrapRow label="Actor" value={event.actor?.name} />
                <WrapRow label="Target" value={event.target?.name} />
                <WrapRow label="Objects" value={Array.isArray(event.objects) ? event.objects.join(", ") : text(event.objects)} />
                <WrapRow label="Stack" value={event.stack} />
                <WrapRow label="Tracking number" value={event.trackingNumber} />
                <WrapRow label="IP address" value={event.ipAddress} />
                <WrapRow label="Created" value={fmt(event.created)} />
                <WrapRow label="Event ID" value={event.id} />
              </div>
              {event.attributes && Object.keys(event.attributes).length > 0 && (
                <>
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mt-4 mb-1">Attributes</p>
                  <div className="border border-gray-100 rounded-xl overflow-hidden px-4">
                    {Object.entries(event.attributes).map(([k, v]) => <WrapRow key={k} label={k} value={text(v)} />)}
                  </div>
                </>
              )}
            </div>
          )}
          {tab === "json" && <RawJsonPanel data={event} resource="events" objectId={event.id} readOnly />}
        </div>
      </div>
    </div>
  );
}

export default function OperationsPage() {
  const { search, debouncedSearch, handleSearch } = useUrlSearch();
  const [days, setDays] = useUrlState("days", "7");
  const [show, setShow] = useUrlState("show", "ALL");
  const [openId, setOpenId] = useState(null);
  const failedOnly = show !== "ALL";

  // All events, or (for both failure filters) just the failed ones — a
  // separate query so the 250-row cap applies to failures, not to the far
  // more numerous successful events.
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["event-log", days, failedOnly],
    queryFn: () => searchEvents({ days: Number(days), failedOnly }),
    refetchInterval: 60000,
  });
  const loaded = useMemo(() => (Array.isArray(data) ? data : []), [data]);
  const events = useMemo(
    () => (show === "RETRYABLE" ? loaded.filter((e) => retryableReason(e)) : show === "FAILED" ? loaded.filter(isFailedEvent) : loaded),
    [loaded, show]
  );
  const { data: suggestionIndex } = useQuery({ queryKey: ["ops-suggestions"], queryFn: listEventFixSuggestions, staleTime: 60000 });
  const suggested = useMemo(() => new Set((suggestionIndex || []).map((s) => s.eventId)), [suggestionIndex]);
  const list = useMemo(() => {
    const q = debouncedSearch.trim().toLowerCase();
    if (!q) return events;
    return events.filter((e) =>
      [e.name, e.technicalName, e.action, e.type, e.status, e.actor?.name, e.target?.name, e.stack, ...(Array.isArray(e.objects) ? e.objects : [])]
        .some((v) => v && String(v).toLowerCase().includes(q))
    );
  }, [events, debouncedSearch]);
  const open = openId ? events.find((e) => e.id === openId) : null;

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <TopBar
        title={<ToolsTitleMenu active="Event Log" />}
        loading={isLoading}
        action={<IconButton icon={RefreshCw} title="Refresh" onClick={() => refetch()} loading={isFetching && !isLoading} />}
      />
      <div className="flex-1 overflow-y-auto pb-24">
        <div className="px-4 pt-4 flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-red-50 flex items-center justify-center flex-shrink-0">
            <Activity size={18} className="text-red-600" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-gray-900">Event Log</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              The tenant's audit events (ISC's events index), newest first. Failed shows status Failed, Error or Incomplete;
              Retryable Failures shows the failures whose recorded error looks transient (timeouts, dropped connections,
              429/5xx, temporarily unavailable) — the ones worth simply trying again. Open any event for its full detail and,
              for a failure, an AI-suggested fix.
            </p>
          </div>
        </div>
        <SearchBar value={search} onChange={handleSearch} placeholder="Search events by name, type, action, actor, target, or object…" />
        <FilterBar options={SHOW} active={show} onChange={setShow} />
        <FilterBar options={WINDOWS} active={days} onChange={setDays} right={<span className="text-xs text-gray-400">{list.length} of {events.length}</span>} />

        {error && <ErrorBox message={error.response?.data?.error || error.message} onRetry={refetch} />}
        {isLoading && <SkeletonList rows={6} />}
        {!isLoading && !error && list.length === 0 && (
          <EmptyState
            icon={AlertTriangle}
            title={search ? "No results" : show === "ALL" ? "No events" : show === "RETRYABLE" ? "No retryable failures" : "No failures"}
            subtitle={
              search
                ? `No ${show === "ALL" ? "" : "failed "}events match "${search}"`
                : `No ${show === "ALL" ? "events" : show === "RETRYABLE" ? "failures with a transient cause" : "failed events"} in the last ${WINDOWS.find((w) => w.value === days)?.label || "period"}`
            }
          />
        )}
        {list.map((e) => (
          <button key={e.id} onClick={() => setOpenId(e.id)} className="w-full text-left flex items-center gap-3 px-4 py-3 border-b border-gray-100 hover:bg-gray-50 transition-colors">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-gray-900 truncate">{e.name || e.technicalName || e.action || "Event"}</p>
              <p className="text-xs text-gray-500 truncate mt-0.5">
                {fmt(e.created)}{e.type ? ` · ${e.type}` : ""}{e.actor?.name ? ` · ${e.actor.name}` : ""}{e.target?.name ? ` → ${e.target.name}` : ""}
              </p>
            </div>
            {retryableReason(e) && (
              <span className="hidden sm:inline-flex items-center gap-1 text-[10px] font-medium text-blue-700 bg-blue-50 px-2 py-0.5 rounded-full flex-shrink-0" title="Recorded error looks transient — worth retrying">
                <RotateCcw size={10} /> {retryableReason(e)}
              </span>
            )}
            {suggested.has(e.id) && <Sparkles size={14} className="text-violet-600 flex-shrink-0" title="A fix has been suggested" />}
            <span className={`text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full flex-shrink-0 ${statusTone(e.status)}`}>{e.status || "—"}</span>
            <ChevronRight size={16} className="text-gray-300 flex-shrink-0" />
          </button>
        ))}
        {!isLoading && loaded.length >= 250 && (
          <p className="px-4 py-3 text-xs text-gray-400">Showing the 250 most recent {failedOnly ? "failures" : "events"} — narrow the window or search to see others.</p>
        )}
      </div>
      {open && <EventSheet event={open} onClose={() => setOpenId(null)} />}
    </div>
  );
}
