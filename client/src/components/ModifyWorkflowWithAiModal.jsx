import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Sparkles, X, Plus, Minus, PenLine, Info, ShieldCheck } from "lucide-react";
import toast from "react-hot-toast";
import { toastWorkflowError } from "./workflowErrorToast";
import { proposeWorkflowModification, updateWorkflow, validateWorkflowDraft } from "../lib/sailpoint";
import { PrimaryButton, OutlineButton, Spinner, Textarea, ConfirmModal } from "./ui";
import { WorkflowValidationResult } from "./WorkflowValidation";

const errText = (err) => err.response?.data?.error || err.response?.data?.messages?.[0]?.text || err.message;

function Working({ children }) {
  return <p className="text-sm text-gray-600 flex items-center gap-2 py-6 justify-center"><Spinner size={16} /> {children}</p>;
}

// What differs, as computed by the server from the two definitions — shown
// above the AI's own account so the review doesn't rest on the model's word.
function ComputedChanges({ diff }) {
  const rows = [
    ...diff.added.map((n) => ({ Icon: Plus, tone: "text-emerald-700", text: `Step added: ${n}` })),
    ...diff.removed.map((n) => ({ Icon: Minus, tone: "text-red-700", text: `Step removed: ${n}` })),
    ...diff.changed.map((n) => ({ Icon: PenLine, tone: "text-amber-700", text: `Step changed: ${n}` })),
    ...(diff.triggerChanged ? [{ Icon: PenLine, tone: "text-amber-700", text: "Trigger changed" }] : []),
    ...(diff.startChanged ? [{ Icon: PenLine, tone: "text-amber-700", text: "First step changed" }] : []),
    ...(diff.renamed ? [{ Icon: PenLine, tone: "text-amber-700", text: "Workflow renamed" }] : []),
    ...(diff.descriptionChanged ? [{ Icon: PenLine, tone: "text-amber-700", text: "Description changed" }] : []),
  ];
  if (rows.length === 0) return <p className="text-xs text-gray-500">The proposal is identical to the current workflow — nothing would change.</p>;
  return (
    <ul className="space-y-0.5">
      {rows.map((r, i) => <li key={i} className={`text-xs flex items-center gap-1.5 ${r.tone}`}><r.Icon size={12} className="flex-shrink-0" /> {r.text}</li>)}
    </ul>
  );
}

// Workflow detail > Modify with AI. Describe the change → review the proposal
// (what changed, the AI's explanation, the new flowchart; revise as needed) →
// approve, which saves it. Nothing touches ISC before approval.
// `renderFlowchart(workflow)` draws a workflow the way the Workflow tab does.
// `fix` ({ instructions, problems }) opens it as "Fix with AI": the change is
// already written (ISC's validation errors, verbatim) and proposing starts at
// once — the user lands on the proposal rather than on an empty box.
export function ModifyWorkflowWithAiModal({ workflow, renderFlowchart, onClose, onSaved, fix }) {
  const queryClient = useQueryClient();
  const [instructions, setInstructions] = useState(fix?.instructions || "");
  const [proposal, setProposal] = useState(null);
  const [feedback, setFeedback] = useState("");
  const [problems, setProblems] = useState(null);
  const [confirmEnabled, setConfirmEnabled] = useState(false);

  const onProposeError = (err) => {
    if (err.response?.data?.problems) setProblems(err.response.data.problems);
    toastWorkflowError(errText(err));
  };
  const propose = useMutation({
    mutationFn: () => proposeWorkflowModification(workflow.id, { instructions: instructions.trim() }),
    onSuccess: (p) => { setProposal(p); setFeedback(""); setProblems(null); },
    onError: onProposeError,
  });
  const autoStarted = useRef(false);
  const { mutate: startProposal } = propose;
  useEffect(() => {
    if (!fix || autoStarted.current) return;
    autoStarted.current = true;
    startProposal();
  }, [fix, startProposal]);

  const revise = useMutation({
    mutationFn: () => proposeWorkflowModification(workflow.id, { instructions: instructions.trim(), proposal: proposal.workflow, feedback: feedback.trim() }),
    onSuccess: (p) => { setProposal(p); setFeedback(""); setProblems(null); },
    onError: onProposeError,
  });

  // A proposal with placeholders isn't runnable yet — saved disabled, so a
  // live workflow never comes back on half-configured.
  const hasPlaceholders = (proposal?.placeholders?.length || 0) > 0;
  const save = useMutation({
    mutationFn: (allowDisable) =>
      updateWorkflow(
        workflow.id,
        { ...proposal.workflow, owner: workflow.owner, enabled: hasPlaceholders ? false : workflow.enabled },
        { allowDisable }
      ),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["workflow", workflow.id] });
      queryClient.invalidateQueries({ queryKey: ["workflows"] });
      queryClient.removeQueries({ queryKey: ["workflow-flowchart", workflow.id] });
      if (result?.wasDisabledToSave && !result.reenabled && result.reenableError) {
        toastWorkflowError(`Saved, but the workflow could not be re-enabled — it is currently DISABLED.\n${result.reenableError}`);
      } else if (hasPlaceholders) {
        toast.success(`Saved${workflow.enabled ? " and left DISABLED" : ""} — fill in ${proposal.placeholders.join(", ")} before enabling it.`, { duration: 12000 });
      } else {
        toast.success(result?.wasDisabledToSave ? "Saved — the workflow was re-enabled" : "Workflow saved");
      }
      onSaved();
    },
    onError: (err) => {
      setConfirmEnabled(false);
      if (err.response?.data?.code === "WORKFLOW_ENABLED") return setConfirmEnabled(true);
      toastWorkflowError(errText(err));
    },
  });
  const startSave = () => (workflow.enabled ? setConfirmEnabled(true) : save.mutate(false));

  // Every proposal passed this check server-side before it got here; Validate
  // shows that on demand, and Validate & Save re-runs it against exactly what
  // is about to be written.
  const [validation, setValidation] = useState(null);
  const proposalKey = proposal ? JSON.stringify(proposal.workflow) : null;
  const validate = useMutation({
    mutationFn: async () => ({ ...(await validateWorkflowDraft({ workflow: proposal.workflow })), key: JSON.stringify(proposal.workflow) }),
    onSuccess: setValidation,
    onError: (err) => toastWorkflowError(errText(err)),
  });
  const validateThenSave = async () => {
    const r = await validate.mutateAsync().catch(() => null);
    if (r?.state === "OK") startSave();
  };

  const busy = propose.isPending || revise.isPending || save.isPending || validate.isPending;
  const nothingChanged = proposal && !Object.values(proposal.diff).some((v) => (Array.isArray(v) ? v.length : v));

  return (
    <div className="fixed inset-0 bg-black/30 z-30 flex items-end md:items-center justify-center" onClick={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className={`bg-white w-full ${proposal ? "max-w-4xl" : "max-w-2xl"} md:mx-4 rounded-t-2xl md:rounded-2xl shadow-xl max-h-[92vh] flex flex-col`}>
        <div className="flex items-center justify-between gap-3 px-5 pt-5 pb-3 border-b border-gray-100">
          <h2 className="text-base font-semibold text-gray-900 flex items-center gap-2 min-w-0"><Sparkles size={16} className="text-violet-600 flex-shrink-0" /> <span className="truncate">{fix ? "Fix" : "Modify"} "{workflow.name}" with AI</span></h2>
          <button onClick={() => !busy && onClose()} disabled={busy} className="text-gray-400 hover:text-gray-600 disabled:opacity-40" title="Close"><X size={18} /></button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {!proposal && !propose.isPending && (
            <>
              <p className="text-sm text-gray-600 mb-3">Describe the change. The AI proposes a modified workflow for you to review — nothing is saved until you approve it, and it's told to leave everything you don't mention exactly as it is.</p>
              <Textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={6} placeholder="e.g. Before the campaign is created, email the identity's manager that a review is coming." />
              {problems && (
                <div className="mt-3 border border-red-200 bg-red-50 rounded-xl px-3 py-2.5 text-xs text-red-700">
                  <p className="font-medium">The AI's attempt didn't pass validation, so there's nothing to review:</p>
                  <ul className="mt-1 list-disc pl-4 space-y-0.5">{problems.slice(0, 6).map((p, i) => <li key={i}>{p}</li>)}</ul>
                </div>
              )}
              <p className="text-[11px] text-gray-400 mt-3">This workflow's definition and your tenant's workflow library are sent to the AI provider.</p>
            </>
          )}
          {propose.isPending && (
            <>
              {fix && (
                <div className="border border-red-200 bg-red-50 rounded-xl px-3 py-2.5 text-xs text-red-700">
                  <p className="font-medium">ISC refused to enable this workflow:</p>
                  <ul className="mt-1 list-disc pl-4 space-y-1">{fix.problems.map((p, i) => <li key={i} className="break-words">{p}</li>)}</ul>
                </div>
              )}
              <Working>{fix ? "Working out a fix for exactly these errors" : "Working out the change against your tenant's actions"} — this can take up to a minute…</Working>
            </>
          )}

          {proposal && !save.isPending && (revise.isPending ? <Working>Revising the proposal…</Working> : (
            <>
              <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-1">What would change</p>
              <div className="border border-gray-200 rounded-xl px-3 py-2.5"><ComputedChanges diff={proposal.diff} /></div>

              {proposal.summary.length > 0 && (
                <>
                  <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mt-4 mb-1">The AI's explanation</p>
                  <ul className="list-disc pl-5 space-y-1">{proposal.summary.map((t, i) => <li key={i} className="text-sm text-gray-800">{t}</li>)}</ul>
                </>
              )}
              {(proposal.notes.length > 0 || hasPlaceholders) && (
                <div className="mt-4 border border-amber-200 bg-amber-50/60 rounded-xl px-3 py-2.5">
                  <p className="text-xs font-semibold text-amber-800 flex items-center gap-1.5"><Info size={13} /> Check before you rely on it</p>
                  <ul className="mt-1 space-y-0.5 list-disc pl-4">
                    {hasPlaceholders && <li className="text-xs text-gray-700">Placeholders to fill in: <span className="font-mono">{proposal.placeholders.join(", ")}</span>{workflow.enabled ? " — because of these, it will be saved DISABLED." : ""}</li>}
                    {proposal.notes.map((n, i) => <li key={i} className="text-xs text-gray-700">{n}</li>)}
                  </ul>
                </div>
              )}

              <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mt-4 mb-1">The workflow as proposed</p>
              <div className="border border-gray-100 rounded-xl p-3">{renderFlowchart({ ...workflow, ...proposal.workflow })}</div>

              <WorkflowValidationResult result={validation} stale={!!validation && validation.key !== proposalKey} />

              <div className="mt-5">
                <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-1">Not quite right?</p>
                <Textarea value={feedback} onChange={(e) => setFeedback(e.target.value)} rows={3} placeholder="e.g. Skip the email when the identity has no manager." />
              </div>
            </>
          ))}
          {save.isPending && <Working>Saving to ISC…</Working>}
        </div>

        <div className="px-5 py-4 border-t border-gray-100 flex flex-col md:flex-row gap-2">
          {!proposal ? (
            <>
              <PrimaryButton onClick={() => propose.mutate()} loading={propose.isPending} disabled={!instructions.trim()} className="!w-auto md:flex-1">Propose the Change</PrimaryButton>
              <OutlineButton onClick={onClose} disabled={busy} className="!w-auto md:flex-1">Cancel</OutlineButton>
            </>
          ) : (
            <>
              <OutlineButton onClick={() => validate.mutate()} loading={validate.isPending} disabled={busy} className="!w-auto md:flex-1"><ShieldCheck size={16} /> Validate</OutlineButton>
              <PrimaryButton onClick={validateThenSave} loading={save.isPending} disabled={busy || nothingChanged} className="!w-auto md:flex-1">Validate & Save</PrimaryButton>
              <OutlineButton onClick={() => revise.mutate()} loading={revise.isPending} disabled={busy || !feedback.trim()} className="!w-auto md:flex-1">Revise Proposal</OutlineButton>
              <OutlineButton onClick={() => { setProposal(null); setProblems(null); }} disabled={busy} className="!w-auto md:flex-1">Start Over</OutlineButton>
            </>
          )}
        </div>
      </div>

      {confirmEnabled && (
        <ConfirmModal
          title="This workflow is enabled"
          message={
            hasPlaceholders
              ? "ISC only accepts changes to a disabled workflow. It will be disabled and updated — and LEFT DISABLED, because the change has placeholders to fill in before it can run."
              : "ISC only accepts changes to a disabled workflow. To save, it will be disabled, updated, and enabled again — a few seconds in which a trigger that fires is missed. If the save is rejected, it is re-enabled unchanged."
          }
          confirmLabel={hasPlaceholders ? "Disable & Save" : "Disable, Save & Re-enable"}
          pending={save.isPending}
          onConfirm={() => save.mutate(true)}
          onCancel={() => !save.isPending && setConfirmEnabled(false)}
        />
      )}
    </div>
  );
}
