import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { LayoutGrid, ChevronRight, Plus, Trash2, Wand2, Printer, Power, PowerOff, CheckCircle2, XCircle, Eye, EyeOff } from "lucide-react";
import toast from "react-hot-toast";
import {
  listAllSourceApps, createSourceApp, deleteSourceApp, updateSourceApp, generateAllSourceAppDescriptions,
  getCredentials, listSourceAppAccessProfiles,
} from "../lib/sailpoint";
import { printApplicationsListPdf, printApplicationsDetailPdf } from "../lib/exportRolePdf";
import { useAuth } from "../hooks/useAuth";
import { useUrlSearch } from "../hooks/useUrlSearch";
import { useUrlState } from "../hooks/useUrlState";
import { TopBar } from "../components/TopBar";
import { BrowseTitleMenu } from "../components/BrowseTitleMenu";
import { SearchBar, FilterBar, SkeletonList, EmptyState, ErrorBox, IconButton, ConfirmModal, Spinner, SelectionActionBar } from "../components/ui";
import { BulkDescriptionReviewSheet } from "../components/BulkDescriptionReviewSheet";
import { ApplicationFormModal } from "../components/ApplicationFormModal";
import { usePagedList } from "../hooks/usePagedList";

// Tenant-wide browse of every Application (across all sources) — search,
// select one or all, bulk delete, Generate Descriptions, and create
// (create prompts for a Source since this isn't scoped to one). Selecting a
// row navigates to its own detail page (ApplicationDetailPage) rather than
// opening an edit dialog.
// Full detail needs each app's own assigned access profiles, which the list
// endpoint doesn't return — batched for the same reason as Access Profiles, and
// shared by the header's Detail Report and the selection-scoped print.
async function enrichAppsForReport(apps) {
  const detailed = [];
  const batchSize = 5;
  for (let i = 0; i < apps.length; i += batchSize) {
    const batch = apps.slice(i, i + batchSize);
    detailed.push(...(await Promise.all(
      batch.map(async (a) => ({ ...a, accessProfiles: await listSourceAppAccessProfiles(a.id) }))
    )));
  }
  return detailed;
}

export default function ApplicationsPage() {
  const { session } = useAuth();
  const currentUser = session?.identity
    ? { id: session.identity.id, name: session.identity.displayName || session.identity.username }
    : null;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { search, debouncedSearch, handleSearch } = useUrlSearch();
  // URL-backed (not useState) — same pattern as Roles' Active/Disabled
  // filter, so it survives navigating into an application's detail page
  // and clicking Back.
  const [enabledFilter, setEnabledFilter] = useUrlState("status", "ALL");
  const [selected, setSelected] = useState(() => new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [progress, setProgress] = useState(0);
  const [creating, setCreating] = useState(false);
  const [descriptionResults, setDescriptionResults] = useState(null);
  const [printMenuOpen, setPrintMenuOpen] = useState(false);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["all-source-apps"],
    queryFn: listAllSourceApps,
  });

  const list = (Array.isArray(data) ? data : [])
    .filter((a) => !debouncedSearch || a.name?.toLowerCase().includes(debouncedSearch.toLowerCase()))
    .filter((a) => (enabledFilter === "ACTIVE" ? a.enabled : enabledFilter === "DISABLED" ? !a.enabled : true))
    .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  const appById = new Map(list.map((a) => [a.id, a]));
  const { page, pager } = usePagedList(list, { noun: "application", resetKey: `${debouncedSearch}|${enabledFilter}` });
  const allSelected = list.length > 0 && list.every((a) => selected.has(a.id));

  function toggleOne(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleAll() {
    setSelected((prev) => (allSelected ? new Set() : new Set(list.map((a) => a.id))));
  }

  const createApp = useMutation({
    mutationFn: ({ name, owner, matchAllAccounts, sourceId }) => createSourceApp(sourceId, { name, owner, matchAllAccounts }),
    onSuccess: () => {
      toast.success("Application created");
      setCreating(false);
      queryClient.invalidateQueries({ queryKey: ["all-source-apps"] });
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const togglePillField = useMutation({
    mutationFn: ({ id, field, value }) => updateSourceApp(id, { [field]: value }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["all-source-apps"] }),
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  // Scoped to the current selection, unlike the header's print menu which
  // deliberately covers the whole filtered list. Both exist because "print
  // what I picked" and "print what I'm looking at" are different intents.
  const printSelectedDetail = useMutation({
    mutationFn: async () => {
      const tenant = getCredentials()?.tenant;
      const chosen = await enrichAppsForReport(list.filter((r) => selected.has(r.id)));
      return printApplicationsDetailPdf({ tenant, apps: chosen });
    },
    onSuccess: (opened) => {
      if (!opened) toast("Pop-up blocked — downloaded the PDF instead");
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const bulkDelete = useMutation({
    mutationFn: async () => {
      const ids = [...selected];
      const results = [];
      for (const id of ids) {
        try {
          await deleteSourceApp(id);
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
        toast.error(`Deleted ${results.length - failed.length} of ${results.length} applications — ${failed.length} failed`);
      } else {
        toast.success(`Deleted ${results.length} application${results.length === 1 ? "" : "s"}`);
      }
      setSelected(new Set());
      setConfirmOpen(false);
      setProgress(0);
      queryClient.invalidateQueries({ queryKey: ["all-source-apps"] });
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const printList = useMutation({
    mutationFn: async () => {
      const tenant = getCredentials()?.tenant;
      return printApplicationsListPdf({ tenant, apps: list, searchQuery: debouncedSearch || undefined });
    },
    onSuccess: (opened) => {
      setPrintMenuOpen(false);
      if (!opened) toast("Pop-up blocked — downloaded the PDF instead");
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const printDetail = useMutation({
    mutationFn: async () => {
      const apps = await enrichAppsForReport(list);
      const tenant = getCredentials()?.tenant;
      return printApplicationsDetailPdf({ tenant, apps, searchQuery: debouncedSearch || undefined });
    },
    onSuccess: (opened) => {
      setPrintMenuOpen(false);
      if (!opened) toast("Pop-up blocked — downloaded the PDF instead");
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const printPending = printList.isPending || printDetail.isPending;

  const generateDescriptions = useMutation({
    mutationFn: (ids) => generateAllSourceAppDescriptions(ids),
    onSuccess: (result) => setDescriptionResults(result.results),
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  // Bulk versions of the per-row Enable/Disable and Requestable/No Requests
  // pills, applied to every selected application.
  function makeBulkToggle({ label, verb, field, value }) {
    return useMutation({
      mutationFn: async () => {
        const ids = [...selected];
        const results = [];
        for (const id of ids) {
          try {
            await updateSourceApp(id, { [field]: value });
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
          toast.success(`${verb} ${results.length} application${results.length === 1 ? "" : "s"}`);
        }
        setSelected(new Set());
        setProgress(0);
        queryClient.invalidateQueries({ queryKey: ["all-source-apps"] });
      },
      onError: (err) => toast.error(err.response?.data?.error || err.message),
    });
  }

  const bulkEnable = makeBulkToggle({ label: "enabled", verb: "Enabled", field: "enabled", value: true });
  const bulkDisable = makeBulkToggle({ label: "disabled", verb: "Disabled", field: "enabled", value: false });
  const bulkMakeRequestable = makeBulkToggle({ label: "requestable", verb: "Made requestable", field: "provisionRequestEnabled", value: true });
  const bulkNoRequests = makeBulkToggle({ label: "no-requests", verb: "Set to no requests", field: "provisionRequestEnabled", value: false });
  const bulkMakeVisible = makeBulkToggle({ label: "visible", verb: "Made visible", field: "appCenterEnabled", value: true });
  const bulkMakeInvisible = makeBulkToggle({ label: "invisible", verb: "Made invisible", field: "appCenterEnabled", value: false });

  const bulkActionPending =
    bulkEnable.isPending || bulkDisable.isPending || bulkMakeRequestable.isPending || bulkNoRequests.isPending ||
    bulkMakeVisible.isPending || bulkMakeInvisible.isPending;

  const saveDescriptions = useMutation({
    mutationFn: (items) => Promise.all(items.map(({ roleId, description }) => updateSourceApp(roleId, { description }))),
    onSuccess: (_result, items) => {
      toast.success(`${items.length} description${items.length === 1 ? "" : "s"} saved`);
      queryClient.invalidateQueries({ queryKey: ["all-source-apps"] });
      setDescriptionResults(null);
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <TopBar
        title={<BrowseTitleMenu active="Applications" />}
        loading={isLoading}
        action={
          <div className="relative flex items-center gap-2">
            <IconButton icon={Plus} title="Create Application" onClick={() => setCreating(true)} />
            {list.length > 0 && (
              <>
                <IconButton
                  icon={Wand2}
                  title="Generate descriptions for the applications currently shown"
                  onClick={() => generateDescriptions.mutate(list.map((a) => a.id))}
                  loading={generateDescriptions.isPending}
                />
                <IconButton
                  icon={Printer}
                  title="Print applications"
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
                          All fields per application{printDetail.isPending ? " — generating…" : ", one page break between applications"}
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
        <SearchBar value={search} onChange={handleSearch} placeholder="Search applications…" />
        <FilterBar
          options={[
            { value: "ALL", label: "All" },
            { value: "ACTIVE", label: "Enabled" },
            { value: "DISABLED", label: "Disabled" },
          ]}
          active={enabledFilter}
          onChange={setEnabledFilter}
        />

        {error && <ErrorBox message={error.message} onRetry={refetch} />}
        {isLoading && <SkeletonList rows={8} />}
        {!isLoading && !error && list.length === 0 && (
          <EmptyState
            icon={LayoutGrid}
            title={debouncedSearch ? "No results" : "No applications found"}
            subtitle={debouncedSearch ? `No applications match "${debouncedSearch}"` : "Use the + icon above to create one"}
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
                {list.length} application{list.length !== 1 && "s"}{debouncedSearch && " matching"}
              </p>
            </div>

            {selected.size > 0 && (
              <SelectionActionBar
                count={selected.size}
                actions={[
                  { icon: Wand2, title: `Generate Descriptions (${selected.size})`, onClick: () => generateDescriptions.mutate([...selected]), loading: generateDescriptions.isPending, disabled: bulkActionPending },
                  { icon: Power, title: `Enable (${selected.size})`, onClick: () => bulkEnable.mutate(), loading: bulkEnable.isPending, disabled: bulkActionPending },
                  { icon: PowerOff, title: `Disable (${selected.size})`, onClick: () => bulkDisable.mutate(), loading: bulkDisable.isPending, disabled: bulkActionPending },
                  { icon: CheckCircle2, title: `Make Requestable (${selected.size})`, onClick: () => bulkMakeRequestable.mutate(), loading: bulkMakeRequestable.isPending, disabled: bulkActionPending },
                  { icon: XCircle, title: `No Requests (${selected.size})`, onClick: () => bulkNoRequests.mutate(), loading: bulkNoRequests.isPending, disabled: bulkActionPending },
                  { icon: Eye, title: `Make Visible (${selected.size})`, onClick: () => bulkMakeVisible.mutate(), loading: bulkMakeVisible.isPending, disabled: bulkActionPending },
                  { icon: EyeOff, title: `Make Invisible (${selected.size})`, onClick: () => bulkMakeInvisible.mutate(), loading: bulkMakeInvisible.isPending, disabled: bulkActionPending },
                  { icon: Trash2, title: `Delete Selected Applications (${selected.size})`, onClick: () => setConfirmOpen(true), danger: true },
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
            {page.map((a) => (
              <div
                key={a.id}
                className="w-full flex items-center gap-3 px-4 py-3.5 border-b border-gray-100 hover:bg-gray-50 transition-colors"
              >
                <input
                  type="checkbox"
                  checked={selected.has(a.id)}
                  onChange={() => toggleOne(a.id)}
                  className="w-4 h-4 rounded border-gray-300 flex-shrink-0"
                />
                <button
                  onClick={() => navigate(`/applications/${a.id}`)}
                  className="flex-1 min-w-0 flex items-center gap-3 text-left active:bg-gray-100"
                >
                  <div className="w-10 h-10 rounded-full bg-violet-50 flex items-center justify-center flex-shrink-0">
                    <LayoutGrid size={16} className="text-violet-600" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{a.name}</p>
                    <p className="text-xs text-gray-500 mt-0.5 truncate">{a.accountSource?.name || "—"}</p>
                  </div>
                  <ChevronRight size={16} className="text-gray-300 flex-shrink-0" />
                </button>
                <button
                  type="button"
                  title={a.enabled ? "Disable" : "Enable"}
                  onClick={(e) => {
                    e.stopPropagation();
                    togglePillField.mutate({ id: a.id, field: "enabled", value: !a.enabled });
                  }}
                  disabled={togglePillField.isPending && togglePillField.variables?.id === a.id && togglePillField.variables?.field === "enabled"}
                  className={`text-xs font-medium px-2 py-0.5 rounded-full border flex-shrink-0 transition-colors disabled:opacity-50 ${
                    a.enabled
                      ? "bg-blue-50 text-blue-700 border-blue-200 hover:bg-gray-50 hover:text-gray-500 hover:border-gray-200"
                      : "bg-gray-50 text-gray-500 border-gray-200 hover:bg-blue-50 hover:text-blue-700 hover:border-blue-200"
                  }`}
                >
                  {a.enabled ? "Enabled" : "Disabled"}
                </button>
                <button
                  type="button"
                  title={a.appCenterEnabled ? "Hide from request center" : "Show in request center"}
                  onClick={(e) => {
                    e.stopPropagation();
                    togglePillField.mutate({ id: a.id, field: "appCenterEnabled", value: !a.appCenterEnabled });
                  }}
                  disabled={togglePillField.isPending && togglePillField.variables?.id === a.id && togglePillField.variables?.field === "appCenterEnabled"}
                  className={`text-xs font-medium px-2 py-0.5 rounded-full border flex-shrink-0 transition-colors disabled:opacity-50 ${
                    a.appCenterEnabled
                      ? "bg-blue-50 text-blue-700 border-blue-200 hover:bg-gray-50 hover:text-gray-500 hover:border-gray-200"
                      : "bg-gray-50 text-gray-500 border-gray-200 hover:bg-blue-50 hover:text-blue-700 hover:border-blue-200"
                  }`}
                >
                  {a.appCenterEnabled ? "Visible" : "Hidden"}
                </button>
                <button
                  type="button"
                  title={a.provisionRequestEnabled ? "Disallow access requests" : "Allow access requests"}
                  onClick={(e) => {
                    e.stopPropagation();
                    togglePillField.mutate({ id: a.id, field: "provisionRequestEnabled", value: !a.provisionRequestEnabled });
                  }}
                  disabled={togglePillField.isPending && togglePillField.variables?.id === a.id && togglePillField.variables?.field === "provisionRequestEnabled"}
                  className={`text-xs font-medium px-2 py-0.5 rounded-full border flex-shrink-0 transition-colors disabled:opacity-50 ${
                    a.provisionRequestEnabled
                      ? "bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-gray-50 hover:text-gray-500 hover:border-gray-200"
                      : "bg-gray-50 text-gray-500 border-gray-200 hover:bg-emerald-50 hover:text-emerald-700 hover:border-emerald-200"
                  }`}
                >
                  {a.provisionRequestEnabled ? "Requestable" : "Not Requestable"}
                </button>
              </div>
            ))}
            {pager}
          </>
        )}
      </div>

      {creating && (
        <ApplicationFormModal
          currentUser={currentUser}
          onSave={(fields) => createApp.mutate(fields)}
          onClose={() => setCreating(false)}
          pending={createApp.isPending}
        />
      )}

      {confirmOpen && (
        <ConfirmModal
          title={`Delete ${selected.size} application${selected.size === 1 ? "" : "s"}?`}
          message={`This permanently deletes the selected application${selected.size === 1 ? "" : "s"} from this tenant. This cannot be undone.`}
          confirmLabel="Delete"
          danger
          pending={bulkDelete.isPending}
          progressText={`Deleting ${progress} of ${selected.size}…`}
          onConfirm={() => bulkDelete.mutate()}
          onCancel={() => setConfirmOpen(false)}
        />
      )}

      {descriptionResults && (
        <BulkDescriptionReviewSheet
          items={descriptionResults}
          roleById={appById}
          onClose={() => setDescriptionResults(null)}
          onSaveSelected={(items) => saveDescriptions.mutate(items)}
          pending={saveDescriptions.isPending}
        />
      )}

      {generateDescriptions.isPending && (
        <div className="fixed inset-0 bg-black/20 z-20 flex items-center justify-center pointer-events-none">
          <div className="bg-white rounded-2xl shadow-xl px-5 py-4 flex items-center gap-3">
            <Spinner size={18} />
            <p className="text-sm text-gray-600">
              Generating descriptions for {(generateDescriptions.variables || []).length} application
              {(generateDescriptions.variables || []).length === 1 ? "" : "s"}…
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
