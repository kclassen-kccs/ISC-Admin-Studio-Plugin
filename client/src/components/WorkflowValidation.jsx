import { CheckCircle2, XCircle } from "lucide-react";

// Result of validateWorkflowDraft(), in the shape of the connector-rule
// editor's validation box. `onSaveAnyway` is offered on a failure because ISC
// itself accepts an incomplete workflow as a disabled draft — the check is a
// guard, not a gate. Says plainly that it isn't ISC's own validation.
export function WorkflowValidationResult({ result, stale, onSaveAnyway, savingAnyway }) {
  if (!result) return null;
  if (stale) return <p className="text-xs text-amber-700 mt-2">Changed since it was last validated — it will be validated again on Validate & Save.</p>;
  if (result.state === "OK") {
    return (
      <p className="text-xs text-emerald-700 flex items-start gap-1.5 mt-2">
        <CheckCircle2 size={14} className="flex-shrink-0 mt-px" />
        <span>Validation passed — the structure, the trigger and action ids, every link and every JSONPath key check out. ISC runs its own, fuller validation when the workflow is enabled.</span>
      </p>
    );
  }
  const problems = Array.isArray(result.problems) ? result.problems : [];
  return (
    <div className="mt-2 border border-red-200 bg-red-50 rounded-xl px-3 py-2.5 text-xs text-red-700">
      <p className="font-medium flex items-center gap-1.5"><XCircle size={14} /> Validation failed — {problems.length} issue{problems.length === 1 ? "" : "s"}</p>
      <ul className="mt-1 space-y-1 list-disc pl-4">{problems.map((p, i) => <li key={i} className="break-words">{p}</li>)}</ul>
      {onSaveAnyway && (
        <p className="mt-2 text-gray-600">
          ISC accepts an unfinished workflow as a disabled draft, but won't let it be enabled like this.{" "}
          <button onClick={onSaveAnyway} disabled={savingAnyway} className="font-medium text-blue-600 hover:underline disabled:opacity-50">Save anyway</button>
        </p>
      )}
    </div>
  );
}
