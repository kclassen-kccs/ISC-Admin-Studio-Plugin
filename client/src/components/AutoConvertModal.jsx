import { useEffect, useRef, useState } from "react";
import { Wand2, AlertTriangle, CheckCircle2, XCircle, Printer, Loader2, Download } from "lucide-react";
import toast from "react-hot-toast";
import { runAutoConvert } from "../lib/autoConvert";
import { printAutoConvertPdf, downloadAutoConvertLog } from "../lib/exportAutoConvertPdf";
import { getCredentials, getServerVersion } from "../lib/sailpoint";
import pkg from "../../package.json";
import { PrimaryButton, OutlineButton } from "./ui";

const LEVEL_STYLES = {
  step: "text-gray-900 font-semibold",
  info: "text-gray-600",
  success: "text-emerald-700",
  warn: "text-amber-700",
  error: "text-red-600",
};

// Runs the whole Auto Convert sequence with a live operation log. The
// engine (lib/autoConvert.js) pauses on any step failure and waits for the
// user's Retry / Continue / Cancel choice via the pendingError overlay —
// the promise resolver is stashed in a ref so the running engine and the
// dialog buttons can meet in the middle.
export function AutoConvertModal({ session, onClose }) {
  const [phase, setPhase] = useState("confirm"); // confirm | running | done
  const [dynamicRoles, setDynamicRoles] = useState(true);
  const [dataSegments, setDataSegments] = useState(true);
  const [entries, setEntries] = useState([]);
  const [pendingError, setPendingError] = useState(null); // { step, message }
  const [outcome, setOutcome] = useState(null); // { cancelled }
  const errorResolverRef = useRef(null);
  const startedAtRef = useRef(null);
  const optionsRef = useRef(null);
  const logEndRef = useRef(null);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [entries, pendingError]);

  function appendLog(level, message) {
    setEntries((prev) => [...prev, { time: Date.now(), level, message }]);
  }

  const [versionError, setVersionError] = useState(null);

  async function start() {
    // The conversion runs from THIS page's code. A tab opened before an
    // update keeps running the old code against the new server, so refuse
    // to start until the page matches the server.
    try {
      const serverVersion = await getServerVersion();
      if (serverVersion && serverVersion !== pkg.version) {
        setVersionError(`This page is Admin Studio v${pkg.version} but the server is v${serverVersion}. Reload the page, then start the conversion.`);
        return;
      }
    } catch {
      // Version endpoint unreachable — don't block on it.
    }
    setVersionError(null);
    const options = { dynamicRoles, dataSegments };
    optionsRef.current = options;
    startedAtRef.current = Date.now();
    setPhase("running");
    appendLog("info", `Admin Studio v${pkg.version}`);
    const result = await runAutoConvert({
      options,
      owner: session?.identity ? { id: session.identity.id, name: session.identity.username } : null,
      log: appendLog,
      onError: (step, message) =>
        new Promise((resolve) => {
          errorResolverRef.current = resolve;
          setPendingError({ step, message });
        }),
    });
    setOutcome(result);
    setPhase("done");
  }

  function resolveError(choice) {
    setPendingError(null);
    const resolve = errorResolverRef.current;
    errorResolverRef.current = null;
    resolve?.(choice);
  }

  function openPdf() {
    const tenant = getCredentials()?.tenant;
    const opened = printAutoConvertPdf({
      tenant,
      entries,
      startedAt: startedAtRef.current,
      options: optionsRef.current,
      cancelled: !!outcome?.cancelled,
    });
    if (!opened) toast("Pop-up blocked — downloaded the PDF instead");
  }

  function saveLog() {
    downloadAutoConvertLog({
      tenant: getCredentials()?.tenant,
      entries,
      startedAt: startedAtRef.current,
      options: optionsRef.current,
      cancelled: !!outcome?.cancelled,
      finished: phase === "done",
    });
  }

  const running = phase === "running";

  return (
    <div className="fixed inset-0 bg-black/40 z-40 flex items-end md:items-center justify-center">
      <div className="bg-white w-full max-w-lg md:mx-4 rounded-t-2xl md:rounded-2xl shadow-xl p-5 max-h-[90vh] flex flex-col">
        <div className="flex items-center gap-3 mb-3 flex-shrink-0">
          <div className="w-10 h-10 rounded-full bg-violet-50 flex items-center justify-center flex-shrink-0">
            <Wand2 size={18} className="text-violet-600" />
          </div>
          <h2 className="text-base font-semibold text-gray-900">Auto Convert a Tenant</h2>
        </div>

        {phase === "confirm" && (
          <>
            <p className="text-sm text-gray-600 mb-3">
              This converts a DemoHub tenant to a new Role Model end to end: backup the tenant
              configuration to this computer, rename every existing role with "Previous - ", run a
              Role Model Draft scan and create the suggested roles ("The … Role"), optionally scan
              for and apply Data Segments by metadata — roles and segments are built by the same code
              as the Role Mining screens — deploy an Attribute Sync model, generate and apply AI
              descriptions for Roles, Access Profiles, and Sources, enable the new roles, then
              remove the "Previous - " roles and produce a change-log PDF. The log can be saved
              at any point while it runs.
            </p>
            <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 mb-3">
              <p className="text-xs text-amber-800">
                This makes extensive live changes to the tenant — existing roles are renamed and
                ultimately deleted. A configuration backup is saved to this computer first, but
                role membership/entitlement data beyond configuration is not restorable from it.
              </p>
            </div>
            <label className="flex items-start gap-3 border border-gray-100 rounded-xl p-3 mb-2 cursor-pointer">
              <input
                type="checkbox"
                checked={dynamicRoles}
                onChange={(e) => setDynamicRoles(e.target.checked)}
                className="w-4 h-4 mt-0.5 rounded border-gray-300 flex-shrink-0"
              />
              <div>
                <p className="text-sm font-medium text-gray-900">Dynamic Roles</p>
                <p className="text-xs text-gray-500 mt-0.5">
                  Create dimensional roles (Title dimensions under Department-based roles) instead
                  of flat standard roles.
                </p>
              </div>
            </label>
            <label className="flex items-start gap-3 border border-gray-100 rounded-xl p-3 mb-4 cursor-pointer">
              <input
                type="checkbox"
                checked={dataSegments}
                onChange={(e) => setDataSegments(e.target.checked)}
                className="w-4 h-4 mt-0.5 rounded border-gray-300 flex-shrink-0"
              />
              <div>
                <p className="text-sm font-medium text-gray-900">Data Segments</p>
                <p className="text-xs text-gray-500 mt-0.5">
                  Use Country as the Multi-Company/Division Boundary for roles, and scan for and
                  apply a Data Segment per country.
                </p>
              </div>
            </label>
            {versionError && (
              <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 mb-3">
                <p className="text-xs text-red-700">{versionError}</p>
                <button type="button" onClick={() => window.location.reload()} className="mt-1.5 text-xs font-semibold text-red-700 underline">
                  Reload now
                </button>
              </div>
            )}
            <div className="flex gap-2">
              <PrimaryButton onClick={start}>Start Conversion</PrimaryButton>
              <OutlineButton onClick={onClose}>Cancel</OutlineButton>
            </div>
          </>
        )}

        {(phase === "running" || phase === "done") && (
          <>
            <div className="flex-1 min-h-0 overflow-y-auto border border-gray-100 rounded-xl bg-gray-50 px-3 py-2 mb-3 font-mono text-[11px] leading-relaxed">
              {entries.map((e, i) => (
                <p key={i} className={LEVEL_STYLES[e.level] || "text-gray-600"}>
                  <span className="text-gray-400">{new Date(e.time).toLocaleTimeString()} </span>
                  {e.message}
                </p>
              ))}
              {running && !pendingError && (
                <p className="text-gray-400 flex items-center gap-1.5">
                  <Loader2 size={11} className="animate-spin" /> working…
                </p>
              )}
              <div ref={logEndRef} />
            </div>

            {phase === "done" && (
              <div className="flex items-center gap-2 mb-3 flex-shrink-0">
                {outcome?.cancelled ? (
                  <>
                    <XCircle size={18} className="text-red-600 flex-shrink-0" />
                    <p className="text-sm font-medium text-gray-900">Conversion cancelled — see the log above for what completed.</p>
                  </>
                ) : (
                  <>
                    <CheckCircle2 size={18} className="text-emerald-600 flex-shrink-0" />
                    <p className="text-sm font-medium text-gray-900">Conversion complete.</p>
                  </>
                )}
              </div>
            )}

            <div className="flex gap-2 flex-shrink-0">
              {phase === "done" ? (
                <>
                  <PrimaryButton onClick={openPdf} className="!w-auto flex-1">
                    <Printer size={16} />
                    Change Log PDF
                  </PrimaryButton>
                  <OutlineButton onClick={saveLog} className="!w-auto flex-1">
                    <Download size={16} />
                    Save Log
                  </OutlineButton>
                  <OutlineButton onClick={onClose} className="!w-auto flex-1">Close</OutlineButton>
                </>
              ) : (
                <>
                  <p className="text-xs text-gray-400 py-2 flex-1">
                    Keep this window open — the conversion runs from this browser tab.
                  </p>
                  <OutlineButton onClick={saveLog} disabled={entries.length === 0} className="!w-auto">
                    <Download size={16} />
                    Save Log
                  </OutlineButton>
                </>
              )}
            </div>
          </>
        )}
      </div>

      {pendingError && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-end md:items-center justify-center">
          <div className="bg-white w-full max-w-md md:mx-4 rounded-t-2xl md:rounded-2xl shadow-xl p-5">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-full bg-red-50 flex items-center justify-center flex-shrink-0">
                <AlertTriangle size={18} className="text-red-600" />
              </div>
              <h2 className="text-base font-semibold text-gray-900">Step failed</h2>
            </div>
            <p className="text-sm font-medium text-gray-900 mb-1">{pendingError.step}</p>
            <p className="text-sm text-gray-600 mb-4">{pendingError.message}</p>
            <div className="flex gap-2">
              <PrimaryButton onClick={() => resolveError("retry")} className="!w-auto flex-1">
                Retry
              </PrimaryButton>
              <OutlineButton onClick={() => resolveError("continue")} className="!w-auto flex-1">
                Continue
              </OutlineButton>
              <OutlineButton
                onClick={() => resolveError("cancel")}
                className="!w-auto flex-1 !border-red-200 !text-red-600 hover:!bg-red-50"
              >
                Cancel
              </OutlineButton>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
