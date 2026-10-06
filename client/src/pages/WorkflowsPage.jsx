import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { GitBranch, Sparkles, Play, Pause, Trash2 } from "lucide-react";
import { listWorkflows, setWorkflowEnabled, deleteWorkflow } from "../lib/sailpoint";
import { useUrlSearch } from "../hooks/useUrlSearch";
import { useUrlState } from "../hooks/useUrlState";
import { TopBar } from "../components/TopBar";
import { BrowseTitleMenu } from "../components/BrowseTitleMenu";
import { SearchBar, FilterBar, SegmentedPill, SkeletonList, EmptyState, ErrorBox, IconButton, SelectionActionBar, ConfirmModal } from "../components/ui";
import { ResultDialog } from "../components/ResultDialog";
import { LIST_SORT_OPTIONS, sortList, updatedSuffix } from "../lib/listSort";
import { CreateWorkflowWithAiModal } from "../components/CreateWorkflowWithAiModal";
import { usePagedList } from "../hooks/usePagedList";

// Human-readable one-liner for a workflow's trigger — the raw trigger object
// is shown in full on the detail page; the list just needs enough to scan by.
export function describeWorkflowTrigger(trigger) {
  if (!trigger) return "No trigger";
  const eventId = trigger.attributes?.id;
  if (trigger.type === "SCHEDULED") {
    const cron = trigger.attributes?.cronString;
    return `Scheduled${cron ? ` (${cron}${trigger.attributes?.timeZone ? " " + trigger.attributes.timeZone : ""})` : ""}`;
  }
  if (trigger.type === "EXTERNAL") return "External HTTP";
  return eventId ? `Event: ${eventId}` : trigger.type || "Unknown";
}

export default function WorkflowsPage() {
  const navigate = useNavigate();
  const { search, debouncedSearch, handleSearch } = useUrlSearch();
  const [statusFilter, setStatusFilter] = useUrlState("status", "ALL");
  // URL-backed like the filter, so it survives opening a workflow and coming back.
  const [sortBy, setSortBy] = useUrlState("sort", "name");
  const [aiCreateOpen, setAiCreateOpen] = useState(false);
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState(() => new Set());
  const [confirm, setConfirm] = useState(null); // "disable" | "delete"
  const [progress, setProgress] = useState(null);
  const [bulkResult, setBulkResult] = useState(null);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["workflows"],
    queryFn: listWorkflows,
  });

  const list = sortList((Array.isArray(data) ? data : [])
    .filter((w) => (statusFilter === "ENABLED" ? w.enabled : statusFilter === "DISABLED" ? !w.enabled : true))
    .filter((w) => {
      if (!debouncedSearch) return true;
      const q = debouncedSearch.toLowerCase();
      return (w.name || "").toLowerCase().includes(q) || (w.description || "").toLowerCase().includes(q);
    }), sortBy);

  // Selection is over what's listed — a filter change can hide a selected
  // row, and an action should never reach something the user can't see.
  const chosen = list.filter((w) => selected.has(w.id));
  const allSelected = list.length > 0 && list.every((w) => selected.has(w.id));
  const { page, pager } = usePagedList(list, { noun: "workflow", resetKey: `${debouncedSearch}|${statusFilter}|${sortBy}` });
  const toggleOne = (id) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(list.map((w) => w.id)));

  // One workflow at a time (ISC rate-limits bursts), and a failure doesn't
  // stop the rest — the result dialog says which ones and why.
  const bulk = useMutation({
    mutationFn: async (action) => {
      const targets =
        action === "enable" ? chosen.filter((w) => !w.enabled) : action === "disable" ? chosen.filter((w) => w.enabled) : chosen;
      const failed = [];
      let done = 0;
      for (const w of targets) {
        try {
          if (action === "delete") await deleteWorkflow(w.id);
          else await setWorkflowEnabled(w.id, action === "enable");
        } catch (err) {
          failed.push(`${w.name}: ${err.response?.data?.error || err.message}`);
        }
        setProgress(`${++done} of ${targets.length}…`);
      }
      return { action, total: targets.length, skipped: chosen.length - targets.length, failed };
    },
    onSettled: () => {
      setProgress(null);
      setConfirm(null);
      queryClient.invalidateQueries({ queryKey: ["workflows"] });
      queryClient.invalidateQueries({ queryKey: ["workflow"] });
    },
    onSuccess: (r) => {
      const verb = { enable: "enabled", disable: "disabled", delete: "deleted" }[r.action];
      const ok = r.total - r.failed.length;
      if (r.failed.length === 0) {
        toast.success(`${ok} workflow${ok === 1 ? "" : "s"} ${verb}${r.skipped ? ` · ${r.skipped} already ${r.action === "enable" ? "enabled" : "disabled"}` : ""}`);
      } else {
        setBulkResult({ title: `${ok} of ${r.total} ${verb}`, message: `These could not be ${verb}:\n${r.failed.map((f) => `• ${f}`).join("\n")}` });
      }
      setSelected(new Set());
    },
    onError: (err) => toast.error(err.message),
  });
  const enabledChosen = chosen.filter((w) => w.enabled).length;

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <TopBar
        title={<BrowseTitleMenu active="Workflows" />}
        action={<IconButton icon={Sparkles} title="Create a workflow with AI" onClick={() => setAiCreateOpen(true)} className="!border-violet-300 !text-violet-700 hover:!bg-violet-50" />}
      />
      {aiCreateOpen && (
        <CreateWorkflowWithAiModal
          onClose={() => setAiCreateOpen(false)}
          // Straight to the new workflow's flowchart — the natural place to review it.
          onCreated={(wf) => { setAiCreateOpen(false); navigate(`/workflows/${wf.id}?tab=flowchart`); }}
        />
      )}
      <div className="flex-1 overflow-y-auto pb-24">
        <SearchBar value={search} onChange={handleSearch} placeholder="Search workflows…" />
        <FilterBar
          options={[
            { value: "ALL", label: "All" },
            { value: "ENABLED", label: "Enabled" },
            { value: "DISABLED", label: "Disabled" },
          ]}
          active={statusFilter}
          onChange={setStatusFilter}
          right={
            <SegmentedPill
              label="Sort by"
              options={LIST_SORT_OPTIONS}
              active={sortBy}
              onChange={setSortBy}
            />
          }
        />

        {error && <ErrorBox message={error.message} onRetry={refetch} />}
        {isLoading && <SkeletonList rows={8} />}
        {!isLoading && !error && list.length === 0 && (
          <EmptyState
            icon={GitBranch}
            title={debouncedSearch ? "No results" : "No workflows"}
            subtitle={debouncedSearch ? `No workflows match "${debouncedSearch}"` : "This tenant has no workflows yet"}
          />
        )}

        {!isLoading && list.length > 0 && (
          <>
            <div className="flex items-center justify-between px-4 py-2 gap-3">
              <label className="flex items-center gap-2 text-xs text-gray-500">
                <input type="checkbox" checked={allSelected} onChange={toggleAll} className="w-4 h-4 rounded border-gray-300" />
                Select all
              </label>
              <p className="text-xs text-gray-400">{list.length} workflow{list.length !== 1 && "s"}{debouncedSearch && " matching"}</p>
            </div>
            {chosen.length > 0 && (
              <SelectionActionBar
                count={chosen.length}
                progressText={progress}
                actions={[
                  // Enabling is validated by ISC and harmless to an already-enabled
                  // one, so it runs straight away; the other two confirm.
                  { icon: Play, title: `Enable (${chosen.length - enabledChosen})`, onClick: () => bulk.mutate("enable"), loading: bulk.isPending && bulk.variables === "enable", disabled: bulk.isPending || chosen.length === enabledChosen },
                  { icon: Pause, title: `Disable (${enabledChosen})`, onClick: () => setConfirm("disable"), loading: bulk.isPending && bulk.variables === "disable", disabled: bulk.isPending || enabledChosen === 0 },
                  { icon: Trash2, title: `Delete (${chosen.length})`, onClick: () => setConfirm("delete"), loading: bulk.isPending && bulk.variables === "delete", disabled: bulk.isPending, danger: true },
                ]}
              />
            )}
          </>
        )}

        {!isLoading && pager}
        {!isLoading && page.map((w) => (
          <div key={w.id} className="w-full flex items-center gap-3 px-4 py-3.5 border-b border-gray-100 hover:bg-gray-50 transition-colors">
          <input type="checkbox" checked={selected.has(w.id)} onChange={() => toggleOne(w.id)} aria-label={`Select ${w.name}`} className="w-4 h-4 rounded border-gray-300 flex-shrink-0" />
          <button
            onClick={() => navigate(`/workflows/${w.id}`)}
            className="flex-1 min-w-0 flex items-center gap-3 text-left active:bg-gray-100"
          >
            <div className="w-10 h-10 rounded-full bg-cyan-50 flex items-center justify-center flex-shrink-0">
              <GitBranch size={16} className="text-cyan-700" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-gray-900 truncate">{w.name}</p>
              <p className="text-xs text-gray-500 truncate mt-0.5">
                {describeWorkflowTrigger(w.trigger)}
                {/* The date only earns its space when it's what the list is ordered by. */}
                {updatedSuffix(w, sortBy)}
              </p>
            </div>
            <span
              className={`text-xs font-medium px-2 py-0.5 rounded-full border flex-shrink-0 ${
                w.enabled
                  ? "bg-green-50 text-green-700 border-green-200"
                  : "bg-gray-50 text-gray-500 border-gray-200"
              }`}
            >
              {w.enabled ? "Enabled" : "Disabled"}
            </span>
          </button>
          </div>
        ))}
        {!isLoading && pager}
      </div>

      {confirm === "disable" && (
        <ConfirmModal
          title={`Disable ${enabledChosen} workflow${enabledChosen === 1 ? "" : "s"}?`}
          message="They stop running: their triggers no longer start them, and events that occur while they're disabled are not replayed when they're enabled again. Runs already in progress are not cancelled."
          confirmLabel="Disable"
          pending={bulk.isPending}
          progressText={progress}
          onConfirm={() => bulk.mutate("disable")}
          onCancel={() => !bulk.isPending && setConfirm(null)}
        />
      )}
      {confirm === "delete" && (
        <ConfirmModal
          title={`Delete ${chosen.length} workflow${chosen.length === 1 ? "" : "s"}?`}
          confirmLabel="Delete"
          danger
          pending={bulk.isPending}
          progressText={progress}
          onConfirm={() => bulk.mutate("delete")}
          onCancel={() => !bulk.isPending && setConfirm(null)}
        >
          <p className="text-sm text-gray-600 mb-2">This permanently deletes {chosen.length === 1 ? "this workflow" : "these workflows"} from ISC, including {chosen.length === 1 ? "its" : "their"} run history. It cannot be undone.{enabledChosen > 0 ? ` ${enabledChosen} ${enabledChosen === 1 ? "is" : "are"} enabled and will be disabled first — ISC won't delete a running workflow.` : ""}</p>
          <ul className="text-xs text-gray-600 mb-4 max-h-32 overflow-y-auto list-disc pl-4 space-y-0.5">
            {chosen.map((w) => <li key={w.id}>{w.name}{w.enabled ? " (enabled)" : ""}</li>)}
          </ul>
        </ConfirmModal>
      )}
      {bulkResult && <ResultDialog title={bulkResult.title} success={false} message={bulkResult.message} onClose={() => setBulkResult(null)} />}
    </div>
  );
}
