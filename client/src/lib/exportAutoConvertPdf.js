import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { filenameStamp, PDF_GREY_HEAD as GREY_HEAD, openPdfOrDownload } from "./pdfUtils";

export function autoConvertPdfFilename(tenant) {
  return `${tenant || "tenant"}_auto-convert-log_${filenameStamp(new Date())}.pdf`;
}

const LEVEL_LABELS = { step: "STEP", info: "", success: "OK", warn: "WARN", error: "ERROR" };

/**
 * Renders the Auto Convert run's change log — every operation performed,
 * successes and failures alike — as a PDF, one row per log line with its
 * timestamp and level. Same report conventions as the scan reports
 * (exportRoleScanPdf.js etc.).
 */
function buildAutoConvertPdf({ tenant, entries, startedAt, options, cancelled }) {
  const doc = new jsPDF();

  doc.setFontSize(16);
  doc.text("Auto Convert Change Log", 14, 18);
  doc.setFontSize(10);
  doc.setTextColor(100);
  doc.text(`Tenant: ${tenant || "—"}`, 14, 25);
  doc.text(`Started: ${startedAt ? new Date(startedAt).toLocaleString() : "—"}`, 14, 30);
  doc.text(`Generated: ${new Date().toLocaleString()}`, 14, 35);
  doc.text(
    `Options: Dynamic Roles ${options?.dynamicRoles ? "on" : "off"} · Data Segments ${options?.dataSegments ? "on" : "off"}`,
    14, 40
  );
  const errorCount = entries.filter((e) => e.level === "error").length;
  const warnCount = entries.filter((e) => e.level === "warn").length;
  doc.text(
    `Outcome: ${cancelled ? "CANCELLED" : "Completed"} — ${errorCount} error${errorCount === 1 ? "" : "s"}, ${warnCount} warning${warnCount === 1 ? "" : "s"}`,
    14, 45
  );

  autoTable(doc, {
    startY: 52,
    head: [["Time", "Level", "Message"]],
    body: entries.map((e) => [
      new Date(e.time).toLocaleTimeString(),
      LEVEL_LABELS[e.level] ?? e.level,
      e.message,
    ]),
    styles: { fontSize: 8, cellWidth: "wrap" },
    columnStyles: { 0: { cellWidth: 22 }, 1: { cellWidth: 16 } },
    headStyles: { fillColor: GREY_HEAD },
    // Failures should be findable at a glance in a long log.
    didParseCell: (data) => {
      if (data.section !== "body") return;
      const level = entries[data.row.index]?.level;
      if (level === "error") data.cell.styles.textColor = [185, 28, 28];
      else if (level === "warn") data.cell.styles.textColor = [180, 100, 10];
      else if (level === "step") data.cell.styles.fontStyle = "bold";
    },
  });

  return doc;
}

/**
 * Opens the change log PDF in a new tab with the print dialog already
 * triggered. Popup blockers can stop the window opening, so fall back to
 * downloading rather than appearing to do nothing.
 */
export function printAutoConvertPdf({ tenant, entries, startedAt, options, cancelled }) {
  const doc = buildAutoConvertPdf({ tenant, entries, startedAt, options, cancelled });
  doc.autoPrint();
  return openPdfOrDownload(doc, autoConvertPdfFilename(tenant));
}

/**
 * The same run as plain text — one line per log entry with a full
 * timestamp, headed by the run's tenant, options and outcome — downloaded
 * as a .log file. Available while the run is still going, so a long or
 * stuck conversion can be saved without waiting for it to finish.
 */
export function downloadAutoConvertLog({ tenant, entries, startedAt, options, cancelled, finished }) {
  const errorCount = entries.filter((e) => e.level === "error").length;
  const warnCount = entries.filter((e) => e.level === "warn").length;
  const header = [
    "Auto Convert Log",
    `Tenant: ${tenant || "—"}`,
    `Started: ${startedAt ? new Date(startedAt).toLocaleString() : "—"}`,
    `Saved: ${new Date().toLocaleString()}`,
    `Options: Dynamic Roles ${options?.dynamicRoles ? "on" : "off"} · Data Segments ${options?.dataSegments ? "on" : "off"}`,
    `Outcome: ${!finished ? "IN PROGRESS" : cancelled ? "CANCELLED" : "Completed"} — ${errorCount} error${errorCount === 1 ? "" : "s"}, ${warnCount} warning${warnCount === 1 ? "" : "s"}`,
    "",
  ];
  const lines = entries.map((e) => {
    const label = LEVEL_LABELS[e.level] ?? e.level;
    return `${new Date(e.time).toISOString()}  ${(label || "").padEnd(5)}  ${e.message}`;
  });
  const blob = new Blob([[...header, ...lines].join("\n") + "\n"], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${tenant || "tenant"}_auto-convert-log_${filenameStamp(new Date())}.log`;
  a.click();
  URL.revokeObjectURL(url);
}
