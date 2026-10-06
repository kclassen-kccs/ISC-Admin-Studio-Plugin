import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { ChevronRight, Database, Printer, Wand2, Plus, Mail } from "lucide-react";
import toast from "react-hot-toast";
import {
  listSources, getCredentials, fetchAllPages, generateAllSourceDescriptions, updateSourceDescription, isSaasSource, isVaSource,
} from "../lib/sailpoint";
import { printSourcesListPdf, printSourcesDetailPdf, buildSourcesDetailPdfBase64 } from "../lib/exportRolePdf";
import { useUrlSearch } from "../hooks/useUrlSearch";
import { useUrlState } from "../hooks/useUrlState";
import { useEmailReportAction } from "../hooks/useEmailReportAction";
import { TopBar } from "../components/TopBar";
import { BrowseTitleMenu } from "../components/BrowseTitleMenu";
import { SearchBar, SegmentedPill, SkeletonList, EmptyState, ErrorBox, IconButton, SelectionActionBar, Spinner, ConfirmModal } from "../components/ui";
import { BulkDescriptionReviewSheet } from "../components/BulkDescriptionReviewSheet";
import { AddDisconnectedSourceModal } from "../components/AddDisconnectedSourceModal";
import { EmailReportDialog } from "../components/EmailReportDialog";
import { usePagedList } from "../hooks/usePagedList";

// Same list-screen shape as Roles/Access Profiles/Data Segments/Applications —
// search, a status filter, select one or all, and a bulk action. Sources
// have no enable/disable or delete capability in this app (health isn't
// user-togglable, and deleting a connected source is an infra-level action
// out of scope here) — Print is the one safe, universal bulk action every
// other list already has, so it's what Sources gets too.
export default function SourcesPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { search, debouncedSearch, handleSearch } = useUrlSearch();
  // URL-backed (not useState) so it survives navigating into a source's
  // detail page and clicking Back — same pattern as every other list's
  // filter state in this app.
  const [healthFilter, setHealthFilter] = useUrlState("health", "ALL");
  const [kindFilter, setKindFilter] = useUrlState("kind", "ALL");
  const [selected, setSelected] = useState(() => new Set());
  const [descriptionResults, setDescriptionResults] = useState(null);
  const [addSourceOpen, setAddSourceOpen] = useState(false);
  // No separate enrichment step needed — unlike Roles/Access Profiles'
  // enrichRolesForReport/enrichProfilesForReport, the list-fetched source
  // objects already carry everything buildSourcePdf renders (same reason
  // printSelectedDetail below uses `list` items directly, unenriched).
  const emailReport = useEmailReportAction({
    objectLabel: "Source",
    buildDetailPdfBase64: async ({ tenant, items }) => buildSourcesDetailPdfBase64({ tenant, sources: items }),
    itemLabel: (s) => s.name,
    onDone: () => setSelected(new Set()),
  });

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["sources", debouncedSearch],
    queryFn: () => fetchAllPages((page) => listSources({ ...page, query: debouncedSearch || undefined })),
    keepPreviousData: true,
  });

  const list = (Array.isArray(data) ? data : [])
    .filter((s) => (healthFilter === "HEALTHY" ? s.healthy : healthFilter === "UNHEALTHY" ? !s.healthy : true))
    .filter((s) => (kindFilter === "VA" ? isVaSource(s) : kindFilter === "SAAS" ? isSaasSource(s) : true));
  const { page, pager } = usePagedList(list, { noun: "source", resetKey: `${debouncedSearch}|${healthFilter}|${kindFilter}` });
  const sourceById = new Map(list.map((s) => [s.id, s]));
  const allSelected = list.length > 0 && list.every((s) => selected.has(s.id));

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

  const printList = useMutation({
    mutationFn: async () => {
      const tenant = getCredentials()?.tenant;
      return printSourcesListPdf({ tenant, sources: list, searchQuery: debouncedSearch || undefined });
    },
    onSuccess: (opened) => {
      if (!opened) toast("Pop-up blocked — downloaded the PDF instead");
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const printSelectedDetail = useMutation({
    mutationFn: async () => {
      const tenant = getCredentials()?.tenant;
      const chosen = list.filter((s) => selected.has(s.id));
      return printSourcesDetailPdf({ tenant, sources: chosen });
    },
    onSuccess: (opened) => {
      if (!opened) toast("Pop-up blocked — downloaded the PDF instead");
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const generateDescriptions = useMutation({
    mutationFn: (ids) => generateAllSourceDescriptions(ids),
    onSuccess: (result) => setDescriptionResults(result.results),
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const saveDescriptions = useMutation({
    mutationFn: (items) => Promise.all(items.map(({ roleId, description }) => updateSourceDescription(roleId, description))),
    onSuccess: (_result, items) => {
      toast.success(`${items.length} description${items.length === 1 ? "" : "s"} saved`);
      queryClient.invalidateQueries({ queryKey: ["sources"] });
      setDescriptionResults(null);
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <TopBar
        title={<BrowseTitleMenu active="Sources" />}
        loading={isLoading}
        action={
          <div className="flex items-center gap-2">
            <IconButton icon={Plus} title="Add Disconnected Source" onClick={() => setAddSourceOpen(true)} />
            {list.length > 0 && (
              <IconButton
                icon={Printer}
                title="Print sources"
                onClick={() => printList.mutate()}
                loading={printList.isPending}
              />
            )}
          </div>
        }
      />
      <div className="flex-1 overflow-y-auto pb-24">
        <SearchBar value={search} onChange={handleSearch} placeholder="Search sources…" />
        {/* Health and connector type side by side, one pill each; they wrap
            onto a second line only when the screen is too narrow for both. */}
        <div className="flex items-center flex-wrap gap-2 px-4 py-3 border-b border-gray-100">
          <SegmentedPill
            label="Health"
            options={[
              { value: "ALL", label: "All" },
              { value: "HEALTHY", label: "Healthy" },
              { value: "UNHEALTHY", label: "Unhealthy" },
            ]}
            active={healthFilter}
            onChange={setHealthFilter}
          />
          <SegmentedPill
            label="Connector type"
            options={[
              { value: "ALL", label: "All" },
              { value: "VA", label: "VA Based" },
              { value: "SAAS", label: "SaaS Based" },
            ]}
            active={kindFilter}
            onChange={setKindFilter}
          />
        </div>

        {error && <ErrorBox message={error.message} onRetry={refetch} />}
        {isLoading && <SkeletonList rows={8} />}
        {!isLoading && !error && list.length === 0 && (
          <EmptyState
            icon={Database}
            title={debouncedSearch ? "No results" : "No sources found"}
            subtitle={debouncedSearch ? `No sources match "${debouncedSearch}"` : "Your tenant has no connected sources"}
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
                {list.length} source{list.length !== 1 && "s"}{debouncedSearch && " matching"}
              </p>
            </div>

            {selected.size > 0 && (
              <SelectionActionBar
                count={selected.size}
                actions={[
                  {
                    icon: Wand2,
                    title: `Generate Descriptions (${selected.size})`,
                    onClick: () => generateDescriptions.mutate([...selected]),
                    loading: generateDescriptions.isPending,
                  },
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
                <button
                  onClick={() => navigate(`/sources/${s.id}`)}
                  className="flex-1 min-w-0 flex items-center gap-3 text-left active:bg-gray-100"
                >
                  <div className="w-10 h-10 rounded-full bg-blue-50 flex items-center justify-center flex-shrink-0">
                    <Database size={16} className="text-blue-600" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{s.name}</p>
                    <p className="text-xs text-gray-500 mt-0.5 truncate">
                      {s.connectorName || s.type || s.description || "—"}
                    </p>
                  </div>
                  <span
                    className={`text-xs font-medium px-2 py-0.5 rounded-full border flex-shrink-0 ${
                      s.healthy
                        ? "bg-green-50 text-green-700 border-green-200"
                        : "bg-red-50 text-red-700 border-red-200"
                    }`}
                  >
                    {s.healthy ? "Healthy" : "Unhealthy"}
                  </span>
                  <ChevronRight size={16} className="text-gray-300 flex-shrink-0" />
                </button>
              </div>
            ))}
            {pager}
          </>
        )}
      </div>

      {descriptionResults && (
        <BulkDescriptionReviewSheet
          items={descriptionResults}
          roleById={sourceById}
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
              Generating descriptions for {(generateDescriptions.variables || []).length} source
              {(generateDescriptions.variables || []).length === 1 ? "" : "s"}…
            </p>
          </div>
        </div>
      )}

      {addSourceOpen && (
        <AddDisconnectedSourceModal
          onClose={() => setAddSourceOpen(false)}
          onDone={(newSourceId) => {
            setAddSourceOpen(false);
            queryClient.invalidateQueries({ queryKey: ["sources"] });
            navigate(`/sources/${newSourceId}`);
          }}
        />
      )}

      {emailReport.confirmOpen && (
        <ConfirmModal
          title={`Email report for ${selected.size} source${selected.size === 1 ? "" : "s"}?`}
          message={
            `Builds one Source Report PDF per owner (sources sharing an owner are combined into one report) and ` +
            `publishes each to a link — the link is used instead of an attachment since email links can't carry ` +
            `files. Nothing is sent automatically: you'll get a list to review, and each email only opens your ` +
            `mail app when you click its own send icon, one at a time. A source with no owner, or an owner with ` +
            `no email address on file, is skipped.`
          }
          confirmLabel="Build Reports"
          pending={emailReport.mutation.isPending}
          onConfirm={() => emailReport.mutation.mutate(list.filter((s) => selected.has(s.id)))}
          onCancel={() => emailReport.setConfirmOpen(false)}
        />
      )}

      {emailReport.dialog && (
        <EmailReportDialog
          objectLabel="Source"
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
    </div>
  );
}
