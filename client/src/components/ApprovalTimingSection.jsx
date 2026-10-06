import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock, Bell, TrendingUp, Wand2, AlertTriangle, ArrowUp, ArrowDown, X, Plus, RotateCcw } from "lucide-react";
import toast from "react-hot-toast";
import {
  getItemApprovalConfig, putItemApprovalConfig, deleteItemApprovalConfig, listIdentities,
} from "../lib/sailpoint";
import { PickerField } from "./PickerField";
import { SkeletonList, ErrorBox, PrimaryButton, OutlineButton, Input, Select, SectionLabel } from "./ui";

// ─── Timeouts, reminders and escalations ─────────────────────────────────────
// ISC's approval config for one access item — entitlement, access profile
// or role (GET/PUT/DELETE /generic-approvals/config/{id}[/{scope}]). With no
// settings of its own the item uses the tenant default, which GET returns
// (scope TENANT); saving here gives the item its own copy, and "Use tenant
// defaults" deletes that copy. Schedules are cron strings in ISC ("@every 48h"); this
// form edits them as a number of days.

const ESCALATE_TO = [
  { value: "MANAGER_OF", label: "Current approver's manager", needsId: false },
  { value: "MANAGER_OF_REQUESTER", label: "Requester's manager", needsId: false },
  { value: "ENTITLEMENT_OWNER", label: "Entitlement owner", needsId: false },
  { value: "SOURCE_OWNER", label: "Source owner", needsId: false },
  { value: "GOVERNANCE_GROUP", label: "Governance group", needsId: true },
  { value: "IDENTITY", label: "Specific person", needsId: true },
];
const escalateLabel = (t) => ESCALATE_TO.find((e) => e.value === t)?.label || t;

const PRESETS = [
  {
    key: "standard",
    label: "Standard (remind every 2 days, escalate after 5, expire after 14)",
    apply: () => ({
      reminder: { enabled: true, firstDays: 1, everyDays: 2, max: 3 },
      escalation: { enabled: true, firstDays: 5, everyDays: 3, chain: [{ identityType: "MANAGER_OF", identityId: null }] },
      timeout: { enabled: true, days: 14, result: "EXPIRED" },
    }),
  },
  {
    key: "urgent",
    label: "Urgent (daily reminders, escalate after 2, expire after 5)",
    apply: () => ({
      reminder: { enabled: true, firstDays: 1, everyDays: 1, max: 5 },
      escalation: { enabled: true, firstDays: 2, everyDays: 1, chain: [{ identityType: "MANAGER_OF", identityId: null }, { identityType: "ENTITLEMENT_OWNER", identityId: null }] },
      timeout: { enabled: true, days: 5, result: "EXPIRED" },
    }),
  },
  {
    key: "relaxed",
    label: "Relaxed (weekly reminders, no escalation, expire after 30)",
    apply: () => ({
      reminder: { enabled: true, firstDays: 3, everyDays: 7, max: 4 },
      escalation: { enabled: false, firstDays: 7, everyDays: 7, chain: [] },
      timeout: { enabled: true, days: 30, result: "EXPIRED" },
    }),
  },
];

// "@every 72h" / "@every 3d" / "@daily" → days; anything else → null (kept raw).
function cronToDays(cron) {
  if (!cron) return null;
  const s = String(cron).trim();
  if (s === "@daily" || s === "@midnight") return 1;
  if (s === "@weekly") return 7;
  const m = /^@every\s+(\d+)\s*([hd])$/i.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  return m[2].toLowerCase() === "d" ? n : n / 24;
}
const daysToCron = (days) => `@every ${Math.round(Number(days) * 24)}h`;

function toDraft(cfg) {
  const r = cfg?.reminderConfig || {};
  const e = cfg?.escalationConfig || {};
  const t = cfg?.timeoutConfig || {};
  return {
    reminder: { enabled: !!r.enabled, firstDays: r.daysUntilFirstReminder ?? 1, everyDays: cronToDays(r.reminderCronSchedule) ?? 2, rawCron: cronToDays(r.reminderCronSchedule) == null ? r.reminderCronSchedule || null : null, max: r.maxReminders ?? 3 },
    escalation: {
      enabled: !!e.enabled,
      firstDays: e.daysUntilFirstEscalation ?? 5,
      everyDays: cronToDays(e.escalationCronSchedule) ?? 3,
      rawCron: cronToDays(e.escalationCronSchedule) == null ? e.escalationCronSchedule || null : null,
      chain: (e.escalationChain || []).map((c) => ({ identityType: c.identityType, identityId: c.identityId || null, name: c.name || null })),
    },
    timeout: { enabled: !!t.enabled, days: t.daysUntilTimeout ?? 14, result: t.timeoutResult || "EXPIRED" },
  };
}

function check(d) {
  const errors = [];
  const warnings = [];
  const { reminder: r, escalation: e, timeout: t } = d;
  if (t.enabled && !(t.days >= 1 && t.days <= 90)) errors.push("Timeout must be between 1 and 90 days.");
  if (t.enabled && t.result === "APPROVED") warnings.push("On timeout the request is APPROVED automatically — anyone who waits long enough gets the access. Expired is usually safer.");
  if (r.enabled) {
    if (!(r.max >= 1 && r.max <= 20)) errors.push("Reminders: send between 1 and 20.");
    if (!(r.everyDays > 0)) errors.push("Reminders: the interval must be more than 0 days.");
    if (!(r.firstDays >= 0)) errors.push("Reminders: days until the first reminder can't be negative.");
    if (t.enabled && r.firstDays >= t.days) warnings.push("The first reminder comes after the request has already timed out.");
  }
  if (e.enabled) {
    if (e.chain.length === 0) errors.push("Escalation: add at least one person or group to escalate to.");
    e.chain.forEach((c, i) => { if (ESCALATE_TO.find((x) => x.value === c.identityType)?.needsId && !c.identityId) errors.push(`Escalation step ${i + 1}: choose who.`); });
    if (!(e.everyDays > 0)) errors.push("Escalation: the interval must be more than 0 days.");
    if (t.enabled && e.firstDays >= t.days) warnings.push("The first escalation comes after the request has already timed out — it will never escalate.");
    if (r.enabled && e.firstDays <= r.firstDays) warnings.push("Escalation starts before the first reminder — approvers get no nudge before it moves on.");
  }
  if (!t.enabled) warnings.push("With no timeout, an unanswered request waits forever.");
  return { errors, warnings };
}

function summary(d) {
  const parts = [];
  const { reminder: r, escalation: e, timeout: t } = d;
  if (r.enabled) parts.push(`Remind after ${r.firstDays} day${r.firstDays === 1 ? "" : "s"}, then every ${r.everyDays} day${r.everyDays === 1 ? "" : "s"} (up to ${r.max}).`);
  else parts.push("No reminders.");
  if (e.enabled) parts.push(`Escalate after ${e.firstDays} day${e.firstDays === 1 ? "" : "s"} to ${e.chain.map((c) => c.name || escalateLabel(c.identityType)).join(", then ") || "—"}${e.chain.length > 1 ? `, moving on every ${e.everyDays} day${e.everyDays === 1 ? "" : "s"}` : ""}.`);
  else parts.push("No escalation.");
  parts.push(t.enabled ? `After ${t.days} day${t.days === 1 ? "" : "s"} unanswered the request is ${t.result === "APPROVED" ? "approved" : "expired"}.` : "Requests never time out.");
  return parts.join(" ");
}

function NumberField({ label, value, onChange, min = 0, max, suffix }) {
  return (
    <label className="flex items-center gap-2 text-sm text-gray-700 mb-2">
      <span className="w-44 flex-shrink-0 text-gray-500">{label}</span>
      <span className="w-20"><Input type="number" min={min} max={max} value={value ?? ""} onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))} /></span>
      {suffix && <span className="text-gray-500">{suffix}</span>}
    </label>
  );
}

function Header({ Icon, title, enabled, onToggle }) {
  return (
    <label className="flex items-center gap-2 cursor-pointer mb-2">
      <input type="checkbox" checked={enabled} onChange={(e) => onToggle(e.target.checked)} className="w-4 h-4 rounded border-gray-300 accent-blue-600" />
      <Icon size={15} className="text-gray-500" />
      <span className="text-sm font-medium text-gray-800">{title}</span>
    </label>
  );
}

export function ApprovalTimingSection({ objectId, scope, noun = "item", groups }) {
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: ["item-approval-config", objectId], queryFn: () => getItemApprovalConfig(objectId), enabled: !!objectId });
  const original = useMemo(() => (q.data ? toDraft(q.data) : null), [q.data]);
  const [draft, setDraft] = useState(null);
  // Background reloads only replace the form when it has no unsaved changes.
  const lastOriginal = useRef(null);
  useEffect(() => {
    if (!original) return;
    setDraft((prev) => (!prev || JSON.stringify(prev) === JSON.stringify(lastOriginal.current) ? original : prev));
    lastOriginal.current = original;
  }, [original]);
  const inherited = q.data && q.data.scope !== scope;
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["item-approval-config", objectId] });

  const save = useMutation({
    mutationFn: () => {
      const d = draft;
      // Keep anything this form doesn't edit (notification templates,
      // fallback approver…) as ISC returned it; drop the record's own keys.
      const { id: _id, scope: _scope, ...rest } = q.data || {};
      return putItemApprovalConfig(objectId, scope, {
        ...rest,
        reminderConfig: { enabled: d.reminder.enabled, daysUntilFirstReminder: Number(d.reminder.firstDays), reminderCronSchedule: d.reminder.rawCron || daysToCron(d.reminder.everyDays), maxReminders: Number(d.reminder.max) },
        escalationConfig: {
          enabled: d.escalation.enabled,
          daysUntilFirstEscalation: Number(d.escalation.firstDays),
          escalationCronSchedule: d.escalation.rawCron || daysToCron(d.escalation.everyDays),
          escalationChain: d.escalation.chain.map((c) => ({ identityType: c.identityType, ...(c.identityId ? { identityId: c.identityId } : {}) })),
        },
        timeoutConfig: { enabled: d.timeout.enabled, daysUntilTimeout: Number(d.timeout.days), timeoutResult: d.timeout.result },
        cronTimezone: q.data?.cronTimezone?.location ? q.data.cronTimezone : { location: Intl.DateTimeFormat().resolvedOptions().timeZone, offset: "" },
      });
    },
    onSuccess: () => { toast.success("Timeouts, reminders and escalations saved"); setDraft(null); refresh(); },
    onError: (err) => toast.error(err.response?.data?.messages?.[0]?.text || err.response?.data?.error || err.message, { duration: 10000 }),
  });
  const revert = useMutation({
    mutationFn: () => deleteItemApprovalConfig(objectId, scope),
    onSuccess: () => { toast.success("Using the tenant's default timeouts, reminders and escalations"); setDraft(null); refresh(); },
    onError: (err) => toast.error(err.response?.data?.messages?.[0]?.text || err.response?.data?.error || err.message, { duration: 10000 }),
  });

  if (q.isLoading || (q.data && !draft)) return <SkeletonList rows={4} />;
  if (q.error) return <ErrorBox message={q.error.response?.data?.messages?.[0]?.text || q.error.response?.data?.error || q.error.message} onRetry={q.refetch} />;

  const set = (part, patch) => setDraft((d) => ({ ...d, [part]: { ...d[part], ...patch } }));
  const setChain = (chain) => set("escalation", { chain });
  const { errors, warnings } = check(draft);
  const dirty = JSON.stringify(draft) !== JSON.stringify(original);

  return (
    <div className="mb-5">
      <SectionLabel>Timeouts, reminders and escalations</SectionLabel>
      <p className={`text-xs mb-2 ${inherited ? "text-gray-500" : "text-blue-700"}`}>
        {inherited
          ? `Using the tenant's default settings. Saving here gives this ${noun} its own.`
          : `This ${noun} has its own settings, overriding the tenant default.`}
      </p>
      <div className="flex flex-wrap gap-1.5 mb-3">
        <span className="text-xs text-gray-400 self-center mr-1 inline-flex items-center gap-1"><Wand2 size={12} /> Quick setup:</span>
        {PRESETS.map((p) => (
          <button key={p.key} type="button" onClick={() => setDraft((d) => ({ ...d, ...p.apply() }))} className="text-xs px-2 py-1 rounded-full border border-gray-200 text-gray-600 hover:bg-gray-50">
            {p.label}
          </button>
        ))}
      </div>

      <div className="border border-gray-100 rounded-xl divide-y divide-gray-100">
        <div className="px-3 py-3">
          <Header Icon={Bell} title="Reminders" enabled={draft.reminder.enabled} onToggle={(v) => set("reminder", { enabled: v })} />
          {draft.reminder.enabled && (
            <div className="ml-6">
              <NumberField label="First reminder after" value={draft.reminder.firstDays} onChange={(v) => set("reminder", { firstDays: v })} suffix="days" />
              {draft.reminder.rawCron ? (
                <p className="text-xs text-gray-500 mb-2">Then on ISC schedule <code>{draft.reminder.rawCron}</code> <button type="button" onClick={() => set("reminder", { rawCron: null })} className="text-blue-600 ml-1">Use days instead</button></p>
              ) : (
                <NumberField label="Then every" value={draft.reminder.everyDays} onChange={(v) => set("reminder", { everyDays: v })} min={1} suffix="days" />
              )}
              <NumberField label="Send at most" value={draft.reminder.max} onChange={(v) => set("reminder", { max: v })} min={1} max={20} suffix="reminders (max 20)" />
            </div>
          )}
        </div>

        <div className="px-3 py-3">
          <Header Icon={TrendingUp} title="Escalation" enabled={draft.escalation.enabled} onToggle={(v) => set("escalation", { enabled: v, chain: v && draft.escalation.chain.length === 0 ? [{ identityType: "MANAGER_OF", identityId: null }] : draft.escalation.chain })} />
          {draft.escalation.enabled && (
            <div className="ml-6">
              <NumberField label="Escalate after" value={draft.escalation.firstDays} onChange={(v) => set("escalation", { firstDays: v })} suffix="days without an answer" />
              {draft.escalation.rawCron ? (
                <p className="text-xs text-gray-500 mb-2">Next escalation on ISC schedule <code>{draft.escalation.rawCron}</code> <button type="button" onClick={() => set("escalation", { rawCron: null })} className="text-blue-600 ml-1">Use days instead</button></p>
              ) : (
                <NumberField label="Move up the chain every" value={draft.escalation.everyDays} onChange={(v) => set("escalation", { everyDays: v })} min={1} suffix="days" />
              )}
              <p className="text-xs text-gray-500 mb-1.5">Escalate to, in order:</p>
              <div className="border border-gray-100 rounded-lg divide-y divide-gray-100 mb-2">
                {draft.escalation.chain.map((c, i) => {
                  const opt = ESCALATE_TO.find((x) => x.value === c.identityType);
                  return (
                    <div key={i} className="px-2 py-2">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-semibold text-gray-400 w-4">{i + 1}</span>
                        <div className="flex-1 min-w-0">
                          <Select value={c.identityType} onChange={(e) => setChain(draft.escalation.chain.map((x, j) => (j === i ? { identityType: e.target.value, identityId: null, name: null } : x)))}>
                            {ESCALATE_TO.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
                            {!opt && <option value={c.identityType}>{c.identityType}</option>}
                          </Select>
                        </div>
                        <button type="button" disabled={i === 0} onClick={() => { const n = [...draft.escalation.chain]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; setChain(n); }} className="text-gray-400 hover:text-gray-600 disabled:opacity-30"><ArrowUp size={15} /></button>
                        <button type="button" disabled={i === draft.escalation.chain.length - 1} onClick={() => { const n = [...draft.escalation.chain]; [n[i + 1], n[i]] = [n[i], n[i + 1]]; setChain(n); }} className="text-gray-400 hover:text-gray-600 disabled:opacity-30"><ArrowDown size={15} /></button>
                        <button type="button" onClick={() => setChain(draft.escalation.chain.filter((_, j) => j !== i))} className="text-gray-400 hover:text-red-600"><X size={15} /></button>
                      </div>
                      {c.identityType === "GOVERNANCE_GROUP" && (
                        <div className="ml-6 mt-1.5">
                          <Select value={c.identityId || ""} onChange={(e) => setChain(draft.escalation.chain.map((x, j) => (j === i ? { ...x, identityId: e.target.value || null, name: groups.find((g) => g.id === e.target.value)?.name || null } : x)))}>
                            <option value="">Choose a governance group…</option>
                            {groups.map((g) => <option key={g.id} value={g.id}>{g.name} ({g.memberCount ?? 0} member{g.memberCount === 1 ? "" : "s"})</option>)}
                          </Select>
                        </div>
                      )}
                      {c.identityType === "IDENTITY" && (
                        <div className="ml-6 mt-1.5">
                          <PickerField
                            label=""
                            cacheKey={`escalation-identity-${i}`}
                            placeholder="Search users…"
                            searchFn={async (s) => (await listIdentities({ limit: 15, query: s || undefined })).map((x) => ({ id: x.id, name: x.name }))}
                            multi={false}
                            selected={c.identityId ? [{ id: c.identityId, name: c.name || c.identityId }] : []}
                            onChange={(sel) => setChain(draft.escalation.chain.map((x, j) => (j === i ? { ...x, identityId: sel[0]?.id || null, name: sel[0]?.name || null } : x)))}
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              <button type="button" onClick={() => setChain([...draft.escalation.chain, { identityType: "ENTITLEMENT_OWNER", identityId: null }])} className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-700">
                <Plus size={13} /> Add escalation step
              </button>
            </div>
          )}
        </div>

        <div className="px-3 py-3">
          <Header Icon={Clock} title="Timeout" enabled={draft.timeout.enabled} onToggle={(v) => set("timeout", { enabled: v })} />
          {draft.timeout.enabled && (
            <div className="ml-6">
              <NumberField label="Time out after" value={draft.timeout.days} onChange={(v) => set("timeout", { days: v })} min={1} max={90} suffix="days (max 90)" />
              <label className="flex items-center gap-2 text-sm text-gray-700">
                <span className="w-44 flex-shrink-0 text-gray-500">When it times out</span>
                <span className="w-56">
                  <Select value={draft.timeout.result} onChange={(e) => set("timeout", { result: e.target.value })}>
                    <option value="EXPIRED">Expire the request</option>
                    <option value="APPROVED">Approve the request</option>
                  </Select>
                </span>
              </label>
            </div>
          )}
        </div>
      </div>

      <p className="text-xs text-gray-600 mt-2"><span className="font-medium">In short:</span> {summary(draft)}</p>
      {errors.map((e) => <p key={e} className="text-xs text-red-600 mt-1 flex items-start gap-1"><AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />{e}</p>)}
      {warnings.map((w) => <p key={w} className="text-xs text-amber-700 mt-1 flex items-start gap-1"><AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />{w}</p>)}

      <div className="flex flex-wrap gap-2 mt-3">
        <PrimaryButton onClick={() => save.mutate()} loading={save.isPending} disabled={errors.length > 0 || (!dirty && !inherited)} className="!w-auto">
          {inherited ? `Save as this ${noun}'s settings` : "Save timeouts, reminders and escalations"}
        </PrimaryButton>
        {dirty && <OutlineButton onClick={() => setDraft(original)} disabled={save.isPending} className="!w-auto"><RotateCcw size={14} /> Reset</OutlineButton>}
        {!inherited && (
          <OutlineButton onClick={() => revert.mutate()} loading={revert.isPending} className="!w-auto">Use tenant defaults</OutlineButton>
        )}
      </div>
    </div>
  );
}
