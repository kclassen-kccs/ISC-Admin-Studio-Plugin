import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bone, StopCircle, Settings, Clock, Printer, ShieldPlus, CheckCircle2, XCircle } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
import toast from "react-hot-toast";
import {
  getTenantSettings, getSchemaAnalysis, startSkeletonScan, getSkeletonScan, cancelSkeletonScan,
  listSkeletonScans, deleteSkeletonScan, createSkeletonScanRole, getCredentials,
} from "../../lib/sailpoint";
import { applyRoleNaming } from "../../lib/roleNaming";
import { printSkeletonScanPdf, skeletonRoleStatus, criteriaText } from "../../lib/exportSkeletonScanPdf";
import { TopBar } from "../../components/TopBar";
import { RoleMiningTitleMenu } from "../../components/RoleMiningTitleMenu";
import {
  Spinner, SectionLabel, Field, Input, PrimaryButton, OutlineButton, IconButton, ConfirmModal, ErrorBox, EmptyState, SkeletonList,
} from "../../components/ui";
import { STATUS_META, ScanListItem, ScanMasterDetail, ScanListRow } from "./shared";

// ─── Launcher ───────────────────────────────────────────────────────────────
// Same shape as Role Model Drafts: a form for this draft's one-off naming and
// Boundary choice, a button that plans a draft (creating nothing in ISC),
// and the list of past drafts. Roles are created from the draft screen.
export default function SkeletonRolesPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const settingsQuery = useQuery({ queryKey: ["tenant-settings"], queryFn: getTenantSettings });
  const schemaAnalysisQuery = useQuery({ queryKey: ["schema-analysis"], queryFn: getSchemaAnalysis });

  const [rolePrefix, setRolePrefix] = useState("");
  const [roleSuffix, setRoleSuffix] = useState("");
  const [attributeSeparator, setAttributeSeparator] = useState(" - ");
  const settingsLoadedAt = settingsQuery.dataUpdatedAt;
  useEffect(() => {
    if (settingsQuery.data) {
      setRolePrefix(settingsQuery.data.rolePrefix || "");
      setRoleSuffix(settingsQuery.data.roleSuffix || "");
      setAttributeSeparator(settingsQuery.data.attributeSeparator ?? " - ");
    }
  }, [settingsLoadedAt]);

  const [useBoundary, setUseBoundary] = useState(false);
  const schemaAnalysisLoadedAt = schemaAnalysisQuery.dataUpdatedAt;
  useEffect(() => {
    if (schemaAnalysisQuery.data) setUseBoundary(!!schemaAnalysisQuery.data.roleBoundaryEnabled);
  }, [schemaAnalysisLoadedAt]);
  const boundaryAttributes = schemaAnalysisQuery.data?.roleBoundaryAttributes || [];
  const attributeKeys = schemaAnalysisQuery.data?.topAttributes?.length ? schemaAnalysisQuery.data.topAttributes : ["department", "location"];

  const namingPreview = applyRoleNaming(["Engineering", "Production Test Engineer I"].join(attributeSeparator), rolePrefix, roleSuffix);

  const start = useMutation({
    mutationFn: () => startSkeletonScan({ rolePrefix, roleSuffix, useBoundary, attributeSeparator }),
    onSuccess: ({ scanId }) => {
      toast.success("Planning the Skeleton Role Model draft — check back here for results.");
      queryClient.invalidateQueries({ queryKey: ["skeletonScans"] });
      navigate(`/role-mining/skeleton-scans/${scanId}`);
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });
  const { data: drafts = [] } = useQuery({
    queryKey: ["skeletonScans"],
    queryFn: listSkeletonScans,
    refetchInterval: (query) => (query.state.data?.some((s) => s.status === "running") ? 4000 : 15000),
  });
  const cancel = useMutation({
    mutationFn: (id) => cancelSkeletonScan(id),
    onSuccess: () => { toast.success("Cancelling planning"); queryClient.invalidateQueries({ queryKey: ["skeletonScans"] }); },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });
  const remove = useMutation({
    mutationFn: (id) => deleteSkeletonScan(id),
    onSuccess: () => { toast.success("Draft removed"); queryClient.invalidateQueries({ queryKey: ["skeletonScans"] }); },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <TopBar
        title={<RoleMiningTitleMenu active="Skeleton Roles" />}
        action={<IconButton icon={Settings} title="Mining Config" onClick={() => navigate("/studio-settings/scanning-config")} />}
      />
      <div className="flex-1 overflow-y-auto pb-24">
        <div className="px-4 py-4 flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-violet-50 flex items-center justify-center flex-shrink-0">
            <Bone size={18} className="text-violet-600" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-gray-900">Skeleton Roles</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Plans a disabled, access-less role per {attributeKeys[0]} value (using the Role Naming below) so the
              Role Model can be visualized without assigning any access. Review and print the draft, then create
              any or all of its roles in ISC.
            </p>
          </div>
        </div>

        <div className="px-4 pb-4">
          <label className="flex items-start gap-2.5 border border-gray-100 rounded-xl p-4 cursor-pointer">
            <input
              type="checkbox"
              checked={useBoundary}
              onChange={(e) => setUseBoundary(e.target.checked)}
              disabled={start.isPending || schemaAnalysisQuery.isLoading}
              className="w-4 h-4 rounded border-gray-300 mt-0.5 flex-shrink-0"
            />
            <div className="min-w-0">
              <p className="text-sm font-medium text-gray-900">Use Multi-Company/Division Boundary</p>
              <p className="text-xs text-gray-500 mt-0.5">
                {schemaAnalysisQuery.isLoading
                  ? "Loading…"
                  : boundaryAttributes.length > 0
                  ? `Plans a separate skeleton role set per distinct combination of ${boundaryAttributes.join(" + ")}.`
                  : "No boundary attributes are configured — set this up in Schema Analysis first."}
                {" "}Defaulted from Schema Analysis's saved setting; this only affects this draft.
              </p>
            </div>
          </label>
        </div>

        <SectionLabel>Role Naming</SectionLabel>
        <div className="px-4">
          {settingsQuery.isLoading ? (
            <div className="flex items-center justify-center py-6"><Spinner size={18} /></div>
          ) : (
            <div className="border border-gray-100 rounded-xl p-4">
              <p className="text-xs text-gray-500 mb-3">
                Starts from Mining Config's saved Role Naming, but changes here are used only for this draft —
                they're never saved back to Mining Config.
              </p>
              <Field label="Attribute Separator">
                <Input value={attributeSeparator} onChange={(e) => setAttributeSeparator(e.target.value)} placeholder='e.g. " - "' disabled={start.isPending} />
              </Field>
              <Field label="Prefix">
                <Input value={rolePrefix} onChange={(e) => setRolePrefix(e.target.value)} placeholder='Optional, e.g. "DRAFT - "' disabled={start.isPending} />
              </Field>
              <Field label="Suffix">
                <Input value={roleSuffix} onChange={(e) => setRoleSuffix(e.target.value)} placeholder='Optional, e.g. " Peer Group"' disabled={start.isPending} />
              </Field>
              <p className="text-xs text-gray-400 truncate">Preview: {namingPreview}</p>
            </div>
          )}
        </div>

        <div className="px-4 pt-4">
          <OutlineButton onClick={() => start.mutate()} loading={start.isPending}>
            <Bone size={16} />
            Create a Skeleton Role Model Draft
          </OutlineButton>
        </div>

        {drafts.length > 0 && (
          <div className="mt-4">
            <div className="px-4 py-2 flex items-center gap-2">
              <Clock size={14} className="text-gray-400" />
              <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Skeleton Role Model Drafts</h3>
            </div>
            {drafts.map((s) => (
              <ScanListItem
                key={s.id}
                scan={s}
                onOpen={() => navigate(`/role-mining/skeleton-scans/${s.id}`)}
                onCancel={() => cancel.mutate(s.id)}
                cancelPending={cancel.isPending}
                onRemove={() => remove.mutate(s.id)}
                removePending={remove.isPending}
                detail={
                  s.status === "running"
                    ? `${s.scanned ?? 0} identities scanned…`
                    : `${s.planned ?? 0} role${(s.planned ?? 0) === 1 ? "" : "s"} proposed · ${s.created ?? 0} created in ISC${s.failed ? ` · ${s.failed} failed` : ""} · ${(s.attributeKeys || []).join(" > ")}`
                }
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Draft detail ───────────────────────────────────────────────────────────
// Same shape as Role Model Draft: a summary of the draft, then (from md up) a
// picker rail of proposed roles on the left and the selected role's full
// card on the right; below md the cards stack in one column.

const canCreate = (r) => !r.roleId && skeletonRoleStatus(r) !== "created";
const humanize = (k) => String(k || "").replace(/([a-z])([A-Z])/g, "$1 $2");

function SkeletonRoleCard({ scanId, result, index, onCreated }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const status = skeletonRoleStatus(result);
  const boundaryKeys = new Set((result.boundary || []).map((b) => b.key));
  const dimensions = Array.isArray(result.dimensionCounts) && result.dimensionCounts.length
    ? result.dimensionCounts
    : (result.dimensionValues || []).map((value) => ({ value, members: null }));
  const dimensionOutcome = new Map((result.dimensions || []).map((d) => [d.value, d]));

  const create = useMutation({
    mutationFn: () => createSkeletonScanRole(scanId, index),
    onSuccess: (created) => {
      toast.success(`Created "${created.roleName}" in ISC`);
      queryClient.invalidateQueries({ queryKey: ["skeleton-scan", scanId] });
      queryClient.invalidateQueries({ queryKey: ["skeletonScans"] });
      onCreated?.();
    },
    onError: (err) => {
      toast.error(err.response?.data?.error || err.message);
      queryClient.invalidateQueries({ queryKey: ["skeleton-scan", scanId] });
    },
  });

  return (
    <div className="px-4 py-4">
      <div className="flex items-center gap-2 mb-1">
        <Bone size={16} className="text-violet-600 flex-shrink-0" />
        <p className="text-sm font-semibold text-gray-900">{result.roleName}</p>
        {result.isCommonAccess && <span className="text-[10px] font-semibold uppercase tracking-wide text-violet-700 bg-violet-50 px-1.5 py-0.5 rounded-full">Common Access</span>}
        {result.dimensional && <span className="text-[10px] font-semibold uppercase tracking-wide text-blue-700 bg-blue-50 px-1.5 py-0.5 rounded-full">Dynamic</span>}
      </div>
      <p className="text-xs text-gray-500 mb-2">
        {result.memberCount} member{result.memberCount === 1 ? "" : "s"}
        {result.dimensional ? ` · ${dimensions.length} dimension${dimensions.length === 1 ? "" : "s"}` : " · no dimensions"}
        {" · no entitlements"}
      </p>

      {(result.criteria || []).length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {result.criteria.map(({ key, value }) => (
            <span
              key={`${key}:${value}`}
              className={`text-xs px-2 py-1 rounded-full border ${
                boundaryKeys.has(key) ? "bg-amber-50 text-amber-700 border-amber-200" : "bg-blue-50 text-blue-700 border-blue-100"
              }`}
            >
              {humanize(key)}: {value}
            </span>
          ))}
          {!result.isCommonAccess && (
            <span className="text-xs px-2 py-1 rounded-full border bg-blue-50 text-blue-700 border-blue-100">cloud Lifecycle State: active</span>
          )}
        </div>
      )}

      {!result.isCommonAccess && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {(result.members || []).map((m) => (
            <button
              key={m.id}
              onClick={() => navigate(`/identities/${m.id}`)}
              className="text-xs bg-gray-100 text-gray-700 px-2 py-1 rounded-full hover:bg-gray-200 transition-colors"
            >
              {m.name || m.id}
            </button>
          ))}
        </div>
      )}
      {result.isCommonAccess && (
        <p className="text-xs text-gray-400 mb-2">Members are every identity in the scan scope{(result.boundary || []).length ? " within this partition" : ""} — {result.memberCount} in all.</p>
      )}

      {result.dimensional && (
        <div className="mb-3">
          <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-1">Dimensions by {humanize(result.dimensionAttribute)}</p>
          <div className="flex flex-wrap gap-1.5">
            {dimensions.map((d) => {
              const o = dimensionOutcome.get(d.value);
              const cls = o
                ? (o.ok ? "bg-emerald-50 text-emerald-700 border-emerald-100" : "bg-red-50 text-red-700 border-red-200")
                : "bg-violet-50 text-violet-700 border-violet-100";
              return (
                <span key={d.value} className={`text-xs px-2 py-1 rounded-full border ${cls}`} title={o && !o.ok ? o.error : undefined}>
                  {d.value}{d.members != null ? ` (${d.members})` : ""}
                </span>
              );
            })}
          </div>
        </div>
      )}

      {result.description && <p className="text-xs text-gray-600 mb-3">{result.description}</p>}

      {status === "created" ? (
        <div className="bg-emerald-50 border border-emerald-100 rounded-lg px-3 py-2">
          <div className="flex items-start gap-2 text-xs text-emerald-700">
            <CheckCircle2 size={14} className="flex-shrink-0 mt-0.5" />
            <span>
              {result.dimensional ? "Dynamic role" : result.isCommonAccess ? "Common Access role" : "Role"}{" "}
              <button type="button" onClick={() => navigate(`/roles/${result.roleId}`)} className="underline font-medium">
                "{result.roleName}"
              </button>{" "}
              created{result.createdAt ? ` ${new Date(result.createdAt).toLocaleDateString()}` : ""}
              {result.dimensional && (
                <> — dimensioned by {humanize(result.dimensionAttribute)} ({(result.dimensions || []).filter((d) => d.ok).length} of {(result.dimensions || []).length} values)</>
              )}
            </span>
          </div>
          {result.commonAccessFlagged === false && (
            <p className="text-xs text-amber-700 mt-2 pl-1">
              Couldn't be flagged as Common Access in ISC{result.commonAccessError ? `: ${result.commonAccessError}` : ""} — flag it manually in ISC (Admin › Access Model › Roles › Common Access).
            </p>
          )}
          {(result.dimensions || []).some((d) => !d.ok) && (
            <div className="mt-2 pl-1 space-y-1">
              {result.dimensions.filter((d) => !d.ok).map((d) => (
                <p key={d.value} className="text-xs text-red-600 flex items-center gap-1.5"><XCircle size={11} className="flex-shrink-0" />{d.value}: {d.error}</p>
              ))}
            </div>
          )}
        </div>
      ) : (
        <>
          {status === "failed" && result.error && (
            <div className="bg-red-50 border border-red-100 rounded-lg px-3 py-2 mb-2 text-xs text-red-700 break-words">{result.error}</div>
          )}
          <OutlineButton onClick={() => create.mutate()} loading={create.isPending}>
            <ShieldPlus size={16} />
            {status === "failed" ? "Retry Creating This Role" : result.isCommonAccess ? "Create Common Access Role" : "Create This Role"}
          </OutlineButton>
        </>
      )}
    </div>
  );
}

export function SkeletonScanDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const tenant = getCredentials()?.tenant;
  const [selectedIndex, setSelectedIndex] = useState(null);
  const [createAllOpen, setCreateAllOpen] = useState(false);
  const [bulkProgress, setBulkProgress] = useState(null);

  const { data: scan, isLoading, error } = useQuery({
    queryKey: ["skeleton-scan", id],
    queryFn: () => getSkeletonScan(id),
    refetchInterval: (query) => (query.state.data?.status === "running" ? 2000 : false),
  });
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["skeleton-scan", id] });
    queryClient.invalidateQueries({ queryKey: ["skeletonScans"] });
  };
  const results = useMemo(() => scan?.results || [], [scan]);
  const creatable = results.map((r, index) => ({ r, index })).filter(({ r }) => canCreate(r));
  const createdCount = results.filter((r) => skeletonRoleStatus(r) === "created").length;
  const selected = selectedIndex != null && results[selectedIndex] ? selectedIndex : (results.length ? 0 : null);

  const cancel = useMutation({
    mutationFn: () => cancelSkeletonScan(id),
    onSuccess: () => { toast.success("Cancelling planning"); refresh(); },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });
  const createAll = useMutation({
    mutationFn: async (indexes) => {
      let ok = 0; let failed = 0;
      setBulkProgress({ done: 0, total: indexes.length });
      for (let i = 0; i < indexes.length; i += 1) {
        try { await createSkeletonScanRole(id, indexes[i]); ok += 1; } catch { failed += 1; }
        setBulkProgress({ done: i + 1, total: indexes.length });
        queryClient.invalidateQueries({ queryKey: ["skeleton-scan", id] });
      }
      return { ok, failed };
    },
    onSuccess: ({ ok, failed }) => {
      if (failed) toast.error(`Created ${ok} of ${ok + failed} roles — ${failed} failed (see each role)`);
      else toast.success(`Created ${ok} role${ok === 1 ? "" : "s"} in ISC`);
    },
    onError: (err) => toast.error(err.message),
    onSettled: () => { setBulkProgress(null); setCreateAllOpen(false); refresh(); },
  });

  const meta = scan ? (STATUS_META[scan.status] || STATUS_META.running) : null;
  const StatusIcon = meta?.icon;
  const rowIcon = (r) => {
    const s = skeletonRoleStatus(r);
    if (s === "created") return { icon: CheckCircle2, cls: "text-emerald-600" };
    if (s === "failed") return { icon: XCircle, cls: "text-red-500" };
    return { icon: Bone, cls: "text-violet-600" };
  };
  const rowSubtitle = (r) => {
    const dims = Array.isArray(r.dimensionCounts) && r.dimensionCounts.length ? r.dimensionCounts.length : (r.dimensionValues || []).length;
    const boundary = (r.boundary || []).map((b) => b.value).join(" · ");
    return `${r.memberCount} member${r.memberCount === 1 ? "" : "s"} · ${dims} dimension${dims === 1 ? "" : "s"}${boundary ? ` · ${boundary}` : ""}`;
  };

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <TopBar
        title="Skeleton Role Model Draft"
        onBack={() => navigate("/role-mining/skeleton-roles")}
        action={
          scan && (
            <div className="flex items-center gap-3">
              <IconButton icon={Settings} title="Mining Config" onClick={() => navigate("/studio-settings/scanning-config")} />
              {scan.status === "running" && (
                <IconButton icon={StopCircle} title="Cancel" onClick={() => cancel.mutate()} loading={cancel.isPending} />
              )}
              {scan.status !== "running" && results.length > 0 && (
                <IconButton
                  icon={ShieldPlus}
                  title={creatable.length ? `Create All Roles (${creatable.length})` : "Create All Roles — every role is already created"}
                  onClick={() => setCreateAllOpen(true)}
                  loading={createAll.isPending}
                  disabled={createAll.isPending || creatable.length === 0}
                />
              )}
              {results.length > 0 && (
                <button
                  onClick={() => { if (!printSkeletonScanPdf({ tenant, scan })) toast("Pop-up blocked — downloaded the PDF instead"); }}
                  className="flex items-center gap-1 text-blue-600 text-sm font-medium"
                  title="Print"
                >
                  <Printer size={16} />
                </button>
              )}
            </div>
          )
        }
      />

      {createAllOpen && scan && (
        <ConfirmModal
          title={`Create ${creatable.length} role${creatable.length === 1 ? "" : "s"} in ISC?`}
          message={bulkProgress
            ? `Creating ${bulkProgress.done} of ${bulkProgress.total}…`
            : "Every proposed role that isn't created yet will be created in ISC — disabled, not requestable, with its membership criteria and dimensions and no entitlements. You can enable them later from Roles."}
          confirmLabel="Create All"
          pending={createAll.isPending}
          onConfirm={() => createAll.mutate(creatable.map(({ index }) => index))}
          onCancel={() => !createAll.isPending && setCreateAllOpen(false)}
        />
      )}

      <div className="flex-1 overflow-y-auto pb-24">
        {isLoading && <div className="px-4 py-4"><SkeletonList rows={4} /></div>}
        {error && <div className="px-4 py-4"><ErrorBox message={error.response?.data?.error || error.message} /></div>}
        {scan && (
          <>
            <div className="px-4 py-4 border-b border-gray-100">
              <div className="md:grid md:grid-cols-2 md:gap-x-8 md:items-start">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    {StatusIcon && <StatusIcon size={16} className={meta.className} />}
                    <p className="text-sm font-medium text-gray-900">{scan.status === "completed" ? "Planned" : meta.label}</p>
                    {bulkProgress && <p className="text-xs text-blue-600 font-medium">· Creating {bulkProgress.done} of {bulkProgress.total}…</p>}
                  </div>
                  <p className="text-xs text-gray-500">Started {new Date(scan.startedAt).toLocaleString()}</p>
                  <p className="text-xs text-gray-500 mt-1">
                    {scan.scanned ?? 0} identities scanned · <span className="font-medium text-gray-700">{results.length}</span> role{results.length === 1 ? "" : "s"} proposed
                    {" · "}<span className="font-medium text-emerald-700">{createdCount}</span> created in ISC
                    {scan.failed ? <> · <span className="text-red-600 font-medium">{scan.failed} failed</span></> : null}
                  </p>
                </div>
                <div className="mt-2 md:mt-0">
                  <p className="text-xs font-medium text-gray-500">
                    Attribute priority: <span className="text-gray-700">{(scan.attributeKeys || []).join(" > ") || "—"}</span>
                  </p>
                  <p className="text-xs font-medium text-gray-500 mt-1">
                    Boundary: <span className="text-gray-700">{scan.roleBoundaryEnabled ? (scan.roleBoundaryAttributes || []).join(" + ") : "Off"}</span>
                    {" · "}Create Dynamic Roles: <span className="text-gray-700">{scan.createDynamicRoles ? "On" : "Off"}</span>
                  </p>
                  <p className="text-xs font-medium text-gray-500 mt-1">
                    Naming: <span className="text-gray-700 font-mono">"{scan.rolePrefix || ""}"</span> + value + <span className="text-gray-700 font-mono">"{scan.roleSuffix || ""}"</span>
                    {" · "}separator <span className="text-gray-700 font-mono">"{scan.attributeSeparator || ""}"</span>
                  </p>
                  {scan.scopeQuery && (
                    <p className="text-xs font-medium text-gray-500 mt-1">Scope: <span className="text-gray-700 font-mono">{scan.scopeQuery}</span></p>
                  )}
                </div>
              </div>
              {scan.error && <div className="mt-3"><ErrorBox message={scan.error} /></div>}
            </div>

            {results.length === 0 && scan.status === "completed" ? (
              <EmptyState icon={Bone} title="No roles to propose" subtitle={`No in-scope identity has a value for ${scan.primaryKey || "the primary attribute"}.`} />
            ) : (
              <ScanMasterDetail
                listTitle={`Proposed Roles (${results.length})`}
                single={results.map((r, index) => (
                  <div key={index} className="border-b border-gray-100">
                    <SkeletonRoleCard scanId={id} result={r} index={index} />
                  </div>
                ))}
                list={results.map((r, index) => {
                  const { icon, cls } = rowIcon(r);
                  return (
                    <ScanListRow
                      key={index}
                      active={selected === index}
                      onClick={() => setSelectedIndex(index)}
                      icon={icon}
                      iconClass={cls}
                      title={r.roleName}
                      subtitle={rowSubtitle(r)}
                      tag={r.isCommonAccess ? "Common Access" : r.dimensional ? "Dynamic" : null}
                    />
                  );
                })}
                detail={selected != null && (
                  <SkeletonRoleCard key={selected} scanId={id} result={results[selected]} index={selected} />
                )}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
