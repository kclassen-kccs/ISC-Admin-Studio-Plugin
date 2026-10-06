import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { Split, ChevronRight, Trash2, Power, PowerOff, Info, Shield, ShieldCheck, Key, Braces, Printer, Users } from "lucide-react";
import toast from "react-hot-toast";
import {
  listIscSegments, getIscSegment, deleteIscSegment, setIscSegmentActive, listIscSegmentItems, searchIscSegmentIdentities,
  getCredentials,
} from "../lib/sailpoint";
import { printIscSegmentsListPdf, printIscSegmentsDetailPdf } from "../lib/exportIscSegmentsPdf";
import { useUrlSearch } from "../hooks/useUrlSearch";
import { useUrlState } from "../hooks/useUrlState";
import { usePagedList } from "../hooks/usePagedList";
import { TopBar } from "../components/TopBar";
import { BrowseTitleMenu } from "../components/BrowseTitleMenu";
import {
  SearchBar, FilterBar, SkeletonList, EmptyState, ErrorBox, IconButton, ConfirmModal, SelectionActionBar,
  Spinner, InfoRow, SectionLabel, ListRow, Avatar, Pager,
} from "../components/ui";
import { RawJsonPanel } from "../components/RawJsonPanel";
import { EntitlementRollup } from "./SegmentDetailPage";

// ─── Segments (ISC access-request Segments) ──────────────────────────────────
// A separate object from Data Segments: a member definition
// (visibilityCriteria) plus the roles, access profiles and entitlements
// assigned to it. Same list/detail shape as the Data Segments screens, minus
// Data Segments' draft/publish lifecycle, which Segments don't have — a
// Segment is just active or inactive.

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// ISC's Segment expression: EQUALS leaves, optionally under AND/OR.
function describeSegmentExpression(expr) {
  if (!expr) return "No member criteria set";
  if ((expr.operator === "AND" || expr.operator === "OR") && expr.children?.length) {
    return expr.children.map(describeSegmentExpression).join(` ${expr.operator} `);
  }
  if (expr.operator === "EQUALS") return `${expr.attribute} = "${expr.value?.value ?? ""}"`;
  return expr.operator || "Unrecognized criteria";
}

function ActivePill({ active, onClick, pending }) {
  return (
    <button
      type="button"
      title={active ? "Deactivate" : "Activate"}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      disabled={pending}
      className={`text-xs font-medium px-2 py-0.5 rounded-full border flex-shrink-0 transition-colors disabled:opacity-50 ${
        active
          ? "bg-blue-50 text-blue-700 border-blue-200 hover:bg-red-50 hover:text-red-700 hover:border-red-200"
          : "bg-gray-50 text-gray-500 border-gray-200 hover:bg-blue-50 hover:text-blue-700 hover:border-blue-200"
      }`}
    >
      {active ? "Active" : "Inactive"}
    </button>
  );
}

export default function IscSegmentsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { search, debouncedSearch, handleSearch } = useUrlSearch();
  const [activeFilter, setActiveFilter] = useUrlState("status", "ALL");
  const [selected, setSelected] = useState(() => new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [progress, setProgress] = useState(0);

  const { data, isLoading, error, refetch } = useQuery({ queryKey: ["isc-segments"], queryFn: listIscSegments });

  const list = (Array.isArray(data) ? data : [])
    .filter((s) => !debouncedSearch || s.name?.toLowerCase().includes(debouncedSearch.toLowerCase()))
    .filter((s) => (activeFilter === "ACTIVE" ? s.active : activeFilter === "INACTIVE" ? !s.active : true))
    .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  const allSelected = list.length > 0 && list.every((s) => selected.has(s.id));
  const { page, pager } = usePagedList(list, { noun: "segment", resetKey: `${debouncedSearch}|${activeFilter}` });

  const toggleOne = (id) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  // One at a time, continuing past failures — same as the Data Segments list.
  const runBulk = async (fn) => {
    const results = [];
    for (const id of [...selected]) {
      try { await fn(id); results.push({ id, ok: true }); }
      catch (err) { results.push({ id, ok: false, error: err.response?.data?.error || err.message }); }
      setProgress(results.length);
    }
    return results;
  };
  const report = (verb, results) => {
    const failed = results.filter((r) => !r.ok);
    if (failed.length) toast.error(`${verb} ${results.length - failed.length} of ${results.length} segments — ${failed.length} failed — ${failed[0].error}`, { duration: 8000 });
    else toast.success(`${verb} ${plural(results.length, "segment")}`);
    setSelected(new Set());
    setProgress(0);
    queryClient.invalidateQueries({ queryKey: ["isc-segments"] });
  };

  const bulkSetActive = useMutation({
    mutationFn: async (active) => ({ active, results: await runBulk((id) => setIscSegmentActive(id, active)) }),
    onSuccess: ({ active, results }) => report(active ? "Activated" : "Deactivated", results),
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });
  const bulkDelete = useMutation({
    mutationFn: () => runBulk(deleteIscSegment),
    onSuccess: (results) => { setConfirmOpen(false); report("Deleted", results); },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });
  const toggleOneActive = useMutation({
    mutationFn: ({ id, active }) => setIscSegmentActive(id, active),
    onSuccess: (_d, { active }) => {
      toast.success(active ? "Activated" : "Deactivated");
      queryClient.invalidateQueries({ queryKey: ["isc-segments"] });
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });
  const busy = bulkSetActive.isPending || bulkDelete.isPending;

  // Selection wins over the filtered list when anything's checked — same
  // rule as the Data Segments list's print menu.
  const [printMenuOpen, setPrintMenuOpen] = useState(false);
  const printTargets = selected.size > 0 ? list.filter((s) => selected.has(s.id)) : list;
  const printSearchQuery = selected.size > 0 ? undefined : debouncedSearch || undefined;
  const afterPrint = (opened) => {
    setPrintMenuOpen(false);
    if (!opened) toast("Pop-up blocked — downloaded the PDF instead");
  };
  const printList = useMutation({
    mutationFn: async () => printIscSegmentsListPdf({ tenant: getCredentials()?.tenant, segments: printTargets, searchQuery: printSearchQuery }),
    onSuccess: afterPrint,
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });
  const printDetail = useMutation({
    mutationFn: async () => {
      // Each segment's assigned items, five segments at a time.
      const enriched = [];
      for (let i = 0; i < printTargets.length; i += 5) {
        enriched.push(...await Promise.all(printTargets.slice(i, i + 5).map(async (s) => {
          const load = (type) => listIscSegmentItems(type, s.id).catch(() => []);
          const [roles, accessProfiles, entitlements] = await Promise.all([load("roles"), load("accessProfiles"), load("entitlements")]);
          return {
            ...s,
            roles: roles.map((r) => ({ name: r.name })),
            accessProfiles: accessProfiles.map((a) => ({ name: a.name, source: a.source?.name })),
            entitlements: entitlements.map((e) => ({ name: e.name || e.attributes?.displayName || e.value, source: e.source?.name })),
          };
        })));
      }
      return printIscSegmentsDetailPdf({ tenant: getCredentials()?.tenant, segments: enriched, searchQuery: printSearchQuery });
    },
    onSuccess: afterPrint,
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });
  const printPending = printList.isPending || printDetail.isPending;

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <TopBar
        title={<BrowseTitleMenu active="Segments" />}
        loading={isLoading}
        action={
          list.length > 0 && (
            <div className="relative">
              <IconButton
                icon={Printer}
                title={selected.size > 0 ? `Print ${selected.size} selected` : "Print segments"}
                onClick={() => setPrintMenuOpen((v) => !v)}
                disabled={printPending}
              />
              {printMenuOpen && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setPrintMenuOpen(false)} />
                  <div className="absolute right-0 top-full mt-1 w-56 bg-white border border-gray-200 rounded-xl shadow-lg z-20 overflow-hidden">
                    <p className="px-4 pt-3 pb-1 text-[11px] font-semibold text-gray-400 uppercase tracking-wide">
                      {selected.size > 0 ? `${selected.size} selected` : `${list.length} shown`}
                    </p>
                    <button
                      onClick={() => printList.mutate()}
                      disabled={printPending}
                      className="w-full text-left px-4 py-3 text-sm text-gray-900 hover:bg-gray-50 disabled:opacity-50"
                    >
                      <p className="font-medium">Basic list</p>
                      <p className="text-xs text-gray-500 mt-0.5">Name, description and status</p>
                    </button>
                    <button
                      onClick={() => printDetail.mutate()}
                      disabled={printPending}
                      className="w-full text-left px-4 py-3 text-sm text-gray-900 hover:bg-gray-50 disabled:opacity-50 border-t border-gray-100"
                    >
                      <p className="font-medium">Detailed list</p>
                      <p className="text-xs text-gray-500 mt-0.5">
                        Members rule, roles, access profiles and entitlements per segment{printDetail.isPending ? " — generating…" : ""}
                      </p>
                    </button>
                  </div>
                </>
              )}
            </div>
          )
        }
      />
      <div className="flex-1 overflow-y-auto pb-24">
        <SearchBar value={search} onChange={handleSearch} placeholder="Search segments…" />
        <FilterBar
          options={[
            { value: "ALL", label: "All" },
            { value: "ACTIVE", label: "Active" },
            { value: "INACTIVE", label: "Inactive" },
          ]}
          active={activeFilter}
          onChange={setActiveFilter}
        />

        {error && <ErrorBox message={error.message} onRetry={refetch} />}
        {isLoading && <SkeletonList rows={8} />}
        {!isLoading && !error && list.length === 0 && (
          <EmptyState
            icon={Split}
            title={debouncedSearch ? "No results" : "No segments found"}
            subtitle={debouncedSearch ? `No segments match "${debouncedSearch}"` : "Use Mining > Segments to propose and create segments from the Multi-Company/Division Boundary"}
          />
        )}

        {!isLoading && list.length > 0 && (
          <>
            <div className="flex items-center justify-between px-4 py-2 gap-3">
              <label className="flex items-center gap-2 text-xs text-gray-500">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={() => setSelected(allSelected ? new Set() : new Set(list.map((s) => s.id)))}
                  className="w-4 h-4 rounded border-gray-300"
                />
                Select all
              </label>
              <p className="text-xs text-gray-400">{plural(list.length, "segment")}{debouncedSearch && " matching"}</p>
            </div>

            {selected.size > 0 && (
              <SelectionActionBar
                count={selected.size}
                progressText={busy ? `Updating ${progress} of ${selected.size}…` : null}
                actions={[
                  { icon: Power, title: `Activate (${selected.size})`, onClick: () => bulkSetActive.mutate(true), loading: bulkSetActive.isPending && bulkSetActive.variables === true, disabled: busy },
                  { icon: PowerOff, title: `Deactivate (${selected.size})`, onClick: () => bulkSetActive.mutate(false), loading: bulkSetActive.isPending && bulkSetActive.variables === false, disabled: busy },
                  { icon: Printer, title: `Print Detail for Selected (${selected.size})`, onClick: () => printDetail.mutate(), loading: printDetail.isPending, disabled: busy || printPending },
                  { icon: Trash2, title: `Delete Selected Segments (${selected.size})`, onClick: () => setConfirmOpen(true), disabled: busy, danger: true },
                ]}
              />
            )}

            {pager}
            {page.map((s) => (
              <div key={s.id} className="w-full flex items-center gap-3 px-4 py-3.5 border-b border-gray-100 hover:bg-gray-50 transition-colors">
                <input type="checkbox" checked={selected.has(s.id)} onChange={() => toggleOne(s.id)} className="w-4 h-4 rounded border-gray-300 flex-shrink-0" />
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => navigate(`/access-segments/${s.id}`)}
                  onKeyDown={(e) => e.key === "Enter" && navigate(`/access-segments/${s.id}`)}
                  className="flex-1 min-w-0 flex items-center gap-3 text-left cursor-pointer active:bg-gray-100"
                >
                  <div className="w-10 h-10 rounded-full bg-teal-50 flex items-center justify-center flex-shrink-0">
                    <Split size={16} className="text-teal-600" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{s.name}</p>
                    <p className="text-xs text-gray-500 mt-0.5 truncate">{s.description || describeSegmentExpression(s.visibilityCriteria?.expression)}</p>
                  </div>
                  <ActivePill
                    active={s.active}
                    onClick={() => toggleOneActive.mutate({ id: s.id, active: !s.active })}
                    pending={toggleOneActive.isPending && toggleOneActive.variables?.id === s.id}
                  />
                  <ChevronRight size={16} className="text-gray-300 flex-shrink-0" />
                </div>
              </div>
            ))}
            {pager}
          </>
        )}
      </div>

      {confirmOpen && (
        <ConfirmModal
          title={`Delete ${plural(selected.size, "segment")}?`}
          message={`This permanently deletes the selected segment${selected.size === 1 ? "" : "s"} from this tenant. This cannot be undone.`}
          confirmLabel="Delete"
          danger
          pending={bulkDelete.isPending}
          progressText={`Deleting ${progress} of ${selected.size}…`}
          onConfirm={() => bulkDelete.mutate()}
          onCancel={() => setConfirmOpen(false)}
        />
      )}
    </div>
  );
}

// ─── Detail ──────────────────────────────────────────────────────────────────

const SECTIONS = [
  { key: "details", label: "Details", Icon: Info },
  { key: "identities", label: "Identities", Icon: Users },
  { key: "roles", label: "Roles", Icon: Shield },
  { key: "accessProfiles", label: "Access Profiles", Icon: ShieldCheck },
  { key: "entitlements", label: "Entitlements", Icon: Key },
  { key: "json", label: "JSON", Icon: Braces },
];

function useSegmentItems(type, segmentId, enabled) {
  return useQuery({
    queryKey: ["isc-segment-items", type, segmentId],
    queryFn: () => listIscSegmentItems(type, segmentId),
    enabled,
  });
}

function ItemsPanel({ type, segmentId, navigate }) {
  const { data, isLoading, error, refetch } = useSegmentItems(type, segmentId, true);
  const items = Array.isArray(data) ? [...data].sort((a, b) => (a.name || "").localeCompare(b.name || "")) : [];
  const noun = type === "roles" ? "role" : "access profile";
  const { page, pager } = usePagedList(items, { urlKey: type === "roles" ? "ro" : "ap", noun, resetKey: segmentId });
  const Icon = type === "roles" ? Shield : ShieldCheck;
  const tone = type === "roles" ? "bg-blue-50 text-blue-600" : "bg-emerald-50 text-emerald-600";

  if (isLoading) return <div className="px-4 py-4"><SkeletonList rows={4} /></div>;
  if (error) return <ErrorBox message={error.message} onRetry={refetch} />;
  if (items.length === 0) {
    return <EmptyState icon={Icon} title={`No ${noun}s in this segment`} subtitle={`No ${noun} lists this segment. Mining > Segments assigns them when it creates a segment.`} />;
  }
  return (
    <div className="px-4 py-2">
      <p className="text-xs text-gray-400 py-2">{plural(items.length, noun)}</p>
      {pager}
      <div className="border border-gray-100 rounded-xl overflow-hidden divide-y divide-gray-100">
        {page.map((x) => (
          <ListRow
            key={x.id}
            onClick={() => navigate(type === "roles" ? `/roles/${x.id}` : `/access-profiles/${x.id}`)}
            left={
              <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${tone}`}>
                <Icon size={14} />
              </div>
            }
            title={x.name}
            subtitle={[
              type === "accessProfiles" ? x.source?.name : `${plural(x.entitlements?.length || 0, "entitlement")}`,
              x.enabled === false ? "disabled" : null,
            ].filter(Boolean).join(" · ")}
            right={<ChevronRight size={16} className="text-gray-300 flex-shrink-0" />}
          />
        ))}
      </div>
      {pager}
    </div>
  );
}

// The identities the Segment's member definition matches, from identity
// search — server-paged with the real total, and searchable by name.
const IDENTITIES_PAGE_SIZE = 50;
function IdentitiesPanel({ segment, navigate }) {
  const { search, debouncedSearch, handleSearch: handleUrlSearch } = useUrlSearch("q");
  const [offset, setOffset] = useState(0);
  const handleSearch = (value) => { handleUrlSearch(value); setOffset(0); };
  const expression = segment.visibilityCriteria?.expression;
  const q = useQuery({
    queryKey: ["isc-segment-identities", segment.id, debouncedSearch, offset],
    queryFn: () => searchIscSegmentIdentities(expression, { limit: IDENTITIES_PAGE_SIZE, offset, search: debouncedSearch }),
    keepPreviousData: true,
  });
  const identities = q.data?.identities || [];
  const total = q.data?.total ?? 0;
  const hasNext = offset + identities.length < total;

  return (
    <div>
      <SearchBar value={search} onChange={handleSearch} placeholder="Search identities by name…" />
      {q.isLoading && <div className="flex items-center justify-center py-6"><Spinner size={18} /></div>}
      {q.error && <ErrorBox message={q.error.message} onRetry={q.refetch} />}
      {!q.isLoading && !q.error && identities.length === 0 && (
        <EmptyState
          icon={Users}
          title={debouncedSearch ? "No results" : "No identities"}
          subtitle={debouncedSearch ? `No identities match "${debouncedSearch}"` : expression ? "No identities currently match this segment's member definition" : "This segment has no member definition"}
        />
      )}
      {total > 0 && <Pager offset={offset} pageSize={IDENTITIES_PAGE_SIZE} total={total} noun="identity" onOffsetChange={setOffset} hasNext={hasNext} busy={q.isFetching} />}
      {identities.length > 0 && (
        <div className="border-t border-gray-100">
          {identities.map((m) => (
            <button
              key={m.id}
              onClick={() => navigate(`/identities/${m.id}`)}
              className="w-full flex items-center gap-3 px-4 py-3 border-b border-gray-100 hover:bg-gray-50 active:bg-gray-100 text-left transition-colors"
            >
              <Avatar name={m.displayName || m.name} size="sm" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-gray-900 truncate">{m.displayName || m.name}</p>
                {(m.attributes?.jobTitle || m.attributes?.department) && (
                  <p className="text-xs text-gray-500 truncate mt-0.5">
                    {[m.attributes?.jobTitle, m.attributes?.department].filter(Boolean).join(" · ")}
                  </p>
                )}
              </div>
            </button>
          ))}
        </div>
      )}
      {total > 0 && <Pager offset={offset} pageSize={IDENTITIES_PAGE_SIZE} total={total} noun="identity" onOffsetChange={setOffset} hasNext={hasNext} busy={q.isFetching} />}
    </div>
  );
}

function EntitlementsPanel({ segmentId }) {
  const { data, isLoading, error, refetch } = useSegmentItems("entitlements", segmentId, true);
  if (isLoading) return <div className="px-4 py-4"><SkeletonList rows={4} /></div>;
  if (error) return <ErrorBox message={error.message} onRetry={refetch} />;
  const entitlements = (Array.isArray(data) ? data : []).map((e) => ({
    id: e.id,
    name: e.name || e.attributes?.displayName || e.value,
    sourceName: e.source?.name || "Other",
    via: [e.attribute, e.privilegeLevel?.effective].filter(Boolean),
  }));
  if (entitlements.length === 0) {
    return <EmptyState icon={Key} title="No entitlements in this segment" subtitle="No entitlement lists this segment. Mining > Segments assigns them when it creates a segment." />;
  }
  // Rolled up by source, the same as the Data Segment and Identity screens.
  return <EntitlementRollup entitlements={entitlements} segmentId={segmentId} />;
}

export function IscSegmentDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [section, setSection] = useUrlState("tab", "details");
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);

  const { data, isLoading, error, refetch } = useQuery({ queryKey: ["isc-segment", id], queryFn: () => getIscSegment(id) });
  // Counts for the Details tab — the same queries the tabs use, so opening a
  // tab afterwards costs nothing extra.
  const roles = useSegmentItems("roles", id, !!data);
  const profiles = useSegmentItems("accessProfiles", id, !!data);
  const ents = useSegmentItems("entitlements", id, !!data);

  const toggleActive = useMutation({
    mutationFn: (active) => setIscSegmentActive(id, active),
    onSuccess: (_d, active) => {
      toast.success(active ? "Activated" : "Deactivated");
      queryClient.invalidateQueries({ queryKey: ["isc-segment", id] });
      queryClient.invalidateQueries({ queryKey: ["isc-segments"] });
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });
  const remove = useMutation({
    mutationFn: () => deleteIscSegment(id),
    onSuccess: () => {
      toast.success("Segment deleted");
      queryClient.invalidateQueries({ queryKey: ["isc-segments"] });
      navigate("/access-segments");
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const count = (q) => (q.isLoading ? "…" : Array.isArray(q.data) ? q.data.length : "—");

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <TopBar
        title="Segment"
        onBack={() => navigate(-1)}
        action={
          data && (
            <div className="flex items-center gap-2">
              {data.active ? (
                <IconButton icon={PowerOff} title="Deactivate" onClick={() => toggleActive.mutate(false)} loading={toggleActive.isPending} disabled={remove.isPending} />
              ) : (
                <IconButton icon={Power} title="Activate" onClick={() => toggleActive.mutate(true)} loading={toggleActive.isPending} disabled={remove.isPending} />
              )}
              <IconButton icon={Trash2} title="Delete" onClick={() => setConfirmDeleteOpen(true)} disabled={remove.isPending} className="!border-red-200 !text-red-600 hover:!bg-red-50" />
            </div>
          )
        }
      />
      <div className="flex-1 overflow-y-auto pb-24">
        {isLoading && <div className="flex items-center justify-center py-16"><Spinner size={24} /></div>}
        {error && <ErrorBox message={error.message} onRetry={refetch} />}

        {data && (
          <>
            <div className="px-4 py-4 flex items-center gap-3">
              <div className="w-12 h-12 rounded-full bg-teal-50 flex items-center justify-center flex-shrink-0">
                <Split size={20} className="text-teal-600" />
              </div>
              <div className="flex-1 min-w-0">
                <h2 className="text-base font-semibold text-gray-900 truncate">{data.name}</h2>
                <div className="mt-1">
                  <ActivePill active={data.active} onClick={() => toggleActive.mutate(!data.active)} pending={toggleActive.isPending} />
                </div>
              </div>
            </div>

            <div className="flex border-t border-gray-100">
              <div className="w-28 flex-shrink-0 border-r border-gray-100 py-2">
                {SECTIONS.map(({ key, label, Icon }) => (
                  <button
                    key={key}
                    onClick={() => setSection(key)}
                    className={`w-full flex flex-col items-center gap-1 px-2 py-3 text-xs font-medium transition-colors text-center ${
                      section === key ? "text-blue-600 bg-blue-50" : "text-gray-400 hover:text-gray-600"
                    }`}
                  >
                    <Icon size={18} />
                    {label}
                  </button>
                ))}
              </div>

              <div className="flex-1 min-w-0">
                {section === "details" && (
                  <div>
                    <SectionLabel>Details</SectionLabel>
                    <div className="px-4">
                      <InfoRow label="Description" value={data.description || "—"} />
                      <InfoRow label="Owner" value={data.owner?.name || "—"} />
                      <InfoRow label="Created" value={data.created ? new Date(data.created).toLocaleString() : "—"} />
                      <InfoRow label="Modified" value={data.modified ? new Date(data.modified).toLocaleString() : "—"} />
                    </div>
                    <SectionLabel>Members</SectionLabel>
                    <div className="px-4">
                      <div className="border border-gray-100 rounded-xl p-4">
                        <p className="text-sm text-gray-900 font-mono break-words">{describeSegmentExpression(data.visibilityCriteria?.expression)}</p>
                      </div>
                    </div>
                    <SectionLabel>Access</SectionLabel>
                    <div className="px-4 pb-4">
                      <InfoRow label="Roles" value={count(roles)} />
                      <InfoRow label="Access Profiles" value={count(profiles)} />
                      <InfoRow label="Entitlements" value={count(ents)} />
                    </div>
                  </div>
                )}
                {section === "identities" && <IdentitiesPanel segment={data} navigate={navigate} />}
                {(section === "roles" || section === "accessProfiles") && <ItemsPanel key={section} type={section} segmentId={id} navigate={navigate} />}
                {section === "entitlements" && <EntitlementsPanel segmentId={id} />}
                {section === "json" && (
                  <RawJsonPanel data={data} resource="segments" objectId={id} invalidateKeys={[["isc-segment", id], ["isc-segments"]]} />
                )}
              </div>
            </div>
          </>
        )}
      </div>

      {confirmDeleteOpen && (
        <ConfirmModal
          title="Delete this segment?"
          message="This permanently deletes the segment from this tenant. This cannot be undone."
          confirmLabel="Delete"
          danger
          pending={remove.isPending}
          onConfirm={() => remove.mutate()}
          onCancel={() => setConfirmDeleteOpen(false)}
        />
      )}
    </div>
  );
}
