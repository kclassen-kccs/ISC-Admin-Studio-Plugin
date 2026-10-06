import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock, CheckCircle2, AlertTriangle, PlusCircle, Shield, ShieldCheck, Key, Settings, Split, Printer } from "lucide-react";
import toast from "react-hot-toast";
import {
  startAccessSegmentScan, listAccessSegmentScans, getAccessSegmentScan, cancelAccessSegmentScan,
  deleteAccessSegmentScan, createAccessSegmentsFromScan, getAccessSegmentCreateProgress, getSchemaAnalysis, getCredentials,
} from "../../lib/sailpoint";
import { printAccessSegmentScanPdf } from "../../lib/exportIscSegmentsPdf";
import { TopBar } from "../../components/TopBar";
import { RoleMiningTitleMenu } from "../../components/RoleMiningTitleMenu";
import { OutlineButton, EmptyState, Spinner, ErrorBox, IconButton, ConfirmModal, SelectionActionBar } from "../../components/ui";
import { STATUS_META, ScanListItem, ScanMasterDetail, ScanListRow } from "./shared";

// ─── Segments mining ─────────────────────────────────────────────────────────
// ISC Segments (access-request Segments) — a separate object from Data
// Segments. The scan proposes one Segment per Multi-Company/Division
// Boundary value: its member definition is the boundary filter, and its
// access is every role, access profile and entitlement its members hold
// (found with identity search). Nothing is created until the draft is
// reviewed and Create is chosen.

const BASE_PATH = "/role-mining/access-segments";
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function groupBySource(items) {
  const map = new Map();
  for (const e of items || []) {
    const key = e.source || "Other";
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(e);
  }
  return [...map.entries()]
    .map(([source, list]) => [source, [...list].sort((a, b) => (a.name || "").localeCompare(b.name || ""))])
    .sort((a, b) => a[0].localeCompare(b[0]));
}

function ItemPills({ title, items, icon: Icon, className, onOpen, bySource }) {
  if (!items?.length) return null;
  const pill = (x) => (
    <button
      key={x.id}
      type="button"
      onClick={(e) => { e.preventDefault(); onOpen(x); }}
      className={`text-xs border px-2 py-1 rounded-full transition-colors flex items-center gap-1 ${className}`}
    >
      {Icon && <Icon size={11} />}
      {x.name}
    </button>
  );
  return (
    <div className="mb-3">
      <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-1.5">{title} ({items.length})</p>
      {bySource ? (
        <div className="space-y-1.5">
          {groupBySource(items).map(([source, list]) => (
            <div key={source}>
              <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-1">{source}</p>
              <div className="flex flex-wrap gap-1.5">{list.map(pill)}</div>
            </div>
          ))}
        </div>
      ) : (
        <div className="flex flex-wrap gap-1.5">{items.map(pill)}</div>
      )}
    </div>
  );
}

function assignedSummary(assigned) {
  if (!assigned) return "";
  const part = (o, word) => (o ? `${o.assigned + o.alreadyAssigned}/${o.requested} ${word}` : null);
  const failed = ["roles", "accessProfiles", "entitlements"].reduce((n, k) => n + (assigned[k]?.failed?.length || 0), 0);
  return [
    part(assigned.roles, "roles"),
    part(assigned.accessProfiles, "access profiles"),
    part(assigned.entitlements, "entitlements"),
  ].filter(Boolean).join(" · ") + (failed ? ` — ${failed} failed` : "");
}

function SuggestionCard({ s, boundaryKeys, selected, selectable, onToggle, navigate, showCheckbox = true }) {
  const Wrapper = showCheckbox ? "label" : "div";
  const done = s.segmentCreated || s.addedToExisting;
  return (
    <Wrapper className={`flex items-start gap-3 px-4 py-3.5 ${showCheckbox && selectable ? "hover:bg-gray-50 cursor-pointer" : ""}`}>
      {showCheckbox && (
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onToggle(s.id)}
          disabled={!selectable}
          className="w-4 h-4 rounded border-gray-300 flex-shrink-0 mt-0.5"
        />
      )}
      <div className="w-9 h-9 rounded-full bg-teal-50 flex items-center justify-center flex-shrink-0">
        <Split size={15} className="text-teal-600" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-gray-900">{s.name}</p>
        <p className="text-xs text-gray-500 mt-0.5 mb-2">
          {plural(s.memberCount, "member")} · {plural(s.roles?.length || 0, "role")} · {plural(s.accessProfiles?.length || 0, "access profile")} · {plural(s.entitlements?.length || 0, "entitlement")}
        </p>

        <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Members</p>
        <div className="flex flex-wrap gap-1.5 mb-3">
          {(boundaryKeys || []).map((key, i) => (
            <span key={key} className="text-xs px-2 py-1 rounded-full border bg-amber-50 text-amber-700 border-amber-200">
              {key} = {s.values?.[i]}
            </span>
          ))}
        </div>

        {s.searchError && <p className="text-xs text-red-600 mb-2">Access search failed: {s.searchError}</p>}

        <ItemPills title="Roles" items={s.roles} icon={Shield}
          className="bg-blue-50 text-blue-700 border-blue-100 hover:bg-blue-100"
          onOpen={(x) => navigate(`/roles/${x.id}`)} />
        <ItemPills title="Access Profiles" items={s.accessProfiles} icon={ShieldCheck} bySource
          className="bg-emerald-50 text-emerald-700 border-emerald-100 hover:bg-emerald-100"
          onOpen={(x) => navigate(`/access-profiles/${x.id}`)} />
        <ItemPills title="Entitlements" items={s.entitlements} icon={Key} bySource
          className="bg-violet-50 text-violet-700 border-violet-100 hover:bg-violet-100"
          onOpen={(x) => navigate(`/entitlements/${x.id}`)} />

        {done && (
          <div className="mt-1 bg-emerald-50 border border-emerald-100 rounded-lg px-2.5 py-1.5 flex items-start gap-1.5">
            <CheckCircle2 size={13} className="text-emerald-600 flex-shrink-0 mt-0.5" />
            <p className="text-xs text-emerald-700">
              {s.segmentCreated ? "Created" : "Added to existing segment"}{" "}
              <button type="button" onClick={(e) => { e.preventDefault(); navigate(`/access-segments/${done.segmentId}`); }} className="underline font-medium">
                "{done.segmentName}"
              </button>{" "}
              {new Date(done.at).toLocaleDateString()}
              {done.assigned && <span className="block text-emerald-600 mt-0.5">Assigned {assignedSummary(done.assigned)}</span>}
            </p>
          </div>
        )}
        {!done && s.existingSegment && (
          <div className="mt-1 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5 flex items-start gap-1.5">
            <AlertTriangle size={13} className="text-amber-600 flex-shrink-0 mt-0.5" />
            <p className="text-xs text-amber-800">
              A Segment named "{s.existingSegment.name}" already exists — creating adds this access to it instead of making a new one.
            </p>
          </div>
        )}
      </div>
    </Wrapper>
  );
}

export function AccessSegmentScanDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState(() => new Set());
  const [confirmIds, setConfirmIds] = useState(null); // ids awaiting the Create confirm
  const [activate, setActivate] = useState(true);
  const [openId, setOpenId] = useState(null);

  const { data: scan, isLoading, error } = useQuery({
    queryKey: ["accessSegmentScan", id],
    queryFn: () => getAccessSegmentScan(id),
    refetchInterval: (query) => (query.state.data?.status === "running" ? 3000 : false),
  });

  const createMutation = useMutation({
    mutationFn: (ids) => createAccessSegmentsFromScan(id, ids, { activate }),
    onSuccess: ({ results }) => {
      const ok = results.filter((r) => r.ok);
      const failed = results.length - ok.length;
      const assignFailures = ok.reduce((n, r) =>
        n + ["roles", "accessProfiles", "entitlements"].reduce((m, k) => m + (r.assigned?.[k]?.failed?.length || 0), 0), 0);
      if (failed) toast.error(`${ok.length} of ${results.length} segments done — ${failed} failed`);
      else toast.success(`${plural(ok.length, "segment")} done`);
      if (assignFailures) toast.error(`${plural(assignFailures, "access item")} couldn't be assigned — see each segment's result.`, { duration: 8000 });
      setSelected(new Set());
      setConfirmIds(null);
      queryClient.invalidateQueries({ queryKey: ["accessSegmentScan", id] });
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const { data: progress } = useQuery({
    queryKey: ["access-segment-create-progress", id],
    queryFn: () => getAccessSegmentCreateProgress(id),
    enabled: createMutation.isPending,
    refetchInterval: createMutation.isPending ? 1000 : false,
  });
  const progressText = createMutation.isPending && progress?.total ? `Creating segments… (${progress.done} of ${progress.total} done)` : undefined;

  if (isLoading || !scan) {
    return (
      <div className="flex flex-col min-h-screen bg-white">
        <TopBar title="Segments Draft" onBack={() => navigate(BASE_PATH)} />
        <div className="flex-1 flex items-center justify-center">
          {error ? <ErrorBox message={error.message} /> : <Spinner size={24} />}
        </div>
      </div>
    );
  }

  const meta = STATUS_META[scan.status] || STATUS_META.running;
  const StatusIcon = meta.icon;
  const suggestions = scan.suggestions || [];
  const eligible = suggestions.filter((s) => !s.segmentCreated && !s.addedToExisting);
  const eligibleIds = new Set(eligible.map((s) => s.id));
  const allSelected = eligible.length > 0 && eligible.every((s) => selected.has(s.id));
  const toggleOne = (sid) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(sid)) next.delete(sid); else next.add(sid);
    return next;
  });
  const openSuggestion = suggestions.find((s) => s.id === openId) || suggestions[0];
  const confirmList = confirmIds ? suggestions.filter((s) => confirmIds.includes(s.id)) : [];
  const confirmNew = confirmList.filter((s) => !s.existingSegment).length;
  const confirmExisting = confirmList.length - confirmNew;

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <TopBar
        title="Segments Draft"
        onBack={() => navigate(BASE_PATH)}
        action={
          <div className="flex items-center gap-3">
            {eligible.length > 0 && (
              <IconButton icon={PlusCircle} title={`Create All Segments (${eligible.length})`} onClick={() => setConfirmIds(eligible.map((s) => s.id))} />
            )}
            {suggestions.length > 0 && (
              <button
                onClick={() => {
                  if (!printAccessSegmentScanPdf({ tenant: getCredentials()?.tenant, scan })) {
                    toast("Pop-up blocked — downloaded the PDF instead");
                  }
                }}
                className="flex items-center gap-1 text-blue-600 text-sm font-medium"
                title="Print"
              >
                <Printer size={16} />
              </button>
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
          {scan.status === "running" && (
            <p className="text-xs text-gray-500 mt-1">
              {scan.searched ? `Searching members' access… ${scan.searched} done` : `Scanned ${scan.scanned || 0} objects…`}
            </p>
          )}
          {scan.error && <p className="text-xs text-red-600 mt-1">{scan.error}</p>}
          <p className="text-xs text-gray-400 mt-2">Boundary: {scan.boundaryKeys?.join(" + ") || "—"}</p>
          <p className="text-xs text-gray-400 mt-1">{plural(scan.totalCombinations ?? 0, "boundary value")} found</p>
        </div>

        {suggestions.length === 0 && scan.status === "completed" ? (
          <EmptyState icon={Split} title="No segments proposed" subtitle="No identity has a value for the boundary attribute" />
        ) : (
          <>
            {eligible.length > 0 && (
              <>
                <div className="flex items-center justify-between px-4 py-2 border-b border-gray-100">
                  <label className="flex items-center gap-2 text-xs text-gray-500">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={() => setSelected(allSelected ? new Set() : new Set(eligible.map((s) => s.id)))}
                      className="w-4 h-4 rounded border-gray-300"
                    />
                    Select all
                  </label>
                  <p className="text-xs text-gray-400">{suggestions.length} proposed</p>
                </div>
                {selected.size > 0 && (
                  <SelectionActionBar
                    count={selected.size}
                    actions={[{
                      icon: PlusCircle,
                      title: `Create Selected (${selected.size})`,
                      onClick: () => setConfirmIds([...selected]),
                      loading: createMutation.isPending,
                    }]}
                  />
                )}
              </>
            )}
            <ScanMasterDetail
              listTitle={`Proposed Segments (${suggestions.length})`}
              single={suggestions.map((s) => (
                <div key={s.id} className="border-b border-gray-100">
                  <SuggestionCard s={s} boundaryKeys={scan.boundaryKeys} selected={selected.has(s.id)}
                    selectable={eligibleIds.has(s.id)} onToggle={toggleOne} navigate={navigate} />
                </div>
              ))}
              list={suggestions.map((s) => (
                <ScanListRow
                  key={s.id}
                  active={openSuggestion?.id === s.id}
                  onClick={() => setOpenId(s.id)}
                  icon={s.segmentCreated || s.addedToExisting ? CheckCircle2 : s.existingSegment ? AlertTriangle : Split}
                  iconClass={s.segmentCreated || s.addedToExisting ? "text-emerald-600" : s.existingSegment ? "text-amber-500" : "text-teal-600"}
                  title={s.name}
                  subtitle={`${plural(s.memberCount, "member")} · ${(s.roles?.length || 0) + (s.accessProfiles?.length || 0) + (s.entitlements?.length || 0)} access items`}
                  tag={s.segmentCreated ? "Created" : s.addedToExisting ? "Added" : s.existingSegment ? "Exists" : null}
                  leading={
                    eligibleIds.has(s.id) ? (
                      <input type="checkbox" checked={selected.has(s.id)} onChange={() => toggleOne(s.id)}
                        className="w-4 h-4 rounded border-gray-300 flex-shrink-0 mt-1" />
                    ) : <span className="w-4 flex-shrink-0" />
                  }
                />
              ))}
              detail={openSuggestion && (
                <SuggestionCard key={openSuggestion.id} s={openSuggestion} boundaryKeys={scan.boundaryKeys}
                  selected={selected.has(openSuggestion.id)} selectable={eligibleIds.has(openSuggestion.id)}
                  onToggle={toggleOne} navigate={navigate} showCheckbox={false} />
              )}
            />
          </>
        )}
      </div>

      {confirmIds && (
        <ConfirmModal
          title={`Create ${plural(confirmList.length, "segment")}?`}
          message={
            `Creates ${plural(confirmNew, "new ISC Segment")}${confirmExisting ? ` and adds access to ${plural(confirmExisting, "existing Segment")} of the same name` : ""}. ` +
            "Each Segment's members are defined by its boundary filter, and every role, access profile and entitlement its members hold is assigned to it."
          }
          confirmLabel="Create"
          pending={createMutation.isPending}
          progressText={progressText}
          onConfirm={() => createMutation.mutate(confirmIds)}
          onCancel={() => setConfirmIds(null)}
        >
          <label className="flex items-center gap-2 text-sm text-gray-700 mb-4">
            <input type="checkbox" checked={activate} onChange={(e) => setActivate(e.target.checked)}
              disabled={createMutation.isPending} className="w-4 h-4 rounded border-gray-300" />
            Activate new Segments
          </label>
        </ConfirmModal>
      )}
    </div>
  );
}

export default function AccessSegmentsMiningPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: schemaAnalysis } = useQuery({ queryKey: ["schema-analysis"], queryFn: getSchemaAnalysis });
  const boundaryReady = !!schemaAnalysis?.roleBoundaryEnabled && (schemaAnalysis.roleBoundaryAttributes || []).length > 0;

  const { data: scans = [], error } = useQuery({
    queryKey: ["accessSegmentScans"],
    queryFn: listAccessSegmentScans,
    refetchInterval: (query) => (query.state.data?.some((s) => s.status === "running") ? 4000 : 15000),
  });

  const startMutation = useMutation({
    mutationFn: startAccessSegmentScan,
    onSuccess: ({ scanId }) => {
      toast.success("Segments scan started");
      queryClient.invalidateQueries({ queryKey: ["accessSegmentScans"] });
      navigate(`${BASE_PATH}/scans/${scanId}`);
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });
  const cancelMutation = useMutation({
    mutationFn: cancelAccessSegmentScan,
    onSuccess: () => { toast.success("Cancelling…"); queryClient.invalidateQueries({ queryKey: ["accessSegmentScans"] }); },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });
  const removeMutation = useMutation({
    mutationFn: deleteAccessSegmentScan,
    onSuccess: () => { toast.success("Draft removed"); queryClient.invalidateQueries({ queryKey: ["accessSegmentScans"] }); },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <TopBar
        title={<RoleMiningTitleMenu active="Segments" />}
        action={<IconButton icon={Settings} title="Mining Config (Multi-Company/Division Boundary)" onClick={() => navigate("/studio-settings/scanning-config")} />}
      />
      <div className="flex-1 overflow-y-auto pb-24">
        <div className="px-4 py-5 border-b border-gray-100">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-full bg-teal-50 flex items-center justify-center flex-shrink-0">
              <Split size={18} className="text-teal-600" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-gray-900">Segments</h2>
              <p className="text-xs text-gray-500 mt-0.5">
                Proposes one ISC Segment per Multi-Company/Division Boundary value. Each Segment's members are
                defined by the boundary filter, and search finds every role, access profile and entitlement those
                members hold to assign to it. Segments are separate from Data Segments; review the draft before
                creating anything.
              </p>
            </div>
          </div>
          {error && <ErrorBox message={error.message} />}
          {!boundaryReady && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-3 flex gap-2">
              <AlertTriangle size={14} className="text-amber-600 flex-shrink-0 mt-0.5" />
              <p className="text-xs text-amber-800">
                Enable the Multi-Company/Division Boundary with at least one attribute in Schema Analysis first.
              </p>
            </div>
          )}
          <OutlineButton onClick={() => startMutation.mutate()} loading={startMutation.isPending} disabled={!boundaryReady}>
            <Split size={16} />
            Scan for Segments
          </OutlineButton>
          {boundaryReady && (
            <p className="mt-3 text-xs text-gray-500">
              Boundary: <span className="font-medium text-gray-700">{schemaAnalysis.roleBoundaryAttributes.join(" + ")}</span>
            </p>
          )}
        </div>

        {scans.length > 0 && (
          <div className="mt-2">
            <div className="px-4 py-2 flex items-center gap-2">
              <Clock size={14} className="text-gray-400" />
              <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Segments Drafts</h3>
            </div>
            {scans.map((s) => (
              <ScanListItem
                key={s.id}
                scan={s}
                onOpen={() => navigate(`${BASE_PATH}/scans/${s.id}`)}
                onCancel={() => cancelMutation.mutate(s.id)}
                cancelPending={cancelMutation.isPending}
                onRemove={() => removeMutation.mutate(s.id)}
                removePending={removeMutation.isPending}
                detail={`${plural(s.totalCombinations ?? 0, "boundary value")} · ${plural(s.suggestionCount ?? 0, "proposed segment")}`}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
