import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BadgeCheck, Clock, StopCircle, CheckCircle2, XCircle, Printer, ChevronRight, ChevronDown,
  ChevronsUpDown, ChevronsDownUp, Layers, ShieldCheck, Key, AlertTriangle, CircleDashed, ClipboardPlus, RefreshCw, Loader2, Settings,
} from "lucide-react";
import toast from "react-hot-toast";
import {
  startCertificationRun, listCertificationRuns, getCertificationRun, getCertificationRunCampaign,
  createCertificationCampaign, cancelCertificationRun, deleteCertificationRun, syncCertificationRunStatus,
  getStudioPreferences, getTenantSettings, getCredentials,
} from "../../lib/sailpoint";
import { describeCertSettings, describeCertFilters, humanizeAttributeKey, certificationCriteriaText, certificationCampaignName } from "../../lib/certificationSettings";
import {
  printCertificationRunSummaryPdf, printCertificationRunDetailPdf, printCertificationCampaignPdf,
} from "../../lib/exportCertificationRunPdf";
import { TopBar } from "../../components/TopBar";
import { RoleMiningTitleMenu } from "../../components/RoleMiningTitleMenu";
import {
  OutlineButton, IconButton, EmptyState, ErrorBox, SkeletonList, SearchBar, InfoRow, ConfirmModal,
} from "../../components/ui";
import { STATUS_META, ScanListItem } from "./shared";

// Same fallback the server's getRoleScanAttributeKeys uses when Schema
// Analysis hasn't been run — kept in sync with ScanForRolesPage.
const DEFAULT_ATTRIBUTE_KEYS = ["department", "location"];

const ACCESS_TYPES = [
  { type: "ROLE", label: "Roles", Icon: Layers, className: "text-violet-600" },
  { type: "ACCESS_PROFILE", label: "Access Profiles", Icon: ShieldCheck, className: "text-blue-600" },
  { type: "ENTITLEMENT", label: "Entitlements", Icon: Key, className: "text-amber-600" },
];

function attributeSourceLabelFor(source) {
  if (source === "certification-settings") return "Certification Attributes";
  if (source === "all-users") return "no Certification Attributes — one campaign for everyone in scope";
  return "Role Creation Priority Order"; // runs recorded before the all-users default
}

function accessSummary(c) {
  const excluded = c.excludedAccessCount ? ` · ${c.excludedAccessCount} excluded by filters` : "";
  return `${c.accessCount ?? 0} access item${(c.accessCount ?? 0) === 1 ? "" : "s"} (${c.roleCount ?? 0} roles · ${c.accessProfileCount ?? 0} access profiles · ${c.entitlementCount ?? 0} entitlements${excluded})`;
}

// A planned campaign that hasn't been created in ISC yet, or one whose
// creation failed and can be retried.
function canCreate(c) {
  return !!c && !c.tooLarge && c.status !== "empty" && !c.campaignId;
}

// Result status: planned (in this app only) / created in ISC / too large
// (flagged, can't be created) / failed (ISC rejected it — retryable).
const RESULT_META = {
  created: { label: "Created in ISC", tag: "bg-emerald-50 text-emerald-700", Icon: CheckCircle2, icon: "text-emerald-600" },
  generating: { label: "Generating in ISC", tag: "bg-blue-50 text-blue-700", Icon: Loader2, icon: "text-blue-600 animate-spin" },
  staged: { label: "Staged in ISC", tag: "bg-emerald-50 text-emerald-700", Icon: CheckCircle2, icon: "text-emerald-600" },
  active: { label: "Active in ISC", tag: "bg-emerald-50 text-emerald-700", Icon: CheckCircle2, icon: "text-emerald-600" },
  completed: { label: "Completed in ISC", tag: "bg-gray-100 text-gray-600", Icon: CheckCircle2, icon: "text-gray-400" },
  iscError: { label: "Error in ISC", tag: "bg-red-50 text-red-700", Icon: XCircle, icon: "text-red-600" },
  deleted: { label: "Deleted in ISC", tag: "bg-gray-100 text-gray-600", Icon: XCircle, icon: "text-gray-400" },
  "too-large": { label: "Too large", tag: "bg-amber-50 text-amber-700", Icon: AlertTriangle, icon: "text-amber-600" },
  failed: { label: "Failed", tag: "bg-red-50 text-red-700", Icon: XCircle, icon: "text-red-600" },
  planned: { label: "Not created", tag: "bg-gray-100 text-gray-600", Icon: CircleDashed, icon: "text-gray-400" },
  empty: { label: "Nothing to certify", tag: "bg-gray-100 text-gray-500", Icon: CircleDashed, icon: "text-gray-300" },
};
// Is ISC still generating this campaign's certifications?
function isGenerating(c) {
  return !!c.campaignId && (!c.campaignStatus || c.campaignStatus === "PENDING");
}
function resultMeta(c) {
  if (c.campaignId || c.status === "created") {
    const s = String(c.campaignStatus || "").toUpperCase();
    if (!s || s === "PENDING") return RESULT_META.generating;
    if (s === "STAGED") return RESULT_META.staged;
    if (s === "ACTIVATING" || s === "ACTIVE" || s === "COMPLETING") return RESULT_META.active;
    if (s === "COMPLETED" || s === "ARCHIVED") return RESULT_META.completed;
    if (s === "ERROR") return RESULT_META.iscError;
    if (s === "DELETED") return RESULT_META.deleted;
    return RESULT_META.created;
  }
  if (c.tooLarge) return RESULT_META["too-large"];
  if (c.status === "empty") return RESULT_META.empty;
  if (c.status === "failed") return RESULT_META.failed;
  return RESULT_META.planned;
}
function ResultTag({ result }) {
  const m = resultMeta(result);
  return (
    <span className={`text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full flex-shrink-0 ${m.tag}`}>
      {m.label}
    </span>
  );
}
function ResultIcon({ result }) {
  const m = resultMeta(result);
  return <m.Icon size={16} className={`${m.icon} flex-shrink-0 mt-0.5`} />;
}

// ─── Launcher ───────────────────────────────────────────────────────────────

export default function CertificationsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const start = useMutation({
    mutationFn: () => startCertificationRun(),
    onSuccess: ({ runId }) => {
      toast.success("Planning certification campaign drafts — check back here for results.");
      queryClient.invalidateQueries({ queryKey: ["certificationRuns"] });
      navigate(`/role-mining/certification-runs/${runId}`);
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const { data: runs = [] } = useQuery({
    queryKey: ["certificationRuns"],
    queryFn: listCertificationRuns,
    refetchInterval: (query) => (query.state.data?.some((r) => r.status === "running") ? 4000 : 15000),
  });

  // What a run started right now would use — read-only here, edited on
  // Studio Settings > User Certifications / Schema Analysis / Mining Config.
  const { data: prefs } = useQuery({ queryKey: ["studio-preferences"], queryFn: getStudioPreferences });
  const { data: scanSettings } = useQuery({ queryKey: ["tenant-settings"], queryFn: getTenantSettings });
  // Same rule the server applies when a run starts: the Certification
  // Attributes split the population into one campaign per combination of
  // their values, and with none chosen there is nothing to split on, so a
  // single campaign covers everyone the other criteria select.
  const attributeKeys = prefs?.certAttributeKeys?.length ? prefs.certAttributeKeys : [];
  const singleCampaign = attributeKeys.length === 0;
  const settings = describeCertSettings(prefs);

  const cancel = useMutation({
    mutationFn: (runId) => cancelCertificationRun(runId),
    onSuccess: () => {
      toast.success("Cancelling planning");
      queryClient.invalidateQueries({ queryKey: ["certificationRuns"] });
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });
  const remove = useMutation({
    mutationFn: (runId) => deleteCertificationRun(runId),
    onSuccess: () => {
      toast.success("Draft removed");
      queryClient.invalidateQueries({ queryKey: ["certificationRuns"] });
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <TopBar
        title={<RoleMiningTitleMenu active="User Certifications" />}
        action={
          <IconButton
            icon={Settings}
            title="User Certification Settings"
            onClick={() => navigate("/studio-settings/user-certifications")}
          />
        }
      />
      <div className="flex-1 overflow-y-auto pb-24">
        <div className="px-4 py-5 border-b border-gray-100">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-full bg-violet-50 flex items-center justify-center flex-shrink-0">
              <BadgeCheck size={18} className="text-violet-600" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-gray-900">User Certifications</h2>
              <p className="text-xs text-gray-500 mt-0.5">
                {singleCampaign ? (
                  <>
                    Plans a single manager-reviewed user access review covering every user the criteria below
                    select — all of their access, reviewed by their own manager. Choose Certification Attributes
                    to split that into one campaign per {"combination of their values"} instead.
                  </>
                ) : (
                  <>
                    Plans one manager-reviewed user access review per {attributeKeys.length > 1 ? "combination of " : ""}
                    {attributeKeys.map(humanizeAttributeKey).join(" and ")} — every user with those values, all of their
                    access, reviewed by their own manager.
                  </>
                )}{" "}
                Review the plan, then create any or all of the campaigns in ISC as drafts; nothing is activated
                from here, and one that would exceed the Size Limit is flagged.
              </p>
            </div>
          </div>
          <OutlineButton onClick={() => start.mutate()} loading={start.isPending}>
            <BadgeCheck size={16} />
            Create Certification Campaign Drafts
          </OutlineButton>

          <div className="mt-3 border border-gray-100 rounded-xl px-3 py-2.5 text-xs text-gray-500 space-y-1">
            <p>
              Attributes:{" "}
              <span className="font-medium text-gray-700">{singleCampaign ? "—" : attributeKeys.join(" > ")}</span>
              {" "}({singleCampaign ? "none set — one campaign for everyone in scope" : "Certification Attributes"})
            </p>
            <p>
              Scope: {scanSettings?.nameScope ? <span className="font-mono">{scanSettings.nameScope}</span> : "(No Scope Defined)"}
            </p>
            <p>
              Notifications: <span className="font-medium text-gray-700">{settings.notifications}</span>
              {" · "}Undecided Access: <span className="font-medium text-gray-700">{settings.undecidedAccess}</span>
              {" · "}Comments: <span className="font-medium text-gray-700">{settings.comments}</span>
              {" · "}Duration: <span className="font-medium text-gray-700">{settings.duration}</span>
              {" · "}Size Limit: <span className="font-medium text-gray-700">{settings.sizeLimit}</span>
            </p>
            <p>
              Campaign names:{" "}
              <span className="font-medium text-gray-700 whitespace-pre">{certificationCampaignName("{value}", prefs || undefined)}</span>
              {prefs && !prefs.certCampaignPrefix && !prefs.certCampaignSuffix && " (no prefix or suffix set)"}
            </p>
            <p>
              Filters: <span className="font-medium text-gray-700">{describeCertFilters(prefs).join("; ") || "None — all access"}</span>
            </p>
          </div>
        </div>

        {runs.length > 0 && (
          <div className="mt-2">
            <div className="px-4 py-2 flex items-center gap-2">
              <Clock size={14} className="text-gray-400" />
              <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">User Certification Campaign Drafts</h3>
            </div>
            {runs.map((r) => (
              <ScanListItem
                key={r.id}
                scan={r}
                onOpen={() => navigate(`/role-mining/certification-runs/${r.id}`)}
                onCancel={() => cancel.mutate(r.id)}
                cancelPending={cancel.isPending}
                onRemove={() => remove.mutate(r.id)}
                removePending={remove.isPending}
                detail={
                  r.status === "running"
                    ? "Scanning identities…"
                    : `${r.planned ?? 0} campaign${(r.planned ?? 0) === 1 ? "" : "s"} planned · ${r.created ?? 0} created in ISC${
                        r.tooLarge ? ` · ${r.tooLarge} too large` : ""}${r.failed ? ` · ${r.failed} failed` : ""} · ${
                        r.attributeKeys?.length
                          ? r.attributeKeys.join(" > ")
                          : r.attributeSource === "all-users" ? "all users in scope" : DEFAULT_ATTRIBUTE_KEYS.join(" > ")
                      }`
                }
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Run detail ─────────────────────────────────────────────────────────────

function RunSettingsBox({ run }) {
  const settings = describeCertSettings(run.settings);
  const attributeKeys = run.attributeKeys?.length ? run.attributeKeys : [];
  return (
    <div className="border border-gray-100 rounded-xl px-3 py-2.5 text-xs text-gray-500 space-y-1">
      <p>
        Attributes: <span className="font-medium text-gray-700">{attributeKeys.length ? attributeKeys.join(" > ") : "—"}</span>
        {run.attributeSource ? ` (${attributeSourceLabelFor(run.attributeSource)})` : ""}
        {run.scopeQuery ? <> · Scope: <span className="font-mono">{run.scopeQuery}</span></> : null}
      </p>
      <p>
        {run.totalIdentities != null ? `${run.totalIdentities} active identities scanned · ` : ""}
        <span className="font-medium text-gray-700">{run.planned ?? 0}</span> campaign{(run.planned ?? 0) === 1 ? "" : "s"} planned
        {" · "}<span className="font-medium text-emerald-700">{run.created ?? 0}</span> created in ISC
        {run.tooLarge ? <> · <span className="text-amber-700 font-medium">{run.tooLarge} too large</span></> : null}
        {run.failed ? <> · <span className="text-red-600 font-medium">{run.failed} failed</span></> : null}
      </p>
      <p>
        Reviewer: <span className="font-medium text-gray-700">each user's manager</span>
        {" · "}Duration: <span className="font-medium text-gray-700">{settings.duration}</span> (deadline set when each campaign is created)
      </p>
      <p>
        Notifications: <span className="font-medium text-gray-700">{settings.notifications}</span>
        {" · "}Undecided Access: <span className="font-medium text-gray-700">{settings.undecidedAccess}</span>
        {" · "}Comments: <span className="font-medium text-gray-700">{settings.comments}</span>
        {" · "}Size Limit: <span className="font-medium text-gray-700">{settings.sizeLimit}</span>
      </p>
      <p>
        Filters: <span className="font-medium text-gray-700">{(run.filters?.summary?.length ? run.filters.summary : describeCertFilters(run.settings)).join("; ") || "None — all access"}</span>
        {run.filters?.active && run.filters.heldItems != null
          ? <> · {run.filters.allowedItems} of {run.filters.heldItems} held access items pass</>
          : null}
      </p>
      {(run.filters?.warnings || []).map((w, i) => (
        <p key={i} className="text-amber-700">{w}</p>
      ))}
    </div>
  );
}

// What ISC says about a created campaign: certification counts once it's
// staged, and ISC's own alerts (the reason for an ERROR, or why a campaign
// completed immediately with nothing to review).
function IscFeedback({ result }) {
  if (!result.campaignId) return null;
  const s = String(result.campaignStatus || "").toUpperCase();
  const alerts = result.iscAlerts || [];
  const parts = [];
  if (!s || s === "PENDING") parts.push("ISC is generating the certifications — the campaign appears in ISC's Campaigns list as Staged once this finishes.");
  if (result.totalCertifications != null && s && s !== "PENDING") {
    parts.push(`${result.totalCertifications} certification${result.totalCertifications === 1 ? "" : "s"} generated${result.completedCertifications ? ` · ${result.completedCertifications} completed` : ""}`);
    if (result.totalCertifications === 0) parts.push("Nothing certifiable was found for this query, so ISC has nothing to review.");
  }
  if (parts.length === 0 && alerts.length === 0) return null;
  return (
    <div className="mt-1 space-y-0.5">
      {parts.map((p, i) => <p key={i} className="text-xs text-gray-500">{p}</p>)}
      {alerts.map((a, i) => <p key={`a${i}`} className="text-xs text-red-600 break-words">{a}</p>)}
    </div>
  );
}

function ResultRow({ result, onOpen, onCreate, creating, createDisabled }) {
  return (
    <div className="flex items-start gap-3 px-4 py-3 border-b border-gray-100 hover:bg-gray-50 transition-colors">
      <button onClick={onOpen} className="flex-1 min-w-0 flex items-start gap-3 text-left">
        <ResultIcon result={result} />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-gray-900 truncate">{result.name}</p>
          <p className="text-xs text-gray-500 mt-0.5">
            {result.identityCount} user{result.identityCount === 1 ? "" : "s"} · {accessSummary(result)}
          </p>
          <p className="text-xs text-gray-400 mt-0.5">{certificationCriteriaText(result)}</p>
          {result.error && (
            <p className={`text-xs mt-1 break-words ${result.tooLarge ? "text-amber-700" : "text-red-600"}`}>{result.error}</p>
          )}
          <IscFeedback result={result} />
        </div>
      </button>
      <div className="flex items-center gap-2 flex-shrink-0 mt-0.5">
        <ResultTag result={result} />
        {canCreate(result) && (
          <OutlineButton
            onClick={onCreate}
            loading={creating}
            disabled={createDisabled}
            className="!w-auto !py-1.5 !px-2.5 !text-xs"
          >
            <ClipboardPlus size={14} />
            {result.status === "failed" ? "Retry in ISC" : "Create in ISC"}
          </OutlineButton>
        )}
        <button onClick={onOpen} className="flex-shrink-0" title="Open">
          <ChevronRight size={16} className="text-gray-300" />
        </button>
      </div>
    </div>
  );
}

export function CertificationRunDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const tenant = getCredentials()?.tenant;
  const [printMenuOpen, setPrintMenuOpen] = useState(false);
  const [createAllOpen, setCreateAllOpen] = useState(false);
  const [creatingIndex, setCreatingIndex] = useState(null); // index being created right now
  const [bulkProgress, setBulkProgress] = useState(null); // { done, total } while Create All runs

  const { data: run, isLoading, error } = useQuery({
    queryKey: ["certificationRun", id],
    queryFn: () => getCertificationRun(id),
    refetchInterval: (query) => (query.state.data?.status === "running" ? 3000 : false),
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["certificationRun", id] });
    queryClient.invalidateQueries({ queryKey: ["certificationRuns"] });
  };

  // ISC status: re-read on demand (header icon) and automatically every
  // few seconds while any created campaign is still PENDING, so the row
  // moves from "Generating" to "Staged" (or shows ISC's error) on its own.
  const syncStatus = useMutation({
    mutationFn: () => syncCertificationRunStatus(id),
    onSuccess: (fresh) => queryClient.setQueryData(["certificationRun", id], fresh),
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });
  const anyGenerating = (run?.results || []).some(isGenerating);
  const anyCreated = (run?.results || []).some((r) => r.campaignId);
  useEffect(() => {
    if (!anyGenerating || syncStatus.isPending) return undefined;
    const t = setTimeout(() => syncStatus.mutate(), 4000);
    return () => clearTimeout(t);
  }, [anyGenerating, run?.results]);

  const cancel = useMutation({
    mutationFn: () => cancelCertificationRun(id),
    onSuccess: () => { toast.success("Cancelling planning"); refresh(); },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  // One campaign — the per-row icon.
  const createOne = useMutation({
    mutationFn: async (index) => {
      setCreatingIndex(index);
      return createCertificationCampaign(id, index);
    },
    onSuccess: (created) => toast.success(`Created "${created.name}" in ISC — generating certifications`),
    onError: (err) => toast.error(err.response?.data?.error || err.message),
    onSettled: () => { setCreatingIndex(null); refresh(); },
  });

  // Every eligible campaign, one at a time so each has its own outcome and
  // the list updates as it goes — same idea as Role Model Drafts' Create All.
  const createAll = useMutation({
    mutationFn: async (indexes) => {
      let ok = 0;
      let failed = 0;
      setBulkProgress({ done: 0, total: indexes.length });
      for (let i = 0; i < indexes.length; i += 1) {
        try {
          await createCertificationCampaign(id, indexes[i]);
          ok += 1;
        } catch {
          failed += 1;
        }
        setBulkProgress({ done: i + 1, total: indexes.length });
        queryClient.invalidateQueries({ queryKey: ["certificationRun", id] });
      }
      return { ok, failed };
    },
    onSuccess: ({ ok, failed }) => {
      if (failed) toast.error(`Created ${ok} of ${ok + failed} campaigns — ${failed} failed (see each row)`);
      else toast.success(`Created ${ok} campaign${ok === 1 ? "" : "s"} in ISC as drafts`);
    },
    onError: (err) => toast.error(err.message),
    onSettled: () => { setBulkProgress(null); setCreateAllOpen(false); refresh(); },
  });
  const busy = createOne.isPending || createAll.isPending;

  // Summary prints straight from what's on screen; Detailed needs every
  // campaign's members and access, so it fetches the full record first.
  const printSummary = useMutation({
    mutationFn: async () => {
      if (!printCertificationRunSummaryPdf({ tenant, run })) toast("Pop-up blocked — downloaded the PDF instead");
    },
    onSettled: () => setPrintMenuOpen(false),
    onError: (err) => toast.error(err.message),
  });
  const printDetail = useMutation({
    mutationFn: async () => {
      const full = await getCertificationRun(id, { full: true });
      if (!printCertificationRunDetailPdf({ tenant, run: full })) toast("Pop-up blocked — downloaded the PDF instead");
    },
    onSettled: () => setPrintMenuOpen(false),
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });
  const printPending = printSummary.isPending || printDetail.isPending;

  const meta = run ? (STATUS_META[run.status] || STATUS_META.running) : null;
  const StatusIcon = meta?.icon;
  const attributeKeys = run?.attributeKeys?.length ? run.attributeKeys : [];
  const results = run?.results || [];
  const creatable = results.map((r, index) => ({ r, index })).filter(({ r }) => canCreate(r));

  // Combined attributes group by the primary attribute's value
  // ("department: Engineering · 3 campaigns"); a single attribute is one section.
  const groups = useMemo(() => {
    const out = [];
    results.forEach((r, index) => {
      const g = attributeKeys.length > 1 && r.values?.length ? r.values[0].value : r.attributeKey;
      let entry = out.find((x) => x.key === g);
      if (!entry) { entry = { key: g, rows: [] }; out.push(entry); }
      entry.rows.push({ r, index });
    });
    return out;
  }, [results, attributeKeys]);

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <TopBar
        title="User Certification Campaign Drafts"
        onBack={() => navigate("/role-mining/certifications")}
        action={
          run && (
            <div className="flex items-center gap-2 relative">
              <IconButton
                icon={Settings}
                title="User Certification Settings"
                onClick={() => navigate("/studio-settings/user-certifications")}
              />
              {run.status === "running" && (
                <IconButton icon={StopCircle} title="Cancel" onClick={() => cancel.mutate()} loading={cancel.isPending} />
              )}
              {run.status !== "running" && (
                <IconButton
                  icon={ClipboardPlus}
                  title={creatable.length
                    ? `Create All Campaigns in ISC (${creatable.length})`
                    : "Create All Campaigns in ISC — nothing left to create"}
                  onClick={() => setCreateAllOpen(true)}
                  loading={createAll.isPending}
                  disabled={busy || creatable.length === 0}
                />
              )}
              {anyCreated && (
                <IconButton
                  icon={RefreshCw}
                  title="Refresh ISC status of created campaigns"
                  onClick={() => syncStatus.mutate()}
                  loading={syncStatus.isPending}
                />
              )}
              <IconButton
                icon={Printer}
                title="Print certification campaigns"
                onClick={() => setPrintMenuOpen((v) => !v)}
                loading={printPending}
                disabled={printPending || results.length === 0}
              />
              {printMenuOpen && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setPrintMenuOpen(false)} />
                  <div className="absolute right-0 top-full mt-1 w-64 bg-white border border-gray-200 rounded-xl shadow-lg z-20 overflow-hidden">
                    <button
                      onClick={() => printSummary.mutate()}
                      disabled={printPending}
                      className="w-full text-left px-4 py-3 text-sm text-gray-900 hover:bg-gray-50 disabled:opacity-50"
                    >
                      <p className="font-medium">Summary</p>
                      <p className="text-xs text-gray-500 mt-0.5">Run settings and one table of every campaign</p>
                    </button>
                    <button
                      onClick={() => printDetail.mutate()}
                      disabled={printPending}
                      className="w-full text-left px-4 py-3 text-sm text-gray-900 hover:bg-gray-50 disabled:opacity-50 border-t border-gray-100"
                    >
                      <p className="font-medium">Detailed</p>
                      <p className="text-xs text-gray-500 mt-0.5">
                        {printDetail.isPending ? "Generating…" : "Plus a section per campaign with its users and every access item"}
                      </p>
                    </button>
                  </div>
                </>
              )}
            </div>
          )
        }
      />

      {createAllOpen && (
        <ConfirmModal
          title={`Create ${creatable.length} campaign${creatable.length === 1 ? "" : "s"} in ISC?`}
          message={
            bulkProgress
              ? `Creating ${bulkProgress.done} of ${bulkProgress.total}…`
              : `Every planned campaign that isn't too large or already created will be created in ISC as a draft, with the deadline set ${describeCertSettings(run?.settings).duration} from now. Nothing is activated — review each one in ISC before starting it.`
          }
          confirmLabel="Create All"
          pending={createAll.isPending}
          onConfirm={() => createAll.mutate(creatable.map(({ index }) => index))}
          onCancel={() => !createAll.isPending && setCreateAllOpen(false)}
        />
      )}

      <div className="flex-1 overflow-y-auto pb-24">
        {isLoading && <div className="px-4 py-4"><SkeletonList rows={4} /></div>}
        {error && <div className="px-4 py-4"><ErrorBox message={error.response?.data?.error || error.message} /></div>}
        {run && (
          <>
            <div className="px-4 py-4 border-b border-gray-100">
              <div className="flex items-center gap-2 mb-2">
                {StatusIcon && <StatusIcon size={16} className={meta.className} />}
                <p className="text-sm font-medium text-gray-900">{run.status === "completed" ? "Planned" : meta.label}</p>
                <p className="text-xs text-gray-500">· started {new Date(run.startedAt).toLocaleString()}</p>
                {bulkProgress && (
                  <p className="text-xs text-blue-600 font-medium ml-auto">Creating {bulkProgress.done} of {bulkProgress.total}…</p>
                )}
              </div>
              <RunSettingsBox run={run} />
              {run.error && <div className="mt-3"><ErrorBox message={run.error} /></div>}
              {run.status !== "running" && results.length > 0 && (
                <div className="mt-3">
                  <OutlineButton
                    onClick={() => setCreateAllOpen(true)}
                    loading={createAll.isPending}
                    disabled={busy || creatable.length === 0}
                  >
                    <ClipboardPlus size={16} />
                    {creatable.length
                      ? `Create All Campaigns in ISC (${creatable.length})`
                      : "All campaigns created in ISC"}
                  </OutlineButton>
                </div>
              )}
            </div>

            {run.status !== "running" && results.length === 0 && !run.error && (
              <EmptyState
                title="No campaigns to create"
                subtitle={`No active identity in scope has a value for ${attributeKeys.map(humanizeAttributeKey).join(" or ") || "the certification attributes"}.`}
              />
            )}

            {groups.map(({ key, rows }) => (
              <div key={key} className="mt-2">
                <div className="px-4 py-2">
                  <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                    {attributeKeys.length > 1 ? `${humanizeAttributeKey(attributeKeys[0])}: ${key}` : `By ${humanizeAttributeKey(key)}`}
                    {" · "}{rows.length} campaign{rows.length === 1 ? "" : "s"}
                  </h3>
                </div>
                {rows.map(({ r, index }) => (
                  <ResultRow
                    key={`${r.attributeKey}:${r.value}`}
                    result={r}
                    onOpen={() => navigate(`/role-mining/certification-runs/${id}/campaigns/${index}`)}
                    onCreate={() => createOne.mutate(index)}
                    creating={creatingIndex === index}
                    createDisabled={busy}
                  />
                ))}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

// ─── Campaign detail ────────────────────────────────────────────────────────

function MemberRow({ member, expanded, onToggle }) {
  const counts = ACCESS_TYPES.map((t) => ({ ...t, count: member.access.filter((a) => a.type === t.type).length }));
  return (
    <div className="border-b border-gray-100">
      <button onClick={onToggle} className="w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-gray-50 transition-colors">
        {expanded ? <ChevronDown size={16} className="text-gray-400 flex-shrink-0" /> : <ChevronRight size={16} className="text-gray-400 flex-shrink-0" />}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-gray-900 truncate">{member.name || member.id}</p>
          <p className="text-xs text-gray-500 truncate">
            {member.email || "—"} · Manager: {member.manager || "—"}{member.excludedAccessCount ? ` · ${member.excludedAccessCount} excluded by filters` : ""}
          </p>
        </div>
        <div className="flex items-center gap-3 flex-shrink-0 text-xs text-gray-500">
          {counts.map(({ type, label, Icon, className, count }) => (
            <span key={type} className="flex items-center gap-1" title={label}>
              <Icon size={12} className={className} />{count}
            </span>
          ))}
        </div>
      </button>
      {expanded && (
        <div className="px-4 pb-3 pl-11 space-y-2">
          {member.access.length === 0 && <p className="text-xs text-gray-400">{member.excludedAccessCount ? "Every access item this user holds is excluded by the campaign filters." : "No access items — nothing to certify for this user."}</p>}
          {ACCESS_TYPES.map(({ type, label, Icon, className }) => {
            const items = member.access.filter((a) => a.type === type);
            if (items.length === 0) return null;
            return (
              <div key={type}>
                <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 mb-1 flex items-center gap-1">
                  <Icon size={11} className={className} />{label} · {items.length}
                </p>
                <ul className="space-y-0.5">
                  {items.map((a) => (
                    <li key={a.id} className="text-xs text-gray-700 truncate">
                      {a.name}{a.source ? <span className="text-gray-400"> · {a.source}</span> : null}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function CertificationCampaignDetailPage() {
  const { id, index } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const tenant = getCredentials()?.tenant;
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState(() => new Set());

  const { data, isLoading, error } = useQuery({
    queryKey: ["certificationRunCampaign", id, index],
    queryFn: () => getCertificationRunCampaign(id, index),
  });
  const run = data?.run;
  const campaign = data?.campaign;
  const settings = describeCertSettings(run?.settings);

  const syncStatus = useMutation({
    mutationFn: () => syncCertificationRunStatus(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["certificationRunCampaign", id, index] }),
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });
  useEffect(() => {
    if (!campaign || !isGenerating(campaign) || syncStatus.isPending) return undefined;
    const t = setTimeout(() => syncStatus.mutate(), 4000);
    return () => clearTimeout(t);
  }, [campaign?.campaignId, campaign?.campaignStatus, campaign?.statusCheckedAt]);

  const create = useMutation({
    mutationFn: () => createCertificationCampaign(id, Number(index)),
    onSuccess: (created) => {
      toast.success(`Created "${created.name}" in ISC as a draft`);
      queryClient.invalidateQueries({ queryKey: ["certificationRunCampaign", id, index] });
      queryClient.invalidateQueries({ queryKey: ["certificationRun", id] });
      queryClient.invalidateQueries({ queryKey: ["certificationRuns"] });
    },
    onError: (err) => {
      toast.error(err.response?.data?.error || err.message);
      queryClient.invalidateQueries({ queryKey: ["certificationRunCampaign", id, index] });
    },
  });

  const members = useMemo(() => {
    const all = campaign?.members || [];
    const q = search.trim().toLowerCase();
    if (!q) return all;
    return all.filter((m) =>
      [m.name, m.email, m.manager].some((v) => v && String(v).toLowerCase().includes(q)) ||
      m.access.some((a) => a.name && String(a.name).toLowerCase().includes(q))
    );
  }, [campaign, search]);

  function toggle(memberId) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(memberId)) next.delete(memberId); else next.add(memberId);
      return next;
    });
  }
  const allExpanded = members.length > 0 && members.every((m) => expanded.has(m.id));

  const print = useMutation({
    mutationFn: async () => {
      if (!printCertificationCampaignPdf({ tenant, run, campaign })) toast("Pop-up blocked — downloaded the PDF instead");
    },
    onError: (err) => toast.error(err.message),
  });

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <TopBar
        title={campaign?.name || "Campaign"}
        onBack={() => navigate(`/role-mining/certification-runs/${id}`)}
        action={
          campaign && (
            <div className="flex items-center gap-2">
              {canCreate(campaign) && (
                <IconButton
                  icon={ClipboardPlus}
                  title={campaign.status === "failed" ? "Retry creating this campaign in ISC" : "Create this campaign in ISC"}
                  onClick={() => create.mutate()}
                  loading={create.isPending}
                />
              )}
              {campaign.campaignId && (
                <IconButton icon={RefreshCw} title="Refresh ISC status" onClick={() => syncStatus.mutate()} loading={syncStatus.isPending} />
              )}
              <IconButton icon={Printer} title="Print this campaign" onClick={() => print.mutate()} loading={print.isPending} />
            </div>
          )
        }
      />
      <div className="flex-1 overflow-y-auto pb-24">
        {isLoading && <div className="px-4 py-4"><SkeletonList rows={6} /></div>}
        {error && <div className="px-4 py-4"><ErrorBox message={error.response?.data?.error || error.message} /></div>}
        {run && campaign && (
          <>
            <div className="px-4 py-4 border-b border-gray-100">
              <div className="flex items-center gap-3 mb-3">
                <div className="w-10 h-10 rounded-full bg-violet-50 flex items-center justify-center flex-shrink-0">
                  <BadgeCheck size={18} className="text-violet-600" />
                </div>
                <div className="min-w-0">
                  <h2 className="text-base font-semibold text-gray-900 truncate">{campaign.name}</h2>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {certificationCriteriaText(campaign)} · {campaign.identityCount} user{campaign.identityCount === 1 ? "" : "s"} · {accessSummary(campaign)}
                  </p>
                </div>
                <div className="ml-auto"><ResultTag result={campaign} /></div>
              </div>
              {campaign.tooLarge && campaign.error && (
                <div className="mb-3 flex items-start gap-2 border border-amber-200 bg-amber-50 rounded-xl px-3 py-2.5 text-xs text-amber-800">
                  <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
                  <p>{campaign.error} This campaign can't be created in ISC.</p>
                </div>
              )}
              {campaign.status === "failed" && campaign.error && <div className="mb-3"><ErrorBox message={campaign.error} /></div>}
              {campaign.status === "empty" && campaign.error && (
                <div className="mb-3 border border-gray-200 bg-gray-50 rounded-xl px-3 py-2.5 text-xs text-gray-600">{campaign.error}</div>
              )}
              {campaign.campaignId && <div className="mb-3"><IscFeedback result={campaign} /></div>}
              {campaign.description && (
                <p className="text-xs text-gray-600 leading-relaxed mb-3">{campaign.description}</p>
              )}
              {canCreate(campaign) && (
                <div className="mb-3">
                  <OutlineButton onClick={() => create.mutate()} loading={create.isPending}>
                    <ClipboardPlus size={16} />
                    {campaign.status === "failed" ? "Retry Creating This Campaign in ISC" : "Create This Campaign in ISC"}
                  </OutlineButton>
                </div>
              )}
              <div className="border border-gray-100 rounded-xl overflow-hidden px-4">
                <InfoRow label="Type" value="Search campaign (identities)" />
                <InfoRow label="Reviewer" value="Each user's manager" />
                <InfoRow label="Deadline" value={campaign.deadline ? `${new Date(campaign.deadline).toLocaleDateString()} (${settings.duration})` : `${settings.duration} from creation`} />
                <InfoRow label="Notifications" value={settings.notifications} />
                <InfoRow label="Undecided Access" value={settings.undecidedAccess} />
                <InfoRow label="Require Comments" value={settings.comments} />
                <InfoRow label="Size Limit" value={`${settings.sizeLimit} access items`} />
                <InfoRow label="Filters" value={(run.filters?.summary?.length ? run.filters.summary : describeCertFilters(run.settings)).join("; ") || "None — all access"} />
                <InfoRow label="Excluded by filters" value={campaign.excludedAccessCount ? `${campaign.excludedAccessCount} access items` : undefined} />
                <InfoRow label="ISC status" value={campaign.campaignId ? resultMeta(campaign).label + (campaign.campaignStatus ? ` (${campaign.campaignStatus})` : "") : campaign.tooLarge ? "Not created — too large" : "Not created yet"} />
                <InfoRow label="Certifications generated" value={campaign.totalCertifications != null ? String(campaign.totalCertifications) : undefined} />
                <InfoRow label="ISC alerts" value={(campaign.iscAlerts || []).join(" · ") || undefined} />
                <InfoRow label="Status checked" value={campaign.statusCheckedAt ? new Date(campaign.statusCheckedAt).toLocaleString() : undefined} />
                <InfoRow label="ISC campaign ID" value={campaign.campaignId} />
                <InfoRow label="Created in ISC" value={campaign.createdAt ? new Date(campaign.createdAt).toLocaleString() : undefined} />
                <InfoRow label="Search query" value={campaign.query} />
              </div>
            </div>

            <div className="pr-4 flex items-center">
              <div className="flex-1 min-w-0">
                <SearchBar value={search} onChange={setSearch} placeholder="Search users or access items…" />
              </div>
              <IconButton
                icon={allExpanded ? ChevronsDownUp : ChevronsUpDown}
                title={allExpanded ? "Collapse all" : "Expand all"}
                onClick={() => setExpanded(allExpanded ? new Set() : new Set(members.map((m) => m.id)))}
              />
            </div>
            <div className="px-4 pb-1">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                Users · {members.length}{search ? ` of ${campaign.members?.length ?? 0}` : ""}
              </p>
            </div>
            {members.length === 0 ? (
              <EmptyState title="No users" subtitle={search ? `No users or access items match "${search}"` : "This campaign has no members."} />
            ) : (
              members.map((m) => (
                <MemberRow key={m.id} member={m} expanded={expanded.has(m.id)} onToggle={() => toggle(m.id)} />
              ))
            )}
          </>
        )}
      </div>
    </div>
  );
}
