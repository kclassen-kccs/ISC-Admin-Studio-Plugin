import { useEffect } from "react";
import { useMutation } from "@tanstack/react-query";
import { Sparkles, Plus, Minus, PenLine } from "lucide-react";
import { proposeWorkflowModification } from "../lib/sailpoint";
import { toastWorkflowError } from "./workflowErrorToast";
import { Spinner } from "./ui";

// The instruction the AI gets for a fix: the problems verbatim, and a hard
// fence around everything else — a fix that also "improves" the workflow is a
// change nobody asked for.
export function workflowFixInstructions(problems, source = "validation") {
  return (
    `This workflow fails ${source === "isc" ? "ISC's validation (the errors below are ISC's own words)" : "validation"}. ` +
    "Fix exactly these problems and change nothing else — no renamed steps, no reworded text, no restructuring beyond what a problem requires:\n" +
    problems.map((p) => `- ${p}`).join("\n")
  );
}

// "Propose a fix with AI" for a workflow that fails validation, inline under
// the problems. It proposes against `base` — what's in the editor right now,
// saved or not — shows what it would change (computed by the server) and why,
// and applies only when told to. `onApply(fixedWorkflow)` gets
// { name, description, trigger, definition }; what "apply" means is the
// host's call (replace the JSON text, take one step, …).
export function WorkflowAiFix({ workflowId, base, problems, applyLabel = "Apply fix", describeApply }) {
  const fix = useMutation({
    mutationFn: () => proposeWorkflowModification(workflowId, { instructions: workflowFixInstructions(problems), base }),
    onError: (err) => toastWorkflowError(err.response?.data?.error || err.message),
  });
  // A proposal is for the exact problems it was asked about.
  const { reset } = fix;
  const key = problems.join("\n");
  useEffect(() => { reset(); }, [key, reset]);

  if (!fix.data) {
    return (
      <div className="mt-2 flex items-center flex-wrap gap-2">
        <button
          onClick={() => fix.mutate()}
          disabled={fix.isPending}
          className="inline-flex items-center justify-center gap-1.5 bg-violet-600 hover:bg-violet-700 active:bg-violet-800 disabled:opacity-60 text-white font-semibold text-xs px-3.5 py-2 rounded-lg shadow-sm transition-colors"
        >
          {fix.isPending ? <Spinner size={14} className="!text-white" /> : <Sparkles size={14} />}
          {fix.isPending ? "Working out a fix — up to a minute…" : "Propose a fix with AI"}
        </button>
        {!fix.isPending && <span className="text-[11px] text-gray-500">Sends this workflow and your tenant's workflow library to the AI provider. Nothing is changed until you apply it.</span>}
      </div>
    );
  }

  const { diff, summary, notes, placeholders, workflow } = fix.data;
  const rows = [
    ...diff.added.map((n) => ({ Icon: Plus, tone: "text-emerald-700", text: `Step added: ${n}` })),
    ...diff.removed.map((n) => ({ Icon: Minus, tone: "text-red-700", text: `Step removed: ${n}` })),
    ...diff.changed.map((n) => ({ Icon: PenLine, tone: "text-amber-700", text: `Step changed: ${n}` })),
    ...(diff.triggerChanged ? [{ Icon: PenLine, tone: "text-amber-700", text: "Trigger changed" }] : []),
    ...(diff.startChanged ? [{ Icon: PenLine, tone: "text-amber-700", text: "First step changed" }] : []),
  ];
  return (
    <div className="mt-2 border border-violet-100 bg-violet-50/40 rounded-lg px-3 py-2.5 text-gray-700">
      <p className="text-xs font-semibold text-gray-900 flex items-center gap-1.5 mb-1.5"><Sparkles size={14} className="text-violet-600" /> Proposed fix — passes validation</p>
      <ul className="space-y-0.5 mb-2">{rows.map((r, i) => <li key={i} className={`text-xs flex items-center gap-1.5 ${r.tone}`}><r.Icon size={12} className="flex-shrink-0" /> {r.text}</li>)}</ul>
      <ul className="list-disc pl-4 space-y-1">{summary.map((t, i) => <li key={i} className="text-xs text-gray-800">{t}</li>)}</ul>
      {(notes.length > 0 || placeholders.length > 0) && (
        <ul className="list-disc pl-4 space-y-0.5 mt-2">
          {placeholders.length > 0 && <li className="text-xs text-amber-800">Placeholders to fill in: <span className="font-mono">{placeholders.join(", ")}</span></li>}
          {notes.map((n, i) => <li key={i} className="text-xs text-amber-800">{n}</li>)}
        </ul>
      )}
      <div className="flex items-center flex-wrap gap-2 mt-2.5">
        <button
          onClick={() => { describeApply.apply(workflow, diff); reset(); }}
          className="inline-flex items-center justify-center gap-1.5 bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white font-semibold text-xs px-3.5 py-2 rounded-lg shadow-sm transition-colors"
        >
          {applyLabel}
        </button>
        <button onClick={() => reset()} className="text-xs font-medium text-gray-600 hover:bg-gray-100 px-3 py-2 rounded-lg transition-colors">Dismiss</button>
        <span className="text-[11px] text-gray-400">{describeApply.note}</span>
      </div>
    </div>
  );
}
