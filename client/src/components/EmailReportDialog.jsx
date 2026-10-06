import { useState } from "react";
import { Mail, X, Archive } from "lucide-react";
import toast from "react-hot-toast";
import { OutlineButton } from "./ui";
import { downloadBlob, buildPdfReportsZip, reportsZipFilename } from "../lib/pdfUtils";

// Same circular icon-button look as the shared IconButton component, but as
// a real <a href="mailto:..."> anchor rather than a button with an onClick
// window.open() — IconButton itself has no anchor variant, and a plain
// anchor click is just as much a genuine user gesture (so it's exempt from
// popup-blocking) while being simpler and more discoverable (right-click →
// copy link works, browsers show the mailto: address in the status bar).
function MailLink({ href, title, sent, onClick }) {
  return (
    <div className="relative group flex-shrink-0">
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        title={title}
        aria-label={title}
        onClick={onClick}
        className={`w-9 h-9 rounded-full border flex items-center justify-center transition-colors ${
          sent ? "border-emerald-200 text-emerald-600" : "border-gray-200 text-gray-600 hover:bg-gray-50 active:bg-gray-100"
        }`}
      >
        <Mail size={16} />
      </a>
      <span
        role="tooltip"
        className="pointer-events-none absolute left-1/2 top-full mt-1.5 -translate-x-1/2 whitespace-nowrap rounded-md bg-gray-900 px-2 py-1 text-[11px] font-medium text-white opacity-0 shadow-lg transition-opacity duration-150 group-hover:opacity-100 z-10"
      >
        {title}
      </span>
    </div>
  );
}

/**
 * Review dialog for the "Email Report" bulk action — shared by
 * Roles/Entitlements/Access Profiles/Sources (see useEmailReportAction).
 * One row per owner with a mailto: link (opens the sender's own mail app,
 * one owner at a time — never auto-sent), a link to the hosted report, and
 * a bulk "Download All as ZIP" for grabbing every prepared PDF at once
 * without going through email at all. `objectLabel` is the singular
 * display name ("Role", "Entitlement", "Access Profile", "Source").
 */
export function EmailReportDialog({ objectLabel, dialog, onClose, onMarkSent }) {
  const [zipping, setZipping] = useState(false);

  async function downloadZip() {
    setZipping(true);
    try {
      const blob = await buildPdfReportsZip(dialog.prepared.map((p) => ({ filename: p.filename, pdfBase64: p.pdfBase64 })));
      downloadBlob(reportsZipFilename(objectLabel), blob);
    } catch (err) {
      toast.error(err.message || "Failed to build zip");
    } finally {
      setZipping(false);
    }
  }

  const label = objectLabel.toLowerCase();

  return (
    <div
      className="fixed inset-0 bg-black/30 z-30 flex items-end md:items-center justify-center"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-white w-full max-w-md md:mx-4 rounded-t-2xl md:rounded-2xl shadow-xl p-5 max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-semibold text-gray-900">
            {dialog.prepared.length} report{dialog.prepared.length === 1 ? "" : "s"} ready
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X size={18} />
          </button>
        </div>
        {dialog.prepared.length > 0 && (
          <>
            <p className="text-xs text-gray-500 mb-4">
              Click the mail icon to email one owner — only opens your mail app for that one owner, one at a time.
            </p>
            <div className="space-y-2">
              {dialog.prepared.map((p) => (
                <div
                  key={p.ownerId}
                  className="flex items-center gap-3 border border-gray-100 rounded-xl px-3 py-2.5"
                >
                  <MailLink
                    href={p.mailto}
                    title={`Email ${p.ownerName}`}
                    sent={p.sent}
                    onClick={() => onMarkSent(p.ownerId)}
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-gray-900 truncate">{p.ownerName}</p>
                    <p className="text-xs text-gray-400">
                      {p.count} {label}
                      {p.count === 1 ? "" : "s"}
                      {p.sent && <span className="text-emerald-600"> · sent</span>}
                    </p>
                  </div>
                  <a
                    href={p.reportUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-blue-600 hover:underline flex-shrink-0"
                  >
                    View report
                  </a>
                </div>
              ))}
            </div>
          </>
        )}

        {dialog.noEmailOwners.length > 0 && (
          <div className={dialog.prepared.length > 0 ? "mt-5" : ""}>
            <p className="text-xs font-semibold text-amber-700 uppercase tracking-wide mb-2">
              No email address — skipped
            </p>
            <div className="space-y-2">
              {dialog.noEmailOwners.map((o) => (
                <div key={o.ownerId} className="border border-amber-100 bg-amber-50 rounded-xl px-3 py-2.5">
                  <p className="text-sm text-gray-900">{o.ownerName}</p>
                  <p className="text-xs text-gray-500 mt-0.5">{o.items.join(", ")}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {dialog.skippedNoOwner.length > 0 && (
          <div className={dialog.prepared.length > 0 || dialog.noEmailOwners.length > 0 ? "mt-5" : ""}>
            <p className="text-xs font-semibold text-amber-700 uppercase tracking-wide mb-2">
              No owner set — skipped
            </p>
            <div className="border border-amber-100 bg-amber-50 rounded-xl px-3 py-2.5">
              <p className="text-xs text-gray-700">{dialog.skippedNoOwner.map((it) => it.name).join(", ")}</p>
            </div>
          </div>
        )}

        {dialog.prepared.length > 0 && (
          <div className="mt-5 pt-4 border-t border-gray-100">
            <OutlineButton onClick={downloadZip} loading={zipping}>
              <Archive size={16} />
              Download All as ZIP
            </OutlineButton>
          </div>
        )}
      </div>
    </div>
  );
}
