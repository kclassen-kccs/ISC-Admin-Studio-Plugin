import { useMemo, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { History, RefreshCw } from "lucide-react";
import { listWorkflowExecutions, getWorkflowExecutionHistory } from "../lib/sailpoint";
import { EmptyState, ErrorBox, IconButton, OutlineButton, SegmentedPill, SkeletonList } from "./ui";
import { AiFixSuggestion } from "./AiFixSuggestion";

const STATUSES = [
  { value: "ALL", label: "All" },
  { value: "Failed", label: "Failed" },
  { value: "Completed", label: "Completed" },
  { value: "Running", label: "Running" },
  { value: "Canceled", label: "Canceled" },
];
const STATUS_STYLE = {
  Completed: "bg-emerald-50 text-emerald-700",
  Failed: "bg-red-50 text-red-700",
  Canceled: "bg-gray-100 text-gray-600",
  Running: "bg-sky-50 text-sky-700",
  Queued: "bg-sky-50 text-sky-700",
};
const PAGE_SIZE = 50;

const isFailure = (e) => /Failed$/.test(e?.type || "");
const fmtTime = (t) => (t ? new Date(t).toLocaleString(undefined, { hour12: false }) : "—");

function duration(start, end) {
  if (!start || !end) return null;
  const ms = new Date(end) - new Date(start);
  if (!(ms >= 0)) return null;
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

// Whatever names the step an event belongs to — ISC's history attributes
// aren't uniform across event types, so try the usual carriers.
function eventStep(e) {
  const a = e?.attributes || {};
  return a.displayName || a.stepName || a.activityType || a.activityId || a.name || "";
}

// "ActivityTaskFailed" → "Activity task failed"
const eventLabel = (type) => String(type || "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase()).replace(/ (\w)/g, (m, c) => ` ${c.toLowerCase()}`);

function ExecutionRow({ execution, workflow }) {
  const [open, setOpen] = useState(false);
  const history = useQuery({
    queryKey: ["workflow-execution-history", execution.id],
    queryFn: () => getWorkflowExecutionHistory(execution.id),
    enabled: open,
    // A finished run's history never changes; a live one is still growing.
    staleTime: ["Running", "Queued"].includes(execution.status) ? 5_000 : Infinity,
  });
  const events = Array.isArray(history.data) ? history.data : [];
  const failures = events.filter(isFailure);
  const took = duration(execution.startTime, execution.closeTime);

  // What the AI is given: the run, the steps as defined, and its history.
  const aiItem = useMemo(() => ({
    id: execution.id,
    workflowName: workflow?.name,
    trigger: workflow?.trigger,
    status: execution.status,
    startTime: execution.startTime,
    closeTime: execution.closeTime,
    steps: Object.entries(workflow?.definition?.steps || {}).map(([name, st]) => ({ name, type: st?.type, actionId: st?.actionId })),
    events,
  }), [execution, workflow, events]);

  return (
    <div className="border-b border-gray-100">
      <button onClick={() => setOpen((o) => !o)} className="w-full text-left px-4 py-2.5 hover:bg-gray-50 transition-colors">
        <div className="flex items-center gap-2 text-[11px] text-gray-500">
          <span className={`px-1.5 py-0.5 rounded font-semibold ${STATUS_STYLE[execution.status] || "bg-gray-100 text-gray-600"}`}>{execution.status || "—"}</span>
          <span className="font-mono">{fmtTime(execution.startTime)}</span>
          {took && <span>· {took}</span>}
        </div>
        <p className="font-mono text-[11px] text-gray-400 mt-1 truncate">{execution.id}</p>
      </button>
      {open && (
        <div className="px-4 pb-3 text-[11px] text-gray-500 space-y-2">
          {history.isLoading && <SkeletonList rows={3} />}
          {history.error && <ErrorBox message={history.error.response?.data?.messages?.[0]?.text || history.error.response?.data?.error || history.error.message} onRetry={history.refetch} />}
          {history.data && (
            <>
              {failures.map((e, i) => (
                <div key={i} className="border border-red-200 bg-red-50 rounded-lg px-2.5 py-2">
                  <p className="text-xs font-medium text-red-700">{eventLabel(e.type)}{eventStep(e) ? ` — ${eventStep(e)}` : ""}</p>
                  <pre className="font-mono text-[11px] text-red-700 mt-1 whitespace-pre-wrap break-words">{JSON.stringify(e.attributes ?? {}, null, 2)}</pre>
                </div>
              ))}
              {(execution.status === "Failed" || failures.length > 0) && events.length > 0 && (
                <AiFixSuggestion
                  kind="workflowExecution"
                  item={aiItem}
                  note="Sends this run's event history and the workflow's step list to the AI provider. Passwords, tokens and keys are redacted first."
                />
              )}
              <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide pt-1">Run history — {events.length} event{events.length === 1 ? "" : "s"}</p>
              {events.length === 0 && <p>ISC returned no history for this run.</p>}
              <ol className="border border-gray-200 rounded-lg divide-y divide-gray-100 overflow-hidden">
                {events.map((e, i) => <EventLine key={i} event={e} />)}
              </ol>
              {execution.requestId && <p>Request id (for SailPoint support): <span className="font-mono text-gray-700">{execution.requestId}</span></p>}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function EventLine({ event }) {
  const [open, setOpen] = useState(false);
  const failed = isFailure(event);
  const hasAttrs = event.attributes && Object.keys(event.attributes).length > 0;
  return (
    <li className={failed ? "bg-red-50/60" : "bg-white"}>
      <button onClick={() => hasAttrs && setOpen((o) => !o)} className={`w-full text-left px-2.5 py-1.5 flex items-baseline gap-2 ${hasAttrs ? "hover:bg-gray-50" : "cursor-default"}`}>
        <span className="font-mono text-gray-400 flex-shrink-0">{event.timestamp ? new Date(event.timestamp).toLocaleTimeString(undefined, { hour12: false }) : "—"}</span>
        <span className={`text-xs ${failed ? "text-red-700 font-medium" : "text-gray-800"}`}>{eventLabel(event.type)}</span>
        {eventStep(event) && <span className="text-gray-500 truncate">{eventStep(event)}</span>}
      </button>
      {open && <pre className="font-mono text-[11px] text-gray-700 bg-gray-50 px-2.5 py-2 whitespace-pre-wrap break-words">{JSON.stringify(event.attributes, null, 2)}</pre>}
    </li>
  );
}

// Executions tab of a workflow: every run ISC still holds (90 days), newest
// first; a run expands to its event history, failures first, and a failed
// run can be explained by AI.
export function WorkflowExecutionsPanel({ workflow }) {
  const [status, setStatus] = useState("ALL");
  const { data, isLoading, error, refetch, isFetching, hasNextPage, fetchNextPage, isFetchingNextPage } = useInfiniteQuery({
    queryKey: ["workflow-executions", workflow.id, status],
    queryFn: ({ pageParam }) => listWorkflowExecutions(workflow.id, { status: status === "ALL" ? undefined : status, limit: PAGE_SIZE, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (last, all) => (Array.isArray(last) && last.length === PAGE_SIZE ? all.length * PAGE_SIZE : undefined),
    staleTime: 15_000,
  });
  // Newest first regardless of how a page came back.
  const executions = useMemo(
    () => (data?.pages || []).flatMap((p) => (Array.isArray(p) ? p : [])).sort((a, b) => String(b.startTime || "").localeCompare(String(a.startTime || ""))),
    [data]
  );
  const failed = executions.filter((e) => e.status === "Failed").length;

  return (
    <div>
      <div className="px-4 pt-4 flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-gray-900">Executions</p>
          <p className="text-xs text-gray-500 mt-0.5">Every run of this workflow ISC still holds — runs are kept for 90 days. Open a run for its step-by-step history.</p>
        </div>
        <IconButton icon={RefreshCw} title="Refresh" onClick={() => refetch()} loading={isFetching && !isFetchingNextPage} />
      </div>
      <div className="px-4 pt-3 pb-2 flex items-center flex-wrap gap-2">
        <SegmentedPill label="Status" options={STATUSES} active={status} onChange={setStatus} />
      </div>

      {error && <div className="px-4"><ErrorBox message={error.response?.data?.messages?.[0]?.text || error.response?.data?.error || error.message} onRetry={refetch} /></div>}
      {isLoading && <div className="px-4"><SkeletonList rows={6} /></div>}
      {!isLoading && !error && executions.length === 0 && (
        <EmptyState
          icon={History}
          title={status === "ALL" ? "No executions" : `No ${status.toLowerCase()} executions`}
          subtitle={status === "ALL" ? (workflow.enabled ? "This workflow hasn't run in the last 90 days" : "This workflow is disabled and hasn't run in the last 90 days") : "Try a different status"}
        />
      )}
      {executions.length > 0 && (
        <p className="px-4 pb-1 text-[11px] text-gray-400">
          {executions.length.toLocaleString()}{hasNextPage ? "+" : ""} run{executions.length === 1 ? "" : "s"}{failed > 0 && status === "ALL" ? ` · ${failed.toLocaleString()} failed` : ""}
        </p>
      )}
      <div className="border-t border-gray-100">
        {executions.map((ex) => <ExecutionRow key={ex.id} execution={ex} workflow={workflow} />)}
      </div>
      {hasNextPage && (
        <div className="px-4 py-3">
          <OutlineButton onClick={() => fetchNextPage()} loading={isFetchingNextPage}>Load older runs</OutlineButton>
        </div>
      )}
    </div>
  );
}
