import { useMemo, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Activity, RefreshCw } from "lucide-react";
import { searchIdentityAccountActivity, searchIdentityEvents } from "../lib/sailpoint";
import { ActivityRow } from "./SourceActivityPanel";
import { EmptyState, ErrorBox, IconButton, OutlineButton, Select, SkeletonList } from "./ui";
import { AiFixSuggestion } from "./AiFixSuggestion";
import { RetryAction } from "./RetryAction";
import { BulkRetryBar, RetryCheckbox, useRetrySelection } from "./BulkRetry";
import { RETRYABLE_EVENT_NAMES } from "../lib/activityRetry";

const VIEWS = [
  { key: "provisioning", label: "Provisioning activity", hint: "Access requests, identity refreshes and lifecycle changes carried out for this identity, with each account operation and its result." },
  { key: "target", label: "Events about this identity", hint: "Audit events naming this identity as the target — sign-ins, provisioning results, certifications." },
  { key: "actor", label: "Actions by this identity", hint: "Audit events this identity performed — requests, approvals and admin changes." },
];
const WINDOWS = [
  { key: "1", label: "Last 24 hours" },
  { key: "7", label: "Last 7 days" },
  { key: "30", label: "Last 30 days" },
  { key: "90", label: "Last 90 days" },
];
const PAGE_SIZE = 100;

// Account activity statuses ISC uses, by how they should read.
const ACTIVITY_STATUS_STYLE = {
  Complete: "bg-emerald-50 text-emerald-700",
  Failed: "bg-red-50 text-red-700",
  Incomplete: "bg-amber-50 text-amber-700",
  Pending: "bg-sky-50 text-sky-700",
  Retrying: "bg-sky-50 text-sky-700",
};
const RESULT_OK = ["committed", "queued", "manual task created"];

const resultErrors = (r) => (Array.isArray(r?.result?.errors) ? r.result.errors.map(String) : []);

function AccountActivityRow({ activity, retryContext, select }) {
  const [open, setOpen] = useState(false);
  const requests = Array.isArray(activity.accountRequests) ? activity.accountRequests : [];
  const errors = [...(Array.isArray(activity.errors) ? activity.errors.map(String) : []), ...requests.flatMap(resultErrors)];
  const sources = activity.sources || [...new Set(requests.map((r) => r.source?.name).filter(Boolean))].join(", ");
  const requester = activity.requester?.name;
  return (
    <div className="border-b border-gray-100">
      <div className="flex items-start">
      {select && <RetryCheckbox checked={select.checked} onChange={select.onChange} />}
      <button onClick={() => setOpen((o) => !o)} className="flex-1 min-w-0 text-left px-4 py-2.5 hover:bg-gray-50 transition-colors">
        <div className="flex items-center gap-2 text-[11px] text-gray-500">
          <span className={`px-1.5 py-0.5 rounded font-semibold ${ACTIVITY_STATUS_STYLE[activity.status] || "bg-gray-100 text-gray-600"}`}>{activity.status || "—"}</span>
          <span className="font-mono">{activity.created ? new Date(activity.created).toLocaleString(undefined, { hour12: false }) : "—"}</span>
          {requester && <span className="truncate">by {requester}</span>}
        </div>
        <p className="text-sm text-gray-900 mt-1">{activity.action || "Account activity"}</p>
        <p className="text-xs text-gray-500 mt-0.5 break-words">
          {[sources, requests.length ? `${requests.length} account operation${requests.length === 1 ? "" : "s"}` : null, activity.stage && activity.stage !== "Completed" ? activity.stage : null].filter(Boolean).join(" · ")}
        </p>
        {errors.length > 0 && <p className={`font-mono text-xs text-red-700 mt-1 break-words ${open ? "whitespace-pre-wrap" : "line-clamp-2"}`}>{errors[0]}</p>}
      </button>
      </div>
      {open && (
        <div className="px-4 pb-3 text-[11px] text-gray-500 space-y-2">
          {errors.slice(1).map((e, i) => <p key={i} className="font-mono text-xs text-red-700 whitespace-pre-wrap break-words">{e}</p>)}
          {(Array.isArray(activity.warnings) ? activity.warnings : []).map((w, i) => <p key={i} className="font-mono text-xs text-amber-700 whitespace-pre-wrap break-words">{String(w)}</p>)}
          {(errors.length > 0 || (activity.status && activity.status !== "Complete" && activity.status !== "Pending")) && (
            <AiFixSuggestion kind="accountActivity" item={activity} actions={<RetryAction kind="accountActivity" item={activity} context={retryContext} />} />
          )}
          {requests.map((r, i) => {
            const status = r.result?.status;
            const ok = status && RESULT_OK.includes(String(status).toLowerCase());
            return (
              <div key={i} className="border border-gray-200 rounded-lg bg-gray-50 px-2.5 py-2">
                <p className="text-xs text-gray-800">
                  <span className="font-medium">{r.op || "Operation"}</span> on {r.source?.name || "unknown source"}
                  {r.accountId ? <> · <span className="font-mono">{r.accountId}</span></> : null}
                  {status && <span className={`ml-2 px-1.5 py-0.5 rounded font-semibold text-[10px] ${ok ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>{status}</span>}
                </p>
                {(Array.isArray(r.attributeRequests) ? r.attributeRequests : []).map((a, j) => (
                  <p key={j} className="font-mono text-gray-700 mt-0.5 break-words">{a.op} {a.name}{a.value != null ? ` = ${typeof a.value === "string" ? a.value : JSON.stringify(a.value)}` : ""}</p>
                ))}
              </div>
            );
          })}
          {activity.trackingNumber && <p>Tracking number: <span className="font-mono text-gray-700">{activity.trackingNumber}</span></p>}
        </div>
      )}
    </div>
  );
}

// Activity tab of an identity: what ISC recorded for, about and by the
// person. Provisioning activity is matched by identity id; audit events only
// carry a name, so they're matched on every name the identity goes by.
export function IdentityActivityPanel({ identityId, identity }) {
  const [view, setView] = useState("provisioning");
  const [days, setDays] = useState("30");
  const [failuresOnly, setFailuresOnly] = useState(false);
  const [retryableOnly, setRetryableOnly] = useState(false);

  const names = useMemo(() => {
    const a = identity?.attributes || {};
    return [...new Set([identity?.name, identity?.alias, a.uid, a.displayName].filter((n) => typeof n === "string" && n.trim()))];
  }, [identity]);

  const { data, isLoading, error, refetch, isFetching, hasNextPage, fetchNextPage, isFetchingNextPage } = useInfiniteQuery({
    queryKey: ["identity-activity", identityId, view, days, failuresOnly, retryableOnly, names],
    queryFn: ({ pageParam }) =>
      view === "provisioning"
        ? searchIdentityAccountActivity({ identityId, days: Number(days), failuresOnly, retryableOnly, limit: PAGE_SIZE, offset: pageParam })
        : searchIdentityEvents({ names, role: view, days: Number(days), failuresOnly, eventNames: retryableOnly ? RETRYABLE_EVENT_NAMES : undefined, limit: PAGE_SIZE, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (last, all) => (Array.isArray(last) && last.length === PAGE_SIZE ? all.length * PAGE_SIZE : undefined),
    enabled: !!identityId && (view === "provisioning" || names.length > 0),
    staleTime: 30_000,
  });
  const items = useMemo(() => (data?.pages || []).flatMap((p) => (Array.isArray(p) ? p : [])), [data]);
  // Under "Actions by this identity" the person is the ACTOR — the event's
  // target is someone (or something) else, so their id must not be assumed.
  const retryContext = useMemo(() => (view === "actor" ? {} : { identityId }), [view, identityId]);
  const kind = view === "provisioning" ? "accountActivity" : "event";
  const selection = useRetrySelection(kind, items, retryContext, `${view}|${days}|${failuresOnly}|${retryableOnly}`);
  const shown = retryableOnly ? items.filter((i) => selection.retryableIds.has(i.id)) : items;

  return (
    <div>
      <div className="px-4 pt-4 flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-gray-900">Activity</p>
          <p className="text-xs text-gray-500 mt-0.5">{VIEWS.find((v) => v.key === view).hint}</p>
        </div>
        <IconButton icon={RefreshCw} title="Refresh" onClick={() => refetch()} loading={isFetching && !isFetchingNextPage} />
      </div>

      <div className="px-4 pt-3 grid grid-cols-2 gap-2">
        <Select value={view} onChange={(e) => setView(e.target.value)}>
          {VIEWS.map((v) => <option key={v.key} value={v.key}>{v.label}</option>)}
        </Select>
        <Select value={days} onChange={(e) => setDays(e.target.value)}>
          {WINDOWS.map((w) => <option key={w.key} value={w.key}>{w.label}</option>)}
        </Select>
      </div>
      <label className="px-4 pt-2 pb-2 flex items-center gap-2 text-xs text-gray-600">
        <input type="checkbox" checked={failuresOnly} onChange={(e) => setFailuresOnly(e.target.checked)} className="rounded border-gray-300" />
        {view === "provisioning" ? "Only activity that didn't complete" : "Failures only"}
      </label>
      <label className="px-4 pb-2 flex items-center gap-2 text-xs text-gray-600">
        <input type="checkbox" checked={retryableOnly} onChange={(e) => setRetryableOnly(e.target.checked)} className="rounded border-gray-300" />
        Only retryable failures — select them to retry
      </label>

      {error && <div className="px-4"><ErrorBox message={error.response?.data?.messages?.[0]?.text || error.response?.data?.error || error.message} onRetry={refetch} /></div>}
      {isLoading && <div className="px-4"><SkeletonList rows={6} /></div>}
      {!isLoading && !error && shown.length === 0 && (
        <EmptyState icon={Activity} title="No activity" subtitle="ISC recorded nothing here for this identity in this window — widen the window or switch the view" />
      )}
      {items.length > 0 && (
        <p className="px-4 pb-1 text-[11px] text-gray-400">{items.length.toLocaleString()}{hasNextPage ? "+" : ""} {view === "provisioning" ? "activit" + (items.length === 1 ? "y" : "ies") : "event" + (items.length === 1 ? "" : "s")}</p>
      )}
      {retryableOnly && <BulkRetryBar selection={selection} noun={view === "provisioning" ? "activity" : "event"} hasMore={hasNextPage} />}
      <div className="border-t border-gray-100">
        {shown.map((item) => {
          const select = retryableOnly ? { checked: selection.selected.has(item.id), onChange: () => selection.toggle(item.id) } : undefined;
          return view === "provisioning"
            ? <AccountActivityRow key={item.id} activity={item} retryContext={retryContext} select={select} />
            : <ActivityRow key={item.id} event={item} showSource retryContext={retryContext} select={select} />;
        })}
      </div>
      {hasNextPage && (
        <div className="px-4 py-3">
          <OutlineButton onClick={() => fetchNextPage()} loading={isFetchingNextPage}>Load older</OutlineButton>
        </div>
      )}
    </div>
  );
}
