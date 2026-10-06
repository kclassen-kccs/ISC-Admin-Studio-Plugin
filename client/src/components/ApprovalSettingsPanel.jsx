import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, ArrowDown, X, Plus, AlertTriangle, CheckCircle2, Wand2, RotateCcw, Link as LinkIcon } from "lucide-react";
import toast from "react-hot-toast";
import {
  getEntitlementRequestConfig, putEntitlementRequestConfig, updateEntitlement, updateAccessProfile, updateRole,
  patchObjectJson, listAllGovernanceGroups, listWorkflows, listFormDefinitions, getSource, listIdentities,
} from "../lib/sailpoint";
import { PickerField } from "./PickerField";
import { ApprovalTimingSection } from "./ApprovalTimingSection";
import { SkeletonList, ErrorBox, PrimaryButton, OutlineButton, Field, Select, Input, SectionLabel } from "./ui";

// ─── Approval settings (entitlement / access profile / role) ─────────────────
// One form for who approves requests for an access item, laid out like ISC's
// own approval settings, with presets, a plain-English route and readiness
// checks so it's hard to save something that can't route. Each kind keeps
// its settings differently:
//   entitlement     GET/PUT /entitlements/{id}/entitlement-request-config
//                   (requestCommentRequired / denialCommentRequired)
//   access profile  accessRequestConfig / revocationRequestConfig on the
//   role            object itself, JSON-Patched (commentsRequired /
//                   denialCommentsRequired)
// Timeouts, reminders and escalations live in ISC's generic approval config
// for every kind (ApprovalTimingSection).

const MANAGER = { value: "MANAGER", label: "Requester's manager", hint: "The manager of the person the access is requested for." };
const GROUP = { value: "GOVERNANCE_GROUP", label: "Governance group", hint: "Any member of the chosen group can approve." };
const WORKFLOW = { value: "WORKFLOW", label: "Workflow (adaptive approval)", hint: "A workflow decides. Must be the only step; needs Adaptive Approvals and an access-request-triggered workflow." };
const ADDITIONAL = [
  { value: "ALL_OWNERS", label: "All owners", hint: "The owner and every additional owner." },
  { value: "ADDITIONAL_OWNER", label: "Additional owners", hint: "The additional owners (people) set on the item." },
  { value: "ADDITIONAL_GOVERNANCE_GROUP", label: "Additional-owner governance group", hint: "The governance group set as the item's additional owner." },
];

const KINDS = {
  entitlement: {
    noun: "entitlement",
    scope: "ENTITLEMENT",
    ownerType: "ENTITLEMENT_OWNER",
    approverTypes: [
      MANAGER,
      { value: "ENTITLEMENT_OWNER", label: "Entitlement owner", hint: "The owner of this entitlement." },
      { value: "SOURCE_OWNER", label: "Source owner", hint: "The owner of the entitlement's source." },
      GROUP,
      WORKFLOW,
    ],
    hasForm: true,
    update: (obj, fields) => updateEntitlement(obj.id, fields),
    iscPath: (id) => `/ui/a/admin/access/entitlements/manage/${id}/access-requests`,
  },
  "access-profile": {
    noun: "access profile",
    scope: "ACCESS_PROFILE",
    ownerType: "OWNER",
    approverTypes: [
      MANAGER,
      { value: "OWNER", label: "Access profile owner", hint: "The owner of this access profile." },
      { value: "APP_OWNER", label: "Application owner", hint: "The owner of the application the access profile belongs to." },
      { value: "SOURCE_OWNER", label: "Source owner", hint: "The owner of the access profile's source." },
      GROUP,
      ...ADDITIONAL,
      WORKFLOW,
    ],
    hasForm: true,
    update: (obj, fields) => updateAccessProfile(obj.id, fields),
    jsonResource: "access-profiles",
  },
  role: {
    noun: "role",
    scope: "ROLE",
    ownerType: "OWNER",
    approverTypes: [
      MANAGER,
      { value: "OWNER", label: "Role owner", hint: "The owner of this role." },
      GROUP,
      ...ADDITIONAL,
      WORKFLOW,
    ],
    hasForm: true,
    update: (obj, fields) => updateRole(obj.id, fields),
    jsonResource: "roles",
  },
};

const DURATION_UNITS = ["HOURS", "DAYS", "WEEKS", "MONTHS"];
const isAccessRequestWorkflow = (w) => /access-request-trigger/i.test(w.trigger?.attributes?.id || "");
const steps = (list) => (list || []).map((s) => ({ approverType: s.approverType, approverId: s.approverId ?? null }));
const duration = (d) => (d?.value ? { value: Number(d.value), timeUnit: d.timeUnit || "DAYS" } : null);

// Kind-specific shape → one draft shape the form edits.
function toDraft(kind, raw) {
  const ar = raw?.accessRequestConfig || {};
  const rv = raw?.revocationRequestConfig || {};
  const entitlement = kind === "entitlement";
  return {
    access: {
      steps: steps(ar.approvalSchemes),
      requestComment: !!(entitlement ? ar.requestCommentRequired : ar.commentsRequired),
      denialComment: !!(entitlement ? ar.denialCommentRequired : ar.denialCommentsRequired),
      reauth: !!ar.reauthorizationRequired,
      requireEndDate: !!ar.requireEndDate,
      maxDuration: duration(ar.maxPermittedAccessDuration),
      formDefinitionId: ar.formDefinitionId || null,
    },
    revoke: { steps: steps(rv.approvalSchemes) },
  };
}

// Draft → the kind's own shape, keeping any fields the form doesn't edit.
function fromDraft(kind, raw, d) {
  const ar = raw?.accessRequestConfig || {};
  const rv = raw?.revocationRequestConfig || {};
  const access = {
    ...ar,
    approvalSchemes: d.access.steps,
    reauthorizationRequired: d.access.reauth,
    requireEndDate: d.access.requireEndDate,
    maxPermittedAccessDuration: d.access.maxDuration,
    formDefinitionId: d.access.formDefinitionId,
  };
  if (kind === "entitlement") {
    access.requestCommentRequired = d.access.requestComment;
    access.denialCommentRequired = d.access.denialComment;
  } else {
    access.commentsRequired = d.access.requestComment;
    access.denialCommentsRequired = d.access.denialComment;
  }
  return { accessRequestConfig: access, revocationRequestConfig: { ...rv, approvalSchemes: d.revoke.steps } };
}

function checkSteps(list, ctx) {
  const errors = [];
  const warnings = [];
  if (list.some((s) => s.approverType === "WORKFLOW") && list.length > 1) errors.push("A workflow approver must be the only approval step.");
  const seen = new Set();
  const additional = ctx.object?.additionalOwners || [];
  list.forEach((s, i) => {
    const n = `Step ${i + 1}`;
    const key = `${s.approverType}:${s.approverId || ""}`;
    if (seen.has(key)) warnings.push(`${n} repeats an earlier approver — ISC will ask the same people twice.`);
    seen.add(key);
    if (s.approverType === "GOVERNANCE_GROUP") {
      const g = s.approverId && ctx.groupsById.get(s.approverId);
      if (!s.approverId) errors.push(`${n}: choose a governance group.`);
      else if (g && !g.memberCount) warnings.push(`${n}: "${g.name}" has no members, so nobody can approve.`);
    }
    if (s.approverType === "WORKFLOW") {
      const w = s.approverId && ctx.workflowsById.get(s.approverId);
      if (!s.approverId) errors.push(`${n}: choose a workflow.`);
      else if (w && !isAccessRequestWorkflow(w)) warnings.push(`${n}: "${w.name}" isn't triggered by access requests (idn:access-request-trigger) — ISC will reject it.`);
      else if (w && w.enabled === false) warnings.push(`${n}: "${w.name}" is disabled.`);
    }
    if (s.approverType === ctx.def.ownerType && ctx.object && !ctx.object.owner?.id) {
      errors.push(`${n}: the ${ctx.def.noun} has no owner — set one above, or requests will have nobody to go to.`);
    }
    if (s.approverType === "ADDITIONAL_OWNER" && !additional.some((o) => o.type === "IDENTITY")) warnings.push(`${n}: the ${ctx.def.noun} has no additional owners (people).`);
    if (s.approverType === "ADDITIONAL_GOVERNANCE_GROUP" && !additional.some((o) => o.type === "GOVERNANCE_GROUP")) warnings.push(`${n}: the ${ctx.def.noun} has no additional-owner governance group.`);
    if (s.approverType === "SOURCE_OWNER" && ctx.sourceOwner === null) warnings.push(`${n}: couldn't confirm the source has an owner.`);
  });
  return { errors, warnings };
}

function describe(list, ctx) {
  if (list.length === 0) return "No approval — requests are granted automatically.";
  const label = (t) => ctx.def.approverTypes.find((a) => a.value === t)?.label || t;
  return list.map((s, i) => {
    let who = label(s.approverType);
    if (s.approverType === ctx.def.ownerType && ctx.object?.owner?.name) who += ` (${ctx.object.owner.name})`;
    if (s.approverType === "SOURCE_OWNER" && ctx.sourceOwner?.name) who += ` (${ctx.sourceOwner.name})`;
    if (s.approverType === "GOVERNANCE_GROUP") who = `Governance group "${ctx.groupsById.get(s.approverId)?.name || "not chosen"}"`;
    if (s.approverType === "WORKFLOW") who = `Workflow "${ctx.workflowsById.get(s.approverId)?.name || "not chosen"}"`;
    return `${i + 1}. ${who}`;
  }).join("  →  ");
}

function StepsEditor({ title, help, list, onChange, groups, workflows, allowWorkflow, ctx }) {
  const update = (i, patch) => onChange(list.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const move = (i, d) => { const next = [...list]; [next[i], next[i + d]] = [next[i + d], next[i]]; onChange(next); };
  const types = ctx.def.approverTypes.filter((t) => allowWorkflow || t.value !== "WORKFLOW");
  const owner = ctx.def.ownerType;
  const presets = [
    { key: "none", label: "No approval", steps: [] },
    { key: "manager", label: "Manager", steps: [{ approverType: "MANAGER" }] },
    { key: "owner", label: "Owner", steps: [{ approverType: owner }] },
    { key: "manager-owner", label: "Manager, then owner", steps: [{ approverType: "MANAGER" }, { approverType: owner }] },
    { key: "group", label: "Governance group", steps: [{ approverType: "GOVERNANCE_GROUP" }] },
  ];
  const accessWorkflows = workflows.filter(isAccessRequestWorkflow);
  const { errors, warnings } = checkSteps(list, ctx);

  return (
    <div className="mb-5">
      <SectionLabel>{title}</SectionLabel>
      {help && <p className="text-xs text-gray-500 mb-2">{help}</p>}
      <div className="flex flex-wrap gap-1.5 mb-3">
        <span className="text-xs text-gray-400 self-center mr-1 inline-flex items-center gap-1"><Wand2 size={12} /> Quick setup:</span>
        {presets.map((p) => (
          <button key={p.key} type="button" onClick={() => onChange(p.steps.map((s) => ({ ...s, approverId: null })))} className="text-xs px-2 py-1 rounded-full border border-gray-200 text-gray-600 hover:bg-gray-50">
            {p.label}
          </button>
        ))}
      </div>

      {list.length === 0 ? (
        <p className="text-sm text-gray-500 border border-dashed border-gray-200 rounded-xl px-3 py-3">No approval steps — requests are granted without review.</p>
      ) : (
        <div className="border border-gray-100 rounded-xl overflow-hidden divide-y divide-gray-100">
          {list.map((s, i) => {
            const known = types.some((t) => t.value === s.approverType);
            return (
              <div key={i} className="px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <span className="w-6 h-6 rounded-full bg-blue-50 text-blue-700 text-xs font-semibold flex items-center justify-center flex-shrink-0">{i + 1}</span>
                  <div className="flex-1 min-w-0">
                    <Select value={s.approverType} onChange={(e) => update(i, { approverType: e.target.value, approverId: null })}>
                      {types.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                      {!known && <option value={s.approverType}>{s.approverType}</option>}
                    </Select>
                  </div>
                  <button type="button" onClick={() => move(i, -1)} disabled={i === 0} title="Move up" className="text-gray-400 hover:text-gray-600 disabled:opacity-30"><ArrowUp size={16} /></button>
                  <button type="button" onClick={() => move(i, 1)} disabled={i === list.length - 1} title="Move down" className="text-gray-400 hover:text-gray-600 disabled:opacity-30"><ArrowDown size={16} /></button>
                  <button type="button" onClick={() => onChange(list.filter((_, j) => j !== i))} title="Remove step" className="text-gray-400 hover:text-red-600"><X size={16} /></button>
                </div>
                <p className="text-xs text-gray-400 mt-1 ml-8">{ctx.def.approverTypes.find((t) => t.value === s.approverType)?.hint}</p>
                {s.approverType === "GOVERNANCE_GROUP" && (
                  <div className="ml-8 mt-2">
                    <Select value={s.approverId || ""} onChange={(e) => update(i, { approverId: e.target.value || null })}>
                      <option value="">Choose a governance group…</option>
                      {groups.map((g) => <option key={g.id} value={g.id}>{g.name} ({g.memberCount ?? 0} member{g.memberCount === 1 ? "" : "s"})</option>)}
                    </Select>
                  </div>
                )}
                {s.approverType === "WORKFLOW" && (
                  <div className="ml-8 mt-2">
                    <Select value={s.approverId || ""} onChange={(e) => update(i, { approverId: e.target.value || null })}>
                      <option value="">Choose a workflow…</option>
                      {accessWorkflows.length > 0 && (
                        <optgroup label="Access-request-triggered workflows">
                          {accessWorkflows.map((w) => <option key={w.id} value={w.id}>{w.name}{w.enabled === false ? " (disabled)" : ""}</option>)}
                        </optgroup>
                      )}
                      <optgroup label="Other workflows (ISC will likely reject)">
                        {workflows.filter((w) => !isAccessRequestWorkflow(w)).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                      </optgroup>
                    </Select>
                    {accessWorkflows.length === 0 && <p className="text-xs text-amber-700 mt-1">No workflow here uses the access-request trigger — create one first for a workflow approver.</p>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      <button
        type="button"
        onClick={() => onChange([...list, { approverType: list.length ? owner : "MANAGER", approverId: null }])}
        disabled={list.some((s) => s.approverType === "WORKFLOW")}
        className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-700 disabled:opacity-40"
      >
        <Plus size={13} /> Add approval step
      </button>

      <p className="text-xs text-gray-600 mt-2"><span className="font-medium">Route:</span> {describe(list, ctx)}</p>
      {errors.map((e) => <p key={e} className="text-xs text-red-600 mt-1 flex items-start gap-1"><AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />{e}</p>)}
      {warnings.map((w) => <p key={w} className="text-xs text-amber-700 mt-1 flex items-start gap-1"><AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />{w}</p>)}
    </div>
  );
}

function Toggle({ checked, onChange, label, help }) {
  return (
    <label className="flex items-start gap-2 cursor-pointer mb-2">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="w-4 h-4 mt-0.5 rounded border-gray-300 accent-blue-600 flex-shrink-0" />
      <span>
        <span className="text-sm text-gray-700">{label}</span>
        {help && <span className="block text-xs text-gray-400">{help}</span>}
      </span>
    </label>
  );
}

/**
 * kind: "entitlement" | "access-profile" | "role"
 * object: the item as ISC returns it (owner, requestable, source, additionalOwners,
 *   and for access profiles / roles the request configs themselves)
 * invalidateKeys: query keys holding `object`, refreshed after a change
 * intro: optional line above the form (e.g. the launcher wording)
 * iscUrl: optional link to the same settings in ISC
 */
export function ApprovalSettingsPanel({ kind, object, invalidateKeys = [], intro, iscUrl }) {
  const def = KINDS[kind];
  const queryClient = useQueryClient();
  const isEntitlement = kind === "entitlement";
  const cfgQ = useQuery({
    queryKey: ["entitlement-request-config", object.id],
    queryFn: () => getEntitlementRequestConfig(object.id),
    enabled: isEntitlement,
  });
  const raw = isEntitlement ? cfgQ.data : object;
  const groupsQ = useQuery({ queryKey: ["governance-groups"], queryFn: listAllGovernanceGroups, staleTime: 60_000 });
  const wfQ = useQuery({ queryKey: ["workflows"], queryFn: listWorkflows, staleTime: 60_000 });
  const formsQ = useQuery({ queryKey: ["form-definitions"], queryFn: listFormDefinitions, staleTime: 60_000 });
  const sourceId = object.source?.id;
  const sourceQ = useQuery({ queryKey: ["source", sourceId], queryFn: () => getSource(sourceId), enabled: !!sourceId && kind !== "role", staleTime: 60_000 });

  const original = useMemo(() => (raw ? toDraft(kind, raw) : null), [kind, raw]);
  const [draft, setDraft] = useState(null);
  const [newOwner, setNewOwner] = useState([]);
  // The item reloads in the background (window focus, other edits); only
  // take the fresh copy when the form has no unsaved changes, so a reload
  // never wipes what's being edited.
  const lastOriginal = useRef(null);
  useEffect(() => {
    if (!original) return;
    setDraft((prev) => (!prev || JSON.stringify(prev) === JSON.stringify(lastOriginal.current) ? original : prev));
    lastOriginal.current = original;
  }, [original]);

  const groups = Array.isArray(groupsQ.data) ? [...groupsQ.data].sort((a, b) => (a.name || "").localeCompare(b.name || "")) : [];
  const workflows = Array.isArray(wfQ.data) ? wfQ.data : [];
  const forms = Array.isArray(formsQ.data) ? formsQ.data : [];
  const ctx = {
    def,
    object,
    sourceOwner: sourceQ.isSuccess ? (sourceQ.data?.owner || null) : undefined,
    groupsById: new Map(groups.map((g) => [g.id, g])),
    workflowsById: new Map(workflows.map((w) => [w.id, w])),
  };
  const refreshObject = () => invalidateKeys.forEach((k) => queryClient.invalidateQueries({ queryKey: k }));

  const save = useMutation({
    mutationFn: async (d) => {
      const next = fromDraft(kind, raw, d);
      if (isEntitlement) return putEntitlementRequestConfig(object.id, next);
      const ops = ["accessRequestConfig", "revocationRequestConfig"].map((key) => ({
        op: key in object ? "replace" : "add",
        path: `/${key}`,
        value: next[key],
      }));
      return patchObjectJson(def.jsonResource, object.id, ops);
    },
    onSuccess: () => {
      toast.success("Approval settings saved");
      setDraft(null); // take the saved copy when it reloads
      if (isEntitlement) queryClient.invalidateQueries({ queryKey: ["entitlement-request-config", object.id] });
      refreshObject();
    },
    onError: (err) => toast.error(err.response?.data?.messages?.[0]?.text || err.response?.data?.error || err.message, { duration: 10000 }),
  });
  const setOwner = useMutation({
    mutationFn: (owner) => def.update(object, { owner: { id: owner.id, name: owner.name } }),
    onSuccess: () => { toast.success("Owner set"); setNewOwner([]); refreshObject(); },
    onError: (err) => toast.error(err.response?.data?.error || err.message, { duration: 8000 }),
  });
  const makeRequestable = useMutation({
    mutationFn: () => def.update(object, { requestable: true }),
    onSuccess: () => { toast.success(`The ${def.noun} is now requestable`); refreshObject(); },
    onError: (err) => toast.error(err.response?.data?.error || err.message, { duration: 8000 }),
  });

  if (isEntitlement && cfgQ.error) return <div className="px-4 py-4"><ErrorBox message={cfgQ.error.response?.data?.error || cfgQ.error.message} onRetry={cfgQ.refetch} /></div>;
  if (!draft) return <div className="px-4 py-4"><SkeletonList rows={6} /></div>;

  const a = draft.access;
  const setA = (patch) => setDraft((d) => ({ ...d, access: { ...d.access, ...patch } }));
  const access = checkSteps(a.steps, ctx);
  const revoke = checkSteps(draft.revoke.steps, ctx);
  const durationInvalid = a.maxDuration && !(a.maxDuration.value > 0);
  const dirty = JSON.stringify(draft) !== JSON.stringify(original);
  const blocked = access.errors.length > 0 || revoke.errors.length > 0 || durationInvalid;
  // A role assigned by ISC itself (dynamic or membership rule) can't be made requestable.
  const autoAssignedRole = kind === "role" && (object.dimensional || object.membership?.criteria);

  const checklist = [
    {
      ok: !!object.requestable,
      text: object.requestable
        ? `The ${def.noun} is requestable`
        : autoAssignedRole
          ? `The ${def.noun} isn't requestable — it's assigned automatically (${object.dimensional ? "dynamic role" : "membership rule"}), so these settings only apply if that changes`
          : `The ${def.noun} isn't requestable — nobody can request it, so these approvals won't be used yet`,
      fix: !object.requestable && !autoAssignedRole && (
        <button type="button" onClick={() => makeRequestable.mutate()} disabled={makeRequestable.isPending} className="text-xs font-medium text-blue-600 hover:text-blue-700 flex-shrink-0">
          {makeRequestable.isPending ? "Saving…" : "Make requestable"}
        </button>
      ),
    },
    { ok: !!object.owner?.id, text: object.owner?.id ? `Owner: ${object.owner.name}` : `The ${def.noun} has no owner (needed for owner approval and certifications)` },
    { ok: access.errors.length === 0, text: access.errors.length ? "Access approval route has problems (see below)" : `Access approval: ${describe(a.steps, ctx)}` },
  ];

  return (
    <div className="px-4 py-4">
      {intro && <p className="text-xs text-gray-500 mb-3">{intro}</p>}
      {iscUrl && (
        <a href={iscUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-700 mb-3">
          <LinkIcon size={12} /> Open these settings in Identity Security Cloud
        </a>
      )}

      <div className="border border-gray-100 rounded-xl px-3 py-2.5 mb-5">
        {checklist.map((c) => (
          <div key={c.text} className="flex items-start gap-2 py-1">
            {c.ok ? <CheckCircle2 size={15} className="text-emerald-600 flex-shrink-0 mt-0.5" /> : <AlertTriangle size={15} className="text-amber-600 flex-shrink-0 mt-0.5" />}
            <span className={`text-sm flex-1 ${c.ok ? "text-gray-700" : "text-amber-800"}`}>{c.text}</span>
            {c.fix}
          </div>
        ))}
        {!object.owner?.id && (
          <div className="mt-2">
            <PickerField
              label={`Set ${def.noun} owner`}
              cacheKey={`approval-owner-${kind}`}
              placeholder="Search users…"
              searchFn={async (q) => (await listIdentities({ limit: 15, query: q || undefined })).map((i) => ({ id: i.id, name: i.name }))}
              multi={false}
              selected={newOwner}
              onChange={setNewOwner}
            />
            <OutlineButton onClick={() => newOwner[0] && setOwner.mutate(newOwner[0])} loading={setOwner.isPending} disabled={!newOwner[0]} className="!w-auto -mt-2">Set owner</OutlineButton>
          </div>
        )}
      </div>

      <StepsEditor
        title="Access request approval"
        help="Who must approve, in order, when someone requests this. Each step must approve before the next is asked."
        list={a.steps}
        onChange={(list) => setA({ steps: list })}
        groups={groups}
        workflows={workflows}
        allowWorkflow
        ctx={ctx}
      />

      <SectionLabel>Request options</SectionLabel>
      <Toggle checked={a.requestComment} onChange={(v) => setA({ requestComment: v })} label="Require a comment from the requester" help="Recommended — approvers see why the access is needed." />
      <Toggle checked={a.denialComment} onChange={(v) => setA({ denialComment: v })} label="Require a comment when an approver denies" />
      <Toggle checked={a.reauth} onChange={(v) => setA({ reauth: v })} label="Require approvers to re-authenticate" help="Approvers confirm with MFA/password before approving." />
      <Toggle checked={a.requireEndDate} onChange={(v) => setA({ requireEndDate: v })} label="Require an end date on requests" help="The access is removed on that date." />
      <Toggle checked={!!a.maxDuration} onChange={(v) => setA({ maxDuration: v ? { value: 30, timeUnit: "DAYS" } : null })} label="Limit how long access can be requested for" />
      {a.maxDuration && (
        <div className="flex gap-2 ml-6 mb-3 max-w-xs">
          <Input type="number" min={1} value={a.maxDuration.value || ""} onChange={(e) => setA({ maxDuration: { ...a.maxDuration, value: Number(e.target.value) } })} />
          <Select value={a.maxDuration.timeUnit} onChange={(e) => setA({ maxDuration: { ...a.maxDuration, timeUnit: e.target.value } })}>
            {DURATION_UNITS.map((u) => <option key={u} value={u}>{u.charAt(0) + u.slice(1).toLowerCase()}</option>)}
          </Select>
        </div>
      )}
      {durationInvalid && <p className="text-xs text-red-600 ml-6 -mt-2 mb-3">Enter a duration greater than zero.</p>}
      {def.hasForm && (
        <Field label="Access request form (optional)">
          <Select value={a.formDefinitionId || ""} onChange={(e) => setA({ formDefinitionId: e.target.value || null })}>
            <option value="">No form</option>
            {a.formDefinitionId && !forms.some((f) => f.id === a.formDefinitionId) && <option value={a.formDefinitionId}>{a.formDefinitionId}</option>}
            {forms.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </Select>
          <p className="text-xs text-gray-400 mt-1">Extra questions the requester answers, shown to approvers.</p>
        </Field>
      )}

      <StepsEditor
        title="Removal (revoke) request approval"
        help="Who must approve when someone asks to have this removed. Usually none."
        list={draft.revoke.steps}
        onChange={(list) => setDraft((d) => ({ ...d, revoke: { steps: list } }))}
        groups={groups}
        workflows={workflows}
        allowWorkflow={false}
        ctx={ctx}
      />

      <div className="flex gap-2 py-3 border-t border-gray-100">
        <PrimaryButton onClick={() => save.mutate(draft)} loading={save.isPending} disabled={!dirty || blocked} className="!w-auto flex-1">Save approval settings</PrimaryButton>
        <OutlineButton onClick={() => setDraft(original)} disabled={!dirty || save.isPending} className="!w-auto"><RotateCcw size={14} /> Reset</OutlineButton>
      </div>

      {/* Saved separately — a different ISC API (generic approval config). */}
      <div className="mt-6 pt-4 border-t border-gray-100">
        <ApprovalTimingSection objectId={object.id} scope={def.scope} noun={def.noun} groups={groups} />
      </div>
    </div>
  );
}
