import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Shapes, ChevronRight, Printer, Trash2, Power, PowerOff, UploadCloud, Link2, FilePlus2 } from "lucide-react";
import toast from "react-hot-toast";
import {
  listSegments, deleteSegment, setSegmentActive, publishSegments, getCredentials, startSegmentRoleMatch, createSegmentDraft,
  getSegmentAccess,
} from "../lib/sailpoint";
import { printSegmentsListPdf, printSegmentsDetailPdf } from "../lib/exportRolePdf";
import { useUrlSearch } from "../hooks/useUrlSearch";
import { useUrlState } from "../hooks/useUrlState";
import { TopBar } from "../components/TopBar";
import { BrowseTitleMenu } from "../components/BrowseTitleMenu";
import { SearchBar, FilterBar, SkeletonList, EmptyState, ErrorBox, IconButton, ConfirmModal, SelectionActionBar } from "../components/ui";
import { usePagedList } from "../hooks/usePagedList";

// Fetches each segment's assigned roles/entitlements (GET /:id/access —
// the same derived roles-plus-what-they-grant data the detail screen's own
// Roles/Entitlements tabs use) and attaches them, batched rather than all
// at once so a large tenant doesn't fire hundreds of requests in parallel —
// same batchSize/pattern as Roles' own printBrief.
async function enrichSegmentsForReport(segments) {
  const enriched = [];
  const batchSize = 5;
  for (let i = 0; i < segments.length; i += batchSize) {
    const batch = segments.slice(i, i + batchSize);
    const withAccess = await Promise.all(
      batch.map(async (s) => {
        try {
          const access = await getSegmentAccess(s.id);
          return { ...s, assignedRoles: access.roles || [], assignedEntitlements: access.entitlements || [] };
        } catch {
          return { ...s, assignedRoles: [], assignedEntitlements: [] };
        }
      })
    );
    enriched.push(...withAccess);
  }
  return enriched;
}

// Same list-screen shape as Roles — search, select one or all, bulk delete,
// click-through to detail.
export default function SegmentsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { search, debouncedSearch, handleSearch } = useUrlSearch();
  // URL-backed (not useState) — same pattern as Roles' Active/Disabled
  // filter, so it survives navigating into a data segment's detail page and
  // clicking Back.
  const [enabledFilter, setEnabledFilter] = useUrlState("status", "ALL");
  const [selected, setSelected] = useState(() => new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [progress, setProgress] = useState(0);
  const [enableProgress, setEnableProgress] = useState(0);
  const [publishProgress, setPublishProgress] = useState(0);
  const [draftProgress, setDraftProgress] = useState(0);
  const [printMenuOpen, setPrintMenuOpen] = useState(false);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["segments"],
    queryFn: listSegments,
  });

  const list = (Array.isArray(data) ? data : [])
    .filter((s) => !debouncedSearch || s.name?.toLowerCase().includes(debouncedSearch.toLowerCase()))
    .filter((s) =>
      enabledFilter === "ACTIVE" ? s.enabled
      : enabledFilter === "DISABLED" ? !s.enabled
      : enabledFilter === "DRAFTS" ? !s.published
      : true
    )
    .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  const allSelected = list.length > 0 && list.every((s) => selected.has(s.id));
  const { page, pager } = usePagedList(list, { noun: "data segment", resetKey: `${debouncedSearch}|${enabledFilter}` });
  // A published segment and its own draft are separate, individually
  // selectable rows here (see GET /api/segments) — so "the selection is
  // all drafts" is unambiguous per-row, not a derived/aggregate property.
  // Create Draft is a no-op for a row that's already a draft, so once
  // every selected row already is one, swap that action for Publish
  // instead of leaving a useless button in its place.
  const selectedRows = list.filter((s) => selected.has(s.id));
  const allSelectedAreDrafts = selectedRows.length > 0 && selectedRows.every((s) => !s.published);

  function toggleOne(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleAll() {
    setSelected((prev) => (allSelected ? new Set() : new Set(list.map((s) => s.id))));
  }

  // Selection wins over the filtered list when anything's checked — "print
  // what I picked" takes priority over "print what I'm looking at" rather
  // than being a second, separate action (Roles' own print menu keeps
  // those as two different buttons, which turned out to just read as
  // "print ignores my selection" instead of a deliberate second option).
  // The search-filter line in the PDF header is only meaningful for the
  // whole-list case — an explicit selection isn't "the search results",
  // even if it was built while one was active.
  const printTargets = selected.size > 0 ? list.filter((s) => selected.has(s.id)) : list;
  const printSearchQuery = selected.size > 0 ? undefined : debouncedSearch || undefined;

  const printList = useMutation({
    mutationFn: async () => {
      const tenant = getCredentials()?.tenant;
      return printSegmentsListPdf({ tenant, segments: printTargets, searchQuery: printSearchQuery });
    },
    onSuccess: (opened) => {
      setPrintMenuOpen(false);
      if (!opened) toast("Pop-up blocked — downloaded the PDF instead");
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const printDetail = useMutation({
    mutationFn: async () => {
      const tenant = getCredentials()?.tenant;
      const enriched = await enrichSegmentsForReport(printTargets);
      return printSegmentsDetailPdf({ tenant, segments: enriched, searchQuery: printSearchQuery });
    },
    onSuccess: (opened) => {
      setPrintMenuOpen(false);
      if (!opened) toast("Pop-up blocked — downloaded the PDF instead");
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const printPending = printList.isPending || printDetail.isPending;

  const bulkSetActive = useMutation({
    mutationFn: async (active) => {
      const ids = [...selected];
      const results = [];
      for (const id of ids) {
        try {
          await setSegmentActive(id, active);
          results.push({ id, ok: true });
        } catch (err) {
          results.push({ id, ok: false, error: err.response?.data?.error || err.message });
        }
        setEnableProgress(results.length);
      }
      return { results, active };
    },
    onSuccess: ({ results, active }) => {
      const failed = results.filter((r) => !r.ok);
      const verb = active ? "Enabled" : "Disabled";
      if (failed.length) {
        const detail = failed[0].error ? ` — ${failed[0].error}` : "";
        toast.error(
          `${verb} ${results.length - failed.length} of ${results.length} data segments — ${failed.length} failed${detail}`,
          { duration: 8000 }
        );
      } else {
        toast.success(`${verb} ${results.length} data segment${results.length === 1 ? "" : "s"}`);
      }
      setSelected(new Set());
      setEnableProgress(0);
      queryClient.invalidateQueries({ queryKey: ["segments"] });
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const bulkPublish = useMutation({
    mutationFn: async () => {
      const ids = [...selected];
      setPublishProgress(0);
      await publishSegments(ids);
      setPublishProgress(ids.length);
      return ids;
    },
    onSuccess: (ids) => {
      toast.success(`Published ${ids.length} data segment${ids.length === 1 ? "" : "s"}`);
      setSelected(new Set());
      setPublishProgress(0);
      queryClient.invalidateQueries({ queryKey: ["segments"] });
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const assignMatchingRoles = useMutation({
    mutationFn: () => startSegmentRoleMatch([...selected]),
    onSuccess: ({ matchId }) => navigate(`/segments/role-matches/${matchId}`),
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  // Same ensure-a-draft-exists action as the Segment Detail screen's own
  // icon, applied to every selected segment — a published segment with no
  // draft can't be PATCHed at all (verified live — see
  // getSegmentPatchTargetId server-side), so this is how to get one before
  // making any other change. The common case reverts each segment in
  // place to draft (published:false, same id — verified live against
  // ISC's own UI network traffic), which also means it stops being live
  // until published again. Continues past individual failures; each
  // result distinguishes that from one that already had a draft, since
  // neither is really a "failure."
  const bulkCreateDraft = useMutation({
    mutationFn: async () => {
      const ids = [...selected];
      const results = [];
      for (const id of ids) {
        try {
          const r = await createSegmentDraft(id);
          results.push({ id, ok: true, ...r });
        } catch (err) {
          results.push({ id, ok: false, error: err.response?.data?.error || err.message });
        }
        setDraftProgress(results.length);
      }
      return results;
    },
    onSuccess: (results) => {
      const created = results.filter((r) => r.ok && r.created);
      const alreadyHadOne = results.filter((r) => r.ok && !r.created);
      const failed = results.filter((r) => !r.ok);
      if (created.length) toast.success(`Reverted ${created.length} data segment${created.length === 1 ? "" : "s"} to draft`, { duration: 6000 });
      if (alreadyHadOne.length) toast(`${alreadyHadOne.length} data segment${alreadyHadOne.length === 1 ? "" : "s"} already had a draft`);
      if (failed.length) toast.error(`${failed.length} failed: ${failed.map((f) => f.error).join("; ")}`, { duration: 8000 });
      setSelected(new Set());
      setDraftProgress(0);
      queryClient.invalidateQueries({ queryKey: ["segments"] });
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const toggleOneActive = useMutation({
    mutationFn: ({ id, active }) => setSegmentActive(id, active),
    onSuccess: (_data, { active }) => {
      toast.success(active ? "Enabled" : "Disabled");
      queryClient.invalidateQueries({ queryKey: ["segments"] });
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  // Draft -> Publish is a real ISC action. Published -> Draft has no
  // real API equivalent — ISC rejects any attempt to patch "published"
  // back to false (verified live) and the only way to remove a published
  // data segment's published state is to delete it outright. Disabling is
  // the closest non-destructive stand-in: the data segment stops taking
  // effect, even though it's technically still marked published.
  const togglePublishState = useMutation({
    mutationFn: ({ id, published }) => (published ? setSegmentActive(id, false) : publishSegments([id])),
    onSuccess: (_data, { published }) => {
      toast.success(published ? "Disabled" : "Published");
      queryClient.invalidateQueries({ queryKey: ["segments"] });
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const bulkDelete = useMutation({
    mutationFn: async () => {
      const ids = [...selected];
      const results = [];
      for (const id of ids) {
        try {
          await deleteSegment(id);
          results.push({ id, ok: true });
        } catch (err) {
          results.push({ id, ok: false, error: err.response?.data?.error || err.message });
        }
        setProgress(results.length);
      }
      return results;
    },
    onSuccess: (results) => {
      const failed = results.filter((r) => !r.ok);
      if (failed.length) {
        const detail = failed[0].error ? ` — ${failed[0].error}` : "";
        toast.error(
          `Deleted ${results.length - failed.length} of ${results.length} data segments — ${failed.length} failed${detail}`,
          { duration: 8000 }
        );
      } else {
        toast.success(`Deleted ${results.length} data segment${results.length === 1 ? "" : "s"}`);
      }
      setSelected(new Set());
      setConfirmOpen(false);
      setProgress(0);
      queryClient.invalidateQueries({ queryKey: ["segments"] });
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <TopBar
        title={<BrowseTitleMenu active="Data Segments" />}
        loading={isLoading}
        action={
          list.length > 0 && (
            <div className="relative">
              <IconButton
                icon={Printer}
                title={selected.size > 0 ? `Print ${selected.size} selected` : "Print data segments"}
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
                      <p className="text-xs text-gray-500 mt-0.5">Name and description only</p>
                    </button>
                    <button
                      onClick={() => printDetail.mutate()}
                      disabled={printPending}
                      className="w-full text-left px-4 py-3 text-sm text-gray-900 hover:bg-gray-50 disabled:opacity-50 border-t border-gray-100"
                    >
                      <p className="font-medium">Detailed list</p>
                      <p className="text-xs text-gray-500 mt-0.5">
                        Status, criteria, and Access Model per segment{printDetail.isPending ? " — generating…" : ""}
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
        <SearchBar value={search} onChange={handleSearch} placeholder="Search data segments…" />
        <FilterBar
          options={[
            { value: "ALL", label: "All" },
            { value: "ACTIVE", label: "Active" },
            { value: "DISABLED", label: "Inactive" },
            { value: "DRAFTS", label: "Drafts" },
          ]}
          active={enabledFilter}
          onChange={setEnabledFilter}
        />

        {error && <ErrorBox message={error.message} onRetry={refetch} />}
        {isLoading && <SkeletonList rows={8} />}
        {!isLoading && !error && list.length === 0 && (
          <EmptyState
            icon={Shapes}
            title={debouncedSearch ? "No results" : "No data segments found"}
            subtitle={
              debouncedSearch
                ? `No data segments match "${debouncedSearch}"`
                : "Use Mining > Data Segments to scan for and create data segments from the Multi-Company/Division Boundary"
            }
          />
        )}

        {!isLoading && list.length > 0 && (
          <>
            <div className="flex items-center justify-between px-4 py-2 gap-3">
              <label className="flex items-center gap-2 text-xs text-gray-500">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  className="w-4 h-4 rounded border-gray-300"
                />
                Select all
              </label>
              <p className="text-xs text-gray-400">
                {list.length} data segment{list.length !== 1 && "s"}{debouncedSearch && " matching"}
              </p>
            </div>

            {selected.size > 0 && (
              <SelectionActionBar
                count={selected.size}
                progressText={
                  bulkSetActive.isPending ? `Updating ${enableProgress} of ${selected.size}…`
                  : bulkPublish.isPending ? `Publishing ${publishProgress} of ${selected.size}…`
                  : bulkCreateDraft.isPending ? `Creating drafts for ${draftProgress} of ${selected.size}…`
                  : null
                }
                actions={[
                  allSelectedAreDrafts
                    ? {
                        icon: UploadCloud,
                        title: `Publish (${selected.size}) — makes the selected draft${selected.size === 1 ? "" : "s"}' criteria take effect`,
                        onClick: () => bulkPublish.mutate(),
                        loading: bulkPublish.isPending,
                        disabled: bulkSetActive.isPending || bulkDelete.isPending || bulkPublish.isPending,
                      }
                    : {
                        icon: FilePlus2,
                        title: `Create Draft (${selected.size}) — reverts published segments to draft so they can be edited`,
                        onClick: () => bulkCreateDraft.mutate(),
                        loading: bulkCreateDraft.isPending,
                        disabled: bulkSetActive.isPending || bulkDelete.isPending || bulkCreateDraft.isPending,
                      },
                  {
                    icon: Link2,
                    title: `Assign Matching Roles & Entitlements (${selected.size})`,
                    onClick: () => assignMatchingRoles.mutate(),
                    loading: assignMatchingRoles.isPending,
                    disabled: bulkSetActive.isPending || bulkDelete.isPending,
                  },
                  {
                    icon: Power,
                    title: `Enable (${selected.size})`,
                    onClick: () => bulkSetActive.mutate(true),
                    loading: bulkSetActive.isPending && bulkSetActive.variables === true,
                    disabled: bulkSetActive.isPending || bulkDelete.isPending,
                  },
                  {
                    icon: PowerOff,
                    title: `Disable (${selected.size})`,
                    onClick: () => bulkSetActive.mutate(false),
                    loading: bulkSetActive.isPending && bulkSetActive.variables === false,
                    disabled: bulkSetActive.isPending || bulkDelete.isPending,
                  },
                  ...(allSelectedAreDrafts
                    ? []
                    : [{
                        icon: UploadCloud,
                        title: `Publish (${selected.size}) — required, along with Enable, for a data segment's criteria to actually apply`,
                        onClick: () => bulkPublish.mutate(),
                        loading: bulkPublish.isPending,
                        disabled: bulkSetActive.isPending || bulkDelete.isPending,
                      }]),
                  {
                    icon: Printer,
                    title: `Print Detail for Selected (${selected.size})`,
                    onClick: () => printDetail.mutate(),
                    loading: printDetail.isPending,
                    disabled: bulkSetActive.isPending || bulkDelete.isPending || printPending,
                  },
                  {
                    icon: Trash2,
                    title: `Delete Selected Data Segments (${selected.size})`,
                    onClick: () => setConfirmOpen(true),
                    disabled: bulkSetActive.isPending,
                    danger: true,
                  },
                ]}
              />
            )}

            {pager}
            {page.map((s) => (
              <div
                key={s.id}
                className="w-full flex items-center gap-3 px-4 py-3.5 border-b border-gray-100 hover:bg-gray-50 transition-colors"
              >
                <input
                  type="checkbox"
                  checked={selected.has(s.id)}
                  onChange={() => toggleOne(s.id)}
                  className="w-4 h-4 rounded border-gray-300 flex-shrink-0"
                />
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => navigate(`/segments/${s.id}`)}
                  onKeyDown={(e) => e.key === "Enter" && navigate(`/segments/${s.id}`)}
                  className="flex-1 min-w-0 flex items-center gap-3 text-left cursor-pointer active:bg-gray-100"
                >
                  <div className="w-10 h-10 rounded-full bg-violet-50 flex items-center justify-center flex-shrink-0">
                    <Shapes size={16} className="text-violet-600" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{s.name}</p>
                    {s.description && (
                      <p className="text-xs text-gray-500 mt-0.5 truncate">{s.description}</p>
                    )}
                  </div>
                  <button
                    type="button"
                    title={s.enabled ? "Disable" : "Enable"}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleOneActive.mutate({ id: s.id, active: !s.enabled });
                    }}
                    disabled={toggleOneActive.isPending && toggleOneActive.variables?.id === s.id}
                    className={`text-xs font-medium px-2 py-0.5 rounded-full border flex-shrink-0 transition-colors disabled:opacity-50 ${
                      s.enabled
                        ? "bg-blue-50 text-blue-700 border-blue-200 hover:bg-red-50 hover:text-red-700 hover:border-red-200"
                        : "bg-gray-50 text-gray-500 border-gray-200 hover:bg-blue-50 hover:text-blue-700 hover:border-blue-200"
                    }`}
                  >
                    {s.enabled ? "Active" : "Inactive"}
                  </button>
                  <button
                    type="button"
                    title={s.published ? "Disable — ISC has no way to unpublish a data segment directly" : "Publish"}
                    onClick={(e) => {
                      e.stopPropagation();
                      togglePublishState.mutate({ id: s.id, published: s.published });
                    }}
                    disabled={togglePublishState.isPending && togglePublishState.variables?.id === s.id}
                    className={`text-xs font-medium px-2 py-0.5 rounded-full border flex-shrink-0 transition-colors disabled:opacity-50 ${
                      s.published
                        ? "bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-gray-50 hover:text-gray-500 hover:border-gray-200"
                        : "bg-amber-50 text-amber-700 border-amber-200 hover:bg-emerald-50 hover:text-emerald-700 hover:border-emerald-200"
                    }`}
                  >
                    {s.published ? "Published" : "Draft"}
                  </button>
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
          title={`Delete ${selected.size} data segment${selected.size === 1 ? "" : "s"}?`}
          message={`This permanently deletes the selected data segment${selected.size === 1 ? "" : "s"} from this tenant. This cannot be undone.`}
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
