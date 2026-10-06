import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ClipboardCheck, Clock, Clock3, CheckCircle2, MinusCircle, PlusCircle, Boxes, AlertTriangle, Layers, CheckCheck, ShieldAlert, StopCircle, Sparkles, BadgeAlert, Printer, Settings,
} from "lucide-react";
import toast from "react-hot-toast";
import {
  startRoleEvalScan, listRoleEvalScans, getRoleEvalScan, cancelRoleEvalScan, deleteRoleEvalScan,
  acceptRoleEvalResult, acceptAllRoleEvalResults, markRoleEvalResultHandled,
  addRoleEntitlements, addDimensionEntitlements, updateDimensionEntitlements, createRoleDimension, updateRoleEntitlements,
  removeRoleEntitlements, removeDimensionEntitlements, evaluateRole, getTenantSettings, applyRoleSodMitigation,
  deleteRoleDimension, enableRoleCommonAccess, getCredentials,
} from "../../lib/sailpoint";
import { printRoleEvalScanPdf } from "../../lib/exportRoleEvalScanPdf";
import { TopBar } from "../../components/TopBar";
import { RoleMiningTitleMenu } from "../../components/RoleMiningTitleMenu";
import { PrimaryButton, OutlineButton, EmptyState, Spinner, ErrorBox, IconButton, Field, Input } from "../../components/ui";
import { EvaluationSheet } from "../../components/RoleEvaluationSheet";
import { STATUS_META, ScanListItem, ScanMasterDetail, ScanListRow } from "./shared";

function evaluationHasAnySuggestion(evaluation) {
  if (!evaluation) return false;
  return (
    (evaluation.removeCandidates?.length || 0) > 0 ||
    (evaluation.addCandidates?.length || 0) > 0 ||
    (evaluation.dimensionEvaluations || []).some((d) => d.addCandidates.length > 0) ||
    (evaluation.missingDimensions?.length || 0) > 0 ||
    (evaluation.staleDimensions?.length || 0) > 0 ||
    (evaluation.sodViolations?.length || 0) > 0 ||
    (evaluation.dimensionEvaluations || []).some((d) => (d.sodViolations || []).length > 0)
  );
}

// One role's evaluation result within a scan — a summary of the same signals
// RoleDetailPage's evaluate sheet shows (stale/missing entitlements,
// per-dimension gaps, missing dimensions). Clicking the row opens the same
// select-one-or-all detail sheet Role Detail uses; the inline Accept button
// stays as a shortcut for accepting everything found for this role without
// opening that detail.
// Shared by the full card and the two-pane picker row so a role reads the
// same in both.
function roleResultMeta(result) {
  return result.error
    ? { icon: AlertTriangle, className: "text-red-600" }
    : result.hasSodViolations
    ? { icon: ShieldAlert, className: "text-red-600" }
    : result.hasSuggestions
    ? { icon: MinusCircle, className: "text-amber-600" }
    : { icon: CheckCircle2, className: "text-emerald-600" };
}

// One line of counts for a picker row — the same facts the card spells out
// as pills, compressed to fit a 17rem rail.
function roleResultSummary(result) {
  if (result.error) return "Evaluation failed";
  const ev = result.evaluation;
  const sodCount =
    (ev?.sodViolations?.length || 0) +
    (ev?.dimensionEvaluations || []).reduce((n, d) => n + (d.sodViolations?.length || 0), 0);
  const parts = [];
  if (sodCount > 0) parts.push(`${sodCount} SOD`);
  if (ev?.removeCandidates?.length > 0) parts.push(`${ev.removeCandidates.length} to remove`);
  if (ev?.addCandidates?.length > 0) parts.push(`${ev.addCandidates.length} to add`);
  const dimGaps = (ev?.dimensionEvaluations || []).filter((d) => d.addCandidates.length > 0).length;
  if (dimGaps > 0) parts.push(`${dimGaps} dim gap${dimGaps === 1 ? "" : "s"}`);
  if (ev?.missingDimensions?.length > 0) parts.push(`${ev.missingDimensions.length} new dim`);
  if (result.mitigatedViolationPresent) parts.push("mitigated");
  return parts.length ? parts.join(" · ") : "No changes needed";
}

function RoleResultCard({ result, onOpen, onAccept, acceptPending }) {
  const navigate = useNavigate();
  const meta = roleResultMeta(result);
  const Icon = meta.icon;
  const ev = result.evaluation;
  const dimGaps = (ev?.dimensionEvaluations || []).filter((d) => d.addCandidates.length > 0);
  const sodCount = (ev?.sodViolations?.length || 0) + (ev?.dimensionEvaluations || []).reduce((n, d) => n + (d.sodViolations?.length || 0), 0);
  const clickable = !result.error && result.evaluation;

  return (
    <div
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={clickable ? onOpen : undefined}
      onKeyDown={clickable ? (e) => (e.key === "Enter" || e.key === " ") && onOpen() : undefined}
      className={`w-full text-left px-4 py-4 transition-colors ${clickable ? "hover:bg-gray-50 cursor-pointer" : ""}`}
    >
      <div className="flex items-start justify-between gap-2 mb-1">
        <div className="flex items-center gap-2 min-w-0">
          <Icon size={16} className={`${meta.className} flex-shrink-0`} />
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); navigate(`/roles/${result.roleId}`); }}
            className="text-sm font-semibold text-gray-900 truncate hover:text-blue-600 hover:underline text-left"
            title="Open role detail"
          >
            {result.roleName}
          </button>
          {result.dimensional && (
            <span className="text-[10px] font-medium text-emerald-700 bg-emerald-50 border border-emerald-100 px-1.5 py-0.5 rounded-full flex-shrink-0">
              Dynamic
            </span>
          )}
        </div>
        {result.accepted ? (
          <span className="flex items-center gap-1 text-xs font-medium text-emerald-600 flex-shrink-0">
            <CheckCheck size={14} />
            Applied
          </span>
        ) : (
          !result.error && result.hasSuggestions && (
            <OutlineButton
              onClick={(e) => { e.stopPropagation(); onAccept(); }}
              loading={acceptPending}
              className="!w-auto !py-1.5 !px-3 !text-xs flex-shrink-0"
            >
              Accept
            </OutlineButton>
          )
        )}
      </div>

      {result.error ? (
        <p className="text-xs text-red-600">{result.error}</p>
      ) : (
        <>
          {!result.hasSuggestions && !result.hasSodViolations && !result.mitigatedViolationPresent && (
            <p className="text-xs text-gray-400 mb-2">No changes needed. No SOD violations detected.</p>
          )}
          {(result.hasSuggestions || result.hasSodViolations) && (
            <p className="text-xs text-gray-600 mb-2">{ev.summary}</p>
          )}
          <div className="flex flex-wrap gap-1.5">
            <span
              className={`text-xs px-2 py-1 rounded-full flex items-center gap-1 border ${
                ev.membershipRuleEvaluated
                  ? "bg-emerald-50 text-emerald-700 border-emerald-100"
                  : "bg-gray-50 text-gray-500 border-gray-200"
              }`}
            >
              {ev.membershipRuleEvaluated ? <CheckCircle2 size={11} /> : <AlertTriangle size={11} />}
              Membership Rule {ev.membershipRuleEvaluated ? "Evaluated" : "Not Evaluated"}
            </span>
            {sodCount > 0 && (
              <span className="text-xs bg-red-50 text-red-700 border border-red-100 px-2 py-1 rounded-full flex items-center gap-1">
                <ShieldAlert size={11} />
                {sodCount} SOD violation{sodCount === 1 ? "" : "s"}
              </span>
            )}
            {result.mitigatedViolationPresent && (
              <span className="text-xs bg-amber-50 text-amber-700 border border-amber-100 px-2 py-1 rounded-full flex items-center gap-1">
                <Clock3 size={11} />
                Mitigated Violation Present
              </span>
            )}
            {ev.removeCandidates?.length > 0 && (
              <span className="text-xs bg-red-50 text-red-700 border border-red-100 px-2 py-1 rounded-full flex items-center gap-1">
                <MinusCircle size={11} />
                {ev.removeCandidates.length} to remove
              </span>
            )}
            {ev.addCandidates?.length > 0 && (
              <span className="text-xs bg-emerald-50 text-emerald-700 border border-emerald-100 px-2 py-1 rounded-full flex items-center gap-1">
                <PlusCircle size={11} />
                {ev.addCandidates.length} to add
              </span>
            )}
            {dimGaps.length > 0 && (
              <span className="text-xs bg-blue-50 text-blue-700 border border-blue-100 px-2 py-1 rounded-full flex items-center gap-1">
                <Boxes size={11} />
                {dimGaps.length} dimension{dimGaps.length === 1 ? "" : "s"} with gaps
              </span>
            )}
            {ev.missingDimensions?.length > 0 && (
              <span className="text-xs bg-amber-50 text-amber-700 border border-amber-100 px-2 py-1 rounded-full flex items-center gap-1">
                <Boxes size={11} />
                {ev.missingDimensions.length} new dimension{ev.missingDimensions.length === 1 ? "" : "s"} needed
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// A role this app itself created/flagged as Common Access, but that ISC's
// own CONFIRMED list doesn't actually show as Common Access — see server's
// getCommonAccessRoleStatus. "Flag Now" re-attempts the exact same
// POST /api/roles/:id/common-access the create flow already tries once;
// on success the row is just removed from view (the next scan will no
// longer find it as an exception at all).
function CommonAccessExceptionRow({ exception, onFixed }) {
  const flagNow = useMutation({
    mutationFn: () => enableRoleCommonAccess(exception.id),
    onSuccess: () => {
      toast.success(`"${exception.name}" flagged as Common Access`);
      onFixed(exception.id);
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  return (
    <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-gray-100">
      <div className="min-w-0">
        <p className="text-sm text-gray-900 truncate">{exception.name}</p>
        {!exception.enabled && <p className="text-xs text-gray-400">Disabled</p>}
      </div>
      <OutlineButton
        onClick={() => flagNow.mutate()}
        loading={flagNow.isPending}
        className="!w-auto !py-1.5 !px-3 !text-xs flex-shrink-0"
      >
        Flag Now
      </OutlineButton>
    </div>
  );
}

// The scan's final step (server-side: findRoleGapProposals) — for each
// Common Access role in scope, a combination of attributes with real
// members that no existing role or dimension already covers. Purely a
// proposal to review, same as everything else in this report — nothing is
// created from here.
function RoleGapProposalCard({ proposal }) {
  const navigate = useNavigate();
  return (
    <div className="border-b border-gray-100 px-4 py-4">
      <div className="flex items-start justify-between gap-2 mb-1">
        <p className="text-sm font-semibold text-gray-900">{proposal.suggestedName}</p>
        {proposal.sampleTooSmall && (
          <span className="text-[10px] font-medium text-amber-700 bg-amber-50 border border-amber-100 px-1.5 py-0.5 rounded-full flex-shrink-0">
            {proposal.memberCount} member{proposal.memberCount === 1 ? "" : "s"} — low confidence
          </span>
        )}
      </div>
      <p className="text-xs text-gray-500 mb-2">
        Under <span className="font-medium text-gray-700">{proposal.commonAccessRoleName}</span>,{" "}
        {proposal.attributes.map((a) => `${a.attrKey}="${a.value}"`).join(" and ")} — {proposal.memberCount} member
        {proposal.memberCount === 1 ? "" : "s"}, no existing role or dimension covers this combination.
      </p>
      {proposal.suggestedEntitlements.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {proposal.suggestedEntitlements.map((e) => (
            <button
              key={e.entitlementId}
              type="button"
              title={e.reason}
              onClick={() => e.entitlementId && navigate(`/entitlements/${e.entitlementId}`)}
              className="text-xs bg-emerald-50 text-emerald-700 border border-emerald-100 px-2 py-1 rounded-full flex items-center gap-1 hover:bg-emerald-100 transition-colors"
            >
              <PlusCircle size={11} />
              {e.entitlement}
            </button>
          ))}
        </div>
      ) : (
        <p className="text-xs text-gray-400">
          {proposal.sampleTooSmall ? "Too few members to estimate commonly-held entitlements." : "No commonly-held entitlements found for this group."}
        </p>
      )}
    </div>
  );
}

export function RoleEvalScanDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: scan, isLoading } = useQuery({
    queryKey: ["roleEvalScan", id],
    queryFn: () => getRoleEvalScan(id),
    refetchInterval: (query) => (query.state.data?.status === "running" ? 3000 : false),
  });

  // Common Access flag exceptions a "Flag Now" click already fixed — the
  // scan's own persisted snapshot isn't rewritten (same as every other
  // per-item action in this report), so a fixed one is just hidden from
  // this view instead; the next scan naturally won't find it anymore.
  const [fixedExceptionIds, setFixedExceptionIds] = useState(() => new Set());

  // Which result the md-and-up right-hand pane is showing. Only that layout
  // reads it — below md every result renders its own card.
  const [selectedRoleId, setSelectedRoleId] = useState(null);

  const { data: evalSettings } = useQuery({
    queryKey: ["tenant-settings"],
    queryFn: getTenantSettings,
  });

  const acceptOne = useMutation({
    mutationFn: (roleId) => acceptRoleEvalResult(id, roleId),
    onSuccess: () => {
      toast.success("Suggestions applied");
      queryClient.invalidateQueries({ queryKey: ["roleEvalScan", id] });
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const acceptAll = useMutation({
    mutationFn: () => acceptAllRoleEvalResults(id),
    onSuccess: (data) => {
      if (data.failed > 0) {
        toast.error(`Applied ${data.succeeded} of ${data.attempted} roles — ${data.failed} failed`);
      } else {
        toast.success(`Applied suggestions for ${data.succeeded} role${data.succeeded === 1 ? "" : "s"}`);
      }
      queryClient.invalidateQueries({ queryKey: ["roleEvalScan", id] });
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const cancelScan = useMutation({
    mutationFn: () => cancelRoleEvalScan(id),
    onSuccess: () => {
      toast.success("Evaluation cancelled");
      queryClient.invalidateQueries({ queryKey: ["roleEvalScan", id] });
      queryClient.invalidateQueries({ queryKey: ["roleEvalScans"] });
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  // The role currently open in the per-item detail sheet — a local mutable
  // copy of that result's evaluation, kept in sync as individual items get
  // applied (same pattern RoleDetailPage uses), separate from the read-only
  // list above. Granular actions here hit the real single-role routes
  // directly (add/remove entitlements, create dimension), same as opening
  // the role itself would — the scan's persisted snapshot isn't rewritten
  // item-by-item, only marked accepted once every suggestion is cleared.
  const [openResult, setOpenResult] = useState(null);

  const markHandled = useMutation({
    mutationFn: (roleId) => markRoleEvalResultHandled(id, roleId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["roleEvalScan", id] }),
  });

  function closeSheet() {
    if (openResult && !evaluationHasAnySuggestion(openResult.evaluation)) {
      markHandled.mutate(openResult.roleId);
    }
    setOpenResult(null);
  }

  const addEntitlements = useMutation({
    mutationFn: (entitlements) => addRoleEntitlements(openResult.roleId, entitlements),
    onSuccess: (_updatedRole, entitlements) => {
      toast.success("Entitlements added");
      const addedIds = new Set(entitlements.map((e) => e.id));
      setOpenResult((prev) =>
        prev
          ? { ...prev, evaluation: { ...prev.evaluation, addCandidates: (prev.evaluation.addCandidates || []).filter((c) => !addedIds.has(c.entitlementId)) } }
          : prev
      );
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const addDimEntitlements = useMutation({
    mutationFn: ({ dimensionId, entitlements }) => addDimensionEntitlements(openResult.roleId, dimensionId, entitlements),
    onSuccess: (_updatedDimension, { dimensionId, entitlements }) => {
      toast.success("Entitlements added");
      const addedIds = new Set(entitlements.map((e) => e.id));
      setOpenResult((prev) =>
        prev
          ? {
              ...prev,
              evaluation: {
                ...prev.evaluation,
                dimensionEvaluations: (prev.evaluation.dimensionEvaluations || []).map((d) =>
                  d.dimensionId === dimensionId
                    ? { ...d, addCandidates: d.addCandidates.filter((c) => !addedIds.has(c.entitlementId)) }
                    : d
                ),
              },
            }
          : prev
      );
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const createDimension = useMutation({
    mutationFn: ({ md, entitlements }) =>
      createRoleDimension(openResult.roleId, { name: md.value, attrKey: md.attrKey, value: md.value, entitlements }),
    onSuccess: (_newDimension, { md }) => {
      toast.success(`Dimension "${md.value}" created`);
      setOpenResult((prev) =>
        prev
          ? { ...prev, evaluation: { ...prev.evaluation, missingDimensions: (prev.evaluation.missingDimensions || []).filter((d) => d.value !== md.value) } }
          : prev
      );
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  // Same repair-then-reevaluate flow as RoleDetailPage's own Repair Role
  // action — removes the picked entitlements from wherever they actually
  // live (base role or a specific dimension) and re-runs the evaluation so
  // the sheet proves whether the violation actually cleared.
  const repairSod = useMutation({
    mutationFn: async (items) => {
      const roleId = openResult.roleId;
      const baseIds = items.filter((it) => it.origin.type === "base").map((it) => it.id);
      const byDimension = new Map();
      for (const it of items) {
        if (it.origin.type !== "dimension") continue;
        if (!byDimension.has(it.origin.dimensionId)) byDimension.set(it.origin.dimensionId, []);
        byDimension.get(it.origin.dimensionId).push(it.id);
      }
      const tasks = [];
      if (baseIds.length) tasks.push(removeRoleEntitlements(roleId, baseIds));
      for (const [dimensionId, ids] of byDimension) tasks.push(removeDimensionEntitlements(roleId, dimensionId, ids));
      await Promise.all(tasks);
      return evaluateRole(roleId);
    },
    onSuccess: (newEvaluation) => {
      setOpenResult((prev) => (prev ? { ...prev, evaluation: newEvaluation } : prev));
      const stillViolating = (newEvaluation.sodViolations?.length || 0) > 0 ||
        (newEvaluation.dimensionEvaluations || []).some((d) => (d.sodViolations || []).length > 0);
      if (stillViolating) {
        toast.error("Entitlements removed, but an SOD violation still remains");
      } else {
        toast.success("Role repaired — no SOD violations remain");
      }
      queryClient.invalidateQueries({ queryKey: ["roleEvalScan", id] });
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  // Mitigate: no removal, just records a time-limited exception server-side
  // and re-evaluates — the violation drops out of the active list for this
  // open result; the persisted scan row itself only ever notes presence
  // (see server's roleEvalResultHasMitigatedSodViolations), not full detail.
  const mitigateSod = useMutation({
    mutationFn: ({ items, expiresAt }) => applyRoleSodMitigation(openResult.roleId, { items, expiresAt, roleName: openResult.roleName }),
    onSuccess: (newEvaluation) => {
      setOpenResult((prev) => (prev ? { ...prev, evaluation: newEvaluation } : prev));
      toast.success("Mitigation applied");
      queryClient.invalidateQueries({ queryKey: ["roleEvalScan", id] });
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const removeStaleDimension = useMutation({
    mutationFn: (sd) => deleteRoleDimension(openResult.roleId, sd.dimensionId),
    onSuccess: (_result, sd) => {
      toast.success("Dimension removed");
      setOpenResult((prev) =>
        prev
          ? { ...prev, evaluation: { ...prev.evaluation, staleDimensions: (prev.evaluation.staleDimensions || []).filter((d) => d.dimensionId !== sd.dimensionId) } }
          : prev
      );
      queryClient.invalidateQueries({ queryKey: ["roleEvalScan", id] });
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const acceptAllForOpenRole = useMutation({
    mutationFn: async () => {
      const evaluation = openResult.evaluation;
      const removeIds = (evaluation.removeCandidates || []).map((c) => c.entitlementId).filter(Boolean);
      const addEnts = (evaluation.addCandidates || []).map((c) => ({ id: c.entitlementId, name: c.entitlement }));
      const tasks = [];
      if (removeIds.length || addEnts.length) {
        tasks.push(updateRoleEntitlements(openResult.roleId, { add: addEnts, remove: removeIds }));
      }
      for (const d of evaluation.dimensionEvaluations || []) {
        const dimAddEnts = (d.addCandidates || []).map((c) => ({ id: c.entitlementId, name: c.entitlement }));
        const dimRemoveIds = (d.removeCandidates || []).map((c) => c.entitlementId).filter(Boolean);
        if (dimAddEnts.length > 0 || dimRemoveIds.length > 0) {
          tasks.push(updateDimensionEntitlements(openResult.roleId, d.dimensionId, { add: dimAddEnts, remove: dimRemoveIds }));
        }
      }
      for (const md of evaluation.missingDimensions || []) {
        tasks.push(
          createRoleDimension(openResult.roleId, {
            name: md.value,
            attrKey: md.attrKey,
            value: md.value,
            entitlements: md.addCandidates.map((c) => ({ id: c.entitlementId, name: c.entitlement })),
          })
        );
      }
      await Promise.all(tasks);
    },
    onSuccess: async () => {
      toast.success("All suggestions applied");
      await markRoleEvalResultHandled(id, openResult.roleId);
      queryClient.invalidateQueries({ queryKey: ["roleEvalScan", id] });
      setOpenResult(null);
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  if (isLoading || !scan) {
    return (
      <div className="flex flex-col min-h-screen bg-white">
        <TopBar title="Role Evaluation" onBack={() => navigate("/role-mining/role-evaluation")} />
        <div className="flex-1 flex items-center justify-center"><Spinner size={24} /></div>
      </div>
    );
  }

  const meta = STATUS_META[scan.status] || STATUS_META.running;
  const StatusIcon = meta.icon;
  const results = scan.results || [];
  const acceptableCount = results.filter((r) => !r.accepted && r.hasSuggestions && !r.error).length;
  // Roles with nothing to change (and no error) are omitted from the report
  // entirely — the point of a batch review is to surface what needs
  // attention, and a long list of "no changes needed" rows just buries that.
  // Common Access roles used by this scan (see commonAccessRolesUsed below),
  // if they appear here at all, are floated to the front — processed first
  // server-side, so shown first here too.
  const commonAccessRoleIds = new Set((scan.commonAccessRolesUsed || []).map((r) => r.id));
  const reportableResults = results
    .filter((r) => r.hasSuggestions || r.hasSodViolations || r.mitigatedViolationPresent || r.error)
    .sort((a, b) => (commonAccessRoleIds.has(a.roleId) === commonAccessRoleIds.has(b.roleId) ? 0 : commonAccessRoleIds.has(a.roleId) ? -1 : 1));
  // Falls back to the first result so the wide layout's detail pane is never
  // blank, and so a selection that disappears (a still-running scan adding
  // results on refetch) degrades to the top of the list.
  const selectedResult =
    reportableResults.find((r) => r.roleId === selectedRoleId) || reportableResults[0];

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <TopBar
        title="Role Evaluation"
        onBack={() => navigate("/role-mining/role-evaluation")}
        action={
          <div className="flex items-center gap-2">
            <IconButton
              icon={Settings}
              title="Evaluation Config"
              onClick={() => navigate("/studio-settings/evaluation-config")}
            />
            <IconButton
              icon={Printer}
              title="Print this evaluation"
              onClick={() => {
                const tenant = getCredentials()?.tenant;
                if (!printRoleEvalScanPdf({ tenant, scan })) {
                  toast("Pop-up blocked — downloaded the PDF instead");
                }
              }}
            />
            {scan.status === "running" && (
              <IconButton
                icon={StopCircle}
                title="Terminate this evaluation"
                onClick={() => cancelScan.mutate()}
                loading={cancelScan.isPending}
                className="!border-red-200 !text-red-600 hover:!bg-red-50"
              />
            )}
          </div>
        }
      />
      <div className="flex-1 overflow-y-auto pb-24">
        <div className="px-4 py-4 border-b border-gray-100">
          <div className="flex items-center gap-2 mb-1">
            <StatusIcon size={16} className={meta.className} />
            <span className="text-sm font-medium text-gray-900">{meta.label}</span>
          </div>
          <p className="text-xs text-gray-500">
            {scan.tenant ? `${scan.tenant} — ` : ""}Started {new Date(scan.startedAt).toLocaleString()}
          </p>
          {scan.error && <p className="text-xs text-red-600 mt-1">{scan.error}</p>}
          {scan.commonAccessExclusionFailed && (
            <p className="text-xs text-amber-600 mt-1">
              Couldn't fetch common-access entitlements for this scan — roles may be flagged as
              missing access a common-access role already grants them. Re-run the scan to retry.
            </p>
          )}
          <p className="text-xs text-gray-400 mt-2">
            {scan.scopeRoleIds?.length > 0
              ? `Scope: ${scan.scopeRoleIds.length} explicitly selected role${scan.scopeRoleIds.length === 1 ? "" : "s"}`
              : <>Search: {scan.scopeQuery ? <span className="font-mono">{scan.scopeQuery}</span> : "(none — every role)"}</>}
          </p>
          {scan.commonAccessRolesUsed?.length > 0 && (
            <p className="text-xs text-gray-400 mt-1">
              Common Access Role{scan.commonAccessRolesUsed.length === 1 ? "" : "s"} in scope:{" "}
              <span className="font-medium text-gray-600">{scan.commonAccessRolesUsed.map((r) => r.name).join(", ")}</span>
            </p>
          )}
          <div className="flex items-center gap-4 mt-2">
            <p className="text-xs text-gray-400">
              {scan.scanned}{scan.totalRoles ? ` of ${scan.totalRoles}` : ""} role{(scan.totalRoles || scan.scanned) === 1 ? "" : "s"} evaluated
            </p>
            <p className="text-xs text-gray-400">
              {results.filter((r) => r.hasSuggestions).length} with suggestions
            </p>
            {results.filter((r) => r.hasSodViolations).length > 0 && (
              <p className="text-xs text-red-600 font-medium">
                {results.filter((r) => r.hasSodViolations).length} with SOD violations
              </p>
            )}
          </div>
          {acceptableCount > 0 && (
            <PrimaryButton onClick={() => acceptAll.mutate()} loading={acceptAll.isPending} className="mt-3">
              <CheckCheck size={16} />
              Accept All ({acceptableCount})
            </PrimaryButton>
          )}
        </div>

        {results.length === 0 && scan.status === "completed" ? (
          <EmptyState icon={ClipboardCheck} title="No roles found" subtitle="This tenant has no roles to evaluate" />
        ) : reportableResults.length === 0 && scan.status === "completed" ? (
          <EmptyState
            icon={CheckCircle2}
            title="No changes needed"
            subtitle={`All ${results.length} role${results.length === 1 ? "" : "s"} evaluated cleanly`}
          />
        ) : (
          <ScanMasterDetail
            listTitle={`Roles (${reportableResults.length})`}
            single={reportableResults.map((r) => (
              <div key={r.roleId} className="border-b border-gray-100">
                <RoleResultCard
                  result={r}
                  onOpen={() => setOpenResult({ roleId: r.roleId, roleName: r.roleName, evaluation: r.evaluation })}
                  onAccept={() => acceptOne.mutate(r.roleId)}
                  acceptPending={acceptOne.isPending && acceptOne.variables === r.roleId}
                />
              </div>
            ))}
            list={reportableResults.map((r) => (
              <ScanListRow
                key={r.roleId}
                active={selectedResult?.roleId === r.roleId}
                onClick={() => setSelectedRoleId(r.roleId)}
                icon={roleResultMeta(r).icon}
                iconClass={roleResultMeta(r).className}
                title={r.roleName}
                subtitle={roleResultSummary(r)}
                tag={
                  r.accepted
                    ? "Applied"
                    : commonAccessRoleIds.has(r.roleId)
                      ? "Common Access"
                      : r.dimensional
                        ? "Dynamic"
                        : null
                }
              />
            ))}
            detail={
              selectedResult && (
                <RoleResultCard
                  key={selectedResult.roleId}
                  result={selectedResult}
                  onOpen={() =>
                    setOpenResult({
                      roleId: selectedResult.roleId,
                      roleName: selectedResult.roleName,
                      evaluation: selectedResult.evaluation,
                    })
                  }
                  onAccept={() => acceptOne.mutate(selectedResult.roleId)}
                  acceptPending={acceptOne.isPending && acceptOne.variables === selectedResult.roleId}
                />
              )
            }
          />
        )}

        {scan.status === "completed" && (scan.newRoleProposals?.length > 0 || scan.roleGapCheckError) && (
          <div className="mt-2">
            <div className="px-4 py-2 flex items-center gap-2">
              <Sparkles size={14} className="text-gray-400" />
              <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                Suggested New Roles
              </h3>
            </div>
            <p className="px-4 pb-2 text-xs text-gray-500">
              Combinations of attributes found within a Common Access role's own population that no
              existing role or dimension covers yet — proposed here, nothing is created automatically.
            </p>
            {scan.roleGapCheckError ? (
              <div className="px-4 pb-2"><ErrorBox message={scan.roleGapCheckError} /></div>
            ) : (
              scan.newRoleProposals.map((p, i) => <RoleGapProposalCard key={`${p.commonAccessRoleId}-${i}`} proposal={p} />)
            )}
          </div>
        )}

        {scan.status === "completed" &&
          (scan.commonAccessFlagExceptions || []).filter((e) => !fixedExceptionIds.has(e.id)).length > 0 && (
            <div className="mt-2">
              <div className="px-4 py-2 flex items-center gap-2">
                <BadgeAlert size={14} className="text-amber-500" />
                <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                  Common Access Not Confirmed in ISC
                </h3>
              </div>
              <p className="px-4 pb-2 text-xs text-gray-500">
                These roles were created or flagged as Common Access by this app, but ISC's own
                {scan.commonAccessFlagCheckBetaUnavailable
                  ? " Common Access confirmation list couldn't be reached, so this may just mean ISC hasn't confirmed them yet"
                  : " Common Access list doesn't show them as confirmed"}
                . Click Flag Now to re-attempt it.
              </p>
              {scan.commonAccessFlagExceptions
                .filter((e) => !fixedExceptionIds.has(e.id))
                .map((exception) => (
                  <CommonAccessExceptionRow
                    key={exception.id}
                    exception={exception}
                    onFixed={(fixedId) => setFixedExceptionIds((prev) => new Set(prev).add(fixedId))}
                  />
                ))}
            </div>
        )}
      </div>

      {openResult && (
        <EvaluationSheet
          result={openResult.evaluation}
          title={openResult.roleName}
          onClose={closeSheet}
          onAddSelected={(entitlements) => addEntitlements.mutate(entitlements)}
          addPending={addEntitlements.isPending}
          onAddDimensionSelected={(dimensionId, entitlements) => addDimEntitlements.mutate({ dimensionId, entitlements })}
          addDimPending={addDimEntitlements.isPending ? addDimEntitlements.variables?.dimensionId : null}
          onCreateDimension={(md, entitlements) => createDimension.mutate({ md, entitlements })}
          createDimensionPending={createDimension.isPending ? createDimension.variables?.md?.value : null}
          onAcceptAll={() => acceptAllForOpenRole.mutate()}
          acceptAllPending={acceptAllForOpenRole.isPending}
          onRepairSod={(items) => repairSod.mutateAsync(items)}
          repairPending={repairSod.isPending}
          onMitigateSod={evalSettings?.allowSodMitigations === false ? null : (payload) => mitigateSod.mutateAsync(payload)}
          mitigatePending={mitigateSod.isPending}
          onRemoveDimension={(sd) => removeStaleDimension.mutate(sd)}
          removeDimensionPending={removeStaleDimension.isPending ? removeStaleDimension.variables?.dimensionId : null}
        />
      )}
    </div>
  );
}

export default function RoleEvaluationPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // Ad-hoc search for this one scan — which roles to evaluate — not a
  // persisted setting. Simple name-contains, same as Role Descriptions/
  // Role Rename's own search, not a raw ISC Search query.
  const [roleSearch, setRoleSearch] = useState("");

  // Start runs immediately — no Common Access prompt. Each role is
  // evaluated against the Common Access roles its membership rule overlaps
  // (the server's criteria-subset matching), and the scan detects which of
  // its roles ARE Common Access on its own, which keeps the Accept cascade
  // (additions accepted onto a Common Access role come off the roles it
  // covers) working without anyone having to pick them.
  const evalScan = useMutation({
    mutationFn: () => startRoleEvalScan(roleSearch.trim()),
    onSuccess: ({ scanId }) => {
      toast.success("Role evaluation started — check back here for results.");
      queryClient.invalidateQueries({ queryKey: ["roleEvalScans"] });
      navigate(`/role-mining/role-eval-scans/${scanId}`);
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const { data: pastScans = [], error: listError } = useQuery({
    queryKey: ["roleEvalScans"],
    queryFn: listRoleEvalScans,
    refetchInterval: (query) => (query.state.data?.some((s) => s.status === "running") ? 4000 : 15000),
  });

  // Shown up top so it's obvious what a scan started right now would
  // actually use — same tenant settings Evaluation Config edits, just
  // read-only here.
  const { data: evalSettings } = useQuery({
    queryKey: ["tenant-settings"],
    queryFn: getTenantSettings,
  });

  const cancelMutation = useMutation({
    mutationFn: (scanId) => cancelRoleEvalScan(scanId),
    onSuccess: () => {
      toast.success("Scan cancelled");
      queryClient.invalidateQueries({ queryKey: ["roleEvalScans"] });
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const removeMutation = useMutation({
    mutationFn: (scanId) => deleteRoleEvalScan(scanId),
    onSuccess: () => {
      toast.success("Scan removed");
      queryClient.invalidateQueries({ queryKey: ["roleEvalScans"] });
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <TopBar
        title={<RoleMiningTitleMenu active="Role Evaluation" />}
        action={
          <IconButton
            icon={Settings}
            title="Evaluation Config"
            onClick={() => navigate("/studio-settings/evaluation-config")}
          />
        }
      />
      <div className="flex-1 overflow-y-auto pb-24">
        <div className="px-4 py-5 border-b border-gray-100">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-full bg-violet-50 flex items-center justify-center flex-shrink-0">
              <ClipboardCheck size={18} className="text-violet-600" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-gray-900">Role Evaluation</h2>
              <p className="text-xs text-gray-500 mt-0.5">
                Loops through existing roles and evaluates them for stale, missing, or
                dimension-related access gaps.
              </p>
            </div>
          </div>
          {listError && <ErrorBox message={listError.message} />}
          <Field label="Search (optional) — limits this scan to roles whose name matches">
            <Input
              value={roleSearch}
              onChange={(e) => setRoleSearch(e.target.value)}
              placeholder="e.g. Accounting"
              disabled={evalScan.isPending}
            />
          </Field>
          <OutlineButton onClick={() => evalScan.mutate()} loading={evalScan.isPending}>
            <Layers size={16} />
            {roleSearch.trim() ? "Evaluate Matching Roles" : "Evaluate All Roles"}
          </OutlineButton>

          {evalSettings && (
            <div className="mt-3 border border-gray-100 rounded-xl px-3 py-2.5 text-xs text-gray-500 space-y-1">
              <p>
                Consider Common Roles:{" "}
                <span className={evalSettings.considerCommonRoles ? "text-emerald-700 font-medium" : "text-gray-700 font-medium"}>
                  {evalSettings.considerCommonRoles ? "On" : "Off"}
                </span>
                {" · "}
                Check for SOD Violations:{" "}
                <span className={evalSettings.checkSodViolations ? "text-emerald-700 font-medium" : "text-gray-700 font-medium"}>
                  {evalSettings.checkSodViolations ? "On" : "Off"}
                </span>
              </p>
            </div>
          )}
        </div>

        {pastScans.length > 0 && (
          <div className="mt-2">
            <div className="px-4 py-2 flex items-center gap-2">
              <Clock size={14} className="text-gray-400" />
              <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Past Evaluations</h3>
            </div>
            {pastScans.map((s) => (
              <ScanListItem
                key={s.id}
                scan={s}
                onOpen={() => navigate(`/role-mining/role-eval-scans/${s.id}`)}
                onCancel={() => cancelMutation.mutate(s.id)}
                cancelPending={cancelMutation.isPending}
                onRemove={() => removeMutation.mutate(s.id)}
                removePending={removeMutation.isPending}
                detail={`${s.scanned}${s.totalRoles ? ` of ${s.totalRoles}` : ""} role${(s.totalRoles || s.scanned) === 1 ? "" : "s"} evaluated · ${s.suggestionCount} with suggestions`}
              />
            ))}
          </div>
        )}
      </div>

    </div>
  );
}
