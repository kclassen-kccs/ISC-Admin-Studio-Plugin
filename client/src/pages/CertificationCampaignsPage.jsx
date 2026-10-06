import { useMemo, useState, useSyncExternalStore } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BadgeCheck, Play, Printer, RefreshCw, ChevronRight, ChevronDown, ChevronsUpDown, ChevronsDownUp, Braces, Info, Users, Key, Layers, ShieldCheck, Trash2, Settings, ScanSearch, FileDown } from "lucide-react";
import toast from "react-hot-toast";
import {
  listAllCampaigns, getCampaign, activateCampaign, deleteCampaigns, listCampaignReviewItems, getCredentials,
} from "../lib/sailpoint";
import {
  startRemediationScans, subscribeScanJobs, getScanJobsSnapshot, isScanJobActive, clearFinishedScanJobs,
} from "../lib/campaignScanJobs";
import { CampaignReportsModal } from "../components/CampaignReportsModal";
import {
  CAMPAIGN_STATUS_ORDER, campaignStatusLabel, campaignStatusTone, campaignTypeLabel, campaignScopeText, canStartCampaign,
  summarizeReviewItems, accessTypeLabel,
} from "../lib/campaigns";
import { printCampaignListPdf, printCampaignsDetailPdf } from "../lib/exportCampaignsPdf";
import { useUrlSearch } from "../hooks/useUrlSearch";
import { useUrlState } from "../hooks/useUrlState";
import { TopBar } from "../components/TopBar";
import { BrowseTitleMenu } from "../components/BrowseTitleMenu";
import { RawJsonPanel } from "../components/RawJsonPanel";
import {
  SkeletonList, ErrorBox, EmptyState, SearchBar, FilterBar, ConfirmModal, SelectionActionBar, IconButton, InfoRow, OutlineButton, Spinner,
} from "../components/ui";
import { usePagedList } from "../hooks/usePagedList";

const IN_FLIGHT = new Set(["PENDING", "ACTIVATING", "COMPLETING", "CANCELING"]);

// Status filter pills. "Active" also covers the transitional activating /
// completing states so a campaign never vanishes from the pill mid-change.
const STATUS_PILLS = [
  { value: "ALL", label: "All", statuses: null },
  { value: "STAGED", label: "Staged", statuses: ["STAGED"] },
  { value: "ACTIVE", label: "Active", statuses: ["ACTIVE", "ACTIVATING", "COMPLETING"] },
  { value: "COMPLETED", label: "Completed", statuses: ["COMPLETED"] },
  { value: "ERROR", label: "Error", statuses: ["ERROR"] },
];

function StatusPill({ status }) {
  return (
    <span className={`text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full flex-shrink-0 ${campaignStatusTone(status)}`}>
      {campaignStatusLabel(status)}
    </span>
  );
}

function groupByStatus(campaigns) {
  // Status groups follow the lifecycle; within a group, alphabetical.
  const byName = (a, b) => String(a.name || "").localeCompare(String(b.name || ""), undefined, { sensitivity: "base", numeric: true });
  const known = CAMPAIGN_STATUS_ORDER.map((g) => ({ ...g, campaigns: campaigns.filter((c) => String(c.status || "").toUpperCase() === g.status).sort(byName) }));
  const knownSet = new Set(CAMPAIGN_STATUS_ORDER.map((g) => g.status));
  const other = campaigns.filter((c) => !knownSet.has(String(c.status || "").toUpperCase()));
  if (other.length) known.push({ status: "OTHER", label: "Other", campaigns: other });
  return known.filter((g) => g.campaigns.length > 0);
}

// Activates campaigns one at a time so each has its own outcome; only STAGED
// campaigns can be started — anything else in the selection is skipped.
function useStartCampaigns(onDone) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (campaigns) => {
      const startable = campaigns.filter(canStartCampaign);
      let ok = 0;
      const failures = [];
      for (const c of startable) {
        try { await activateCampaign(c.id); ok += 1; } catch (err) { failures.push(`${c.name}: ${err.response?.data?.error || err.message}`); }
      }
      return { ok, failures, skipped: campaigns.length - startable.length };
    },
    onSuccess: ({ ok, failures, skipped }) => {
      if (ok) toast.success(`Started ${ok} campaign${ok === 1 ? "" : "s"}${skipped ? ` — ${skipped} skipped (not staged)` : ""}`);
      else if (skipped && !failures.length) toast(`Nothing started — ${skipped} selected campaign${skipped === 1 ? " isn't" : "s aren't"} staged`);
      for (const f of failures) toast.error(f);
      queryClient.invalidateQueries({ queryKey: ["campaigns"] });
      queryClient.invalidateQueries({ queryKey: ["campaign"] });
      onDone?.();
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });
}

// Remediation scans and the campaign reports only exist for a finished
// campaign — anything else in a selection is skipped, the way Start skips
// campaigns that aren't staged.
const isCompletedCampaign = (c) => String(c?.status || "").toUpperCase() === "COMPLETED";

// Requests ISC's remediation scan for each campaign (it re-checks every
// revoked item against its source and updates the remediation status). With
// `regenerate`, each campaign is handed to a background job that waits for
// its scan to finish and then regenerates all four reports — see
// lib/campaignScanJobs.js for how "finished" is detected, since ISC doesn't
// say. Resolves once the scans are requested, not once the jobs are done.
function useRemediationScans(onDone) {
  return useMutation({
    mutationFn: ({ campaigns, regenerate }) => startRemediationScans(campaigns, { regenerate }).then((started) => ({ started, regenerate })),
    onSuccess: ({ started, regenerate }) => {
      if (started.length) {
        toast.success(
          regenerate
            ? `Remediation scan started for ${started.length} campaign${started.length === 1 ? "" : "s"} — the reports regenerate automatically when it finishes`
            : `Remediation scan started for ${started.length} campaign${started.length === 1 ? "" : "s"}`,
          { duration: 6000 }
        );
      }
      onDone?.(started, regenerate);
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });
}

// Deletes campaigns via ISC's bulk endpoint. ISC accepts the request and
// deletes in the background, so the list is refetched again shortly after.
function useDeleteCampaigns(onDone) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (campaigns) => deleteCampaigns(campaigns.map((c) => c.id)),
    onSuccess: (_data, campaigns) => {
      toast.success(`Deleting ${campaigns.length} campaign${campaigns.length === 1 ? "" : "s"} in ISC`);
      queryClient.invalidateQueries({ queryKey: ["campaigns"] });
      setTimeout(() => queryClient.invalidateQueries({ queryKey: ["campaigns"] }), 4000);
      onDone?.();
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });
}

// ─── List ───────────────────────────────────────────────────────────────────

export default function CertificationCampaignsPage() {
  const navigate = useNavigate();
  const tenant = getCredentials()?.tenant;
  const { search, debouncedSearch, handleSearch } = useUrlSearch();
  const [statusFilter, setStatusFilter] = useUrlState("status", "ALL");
  const [selected, setSelected] = useState(() => new Set());
  const [startConfirm, setStartConfirm] = useState(null); // campaigns[] | null
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [scanConfirm, setScanConfirm] = useState(null); // campaigns[] | null
  const [scanRegenerate, setScanRegenerate] = useState(true); // the confirm's checkbox; on by default
  const scanJobs = useSyncExternalStore(subscribeScanJobs, getScanJobsSnapshot);
  const [reportsFor, setReportsFor] = useState(null); // { campaigns, stale } | null
  const [staleReminder, setStaleReminder] = useState(null); // campaigns[] just scanned | null

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["campaigns"],
    queryFn: listAllCampaigns,
    refetchInterval: (query) => (query.state.data?.some((c) => IN_FLIGHT.has(String(c.status || "").toUpperCase())) ? 10000 : false),
  });
  const campaigns = useMemo(() => (Array.isArray(data) ? data : []), [data]);

  const list = useMemo(() => {
    const pill = STATUS_PILLS.find((p) => p.value === statusFilter) || STATUS_PILLS[0];
    const byStatus = pill.statuses ? campaigns.filter((c) => pill.statuses.includes(String(c.status || "").toUpperCase())) : campaigns;
    const q = debouncedSearch.trim().toLowerCase();
    if (!q) return byStatus;
    return byStatus.filter((c) =>
      [c.name, c.description, campaignTypeLabel(c.type), campaignStatusLabel(c.status)].some((v) => v && String(v).toLowerCase().includes(q))
    );
  }, [campaigns, debouncedSearch, statusFilter]);
  const countFor = (pill) => (pill.statuses ? campaigns.filter((c) => pill.statuses.includes(String(c.status || "").toUpperCase())).length : campaigns.length);
  // Paged first, then grouped: each page's own rows are grouped by status,
  // so the status headings still read correctly on every page.
  const { page, pager } = usePagedList(list, { noun: "campaign", resetKey: `${debouncedSearch}|${statusFilter}` });
  const groups = useMemo(() => groupByStatus(page), [page]);
  const allSelected = list.length > 0 && list.every((c) => selected.has(c.id));
  const selectedCampaigns = list.filter((c) => selected.has(c.id));
  const startableSelected = selectedCampaigns.filter(canStartCampaign);
  const completedSelected = selectedCampaigns.filter(isCompletedCampaign);

  const start = useStartCampaigns(() => { setStartConfirm(null); setSelected(new Set()); });
  const remove = useDeleteCampaigns(() => { setDeleteConfirm(false); setSelected(new Set()); });
  // A scan changes the remediation data the reports are built from, so every
  // existing report file for those campaigns is now out of date — say so,
  // rather than leaving it to a toast that's gone in a few seconds.
  // With auto-regenerate off, that's left to the user — so remind them.
  const scan = useRemediationScans((scanned, regenerate) => {
    setScanConfirm(null);
    if (scanned?.length && !regenerate) setStaleReminder(scanned);
  });

  const printList = useMutation({
    mutationFn: async () => {
      if (!printCampaignListPdf({ tenant, groups, title: debouncedSearch ? `Certification Campaigns — "${debouncedSearch}"` : "Certification Campaigns" })) {
        toast("Pop-up blocked — downloaded the PDF instead");
      }
    },
    onError: (err) => toast.error(err.message),
  });
  // Print Selected pulls each campaign's full record and its certifications
  // so the detail pages match the detail screen.
  const printSelected = useMutation({
    mutationFn: async () => {
      const full = [];
      const items = {};
      for (const c of selectedCampaigns) {
        full.push(await getCampaign(c.id));
        try { items[c.id] = await listCampaignReviewItems(c.id); } catch { items[c.id] = []; }
      }
      if (!printCampaignsDetailPdf({ tenant, campaigns: full, reviewItemsById: items })) toast("Pop-up blocked — downloaded the PDF instead");
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  function toggle(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <TopBar
        title={<BrowseTitleMenu active="User Certifications" />}
        loading={isLoading}
        action={
          <div className="flex items-center gap-2">
            <IconButton
              icon={Settings}
              title="User Certification Settings"
              onClick={() => navigate("/studio-settings/user-certifications")}
            />
            <IconButton icon={RefreshCw} title="Refresh" onClick={() => refetch()} loading={isFetching && !isLoading} />
            <IconButton
              icon={Printer}
              title="Print campaign list"
              onClick={() => printList.mutate()}
              loading={printList.isPending}
              disabled={list.length === 0}
            />
          </div>
        }
      />
      <div className="flex-1 overflow-y-auto pb-24">
        <SearchBar value={search} onChange={handleSearch} placeholder="Search campaigns by name, type, or status…" />
        <FilterBar
          options={STATUS_PILLS.map((p) => ({ value: p.value, label: campaigns.length ? `${p.label} (${countFor(p)})` : p.label }))}
          active={statusFilter}
          onChange={(v) => { setStatusFilter(v); setSelected(new Set()); }}
        />

        {scanJobs.length > 0 && (
          <div className="mx-4 mb-2 border border-blue-100 bg-blue-50 rounded-xl px-3 py-2.5 text-xs text-blue-900">
            <div className="flex items-center justify-between gap-3">
              <p className="font-medium flex items-center gap-2">
                {scanJobs.some(isScanJobActive) && <Spinner size={12} />}
                Remediation scans
              </p>
              {scanJobs.some((j) => !isScanJobActive(j)) && (
                <button type="button" onClick={clearFinishedScanJobs} className="text-blue-700 hover:underline">Clear finished</button>
              )}
            </div>
            <ul className="mt-1.5 space-y-1">
              {scanJobs.map((j) => (
                <li key={j.id} className={j.state === "failed" ? "text-red-700" : ""}>
                  <span className="font-medium">{j.name}</span> — {j.note}
                </li>
              ))}
            </ul>
          </div>
        )}

        {error && <ErrorBox message={error.response?.data?.error || error.message} onRetry={refetch} />}
        {isLoading && <SkeletonList rows={6} />}
        {!isLoading && !error && list.length === 0 && (
          <EmptyState
            icon={BadgeCheck}
            title={search || statusFilter !== "ALL" ? "No results" : "No campaigns"}
            subtitle={search ? `No campaigns match "${search}"` : statusFilter !== "ALL" ? `No ${STATUS_PILLS.find((p) => p.value === statusFilter)?.label?.toLowerCase() || ""} campaigns` : "This tenant has no certification campaigns yet — draft some under Mining → Certifications"}
          />
        )}

        {!isLoading && list.length > 0 && (
          <>
            <div className="flex items-center justify-between px-4 py-2 gap-3">
              <label className="flex items-center gap-2 text-xs text-gray-500">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={() => setSelected(allSelected ? new Set() : new Set(list.map((c) => c.id)))}
                  className="w-4 h-4 rounded border-gray-300"
                />
                Select all shown
              </label>
              <p className="text-xs text-gray-400">{list.length} campaign{list.length === 1 ? "" : "s"}</p>
            </div>

            {selected.size > 0 && (
              <SelectionActionBar
                count={selected.size}
                actions={[
                  {
                    icon: Play,
                    title: startableSelected.length
                      ? `Start (${startableSelected.length} staged)`
                      : "Start — none of the selected campaigns are staged",
                    onClick: () => setStartConfirm(startableSelected),
                    disabled: startableSelected.length === 0 || start.isPending,
                    loading: start.isPending,
                  },
                  {
                    icon: ScanSearch,
                    title: completedSelected.length
                      ? `Run campaign remediation scan (${completedSelected.length} completed)`
                      : "Run campaign remediation scan — none of the selected campaigns are completed",
                    onClick: () => { setScanRegenerate(true); setScanConfirm(completedSelected); },
                    disabled: completedSelected.length === 0 || scan.isPending,
                    loading: scan.isPending,
                  },
                  {
                    icon: FileDown,
                    title: completedSelected.length
                      ? `Get Campaign Reports — PDF or CSV (${completedSelected.length} completed)`
                      : "Get Campaign Reports — none of the selected campaigns are completed",
                    onClick: () => setReportsFor({ campaigns: completedSelected, stale: false }),
                    disabled: completedSelected.length === 0,
                  },
                  {
                    icon: Printer,
                    title: `Print Detail for Selected (${selected.size})`,
                    onClick: () => printSelected.mutate(),
                    loading: printSelected.isPending,
                    disabled: printSelected.isPending,
                  },
                  {
                    icon: Trash2,
                    title: `Delete Selected Campaigns (${selected.size})`,
                    onClick: () => setDeleteConfirm(true),
                    loading: remove.isPending,
                    disabled: remove.isPending,
                    danger: true,
                  },
                ]}
              />
            )}

            {pager}
            {groups.map((g) => (
              <div key={g.status} className="mt-2">
                <div className="px-4 py-2 flex items-center gap-2">
                  <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">{g.label}</h3>
                  <span className="text-xs text-gray-400">· {g.campaigns.length}</span>
                </div>
                {g.campaigns.map((c) => (
                  <div key={c.id} className="w-full flex items-center gap-3 px-4 py-3 border-b border-gray-100 hover:bg-gray-50 transition-colors">
                    <input
                      type="checkbox"
                      checked={selected.has(c.id)}
                      onChange={() => toggle(c.id)}
                      className="w-4 h-4 rounded border-gray-300 flex-shrink-0"
                    />
                    <button onClick={() => navigate(`/certifications/${c.id}`)} className="flex-1 min-w-0 flex items-center gap-3 text-left">
                      <div className="w-10 h-10 rounded-full bg-violet-50 flex items-center justify-center flex-shrink-0">
                        <BadgeCheck size={16} className="text-violet-600" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-900 truncate">{c.name}</p>
                        <p className="text-xs text-gray-500 truncate mt-0.5">
                          {campaignTypeLabel(c.type)}
                          {c.deadline ? ` · due ${new Date(c.deadline).toLocaleDateString()}` : ""}
                          {c.totalCertifications != null ? ` · ${c.completedCertifications ?? 0} / ${c.totalCertifications} certifications done` : ""}
                        </p>
                      </div>
                    </button>
                    <StatusPill status={c.status} />
                    {canStartCampaign(c) && (
                      <IconButton icon={Play} title="Start this campaign" onClick={() => setStartConfirm([c])} disabled={start.isPending} />
                    )}
                    <button onClick={() => navigate(`/certifications/${c.id}`)} className="flex-shrink-0" title="Open">
                      <ChevronRight size={16} className="text-gray-300" />
                    </button>
                  </div>
                ))}
              </div>
            ))}
            {pager}
          </>
        )}
      </div>

      {deleteConfirm && (
        <ConfirmModal
          title={`Delete ${selectedCampaigns.length} campaign${selectedCampaigns.length === 1 ? "" : "s"}?`}
          message={`This permanently deletes ${selectedCampaigns.length === 1 ? `"${selectedCampaigns[0].name}"` : "the selected campaigns"} from ISC, along with their certifications and any decisions already made. ISC may refuse a campaign that is currently active. This cannot be undone.`}
          confirmLabel="Delete"
          danger
          pending={remove.isPending}
          onConfirm={() => remove.mutate(selectedCampaigns)}
          onCancel={() => !remove.isPending && setDeleteConfirm(false)}
        />
      )}

      {scanConfirm && (
        <ConfirmModal
          title={`Run remediation scan on ${scanConfirm.length} campaign${scanConfirm.length === 1 ? "" : "s"}?`}
          message={`ISC re-checks every revoked item in ${scanConfirm.length === 1 ? `"${scanConfirm[0].name}"` : "these completed campaigns"} against its source and updates each item's remediation status. It runs in the background and changes no access itself.${selectedCampaigns.length > scanConfirm.length ? ` ${selectedCampaigns.length - scanConfirm.length} selected campaign${selectedCampaigns.length - scanConfirm.length === 1 ? " isn't" : "s aren't"} completed and will be skipped.` : ""}`}
          confirmLabel="Run Scan"
          pending={scan.isPending}
          onConfirm={() => scan.mutate({ campaigns: scanConfirm, regenerate: scanRegenerate })}
          onCancel={() => !scan.isPending && setScanConfirm(null)}
        >
          <label className="flex items-start gap-2.5 mb-4 cursor-pointer">
            <input
              type="checkbox"
              checked={scanRegenerate}
              onChange={() => setScanRegenerate((v) => !v)}
              disabled={scan.isPending}
              className="w-4 h-4 mt-0.5 rounded border-gray-300"
            />
            <span>
              <span className="block text-sm text-gray-800">Automatically regenerate the campaign reports when the scan finishes</span>
              <span className="block text-xs text-gray-500 mt-0.5">
                The scan makes the existing reports stale. All four are regenerated for each campaign once its scan is done. ISC doesn't announce
                when a scan finishes, so this watches the campaign for up to 5 minutes and regenerates anyway if it can't tell. Keep this app open — a page reload stops the watch.
              </span>
            </span>
          </label>
        </ConfirmModal>
      )}

      {staleReminder && (
        <ConfirmModal
          title="Regenerate the campaign reports"
          message={`The remediation scan was started for ${staleReminder.length === 1 ? `"${staleReminder[0].name}"` : `${staleReminder.length} campaigns`}. The reports ISC already holds for ${staleReminder.length === 1 ? "it were" : "them were"} built before the scan, so they're now stale — the Campaign Remediation Status Report especially. Give the scan a few minutes to finish, then generate fresh reports before downloading.`}
          confirmLabel="Generate Reports…"
          onConfirm={() => { setReportsFor({ campaigns: staleReminder, stale: true }); setStaleReminder(null); }}
          onCancel={() => setStaleReminder(null)}
        />
      )}

      {reportsFor && <CampaignReportsModal campaigns={reportsFor.campaigns} stale={reportsFor.stale} onClose={() => setReportsFor(null)} />}

      {startConfirm && (
        <ConfirmModal
          title={`Start ${startConfirm.length} campaign${startConfirm.length === 1 ? "" : "s"}?`}
          message={`Activating ${startConfirm.length === 1 ? `"${startConfirm[0].name}"` : "these campaigns"} assigns the certifications to their reviewers${startConfirm.some((c) => c.emailNotificationEnabled) ? " and sends notification emails" : ""}. This cannot be undone from here.`}
          confirmLabel="Start"
          pending={start.isPending}
          onConfirm={() => start.mutate(startConfirm)}
          onCancel={() => !start.isPending && setStartConfirm(null)}
        />
      )}
    </div>
  );
}

// ─── Detail ─────────────────────────────────────────────────────────────────

const DETAIL_TABS = [
  { key: "details", label: "Details", Icon: Info },
  { key: "users", label: "Users", Icon: Users },
  { key: "items", label: "Access Items", Icon: Key },
  { key: "json", label: "JSON", Icon: Braces },
];

const TYPE_ICONS = { ROLE: Layers, ACCESS_PROFILE: ShieldCheck, ENTITLEMENT: Key };
function TypeIcon({ type, size = 12 }) {
  const Icon = TYPE_ICONS[String(type || "").toUpperCase()] || Key;
  const cls = type === "ROLE" ? "text-violet-600" : type === "ACCESS_PROFILE" ? "text-blue-600" : "text-amber-600";
  return <Icon size={size} className={`${cls} flex-shrink-0`} />;
}

function DecisionPill({ decision, decided }) {
  if (!decided) return <span className="text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full bg-gray-100 text-gray-500 flex-shrink-0">Open</span>;
  const d = String(decision || "").toUpperCase();
  const cls = d === "REVOKE" ? "bg-red-50 text-red-700" : "bg-emerald-50 text-emerald-700";
  return <span className={`text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full flex-shrink-0 ${cls}`}>{d || "Decided"}</span>;
}

// One expandable row: header content on top, children when open.
function ExpandableRow({ expanded, onToggle, title, subtitle, right, children }) {
  return (
    <div className="border-b border-gray-100">
      <button onClick={onToggle} className="w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-gray-50 transition-colors">
        {expanded ? <ChevronDown size={16} className="text-gray-400 flex-shrink-0" /> : <ChevronRight size={16} className="text-gray-400 flex-shrink-0" />}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-gray-900 truncate">{title}</p>
          {subtitle && <p className="text-xs text-gray-500 truncate">{subtitle}</p>}
        </div>
        {right}
      </button>
      {expanded && <div className="px-4 pb-3 pl-11">{children}</div>}
    </div>
  );
}

function useExpanded() {
  const [expanded, setExpanded] = useState(() => new Set());
  const toggle = (id) => setExpanded((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  return { expanded, toggle, setExpanded };
}

function ReviewItemsEmpty({ campaign, error }) {
  if (error) return <div className="px-4 py-4"><ErrorBox message={error.response?.data?.error || error.message} /></div>;
  const s = String(campaign?.status || "").toUpperCase();
  return (
    <EmptyState
      title="No review items yet"
      subtitle={s === "PENDING" ? "ISC is still generating this campaign's certifications — check back shortly." : "ISC has not generated any review items for this campaign."}
    />
  );
}

function UsersTab({ campaign, summary, isLoading, error }) {
  const [search, setSearch] = useState("");
  const { expanded, toggle, setExpanded } = useExpanded();
  const users = useMemo(() => {
    const all = summary?.users || [];
    const q = search.trim().toLowerCase();
    if (!q) return all;
    return all.filter((u) => [u.name, u.reviewer].some((v) => v && String(v).toLowerCase().includes(q)) || u.items.some((i) => String(i.name).toLowerCase().includes(q)));
  }, [summary, search]);
  if (isLoading) return <div className="px-4 py-4"><SkeletonList rows={5} /></div>;
  if (error || !summary?.users?.length) return <ReviewItemsEmpty campaign={campaign} error={error} />;
  const allExpanded = users.length > 0 && users.every((u) => expanded.has(u.id));
  return (
    <>
      <div className="pr-4 flex items-center">
        <div className="flex-1 min-w-0"><SearchBar value={search} onChange={setSearch} placeholder="Search users, reviewers, or access items…" /></div>
        <IconButton icon={allExpanded ? ChevronsDownUp : ChevronsUpDown} title={allExpanded ? "Collapse all" : "Expand all"} onClick={() => setExpanded(allExpanded ? new Set() : new Set(users.map((u) => u.id)))} />
      </div>
      <p className="px-4 pb-1 text-xs font-semibold text-gray-500 uppercase tracking-wide">Users · {users.length}{search ? ` of ${summary.users.length}` : ""}</p>
      {users.map((u) => (
        <ExpandableRow
          key={u.id}
          expanded={expanded.has(u.id)}
          onToggle={() => toggle(u.id)}
          title={u.name}
          subtitle={`Reviewer: ${u.reviewer || "—"} · ${u.items.length} access item${u.items.length === 1 ? "" : "s"} · ${u.items.filter((i) => i.decided).length} decided`}
        >
          <ul className="space-y-1">
            {u.items.map((i) => (
              <li key={`${u.id}:${i.id}`} className="flex items-center gap-2 text-xs text-gray-700">
                <TypeIcon type={i.type} />
                <span className="truncate flex-1">{i.name}{i.source ? <span className="text-gray-400"> · {i.source}</span> : null}</span>
                <span className="text-gray-400 flex-shrink-0">{accessTypeLabel(i.type)}</span>
                <DecisionPill decision={i.decision} decided={i.decided} />
              </li>
            ))}
          </ul>
        </ExpandableRow>
      ))}
    </>
  );
}

function AccessItemsTab({ campaign, summary, isLoading, error }) {
  const [search, setSearch] = useState("");
  const { expanded, toggle, setExpanded } = useExpanded();
  const items = useMemo(() => {
    const all = summary?.access || [];
    const q = search.trim().toLowerCase();
    if (!q) return all;
    return all.filter((a) => [a.name, a.source, accessTypeLabel(a.type)].some((v) => v && String(v).toLowerCase().includes(q)) || a.users.some((u) => String(u.name).toLowerCase().includes(q)));
  }, [summary, search]);
  if (isLoading) return <div className="px-4 py-4"><SkeletonList rows={5} /></div>;
  if (error || !summary?.access?.length) return <ReviewItemsEmpty campaign={campaign} error={error} />;
  const allExpanded = items.length > 0 && items.every((a) => expanded.has(a.id));
  return (
    <>
      <div className="pr-4 flex items-center">
        <div className="flex-1 min-w-0"><SearchBar value={search} onChange={setSearch} placeholder="Search access items, sources, or users…" /></div>
        <IconButton icon={allExpanded ? ChevronsDownUp : ChevronsUpDown} title={allExpanded ? "Collapse all" : "Expand all"} onClick={() => setExpanded(allExpanded ? new Set() : new Set(items.map((a) => a.id)))} />
      </div>
      <p className="px-4 pb-1 text-xs font-semibold text-gray-500 uppercase tracking-wide">Access items · {items.length}{search ? ` of ${summary.access.length}` : ""}</p>
      {items.map((a) => (
        <ExpandableRow
          key={a.id}
          expanded={expanded.has(a.id)}
          onToggle={() => toggle(a.id)}
          title={<span className="flex items-center gap-2"><TypeIcon type={a.type} size={14} /><span className="truncate">{a.name}</span></span>}
          subtitle={`${accessTypeLabel(a.type)}${a.source ? ` · ${a.source}` : ""}${a.privileged ? " · privileged" : ""} · ${a.users.length} user${a.users.length === 1 ? "" : "s"} · ${a.users.filter((u) => u.decided).length} decided`}
        >
          <ul className="space-y-1">
            {a.users.map((u) => (
              <li key={`${a.id}:${u.id}`} className="flex items-center gap-2 text-xs text-gray-700">
                <Users size={12} className="text-gray-400 flex-shrink-0" />
                <span className="truncate flex-1">{u.name}{u.reviewer ? <span className="text-gray-400"> · reviewer {u.reviewer}</span> : null}</span>
                <DecisionPill decision={u.decision} decided={u.decided} />
              </li>
            ))}
          </ul>
        </ExpandableRow>
      ))}
    </>
  );
}

export function CampaignDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const tenant = getCredentials()?.tenant;
  const [tab, setTab] = useUrlState("tab", "details");
  const [startConfirm, setStartConfirm] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);

  const { data: c, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["campaign", id],
    queryFn: () => getCampaign(id),
    refetchInterval: (query) => (IN_FLIGHT.has(String(query.state.data?.status || "").toUpperCase()) ? 8000 : false),
  });
  // Users and Access Items both come from the same review items, fetched
  // once and only when one of those tabs (or a print) needs them.
  const reviewItems = useQuery({
    queryKey: ["campaign-review-items", id],
    queryFn: () => listCampaignReviewItems(id),
    enabled: !!c && (tab === "users" || tab === "items"),
    staleTime: 60_000,
  });
  const summary = useMemo(() => (reviewItems.data ? summarizeReviewItems(reviewItems.data) : null), [reviewItems.data]);

  const start = useStartCampaigns(() => setStartConfirm(false));
  const remove = useDeleteCampaigns(() => { setDeleteConfirm(false); navigate("/certifications"); });
  const print = useMutation({
    mutationFn: async () => {
      let rows = reviewItems.data;
      if (!rows) { try { rows = await listCampaignReviewItems(id); } catch { rows = []; } }
      if (!printCampaignsDetailPdf({ tenant, campaigns: [c], reviewItemsById: { [c.id]: rows } })) toast("Pop-up blocked — downloaded the PDF instead");
    },
    onError: (err) => toast.error(err.message),
  });

  const alerts = (c?.alerts || []).map((a) => a.localizations?.[0]?.text || a.text || a.level || JSON.stringify(a));

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <TopBar
        title="Campaign"
        onBack={() => navigate("/certifications")}
        action={
          c && (
            <div className="flex items-center gap-2">
              {canStartCampaign(c) && (
                <IconButton icon={Play} title="Start this campaign" onClick={() => setStartConfirm(true)} loading={start.isPending} />
              )}
              <IconButton icon={RefreshCw} title="Refresh" onClick={() => { refetch(); if (reviewItems.data) reviewItems.refetch(); }} loading={isFetching && !isLoading} />
              <IconButton icon={Printer} title="Print this campaign" onClick={() => print.mutate()} loading={print.isPending} />
              <IconButton
                icon={Trash2}
                title="Delete this campaign"
                onClick={() => setDeleteConfirm(true)}
                loading={remove.isPending}
                className="!border-red-200 !text-red-600 hover:!bg-red-50"
              />
            </div>
          )
        }
      />
      <div className="flex-1 overflow-y-auto pb-24">
        {isLoading && <div className="px-4 py-4"><SkeletonList rows={6} /></div>}
        {error && <div className="px-4 py-4"><ErrorBox message={error.response?.data?.error || error.message} onRetry={refetch} /></div>}
        {c && (
          <>
            <div className="px-4 py-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-violet-50 flex items-center justify-center flex-shrink-0">
                  <BadgeCheck size={18} className="text-violet-600" />
                </div>
                <div className="min-w-0 flex-1">
                  <h2 className="text-base font-semibold text-gray-900 truncate">{c.name}</h2>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {campaignTypeLabel(c.type)}{c.deadline ? ` · due ${new Date(c.deadline).toLocaleDateString()}` : ""}
                    {c.totalCertifications != null ? ` · ${c.completedCertifications ?? 0} / ${c.totalCertifications} certifications done` : ""}
                  </p>
                </div>
                <StatusPill status={c.status} />
              </div>
              {c.description && <p className="text-xs text-gray-600 leading-relaxed mt-3">{c.description}</p>}
              {alerts.length > 0 && (
                <div className="mt-3 border border-red-200 bg-red-50 rounded-xl px-3 py-2.5 text-xs text-red-700 space-y-0.5">
                  {alerts.map((a, i) => <p key={i}>{a}</p>)}
                </div>
              )}
              {canStartCampaign(c) && (
                <div className="mt-3">
                  <OutlineButton onClick={() => setStartConfirm(true)} loading={start.isPending}>
                    <Play size={16} />
                    Start This Campaign
                  </OutlineButton>
                </div>
              )}
            </div>

            <div className="flex border-t border-gray-100">
              <div className="w-28 flex-shrink-0 border-r border-gray-100 py-2">
                {DETAIL_TABS.map(({ key, label, Icon }) => (
                  <button
                    key={key}
                    onClick={() => setTab(key)}
                    className={`w-full flex flex-col items-center gap-1 px-2 py-3 text-xs font-medium transition-colors ${
                      tab === key ? "text-blue-600 bg-blue-50" : "text-gray-400 hover:text-gray-600"
                    }`}
                  >
                    <Icon size={18} />
                    {label}
                  </button>
                ))}
              </div>

              <div className="flex-1 min-w-0">
                {tab === "details" && (
                  <div className="border border-gray-100 rounded-xl overflow-hidden m-4 px-4">
                    <InfoRow label="Type" value={campaignTypeLabel(c.type)} />
                    <InfoRow label="Status" value={campaignStatusLabel(c.status)} />
                    <InfoRow label="Scope" value={campaignScopeText(c)} />
                    <InfoRow label="Deadline" value={c.deadline ? new Date(c.deadline).toLocaleString() : undefined} />
                    <InfoRow label="Certifications" value={c.totalCertifications != null ? `${c.completedCertifications ?? 0} of ${c.totalCertifications} completed` : undefined} />
                    <InfoRow label="Email notifications" value={c.emailNotificationEnabled ? "On" : "Off"} />
                    <InfoRow label="Auto-revoke undecided" value={c.autoRevokeAllowed ? "Yes" : "No"} />
                    <InfoRow label="Recommendations" value={c.recommendationsEnabled ? "On" : "Off"} />
                    <InfoRow label="Comments required" value={c.mandatoryCommentRequirement} />
                    <InfoRow label="Correlated status" value={c.correlatedStatus} />
                    <InfoRow label="Created" value={c.created ? new Date(c.created).toLocaleString() : undefined} />
                    <InfoRow label="Modified" value={c.modified ? new Date(c.modified).toLocaleString() : undefined} />
                    <InfoRow label="Campaign ID" value={c.id} />
                  </div>
                )}
                {tab === "users" && <UsersTab campaign={c} summary={summary} isLoading={reviewItems.isLoading} error={reviewItems.error} />}
                {tab === "items" && <AccessItemsTab campaign={c} summary={summary} isLoading={reviewItems.isLoading} error={reviewItems.error} />}
                {tab === "json" && (
                  <RawJsonPanel data={c} resource="campaigns" objectId={c.id} invalidateKeys={[["campaign", id], ["campaigns"]]} />
                )}
              </div>
            </div>
          </>
        )}
      </div>

      {deleteConfirm && c && (
        <ConfirmModal
          title={`Delete "${c.name}"?`}
          message="This permanently deletes the campaign from ISC, along with its certifications and any decisions already made. ISC may refuse if the campaign is currently active. This cannot be undone."
          confirmLabel="Delete"
          danger
          pending={remove.isPending}
          onConfirm={() => remove.mutate([c])}
          onCancel={() => !remove.isPending && setDeleteConfirm(false)}
        />
      )}

      {startConfirm && c && (
        <ConfirmModal
          title={`Start "${c.name}"?`}
          message={`Activating assigns the certifications to their reviewers${c.emailNotificationEnabled ? " and sends notification emails" : ""}. This cannot be undone from here.`}
          confirmLabel="Start"
          pending={start.isPending}
          onConfirm={() => start.mutate([c])}
          onCancel={() => !start.isPending && setStartConfirm(false)}
        />
      )}
    </div>
  );
}
