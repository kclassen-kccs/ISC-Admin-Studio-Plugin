import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import toast from "react-hot-toast";
import { aiSuggestionCacheId, getEventFixSuggestion, suggestFix } from "../lib/sailpoint";
import { Spinner } from "./ui";

// "Explain with AI" for one failed thing — an audit event, an account
// activity, or a run of connector log lines (see suggestFix for the kinds).
// Mount it only where it's wanted (an expanded row): mounting is what looks
// up a previously saved explanation. Generating one is always an explicit
// click — it costs an AI call, and sends the item's fields to the AI provider.
// `actions`: other buttons for the same failed item (Retry), kept on the
// Explain button's line so the row has one action bar, not a stack.
export function AiFixSuggestion({ kind, item, note, actions }) {
  const queryClient = useQueryClient();
  const cacheId = aiSuggestionCacheId(kind, item.id);
  const saved = useQuery({
    queryKey: ["ops-suggestion", cacheId],
    queryFn: () => getEventFixSuggestion(cacheId),
    staleTime: Infinity,
  });
  const suggest = useMutation({
    mutationFn: (refresh) => suggestFix(kind, item, { refresh }),
    onSuccess: (data) => {
      queryClient.setQueryData(["ops-suggestion", cacheId], data);
      queryClient.invalidateQueries({ queryKey: ["ops-suggestions"] });
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });
  const result = suggest.data || (saved.data?.suggestion ? saved.data : null);

  return (
    <div className="border border-violet-100 bg-violet-50/40 rounded-lg px-3 py-2.5">
      {result && (
        <div className="flex items-center justify-between gap-3 mb-1.5">
          <p className="text-xs font-semibold text-gray-900 flex items-center gap-1.5"><Sparkles size={14} className="text-violet-600" /> Explanation and suggested fix</p>
          <button onClick={() => suggest.mutate(true)} disabled={suggest.isPending} className="text-[11px] font-medium text-blue-600 hover:text-blue-700 disabled:opacity-50">Regenerate</button>
        </div>
      )}
      {saved.isLoading && <p className="text-xs text-gray-500 flex items-center gap-2"><Spinner size={14} /> Checking for a saved explanation…</p>}
      {!saved.isLoading && !result && !suggest.isPending && (
        <>
          <div className="flex items-center flex-wrap gap-2">
            <button
              onClick={() => suggest.mutate(false)}
              className="inline-flex items-center justify-center gap-1.5 bg-violet-600 hover:bg-violet-700 active:bg-violet-800 text-white font-semibold text-xs px-3.5 py-2 rounded-lg shadow-sm transition-colors"
            >
              <Sparkles size={14} />
              Explain and suggest a fix with AI
            </button>
            {actions}
          </div>
          {note && <p className="text-[11px] text-gray-500 mt-1.5">{note}</p>}
        </>
      )}
      {suggest.isPending && (
        <div className="flex items-center flex-wrap gap-2">
          <p className="text-xs text-gray-500 flex items-center gap-2"><Spinner size={14} /> Analyzing…</p>
          {actions}
        </div>
      )}
      {result && !suggest.isPending && (
        <>
          <p className="text-sm text-gray-800 leading-relaxed whitespace-pre-wrap">{result.suggestion}</p>
          <p className="text-[11px] text-gray-400 mt-1.5">
            AI-generated from this item's own fields{result.generatedAt ? ` on ${new Date(result.generatedAt).toLocaleString()}` : ""} — saved; verify before acting.
          </p>
          {actions && <div className="flex items-center flex-wrap gap-2 mt-2">{actions}</div>}
        </>
      )}
    </div>
  );
}
