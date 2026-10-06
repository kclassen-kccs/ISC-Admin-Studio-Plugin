import { useMemo, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Activity, RefreshCw } from "lucide-react";
import { searchSourceActivity } from "../lib/sailpoint";
import { EmptyState, ErrorBox, IconButton, OutlineButton, Select, SkeletonList } from "./ui";
import { AiFixSuggestion } from "./AiFixSuggestion";
import { RetryAction } from "./RetryAction";
import { BulkRetryBar, RetryCheckbox, useRetrySelection } from "./BulkRetry";
import { RETRYABLE_EVENT_NAMES } from "../lib/activityRetry";

const WINDOWS = [
  { key: "1", label: "Last 24 hours" },
  { key: "7", label: "Last 7 days" },
  { key: "30", label: "Last 30 days" },
  { key: "90", label: "Last 90 days" },
];
const CATEGORIES = [
  { key: "all", label: "All activity" },
  { key: "aggregation", label: "Aggregations" },
  { key: "provisioning", label: "Provisioning" },
  { key: "configuration", label: "Configuration changes" },
];
const STATUS_STYLE = {
  PASSED: "bg-emerald-50 text-emerald-700",
  FAILED: "bg-red-50 text-red-700",
  ERROR: "bg-red-50 text-red-700",
  INCOMPLETE: "bg-amber-50 text-amber-700",
  STARTED: "bg-sky-50 text-sky-700",
};
const PAGE_SIZE = 100;
const FAILED_STATUSES = ["FAILED", "ERROR", "INCOMPLETE"];

// attributes.errors is a JSON array serialized into a string.
function eventErrors(event) {
  const raw = event?.attributes?.errors;
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(String);
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [String(parsed)];
  } catch {
    return [String(raw)];
  }
}

// One line saying what the event touched: whose account, which entitlement.
function eventSubject(event, showSource) {
  const a = event.attributes || {};
  const parts = [];
  const who = a.identityDisplayName || a.identityName;
  const account = a.accountDisplayName || a.accountName || a.accountNativeIdentity;
  if (who) parts.push(who);
  if (account && account !== who) parts.push(`account ${account}`);
  if (a.attributeName && a.attributeValue) parts.push(`${a.attributeName} = ${a.attributeValue}`);
  else if (a.attributeName) parts.push(a.attributeName);
  if (parts.length === 0 && event.target?.name && event.target.name !== a.sourceName) parts.push(event.target.name);
  // Off on a source's own page, where it would repeat on every row.
  if (showSource && a.sourceName && (who || account)) parts.push(a.sourceName);
  return parts.join(" · ");
}

// retryContext: { sourceId } or { identityId } — whichever the screen knows,
// so Retry doesn't have to look it up from the name on the event.
// select: { checked, onChange } — shows the bulk-retry checkbox beside the row.
export function ActivityRow({ event, showSource = false, retryContext, select }) {
  const [open, setOpen] = useState(false);
  const errors = eventErrors(event);
  const subject = eventSubject(event, showSource);
  const actor = event.actor?.name;
  return (
    <div className="border-b border-gray-100">
      <div className="flex items-start">
      {select && <RetryCheckbox checked={select.checked} onChange={select.onChange} />}
      <button onClick={() => setOpen((o) => !o)} className="flex-1 min-w-0 text-left px-4 py-2.5 hover:bg-gray-50 transition-colors">
        <div className="flex items-center gap-2 text-[11px] text-gray-500">
          <span className={`px-1.5 py-0.5 rounded font-semibold ${STATUS_STYLE[event.status] || "bg-gray-100 text-gray-600"}`}>{event.status || "—"}</span>
          <span className="font-mono">{event.created ? new Date(event.created).toLocaleString(undefined, { hour12: false }) : "—"}</span>
          {actor && <span className="truncate">by {actor}</span>}
        </div>
        <p className="text-sm text-gray-900 mt-1">{event.name || event.action || event.technicalName}</p>
        {subject && <p className="text-xs text-gray-500 mt-0.5 break-words">{subject}</p>}
        {errors.length > 0 && <p className={`font-mono text-xs text-red-700 mt-1 break-words ${open ? "whitespace-pre-wrap" : "line-clamp-2"}`}>{errors[0]}</p>}
      </button>
      </div>
      {open && (
        <div className="px-4 pb-3 text-[11px] text-gray-500 space-y-1">
          {errors.slice(1).map((e, i) => <p key={i} className="font-mono text-xs text-red-700 whitespace-pre-wrap break-words">{e}</p>)}
          {(FAILED_STATUSES.includes(event.status) || errors.length > 0) && (
            <AiFixSuggestion kind="event" item={event} actions={<RetryAction kind="event" item={event} context={retryContext} />} />
          )}
          <p>Event: <span className="font-mono text-gray-700">{event.technicalName || event.action}</span>{event.type ? ` · ${event.type}` : ""}</p>
          {event.trackingNumber && <p>Tracking number: <span className="font-mono text-gray-700">{event.trackingNumber}</span></p>}
          {event.attributes && (
            <pre className="border border-gray-200 rounded-lg bg-gray-50 text-gray-700 font-mono p-2 overflow-auto whitespace-pre-wrap break-words">{JSON.stringify(event.attributes, null, 2)}</pre>
          )}
        </div>
      )}
    </div>
  );
}

// Activity tab of a source: ISC's audit events for it. For a VA-based source
// it's the stand-in for a connector log, since a VA's ccg.log never leaves
// the appliance; a SaaS source has its Logs tab for that, and this adds what
// the log doesn't show — each provisioning outcome, per identity.
export function SourceActivityPanel({ sourceId, source, saas = false }) {
  const [days, setDays] = useState("7");
  const [category, setCategory] = useState("all");
  const [failuresOnly, setFailuresOnly] = useState(false);
  const [retryableOnly, setRetryableOnly] = useState(false);

  const { data, isLoading, error, refetch, isFetching, hasNextPage, fetchNextPage, isFetchingNextPage } = useInfiniteQuery({
    queryKey: ["source-activity", sourceId, source?.name, days, category, failuresOnly, retryableOnly],
    queryFn: ({ pageParam }) =>
      searchSourceActivity({ sourceName: source.name, days: Number(days), category, failuresOnly, eventNames: retryableOnly ? RETRYABLE_EVENT_NAMES : undefined, limit: PAGE_SIZE, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (last, all) => (Array.isArray(last) && last.length === PAGE_SIZE ? all.length * PAGE_SIZE : undefined),
    enabled: !!source?.name,
    staleTime: 30_000,
  });
  const events = useMemo(() => (data?.pages || []).flatMap((p) => (Array.isArray(p) ? p : [])), [data]);
  const failed = useMemo(() => events.filter((e) => FAILED_STATUSES.includes(e.status)).length, [events]);
  const retryContext = useMemo(() => ({ sourceId }), [sourceId]);
  const selection = useRetrySelection("event", events, retryContext, `${days}|${category}|${failuresOnly}|${retryableOnly}`);
  // ISC's search already narrowed to retryable event types; this drops the
  // few of those that still can't be retried (an event naming no identity).
  const shown = retryableOnly ? events.filter((e) => selection.retryableIds.has(e.id)) : events;

  return (
    <div>
      <div className="px-4 pt-4 flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-gray-900">Activity</p>
          <p className="text-xs text-gray-500 mt-0.5">
            What ISC recorded for this source — aggregations, provisioning results with the connector's errors, and configuration changes.{" "}
            {saas ? "The connector's own log lines are on the Logs tab." : "The VA's own connector log (ccg.log) stays on the appliance and isn't available through ISC."}
          </p>
        </div>
        <IconButton icon={RefreshCw} title="Refresh" onClick={() => refetch()} loading={isFetching && !isFetchingNextPage} />
      </div>

      <div className="px-4 pt-3 grid grid-cols-2 gap-2">
        <Select value={days} onChange={(e) => setDays(e.target.value)}>
          {WINDOWS.map((w) => <option key={w.key} value={w.key}>{w.label}</option>)}
        </Select>
        <Select value={category} onChange={(e) => setCategory(e.target.value)}>
          {CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
        </Select>
      </div>
      <label className="px-4 pt-2 pb-2 flex items-center gap-2 text-xs text-gray-600">
        <input type="checkbox" checked={failuresOnly} onChange={(e) => setFailuresOnly(e.target.checked)} className="rounded border-gray-300" />
        Only unsuccessful activity (failed, errored or incomplete)
      </label>
      <label className="px-4 pb-2 flex items-center gap-2 text-xs text-gray-600">
        <input type="checkbox" checked={retryableOnly} onChange={(e) => setRetryableOnly(e.target.checked)} className="rounded border-gray-300" />
        Only retryable failures — select them to retry
      </label>

      {error && <div className="px-4"><ErrorBox message={error.response?.data?.messages?.[0]?.text || error.response?.data?.error || error.message} onRetry={refetch} /></div>}
      {isLoading && <div className="px-4"><SkeletonList rows={6} /></div>}
      {!isLoading && !error && shown.length === 0 && (
        <EmptyState icon={Activity} title="No activity" subtitle={retryableOnly ? "No retryable failures were recorded for this source in this window" : failuresOnly ? "Nothing unsuccessful was recorded for this source in this window" : "ISC recorded nothing for this source in this window — widen the window or change the filter"} />
      )}
      {events.length > 0 && (
        <p className="px-4 pb-1 text-[11px] text-gray-400">
          {events.length.toLocaleString()}{hasNextPage ? "+" : ""} event{events.length === 1 ? "" : "s"}{failed > 0 && !failuresOnly ? ` · ${failed.toLocaleString()} unsuccessful` : ""}
        </p>
      )}
      {retryableOnly && <BulkRetryBar selection={selection} noun="event" hasMore={hasNextPage} />}
      <div className="border-t border-gray-100">
        {shown.map((event) => (
          <ActivityRow
            key={event.id}
            event={event}
            retryContext={retryContext}
            select={retryableOnly ? { checked: selection.selected.has(event.id), onChange: () => selection.toggle(event.id) } : undefined}
          />
        ))}
      </div>
      {hasNextPage && (
        <div className="px-4 py-3">
          <OutlineButton onClick={() => fetchNextPage()} loading={isFetchingNextPage}>Load older events</OutlineButton>
        </div>
      )}
    </div>
  );
}
