import { useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ScrollText, RefreshCw, Bug, X, Play, Pause } from "lucide-react";
import toast from "react-hot-toast";
import { querySaasConnectorLogs, setSourceDebugLogging } from "../lib/sailpoint";
import { EmptyState, ErrorBox, IconButton, OutlineButton, Select, SkeletonList, ConfirmModal } from "./ui";
import { AiFixSuggestion } from "./AiFixSuggestion";

const WINDOWS = [
  { key: "1h", label: "Last hour", ms: 3_600_000 },
  { key: "6h", label: "Last 6 hours", ms: 6 * 3_600_000 },
  { key: "24h", label: "Last 24 hours", ms: 24 * 3_600_000 },
  { key: "7d", label: "Last 7 days", ms: 7 * 24 * 3_600_000 },
  { key: "30d", label: "Last 30 days", ms: 30 * 24 * 3_600_000 },
];
// Each choice = that level and everything more severe.
const LEVELS = [
  { key: "all", label: "All levels", levels: null },
  { key: "debug", label: "Debug and up", levels: ["DEBUG", "INFO", "WARN", "ERROR"] },
  { key: "info", label: "Info and up", levels: ["INFO", "WARN", "ERROR"] },
  { key: "warn", label: "Warn and up", levels: ["WARN", "ERROR"] },
  { key: "error", label: "Errors only", levels: ["ERROR"] },
];
const LEVEL_STYLE = {
  ERROR: "bg-red-50 text-red-700",
  WARN: "bg-amber-50 text-amber-700",
  INFO: "bg-sky-50 text-sky-700",
  DEBUG: "bg-gray-100 text-gray-600",
  TRACE: "bg-gray-100 text-gray-500",
};
// ISC pages the stream oldest-first, so reaching the newest lines means
// walking every page — follow this many on their own, then ask.
const AUTO_PAGES = 8;
// Live tail (like `sail conn logs tail`): poll this often for lines newer
// than the newest one on screen. Each poll reaches back TAIL_OVERLAP_MS
// behind that line, because ISC ingests lines a little out of order — a
// late arrival stamped just before it would otherwise never show. The
// overlap is de-duplicated by logKey.
const TAIL_INTERVAL_MS = 5000;
const TAIL_OVERLAP_MS = 30_000;
const TAIL_MAX_PAGES = 5;
const TAIL_MAX_LINES = 5000;
// What the AI is shown for one WARN/ERROR line: the lines of the same
// connector command (request id) around it — a lone line rarely says why.
const AI_CONTEXT_LINES = 60;
const AI_LEVELS = ["WARN", "ERROR", "FATAL"];

const logKey = (l) => `${l.timestamp}|${l.requestID || ""}|${l.level || ""}|${messageText(l.message).slice(0, 200)}`;

// A line's message is either plain text or the connector's structured log
// record ({ level, logger, message, thread_name, … }).
function messageText(m) {
  if (m == null) return "";
  if (typeof m === "string") return m;
  if (typeof m.message === "string") return m.message;
  return JSON.stringify(m);
}

function LogRow({ log, fresh, onFilterRequest, buildAiItem }) {
  const [open, setOpen] = useState(false);
  const text = messageText(log.message);
  const logger = typeof log.message === "object" && log.message ? log.message.logger : null;
  return (
    <div className={`border-b border-gray-100 ${fresh ? "border-l-2 border-l-emerald-400" : ""}`}>
      <button onClick={() => setOpen((o) => !o)} className="w-full text-left px-4 py-2 hover:bg-gray-50 transition-colors">
        <div className="flex items-center gap-2 text-[11px] text-gray-500">
          <span className={`px-1.5 py-0.5 rounded font-semibold ${LEVEL_STYLE[log.level] || "bg-gray-100 text-gray-600"}`}>{log.level || "—"}</span>
          <span className="font-mono">{log.timestamp ? new Date(log.timestamp).toLocaleString(undefined, { hour12: false }) : "—"}</span>
          {log.event && <span className="truncate">{log.event}</span>}
        </div>
        <p className={`font-mono text-xs text-gray-800 mt-1 break-words ${open ? "whitespace-pre-wrap" : "line-clamp-2"}`}>{text || "(no message)"}</p>
      </button>
      {open && (
        <div className="px-4 pb-3 text-[11px] text-gray-500 space-y-0.5">
          {logger && <p>Logger: <span className="font-mono text-gray-700">{logger}</span></p>}
          {log.requestID && (
            <p>
              Request: <span className="font-mono text-gray-700">{log.requestID}</span>{" "}
              <button onClick={() => onFilterRequest(log.requestID)} className="text-blue-600 hover:underline">show only this request</button>
            </p>
          )}
          {AI_LEVELS.includes(log.level) && (
            <AiFixSuggestion
              kind="connectorLog"
              item={buildAiItem(log)}
              note="Sends this line and the lines around it from the same connector command to the AI provider. Passwords, tokens and keys are redacted first."
            />
          )}
          {typeof log.message === "object" && log.message && (
            <pre className="mt-1 border border-gray-200 rounded-lg bg-gray-50 text-gray-700 font-mono p-2 overflow-auto whitespace-pre-wrap break-words">{JSON.stringify(log.message, null, 2)}</pre>
          )}
        </div>
      )}
    </div>
  );
}

// Logs tab of a SaaS source: the connector runtime's log lines for this
// source, newest first, plus the switch for its DEBUG logging.
export function SaasConnectorLogsPanel({ sourceId, source }) {
  const queryClient = useQueryClient();
  const [windowKey, setWindowKey] = useState("24h");
  const [levelKey, setLevelKey] = useState("all");
  const [requestID, setRequestID] = useState("");
  const [debugConfirm, setDebugConfirm] = useState(false);
  // The window's start is pinned when the filters change (or on Refresh),
  // not per render — a moving startTime would make every page a new query.
  const [anchor, setAnchor] = useState(() => Date.now());
  const startTime = useMemo(
    () => new Date(anchor - WINDOWS.find((w) => w.key === windowKey).ms).toISOString(),
    [anchor, windowKey]
  );
  const logLevels = LEVELS.find((l) => l.key === levelKey).levels;
  const debugOn = [true, "true"].includes(source?.connectorAttributes?.spConnDebugLoggingEnabled);

  const { data, isLoading, error, refetch, hasNextPage, fetchNextPage, isFetchingNextPage, isFetching } = useInfiniteQuery({
    queryKey: ["saas-connector-logs", sourceId, source?.name, startTime, levelKey, requestID],
    queryFn: ({ pageParam }) => querySaasConnectorLogs({ targetName: source.name, startTime, logLevels, requestID: requestID || undefined, nextToken: pageParam }),
    initialPageParam: "",
    getNextPageParam: (last, _all, lastParam) =>
      Array.isArray(last?.logs) && last.logs.length > 0 && last.nextToken && last.nextToken !== lastParam ? last.nextToken : undefined,
    enabled: !!source?.name,
    staleTime: 30_000,
  });

  const pageCount = data?.pages?.length || 0;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && pageCount < AUTO_PAGES) fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, pageCount, fetchNextPage]);

  const baseLogs = useMemo(() => (data?.pages || []).flatMap((p) => p?.logs || []), [data]);
  const loadingMore = isFetchingNextPage || (hasNextPage && pageCount < AUTO_PAGES);

  // ── Live tail ──
  const [live, setLive] = useState(false);
  const [tailLogs, setTailLogs] = useState([]);
  const [tailError, setTailError] = useState(null);
  const [lastPolled, setLastPolled] = useState(null);
  const filterKey = `${source?.name}|${startTime}|${levelKey}|${requestID}`;
  // Lines tailed under one set of filters don't belong to another.
  useEffect(() => { setTailLogs([]); setTailError(null); }, [filterKey]);

  // Everything the polling loop reads, kept in a ref so the interval isn't
  // torn down and restarted on every new line.
  const tailState = useRef({});
  tailState.current = { baseLogs, tailLogs, hasNextPage, logLevels, requestID, targetName: source?.name, filterKey };
  const liveSince = useRef(null);

  useEffect(() => {
    if (!live || !source?.name || isLoading || loadingMore) return undefined;
    let cancelled = false;
    let inFlight = false;
    if (!liveSince.current) liveSince.current = Date.now();

    async function poll() {
      if (inFlight || document.hidden) return;
      inFlight = true;
      const st = tailState.current;
      try {
        // Tail from the newest line on screen — unless the window was too
        // busy to load fully, in which case the newest line loaded isn't the
        // newest there is, and the tail starts from when Live was turned on.
        const seen = [...st.baseLogs, ...st.tailLogs];
        const newest = seen.reduce((max, l) => Math.max(max, Date.parse(l.timestamp) || 0), 0);
        const from = st.hasNextPage || !newest ? liveSince.current : newest;
        const since = new Date(from - TAIL_OVERLAP_MS).toISOString();
        const fresh = [];
        let token = "";
        for (let page = 0; page < TAIL_MAX_PAGES; page++) {
          const resp = await querySaasConnectorLogs({ targetName: st.targetName, startTime: since, logLevels: st.logLevels, requestID: st.requestID || undefined, nextToken: token });
          const batch = Array.isArray(resp?.logs) ? resp.logs : [];
          fresh.push(...batch);
          if (batch.length === 0 || !resp.nextToken || resp.nextToken === token) break;
          token = resp.nextToken;
        }
        // Filters changed while this poll was out — its lines are stale.
        if (cancelled || tailState.current.filterKey !== st.filterKey) return;
        const known = new Set(seen.map(logKey));
        const added = fresh.filter((l) => !known.has(logKey(l)));
        if (added.length) setTailLogs((prev) => [...prev, ...added].slice(-TAIL_MAX_LINES));
        setTailError(null);
        setLastPolled(Date.now());
      } catch (err) {
        if (!cancelled) setTailError(err.response?.data?.messages?.[0]?.text || err.response?.data?.error || err.message);
      } finally {
        inFlight = false;
      }
    }

    poll();
    const timer = setInterval(poll, TAIL_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [live, source?.name, isLoading, loadingMore, filterKey]);

  // Newest first. Tailed lines can arrive out of order, so sort rather than
  // just stacking them on top.
  const logs = useMemo(
    () => [...baseLogs, ...tailLogs].sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0)),
    [baseLogs, tailLogs]
  );
  const tailKeys = useMemo(() => new Set(tailLogs.map(logKey)), [tailLogs]);

  // The focus line plus its context, oldest first: the same request's lines
  // when it has a request id, else its neighbours in time. Windowed around
  // the focus line so a long command still fits the AI's budget.
  const buildAiItem = (focus) => {
    const related = (focus.requestID ? logs.filter((l) => l.requestID === focus.requestID) : logs).slice().reverse();
    const at = Math.max(0, related.indexOf(focus));
    const start = Math.max(0, Math.min(at - Math.floor(AI_CONTEXT_LINES * 0.75), related.length - AI_CONTEXT_LINES));
    return {
      id: `${focus.requestID || "no-request"}:${focus.timestamp}`,
      sourceName: source?.name,
      connector: source?.connectorName || source?.connector,
      requestID: focus.requestID || undefined,
      lines: related.slice(start, start + AI_CONTEXT_LINES).map((l) => ({ timestamp: l.timestamp, level: l.level, event: l.event, message: l.message, focus: l === focus })),
    };
  };
  // Two identical lines in the same nanosecond share a logKey — number the
  // repeats so React keys stay unique.
  const rows = useMemo(() => {
    const seen = new Map();
    return logs.map((log) => {
      const k = logKey(log);
      const n = seen.get(k) || 0;
      seen.set(k, n + 1);
      return { log, key: n ? `${k}#${n}` : k };
    });
  }, [logs]);

  const toggleDebug = useMutation({
    mutationFn: (on) => setSourceDebugLogging(sourceId, on),
    onSuccess: (_d, on) => {
      toast.success(on ? "Debug logging turned on — it applies from the connector's next command" : "Debug logging turned off");
      setDebugConfirm(false);
      queryClient.invalidateQueries({ queryKey: ["source", sourceId] });
    },
    onError: (err) => toast.error(err.response?.data?.messages?.[0]?.text || err.response?.data?.error || err.message),
  });

  return (
    <div>
      <div className="px-4 pt-4 flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-gray-900">Connector Logs</p>
          <p className="text-xs text-gray-500 mt-0.5">
            What the SaaS connector logged for this source, newest first. Debug logging is {debugOn ? "on" : "off"}
            {debugOn ? " — turn it off when you're done, it is verbose." : " — without it only INFO and above are logged."}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <IconButton
            icon={Bug}
            title={debugOn ? "Turn debug logging off" : "Turn debug logging on"}
            onClick={() => (debugOn ? toggleDebug.mutate(false) : setDebugConfirm(true))}
            loading={toggleDebug.isPending}
            className={debugOn ? "!border-amber-300 !text-amber-700 !bg-amber-50" : ""}
          />
          <IconButton
            icon={live ? Pause : Play}
            title={live ? "Pause live tail" : `Live tail — check for new lines every ${TAIL_INTERVAL_MS / 1000}s`}
            onClick={() => { liveSince.current = null; setLive((v) => !v); }}
            className={live ? "!border-emerald-300 !text-emerald-700 !bg-emerald-50" : ""}
          />
          <IconButton icon={RefreshCw} title="Refresh" onClick={() => { liveSince.current = null; setAnchor(Date.now()); }} loading={isFetching && !isFetchingNextPage} />
        </div>
      </div>

      <div className="px-4 pt-3 pb-2 grid grid-cols-2 gap-2">
        <Select value={windowKey} onChange={(e) => { setWindowKey(e.target.value); setAnchor(Date.now()); }}>
          {WINDOWS.map((w) => <option key={w.key} value={w.key}>{w.label}</option>)}
        </Select>
        <Select value={levelKey} onChange={(e) => setLevelKey(e.target.value)}>
          {LEVELS.map((l) => <option key={l.key} value={l.key}>{l.label}</option>)}
        </Select>
      </div>
      {requestID && (
        <div className="px-4 pb-2">
          <span className="inline-flex items-center gap-1.5 text-xs bg-blue-50 text-blue-700 rounded-full pl-3 pr-2 py-1">
            Request <span className="font-mono">{requestID}</span>
            <button onClick={() => setRequestID("")} title="Clear request filter"><X size={12} /></button>
          </span>
        </div>
      )}

      {error && <div className="px-4"><ErrorBox message={error.response?.data?.messages?.[0]?.text || error.response?.data?.error || error.message} onRetry={refetch} /></div>}
      {isLoading && <div className="px-4"><SkeletonList rows={6} /></div>}
      {live && (
        <p className={`px-4 pb-2 text-[11px] flex items-center gap-1.5 ${tailError ? "text-red-600" : "text-emerald-700"}`}>
          <span className={`inline-block w-1.5 h-1.5 rounded-full ${tailError ? "bg-red-500" : "bg-emerald-500 animate-pulse"}`} />
          {tailError
            ? `Live tail can't reach ISC — retrying: ${tailError}`
            : `Live — checking every ${TAIL_INTERVAL_MS / 1000}s${lastPolled ? ` · last checked ${new Date(lastPolled).toLocaleTimeString(undefined, { hour12: false })}` : ""}${tailLogs.length ? ` · ${tailLogs.length.toLocaleString()} new` : ""}. Lines reach ISC's log store a few seconds after the connector writes them.`}
        </p>
      )}
      {!isLoading && !error && logs.length === 0 && !loadingMore && !live && (
        <EmptyState icon={ScrollText} title="No log lines" subtitle="The connector logged nothing for this source in this window — widen the window, or run an aggregation or test connection and refresh" />
      )}

      {logs.length > 0 && (
        <p className="px-4 pb-1 text-[11px] text-gray-400">
          {logs.length.toLocaleString()} line{logs.length === 1 ? "" : "s"}{loadingMore ? " — loading more…" : hasNextPage ? " — more available" : ""}
        </p>
      )}
      {hasNextPage && !loadingMore && (
        <div className="px-4 pb-2">
          <OutlineButton onClick={() => fetchNextPage()} loading={isFetchingNextPage}>Load newer lines</OutlineButton>
          <p className="text-[11px] text-gray-400 mt-1">ISC returns logs oldest first, so the most recent lines of a busy window are the last to load — narrow the window or raise the level to get to them faster.</p>
        </div>
      )}
      <div className="border-t border-gray-100">
        {rows.map(({ log, key }) => <LogRow key={key} log={log} fresh={tailKeys.has(logKey(log))} onFilterRequest={setRequestID} buildAiItem={buildAiItem} />)}
      </div>

      {debugConfirm && (
        <ConfirmModal
          title="Turn on debug logging?"
          message={`Sets spConnDebugLoggingEnabled on "${source?.name}". The connector logs far more detail from its next command on — request and response data can appear in these logs. Turn it back off when you're done.`}
          confirmLabel="Turn On"
          pending={toggleDebug.isPending}
          onConfirm={() => toggleDebug.mutate(true)}
          onCancel={() => !toggleDebug.isPending && setDebugConfirm(false)}
        />
      )}
    </div>
  );
}
