import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock, Shapes, CheckCircle2, AlertTriangle, PlusCircle, Printer, Shield, GitMerge, Tags, Settings } from "lucide-react";
import toast from "react-hot-toast";
import {
  startSegmentScan, listSegmentScans, getSegmentScan, cancelSegmentScan, deleteSegmentScan,
  createSegmentsFromScan, addScanSuggestionsToExistingSegments, getSchemaAnalysis, getCredentials,
  getSegmentCreateProgress,
} from "../../lib/sailpoint";
import { creatableSegmentSuggestions, mergeableSegmentSuggestions } from "../../lib/segmentScanApply";
import { printSegmentScanPdf } from "../../lib/exportSegmentScanPdf";
import { TopBar } from "../../components/TopBar";
import { RoleMiningTitleMenu } from "../../components/RoleMiningTitleMenu";
import { OutlineButton, EmptyState, Spinner, ErrorBox, IconButton, ConfirmModal, SelectionActionBar } from "../../components/ui";
import { STATUS_META, ScanListItem, ScanMasterDetail, ScanListRow } from "./shared";

// The same entitlement name can legitimately exist on two different
// sources, so entitlement pills are grouped by source rather than shown
// flat — same convention (and same shape: e.source is a bare name string,
// or missing) as Role Scan's own groupEntitlementsBySource.
function groupEntitlementsBySource(entitlements) {
  const map = new Map();
  for (const e of entitlements || []) {
    const key = e.source || "Entitlements";
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(e);
  }
  return [...map.entries()]
    .map(([source, ents]) => [source, [...ents].sort((a, b) => (a.name || "").localeCompare(b.name || ""))])
    .sort((a, b) => a[0].localeCompare(b[0]));
}

// showCheckbox=false is the two-pane detail view: bulk selection lives in
// the left rail there, so the row is a plain container rather than a label
// wrapping a checkbox it no longer owns.
function SuggestionRow({ s, boundaryKeys, selected, selectable, onToggle, onAddToExisting, addToExistingPending, navigate, showCheckbox = true }) {
  const disabled = !selectable;
  const Wrapper = showCheckbox ? "label" : "div";
  return (
    <Wrapper
      className={`flex items-start gap-3 px-4 py-3.5 transition-colors ${
        disabled || !showCheckbox ? "" : "hover:bg-gray-50 cursor-pointer"
      }`}
    >
      {showCheckbox && (
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onToggle(s.id)}
          disabled={disabled}
          className="w-4 h-4 rounded border-gray-300 flex-shrink-0 mt-0.5"
        />
      )}
      <div className="w-9 h-9 rounded-full bg-violet-50 flex items-center justify-center flex-shrink-0">
        <Shapes size={15} className="text-violet-600" />
      </div>
      <div className="flex-1 min-w-0">
        {s.segmentCreated?.segmentId ? (
          <button
            type="button"
            onClick={(e) => { e.preventDefault(); navigate(`/segments/${s.segmentCreated.segmentId}`); }}
            className="text-sm font-medium text-blue-600 hover:underline text-left"
          >
            {s.name}
          </button>
        ) : (
          <p className="text-sm font-medium text-gray-900">{s.name}</p>
        )}
        <p className="text-xs text-gray-500 mt-0.5 mb-2">
          {s.memberCount} member{s.memberCount === 1 ? "" : "s"}
          {s.suggestedRoles != null && ` · ${s.suggestedRoles.length} matching role${s.suggestedRoles.length === 1 ? "" : "s"}`}
          {s.suggestedEntitlements != null && ` · ${s.suggestedEntitlements.length} entitlement${s.suggestedEntitlements.length === 1 ? "" : "s"}`}
        </p>

        {boundaryKeys?.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-2">
            {boundaryKeys.map((key, i) => (
              <span
                key={key}
                className="text-xs px-2 py-1 rounded-full border bg-amber-50 text-amber-700 border-amber-200"
              >
                {key.replace(/([a-z])([A-Z])/g, "$1 $2")}: {s.values?.[i]}
              </span>
            ))}
          </div>
        )}

        {s.suggestedRoles?.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-2">
            {s.suggestedRoles.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  navigate(`/roles/${r.id}`);
                }}
                className="text-xs bg-blue-50 text-blue-700 border border-blue-100 px-2 py-1 rounded-full hover:bg-blue-100 transition-colors flex items-center gap-1"
              >
                <Shield size={11} />
                {r.name}
              </button>
            ))}
          </div>
        )}

        {s.suggestedEntitlements?.length > 0 && (
          <div className="mb-2 space-y-1.5">
            {groupEntitlementsBySource(s.suggestedEntitlements).map(([source, ents]) => (
              <div key={source}>
                <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-1">{source}</p>
                <div className="flex flex-wrap gap-1.5">
                  {ents.map((e) => (
                    <button
                      key={e.id}
                      type="button"
                      onClick={(ev) => { ev.preventDefault(); navigate(`/entitlements/${e.id}`); }}
                      className="text-xs bg-violet-50 text-violet-700 border border-violet-100 px-2 py-1 rounded-full hover:bg-violet-100 transition-colors"
                    >
                      {e.name}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {s.segmentCreated && (
          <div className="mt-2 bg-emerald-50 border border-emerald-100 rounded-lg px-2.5 py-1.5 flex items-start gap-1.5">
            <CheckCircle2 size={13} className="text-emerald-600 flex-shrink-0 mt-0.5" />
            <p className="text-xs text-emerald-700">
              Created as{" "}
              <button
                type="button"
                onClick={(e) => { e.preventDefault(); navigate(`/segments/${s.segmentCreated.segmentId}`); }}
                className="underline font-medium"
              >
                "{s.segmentCreated.segmentName}"
              </button>{" "}
              {new Date(s.segmentCreated.createdAt).toLocaleDateString()}
            </p>
          </div>
        )}
        {!s.segmentCreated && s.existingSegmentName && (
          <div className="mt-2 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5">
            <div className="flex items-start gap-1.5">
              <AlertTriangle size={13} className="text-amber-600 flex-shrink-0 mt-0.5" />
              <p className="text-xs text-amber-800">
                A data segment named "{s.existingSegmentName}" already exists — not selectable.
              </p>
            </div>
            {s.addedToExisting ? (
              <p className="text-xs text-emerald-700 mt-1.5 flex items-center gap-1">
                <CheckCircle2 size={12} className="flex-shrink-0" />
                Added {new Date(s.addedToExisting.addedAt).toLocaleDateString()}
              </p>
            ) : (
              ((s.suggestedRoles?.length || 0) > 0 || (s.suggestedEntitlements?.length || 0) > 0) && (
                <button
                  type="button"
                  onClick={() => onAddToExisting(s.id)}
                  disabled={addToExistingPending}
                  className="text-xs font-medium text-amber-800 underline mt-1.5 disabled:opacity-50"
                >
                  Add suggested roles &amp; entitlements to this existing data segment
                </button>
              )
            )}
          </div>
        )}
      </div>
    </Wrapper>
  );
}

export function SegmentScanDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState(() => new Set());
  const [createAllConfirmOpen, setCreateAllConfirmOpen] = useState(false);
  // Which suggestion the md-and-up right-hand pane is showing. Only that
  // layout reads it — below md every suggestion renders its own row.
  const [openSuggestionId, setOpenSuggestionId] = useState(null);
  const [mergeAllConfirmOpen, setMergeAllConfirmOpen] = useState(false);

  const { data: scan, isLoading } = useQuery({
    queryKey: ["segmentScan", id],
    queryFn: () => getSegmentScan(id),
    refetchInterval: (query) => (query.state.data?.status === "running" ? 3000 : false),
  });

  // The scan record itself carries which flavor it is, so one detail page
  // serves both nav entries — only the back destination and the create
  // wording differ.
  const metadataMode = scan?.mode === "metadata";
  const backPath = metadataMode ? "/role-mining/segments-by-metadata" : "/role-mining/segments";

  const createMutation = useMutation({
    mutationFn: (suggestionIds) => createSegmentsFromScan(id, suggestionIds),
    onSuccess: (data) => {
      const failed = data.results.filter((r) => !r.ok);
      const ok = data.results.filter((r) => r.ok);
      if (failed.length) {
        toast.error(`Created ${ok.length} of ${data.results.length} data segments — ${failed.length} failed`);
      } else {
        toast.success(`Created ${ok.length} data segment${ok.length === 1 ? "" : "s"}`);
      }
      // ISC caps a segment's Access Model selection at 50 entitlements/roles
      // — a coarse boundary easily suggests more than that, so some created
      // segments may have fewer than proposed. Worth surfacing rather than
      // letting it look like the full suggested set was applied.
      const trimmed = ok.filter((r) => r.dropped && (r.dropped.entitlements || r.dropped.roles));
      if (trimmed.length) {
        const totalEnts = trimmed.reduce((sum, r) => sum + (r.dropped.entitlements || 0), 0);
        const totalRoles = trimmed.reduce((sum, r) => sum + (r.dropped.roles || 0), 0);
        const parts = [];
        if (totalEnts) parts.push(`${totalEnts} entitlement${totalEnts === 1 ? "" : "s"}`);
        if (totalRoles) parts.push(`${totalRoles} role${totalRoles === 1 ? "" : "s"}`);
        toast(
          `${trimmed.length} segment${trimmed.length === 1 ? "" : "s"} hit ISC's 50-item Access Model limit — ${parts.join(" and ")} left off. Add the rest manually from each segment's own Access Model.`,
          { duration: 8000 }
        );
      }
      // Metadata-mode creates report what got tagged instead — no cap there.
      const taggedResults = ok.filter((r) => r.tagged);
      if (taggedResults.length) {
        const totalEnts = taggedResults.reduce((sum, r) => sum + (r.tagged.entitlements || 0), 0);
        const totalRoles = taggedResults.reduce((sum, r) => sum + (r.tagged.roles || 0), 0);
        toast(
          `Tagged ${totalEnts} entitlement${totalEnts === 1 ? "" : "s"} and ${totalRoles} role${totalRoles === 1 ? "" : "s"} with their Boundary metadata value — each segment's Access Model now follows that tag.`,
          { duration: 8000 }
        );
      }
      // Each segment's build criteria are also applied to IDENTITIES on its
      // Access Model. If ISC refused that scope the segment was still
      // created (entitlements / roles scoped as usual) — say which, and why.
      const noIdentityScope = ok.filter((r) => r.identityScope && !r.identityScope.applied);
      if (noIdentityScope.length) {
        toast(
          `${noIdentityScope.length} segment${noIdentityScope.length === 1 ? " was" : "s were"} created WITHOUT the identity scope — ISC refused it (${noIdentityScope[0].identityScope.reason}). Members of ${noIdentityScope.length === 1 ? "that segment" : "those segments"} will see all identities until it's added in ISC's segment editor.`,
          { duration: 12000 }
        );
      }
      setSelected(new Set());
      setCreateAllConfirmOpen(false);
      queryClient.invalidateQueries({ queryKey: ["segmentScan", id] });
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  // Creating tags every suggested entitlement one at a time and ISC rate-
  // limits that hard, so a run can take minutes with nothing to show for it.
  // The server records how far it has got; this counts it off, polling only
  // while a run is actually in flight.
  const { data: createProgress } = useQuery({
    queryKey: ["segment-create-progress", id],
    queryFn: () => getSegmentCreateProgress(id),
    enabled: createMutation.isPending,
    refetchInterval: createMutation.isPending ? 1000 : false,
  });
  const progressLabel = createMutation.isPending && createProgress?.total
    ? ` (${createProgress.done} of ${createProgress.total} created)`
    : "";

  const addToExistingMutation = useMutation({
    mutationFn: (suggestionId) => addScanSuggestionsToExistingSegments(id, [suggestionId]),
    onSuccess: (data) => {
      const result = data.results[0];
      if (result?.ok) {
        toast.success(`Added to "${result.segmentName}"`);
      } else {
        toast.error(result?.error || "Failed to add to the existing data segment");
      }
      queryClient.invalidateQueries({ queryKey: ["segmentScan", id] });
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  // Create every unmatched suggestion AND merge every already-matched one
  // into its existing segment, in one pass — the two id lists are passed in
  // at call time (not read off closed-over selectablePaths/mergeablePaths)
  // so this stays correct regardless of when the mutation actually fires.
  const mergeAllMutation = useMutation({
    mutationFn: async ({ createIds, mergeIds }) => {
      const [createResult, mergeResult] = await Promise.all([
        createIds.length > 0 ? createSegmentsFromScan(id, createIds) : Promise.resolve({ results: [] }),
        mergeIds.length > 0 ? addScanSuggestionsToExistingSegments(id, mergeIds) : Promise.resolve({ results: [] }),
      ]);
      return { createResult, mergeResult };
    },
    onSuccess: ({ createResult, mergeResult }) => {
      const createdOk = createResult.results.filter((r) => r.ok).length;
      const mergedOk = mergeResult.results.filter((r) => r.ok).length;
      const failed =
        (createResult.results.length - createdOk) + (mergeResult.results.length - mergedOk);
      const parts = [];
      if (createResult.results.length) parts.push(`${createdOk} created`);
      if (mergeResult.results.length) parts.push(`${mergedOk} merged`);
      const message = parts.length > 0 ? parts.join(", ") : "Nothing to do";
      if (failed > 0) toast.error(`${message} — ${failed} failed`);
      else toast.success(message);
      setSelected(new Set());
      setMergeAllConfirmOpen(false);
      queryClient.invalidateQueries({ queryKey: ["segmentScan", id] });
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  if (isLoading || !scan) {
    return (
      <div className="flex flex-col min-h-screen bg-white">
        <TopBar title="Data Segments Draft" onBack={() => navigate(backPath)} />
        <div className="flex-1 flex items-center justify-center"><Spinner size={24} /></div>
      </div>
    );
  }

  const meta = STATUS_META[scan.status] || STATUS_META.running;
  const StatusIcon = meta.icon;
  const suggestions = scan.suggestions || [];
  // Shared with Auto Convert (lib/segmentScanApply) so both apply a scan alike.
  const selectablePaths = creatableSegmentSuggestions(suggestions);
  const mergeablePaths = mergeableSegmentSuggestions(suggestions);
  // A row can be selected for either bulk action — Create (unmatched) or
  // Merge (matched, not yet merged) — so the checkbox and Select All cover
  // both sets, and the selection bar picks out which of the two bulk
  // actions actually apply to what's currently checked.
  const eligiblePaths = [...selectablePaths, ...mergeablePaths];
  const eligibleIds = new Set(eligiblePaths.map((s) => s.id));
  const allSelected = eligiblePaths.length > 0 && eligiblePaths.every((s) => selected.has(s.id));
  const selectedCreateIds = selectablePaths.filter((s) => selected.has(s.id)).map((s) => s.id);
  const selectedMergeIds = mergeablePaths.filter((s) => selected.has(s.id)).map((s) => s.id);

  function toggleOne(sid) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(sid)) next.delete(sid);
      else next.add(sid);
      return next;
    });
  }
  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(eligiblePaths.map((s) => s.id)));
  }

  // Falls back to the first suggestion so the wide layout's detail pane is
  // never blank, and so a selection that disappears degrades to the top of
  // the list.
  const openSuggestion =
    suggestions.find((s) => s.id === openSuggestionId) || suggestions[0];

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <TopBar
        title="Data Segments Draft"
        onBack={() => navigate(backPath)}
        action={
          <div className="flex items-center gap-3">
            <IconButton
              icon={Settings}
              title="Mining Config"
              onClick={() => navigate("/studio-settings/scanning-config")}
            />
            {suggestions.length > 0 && (
            <>
              {selectablePaths.length > 0 && (
                <IconButton
                  icon={PlusCircle}
                  title={`Create All Data Segments (${selectablePaths.length})`}
                  onClick={() => setCreateAllConfirmOpen(true)}
                />
              )}
              {(selectablePaths.length > 0 || mergeablePaths.length > 0) && (
                <IconButton
                  icon={GitMerge}
                  title={`Merge All — Create ${selectablePaths.length} New, Update ${mergeablePaths.length} Existing`}
                  onClick={() => setMergeAllConfirmOpen(true)}
                />
              )}
              <button
                onClick={() => {
                  const tenant = getCredentials()?.tenant;
                  if (!printSegmentScanPdf({ tenant, scan })) {
                    toast("Pop-up blocked — downloaded the PDF instead");
                  }
                }}
                className="flex items-center gap-1 text-blue-600 text-sm font-medium"
                title="Print"
              >
                <Printer size={16} />
              </button>
            </>
            )}
          </div>
        }
      />
      <div className="flex-1 overflow-y-auto pb-6">
        <div className="px-4 py-4 border-b border-gray-100">
          <div className="flex items-center gap-2 mb-1">
            <StatusIcon size={16} className={meta.className} />
            <span className="text-sm font-medium text-gray-900">{meta.label}</span>
          </div>
          <p className="text-xs text-gray-500">
            {scan.tenant ? `${scan.tenant} — ` : ""}Started {new Date(scan.startedAt).toLocaleString()}
          </p>
          {scan.error && <p className="text-xs text-red-600 mt-1">{scan.error}</p>}
          <p className="text-xs text-gray-400 mt-2">
            Boundary: {scan.boundaryKeys?.length ? scan.boundaryKeys.join(" + ") : "No Boundary set"}
          </p>
          <p className="text-xs text-gray-400 mt-1">{scan.totalCombinations ?? 0} combinations found</p>
        </div>

        {suggestions.length === 0 && scan.status === "completed" ? (
          <EmptyState
            icon={Shapes}
            title="No new data segments proposed"
            subtitle="Every boundary attribute combination already has a data segment"
          />
        ) : (
          <>
            {eligiblePaths.length > 0 && (
              <>
                <div className="flex items-center justify-between px-4 py-2 border-b border-gray-100">
                  <label className="flex items-center gap-2 text-xs text-gray-500">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleAll}
                      className="w-4 h-4 rounded border-gray-300"
                    />
                    Select all
                  </label>
                  <p className="text-xs text-gray-400">{suggestions.length} proposed</p>
                </div>

                {createMutation.isPending && progressLabel && (
                  <p className="px-4 pb-1.5 text-xs text-gray-500">Creating data segments…{progressLabel}</p>
                )}
                {selected.size > 0 && (
                  <SelectionActionBar
                    count={selected.size}
                    actions={[
                      ...(selectedCreateIds.length > 0
                        ? [{
                            icon: PlusCircle,
                            title: `Create Selected (${selectedCreateIds.length})`,
                            onClick: () => createMutation.mutate(selectedCreateIds),
                            loading: createMutation.isPending,
                          }]
                        : []),
                      ...(selectedMergeIds.length > 0
                        ? [{
                            icon: GitMerge,
                            title: `Merge Selected (${selectedMergeIds.length})`,
                            onClick: () => mergeAllMutation.mutate({ createIds: [], mergeIds: selectedMergeIds }),
                            loading: mergeAllMutation.isPending,
                          }]
                        : []),
                    ]}
                  />
                )}
              </>
            )}
            <ScanMasterDetail
              listTitle={`Proposed Data Segments (${suggestions.length})`}
              single={suggestions.map((s) => (
                <div key={s.id} className="border-b border-gray-100">
                  <SuggestionRow
                    s={s}
                    boundaryKeys={scan.boundaryKeys}
                    selected={selected.has(s.id)}
                    selectable={eligibleIds.has(s.id)}
                    onToggle={toggleOne}
                    onAddToExisting={(suggestionId) => addToExistingMutation.mutate(suggestionId)}
                    addToExistingPending={addToExistingMutation.isPending}
                    navigate={navigate}
                  />
                </div>
              ))}
              list={suggestions.map((s) => (
                <ScanListRow
                  key={s.id}
                  active={openSuggestion?.id === s.id}
                  onClick={() => setOpenSuggestionId(s.id)}
                  icon={
                    s.segmentCreated ? CheckCircle2 : s.existingSegmentName ? AlertTriangle : Shapes
                  }
                  iconClass={
                    s.segmentCreated
                      ? "text-emerald-600"
                      : s.existingSegmentName
                        ? "text-amber-500"
                        : "text-violet-600"
                  }
                  title={s.name}
                  subtitle={[
                    `${s.memberCount} member${s.memberCount === 1 ? "" : "s"}`,
                    s.suggestedRoles != null && `${s.suggestedRoles.length} role${s.suggestedRoles.length === 1 ? "" : "s"}`,
                    s.suggestedEntitlements != null && `${s.suggestedEntitlements.length} entitlement${s.suggestedEntitlements.length === 1 ? "" : "s"}`,
                  ].filter(Boolean).join(" · ")}
                  tag={s.segmentCreated ? "Created" : s.existingSegmentName ? "Exists" : null}
                  /* Bulk selection has to stay reachable from the rail —
                     the rows it applies to aren't all on screen at once in
                     this layout. Ineligible suggestions get a placeholder
                     so every row's text still lines up. */
                  leading={
                    eligibleIds.has(s.id) ? (
                      <input
                        type="checkbox"
                        checked={selected.has(s.id)}
                        onChange={() => toggleOne(s.id)}
                        className="w-4 h-4 rounded border-gray-300 flex-shrink-0 mt-1"
                      />
                    ) : (
                      <span className="w-4 flex-shrink-0" />
                    )
                  }
                />
              ))}
              detail={
                openSuggestion && (
                  <SuggestionRow
                    key={openSuggestion.id}
                    s={openSuggestion}
                    boundaryKeys={scan.boundaryKeys}
                    selected={selected.has(openSuggestion.id)}
                    selectable={eligibleIds.has(openSuggestion.id)}
                    onToggle={toggleOne}
                    onAddToExisting={(suggestionId) => addToExistingMutation.mutate(suggestionId)}
                    addToExistingPending={addToExistingMutation.isPending}
                    navigate={navigate}
                    showCheckbox={false}
                  />
                )
              }
            />
          </>
        )}
      </div>

      {createAllConfirmOpen && (
        <ConfirmModal
          title={`Create ${selectablePaths.length} data segment${selectablePaths.length === 1 ? "" : "s"}?`}
          message={
            metadataMode
              ? "Creates every proposed data segment as a disabled draft in ISC, tags each suggested role/entitlement with its Boundary metadata value, and sets the segment's Access Model to a filter on that metadata — so membership follows the tag from then on. The segment's build criteria are also applied to identities on the Access Model, so its members see the identities that match it."
              : "Creates every proposed data segment on this draft that doesn't already exist, as a disabled draft in ISC — along with any suggested roles/entitlements on its Access Model, and its build criteria applied to identities there too."
          }
          confirmLabel="Create All"
          pending={createMutation.isPending}
          progressText={progressLabel ? `Creating data segments…${progressLabel}` : undefined}
          onConfirm={() => createMutation.mutate(selectablePaths.map((s) => s.id))}
          onCancel={() => setCreateAllConfirmOpen(false)}
        >
          <p className="text-sm font-medium text-gray-900 mb-4">
            {metadataMode
              ? "You'll still need to enable and publish each segment for its criteria to actually apply."
              : "You'll still need to enable and publish it for its criteria to actually apply."}
          </p>
        </ConfirmModal>
      )}

      {mergeAllConfirmOpen && (
        <ConfirmModal
          title="Merge all?"
          message={`Creates ${selectablePaths.length} new data segment${selectablePaths.length === 1 ? "" : "s"} for combinations with no match, and updates ${mergeablePaths.length} existing data segment${mergeablePaths.length === 1 ? "" : "s"} with their suggested roles and entitlements.`}
          confirmLabel="Merge All"
          pending={mergeAllMutation.isPending}
          onConfirm={() =>
            mergeAllMutation.mutate({
              createIds: selectablePaths.map((s) => s.id),
              mergeIds: mergeablePaths.map((s) => s.id),
            })
          }
          onCancel={() => setMergeAllConfirmOpen(false)}
        />
      )}
    </div>
  );
}

// mode="metadata" is the "Data Segments" nav entry (formerly "Segments by Metadata"): the scan is the
// same boundary-combination discovery, but Create tags the suggested
// roles/entitlements with the multi-valued Boundary metadata attribute and
// gives each segment a FILTER Access Model on it, instead of an explicit
// (50-item-capped) selection list.
export default function SegmentsMiningPage({ mode = "selection" }) {
  const metadataMode = mode === "metadata";
  const basePath = metadataMode ? "/role-mining/segments-by-metadata" : "/role-mining/segments";
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [includeRoles, setIncludeRoles] = useState(true);
  const [includeEntitlements, setIncludeEntitlements] = useState(true);

  const segmentScan = useMutation({
    mutationFn: () => startSegmentScan({ includeRoles, includeEntitlements, mode }),
    onSuccess: ({ scanId }) => {
      toast.success("Data segment discovery started — check back here for results.");
      queryClient.invalidateQueries({ queryKey: ["segmentScans"] });
      navigate(`${basePath}/scans/${scanId}`);
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const { data: allScans = [], error } = useQuery({
    queryKey: ["segmentScans"],
    queryFn: listSegmentScans,
    refetchInterval: (query) => (query.state.data?.some((s) => s.status === "running") ? 4000 : 15000),
  });
  // Each nav entry lists only its own flavor of drafts — records predating
  // the mode field have no mode and belong to the original Data Segments.
  const pastScans = allScans.filter((s) => (metadataMode ? s.mode === "metadata" : s.mode !== "metadata"));

  const { data: schemaAnalysis } = useQuery({
    queryKey: ["schema-analysis"],
    queryFn: getSchemaAnalysis,
  });
  const boundaryReady = !!schemaAnalysis?.roleBoundaryEnabled && (schemaAnalysis.roleBoundaryAttributes || []).length > 0;

  const cancelMutation = useMutation({
    mutationFn: (scanId) => cancelSegmentScan(scanId),
    onSuccess: () => {
      toast.success("Cancelling…");
      queryClient.invalidateQueries({ queryKey: ["segmentScans"] });
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const removeMutation = useMutation({
    mutationFn: (scanId) => deleteSegmentScan(scanId),
    onSuccess: () => {
      toast.success("Draft removed");
      queryClient.invalidateQueries({ queryKey: ["segmentScans"] });
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <TopBar
        title={<RoleMiningTitleMenu active="Data Segments" />}
        action={
          <IconButton
            icon={Settings}
            title="Mining Config (Multi-Company/Division Boundary)"
            onClick={() => navigate("/studio-settings/scanning-config")}
          />
        }
      />
      <div className="flex-1 overflow-y-auto pb-24">
        <div className="px-4 py-5 border-b border-gray-100">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-full bg-violet-50 flex items-center justify-center flex-shrink-0">
              {metadataMode ? <Tags size={18} className="text-violet-600" /> : <Shapes size={18} className="text-violet-600" />}
            </div>
            <div>
              <h2 className="text-base font-semibold text-gray-900">
                {metadataMode ? "Data Segments" : "Data Segment Mining"}
              </h2>
              <p className="text-xs text-gray-500 mt-0.5">
                {metadataMode
                  ? "Scans active identities for Multi-Company/Division Boundary attribute combinations that don't yet have a Data Segment. Created segments tag their suggested roles/entitlements with the multi-valued Boundary metadata attribute and use a filter on it as their Access Model — membership then follows the tag, with no per-item selection limit."
                  : "Scans active identities for Multi-Company/Division Boundary attribute combinations that don't yet have a Data Segment, and proposes one data segment per combination as a draft to review before creating."}
              </p>
            </div>
          </div>

          {error && <ErrorBox message={error.message} />}

          {!boundaryReady && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-3 flex gap-2">
              <AlertTriangle size={14} className="text-amber-600 flex-shrink-0 mt-0.5" />
              <p className="text-xs text-amber-800">
                Enable the Multi-Company/Division Boundary with at least one attribute in Schema Analysis before
                scanning for data segments.
              </p>
            </div>
          )}

          {boundaryReady && (
            <div className="flex flex-col gap-1.5 mb-3">
              <label className="flex items-center gap-2 text-xs text-gray-600">
                <input
                  type="checkbox"
                  checked={includeRoles}
                  onChange={(e) => setIncludeRoles(e.target.checked)}
                  disabled={segmentScan.isPending}
                  className="w-4 h-4 rounded border-gray-300"
                />
                Include Roles — propose existing roles whose membership criteria matches each data segment
              </label>
              <label className="flex items-center gap-2 text-xs text-gray-600">
                <input
                  type="checkbox"
                  checked={includeEntitlements}
                  onChange={(e) => setIncludeEntitlements(e.target.checked)}
                  disabled={segmentScan.isPending}
                  className="w-4 h-4 rounded border-gray-300"
                />
                Include Entitlements — propose every entitlement held by anyone in each data segment
              </label>
            </div>
          )}

          <OutlineButton onClick={() => segmentScan.mutate()} loading={segmentScan.isPending} disabled={!boundaryReady}>
            <Shapes size={16} />
            Scan for Data Segments
          </OutlineButton>

          {boundaryReady && (
            <div className="mt-3 border border-gray-100 rounded-xl px-3 py-2.5 text-xs text-gray-500 space-y-1">
              <p>
                Boundary: <span className="font-medium text-gray-700">{schemaAnalysis.roleBoundaryAttributes.join(" + ")}</span>
              </p>
            </div>
          )}
        </div>

        {pastScans.length > 0 && (
          <div className="mt-2">
            <div className="px-4 py-2 flex items-center gap-2">
              <Clock size={14} className="text-gray-400" />
              <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                Data Segment Drafts
              </h3>
            </div>
            {pastScans.map((s) => (
              <ScanListItem
                key={s.id}
                scan={s}
                onOpen={() => navigate(`${basePath}/scans/${s.id}`)}
                onCancel={() => cancelMutation.mutate(s.id)}
                cancelPending={cancelMutation.isPending}
                onRemove={() => removeMutation.mutate(s.id)}
                removePending={removeMutation.isPending}
                detail={`${s.totalCombinations ?? 0} combinations · ${s.suggestionCount ?? 0} proposed data segments`}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
