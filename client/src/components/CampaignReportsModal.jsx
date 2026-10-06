import { useState } from "react";
import { X, FileDown, RefreshCw, Download, FileArchive, FileText, FileSpreadsheet, ChevronLeft, Check } from "lucide-react";
import toast from "react-hot-toast";
import { useMutation } from "@tanstack/react-query";
import JSZip from "jszip";
import { CAMPAIGN_REPORT_TYPES, downloadCampaignReports, runCampaignReport } from "../lib/sailpoint";
import { downloadBlob } from "../lib/pdfUtils";
import { SegmentedPill, PrimaryButton, OutlineButton, Spinner } from "./ui";

const FORMAT_OPTIONS = [
  { value: "pdf", label: "PDF" },
  { value: "csv", label: "CSV" },
];

function blobFromBase64(base64, type) {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

const formatBytes = (n) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
// Decoded size of a base64 payload, without decoding it.
const base64Bytes = (b64) => Math.floor((b64.length * 3) / 4) - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);

// Get Campaign Reports for the selected COMPLETED campaigns (Browse > User
// Certifications), in two steps:
//  1. Options — PDF or CSV, which of ISC's four reports, and for CSV whether
//     to consolidate every campaign into one file per report type.
//  2. Reports ready — every fetched file listed, each with its own Download,
//     plus "Download all as ZIP". Nothing downloads until the user picks.
//
// The server runs any report that was never run (or whose file has expired)
// before fetching it, so step 1 -> 2 can take a while; failures are per
// report and are listed in step 2 rather than sinking the whole batch.
export function CampaignReportsModal({ campaigns, stale = false, onClose }) {
  const [format, setFormat] = useState("pdf");
  const [types, setTypes] = useState(() => new Set(CAMPAIGN_REPORT_TYPES.map((t) => t.value)));
  const [consolidate, setConsolidate] = useState(false);
  const [result, setResult] = useState(null); // { files, failures, format } — set => step 2
  const [downloaded, setDownloaded] = useState(() => new Set()); // file names already saved, and "__zip__"
  const [zipping, setZipping] = useState(false);

  const isCsv = format === "csv";
  const merging = isCsv && consolidate;
  const fileCount = merging ? types.size : campaigns.length * types.size;

  function toggleType(value) {
    setTypes((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  }

  const run = useMutation({
    mutationFn: () =>
      downloadCampaignReports({
        campaignIds: campaigns.map((c) => c.id),
        // Keep ISC's order, whatever order they were ticked in.
        reportTypes: CAMPAIGN_REPORT_TYPES.map((t) => t.value).filter((v) => types.has(v)),
        format,
        // Always the individual files: step 2 offers each one, and builds the
        // ZIP here in the browser from the same bytes if that's what's chosen.
        zip: false,
        consolidate: merging,
      }),
    onSuccess: (data) => {
      const files = data.files || [];
      const failures = data.failures || [];
      setDownloaded(new Set());
      setResult({ files, failures, format });
      if (files.length === 0) toast.error("No reports could be fetched");
      else if (failures.length > 0) toast(`${files.length} report${files.length === 1 ? "" : "s"} ready — ${failures.length} couldn't be fetched`);
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  // Generate Reports: ask ISC for a FRESH copy of each chosen report, without
  // downloading anything — for when the existing files are stale (after a
  // remediation scan, say). One request per campaign x report so each has its
  // own outcome. ISC builds them in the background, so success = "started".
  const [generated, setGenerated] = useState(null);
  const generate = useMutation({
    mutationFn: async () => {
      const wanted = CAMPAIGN_REPORT_TYPES.map((t) => t.value).filter((v) => types.has(v));
      let started = 0;
      const failures = [];
      for (const c of campaigns) {
        for (const reportType of wanted) {
          try {
            await runCampaignReport(c.id, reportType);
            started += 1;
          } catch (err) {
            const busy = err.response?.status === 400 && /400\.2\.0|conflicting operation/i.test(JSON.stringify(err.response?.data || ""));
            failures.push({
              campaign: c.name,
              reportType,
              error: busy
                ? "ISC is still running another operation on this campaign (a remediation scan or another report) — try again in a few minutes."
                : err.response?.data?.error || err.response?.data?.messages?.[0]?.text || err.message,
            });
          }
        }
      }
      return { started, failures };
    },
    onSuccess: ({ started, failures }) => {
      setGenerated({ started, failures });
      if (started > 0 && failures.length === 0) toast.success(`Generating ${started} report${started === 1 ? "" : "s"} in ISC — give them a minute before downloading`);
      else if (started > 0) toast(`Generating ${started} report${started === 1 ? "" : "s"} — ${failures.length} couldn't be started`);
      else toast.error("No reports could be started");
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const pending = run.isPending || generate.isPending;

  const mimeOf = (fmt) => (fmt === "pdf" ? "application/pdf" : "text/csv");
  function downloadOne(f) {
    downloadBlob(f.name, blobFromBase64(f.contentBase64, mimeOf(result.format)));
    setDownloaded((prev) => new Set(prev).add(f.name));
  }
  async function downloadZip() {
    setZipping(true);
    try {
      const zip = new JSZip();
      for (const f of result.files) zip.file(f.name, f.contentBase64, { base64: true });
      const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
      downloadBlob(`campaign-reports-${result.format}-${new Date().toISOString().slice(0, 10)}.zip`, blob);
      setDownloaded((prev) => new Set(prev).add("__zip__"));
    } catch (err) {
      toast.error(`Couldn't build the ZIP: ${err.message}`);
    } finally {
      setZipping(false);
    }
  }
  const labelOf = (value) => CAMPAIGN_REPORT_TYPES.find((t) => t.value === value)?.label || value;

  return (
    <div
      className="fixed inset-0 bg-black/30 z-30 flex items-end md:items-center justify-center"
      onClick={(e) => e.target === e.currentTarget && !pending && onClose()}
    >
      <div className="bg-white w-full max-w-lg md:mx-4 rounded-t-2xl md:rounded-2xl shadow-xl max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 pt-5">
          <h2 className="text-base font-semibold text-gray-900 flex items-center gap-2">
            <FileDown size={16} className="text-blue-600" />
            {result ? "Reports ready" : "Get Campaign Reports"}
          </h2>
          <button onClick={onClose} disabled={pending} className="text-gray-400 hover:text-gray-600 disabled:opacity-50">
            <X size={18} />
          </button>
        </div>

        {!result ? (
        <div className="px-5 pt-2 pb-5">
          <p className="text-xs text-gray-500 mb-3">
            For {campaigns.length} completed campaign{campaigns.length === 1 ? "" : "s"}
            {campaigns.length <= 3 ? `: ${campaigns.map((c) => c.name).join(", ")}` : ""}.
          </p>

          {/* Opened from the post-scan reminder: the existing files predate the
              scan. Cleared once fresh ones have been requested. */}
          {stale && !generated && (
            <div className="border border-amber-200 bg-amber-50 text-amber-800 rounded-xl px-3 py-2.5 mb-3 text-xs">
              A remediation scan was just started for {campaigns.length === 1 ? "this campaign" : "these campaigns"}, so the reports ISC holds are stale.
              Wait a few minutes for the scan to finish, use <span className="font-semibold">Generate Reports</span> below, then Get Reports.
              Downloading now would give you the pre-scan figures.
            </div>
          )}

          <div className="mb-4">
            <SegmentedPill label="Format" options={FORMAT_OPTIONS} active={format} onChange={(v) => { setFormat(v); setResult(null); }} />
          </div>

          <p className="text-xs font-medium text-gray-700 mb-1.5">Reports</p>
          <div className="border border-gray-100 rounded-xl divide-y divide-gray-100 mb-4">
            {CAMPAIGN_REPORT_TYPES.map((t) => (
              <label key={t.value} className="flex items-center gap-2.5 px-3 py-2.5 text-sm text-gray-800 cursor-pointer">
                <input
                  type="checkbox"
                  checked={types.has(t.value)}
                  onChange={() => toggleType(t.value)}
                  disabled={pending}
                  className="w-4 h-4 rounded border-gray-300"
                />
                {t.label}
              </label>
            ))}
          </div>

          <p className="text-xs font-medium text-gray-700 mb-1.5">CSV options</p>
          <div className="border border-gray-100 rounded-xl divide-y divide-gray-100 mb-3">
            <label className={`flex items-start gap-2.5 px-3 py-2.5 ${isCsv ? "cursor-pointer" : "opacity-50"}`}>
              <input
                type="checkbox"
                checked={merging}
                onChange={() => setConsolidate((v) => !v)}
                disabled={!isCsv || pending}
                className="w-4 h-4 mt-0.5 rounded border-gray-300"
              />
              <span>
                <span className="block text-sm text-gray-800">Consolidate all campaigns into one CSV per report</span>
                <span className="block text-xs text-gray-500">
                  {isCsv
                    ? "Every campaign's rows go into one file per report type, with a leading Campaign column. Pick a single report to get a single file."
                    : "CSV only — a PDF can't be merged row by row."}
                </span>
              </span>
            </label>
          </div>

          <p className="text-xs text-gray-500 mb-3">
            {types.size === 0
              ? "Pick at least one report."
              : `${fileCount} file${fileCount === 1 ? "" : "s"} will be fetched. You then choose which to download — each separately, or all as one ZIP. Reports that were never run, or have expired, are run first — allow up to a minute for each of those.`}
          </p>

          {generated && (
            <div className="border border-gray-100 rounded-xl px-3 py-2.5 mb-3 text-xs">
              <p className="text-gray-700">
                {generated.started} report{generated.started === 1 ? "" : "s"} started in ISC. They build in the background — wait a minute, then Get Reports to download the fresh copies.
              </p>
              {generated.failures.length > 0 && (
                <>
                  <p className="text-red-600 font-medium mt-2">{generated.failures.length} couldn't be started:</p>
                  <ul className="mt-1 space-y-1 max-h-32 overflow-y-auto">
                    {generated.failures.map((f, i) => (
                      <li key={i} className="text-red-600">
                        {f.campaign} — {labelOf(f.reportType)}: {f.error}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}

          <PrimaryButton onClick={() => run.mutate()} loading={run.isPending} disabled={types.size === 0 || pending}>
            {run.isPending ? "Fetching reports…" : "Get Reports"}
          </PrimaryButton>
          <button
            type="button"
            onClick={() => generate.mutate()}
            disabled={types.size === 0 || pending}
            title="Ask ISC to build fresh copies of the chosen reports for the selected campaigns, without downloading"
            className="w-full mt-2 flex items-center justify-center gap-2 border border-blue-200 text-blue-700 font-medium text-sm py-3 rounded-xl hover:bg-blue-50 active:bg-blue-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {generate.isPending ? <Spinner size={16} /> : <RefreshCw size={15} />}
            {generate.isPending ? "Starting reports…" : `Generate Reports (${campaigns.length * types.size})`}
          </button>
          <OutlineButton onClick={onClose} disabled={pending} className="mt-2">
            Cancel
          </OutlineButton>
        </div>
        ) : (
        <div className="px-5 pt-2 pb-5">
          <p className="text-xs text-gray-500 mb-3">
            {result.files.length} file{result.files.length === 1 ? "" : "s"} fetched as {result.format.toUpperCase()}
            {result.files.some((f) => f.rowCount != null) ? ` — ${result.files.reduce((n, f) => n + (f.rowCount || 0), 0)} rows consolidated` : ""}.
            {result.files.length > 0 ? " Download them one at a time, or all together as a ZIP. Nothing has been saved yet." : ""}
          </p>

          {result.files.length > 1 && (
            <button
              type="button"
              onClick={downloadZip}
              disabled={zipping}
              className="w-full mb-3 flex items-center justify-center gap-2 bg-blue-600 text-white font-medium text-sm py-3 rounded-xl hover:bg-blue-700 active:bg-blue-800 disabled:opacity-50 transition-colors"
            >
              {zipping ? <Spinner size={16} className="text-white" /> : downloaded.has("__zip__") ? <Check size={16} /> : <FileArchive size={16} />}
              {zipping ? "Building ZIP…" : `Download all ${result.files.length} as a ZIP (${formatBytes(result.files.reduce((n, f) => n + base64Bytes(f.contentBase64), 0))} before compression)`}
            </button>
          )}

          {result.files.length > 0 && (
            <div className="border border-gray-100 rounded-xl divide-y divide-gray-100 mb-3 max-h-72 overflow-y-auto">
              {result.files.map((f) => {
                const FileIcon = result.format === "pdf" ? FileText : FileSpreadsheet;
                const done = downloaded.has(f.name);
                return (
                  <div key={f.name} className="flex items-center gap-2.5 px-3 py-2.5">
                    <FileIcon size={16} className="text-gray-400 flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-gray-900 truncate" title={f.name}>{f.name}</p>
                      <p className="text-xs text-gray-500 truncate">
                        {f.campaign} · {labelOf(f.reportType)} · {formatBytes(base64Bytes(f.contentBase64))}
                        {f.rowCount != null ? ` · ${f.rowCount} rows` : ""}
                        {f.reran ? " · freshly run" : ""}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => downloadOne(f)}
                      title={`Download ${f.name}`}
                      className={`flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-lg border flex-shrink-0 transition-colors ${
                        done ? "border-emerald-200 text-emerald-700 bg-emerald-50" : "border-gray-200 text-gray-700 hover:bg-gray-50"
                      }`}
                    >
                      {done ? <Check size={13} /> : <Download size={13} />}
                      {done ? "Saved" : "Download"}
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {result.failures.length > 0 && (
            <div className="border border-red-100 bg-red-50 rounded-xl px-3 py-2.5 mb-3 text-xs">
              <p className="text-red-700 font-medium">{result.failures.length} couldn't be fetched:</p>
              <ul className="mt-1 space-y-1 max-h-32 overflow-y-auto">
                {result.failures.map((f, i) => (
                  <li key={i} className="text-red-700">
                    {f.campaign} — {labelOf(f.reportType)}: {f.error}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <OutlineButton onClick={() => setResult(null)}>
            <ChevronLeft size={15} />
            Back to options
          </OutlineButton>
          <OutlineButton onClick={onClose} className="mt-2">
            Done
          </OutlineButton>
        </div>
        )}
      </div>
    </div>
  );
}
