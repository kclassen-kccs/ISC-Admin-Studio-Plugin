import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Sparkles, PlusCircle, MinusCircle, Boxes, CheckCheck, ShieldAlert, ShieldCheck, Wrench, Clock3, Copy, Users, Trash2, Tags } from "lucide-react";
import { IconButton, OutlineButton, PrimaryButton, Field, Input, Spinner, EmptyState } from "./ui";

// A stable key for one conflicting entitlement's specific location — the
// same entitlement id can appear as a base-role grant on one role and a
// dimension grant on another, so id alone isn't unique enough to dedupe or
// select against.
function sodItemKey(item) {
  return item.origin.type === "dimension" ? `dim:${item.origin.dimensionId}:${item.id}` : `base:${item.id}`;
}

// Flattens every conflicting entitlement out of a role's SOD violations
// (base-level and per-dimension) into one deduplicated list — the same
// entitlement can be the trigger for more than one policy, so this also
// tracks which policy name(s) each one is implicated in for display.
function collectSodConflictingEntitlements(result) {
  const map = new Map();
  const addFrom = (violations) => {
    for (const v of violations) {
      for (const item of [...v.leftEntitlements, ...v.rightEntitlements]) {
        const key = sodItemKey(item);
        if (!map.has(key)) map.set(key, { ...item, key, policies: new Set() });
        map.get(key).policies.add(v.policyName);
      }
    }
  };
  addFrom(result.sodViolations || []);
  for (const d of result.dimensionEvaluations || []) addFrom(d.sodViolations || []);
  return [...map.values()].map((e) => ({ ...e, policies: [...e.policies] }));
}

// One row per (policy, location) violation occurrence — mitigation is
// applied at this granularity (see server's splitMitigatedSodViolations),
// not per conflicting entitlement, since a policy conflict is one finding
// even though it can list several entitlements on each side.
function collectSodViolatedPolicies(result) {
  const rows = [];
  for (const v of result.sodViolations || []) {
    rows.push({ key: `base:${v.policyId}`, policyId: v.policyId, policyName: v.policyName, origin: { type: "base" } });
  }
  for (const d of result.dimensionEvaluations || []) {
    for (const v of d.sodViolations || []) {
      rows.push({
        key: `dim:${d.dimensionId}:${v.policyId}`,
        policyId: v.policyId,
        policyName: v.policyName,
        origin: { type: "dimension", dimensionId: d.dimensionId, dimensionName: d.dimensionName },
      });
    }
  }
  return rows;
}

// Add-candidates carry a resolved "source" alongside "entitlement" (see
// server's evaluateRoleAlgorithmic) so the same entitlement name from two
// different sources isn't ambiguous — grouping by source disambiguates
// without needing a "source:name" prefix on every row. Candidates without a
// resolved source (older persisted scans) fall into "Other".
function groupCandidatesBySource(candidates) {
  const map = new Map();
  for (const c of candidates || []) {
    const key = c.source || "Other";
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(c);
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

// "Repair Role" modal — lists every entitlement implicated in any SOD
// violation (across the base role and all dimensions) with a checkbox, and
// removes whichever ones are selected. Re-evaluation happens in the parent
// (onRepair resolves once the removal + re-evaluate round-trip completes),
// so this just reflects pending/closed state rather than owning the result.
function SodRepairSheet({ items, policyRows, onClose, onRepair, repairPending, onMitigate, mitigatePending }) {
  const [selected, setSelected] = useState(new Set());
  const [mitigateSelected, setMitigateSelected] = useState(new Set());
  const [mitigateUntil, setMitigateUntil] = useState("");

  const toggle = (key) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const toggleAll = () => {
    setSelected((prev) => (prev.size === items.length ? new Set() : new Set(items.map((it) => it.key))));
  };

  const toggleMitigate = (key) => {
    setMitigateSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const toggleAllMitigate = () => {
    setMitigateSelected((prev) => (prev.size === policyRows.length ? new Set() : new Set(policyRows.map((r) => r.key))));
  };
  const todayStr = new Date().toISOString().slice(0, 10);

  return (
    <div
      className="fixed inset-0 bg-black/40 z-40 flex items-end md:items-center justify-center"
      onClick={(e) => e.target === e.currentTarget && !repairPending && onClose()}
    >
      <div className="bg-white w-full max-w-lg md:mx-4 rounded-t-2xl md:rounded-2xl shadow-xl p-5 max-h-[85vh] overflow-y-auto">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-10 h-10 rounded-full bg-red-50 flex items-center justify-center flex-shrink-0">
            <Wrench size={18} className="text-red-600" />
          </div>
          <h2 className="text-base font-semibold text-gray-900">Repair Role</h2>
        </div>
        <p className="text-sm text-gray-600 mb-4">
          Select any of the conflicting entitlements below to remove. Removing either side of a
          conflict clears the violation.
        </p>

        <label className="flex items-center gap-2 cursor-pointer mb-2">
          <input
            type="checkbox"
            checked={items.length > 0 && selected.size === items.length}
            onChange={toggleAll}
            className="w-4 h-4 rounded border-gray-300 accent-blue-600"
          />
          <span className="text-xs text-gray-400">Select all</span>
        </label>

        <div className="space-y-2 mb-4">
          {items.map((it) => (
            <label
              key={it.key}
              className="flex items-start gap-2 bg-red-50 border border-red-100 rounded-lg px-3 py-2 cursor-pointer"
            >
              <input
                type="checkbox"
                checked={selected.has(it.key)}
                onChange={() => toggle(it.key)}
                className="w-4 h-4 rounded border-gray-300 accent-blue-600 mt-0.5 flex-shrink-0"
              />
              <div className="min-w-0">
                <p className="text-sm font-medium text-gray-900">{it.name}</p>
                <p className="text-xs text-gray-500 mt-0.5">
                  {it.origin.type === "dimension" ? `${it.origin.dimensionName} dimension` : "Base role"}
                </p>
                <p className="text-xs text-gray-600 mt-0.5">Conflicts via: {it.policies.join(", ")}</p>
              </div>
            </label>
          ))}
        </div>

        <div className="flex gap-2 mb-5">
          <PrimaryButton
            onClick={() => onRepair(items.filter((it) => selected.has(it.key)))}
            loading={repairPending}
            disabled={selected.size === 0}
            className="!w-auto flex-1 !bg-red-600 hover:!bg-red-700"
          >
            <Wrench size={16} />
            Remove selected ({selected.size})
          </PrimaryButton>
          <OutlineButton onClick={onClose} disabled={repairPending} className="!w-auto flex-1">
            Cancel
          </OutlineButton>
        </div>

        {onMitigate && (
          <div className="border-t border-gray-100 pt-4">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2 flex items-center gap-1.5">
              <Clock3 size={13} className="text-amber-600" />
              Or, mitigate for a period of time
            </p>
            <p className="text-sm text-gray-600 mb-3">
              Accept the risk without removing anything. A mitigated violation stops being flagged
              as active until it expires — the scan file just notes a mitigated violation is present.
            </p>

            <label className="flex items-center gap-2 cursor-pointer mb-2">
              <input
                type="checkbox"
                checked={policyRows.length > 0 && mitigateSelected.size === policyRows.length}
                onChange={toggleAllMitigate}
                className="w-4 h-4 rounded border-gray-300 accent-amber-600"
              />
              <span className="text-xs text-gray-400">Select all</span>
            </label>

            <div className="space-y-2 mb-3">
              {policyRows.map((row) => (
                <label
                  key={row.key}
                  className="flex items-start gap-2 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2 cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={mitigateSelected.has(row.key)}
                    onChange={() => toggleMitigate(row.key)}
                    className="w-4 h-4 rounded border-gray-300 accent-amber-600 mt-0.5 flex-shrink-0"
                  />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-900">{row.policyName}</p>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {row.origin.type === "dimension" ? `${row.origin.dimensionName} dimension` : "Base role"}
                    </p>
                  </div>
                </label>
              ))}
            </div>

            <Field label="Mitigated until">
              <Input
                type="date"
                min={todayStr}
                value={mitigateUntil}
                onChange={(e) => setMitigateUntil(e.target.value)}
              />
            </Field>

            <PrimaryButton
              onClick={() =>
                onMitigate({
                  items: policyRows
                    .filter((r) => mitigateSelected.has(r.key))
                    .map((r) => ({
                      policyId: r.policyId,
                      policyName: r.policyName,
                      dimensionId: r.origin.type === "dimension" ? r.origin.dimensionId : null,
                      dimensionName: r.origin.type === "dimension" ? r.origin.dimensionName : null,
                    })),
                  expiresAt: mitigateUntil,
                })
              }
              loading={mitigatePending}
              disabled={mitigateSelected.size === 0 || !mitigateUntil}
              className="!w-auto !bg-amber-600 hover:!bg-amber-700"
            >
              <Clock3 size={16} />
              Mitigate selected ({mitigateSelected.size})
            </PrimaryButton>
          </div>
        )}
      </div>
    </div>
  );
}

// Selectable "possibly missing entitlements" block: a select-all checkbox
// next to the title, per-row checkboxes, and an Add-selected icon that
// only appears once something is checked. Used for both a role's own add
// candidates and each dimension's own add candidates.
function AddCandidatesBlock({ title, candidates, onAddSelected, addPending }) {
  const [selected, setSelected] = useState(new Set());

  const toggle = (entId) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(entId)) next.delete(entId);
      else next.add(entId);
      return next;
    });
  };
  const toggleAll = () => {
    setSelected((prev) =>
      prev.size === candidates.length ? new Set() : new Set(candidates.map((c) => c.entitlementId))
    );
  };

  return (
    <div className="mb-4">
      <div className="flex items-center justify-between mb-2">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={candidates.length > 0 && selected.size === candidates.length}
            onChange={toggleAll}
            className="w-4 h-4 rounded border-gray-300 accent-blue-600"
          />
          <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide flex items-center gap-1.5">
            <PlusCircle size={13} className="text-emerald-500" />
            {title}
          </span>
        </label>
        {selected.size > 0 && (
          <IconButton
            icon={PlusCircle}
            title={`Add selected (${selected.size})`}
            onClick={() =>
              onAddSelected(
                candidates
                  .filter((c) => selected.has(c.entitlementId))
                  .map((c) => ({ id: c.entitlementId, name: c.entitlement }))
              )
            }
            loading={addPending}
            className="!w-7 !h-7 !border-emerald-200 !text-emerald-600 hover:!bg-emerald-50"
          />
        )}
      </div>
      <div className="space-y-3">
        {groupCandidatesBySource(candidates).map(([source, ents]) => (
          <div key={source}>
            <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-1">{source}</p>
            <div className="space-y-2">
              {ents.map((c) => (
                <label
                  key={c.entitlementId}
                  className="flex items-start gap-2 bg-emerald-50 border border-emerald-100 rounded-lg px-3 py-2 cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(c.entitlementId)}
                    onChange={() => toggle(c.entitlementId)}
                    className="w-4 h-4 rounded border-gray-300 accent-blue-600 mt-0.5 flex-shrink-0"
                  />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-900">{c.entitlement}</p>
                    <p className="text-xs text-gray-600 mt-0.5">{c.reason}</p>
                  </div>
                </label>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// An existing dimension whose current members number zero — purely a
// membership-validity finding (see server's staleDimensions), never
// proposed just because the dimension has no uniquely-held entitlements of
// its own. Removal is a single explicit action, not folded into "Accept
// all" alongside everything else.
function StaleDimensionBlock({ sd, onRemove, pending }) {
  return (
    <div className="mb-4 border border-red-200 rounded-lg p-3 bg-red-50/40">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <Boxes size={13} className="text-red-600 flex-shrink-0" />
          <span className="text-xs font-semibold text-gray-700 truncate">{sd.dimensionName}</span>
        </div>
        <IconButton
          icon={Trash2}
          title="Remove this dimension"
          onClick={() => onRemove(sd)}
          loading={pending}
          className="!w-7 !h-7 !border-red-300 !text-red-700 hover:!bg-red-100 flex-shrink-0"
        />
      </div>
      <p className="text-xs text-gray-500 mt-1">{sd.reason}</p>
    </div>
  );
}

// A distinct-attribute-value group found among a dynamic role's current
// members that isn't covered by any existing dimension — offers the same
// select-one-or-all entitlement picker as AddCandidatesBlock, but the
// action creates a brand new dimension (scoped to attrKey=value) seeded
// with whichever entitlements are checked, rather than patching something
// that already exists.
function MissingDimensionBlock({ md, onCreate, pending }) {
  const candidates = md.addCandidates;
  const [selected, setSelected] = useState(new Set());

  const toggle = (entId) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(entId)) next.delete(entId);
      else next.add(entId);
      return next;
    });
  };
  const toggleAll = () => {
    setSelected((prev) =>
      prev.size === candidates.length ? new Set() : new Set(candidates.map((c) => c.entitlementId))
    );
  };

  return (
    <div className="mb-4 border border-amber-200 rounded-lg p-3 bg-amber-50/40">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5">
          <Boxes size={13} className="text-amber-600" />
          <span className="text-xs font-semibold text-gray-700">
            New dimension may be needed: {md.attrKey} = "{md.value}"
          </span>
        </div>
        <IconButton
          icon={Boxes}
          title={candidates.length > 0 ? `Create dimension with selected (${selected.size})` : "Create dimension"}
          onClick={() =>
            onCreate(
              candidates.filter((c) => selected.has(c.entitlementId)).map((c) => ({ id: c.entitlementId, name: c.entitlement }))
            )
          }
          loading={pending}
          className="!w-7 !h-7 !border-amber-300 !text-amber-700 hover:!bg-amber-100"
        />
      </div>
      <p className="text-xs text-gray-500 mb-2">
        {md.memberCount} current member{md.memberCount === 1 ? "" : "s"} match this value but no existing dimension covers it.
      </p>
      {candidates.length > 0 ? (
        <>
          <label className="flex items-center gap-2 cursor-pointer mb-1.5">
            <input
              type="checkbox"
              checked={selected.size === candidates.length}
              onChange={toggleAll}
              className="w-3.5 h-3.5 rounded border-gray-300 accent-blue-600"
            />
            <span className="text-xs text-gray-400">Select all entitlements to include</span>
          </label>
          <div className="space-y-3">
            {groupCandidatesBySource(candidates).map(([source, ents]) => (
              <div key={source}>
                <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-1">{source}</p>
                <div className="space-y-2">
                  {ents.map((c) => (
                    <label
                      key={c.entitlementId}
                      className="flex items-start gap-2 bg-white border border-gray-100 rounded-lg px-3 py-2 cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={selected.has(c.entitlementId)}
                        onChange={() => toggle(c.entitlementId)}
                        className="w-4 h-4 rounded border-gray-300 accent-blue-600 mt-0.5 flex-shrink-0"
                      />
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-gray-900">{c.entitlement}</p>
                        <p className="text-xs text-gray-600 mt-0.5">{c.reason}</p>
                      </div>
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </>
      ) : (
        <p className="text-xs text-gray-400">No commonly-held entitlements found for this group yet.</p>
      )}
    </div>
  );
}

// Full detail view for a single role's evaluation result: summary, member
// count, and a selectable (one or all) breakdown of every suggestion —
// stale entitlements to remove, missing ones to add (base role and each
// dimension), and dimensions that may need to be created. Used both from
// Role Detail's "Evaluate this Role" action and from the Role Evaluation
// batch scan report, so the two never present different capabilities for
// the same underlying data.
// The evaluation's segment-metadata check (see ensureRoleSegmentMetadata on
// the server): it FIXES what it finds, so this reports what was already in
// order and what it just tagged or created, rather than offering an action.
function SegmentMetadataBlock({ check }) {
  if (!check) return null;
  if (check.error && check.values.length === 0) {
    return (
      <div className="mb-4 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
        <p className="text-xs font-medium text-red-700">Segment metadata ({check.key}) check failed: {check.error}</p>
      </div>
    );
  }
  const fixed = check.values.some((v) => v.valueCreated || v.roleTagged || v.entitlementsTagged.length > 0);
  return (
    <div className={`mb-4 rounded-lg px-3 py-2 border ${check.error ? "bg-red-50 border-red-200" : fixed ? "bg-blue-50 border-blue-100" : "bg-emerald-50 border-emerald-100"}`}>
      {check.values.map((v) => {
        const notes = [];
        if (v.valueCreated) notes.push(`value created on ${check.key}`);
        if (v.roleTagged) notes.push("role tagged");
        if (v.entitlementsTagged.length > 0) notes.push(`${v.entitlementsTagged.length} of ${v.entitlementsChecked} entitlement${v.entitlementsChecked === 1 ? "" : "s"} tagged`);
        return (
          <div key={v.value} className="mb-1 last:mb-0">
            <p className={`text-xs font-medium flex items-center gap-2 ${fixed ? "text-blue-800" : "text-emerald-800"}`}>
              <Tags size={14} className="flex-shrink-0" />
              {check.key}: {v.name}
              {notes.length > 0
                ? ` — ${notes.join(", ")}`
                : ` — role and all ${v.entitlementsChecked} entitlement${v.entitlementsChecked === 1 ? "" : "s"} tagged`}
            </p>
            {v.entitlementsTagged.length > 0 && (
              <p className="text-xs text-blue-700 mt-0.5 pl-5 break-words">{v.entitlementsTagged.map((e) => e.name).join(", ")}</p>
            )}
          </div>
        );
      })}
      {check.error && <p className="text-xs text-red-700 mt-1">Stopped early: {check.error}</p>}
    </div>
  );
}

export function EvaluationSheet({
  result, title = "Role evaluation", onClose, onAddSelected, addPending, onAddDimensionSelected, addDimPending,
  onCreateDimension, createDimensionPending, onAcceptAll, acceptAllPending, onRepairSod, repairPending,
  onMitigateSod, mitigatePending, onRemoveDimension, removeDimensionPending,
}) {
  const navigate = useNavigate();
  const [repairOpen, setRepairOpen] = useState(false);
  const addCandidates = result.addCandidates || [];
  const dimensionEvaluations = (result.dimensionEvaluations || []).filter((d) => d.addCandidates.length > 0);
  const dimensionRedundancies = (result.dimensionEvaluations || []).filter((d) => (d.removeCandidates || []).length > 0);
  const missingDimensions = result.missingDimensions || [];
  const staleDimensions = result.staleDimensions || [];
  const sodViolations = result.sodViolations || [];
  const dimensionSodViolations = (result.dimensionEvaluations || []).filter((d) => (d.sodViolations || []).length > 0);
  const hasSodViolations = sodViolations.length > 0 || dimensionSodViolations.length > 0;
  const mitigatedSodCount = (result.mitigatedSodViolations?.length || 0) +
    (result.dimensionEvaluations || []).reduce((n, d) => n + (d.mitigatedSodViolations?.length || 0), 0);
  const sodRepairItems = hasSodViolations ? collectSodConflictingEntitlements(result) : [];
  const sodPolicyRows = hasSodViolations ? collectSodViolatedPolicies(result) : [];
  // SOD violations are shown but never actionable via Accept all — there's
  // no safe automated fix for a policy conflict, so they don't count toward
  // whether the Accept all button appears. Repairing them is its own
  // separate flow (the Repair Role button below).
  const hasAnySuggestion =
    (result.removeCandidates?.length || 0) > 0 ||
    addCandidates.length > 0 ||
    dimensionEvaluations.length > 0 ||
    dimensionRedundancies.length > 0 ||
    missingDimensions.length > 0;
  const hasAnyFinding = hasAnySuggestion || hasSodViolations ||
    (result.overlappingCommonAccessRoles?.length || 0) > 0 || staleDimensions.length > 0;

  return (
    <div
      className="fixed inset-0 bg-black/30 z-30 flex items-end md:items-center justify-center"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-white w-full max-w-lg md:mx-4 rounded-t-2xl md:rounded-2xl shadow-xl p-5 max-h-[85vh] overflow-y-auto">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-10 h-10 rounded-full bg-violet-50 flex items-center justify-center flex-shrink-0">
            <Sparkles size={18} className="text-violet-600" />
          </div>
          <h2 className="text-base font-semibold text-gray-900 truncate">{title}</h2>
        </div>

        <p className="text-sm text-gray-700 leading-relaxed mb-4">{result.summary}</p>

        <div className="mb-4">
          <span
            className={`text-xs px-2 py-1 rounded-full inline-flex items-center gap-1 border ${
              result.membershipRuleEvaluated
                ? "bg-emerald-50 text-emerald-700 border-emerald-100"
                : "bg-gray-50 text-gray-500 border-gray-200"
            }`}
          >
            {result.membershipRuleEvaluated ? <ShieldCheck size={11} /> : <ShieldAlert size={11} />}
            Membership Rule {result.membershipRuleEvaluated ? "Evaluated" : "Not Evaluated"}
          </span>
        </div>

        {result.memberProfile && (
          <p className="text-xs text-gray-400 mb-4">
            Based on {result.memberProfile.memberCount} current member{result.memberProfile.memberCount === 1 ? "" : "s"}
            {result.memberProfile.partial ? ` (sampled from ${result.memberProfile.totalScanned}+ identities scanned)` : ""}.
            {result.memberProfile.sampleTooSmall && (
              <span className="block text-amber-600 mt-1">
                Too few members to reliably compare access — commonly/rarely-held checks were skipped.
              </span>
            )}
          </p>
        )}

        {!hasSodViolations && (
          <div className="mb-4 bg-emerald-50 border border-emerald-100 rounded-lg px-3 py-2 flex items-center gap-2">
            <ShieldCheck size={14} className="text-emerald-600 flex-shrink-0" />
            <p className="text-xs font-medium text-emerald-800">No SOD violations detected.</p>
          </div>
        )}

        <SegmentMetadataBlock check={result.segmentMetadata} />

        {mitigatedSodCount > 0 && (
          <button
            onClick={() => navigate("/studio-settings/evaluation-config", { state: { openManageMitigations: true } })}
            className="w-full mb-4 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2 flex items-center gap-2 hover:bg-amber-100 transition-colors text-left"
          >
            <Clock3 size={14} className="text-amber-600 flex-shrink-0" />
            <p className="text-xs font-medium text-amber-800 underline underline-offset-2">
              Mitigated Violation Present ({mitigatedSodCount})
            </p>
          </button>
        )}

        {(result.overlappingCommonAccessRoles?.length || 0) > 0 && (
          <div className="mb-4 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
            <p className="text-xs font-semibold text-amber-800 flex items-center gap-1.5 mb-1.5">
              <Copy size={13} className="text-amber-600" />
              Potential duplicate common roles
            </p>
            <p className="text-xs text-amber-700 mb-1.5">
              These active common-access roles have a membership rule that overlaps with this role's — worth reviewing for consolidation.
            </p>
            <div className="space-y-1">
              {result.overlappingCommonAccessRoles.map((r) => (
                <p key={r.id} className="text-sm text-gray-900">{r.name}</p>
              ))}
            </div>
          </div>
        )}

        {sodViolations.length > 0 && (
          <div className="mb-4">
            <p className="text-xs font-semibold text-red-600 uppercase tracking-wide mb-2 flex items-center gap-1.5">
              <ShieldAlert size={13} className="text-red-600" />
              SOD policy violations — base role
            </p>
            <div className="space-y-2">
              {sodViolations.map((v) => (
                <div key={v.policyId} className="bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                  <p className="text-sm font-medium text-gray-900">{v.policyName}</p>
                  <div className="text-xs text-gray-600 mt-0.5">
                    {v.leftEntitlements.map((e) => <div key={e.id}>{e.name}</div>)}
                    <div className="text-gray-400 my-0.5">conflicts with</div>
                    {v.rightEntitlements.map((e) => <div key={e.id}>{e.name}</div>)}
                  </div>
                  {v.state !== "ENFORCED" && (
                    <p className="text-[11px] text-gray-400 mt-0.5">Policy state: {v.state}</p>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {dimensionSodViolations.map((d) => (
          <div key={`${d.dimensionId}-sod`} className="mb-4">
            <p className="text-xs font-semibold text-red-600 uppercase tracking-wide mb-2 flex items-center gap-1.5">
              <ShieldAlert size={13} className="text-red-600" />
              SOD policy violations — {d.dimensionName} dimension
            </p>
            <div className="space-y-2">
              {d.sodViolations.map((v) => (
                <div key={v.policyId} className="bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                  <p className="text-sm font-medium text-gray-900">{v.policyName}</p>
                  <div className="text-xs text-gray-600 mt-0.5">
                    {v.leftEntitlements.map((e) => <div key={e.id}>{e.name}</div>)}
                    <div className="text-gray-400 my-0.5">conflicts with</div>
                    {v.rightEntitlements.map((e) => <div key={e.id}>{e.name}</div>)}
                  </div>
                  {v.state !== "ENFORCED" && (
                    <p className="text-[11px] text-gray-400 mt-0.5">Policy state: {v.state}</p>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}

        {hasSodViolations && onRepairSod && (
          <OutlineButton onClick={() => setRepairOpen(true)} className="!w-auto !border-red-200 !text-red-600 hover:!bg-red-50 mb-4">
            <Wrench size={16} />
            Repair Role
          </OutlineButton>
        )}

        {result.removeCandidates?.length > 0 && (
          <div className="mb-4">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2 flex items-center gap-1.5">
              <MinusCircle size={13} className="text-red-500" />
              Possibly stale entitlements
            </p>
            <div className="space-y-3">
              {groupCandidatesBySource(result.removeCandidates).map(([source, ents]) => (
                <div key={source}>
                  <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-1">{source}</p>
                  <div className="space-y-2">
                    {ents.map((c, i) => (
                      <div key={i} className="bg-red-50 border border-red-100 rounded-lg px-3 py-2">
                        <p className="text-sm font-medium text-gray-900">{c.entitlement}</p>
                        <p className="text-xs text-gray-600 mt-0.5">{c.reason}</p>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {addCandidates.length > 0 && (
          <AddCandidatesBlock
            title="Possibly missing entitlements"
            candidates={addCandidates}
            onAddSelected={onAddSelected}
            addPending={addPending}
          />
        )}

        {dimensionEvaluations.map((d) => (
          <AddCandidatesBlock
            key={d.dimensionId}
            title={`Possibly missing — ${d.dimensionName} dimension`}
            candidates={d.addCandidates}
            onAddSelected={(entitlements) => onAddDimensionSelected(d.dimensionId, entitlements)}
            addPending={addDimPending === d.dimensionId}
          />
        ))}

        {dimensionRedundancies.map((d) => (
          <div key={`${d.dimensionId}-redundant`} className="mb-4">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2 flex items-center gap-1.5">
              <MinusCircle size={13} className="text-red-500" />
              Redundant with base role — {d.dimensionName} dimension
            </p>
            <div className="space-y-3">
              {groupCandidatesBySource(d.removeCandidates).map(([source, ents]) => (
                <div key={source}>
                  <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-1">{source}</p>
                  <div className="space-y-2">
                    {ents.map((c, i) => (
                      <div key={i} className="bg-red-50 border border-red-100 rounded-lg px-3 py-2">
                        <p className="text-sm font-medium text-gray-900">{c.entitlement}</p>
                        <p className="text-xs text-gray-600 mt-0.5">{c.reason}</p>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}

        {missingDimensions.map((md) => (
          <MissingDimensionBlock
            key={`${md.attrKey}:${md.value}`}
            md={md}
            onCreate={(entitlements) => onCreateDimension(md, entitlements)}
            pending={createDimensionPending === md.value}
          />
        ))}

        {staleDimensions.map((sd) => (
          <StaleDimensionBlock
            key={sd.dimensionId}
            sd={sd}
            onRemove={onRemoveDimension}
            pending={removeDimensionPending === sd.dimensionId}
          />
        ))}

        {!hasAnyFinding && (
          <p className="text-sm text-gray-400 mb-4">No changes suggested.</p>
        )}

        <div className="flex gap-2">
          {hasAnySuggestion && (
            <PrimaryButton onClick={onAcceptAll} loading={acceptAllPending} className="!w-auto flex-1">
              <CheckCheck size={16} />
              Accept all
            </PrimaryButton>
          )}
          <OutlineButton onClick={onClose} className="!w-auto flex-1">Close</OutlineButton>
        </div>
      </div>

      {repairOpen && (
        <SodRepairSheet
          items={sodRepairItems}
          policyRows={sodPolicyRows}
          onClose={() => setRepairOpen(false)}
          repairPending={repairPending}
          onRepair={(items) =>
            Promise.resolve(onRepairSod(items)).then(() => setRepairOpen(false))
          }
          onMitigate={onMitigateSod ? (payload) => Promise.resolve(onMitigateSod(payload)).then(() => setRepairOpen(false)) : null}
          mitigatePending={mitigatePending}
        />
      )}
    </div>
  );
}


