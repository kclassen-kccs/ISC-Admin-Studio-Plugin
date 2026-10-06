import { useMemo, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GitBranch, Info, Braces, Pencil, Maximize2, Minimize2, History, Play, Pause, Trash2, Sparkles, ShieldCheck } from "lucide-react";
import toast from "react-hot-toast";
import { toastWorkflowError } from "../components/workflowErrorToast";
import { getWorkflow, updateWorkflow, setWorkflowEnabled, deleteWorkflow, validateWorkflowDraft } from "../lib/sailpoint";
import { useUrlState } from "../hooks/useUrlState";
import { TopBar } from "../components/TopBar";
import { FormPreviewModal } from "./FormsPage";
import { StepFieldsEditor } from "../components/WorkflowStepFields";
import { describeWorkflowTrigger } from "./WorkflowsPage";
import { InfoRow, SkeletonList, ErrorBox, IconButton, PrimaryButton, OutlineButton, ConfirmModal } from "../components/ui";
import { JSON_EDITOR_STYLE, highlightJson, escapeHtml, jsonParseError } from "../components/JsonEditor";
import { JsonEditTabs } from "../components/JsonTree";
import { WorkflowExecutionsPanel } from "../components/WorkflowExecutionsPanel";
import { ModifyWorkflowWithAiModal } from "../components/ModifyWorkflowWithAiModal";
import { WorkflowValidationResult } from "../components/WorkflowValidation";
import { WorkflowAiFix, workflowFixInstructions } from "../components/WorkflowAiFix";

const SECTIONS = [
  { key: "details", label: "Details", Icon: Info },
  { key: "json", label: "JSON", Icon: Braces },
  { key: "flowchart", label: "Workflow", Icon: GitBranch },
  { key: "executions", label: "Executions", Icon: History },
];

// The only fields ISC's PUT /workflows/{id} accepts — everything else on
// the GET payload (id, created, modified, creator, modifiedBy, execution/
// failure counts) is read-only and gets rejected if sent back.
const EDITABLE_WORKFLOW_FIELDS = ["name", "description", "owner", "definition", "enabled", "trigger"];

// ISC only accepts changes to a DISABLED workflow. Saving an enabled one
// means disable → save → re-enable (the server does it, and restores the
// enabled state even if the save is rejected) — but triggers that fire in
// that moment are missed, so it's confirmed first rather than done quietly.
function SaveEnabledWorkflowConfirm({ pending, onConfirm, onCancel }) {
  return (
    <ConfirmModal
      title="This workflow is enabled"
      message="ISC only accepts changes to a disabled workflow. To save, it will be disabled, updated, and enabled again — a few seconds in which a trigger that fires is missed. If the save is rejected, it is re-enabled unchanged."
      confirmLabel="Disable, Save & Re-enable"
      pending={pending}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}

const saveErrorText = (err) => err.response?.data?.error || err.response?.data?.messages?.[0]?.text || err.message;

// What to tell the user once a save went through.
function toastSaved(result, label) {
  if (result?.wasDisabledToSave && !result.reenabled && result.reenableError) {
    // reenableError is ISC's own text — often the multi-line validation list.
    toastWorkflowError(`${label}, but the workflow could not be re-enabled — it is currently DISABLED.\n${result.reenableError}`);
  } else {
    toast.success(result?.wasDisabledToSave && result.reenabled ? `${label} — the workflow was re-enabled` : label);
  }
}

// Validate / Validate & Save for an editor. `candidate()` returns the workflow
// as it WOULD be saved ({ name, description, trigger, definition }) or null
// when it can't be built yet (unparseable JSON). ISC has no validate call — it
// only validates on enable — so this is the app's structural check, run
// before a save rather than discovered after one.
function useWorkflowValidation(candidate) {
  const [result, setResult] = useState(null); // { state, problems, key }
  const current = candidate();
  const key = current ? JSON.stringify(current) : null;
  const run = useMutation({
    mutationFn: async () => {
      const workflow = candidate();
      return { ...(await validateWorkflowDraft({ workflow })), key: JSON.stringify(workflow) };
    },
    onSuccess: setResult,
    onError: (err) => toastWorkflowError(saveErrorText(err)),
  });
  return { result, stale: !!result && result.key !== key, candidate: current, run, clear: () => setResult(null) };
}

// View + edit for the workflow's raw JSON. A parse failure disables Save
// and shows the parser's own message.
function JsonPanel({ data, workflowId }) {
  const queryClient = useQueryClient();
  const pretty = useMemo(() => JSON.stringify(data, null, 2), [data]);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(pretty);

  const parseError = editing ? jsonParseError(text) : null;
  const [confirmEnabled, setConfirmEnabled] = useState(false);

  const save = useMutation({
    mutationFn: (allowDisable) => {
      const parsed = JSON.parse(text);
      const body = {};
      for (const key of EDITABLE_WORKFLOW_FIELDS) {
        if (parsed[key] !== undefined) body[key] = parsed[key];
      }
      return updateWorkflow(workflowId, body, { allowDisable });
    },
    onSuccess: (result) => {
      toastSaved(result, "Workflow saved");
      setConfirmEnabled(false);
      setEditing(false);
      queryClient.invalidateQueries({ queryKey: ["workflow", workflowId] });
      queryClient.invalidateQueries({ queryKey: ["workflows"] });
      queryClient.removeQueries({ queryKey: ["workflow-flowchart", workflowId] });
    },
    onError: (err) => {
      setConfirmEnabled(false);
      // Enabled since this page loaded it — ask, then save with the dance.
      if (err.response?.data?.code === "WORKFLOW_ENABLED") return setConfirmEnabled(true);
      toastWorkflowError(saveErrorText(err));
      queryClient.invalidateQueries({ queryKey: ["workflow", workflowId] });
    },
  });
  const startSave = () => (data.enabled ? setConfirmEnabled(true) : save.mutate(false));

  const validation = useWorkflowValidation(() => {
    if (!editing || jsonParseError(text)) return null;
    const parsed = JSON.parse(text);
    return { name: parsed.name, description: parsed.description, trigger: parsed.trigger, definition: parsed.definition };
  });
  const validateThenSave = async () => {
    const r = await validation.run.mutateAsync().catch(() => null);
    if (r?.state === "OK") startSave();
  };

  return (
    <div className="px-4 py-4">
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs text-gray-500">
          {editing
            ? "Read-only fields (id, timestamps, counters) are ignored on save."
            : "The workflow's full definition as ISC returns it."}
        </p>
        {!editing ? (
          <IconButton icon={Pencil} title="Edit JSON" onClick={() => { setText(pretty); setEditing(true); }} />
        ) : null}
      </div>

      {!editing ? (
        <pre
          className="border border-gray-200 rounded-xl overflow-auto text-gray-800 bg-gray-50"
          style={JSON_EDITOR_STYLE}
          dangerouslySetInnerHTML={{ __html: highlightJson(escapeHtml(pretty)) }}
        />
      ) : (
        <>
          <JsonEditTabs text={text} onChange={setText} minHeight="240px" title={`${data?.name || workflowId} — workflow`} />
          <WorkflowValidationResult result={validation.result} stale={validation.stale} onSaveAnyway={startSave} savingAnyway={save.isPending} />
          {validation.result?.state === "ERROR" && !validation.stale && validation.candidate && (
            <WorkflowAiFix
              workflowId={workflowId}
              base={validation.candidate}
              problems={validation.result.problems}
              describeApply={{
                note: "Replaces the JSON in the editor — review it, then Validate & Save.",
                // Only the four fields the AI returns change; id, owner, counters stay as typed.
                apply: (fixed) => { setText(JSON.stringify({ ...JSON.parse(text), ...fixed }, null, 2)); validation.clear(); },
              }}
            />
          )}
          <div className="flex flex-col md:flex-row gap-2 mt-3">
            <OutlineButton onClick={() => validation.run.mutate()} loading={validation.run.isPending} disabled={!!parseError || save.isPending} className="!w-auto md:flex-1">
              <ShieldCheck size={16} />
              Validate
            </OutlineButton>
            <PrimaryButton onClick={validateThenSave} loading={save.isPending || validation.run.isPending} disabled={!!parseError} className="!w-auto md:flex-1">
              Validate & Save
            </PrimaryButton>
            <OutlineButton onClick={() => { setEditing(false); validation.clear(); }} disabled={save.isPending} className="!w-auto md:flex-1">
              Cancel
            </OutlineButton>
          </div>
        </>
      )}
      {confirmEnabled && (
        <SaveEnabledWorkflowConfirm pending={save.isPending} onConfirm={() => save.mutate(true)} onCancel={() => !save.isPending && setConfirmEnabled(false)} />
      )}
    </div>
  );
}

// Editor for one node clicked on the flowchart — the trigger, or a single
// entry from definition.steps. Saves by splicing the edited fragment back
// into the full workflow and PUTting the editable fields, same contract as
// the whole-document editor above.
function StepEditorSheet({ workflow, stepName, onClose }) {
  const queryClient = useQueryClient();
  const isTrigger = stepName === "__trigger__";
  const stepJson = isTrigger ? workflow.trigger : workflow.definition?.steps?.[stepName];
  // Structured (Fields) mode covers action and choice steps — the trigger
  // and anything else keeps the raw JSON editor only.
  const supportsFields = !isTrigger && (stepJson?.type === "action" || stepJson?.type === "choice");
  const [mode, setMode] = useState(supportsFields ? "fields" : "json");
  // Two drafts, synced at tab switches: `draft` backs Fields mode (typed
  // state — can't be malformed), `text` backs the JSON tab.
  const [draft, setDraft] = useState(() => (stepJson ? JSON.parse(JSON.stringify(stepJson)) : null));
  const [text, setText] = useState(() => JSON.stringify(stepJson ?? null, null, 2));
  const [expanded, setExpanded] = useState(false);
  const parseError = jsonParseError(text);

  const switchMode = (next) => {
    if (next === mode) return;
    if (next === "json") {
      setText(JSON.stringify(draft, null, 2));
    } else {
      if (parseError) {
        toast.error("Fix the JSON before switching to Fields — it isn't valid yet.");
        return;
      }
      setDraft(JSON.parse(text));
    }
    setMode(next);
  };

  const [confirmEnabled, setConfirmEnabled] = useState(false);
  const save = useMutation({
    mutationFn: (allowDisable) => {
      const parsed = mode === "fields" ? draft : JSON.parse(text);
      const body = {};
      for (const key of EDITABLE_WORKFLOW_FIELDS) {
        if (workflow[key] !== undefined) body[key] = workflow[key];
      }
      if (isTrigger) {
        body.trigger = parsed;
      } else {
        body.definition = {
          ...workflow.definition,
          steps: { ...workflow.definition?.steps, [stepName]: parsed },
        };
      }
      return updateWorkflow(workflow.id, body, { allowDisable });
    },
    onSuccess: (result) => {
      toastSaved(result, isTrigger ? "Trigger saved" : `Step "${stepName}" saved`);
      setConfirmEnabled(false);
      queryClient.invalidateQueries({ queryKey: ["workflow", workflow.id] });
      queryClient.invalidateQueries({ queryKey: ["workflows"] });
      queryClient.removeQueries({ queryKey: ["workflow-flowchart", workflow.id] });
      onClose();
    },
    onError: (err) => {
      setConfirmEnabled(false);
      if (err.response?.data?.code === "WORKFLOW_ENABLED") return setConfirmEnabled(true);
      toastWorkflowError(saveErrorText(err));
      queryClient.invalidateQueries({ queryKey: ["workflow", workflow.id] });
    },
  });
  const startSave = () => (workflow.enabled ? setConfirmEnabled(true) : save.mutate(false));

  // The whole workflow with this step's edit spliced in — a step is only
  // valid or not in context (does its nextStep exist? is it still reachable?).
  const validation = useWorkflowValidation(() => {
    if (stepJson === undefined || (mode === "json" && parseError)) return null;
    const parsed = mode === "fields" ? draft : JSON.parse(text);
    return {
      name: workflow.name,
      description: workflow.description,
      trigger: isTrigger ? parsed : workflow.trigger,
      definition: isTrigger ? workflow.definition : { ...workflow.definition, steps: { ...workflow.definition?.steps, [stepName]: parsed } },
    };
  });
  const validateThenSave = async () => {
    const r = await validation.run.mutateAsync().catch(() => null);
    if (r?.state === "OK") startSave();
  };
  // A fix is proposed for the whole workflow, but this dialog edits one step:
  // take this step's part, and say so if the fix reached beyond it.
  const applyFix = (fixed, diff) => {
    const mine = isTrigger ? fixed.trigger : fixed.definition?.steps?.[stepName];
    if (mine === undefined) return toast.error(`The fix removes "${stepName}" — apply it from the JSON tab instead.`);
    setDraft(JSON.parse(JSON.stringify(mine)));
    setText(JSON.stringify(mine, null, 2));
    validation.clear();
    const others = [...diff.added, ...diff.removed, ...diff.changed.filter((n) => n !== stepName), ...(diff.triggerChanged && !isTrigger ? ["the trigger"] : [])];
    if (others.length) toast(`Applied this step's part. The full fix also touches ${others.join(", ")} — use Edit JSON on the JSON tab to apply all of it.`, { duration: 10000 });
  };

  return (
    <div
      className="fixed inset-0 bg-black/30 z-30 flex items-end md:items-center justify-center"
      onClick={(e) => e.target === e.currentTarget && !save.isPending && onClose()}
    >
      <div
        className={`bg-white md:mx-4 rounded-t-2xl md:rounded-2xl shadow-xl overflow-y-auto p-5 ${
          expanded ? "w-[80vw] max-w-[80vw] h-[80vh] max-h-[80vh]" : "w-full max-w-2xl max-h-[85vh]"
        }`}
      >
        <div className="flex items-start justify-between gap-3 mb-1">
          <h2 className="text-base font-semibold text-gray-900 min-w-0 truncate">
            {isTrigger ? "Trigger" : stepName}
          </h2>
          <IconButton
            icon={expanded ? Minimize2 : Maximize2}
            title={expanded ? "Shrink dialog" : "Expand dialog"}
            onClick={() => setExpanded((v) => !v)}
          />
        </div>
        <p className="text-xs text-gray-400 mb-2">
          {isTrigger
            ? "The workflow's trigger configuration."
            : "This step's entry from definition.steps — saving splices it back into the workflow."}
        </p>

        {supportsFields && (
          <div className="flex border-b border-gray-100 mb-3">
            {["fields", "json"].map((m) => (
              <button
                key={m}
                onClick={() => switchMode(m)}
                className={`flex-1 text-center text-xs font-medium py-2 border-b-2 transition-colors ${
                  mode === m ? "text-blue-600 border-blue-600 bg-blue-50" : "text-gray-400 border-transparent hover:text-gray-600"
                }`}
              >
                {m === "fields" ? "Fields" : "JSON"}
              </button>
            ))}
          </div>
        )}

        {stepJson === undefined ? (
          <ErrorBox message={`The flowchart labeled this node "${stepName}", but no step with that key exists in the definition. Regenerate the flowchart, or edit from the JSON tab.`} />
        ) : mode === "fields" && draft ? (
          <StepFieldsEditor workflow={workflow} stepName={stepName} draft={draft} onChange={setDraft} />
        ) : (
          <>
            <JsonEditTabs
              text={text}
              onChange={setText}
              minHeight={expanded ? "calc(80vh - 260px)" : "200px"}
              title={`${workflow?.name || "Workflow"} — step "${stepName}"`}
            />
          </>
        )}

        <WorkflowValidationResult result={validation.result} stale={validation.stale} onSaveAnyway={startSave} savingAnyway={save.isPending} />
        {validation.result?.state === "ERROR" && !validation.stale && validation.candidate && (
          <WorkflowAiFix
            workflowId={workflow.id}
            base={validation.candidate}
            problems={validation.result.problems}
            applyLabel={isTrigger ? "Apply to the trigger" : "Apply to this step"}
            describeApply={{ note: "Updates this editor — review it, then Validate & Save.", apply: applyFix }}
          />
        )}
        <div className="flex flex-col md:flex-row gap-2 mt-3">
          {stepJson !== undefined && (
            <>
              <OutlineButton onClick={() => validation.run.mutate()} loading={validation.run.isPending} disabled={(mode === "json" && !!parseError) || save.isPending} className="!w-auto md:flex-1">
                <ShieldCheck size={16} />
                Validate
              </OutlineButton>
              <PrimaryButton onClick={validateThenSave} loading={save.isPending || validation.run.isPending} disabled={mode === "json" && !!parseError} className="!w-auto md:flex-1">
                Validate & Save
              </PrimaryButton>
            </>
          )}
          <OutlineButton onClick={onClose} disabled={save.isPending} className="!w-auto md:flex-1">
            {stepJson === undefined ? "Close" : "Cancel"}
          </OutlineButton>
        </div>
      </div>
      {confirmEnabled && (
        <SaveEnabledWorkflowConfirm pending={save.isPending} onConfirm={() => save.mutate(true)} onCancel={() => !save.isPending && setConfirmEnabled(false)} />
      )}
    </div>
  );
}

// ─── Deterministic flowchart ────────────────────────────────────────────────
// The workflow definition is already a graph — start step, nextStep links,
// choiceList branches, defaultStep fallbacks — so the chart is computed
// directly from it: no AI call, instant, and every node is guaranteed to
// carry a real definition.steps key for click-to-edit.

const COMPARATOR_SYMBOLS = {
  StringEquals: "=", StringNotEquals: "≠", NumericEquals: "=", NumericNotEquals: "≠",
  NumericGreaterThan: ">", NumericLessThan: "<", BooleanEquals: "=",
  StringContains: "contains", StringStartsWith: "starts with", StringEndsWith: "ends with",
};

function choiceEdgeLabel(choice) {
  const op = COMPARATOR_SYMBOLS[choice.comparator] || choice.comparator || "";
  const val = choice.variableB != null ? `"${choice.variableB}"` : "";
  return [op, val].filter(Boolean).join(" ") || "matches";
}

// nodes: Map(name -> {type, subtitle}); edges: [{from, to, label}].
function buildWorkflowGraph(workflow) {
  const steps = workflow.definition?.steps || {};
  const nodes = new Map();
  const edges = [];
  nodes.set("__trigger__", { type: "trigger", subtitle: describeWorkflowTrigger(workflow.trigger) });
  for (const [name, step] of Object.entries(steps)) {
    const subtitle =
      step.type === "action"
        ? (step.actionId || "").replace(/^sp:/, "")
        : step.type === "choice"
        ? "decision"
        : step.type; // success / failure / anything else
    // Interactive Form steps carry the form they present — surfaced on the
    // node as a link into the form preview dialog. Only literal ids count;
    // an expression ("$.…") can't be resolved without running the workflow.
    const formDefinitionId =
      step.actionId === "sp:interactive-form" &&
      typeof step.attributes?.formDefinitionId === "string" &&
      !step.attributes.formDefinitionId.startsWith("$")
        ? step.attributes.formDefinitionId
        : null;
    nodes.set(name, { type: step.type, subtitle, formDefinitionId });
    if (step.nextStep) edges.push({ from: name, to: step.nextStep, label: null });
    for (const c of step.choiceList || []) {
      if (c.nextStep) edges.push({ from: name, to: c.nextStep, label: choiceEdgeLabel(c) });
    }
    if (step.defaultStep) edges.push({ from: name, to: step.defaultStep, label: "otherwise" });
  }
  if (workflow.definition?.start) {
    edges.push({ from: "__trigger__", to: workflow.definition.start, label: null });
  }

  // Longest-path layering from the trigger (workflow graphs are small, and
  // the stack guard turns any loop into a back-edge instead of recursing
  // forever). Unreachable steps still get drawn, in a final row.
  const levels = new Map();
  const assign = (name, lvl, stack) => {
    if (!nodes.has(name) || stack.has(name)) return;
    if ((levels.get(name) ?? -1) >= lvl) return;
    levels.set(name, lvl);
    stack.add(name);
    for (const e of edges) if (e.from === name) assign(e.to, lvl + 1, stack);
    stack.delete(name);
  };
  assign("__trigger__", 0, new Set());
  const maxLevel = Math.max(0, ...levels.values());
  for (const name of nodes.keys()) {
    if (!levels.has(name)) levels.set(name, maxLevel + 1);
  }
  return { nodes, edges, levels };
}

const FLOW_COLORS = {
  trigger: { fill: "#f3f4f6", stroke: "#d1d5db", title: "#374151", sub: "#6b7280" },
  choice: { fill: "#f5f3ff", stroke: "#ddd6fe", title: "#6d28d9", sub: "#8b5cf6" },
  action: { fill: "#f0fdfa", stroke: "#99f6e4", title: "#0f766e", sub: "#14b8a6" },
  success: { fill: "#f3f4f6", stroke: "#d1d5db", title: "#374151", sub: "#6b7280" },
  failure: { fill: "#fef2f2", stroke: "#fecaca", title: "#b91c1c", sub: "#ef4444" },
};

function truncate(s, max) {
  return s && s.length > max ? s.slice(0, max - 1) + "…" : s || "";
}

function WorkflowFlowchart({ workflow, onSelectStep, onOpenForm }) {
  const { nodes, edges, levels } = useMemo(() => buildWorkflowGraph(workflow), [workflow]);

  const NODE_H = 44;
  const ROW_GAP = 36;
  const COL_GAP = 16;
  const WIDTH = 680;

  // Per-level horizontal packing, centered.
  const byLevel = new Map();
  for (const [name, lvl] of levels) {
    if (!byLevel.has(lvl)) byLevel.set(lvl, []);
    byLevel.get(lvl).push(name);
  }
  const pos = new Map(); // name -> {x, y, w}
  for (const [lvl, names] of byLevel) {
    const k = names.length;
    const w = Math.min(180, (WIDTH - 40 - (k - 1) * COL_GAP) / k);
    const total = k * w + (k - 1) * COL_GAP;
    let x = (WIDTH - total) / 2;
    const y = 20 + lvl * (NODE_H + ROW_GAP);
    for (const name of names) {
      pos.set(name, { x, y, w });
      x += w + COL_GAP;
    }
  }
  const height = 20 + (Math.max(0, ...levels.values()) + 1) * (NODE_H + ROW_GAP) - ROW_GAP + 20;

  return (
    <svg width="100%" viewBox={`0 0 ${WIDTH} ${height}`} role="img">
      <title>{`${workflow.name} flowchart`}</title>
      <defs>
        <marker id="wf-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M2 1L8 5L2 9" fill="none" stroke="#9ca3af" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </marker>
      </defs>

      {edges.map((e, i) => {
        const from = pos.get(e.from);
        const to = pos.get(e.to);
        if (!from || !to) return null;
        const x1 = from.x + from.w / 2;
        const y1 = from.y + NODE_H;
        const x2 = to.x + to.w / 2;
        const y2 = to.y;
        const forward = y2 > y1;
        // Back/lateral edges (loops) swing out to the right margin instead
        // of slashing through the layout.
        const d = forward
          ? `M ${x1} ${y1} C ${x1} ${y1 + 16}, ${x2} ${y2 - 16}, ${x2} ${y2}`
          : `M ${from.x + from.w} ${from.y + NODE_H / 2} C ${WIDTH - 8} ${from.y + NODE_H / 2}, ${WIDTH - 8} ${to.y - 24}, ${x2} ${to.y}`;
        const labelX = forward ? (x1 + x2) / 2 : WIDTH - 30;
        const labelY = forward ? (y1 + y2) / 2 : (from.y + to.y) / 2;
        return (
          <g key={i}>
            <path d={d} fill="none" stroke="#9ca3af" strokeWidth="1.2" markerEnd="url(#wf-arrow)" />
            {e.label && (
              <text
                x={labelX} y={labelY} textAnchor="middle" dominantBaseline="central"
                fontSize="10" fill="#6b7280" stroke="#ffffff" strokeWidth="3" paintOrder="stroke"
                style={{ fontFamily: "inherit" }}
              >
                {truncate(e.label, 24)}
              </text>
            )}
          </g>
        );
      })}

      {[...nodes.entries()].map(([name, node]) => {
        const p = pos.get(name);
        if (!p) return null;
        const colors = FLOW_COLORS[node.type] || FLOW_COLORS.action;
        const title = name === "__trigger__" ? "Trigger" : name;
        const charBudget = Math.floor(p.w / 6.5);
        return (
          <g key={name} onClick={() => onSelectStep(name)} style={{ cursor: "pointer" }}>
            <rect x={p.x} y={p.y} width={p.w} height={NODE_H} rx="8" fill={colors.fill} stroke={colors.stroke} strokeWidth="1" />
            <text x={p.x + p.w / 2} y={p.y + 16} textAnchor="middle" dominantBaseline="central" fontSize="12" fontWeight="600" fill={colors.title}>
              {truncate(title, charBudget)}
            </text>
            <text x={p.x + p.w / 2} y={p.y + 31} textAnchor="middle" dominantBaseline="central" fontSize="10" fill={colors.sub}>
              {truncate(node.subtitle, charBudget + 4)}
            </text>
            {node.formDefinitionId && onOpenForm && (
              // Corner badge on Interactive Form steps — opens the form's
              // own preview dialog rather than the step's JSON editor.
              <g
                onClick={(e) => { e.stopPropagation(); onOpenForm(node.formDefinitionId); }}
                style={{ cursor: "pointer" }}
              >
                <title>Open form preview</title>
                <circle cx={p.x + p.w - 11} cy={p.y + 11} r="8" fill="#eef2ff" stroke="#c7d2fe" strokeWidth="1" />
                <text x={p.x + p.w - 11} y={p.y + 11.5} textAnchor="middle" dominantBaseline="central" fontSize="9" fill="#4f46e5" fontWeight="700">
                  ⧉
                </text>
              </g>
            )}
          </g>
        );
      })}
    </svg>
  );
}

// Deterministic flowchart computed straight from the definition — every
// node's click opens that exact step's editor.
function FlowchartPanel({ workflow }) {
  const [selectedStep, setSelectedStep] = useState(null); // steps key, or "__trigger__"
  const [previewFormId, setPreviewFormId] = useState(null);

  return (
    <div className="px-4 py-4">
      <p className="text-xs text-gray-500 mb-3">
        Generated from the workflow definition — click a step to view and edit its JSON. Form steps carry a
        badge that opens the form's own preview.
      </p>
      <div className="border border-gray-100 rounded-xl p-3">
        <WorkflowFlowchart workflow={workflow} onSelectStep={setSelectedStep} onOpenForm={setPreviewFormId} />
      </div>
      {selectedStep && (
        <StepEditorSheet workflow={workflow} stepName={selectedStep} onClose={() => setSelectedStep(null)} />
      )}
      {previewFormId && <FormPreviewModal formId={previewFormId} onClose={() => setPreviewFormId(null)} />}
    </div>
  );
}

export default function WorkflowDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [section, setSection] = useUrlState("tab", "details");

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["workflow", id],
    queryFn: () => getWorkflow(id),
  });

  const trigger = data?.trigger;
  const triggerFilter = trigger?.attributes?.["filter.$"];

  const queryClient = useQueryClient();
  const [disableConfirm, setDisableConfirm] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [aiModifyOpen, setAiModifyOpen] = useState(false);
  // ISC's validation errors from a refused Enable — offered to the AI to fix.
  const [enableProblems, setEnableProblems] = useState(null);
  const [aiFix, setAiFix] = useState(null);
  const remove = useMutation({
    mutationFn: () => deleteWorkflow(id),
    onSuccess: () => {
      toast.success(`Deleted "${data?.name}"`);
      queryClient.invalidateQueries({ queryKey: ["workflows"] });
      queryClient.removeQueries({ queryKey: ["workflow", id] });
      navigate("/workflows", { replace: true });
    },
    onError: (err) => {
      setDeleteConfirm(false);
      toastWorkflowError(saveErrorText(err));
      queryClient.invalidateQueries({ queryKey: ["workflow", id] });
    },
  });
  const setEnabled = useMutation({
    mutationFn: (enabled) => setWorkflowEnabled(id, enabled),
    onSuccess: (_wf, enabled) => {
      toast.success(enabled ? "Workflow enabled — it now runs when its trigger fires" : "Workflow disabled");
      setDisableConfirm(false);
      queryClient.invalidateQueries({ queryKey: ["workflow", id] });
      queryClient.invalidateQueries({ queryKey: ["workflows"] });
    },
    onError: (err) => {
      setDisableConfirm(false);
      // A refused Enable comes back as ISC's headline + one line per problem
      // (see the server's iscWorkflowErrorText). That's the one moment ISC
      // validates a workflow, so it gets a dialog that can act on the errors
      // rather than a toast that can only show them.
      const [, ...lines] = saveErrorText(err).split("\n");
      const problems = lines.map((l) => l.replace(/^•\s*/, "").trim()).filter(Boolean);
      if (problems.length) setEnableProblems(problems);
      else toastWorkflowError(saveErrorText(err));
    },
  });

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <TopBar
        title="Workflow"
        onBack={() => navigate(-1)}
        action={
          data && (
            <div className="flex items-center gap-2">
              <IconButton icon={Sparkles} title="Modify this workflow with AI" onClick={() => setAiModifyOpen(true)} className="!border-violet-300 !text-violet-700 hover:!bg-violet-50" />
              {/* Both always shown, the one that doesn't apply greyed out —
                  the pair doubles as a read of the current state. Disabling
                  a live workflow is confirmed; enabling isn't (ISC validates
                  it and refuses an incomplete workflow itself). */}
              <IconButton
                icon={Play}
                title={data.enabled ? "Already enabled" : "Enable workflow"}
                onClick={() => setEnabled.mutate(true)}
                loading={setEnabled.isPending && setEnabled.variables === true}
                disabled={data.enabled || setEnabled.isPending}
                className={data.enabled ? "" : "!border-emerald-300 !text-emerald-700 hover:!bg-emerald-50"}
              />
              <IconButton
                icon={Pause}
                title={data.enabled ? "Disable workflow" : "Already disabled"}
                onClick={() => setDisableConfirm(true)}
                loading={setEnabled.isPending && setEnabled.variables === false}
                disabled={!data.enabled || setEnabled.isPending}
                className={data.enabled ? "!border-amber-300 !text-amber-700 hover:!bg-amber-50" : ""}
              />
              <IconButton icon={Trash2} title="Delete workflow" onClick={() => setDeleteConfirm(true)} loading={remove.isPending} className="!border-red-200 !text-red-600 hover:!bg-red-50" />
            </div>
          )
        }
      />
      {deleteConfirm && data && (
        <ConfirmModal
          title={`Delete "${data.name}"?`}
          message={`This permanently deletes the workflow from ISC, including its run history. It cannot be undone.${data.enabled ? " It is enabled, so it will be disabled first — ISC won't delete a running workflow." : ""}`}
          confirmLabel="Delete Workflow"
          danger
          pending={remove.isPending}
          onConfirm={() => remove.mutate()}
          onCancel={() => !remove.isPending && setDeleteConfirm(false)}
        />
      )}
      {enableProblems && data && (
        <div className="fixed inset-0 bg-black/30 z-30 flex items-end md:items-center justify-center" onClick={(e) => e.target === e.currentTarget && setEnableProblems(null)}>
          <div className="bg-white w-full max-w-lg md:mx-4 rounded-t-2xl md:rounded-2xl shadow-xl p-5 max-h-[85vh] overflow-y-auto">
            <h2 className="text-base font-semibold text-gray-900 mb-1">ISC won't enable this workflow</h2>
            <p className="text-xs text-gray-500 mb-3">ISC validates a workflow when it's enabled — saving accepts almost anything. Fix {enableProblems.length === 1 ? "this" : "these"}, then enable it again.</p>
            <ul className="border border-red-200 bg-red-50 rounded-xl px-3 py-2.5 text-xs text-red-700 list-disc pl-7 space-y-1.5">
              {enableProblems.map((p, i) => <li key={i} className="break-words">{p}</li>)}
            </ul>
            <div className="flex flex-col md:flex-row gap-2 mt-4">
              <PrimaryButton
                onClick={() => { setAiFix({ instructions: workflowFixInstructions(enableProblems, "isc"), problems: enableProblems }); setEnableProblems(null); }}
                className="!w-auto md:flex-1 !bg-violet-600 hover:!bg-violet-700 active:!bg-violet-800"
              >
                <Sparkles size={16} />
                Propose a Fix with AI
              </PrimaryButton>
              <OutlineButton onClick={() => setEnableProblems(null)} className="!w-auto md:flex-1">I'll Fix It Myself</OutlineButton>
            </div>
          </div>
        </div>
      )}
      {(aiModifyOpen || aiFix) && data && (
        <ModifyWorkflowWithAiModal
          workflow={data}
          fix={aiFix}
          // Read-only: the same chart as the Workflow tab, but clicking a
          // step of a PROPOSAL has nothing saved to edit yet.
          renderFlowchart={(wf) => <WorkflowFlowchart workflow={wf} onSelectStep={() => {}} />}
          onClose={() => { setAiModifyOpen(false); setAiFix(null); }}
          onSaved={() => { setAiModifyOpen(false); setAiFix(null); setSection("flowchart"); }}
        />
      )}
      {disableConfirm && data && (
        <ConfirmModal
          title={`Disable "${data.name}"?`}
          message="The workflow stops running: its trigger no longer starts it, and events that occur while it's disabled are not replayed when it's enabled again. Runs already in progress are not cancelled."
          confirmLabel="Disable Workflow"
          pending={setEnabled.isPending}
          onConfirm={() => setEnabled.mutate(false)}
          onCancel={() => !setEnabled.isPending && setDisableConfirm(false)}
        />
      )}
      <div className="flex-1 overflow-y-auto pb-24">
        {isLoading && <SkeletonList rows={6} />}
        {error && <ErrorBox message={error.message} onRetry={refetch} />}

        {data && (
          <>
            <div className="px-4 py-4 flex items-center gap-3">
              <div className="w-12 h-12 rounded-full bg-cyan-50 flex items-center justify-center flex-shrink-0">
                <GitBranch size={20} className="text-cyan-700" />
              </div>
              <div className="flex-1 min-w-0">
                <h2 className="text-base font-semibold text-gray-900 truncate">{data.name}</h2>
                <span
                  className={`text-xs font-medium px-2 py-0.5 rounded-full border inline-block mt-1 ${
                    data.enabled
                      ? "bg-green-50 text-green-700 border-green-200"
                      : "bg-gray-50 text-gray-500 border-gray-200"
                  }`}
                >
                  {data.enabled ? "Enabled" : "Disabled"}
                </span>
              </div>
            </div>

            <div className="flex border-t border-gray-100">
              <div className="w-28 flex-shrink-0 border-r border-gray-100 py-2">
                {SECTIONS.map(({ key, label, Icon }) => (
                  <button
                    key={key}
                    onClick={() => setSection(key)}
                    className={`w-full flex flex-col items-center gap-1 px-2 py-3 text-xs font-medium transition-colors ${
                      section === key ? "text-blue-600 bg-blue-50" : "text-gray-400 hover:text-gray-600"
                    }`}
                  >
                    <Icon size={18} />
                    {label}
                  </button>
                ))}
              </div>

              <div className="flex-1 min-w-0">
                {section === "details" && (
                  <div className="px-4 py-4">
                    {data.description && (
                      <p className="text-sm text-gray-600 leading-relaxed mb-4">{data.description}</p>
                    )}
                    <div className="border border-gray-100 rounded-xl overflow-hidden px-3">
                      <InfoRow label="Name" value={data.name} />
                      <InfoRow label="Status" value={data.enabled ? "Enabled" : "Disabled"} />
                      <InfoRow label="Trigger" value={describeWorkflowTrigger(trigger)} />
                      <InfoRow label="Trigger filter" value={triggerFilter} />
                      <InfoRow label="Created" value={data.created ? new Date(data.created).toLocaleString() : undefined} />
                      <InfoRow label="Last modified" value={data.modified ? new Date(data.modified).toLocaleString() : undefined} />
                      <InfoRow label="Owner" value={data.owner?.name} />
                      <InfoRow label="Executions" value={data.executionCount != null ? String(data.executionCount) : undefined} />
                      <InfoRow label="Failures" value={data.failureCount != null ? String(data.failureCount) : undefined} />
                      <InfoRow label="Workflow ID" value={data.id} />
                    </div>
                  </div>
                )}
                {section === "json" && <JsonPanel data={data} workflowId={id} />}
                {section === "flowchart" && <FlowchartPanel workflow={data} />}
                {section === "executions" && <WorkflowExecutionsPanel workflow={data} />}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
