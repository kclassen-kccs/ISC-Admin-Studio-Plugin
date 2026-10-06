import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Clock, Server, CheckCircle2, XCircle, ChevronDown, ChevronUp, Printer, Settings } from "lucide-react";
import toast from "react-hot-toast";
import {
  startAttributeSyncScan, listAttributeSyncScans, getAttributeSyncScan,
  deleteAttributeSyncScan, deployAttributeSyncScan, getCredentials,
} from "../../lib/sailpoint";
import { printAttributeSyncScanPdf } from "../../lib/exportAttributeSyncScanPdf";
import { TopBar } from "../../components/TopBar";
import { RoleMiningTitleMenu } from "../../components/RoleMiningTitleMenu";
import { OutlineButton, PrimaryButton, IconButton, Spinner, EmptyState, ConfirmModal } from "../../components/ui";
import { STATUS_META } from "./shared";

// ─── List / trigger page ───────────────────────────────────────────────────

export default function AttributeSyncPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const scanMutation = useMutation({
    mutationFn: () => startAttributeSyncScan(),
    onSuccess: ({ scanId }) => {
      toast.success("Attribute Sync scan started — check back here for results.");
      queryClient.invalidateQueries({ queryKey: ["attributeSyncScans"] });
      navigate(`/role-mining/attribute-sync-scans/${scanId}`);
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const { data: pastScans = [] } = useQuery({
    queryKey: ["attributeSyncScans"],
    queryFn: listAttributeSyncScans,
    refetchInterval: (query) => (query.state.data?.some((s) => s.status === "running") ? 4000 : 15000),
  });

  const removeMutation = useMutation({
    mutationFn: (scanId) => deleteAttributeSyncScan(scanId),
    onSuccess: () => {
      toast.success("Scan removed");
      queryClient.invalidateQueries({ queryKey: ["attributeSyncScans"] });
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <TopBar
        title={<RoleMiningTitleMenu active="Attribute Sync" />}
        action={
          <IconButton
            icon={Settings}
            title="Mining Config"
            onClick={() => navigate("/studio-settings/scanning-config")}
          />
        }
      />
      <div className="flex-1 overflow-y-auto pb-24">
        <div className="px-4 py-5 border-b border-gray-100">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-full bg-cyan-50 flex items-center justify-center flex-shrink-0">
              <RefreshCw size={18} className="text-cyan-700" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-gray-900">Attribute Sync</h2>
              <p className="text-xs text-gray-500 mt-0.5">
                Scans every source's provisioning policy for identity-attribute-mapped fields
                and proposes an optimal Attribute Sync configuration for each one.
              </p>
            </div>
          </div>
          <OutlineButton onClick={() => scanMutation.mutate()} loading={scanMutation.isPending}>
            <RefreshCw size={16} />
            Scan Sources for Attribute Sync
          </OutlineButton>
        </div>

        {pastScans.length === 0 ? (
          <EmptyState
            icon={RefreshCw}
            title="No scans yet"
            subtitle="Run a scan to get a proposed Attribute Sync model for every source"
          />
        ) : (
          <div className="mt-2">
            <div className="px-4 py-2 flex items-center gap-2">
              <Clock size={14} className="text-gray-400" />
              <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Past Scans</h3>
            </div>
            {pastScans.map((s) => {
              const meta = STATUS_META[s.status] || STATUS_META.running;
              const StatusIcon = meta.icon;
              return (
                <div
                  key={s.id}
                  className={`w-full flex items-center gap-3 px-4 py-3 border-b border-gray-100 transition-colors ${
                    s.status === "running" ? "bg-cyan-50" : "hover:bg-gray-50"
                  }`}
                >
                  <button
                    onClick={() => navigate(`/role-mining/attribute-sync-scans/${s.id}`)}
                    className="flex-1 min-w-0 flex items-center gap-3 text-left"
                  >
                    <StatusIcon size={16} className={`${meta.className} flex-shrink-0`} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900">{new Date(s.startedAt).toLocaleString()}</p>
                      <p className="text-xs text-gray-500">
                        {meta.label}
                        {s.status === "completed" &&
                          ` · ${s.sourceCount} source${s.sourceCount === 1 ? "" : "s"} · ${s.proposedChangeCount} proposed change${s.proposedChangeCount === 1 ? "" : "s"}`}
                      </p>
                    </div>
                  </button>
                  {s.status !== "running" && (
                    <button
                      onClick={() => removeMutation.mutate(s.id)}
                      disabled={removeMutation.isPending}
                      className="text-xs font-medium text-red-600 hover:text-red-700 disabled:opacity-50 flex-shrink-0"
                    >
                      Remove
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Detail page ────────────────────────────────────────────────────────────

function SourceResultCard({ result, onDeployOne, deploying, expanded, onToggleExpand }) {
  const deployedOutcome = result._deployOutcome;

  if (result.skipped) {
    return (
      <div className="px-4 py-3.5 border-b border-gray-100">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center flex-shrink-0">
            <Server size={14} className="text-gray-400" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-gray-500 truncate">{result.sourceName}</p>
            <p className="text-xs text-gray-400 mt-0.5">{result.reason}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="border-b border-gray-100">
      <div className="flex items-center gap-3 px-4 py-3.5">
        <button
          onClick={onToggleExpand}
          className="flex-1 min-w-0 flex items-center gap-3 text-left"
        >
          <div className="w-8 h-8 rounded-full bg-cyan-50 flex items-center justify-center flex-shrink-0">
            <Server size={14} className="text-cyan-700" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-gray-900 truncate">{result.sourceName}</p>
            <p className="text-xs text-gray-500 mt-0.5">
              {result.sourceType} · {result.changeCount} proposed change{result.changeCount === 1 ? "" : "s"}
              {deployedOutcome && (
                <span className={deployedOutcome.ok ? "text-emerald-600 font-medium" : "text-red-600 font-medium"}>
                  {" · "}{deployedOutcome.ok ? "Deployed" : `Deploy failed: ${deployedOutcome.error}`}
                </span>
              )}
            </p>
          </div>
          {expanded ? <ChevronUp size={16} className="text-gray-300 flex-shrink-0" /> : <ChevronDown size={16} className="text-gray-300 flex-shrink-0" />}
        </button>
        <IconButton
          icon={RefreshCw}
          title={result.changeCount > 0 ? `Deploy Attribute Sync for ${result.sourceName}` : "No proposed changes for this source"}
          onClick={() => onDeployOne(result.sourceId)}
          loading={deploying}
          disabled={result.changeCount === 0 || deploying}
        />
      </div>
      {expanded && (
        <div className="px-4 pb-3.5">
          <div className="border border-gray-100 rounded-xl overflow-hidden">
            {result.proposed.map((p, i) => (
              <div
                key={`${p.name}-${p.target}`}
                className={`flex items-center justify-between gap-3 px-3 py-2.5 text-xs ${i > 0 ? "border-t border-gray-100" : ""}`}
              >
                <div className="min-w-0">
                  <span className="font-medium text-gray-900">{p.name}</span>
                  <span className="text-gray-400"> → </span>
                  <span className="font-medium text-gray-900">{p.target}</span>
                  {p.reason && <p className="text-gray-400 mt-0.5">{p.reason}</p>}
                </div>
                <span
                  className={`flex-shrink-0 px-2 py-0.5 rounded-full border font-medium ${
                    p.currentlyEnabled
                      ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                      : p.recommended
                      ? "bg-blue-50 text-blue-700 border-blue-200"
                      : "bg-gray-50 text-gray-500 border-gray-200"
                  }`}
                >
                  {p.currentlyEnabled ? "Already Enabled" : p.recommended ? "Recommended" : "Excluded"}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function AttributeSyncScanDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [deployAllConfirmOpen, setDeployAllConfirmOpen] = useState(false);
  const [expandedIds, setExpandedIds] = useState(() => new Set());

  const { data: scan, isLoading } = useQuery({
    queryKey: ["attributeSyncScan", id],
    queryFn: () => getAttributeSyncScan(id),
    refetchInterval: (query) => (query.state.data?.status === "running" ? 3000 : false),
  });

  const deployMutation = useMutation({
    mutationFn: (sourceId) => deployAttributeSyncScan(id, sourceId),
    onSuccess: (data) => {
      if (data.failedCount > 0) {
        toast.error(`${data.failedCount} of ${data.outcomes.length} source${data.outcomes.length === 1 ? "" : "s"} failed to deploy`);
      } else {
        toast.success(`Deployed Attribute Sync for ${data.outcomes.length} source${data.outcomes.length === 1 ? "" : "s"}`);
      }
      queryClient.invalidateQueries({ queryKey: ["attributeSyncScan", id] });
      setDeployAllConfirmOpen(false);
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  if (isLoading || !scan) {
    return (
      <div className="flex flex-col min-h-screen bg-white">
        <TopBar title="Attribute Sync Scan" onBack={() => navigate("/role-mining/attribute-sync")} />
        <div className="flex-1 flex items-center justify-center"><Spinner size={24} /></div>
      </div>
    );
  }

  const meta = STATUS_META[scan.status] || STATUS_META.running;
  const StatusIcon = meta.icon;
  const outcomeBySourceId = new Map((scan.deployResults || []).map((o) => [o.sourceId, o]));
  const results = (scan.results || [])
    .map((r) => ({ ...r, _deployOutcome: outcomeBySourceId.get(r.sourceId) }))
    .sort((a, b) => String(a.sourceName || "").localeCompare(String(b.sourceName || ""), undefined, { sensitivity: "base", numeric: true }));
  const deployableCount = results.filter((r) => !r.skipped && r.changeCount > 0).length;
  const expandableResults = results.filter((r) => !r.skipped);
  const allExpanded = expandableResults.length > 0 && expandableResults.every((r) => expandedIds.has(r.sourceId));

  function toggleExpandAll() {
    setExpandedIds(allExpanded ? new Set() : new Set(expandableResults.map((r) => r.sourceId)));
  }
  function toggleExpandOne(sourceId) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(sourceId)) next.delete(sourceId);
      else next.add(sourceId);
      return next;
    });
  }

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <TopBar
        title="Attribute Sync Scan"
        onBack={() => navigate("/role-mining/attribute-sync")}
        action={
          <div className="flex items-center gap-2">
            <IconButton
              icon={Settings}
              title="Mining Config"
              onClick={() => navigate("/studio-settings/scanning-config")}
            />
            <IconButton
              icon={Printer}
              title="Print this scan"
              onClick={() => {
                const tenant = getCredentials()?.tenant;
                if (!printAttributeSyncScanPdf({ tenant, scan })) {
                  toast("Pop-up blocked — downloaded the PDF instead");
                }
              }}
            />
          </div>
        }
      />

      <div className="flex-1 overflow-y-auto pb-24">
        <div className="px-4 py-4 border-b border-gray-100">
          <div className="flex items-center gap-2 mb-1">
            <StatusIcon size={16} className={meta.className} />
            <span className="text-sm font-medium text-gray-900">{meta.label}</span>
          </div>
          <p className="text-xs text-gray-500">
            {scan.tenant ? `${scan.tenant} — ` : ""}Started {new Date(scan.startedAt).toLocaleString()}
            {scan.status === "running" && ` · ${scan.scanned} of ${scan.totalSources} sources scanned`}
          </p>
          {scan.error && <p className="text-xs text-red-600 mt-1">{scan.error}</p>}
        </div>

        {scan.status === "completed" && (
          <div className="px-4 py-4 border-b border-gray-100">
            <PrimaryButton
              onClick={() => setDeployAllConfirmOpen(true)}
              disabled={deployableCount === 0 || deployMutation.isPending}
              loading={deployMutation.isPending && deployMutation.variables === undefined}
            >
              <RefreshCw size={16} />
              {deployableCount > 0
                ? `Deploy this Attribute Sync Model (${scan.proposedChangeCount} change${scan.proposedChangeCount === 1 ? "" : "s"} across ${deployableCount} source${deployableCount === 1 ? "" : "s"})`
                : "No recommended changes to deploy"}
            </PrimaryButton>
          </div>
        )}

        {scan.status === "completed" && results.length === 0 && (
          <EmptyState icon={Server} title="No sources scanned" subtitle="This tenant has no sources to propose an Attribute Sync model for" />
        )}

        {expandableResults.length > 0 && (
          <div className="flex items-center justify-end px-4 py-2 border-b border-gray-100">
            <button
              onClick={toggleExpandAll}
              className="flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-700"
            >
              {allExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              {allExpanded ? "Collapse All" : "Expand All"}
            </button>
          </div>
        )}

        {results.map((r) => (
          <SourceResultCard
            key={r.sourceId}
            result={r}
            onDeployOne={(sourceId) => deployMutation.mutate(sourceId)}
            deploying={deployMutation.isPending && deployMutation.variables === r.sourceId}
            expanded={expandedIds.has(r.sourceId)}
            onToggleExpand={() => toggleExpandOne(r.sourceId)}
          />
        ))}
      </div>

      {deployAllConfirmOpen && (
        <ConfirmModal
          title="Deploy this Attribute Sync Model?"
          message={`This writes the recommended mappings to ${deployableCount} source${deployableCount === 1 ? "" : "s"} in ISC — each source's Attribute Sync configuration will be updated live. This cannot be undone automatically.`}
          confirmLabel="Deploy"
          pending={deployMutation.isPending}
          onConfirm={() => deployMutation.mutate(undefined)}
          onCancel={() => setDeployAllConfirmOpen(false)}
        />
      )}
    </div>
  );
}
