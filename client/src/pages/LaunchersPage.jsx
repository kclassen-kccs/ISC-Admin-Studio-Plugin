import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Rocket, Trash2, Pencil, Info, Braces, GitBranch, Play, ChevronRight, Key, ClipboardList, Plus, ShieldCheck } from "lucide-react";
import toast from "react-hot-toast";
import {
  listLaunchers, getLauncher, createLauncher, updateLauncher, makeLauncherEntitlementRequestable, deleteLaunchers, launchLauncher, listWorkflows, getWorkflow, getLauncherEntitlement, updateEntitlement, listFormDefinitions,
} from "../lib/sailpoint";
import { useUrlSearch } from "../hooks/useUrlSearch";
import { useUrlState } from "../hooks/useUrlState";
import { TopBar } from "../components/TopBar";
import { BrowseTitleMenu } from "../components/BrowseTitleMenu";
import {
  SkeletonList, ErrorBox, EmptyState, SearchBar, ConfirmModal, SelectionActionBar, IconButton, InfoRow,
  PrimaryButton, OutlineButton, Field, Input, Textarea, Select,
  SegmentedPill,
} from "../components/ui";
import { LIST_SORT_OPTIONS, sortList, updatedSuffix } from "../lib/listSort";
import { JSON_EDITOR_STYLE, highlightJson, escapeHtml, jsonParseError } from "../components/JsonEditor";
import { JsonEditTabs } from "../components/JsonTree";
import { JsonAiFix } from "../components/JsonAiFix";
import { usePagedList } from "../hooks/usePagedList";
import { LauncherApprovalPanel } from "../components/LauncherApprovalPanel";

// ISC's Launcher is replaced whole on update (PUT), and only these fields
// are accepted — id, owner and timestamps are ISC's own.
const EDITABLE_LAUNCHER_FIELDS = ["name", "description", "type", "disabled", "reference", "config"];

function launcherBody(l, overrides = {}) {
  const body = {};
  for (const k of EDITABLE_LAUNCHER_FIELDS) if (l?.[k] !== undefined) body[k] = l[k];
  return { type: "INTERACTIVE_PROCESS", disabled: false, config: "{}", ...body, ...overrides };
}

function prettyConfig(config) {
  if (config == null || config === "") return "";
  try { return JSON.stringify(JSON.parse(config), null, 2); } catch { return String(config); }
}

function StatusPill({ disabled }) {
  return (
    <span className={`text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full flex-shrink-0 ${disabled ? "bg-gray-100 text-gray-600" : "bg-emerald-50 text-emerald-700"}`}>
      {disabled ? "Disabled" : "Enabled"}
    </span>
  );
}

// ─── List ───────────────────────────────────────────────────────────────────

// Launcher-style triggers ("interactive process launched" and kin) — those
// workflows are listed first in the picker; ISC may refuse others.
const isLauncherWorkflow = (w) => /interactive|launch/i.test(`${w.trigger?.type || ""} ${w.trigger?.attributes?.id || ""}`);

function CreateLauncherModal({ onClose, onCreated }) {
  const { data: workflows, isLoading } = useQuery({ queryKey: ["workflows"], queryFn: listWorkflows, staleTime: 60_000 });
  const all = Array.isArray(workflows) ? workflows : [];
  const launcherFlows = all.filter(isLauncherWorkflow);
  const otherFlows = all.filter((w) => !isLauncherWorkflow(w));
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [workflowId, setWorkflowId] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [requestable, setRequestable] = useState(true);
  const create = useMutation({
    mutationFn: async () => {
      const created = await createLauncher({
      name: name.trim(),
      description: description.trim(),
      type: "INTERACTIVE_PROCESS",
      disabled: !enabled,
      reference: { type: "WORKFLOW", id: workflowId },
      config: "{}",
      });
      // The entitlement only exists a few minutes after the launcher; the
      // server finishes the job in the background when it's not there yet.
      let requestableStatus = null;
      if (requestable && created?.id) {
        try { requestableStatus = (await makeLauncherEntitlementRequestable(created.id)).status; }
        catch (err) { requestableStatus = `failed: ${err.response?.data?.error || err.message}`; }
      }
      return { created, requestableStatus };
    },
    onSuccess: ({ created, requestableStatus }) => {
      const label = `Created launcher "${created?.name || name.trim()}"`;
      if (requestableStatus === "done") toast.success(`${label} — its entitlement is requestable`, { duration: 7000 });
      else if (requestableStatus === "pending") toast.success(`${label} — its entitlement will be made requestable as soon as ISC creates it (usually a few minutes)`, { duration: 9000 });
      else if (requestableStatus) toast.error(`${label}, but making its entitlement requestable ${requestableStatus} — use Make requestable on the Entitlement tab`, { duration: 10000 });
      else toast.success(label);
      onCreated(created);
    },
    onError: (err) => toast.error(err.response?.data?.messages?.[0]?.text || err.response?.data?.error || err.message, { duration: 9000 }),
  });
  const picked = all.find((w) => w.id === workflowId);
  const canSave = name.trim() && description.trim() && workflowId;
  const label = (w) => `${w.name}${w.enabled === false ? " (disabled)" : ""}`;

  return (
    <div className="fixed inset-0 bg-black/30 z-30 flex items-end md:items-center justify-center" onClick={(e) => e.target === e.currentTarget && !create.isPending && onClose()}>
      <div className="bg-white w-full max-w-lg md:mx-4 rounded-t-2xl md:rounded-2xl shadow-xl p-5 max-h-[85vh] overflow-y-auto">
        <h2 className="text-base font-semibold text-gray-900 mb-4">Create launcher</h2>
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={255} placeholder="e.g. Request a new AD group" />
        </Field>
        <Field label="Description">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} placeholder="What the launcher does — shown to users in the Launchpad" />
        </Field>
        <Field label="Workflow">
          <Select value={workflowId} onChange={(e) => setWorkflowId(e.target.value)} disabled={isLoading}>
            <option value="">{isLoading ? "Loading workflows…" : "Choose a workflow…"}</option>
            {launcherFlows.length > 0 && (
              <optgroup label="Launcher-triggered workflows">
                {launcherFlows.map((w) => <option key={w.id} value={w.id}>{label(w)}</option>)}
              </optgroup>
            )}
            {otherFlows.length > 0 && (
              <optgroup label="Other workflows">
                {otherFlows.map((w) => <option key={w.id} value={w.id}>{label(w)}</option>)}
              </optgroup>
            )}
          </Select>
          {!isLoading && launcherFlows.length === 0 && (
            <p className="text-xs text-gray-400 mt-1">No workflow here has a launcher (interactive process) trigger — ISC may reject other workflows.</p>
          )}
          {picked && !isLauncherWorkflow(picked) && launcherFlows.length > 0 && (
            <p className="text-xs text-amber-700 mt-1">This workflow isn't launcher-triggered ({picked.trigger?.attributes?.id || picked.trigger?.type || "no trigger"}) — ISC may reject it.</p>
          )}
        </Field>
        <Field label="Status">
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="w-4 h-4 rounded border-gray-300 accent-blue-600" />
            <span className="text-sm text-gray-700">Enabled</span>
          </label>
        </Field>
        <Field label="Entitlement">
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={requestable} onChange={(e) => setRequestable(e.target.checked)} className="w-4 h-4 rounded border-gray-300 accent-blue-600" />
            <span className="text-sm text-gray-700">Make the launcher's entitlement requestable</span>
          </label>
          <p className="text-xs text-gray-400 mt-1">
            ISC creates the entitlement a few minutes after the launcher; it's made requestable as soon as it appears, so users can request the launcher for their Launchpad.
          </p>
        </Field>
        <div className="flex gap-2">
          <PrimaryButton onClick={() => create.mutate()} loading={create.isPending} disabled={!canSave} className="!w-auto flex-1">
            <Plus size={16} /> Create
          </PrimaryButton>
          <OutlineButton onClick={onClose} disabled={create.isPending} className="!w-auto flex-1">Cancel</OutlineButton>
        </div>
      </div>
    </div>
  );
}

export default function LaunchersPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { search, debouncedSearch, handleSearch } = useUrlSearch();
  const [selected, setSelected] = useState(() => new Set());
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  const { data, isLoading, error, refetch } = useQuery({ queryKey: ["launchers"], queryFn: listLaunchers });
  const all = useMemo(() => (Array.isArray(data) ? data : []), [data]);
  // URL-backed, so it survives opening a launcher and coming back. A–Z by default.
  const [sortBy, setSortBy] = useUrlState("sort", "name");
  const list = useMemo(() => {
    const q = debouncedSearch.trim().toLowerCase();
    const matching = q ? all.filter((l) => [l.name, l.description, l.type].some((v) => v && String(v).toLowerCase().includes(q))) : all;
    return sortList(matching, sortBy);
  }, [all, debouncedSearch, sortBy]);
  const allSelected = list.length > 0 && list.every((l) => selected.has(l.id));
  const selectedLaunchers = list.filter((l) => selected.has(l.id));
  const { page, pager } = usePagedList(list, { noun: "launcher", resetKey: `${debouncedSearch}|${sortBy}` });

  const remove = useMutation({
    mutationFn: (ids) => deleteLaunchers(ids),
    onSuccess: ({ ok, failures }) => {
      if (failures.length) toast.error(`Deleted ${ok} of ${ok + failures.length} — ${failures.map((f) => f.error).join("; ")}`);
      else toast.success(`Deleted ${ok} launcher${ok === 1 ? "" : "s"}`);
      queryClient.invalidateQueries({ queryKey: ["launchers"] });
      setDeleteConfirm(false);
      setSelected(new Set());
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  function toggle(id) {
    setSelected((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <TopBar
        title={<BrowseTitleMenu active="Launchers" />}
        loading={isLoading}
        action={<IconButton icon={Plus} title="Create Launcher" onClick={() => setCreateOpen(true)} />}
      />
      <div className="flex-1 overflow-y-auto pb-24">
        <SearchBar value={search} onChange={handleSearch} placeholder="Search launchers…" />
        <div className="flex items-center px-4 pb-2">
          <SegmentedPill label="Sort by" options={LIST_SORT_OPTIONS} active={sortBy} onChange={setSortBy} />
        </div>

        {error && <ErrorBox message={error.response?.data?.error || error.message} onRetry={refetch} />}
        {isLoading && <SkeletonList rows={6} />}
        {!isLoading && !error && list.length === 0 && (
          <EmptyState
            icon={Rocket}
            title={search ? "No results" : "No launchers"}
            subtitle={search ? `No launchers match "${search}"` : "This tenant has no launchers"}
          />
        )}

        {!isLoading && list.length > 0 && (
          <>
            <div className="flex items-center justify-between px-4 py-2 gap-3">
              <label className="flex items-center gap-2 text-xs text-gray-500">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={() => setSelected(allSelected ? new Set() : new Set(list.map((l) => l.id)))}
                  className="w-4 h-4 rounded border-gray-300"
                />
                Select all shown
              </label>
              <p className="text-xs text-gray-400">{list.length} launcher{list.length === 1 ? "" : "s"}</p>
            </div>

            {selected.size > 0 && (
              <SelectionActionBar
                count={selected.size}
                actions={[
                  {
                    icon: Trash2,
                    title: `Delete Selected Launchers (${selected.size})`,
                    onClick: () => setDeleteConfirm(true),
                    loading: remove.isPending,
                    disabled: remove.isPending,
                    danger: true,
                  },
                ]}
              />
            )}

            {pager}
            {page.map((l) => (
              <div key={l.id} className="w-full flex items-center gap-3 px-4 py-3.5 border-b border-gray-100 hover:bg-gray-50 transition-colors">
                <input type="checkbox" checked={selected.has(l.id)} onChange={() => toggle(l.id)} className="w-4 h-4 rounded border-gray-300 flex-shrink-0" />
                <button onClick={() => navigate(`/launchers/${l.id}`)} className="flex-1 min-w-0 flex items-center gap-3 text-left">
                  <div className="w-10 h-10 rounded-full bg-sky-50 flex items-center justify-center flex-shrink-0">
                    <Rocket size={16} className="text-sky-600" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{l.name}</p>
                    <p className="text-xs text-gray-500 truncate mt-0.5">{l.description || "—"}{updatedSuffix(l, sortBy)}</p>
                  </div>
                </button>
                <StatusPill disabled={!!l.disabled} />
                <button onClick={() => navigate(`/launchers/${l.id}`)} className="flex-shrink-0" title="Open">
                  <ChevronRight size={16} className="text-gray-300" />
                </button>
              </div>
            ))}
            {pager}
          </>
        )}
      </div>

      {createOpen && (
        <CreateLauncherModal
          onClose={() => setCreateOpen(false)}
          onCreated={(created) => {
            setCreateOpen(false);
            queryClient.invalidateQueries({ queryKey: ["launchers"] });
            if (created?.id) navigate(`/launchers/${created.id}`);
          }}
        />
      )}
      {deleteConfirm && (
        <ConfirmModal
          title={`Delete ${selectedLaunchers.length} launcher${selectedLaunchers.length === 1 ? "" : "s"}?`}
          message={`This permanently deletes ${selectedLaunchers.length === 1 ? `"${selectedLaunchers[0].name}"` : "the selected launchers"} from ISC. The workflows they reference are not affected. This cannot be undone.`}
          confirmLabel="Delete"
          danger
          pending={remove.isPending}
          onConfirm={() => remove.mutate(selectedLaunchers.map((l) => l.id))}
          onCancel={() => !remove.isPending && setDeleteConfirm(false)}
        />
      )}
    </div>
  );
}

// ─── Detail ─────────────────────────────────────────────────────────────────

const SECTIONS = [
  { key: "details", label: "Details", Icon: Info },
  { key: "workflow", label: "Workflow", Icon: GitBranch },
  { key: "entitlement", label: "Entitlement", Icon: Key },
  { key: "forms", label: "Forms", Icon: ClipboardList },
  { key: "approval", label: "Approval", Icon: ShieldCheck },
  { key: "json", label: "JSON", Icon: Braces },
];

const fmtWhen = (d) => (d ? new Date(d).toLocaleString() : undefined);

// A clickable header card that opens an object's own detail page.
function OpenCard({ Icon, iconClass, title, subtitle, onClick }) {
  return (
    <button onClick={onClick} className="w-full flex items-center gap-3 px-4 py-3 border border-gray-100 rounded-xl hover:bg-gray-50 text-left transition-colors mb-3">
      <div className={`w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 ${iconClass}`}>
        <Icon size={18} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-gray-900 truncate">{title}</p>
        {subtitle && <p className="text-xs text-gray-500 truncate mt-0.5">{subtitle}</p>}
      </div>
      <ChevronRight size={16} className="text-gray-300 flex-shrink-0" />
    </button>
  );
}

// The workflow the launcher runs — its own fetch so the tab shows the full
// record (trigger, steps, owner) and opens the Workflow detail screen.
function LauncherWorkflowPanel({ workflowId }) {
  const navigate = useNavigate();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["workflow", workflowId],
    queryFn: () => getWorkflow(workflowId),
    enabled: !!workflowId,
    staleTime: 60_000,
  });
  if (!workflowId) return <EmptyState icon={GitBranch} title="No workflow" subtitle="This launcher doesn't reference a workflow." />;
  if (isLoading) return <div className="px-4 py-4"><SkeletonList rows={4} /></div>;
  if (error) return <div className="px-4 py-4"><ErrorBox message={error.response?.data?.error || error.message} onRetry={refetch} /></div>;
  const steps = Object.keys(data?.definition?.steps || {}).length;
  return (
    <div className="px-4 py-4">
      <OpenCard
        Icon={GitBranch}
        iconClass="bg-indigo-50 text-indigo-600"
        title={data.name}
        subtitle={data.description || "Open the workflow"}
        onClick={() => navigate(`/workflows/${workflowId}`)}
      />
      <div className="border border-gray-100 rounded-xl overflow-hidden px-4">
        <InfoRow label="Status" value={data.enabled ? "Enabled" : "Disabled"} />
        <InfoRow label="Trigger" value={data.trigger?.type} />
        <InfoRow label="Steps" value={steps ? String(steps) : undefined} />
        <InfoRow label="Owner" value={data.owner?.name} />
        <InfoRow label="Created" value={fmtWhen(data.created)} />
        <InfoRow label="Modified" value={fmtWhen(data.modified)} />
        <InfoRow label="Workflow ID" value={data.id} />
      </div>
      {!data.enabled && <p className="text-xs text-amber-700 mt-2">The workflow is disabled, so launching won't run it until it's enabled.</p>}
    </div>
  );
}

// Forms the launcher's workflow shows — every "sp:interactive-form" step
// with a fixed formDefinitionId (a "$.…" expression is resolved at run time,
// so it's listed as dynamic). Each links to the form's details on Forms.
function LauncherFormsPanel({ workflowId, launcherName }) {
  const navigate = useNavigate();
  const wf = useQuery({ queryKey: ["workflow", workflowId], queryFn: () => getWorkflow(workflowId), enabled: !!workflowId, staleTime: 60_000 });
  const forms = useQuery({ queryKey: ["form-definitions"], queryFn: listFormDefinitions, staleTime: 60_000 });
  if (!workflowId) return <EmptyState icon={ClipboardList} title="No workflow" subtitle="This launcher doesn't reference a workflow, so it shows no forms." />;
  if (wf.isLoading) return <div className="px-4 py-4"><SkeletonList rows={3} /></div>;
  if (wf.error) return <div className="px-4 py-4"><ErrorBox message={wf.error.response?.data?.error || wf.error.message} onRetry={wf.refetch} /></div>;
  const byId = new Map((Array.isArray(forms.data) ? forms.data : []).map((f) => [f.id, f]));
  const steps = Object.entries(wf.data?.definition?.steps || {}).filter(([, st]) => st?.actionId === "sp:interactive-form");
  if (steps.length === 0) return <EmptyState icon={ClipboardList} title="No forms" subtitle="The launcher's workflow has no form steps." />;
  return (
    <div className="px-4 py-4">
      <p className="text-xs text-gray-400 mb-2">{steps.length} form step{steps.length === 1 ? "" : "s"} in "{wf.data.name}"</p>
      <div className="border border-gray-100 rounded-xl overflow-hidden divide-y divide-gray-100">
        {steps.map(([stepName, st]) => {
          const formId = st.attributes?.formDefinitionId;
          const fixed = typeof formId === "string" && formId && !formId.startsWith("$");
          const form = fixed ? byId.get(formId) : null;
          const Row = fixed ? "button" : "div";
          return (
            <Row
              key={stepName}
              {...(fixed ? { onClick: () => navigate(`/forms?form=${encodeURIComponent(formId)}`, { state: { returnLabel: `launcher "${launcherName}"` } }) } : {})}
              className={`w-full px-3 py-2.5 flex items-center gap-3 text-left ${fixed ? "hover:bg-gray-50" : ""}`}
            >
              <ClipboardList size={16} className="text-gray-500 flex-shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-gray-900 truncate">
                  {fixed ? (form?.name || (forms.isLoading ? "Loading…" : formId)) : "Form chosen at run time"}
                </p>
                <p className="text-xs text-gray-500 truncate">
                  Step: {st.displayName || stepName}{!fixed && formId ? ` · ${formId}` : ""}{fixed && !form && !forms.isLoading ? " · form not found in this tenant" : ""}
                </p>
              </div>
              {fixed && <ChevronRight size={16} className="text-gray-300 flex-shrink-0" />}
            </Row>
          );
        })}
      </div>
    </div>
  );
}

// The entitlement ISC generated for the launcher (internal IdentityNow
// source) — what has to be requestable and assigned for the launcher to
// show in a user's Launchpad.
function LauncherEntitlementPanel({ launcherId }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const setRequestable = useMutation({
    mutationFn: ({ id, requestable }) => updateEntitlement(id, { requestable }),
    onSuccess: (_d, { requestable }) => {
      toast.success(requestable ? "Entitlement is now requestable" : "Entitlement is no longer requestable");
      queryClient.invalidateQueries({ queryKey: ["launcher-entitlement", launcherId] });
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message, { duration: 8000 }),
  });
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["launcher-entitlement", launcherId],
    queryFn: () => getLauncherEntitlement(launcherId),
    staleTime: 60_000,
  });
  if (isLoading) return <div className="px-4 py-4"><SkeletonList rows={4} /></div>;
  if (error) return <div className="px-4 py-4"><ErrorBox message={error.response?.data?.error || error.message} onRetry={refetch} /></div>;
  const e = data?.entitlement;
  if (!e) {
    return (
      <EmptyState
        icon={Key}
        title="No entitlement found yet"
        subtitle={data?.reason || (data?.pendingRequestable
          ? "ISC hasn't created the launcher's entitlement yet — it will be made requestable automatically when it appears (usually a few minutes)."
          : "ISC creates the launcher's entitlement on its IdentityNow source shortly after the launcher is created — check back in a few minutes.")}
        action={<div className="mt-3"><OutlineButton onClick={() => refetch()} className="!w-auto">Check again</OutlineButton></div>}
      />
    );
  }
  return (
    <div className="px-4 py-4">
      <OpenCard
        Icon={Key}
        iconClass="bg-amber-50 text-amber-600"
        title={e.displayName || e.name}
        subtitle={e.description || "Open the entitlement"}
        onClick={() => navigate(`/entitlements/${e.id}`)}
      />
      <div className="border border-gray-100 rounded-xl overflow-hidden px-4">
        <InfoRow label="Source" value={e.source?.name} />
        <InfoRow label="Requestable" value={e.requestable ? "Yes" : "No"} />
        <InfoRow label="Privileged" value={e.privileged ? "Yes" : "No"} />
        <InfoRow label="Owner" value={e.owner?.name} />
        <InfoRow label="Attribute" value={e.attribute} />
        <InfoRow label="Value" value={e.value} />
        <InfoRow label="Type" value={e.sourceSchemaObjectType} />
        <InfoRow label="Entitlement ID" value={e.id} />
      </div>
      {!e.requestable && (
        <p className="text-xs text-amber-700 mt-2">Not requestable — the launcher only appears in a user's Launchpad once this entitlement is requestable and assigned to them.</p>
      )}
      <div className="mt-3">
        {e.requestable ? (
          <OutlineButton onClick={() => setRequestable.mutate({ id: e.id, requestable: false })} loading={setRequestable.isPending} className="!w-auto">
            Make not requestable
          </OutlineButton>
        ) : (
          <PrimaryButton onClick={() => setRequestable.mutate({ id: e.id, requestable: true })} loading={setRequestable.isPending} className="!w-auto">
            Make requestable
          </PrimaryButton>
        )}
      </div>
    </div>
  );
}

// Edit form: everything ISC accepts on a launcher. Config is a JSON string
// in ISC, so it's edited as text and validated before Save.
function EditLauncherModal({ launcher, workflows, onClose, onSave, pending }) {
  const [name, setName] = useState(launcher.name || "");
  const [description, setDescription] = useState(launcher.description || "");
  const [disabled, setDisabled] = useState(!!launcher.disabled);
  const [workflowId, setWorkflowId] = useState(launcher.reference?.id || "");
  const [config, setConfig] = useState(prettyConfig(launcher.config) || "{}");
  const configError = jsonParseError(config);
  const canSave = name.trim() && description.trim() && workflowId && !configError;

  return (
    <div className="fixed inset-0 bg-black/30 z-30 flex items-end md:items-center justify-center" onClick={(e) => e.target === e.currentTarget && !pending && onClose()}>
      <div className="bg-white w-full max-w-lg md:mx-4 rounded-t-2xl md:rounded-2xl shadow-xl p-5 max-h-[85vh] overflow-y-auto">
        <h2 className="text-base font-semibold text-gray-900 mb-4">Edit launcher</h2>
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={255} />
        </Field>
        <Field label="Description">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} />
        </Field>
        <Field label="Workflow">
          <Select value={workflowId} onChange={(e) => setWorkflowId(e.target.value)}>
            <option value="">Choose a workflow…</option>
            {!workflows.some((w) => w.id === workflowId) && workflowId && <option value={workflowId}>{workflowId}</option>}
            {workflows.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </Select>
        </Field>
        <Field label="Status">
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={!disabled} onChange={(e) => setDisabled(!e.target.checked)} className="w-4 h-4 rounded border-gray-300 accent-blue-600" />
            <span className="text-sm text-gray-700">Enabled</span>
          </label>
        </Field>
        <Field label="Config (JSON, max 4 KB)">
          <Textarea value={config} onChange={(e) => setConfig(e.target.value)} rows={6} spellCheck={false} />
          <p className={`text-xs mt-1 ${configError ? "text-red-600" : "text-emerald-600"}`}>{configError ? `Invalid JSON: ${configError}` : "Valid JSON"}</p>
          <JsonAiFix text={config} error={configError} onApply={setConfig} />
        </Field>
        <div className="flex gap-2 mt-2">
          <PrimaryButton
            onClick={() => onSave({ name: name.trim(), description: description.trim(), disabled, reference: { type: "WORKFLOW", id: workflowId }, config: JSON.stringify(JSON.parse(config)) })}
            loading={pending}
            disabled={!canSave}
            className="!w-auto flex-1"
          >
            Save
          </PrimaryButton>
          <OutlineButton onClick={onClose} disabled={pending} className="!w-auto flex-1">Cancel</OutlineButton>
        </div>
      </div>
    </div>
  );
}

// JSON tab — same PUT-based editor Transforms/Workflows use, since ISC
// replaces a launcher whole rather than accepting JSON-Patch.
function JsonPanel({ data, launcherId }) {
  const queryClient = useQueryClient();
  const pretty = useMemo(() => JSON.stringify(data, null, 2), [data]);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(pretty);
  const parseError = editing ? jsonParseError(text) : null;

  const save = useMutation({
    mutationFn: () => updateLauncher(launcherId, launcherBody(JSON.parse(text))),
    onSuccess: () => {
      toast.success("Launcher saved");
      setEditing(false);
      queryClient.invalidateQueries({ queryKey: ["launcher", launcherId] });
      queryClient.invalidateQueries({ queryKey: ["launchers"] });
    },
    onError: (err) => toast.error(err.response?.data?.messages?.[0]?.text || err.response?.data?.error || err.message),
  });

  return (
    <div className="px-4 py-4">
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs text-gray-500">
          {editing ? "Only name, description, type, disabled, reference and config are sent; id, owner and timestamps are ISC's." : "The launcher's full definition as ISC returns it."}
        </p>
        {!editing ? <IconButton icon={Pencil} title="Edit JSON" onClick={() => { setText(pretty); setEditing(true); }} /> : null}
      </div>
      {!editing ? (
        <pre className="border border-gray-200 rounded-xl overflow-auto text-gray-800 bg-gray-50" style={JSON_EDITOR_STYLE} dangerouslySetInnerHTML={{ __html: highlightJson(escapeHtml(pretty)) }} />
      ) : (
        <>
          <JsonEditTabs text={text} onChange={setText} minHeight="240px" title={`${data?.name || launcherId} — launcher`} />
          <div className="flex gap-2 mt-3">
            <PrimaryButton onClick={() => save.mutate()} loading={save.isPending} disabled={!!parseError} className="!w-auto flex-1">Save</PrimaryButton>
            <OutlineButton onClick={() => setEditing(false)} disabled={save.isPending} className="!w-auto flex-1">Cancel</OutlineButton>
          </div>
        </>
      )}
    </div>
  );
}

export function LauncherDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [section, setSection] = useUrlState("tab", "details");
  const [editOpen, setEditOpen] = useState(false);
  const [launchConfirm, setLaunchConfirm] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);

  const { data, isLoading, error, refetch } = useQuery({ queryKey: ["launcher", id], queryFn: () => getLauncher(id) });
  const { data: workflows } = useQuery({ queryKey: ["workflows"], queryFn: listWorkflows, staleTime: 60_000 });
  const workflowList = Array.isArray(workflows) ? workflows : [];
  const listed = data?.reference?.id ? workflowList.find((w) => w.id === data.reference.id) : null;
  // Resolve the referenced workflow's name directly when it isn't in the
  // loaded list, so the reference never shows as a bare id.
  const referenced = useQuery({
    queryKey: ["workflow", data?.reference?.id],
    queryFn: () => getWorkflow(data.reference.id),
    enabled: !!data?.reference?.id && !listed && Array.isArray(workflows),
    staleTime: 60_000,
  });
  const workflow = listed || (referenced.data?.id ? referenced.data : null);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["launcher", id] });
    queryClient.invalidateQueries({ queryKey: ["launchers"] });
  };
  const save = useMutation({
    mutationFn: (fields) => updateLauncher(id, launcherBody(data, fields)),
    onSuccess: () => { toast.success("Launcher updated"); setEditOpen(false); refresh(); },
    onError: (err) => toast.error(err.response?.data?.messages?.[0]?.text || err.response?.data?.error || err.message),
  });
  const launch = useMutation({
    mutationFn: () => launchLauncher(id),
    onSuccess: (result) => {
      toast.success(`Launched "${data?.name}" in ISC${result?.id ? ` — interactive process ${result.id}` : ""}`, { duration: 6000 });
      setLaunchConfirm(false);
    },
    onError: (err) => toast.error(err.response?.data?.messages?.[0]?.text || err.response?.data?.error || err.message),
  });
  const remove = useMutation({
    mutationFn: () => deleteLaunchers([id]),
    onSuccess: ({ failures }) => {
      if (failures.length) { toast.error(failures[0].error); return; }
      toast.success(`Deleted "${data?.name}"`);
      queryClient.invalidateQueries({ queryKey: ["launchers"] });
      navigate("/launchers");
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <TopBar
        title="Launcher"
        onBack={() => navigate("/launchers")}
        action={
          data && (
            <div className="flex items-center gap-2">
              <IconButton icon={Play} title="Launch in Identity Security Cloud" onClick={() => setLaunchConfirm(true)} loading={launch.isPending} disabled={!!data.disabled} />
              <IconButton icon={Pencil} title="Edit launcher" onClick={() => setEditOpen(true)} />
              <IconButton icon={Trash2} title="Delete launcher" onClick={() => setDeleteConfirm(true)} loading={remove.isPending} className="!border-red-200 !text-red-600 hover:!bg-red-50" />
            </div>
          )
        }
      />
      <div className="flex-1 overflow-y-auto pb-24">
        {isLoading && <div className="px-4 py-4"><SkeletonList rows={6} /></div>}
        {error && <div className="px-4 py-4"><ErrorBox message={error.response?.data?.error || error.message} onRetry={refetch} /></div>}
        {data && (
          <>
            <div className="px-4 py-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-sky-50 flex items-center justify-center flex-shrink-0">
                  <Rocket size={18} className="text-sky-600" />
                </div>
                <div className="min-w-0 flex-1">
                  <h2 className="text-base font-semibold text-gray-900 truncate">{data.name}</h2>
                  <p className="text-xs text-gray-500 mt-0.5">{data.type || "INTERACTIVE_PROCESS"}{workflow ? ` · ${workflow.name}` : ""}</p>
                </div>
                <StatusPill disabled={!!data.disabled} />
              </div>
              {data.description && <p className="text-sm text-gray-600 leading-relaxed mt-3">{data.description}</p>}
              {data.disabled && <p className="text-xs text-amber-700 mt-2">Disabled launchers can't be launched — enable it from Edit first.</p>}
            </div>

            <div className="flex border-t border-gray-100">
              <div className="w-28 flex-shrink-0 border-r border-gray-100 py-2">
                {SECTIONS.map(({ key, label, Icon }) => (
                  <button key={key} onClick={() => setSection(key)} className={`w-full flex flex-col items-center gap-1 px-2 py-3 text-xs font-medium transition-colors ${section === key ? "text-blue-600 bg-blue-50" : "text-gray-400 hover:text-gray-600"}`}>
                    <Icon size={18} />
                    {label}
                  </button>
                ))}
              </div>
              <div className="flex-1 min-w-0">
                {section === "details" && (
                  <div className="px-4 py-4">
                    <div className="border border-gray-100 rounded-xl overflow-hidden px-4">
                      <InfoRow label="Name" value={data.name} />
                      <InfoRow label="Type" value={data.type} />
                      <InfoRow label="Status" value={data.disabled ? "Disabled" : "Enabled"} />
                      <InfoRow label="Workflow" value={workflow ? workflow.name : data.reference?.id} />
                      <InfoRow label="Workflow ID" value={data.reference?.id} />
                      <InfoRow label="Owner" value={data.owner?.name} />
                      <InfoRow label="Created" value={data.created ? new Date(data.created).toLocaleString() : undefined} />
                      <InfoRow label="Modified" value={data.modified ? new Date(data.modified).toLocaleString() : undefined} />
                      <InfoRow label="Launcher ID" value={data.id} />
                    </div>
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mt-4 mb-1">Config</p>
                    <pre className="border border-gray-200 rounded-xl overflow-auto text-gray-800 bg-gray-50 text-xs p-3 whitespace-pre-wrap break-words">{prettyConfig(data.config) || "{}"}</pre>
                  </div>
                )}
                {section === "workflow" && <LauncherWorkflowPanel workflowId={data.reference?.id} />}
                {section === "entitlement" && <LauncherEntitlementPanel launcherId={id} />}
                {section === "forms" && <LauncherFormsPanel workflowId={data.reference?.id} launcherName={data.name} />}
                {section === "approval" && <LauncherApprovalPanel launcherId={id} />}
                {section === "json" && <JsonPanel data={data} launcherId={id} />}
              </div>
            </div>
          </>
        )}
      </div>

      {editOpen && data && (
        <EditLauncherModal launcher={data} workflows={workflowList} onClose={() => setEditOpen(false)} onSave={(fields) => save.mutate(fields)} pending={save.isPending} />
      )}
      {launchConfirm && data && (
        <ConfirmModal
          title={`Launch "${data.name}"?`}
          message={`This starts the launcher in ISC${workflow ? ` — it runs the "${workflow.name}" workflow as an interactive process` : ""}. Whatever that workflow does will happen now.`}
          confirmLabel="Launch"
          pending={launch.isPending}
          onConfirm={() => launch.mutate()}
          onCancel={() => !launch.isPending && setLaunchConfirm(false)}
        />
      )}
      {deleteConfirm && data && (
        <ConfirmModal
          title={`Delete "${data.name}"?`}
          message="This permanently deletes the launcher from ISC. The workflow it references is not affected. This cannot be undone."
          confirmLabel="Delete"
          danger
          pending={remove.isPending}
          onConfirm={() => remove.mutate()}
          onCancel={() => !remove.isPending && setDeleteConfirm(false)}
        />
      )}
    </div>
  );
}
