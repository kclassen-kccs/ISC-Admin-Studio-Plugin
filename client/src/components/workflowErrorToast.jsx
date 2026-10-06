import toast from "react-hot-toast";
import { XCircle, X } from "lucide-react";

// Errors from ISC's workflow endpoints can be a LIST — "Please fix the
// following validation errors…" followed by one line per problem (the server
// joins them with newlines; see iscWorkflowErrorText). A normal toast
// collapses the line breaks and is gone in seconds, which is exactly wrong
// for something the user has to read and act on: a multi-line error gets a
// card that keeps its lines and stays until dismissed. One-liners stay toasts.
export function toastWorkflowError(text) {
  const message = String(text || "Something went wrong.");
  if (!message.includes("\n")) return toast.error(message, { duration: 8000 });
  const [head, ...lines] = message.split("\n");
  return toast.custom(
    (t) => (
      <div className="bg-white border border-red-200 shadow-xl rounded-xl px-4 py-3 w-[min(36rem,92vw)] max-h-[70vh] overflow-y-auto">
        <div className="flex items-start gap-2">
          <XCircle size={18} className="text-red-600 flex-shrink-0 mt-0.5" />
          <p className="flex-1 text-sm font-medium text-gray-900">{head}</p>
          <button onClick={() => toast.dismiss(t.id)} title="Dismiss" className="text-gray-400 hover:text-gray-600 flex-shrink-0"><X size={16} /></button>
        </div>
        <ul className="mt-2 space-y-1.5">
          {lines.filter((l) => l.trim()).map((l, i) => <li key={i} className="text-xs text-gray-700 break-words">{l}</li>)}
        </ul>
      </div>
    ),
    { duration: Infinity }
  );
}
