import { CheckCircle2, XCircle } from "lucide-react";
import { PrimaryButton } from "./ui";

// Plain acknowledge-only dialog (unlike ConfirmModal, which always renders a
// Confirm + Cancel pair) — an operation's outcome is a fact to acknowledge,
// not a decision to make. Shared by Backup and Restore.
export function ResultDialog({ title, success, message, onClose }) {
  return (
    <div
      className="fixed inset-0 bg-black/30 z-30 flex items-end md:items-center justify-center"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-white w-full max-w-md md:mx-4 rounded-t-2xl md:rounded-2xl shadow-xl p-5">
        <div className="flex items-center gap-3 mb-3">
          <div className={`w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 ${success ? "bg-emerald-50" : "bg-red-50"}`}>
            {success ? <CheckCircle2 size={18} className="text-emerald-600" /> : <XCircle size={18} className="text-red-600" />}
          </div>
          <h2 className="text-base font-semibold text-gray-900">{title}</h2>
        </div>
        <p className="text-sm text-gray-600 mb-4 break-words whitespace-pre-wrap">{message}</p>
        <PrimaryButton onClick={onClose}>OK</PrimaryButton>
      </div>
    </div>
  );
}
