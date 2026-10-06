import { useEffect, useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import toast from "react-hot-toast";
import { fixJsonWithAi } from "../lib/sailpoint";
import { Spinner } from "./ui";

// The lines that differ between two texts, as one changed region: whatever
// sits between their common leading and trailing lines. A syntax repair is
// local, so that region is small — and showing it is the safeguard here: the
// original can't be parsed, so nothing can verify the AI left values alone
// except the person reading what changed.
function changedRegion(before, after) {
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  return { line: start + 1, removed: a.slice(start, endA), added: b.slice(start, endB) };
}

const MAX_DIFF_LINES = 14;
function DiffLines({ lines, sign, className }) {
  const shown = lines.slice(0, MAX_DIFF_LINES);
  return (
    <>
      {shown.map((l, i) => <div key={i} className={className}>{sign} {l || " "}</div>)}
      {lines.length > shown.length && <div className="text-gray-400">  … {lines.length - shown.length} more line{lines.length - shown.length === 1 ? "" : "s"}</div>}
    </>
  );
}

// Goes under a JSON editor. While the text doesn't parse (`error` set) it
// offers to have the AI repair the syntax, then explains what was wrong and
// shows the changed lines; nothing is applied until the user says so. Right
// after applying — when the text is valid again, so `error` is null — it
// stays just long enough to offer "Undo fix". Render it unconditionally and
// let it decide. `onApply(text)` replaces the editor's text.
export function JsonAiFix({ text, error, onApply }) {
  // { before, after } of the fix just applied — until the text moves on.
  const [applied, setApplied] = useState(null);
  useEffect(() => { setApplied((a) => (a && a.after !== text ? null : a)); }, [text]);

  const fix = useMutation({
    mutationFn: () => fixJsonWithAi(text, error),
    onError: (err) => toast.error(err.response?.data?.error || err.message, { duration: 8000 }),
  });
  // A proposal is for the exact text it was made from — once that's edited
  // it no longer applies cleanly, so drop it.
  const { reset } = fix;
  useEffect(() => { reset(); }, [text, reset]);

  const diff = useMemo(() => (fix.data ? changedRegion(text, fix.data.fixed) : null), [fix.data, text]);

  if (applied && applied.after === text) {
    return (
      <p className="text-[11px] text-gray-500 mt-1.5">
        AI fix applied — review it before saving.{" "}
        <button onClick={() => { onApply(applied.before); setApplied(null); }} className="font-medium text-blue-600 hover:underline">Undo fix</button>
      </p>
    );
  }
  if (!error) return null;

  if (!fix.data) {
    return (
      <div className="mt-2 flex items-center flex-wrap gap-2">
        <button
          onClick={() => fix.mutate()}
          disabled={fix.isPending}
          className="inline-flex items-center justify-center gap-1.5 bg-violet-600 hover:bg-violet-700 active:bg-violet-800 disabled:opacity-60 text-white font-semibold text-xs px-3.5 py-2 rounded-lg shadow-sm transition-colors"
        >
          {fix.isPending ? <Spinner size={14} className="!text-white" /> : <Sparkles size={14} />}
          {fix.isPending ? "Finding the problem…" : "Fix with AI"}
        </button>
        <span className="text-[11px] text-gray-500">Explains what's wrong and proposes a corrected version — sends this JSON to the AI provider.</span>
      </div>
    );
  }

  return (
    <div className="mt-2 border border-violet-100 bg-violet-50/40 rounded-lg px-3 py-2.5">
      <p className="text-xs font-semibold text-gray-900 flex items-center gap-1.5 mb-1.5"><Sparkles size={14} className="text-violet-600" /> What's wrong</p>
      <p className="text-sm text-gray-800 leading-relaxed whitespace-pre-wrap">{fix.data.explanation}</p>
      {diff && (diff.removed.length > 0 || diff.added.length > 0) && (
        <>
          <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mt-3 mb-1">Proposed change — from line {diff.line}</p>
          <pre className="border border-gray-200 rounded-lg bg-white font-mono text-[11px] leading-relaxed p-2 overflow-auto whitespace-pre">
            <DiffLines lines={diff.removed} sign="-" className="text-red-700 bg-red-50" />
            <DiffLines lines={diff.added} sign="+" className="text-emerald-700 bg-emerald-50" />
          </pre>
        </>
      )}
      <div className="flex items-center flex-wrap gap-2 mt-2.5">
        <button
          onClick={() => { setApplied({ before: text, after: fix.data.fixed }); onApply(fix.data.fixed); }}
          className="inline-flex items-center justify-center gap-1.5 bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white font-semibold text-xs px-3.5 py-2 rounded-lg shadow-sm transition-colors"
        >
          Apply fix
        </button>
        <button onClick={() => reset()} className="text-xs font-medium text-gray-600 hover:bg-gray-100 px-3 py-2 rounded-lg transition-colors">Dismiss</button>
        <span className="text-[11px] text-gray-400">AI-generated — check the changed lines keep your values. Nothing is saved until you save.</span>
      </div>
    </div>
  );
}
