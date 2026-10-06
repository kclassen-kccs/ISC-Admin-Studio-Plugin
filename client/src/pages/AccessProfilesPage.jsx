import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { ChevronRight, ShieldCheck, Trash2, Printer, Wand2, Plus, X, Power, PowerOff, CheckCircle2, XCircle, UserCog, Mail, Tags } from "lucide-react";
import toast from "react-hot-toast";
import {
  listAccessProfiles, deleteAccessProfile, getAccessProfile, getCredentials,
  generateAllAccessProfileDescriptions, updateAccessProfile, setAccessProfileEnabled,
  createAccessProfile, listIdentities, listSources, listEntitlementsBySource,
  fetchAllPages,
} from "../lib/sailpoint";
import { printAccessProfilesListPdf, printAccessProfilesDetailPdf, buildAccessProfilesDetailPdfBase64 } from "../lib/exportRolePdf";
import { useUrlSearch } from "../hooks/useUrlSearch";
import { useUrlState } from "../hooks/useUrlState";
import { MetadataFilterControl, useMetadataFilter, useMetadataMatchIds } from "../components/MetadataFilter";
import { SegmentFilterControl, useSegmentFilter, useSegmentMatchIds } from "../components/SegmentFilter";
import { useEmailReportAction } from "../hooks/useEmailReportAction";
import { TopBar } from "../components/TopBar";
import { BrowseTitleMenu } from "../components/BrowseTitleMenu";
import {
  SearchBar, FilterBar, SkeletonList, EmptyState, ErrorBox, IconButton, ConfirmModal, Spinner,
  Field, Input, Select, PrimaryButton, SelectionActionBar,
} from "../components/ui";
import { useBulkTagMetadata } from "../components/BulkTagMetadata";
import { BulkDescriptionReviewSheet } from "../components/BulkDescriptionReviewSheet";
import { PickerField } from "../components/PickerField";
import { ChangeOwnerModal } from "../components/ChangeOwnerModal";
import { EmailReportDialog } from "../components/EmailReportDialog";
import { usePagedList } from "../hooks/usePagedList";

// Prompts for Name, Owner, and a single Source (plain pick list — a
// dropdown, not search-as-you-type, since sources are a small bounded
// set), then lets entitlements from that source be multi-picked.
// Enabled/Requestable both default false server-side (not collected here).
function CreateAccessProfileModal({ onCreate, onClose, pending }) {
  const [name, setName] = useState("");
  const [owner, setOwner] = useState([]);
  const [sourceId, setSourceId] = useState("");
  const [entitlements, setEntitlements] = useState([]);

  const sourcesQuery = useQuery({ queryKey: ["sources-for-ap-create"], queryFn: () => listSources({ limit: 250 }) });
  const sources = sourcesQuery.data || [];

  const searchIdentities = async (q) => (await listIdentities({ limit: 15, query: q || undefined })).map((i) => ({ id: i.id, name: i.name }));
  const searchEntitlements = async (q) =>
    sourceId ? (await listEntitlementsBySource(sourceId, { limit: 25, query: q || undefined })).map((e) => ({ id: e.id, name: e.name })) : [];

  return (
    <div
      className="fixed inset-0 bg-black/30 z-30 flex items-end md:items-center justify-center"
      onClick={(e) => e.target === e.currentTarget && !pending && onClose()}
    >
      <div className="bg-white w-full max-w-md md:mx-4 rounded-t-2xl md:rounded-2xl shadow-xl p-5 max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-semibold text-gray-900">New Access Profile</h2>
          <button onClick={onClose} disabled={pending} className="text-gray-400 hover:text-gray-600 disabled:opacity-50">
            <X size={18} />
          </button>
        </div>

        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Access profile name" autoFocus />
        </Field>
        <PickerField
          label="Owner"
          placeholder="Search users…"
          searchFn={searchIdentities}
          multi={false}
          selected={owner}
          onChange={setOwner}
        />
        <Field label="Source">
          <Select
            value={sourceId}
            onChange={(e) => {
              setSourceId(e.target.value);
              setEntitlements([]); // a new source invalidates whatever was picked from the old one
            }}
          >
            <option value="">Select a source…</option>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </Select>
        </Field>
        <PickerField
          label="Entitlements"
          placeholder={sourceId ? "Search entitlements on this source…" : "Pick a source first"}
          searchFn={searchEntitlements}
          multi={true}
          selected={entitlements}
          onChange={setEntitlements}
        />

        <PrimaryButton
          onClick={() => onCreate({ name: name.trim(), owner: owner[0], sourceId, entitlementIds: entitlements.map((e) => e.id) })}
          loading={pending}
          disabled={!name.trim() || !owner[0] || !sourceId}
        >
          Create
        </PrimaryButton>
      </div>
    </div>
  );
}

// Full detail needs each profile's own entitlements/dates, which the list
// endpoint doesn't return — fetched a few at a time rather than all at once so
// a large list doesn't fire hundreds of simultaneous requests. Shared by the
// header's Detail Report and the selection-scoped print so the two can't drift.
async function enrichProfilesForReport(profiles) {
  const detailed = [];
  const batchSize = 5;
  for (let i = 0; i < profiles.length; i += batchSize) {
    const batch = profiles.slice(i, i + batchSize);
    detailed.push(...(await Promise.all(batch.map((ap) => getAccessProfile(ap.id)))));
  }
  return detailed;
}

export default function AccessProfilesPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { search, debouncedSearch, handleSearch } = useUrlSearch();
  const [selected, setSelected] = useState(() => new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [progress, setProgress] = useState(0);
  const [changeOwnerOpen, setChangeOwnerOpen] = useState(false);
  // URL-backed (not useState) — same pattern as Roles' Active/Disabled
  // filter, so it survives navigating into an access profile's detail page
  // and clicking Back.
  const [enabledFilter, setEnabledFilter] = useUrlState("status", "ALL");
  const metadataFilter = useMetadataFilter();
  const metadataMatch = useMetadataMatchIds("accessprofiles", metadataFilter.filter);
  const segmentFilter = useSegmentFilter();
  const segmentMatch = useSegmentMatchIds("accessprofiles", segmentFilter.filter);
  const [printMenuOpen, setPrintMenuOpen] = useState(false);
  const [descriptionResults, setDescriptionResults] = useState(null);
  const [creating, setCreating] = useState(false);
  const emailReport = useEmailReportAction({
    objectLabel: "Access Profile",
    buildDetailPdfBase64: async ({ tenant, items }) => {
      const enriched = await enrichProfilesForReport(items);
      return buildAccessProfilesDetailPdfBase64({ tenant, profiles: enriched });
    },
    itemLabel: (p) => p.name,
    onDone: () => setSelected(new Set()),
  });

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["access-profiles", debouncedSearch],
    // includeNonRequestable — this list now doubles as where Requestable
    // gets turned on (see the pill below), and a brand-new access profile
    // defaults to requestable:false, so excluding those would hide every
    // profile right after creation.
    queryFn: () => fetchAllPages((page) => listAccessProfiles({ ...page, query: debouncedSearch || undefined, includeNonRequestable: true })),
    keepPreviousData: true,
  });

  // "enabled" isn't a queryable filter on ISC's own /v2026/access-profiles
  // (confirmed live: 400 "not queryable"), so Active/Disabled is applied
  // client-side against the fetched page rather than as a filters clause.
  const list = (Array.isArray(data) ? data : [])
    .filter((ap) => (enabledFilter === "ACTIVE" ? ap.enabled : enabledFilter === "DISABLED" ? !ap.enabled : true))
    .filter((ap) => !metadataFilter.filter || (metadataMatch.ids ? metadataMatch.ids.has(ap.id) : false))
    .filter((ap) => !segmentFilter.filter || (segmentMatch.ids ? segmentMatch.ids.has(ap.id) : false));
  const allSelected = list.length > 0 && list.every((ap) => selected.has(ap.id));
  const { page, pager } = usePagedList(list, { noun: "access profile", resetKey: `${debouncedSearch}|${enabledFilter}|${metadataFilter.filter?.value || ""}|${segmentFilter.filter?.id || ""}` });
  // Tag Metadata: add a metadata value to — or remove it from — the selection.
  const tagMetadata = useBulkTagMetadata({
    kind: "access-profiles",
    noun: "access profiles",
    ids: [...selected],
    names: new Map(list.map((x) => [x.id, x.displayName || x.name])),
    invalidateKeys: [["access-profiles"], ["access-profile"]],
    onDone: () => setSelected(new Set()),
  });
  const profileById = new Map(list.map((ap) => [ap.id, ap]));

  function toggleOne(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) => {
      if (allSelected) return new Set();
      return new Set(list.map((ap) => ap.id));
    });
  }

  const printList = useMutation({
    mutationFn: async () => {
      const tenant = getCredentials()?.tenant;
      return printAccessProfilesListPdf({ tenant, profiles: list, searchQuery: debouncedSearch || undefined });
    },
    onSuccess: (opened) => {
      setPrintMenuOpen(false);
      if (!opened) toast("Pop-up blocked — downloaded the PDF instead");
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const printDetail = useMutation({
    mutationFn: async () => {
      const profiles = await enrichProfilesForReport(list);
      const tenant = getCredentials()?.tenant;
      return printAccessProfilesDetailPdf({ tenant, profiles, searchQuery: debouncedSearch || undefined });
    },
    onSuccess: (opened) => {
      setPrintMenuOpen(false);
      if (!opened) toast("Pop-up blocked — downloaded the PDF instead");
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const printPending = printList.isPending || printDetail.isPending;

  // Scoped to the current selection, unlike the header's print menu which
  // deliberately covers the whole filtered list. Both exist because "print
  // what I picked" and "print what I'm looking at" are different intents.
  const printSelectedDetail = useMutation({
    mutationFn: async () => {
      const tenant = getCredentials()?.tenant;
      const chosen = await enrichProfilesForReport(list.filter((r) => selected.has(r.id)));
      return printAccessProfilesDetailPdf({ tenant, profiles: chosen });
    },
    onSuccess: (opened) => {
      if (!opened) toast("Pop-up blocked — downloaded the PDF instead");
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const generateDescriptions = useMutation({
    mutationFn: () => generateAllAccessProfileDescriptions(list.map((ap) => ap.id)),
    onSuccess: (result) => setDescriptionResults(result.results),
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const saveDescriptions = useMutation({
    mutationFn: (items) => Promise.all(items.map(({ roleId, description }) => updateAccessProfile(roleId, { description }))),
    onSuccess: (_result, items) => {
      toast.success(`${items.length} description${items.length === 1 ? "" : "s"} saved`);
      queryClient.invalidateQueries({ queryKey: ["access-profiles"] });
      setDescriptionResults(null);
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const createProfile = useMutation({
    mutationFn: (fields) => createAccessProfile(fields),
    onSuccess: () => {
      toast.success("Access profile created");
      setCreating(false);
      queryClient.invalidateQueries({ queryKey: ["access-profiles"] });
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const toggleEnabled = useMutation({
    mutationFn: ({ id, enabled }) => setAccessProfileEnabled(id, enabled),
    onSuccess: (_data, { enabled }) => {
      toast.success(enabled ? "Enabled" : "Disabled");
      queryClient.invalidateQueries({ queryKey: ["access-profiles"] });
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const toggleRequestable = useMutation({
    mutationFn: ({ id, requestable }) => updateAccessProfile(id, { requestable }),
    onSuccess: (_data, { requestable }) => {
      toast.success(requestable ? "Requestable" : "No Requests");
      queryClient.invalidateQueries({ queryKey: ["access-profiles"] });
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const bulkDelete = useMutation({
    mutationFn: async () => {
      const ids = [...selected];
      const results = [];
      for (const id of ids) {
        try {
          await deleteAccessProfile(id);
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
        toast.error(`Deleted ${results.length - failed.length} of ${results.length} access profiles — ${failed.length} failed`);
      } else {
        toast.success(`Deleted ${results.length} access profile${results.length === 1 ? "" : "s"}`);
      }
      setSelected(new Set());
      setConfirmOpen(false);
      setProgress(0);
      queryClient.invalidateQueries({ queryKey: ["access-profiles"] });
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  // Bulk versions of the per-row Enable/Disable and Requestable/No Requests
  // pills, applied to every selected profile — same sequential-loop-with-
  // progress pattern as bulkDelete.
  function makeBulkToggle({ label, verb, run }) {
    return useMutation({
      mutationFn: async () => {
        const ids = [...selected];
        const results = [];
        for (const id of ids) {
          try {
            await run(id);
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
          toast.error(`${verb} ${results.length - failed.length} of ${results.length} ${label} — ${failed.length} failed`);
        } else {
          toast.success(`${verb} ${results.length} access profile${results.length === 1 ? "" : "s"}`);
        }
        setSelected(new Set());
        setProgress(0);
        queryClient.invalidateQueries({ queryKey: ["access-profiles"] });
      },
      onError: (err) => toast.error(err.response?.data?.error || err.message),
    });
  }

  const bulkEnable = makeBulkToggle({ label: "enabled", verb: "Enabled", run: (id) => setAccessProfileEnabled(id, true) });
  const bulkDisable = makeBulkToggle({ label: "disabled", verb: "Disabled", run: (id) => setAccessProfileEnabled(id, false) });
  const bulkMakeRequestable = makeBulkToggle({ label: "requestable", verb: "Made requestable", run: (id) => updateAccessProfile(id, { requestable: true }) });
  const bulkNoRequests = makeBulkToggle({ label: "no-requests", verb: "Set to no requests", run: (id) => updateAccessProfile(id, { requestable: false }) });

  // Takes the picked owner as its mutate() argument (unlike makeBulkToggle's
  // zero-arg run), so it's its own useMutation rather than built from that
  // factory — same loop-with-progress shape otherwise.
  const bulkChangeOwner = useMutation({
    mutationFn: async (owner) => {
      const ids = [...selected];
      const results = [];
      for (const id of ids) {
        try {
          await updateAccessProfile(id, { owner: { id: owner.id, name: owner.name } });
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
        toast.error(`Changed owner for ${results.length - failed.length} of ${results.length} access profiles — ${failed.length} failed`);
      } else {
        toast.success(`Changed owner for ${results.length} access profile${results.length === 1 ? "" : "s"}`);
      }
      setSelected(new Set());
      setChangeOwnerOpen(false);
      setProgress(0);
      queryClient.invalidateQueries({ queryKey: ["access-profiles"] });
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const bulkActionPending =
    bulkEnable.isPending || bulkDisable.isPending || bulkMakeRequestable.isPending || bulkNoRequests.isPending || bulkChangeOwner.isPending;

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <TopBar
        title={<BrowseTitleMenu active="Access Profiles" />}
        loading={isLoading}
        action={
          <div className="relative flex items-center gap-2">
            <IconButton icon={Plus} title="Create Access Profile" onClick={() => setCreating(true)} />
            {list.length > 0 && (
              <>
                <IconButton
                  icon={Wand2}
                  title="Generate descriptions for the access profiles currently shown"
                  onClick={() => generateDescriptions.mutate()}
                  loading={generateDescriptions.isPending}
                />
                <IconButton
                  icon={Printer}
                  title="Print access profiles"
                  onClick={() => setPrintMenuOpen((v) => !v)}
                  disabled={printPending}
                />
                {printMenuOpen && (
                  <>
                    <div className="fixed inset-0 z-10" onClick={() => setPrintMenuOpen(false)} />
                    <div className="absolute right-0 top-full mt-1 w-56 bg-white border border-gray-200 rounded-xl shadow-lg z-20 overflow-hidden">
                      <button
                        onClick={() => printList.mutate()}
                        disabled={printPending}
                        className="w-full text-left px-4 py-3 text-sm text-gray-900 hover:bg-gray-50 disabled:opacity-50"
                      >
                        <p className="font-medium">Simple list</p>
                        <p className="text-xs text-gray-500 mt-0.5">Name, source, and owner only</p>
                      </button>
                      <button
                        onClick={() => printDetail.mutate()}
                        disabled={printPending}
                        className="w-full text-left px-4 py-3 text-sm text-gray-900 hover:bg-gray-50 disabled:opacity-50 border-t border-gray-100"
                      >
                        <p className="font-medium">Detail report</p>
                        <p className="text-xs text-gray-500 mt-0.5">
                          All fields per profile{printDetail.isPending ? " — generating…" : ", one page break between profiles"}
                        </p>
                      </button>
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        }
      />
      <div className="flex-1 overflow-y-auto pb-24">
        <SearchBar value={search} onChange={handleSearch} placeholder="Search access profiles…" />
        <FilterBar
          options={[
            { value: "ALL", label: "All" },
            { value: "ACTIVE", label: "Active" },
            { value: "DISABLED", label: "Disabled" },
          ]}
          active={enabledFilter}
          onChange={setEnabledFilter}
          right={
            <div className="flex items-center gap-2">
              <MetadataFilterControl filter={metadataFilter.filter} onApply={metadataFilter.set} onClear={metadataFilter.clear} />
              <SegmentFilterControl filter={segmentFilter.filter} onApply={segmentFilter.set} onClear={segmentFilter.clear} />
            </div>
          }
        />
        {metadataMatch.error && <ErrorBox message={`Metadata filter failed: ${metadataMatch.error.response?.data?.error || metadataMatch.error.message}`} />}
        {segmentMatch.error && <ErrorBox message={`Segment filter failed: ${segmentMatch.error.response?.data?.error || segmentMatch.error.message}`} />}

        {error && <ErrorBox message={error.message} onRetry={refetch} />}
        {(isLoading || metadataMatch.isLoading || segmentMatch.isLoading) && <SkeletonList rows={8} />}
        {!isLoading && !metadataMatch.isLoading && !segmentMatch.isLoading && !error && list.length === 0 && (
          <EmptyState
            icon={ShieldCheck}
            title={debouncedSearch ? "No results" : "No access profiles found"}
            subtitle={debouncedSearch ? `No access profiles match "${debouncedSearch}"` : "Use the + icon above to create one"}
          />
        )}

        {!isLoading && list.length > 0 && (
          <div>
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
                {list.length} access profile{list.length !== 1 && "s"}{debouncedSearch && " matching"}
              </p>
            </div>

            {selected.size > 0 && (
              <SelectionActionBar
                count={selected.size}
                progressText={bulkChangeOwner.isPending ? `Changing owner for ${progress} of ${selected.size}…` : null}
                actions={[
                  { icon: Tags, title: `Tag Metadata (${selected.size})`, onClick: tagMetadata.open, loading: tagMetadata.pending },
                  { icon: Power, title: `Enable (${selected.size})`, onClick: () => bulkEnable.mutate(), loading: bulkEnable.isPending, disabled: bulkActionPending },
                  { icon: PowerOff, title: `Disable (${selected.size})`, onClick: () => bulkDisable.mutate(), loading: bulkDisable.isPending, disabled: bulkActionPending },
                  { icon: CheckCircle2, title: `Make Requestable (${selected.size})`, onClick: () => bulkMakeRequestable.mutate(), loading: bulkMakeRequestable.isPending, disabled: bulkActionPending },
                  { icon: XCircle, title: `No Requests (${selected.size})`, onClick: () => bulkNoRequests.mutate(), loading: bulkNoRequests.isPending, disabled: bulkActionPending },
                  { icon: UserCog, title: `Change Owner (${selected.size})`, onClick: () => setChangeOwnerOpen(true), disabled: bulkActionPending },
                  { icon: Trash2, title: `Delete Selected Access Profiles (${selected.size})`, onClick: () => setConfirmOpen(true), danger: true },
                  {
                    icon: Mail,
                    title: `Email Report (${selected.size})`,
                    onClick: () => emailReport.setConfirmOpen(true),
                    loading: emailReport.mutation.isPending,
                    disabled: emailReport.mutation.isPending,
                  },
                  {
                    icon: Printer,
                    title: `Print Detail for Selected (${selected.size})`,
                    onClick: () => printSelectedDetail.mutate(),
                    loading: printSelectedDetail.isPending,
                  },
                ]}
              />
            )}

            {pager}
            {page.map((ap) => (
              <div
                key={ap.id}
                className="w-full flex items-center gap-3 px-4 py-3.5 border-b border-gray-100 hover:bg-gray-50 transition-colors"
              >
                <input
                  type="checkbox"
                  checked={selected.has(ap.id)}
                  onChange={() => toggleOne(ap.id)}
                  className="w-4 h-4 rounded border-gray-300 flex-shrink-0"
                />
                <button
                  onClick={() => navigate(`/access-profiles/${ap.id}`)}
                  className="flex-1 min-w-0 flex items-center gap-3 text-left active:bg-gray-100"
                >
                  <div className="w-10 h-10 rounded-full bg-violet-50 flex items-center justify-center flex-shrink-0">
                    <ShieldCheck size={16} className="text-violet-600" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{ap.name}</p>
                    <p className="text-xs text-gray-500 mt-0.5 truncate">
                      {ap.source?.name || ap.description || "—"}
                    </p>
                  </div>
                </button>
                <button
                  type="button"
                  title={ap.enabled ? "Disable" : "Enable"}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleEnabled.mutate({ id: ap.id, enabled: !ap.enabled });
                  }}
                  disabled={toggleEnabled.isPending && toggleEnabled.variables?.id === ap.id}
                  className={`text-xs font-medium px-2 py-0.5 rounded-full border flex-shrink-0 transition-colors disabled:opacity-50 ${
                    ap.enabled
                      ? "bg-blue-50 text-blue-700 border-blue-200 hover:bg-gray-50 hover:text-gray-500 hover:border-gray-200"
                      : "bg-gray-50 text-gray-500 border-gray-200 hover:bg-blue-50 hover:text-blue-700 hover:border-blue-200"
                  }`}
                >
                  {ap.enabled ? "Enabled" : "Disabled"}
                </button>
                <button
                  type="button"
                  title={ap.requestable ? "Disallow requests" : "Allow requests"}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleRequestable.mutate({ id: ap.id, requestable: !ap.requestable });
                  }}
                  disabled={toggleRequestable.isPending && toggleRequestable.variables?.id === ap.id}
                  className={`text-xs font-medium px-2 py-0.5 rounded-full border flex-shrink-0 transition-colors disabled:opacity-50 ${
                    ap.requestable
                      ? "bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-gray-50 hover:text-gray-500 hover:border-gray-200"
                      : "bg-gray-50 text-gray-500 border-gray-200 hover:bg-emerald-50 hover:text-emerald-700 hover:border-emerald-200"
                  }`}
                >
                  {ap.requestable ? "Requestable" : "No Requests"}
                </button>
                <ChevronRight size={16} className="text-gray-300 flex-shrink-0" />
              </div>
            ))}
            {pager}
          </div>
        )}
      </div>

      {creating && (
        <CreateAccessProfileModal
          onCreate={(fields) => createProfile.mutate(fields)}
          onClose={() => setCreating(false)}
          pending={createProfile.isPending}
        />
      )}

      {confirmOpen && (
        <ConfirmModal
          title={`Delete ${selected.size} access profile${selected.size === 1 ? "" : "s"}?`}
          message={`This permanently deletes the selected access profile${selected.size === 1 ? "" : "s"} from this tenant. This cannot be undone.`}
          confirmLabel="Delete"
          danger
          pending={bulkDelete.isPending}
          progressText={`Deleting ${progress} of ${selected.size}…`}
          onConfirm={() => bulkDelete.mutate()}
          onCancel={() => setConfirmOpen(false)}
        />
      )}

      {changeOwnerOpen && (
        <ChangeOwnerModal
          count={selected.size}
          pending={bulkChangeOwner.isPending}
          progressText={`Changing owner for ${progress} of ${selected.size}…`}
          onConfirm={(owner) => bulkChangeOwner.mutate(owner)}
          onClose={() => setChangeOwnerOpen(false)}
        />
      )}

      {descriptionResults && (
        <BulkDescriptionReviewSheet
          items={descriptionResults}
          roleById={profileById}
          onClose={() => setDescriptionResults(null)}
          onSaveSelected={(items) => saveDescriptions.mutate(items)}
          pending={saveDescriptions.isPending}
        />
      )}

      {generateDescriptions.isPending && (
        <div className="fixed inset-0 bg-black/20 z-20 flex items-center justify-center pointer-events-none">
          <div className="bg-white rounded-2xl shadow-xl px-5 py-4 flex items-center gap-3">
            <Spinner size={18} />
            <p className="text-sm text-gray-600">Generating descriptions for {list.length} access profile{list.length === 1 ? "" : "s"}…</p>
          </div>
        </div>
      )}

      {emailReport.confirmOpen && (
        <ConfirmModal
          title={`Email report for ${selected.size} access profile${selected.size === 1 ? "" : "s"}?`}
          message={
            `Builds one Access Profile Report PDF per owner (access profiles sharing an owner are combined into ` +
            `one report) and publishes each to a link — the link is used instead of an attachment since email ` +
            `links can't carry files. Nothing is sent automatically: you'll get a list to review, and each email ` +
            `only opens your mail app when you click its own send icon, one at a time. An access profile with no ` +
            `owner, or an owner with no email address on file, is skipped.`
          }
          confirmLabel="Build Reports"
          pending={emailReport.mutation.isPending}
          onConfirm={() => emailReport.mutation.mutate(list.filter((ap) => selected.has(ap.id)))}
          onCancel={() => emailReport.setConfirmOpen(false)}
        />
      )}

      {emailReport.dialog && (
        <EmailReportDialog
          objectLabel="Access Profile"
          dialog={emailReport.dialog}
          onClose={() => emailReport.setDialog(null)}
          onMarkSent={(ownerId) =>
            emailReport.setDialog((prev) => ({
              ...prev,
              prepared: prev.prepared.map((r) => (r.ownerId === ownerId ? { ...r, sent: true } : r)),
            }))
          }
        />
      )}
      {tagMetadata.element}
    </div>
  );
}
