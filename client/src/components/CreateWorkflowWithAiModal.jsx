import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Sparkles, HelpCircle, Lightbulb, X, ShieldCheck } from "lucide-react";
import toast from "react-hot-toast";
import { toastWorkflowError } from "./workflowErrorToast";
import { draftWorkflowOutline, createWorkflowFromOutline, validateWorkflowDraft } from "../lib/sailpoint";
import { PrimaryButton, OutlineButton, Spinner, Textarea } from "./ui";
import { WorkflowOutlineFlowchart } from "./WorkflowOutlineFlowchart";
import { WorkflowValidationResult } from "./WorkflowValidation";

const errText = (err) => err.response?.data?.error || err.response?.data?.messages?.[0]?.text || err.message;

const EXAMPLES = [
  "When an identity's department changes, email their manager with the old and new department and ask them to review the person's access.",
  "Every Monday at 8am, find identities that have been inactive for 90 days and email a list of them to the IT Security team.",
  "When a new identity is created, wait one day, then send them a welcome email; if they have no manager, email the help desk instead.",
];

// Busy states get a sentence, not just a spinner — these calls run up to a
// minute or two on a capable model, and silence reads as broken.
function Working({ children }) {
  return <p className="text-sm text-gray-600 flex items-center gap-2 py-6 justify-center"><Spinner size={16} /> {children}</p>;
}

// The proposal: the flowchart (each box says what that step will do, and
// ordinary steps can be moved), then what the AI assumed and wants to know.
function Outline({ outline, onChange, reordered }) {
  const list = (items) => (Array.isArray(items) ? items.filter((x) => typeof x === "string" && x.trim()) : []);
  const assumptions = list(outline.assumptions);
  const questions = list(outline.questions);
  return (
    <div>
      <h3 className="text-base font-semibold text-gray-900">{outline.name}</h3>
      {outline.description && <p className="text-sm text-gray-600 mt-1">{outline.description}</p>}
      <p className="text-[11px] text-gray-400 mt-2 mb-3">
        Use the arrows on a step to move it earlier or later. Steps around a decision can't be moved by hand — describe that kind of change under "Want changes?".
      </p>

      <WorkflowOutlineFlowchart outline={outline} onChange={onChange} />

      {reordered && (
        <p className="mt-4 text-xs text-gray-600 border border-gray-200 bg-gray-50 rounded-xl px-3 py-2.5">
          You've changed the order. A step can only use information from steps that run before it — when the workflow is built, the AI wires each step's inputs to fit the new order, and leaves a placeholder where something is no longer available.
        </p>
      )}
      {assumptions.length > 0 && (
        <div className="mt-4 border border-amber-200 bg-amber-50/60 rounded-xl px-3 py-2.5">
          <p className="text-xs font-semibold text-amber-800 flex items-center gap-1.5"><Lightbulb size={13} /> Assumptions the AI made</p>
          <ul className="mt-1 space-y-0.5 list-disc pl-4">{assumptions.map((a, i) => <li key={i} className="text-xs text-gray-700">{a}</li>)}</ul>
        </div>
      )}
      {questions.length > 0 && (
        <div className="mt-3 border border-violet-200 bg-violet-50/60 rounded-xl px-3 py-2.5">
          <p className="text-xs font-semibold text-violet-800 flex items-center gap-1.5"><HelpCircle size={13} /> Questions for you — answer them in a revision</p>
          <ul className="mt-1 space-y-0.5 list-disc pl-4">{questions.map((q, i) => <li key={i} className="text-xs text-gray-700">{q}</li>)}</ul>
        </div>
      )}
    </div>
  );
}

// Workflows > Create with AI. Three moves: describe it → review the outline
// (revise as often as needed) → approve, which builds the real workflow and
// saves it DISABLED. `onCreated(workflow)` once it exists in ISC.
export function CreateWorkflowWithAiModal({ onClose, onCreated }) {
  const queryClient = useQueryClient();
  const [requirements, setRequirements] = useState("");
  const [outline, setOutline] = useState(null);
  const [feedback, setFeedback] = useState("");
  const [revisions, setRevisions] = useState(0);
  const [reordered, setReordered] = useState(false);
  const [buildProblems, setBuildProblems] = useState(null);

  const draft = useMutation({
    mutationFn: () => draftWorkflowOutline({ requirements: requirements.trim() }),
    onSuccess: (o) => { setOutline(o); setRevisions(0); setReordered(false); setFeedback(""); setBuildProblems(null); },
    onError: (err) => toastWorkflowError(errText(err)),
  });
  const revise = useMutation({
    mutationFn: () => draftWorkflowOutline({ requirements: requirements.trim(), outline, feedback: feedback.trim() }),
    onSuccess: (o) => { setOutline(o); setRevisions((n) => n + 1); setReordered(false); setFeedback(""); setBuildProblems(null); },
    onError: (err) => toastWorkflowError(errText(err)),
  });
  const create = useMutation({
    mutationFn: () => createWorkflowFromOutline({ requirements: requirements.trim(), outline }),
    onSuccess: ({ workflow, placeholders }) => {
      queryClient.invalidateQueries({ queryKey: ["workflows"] });
      toast.success(
        `"${workflow.name}" created — disabled. ${placeholders?.length ? `Fill in ${placeholders.length} placeholder${placeholders.length === 1 ? "" : "s"} (${placeholders.slice(0, 3).join(", ")}${placeholders.length > 3 ? "…" : ""}), review it, then enable it.` : "Review it, then enable it."}`,
        { duration: 12000 }
      );
      onCreated(workflow);
    },
    onError: (err) => {
      if (err.response?.data?.problems) setBuildProblems(err.response.data.problems);
      toastWorkflowError(errText(err));
    },
  });

  // The outline as it stands — the AI's was validated when it was drafted, but
  // a hand reorder makes it the user's, and that hasn't been checked.
  const [validation, setValidation] = useState(null); // { state, problems, key }
  const outlineKey = outline ? JSON.stringify(outline) : null;
  const validate = useMutation({
    mutationFn: async () => ({ ...(await validateWorkflowDraft({ outline })), key: JSON.stringify(outline) }),
    onSuccess: setValidation,
    onError: (err) => toastWorkflowError(errText(err)),
  });
  // The built workflow is validated again server-side before it's saved; this
  // stops a broken outline from costing a minute's build first.
  const validateThenCreate = async () => {
    const r = await validate.mutateAsync().catch(() => null);
    if (r?.state === "OK") create.mutate();
  };

  const busy = draft.isPending || revise.isPending || create.isPending || validate.isPending;

  return (
    <div className="fixed inset-0 bg-black/30 z-30 flex items-end md:items-center justify-center" onClick={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className={`bg-white w-full ${outline ? "max-w-4xl" : "max-w-2xl"} md:mx-4 rounded-t-2xl md:rounded-2xl shadow-xl max-h-[92vh] flex flex-col`}>
        <div className="flex items-center justify-between gap-3 px-5 pt-5 pb-3 border-b border-gray-100">
          <h2 className="text-base font-semibold text-gray-900 flex items-center gap-2"><Sparkles size={16} className="text-violet-600" /> Create a workflow with AI</h2>
          <button onClick={() => !busy && onClose()} disabled={busy} className="text-gray-400 hover:text-gray-600 disabled:opacity-40" title="Close"><X size={18} /></button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {!outline && !draft.isPending && (
            <>
              <p className="text-sm text-gray-600 mb-3">Describe what the workflow should do — what starts it, what it should do, and anything it should decide along the way. You'll get an outline to review before anything is created.</p>
              <Textarea value={requirements} onChange={(e) => setRequirements(e.target.value)} rows={7} placeholder="e.g. When an identity's department changes, email their manager…" />
              <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mt-3 mb-1">Examples — tap to use</p>
              <div className="space-y-1.5">
                {EXAMPLES.map((ex) => (
                  <button key={ex} onClick={() => setRequirements(ex)} className="w-full text-left text-xs text-gray-600 border border-gray-200 rounded-lg px-3 py-2 hover:bg-gray-50 transition-colors">{ex}</button>
                ))}
              </div>
              <p className="text-[11px] text-gray-400 mt-3">Your description and this tenant's workflow library (trigger and action names) are sent to the AI provider.</p>
            </>
          )}
          {draft.isPending && <Working>Designing an outline from your tenant's triggers and actions — this can take up to a minute…</Working>}

          {outline && !create.isPending && (
            <>
              {revise.isPending ? <Working>Revising the outline…</Working> : <Outline outline={outline} reordered={reordered} onChange={(next) => { setOutline(next); setReordered(true); setBuildProblems(null); }} />}
              {buildProblems && (
                <div className="mt-4 border border-red-200 bg-red-50 rounded-xl px-3 py-2.5 text-xs text-red-700">
                  <p className="font-medium">The workflow built from this outline didn't pass validation, so nothing was saved:</p>
                  <ul className="mt-1 list-disc pl-4 space-y-0.5">{buildProblems.slice(0, 6).map((p, i) => <li key={i}>{p}</li>)}</ul>
                  <p className="mt-1">Approve again to retry, or revise the outline to simplify the part it's tripping on.</p>
                </div>
              )}
              {!revise.isPending && <WorkflowValidationResult result={validation} stale={!!validation && validation.key !== outlineKey} />}
              {!revise.isPending && validation?.state === "ERROR" && validation.key === outlineKey && (
                <p className="text-xs text-gray-600 mt-1.5">Move the step back, or describe what you want under "Want changes?" and let the AI redo the outline.</p>
              )}
              {!revise.isPending && (
                <div className="mt-5">
                  <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-1">Want changes?{revisions > 0 ? ` · revised ${revisions}×` : ""}</p>
                  <Textarea value={feedback} onChange={(e) => setFeedback(e.target.value)} rows={3} placeholder="e.g. Also CC the help desk. Skip contractors. Wait 2 days before the reminder." />
                </div>
              )}
            </>
          )}
          {create.isPending && <Working>Building the workflow from the approved outline, checking it, and saving it to ISC — this can take a minute or two…</Working>}
        </div>

        <div className="px-5 py-4 border-t border-gray-100 flex flex-col md:flex-row gap-2">
          {!outline ? (
            <>
              <PrimaryButton onClick={() => { setValidation(null); draft.mutate(); }} loading={draft.isPending} disabled={!requirements.trim()} className="!w-auto md:flex-1">Propose an Outline</PrimaryButton>
              <OutlineButton onClick={onClose} disabled={busy} className="!w-auto md:flex-1">Cancel</OutlineButton>
            </>
          ) : (
            <>
              <OutlineButton onClick={() => validate.mutate()} loading={validate.isPending} disabled={busy} className="!w-auto md:flex-1"><ShieldCheck size={16} /> Validate</OutlineButton>
              <PrimaryButton onClick={validateThenCreate} loading={create.isPending} disabled={busy} className="!w-auto md:flex-1">Validate & Create Workflow</PrimaryButton>
              <OutlineButton onClick={() => revise.mutate()} loading={revise.isPending} disabled={busy || !feedback.trim()} className="!w-auto md:flex-1">Revise Outline</OutlineButton>
              <OutlineButton onClick={() => { setOutline(null); setBuildProblems(null); }} disabled={busy} className="!w-auto md:flex-1">Start Over</OutlineButton>
            </>
          )}
        </div>
        {outline && <p className="px-5 pb-4 -mt-2 text-[11px] text-gray-400">Approving creates the workflow <span className="font-medium">disabled</span> — nothing runs until you've reviewed it and enabled it yourself.</p>}
      </div>
    </div>
  );
}
