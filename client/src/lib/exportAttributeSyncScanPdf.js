import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { filenameStamp, PDF_GREY_HEAD as GREY_HEAD, openPdfOrDownload } from "./pdfUtils";

export function attributeSyncScanPdfFilename(tenant) {
  return `${tenant || "attribute-sync-scan"}_${filenameStamp(new Date())}.pdf`;
}

function statusText(r, outcome) {
  if (r.skipped) return `Skipped — ${r.reason}`;
  if (outcome) return outcome.ok ? "Deployed" : `Deploy failed: ${outcome.error}`;
  return r.changeCount > 0 ? "Proposed" : "No changes";
}

function fieldStatus(p) {
  if (p.currentlyEnabled) return "Already Enabled";
  if (p.recommended) return "Recommended";
  return "Excluded";
}

/**
 * Renders an Attribute Sync scan into a jsPDF document — same shape as the
 * other scan reports (Role Model Draft / Data Segments Draft / Role
 * Evaluation): a summary table of every source scanned, then a page per
 * source with at least one proposed field mapping, listing each field's
 * target identity attribute, recommendation status, and reason.
 */
function buildAttributeSyncScanPdf({ tenant, scan }) {
  const doc = new jsPDF();
  const outcomeBySourceId = new Map((scan.deployResults || []).map((o) => [o.sourceId, o]));
  const results = scan.results || [];

  doc.setFontSize(16);
  doc.text("Attribute Sync Scan Report", 14, 18);
  doc.setFontSize(10);
  doc.setTextColor(100);
  doc.text(`Tenant: ${tenant || "—"}`, 14, 25);
  doc.text(`Started: ${new Date(scan.startedAt).toLocaleString()}`, 14, 30);
  doc.text(`Generated: ${new Date().toLocaleString()}`, 14, 35);
  doc.text(
    `${scan.sourceCount ?? results.length} source${(scan.sourceCount ?? results.length) === 1 ? "" : "s"} scanned — ${scan.proposedChangeCount ?? 0} proposed change${(scan.proposedChangeCount ?? 0) === 1 ? "" : "s"}`,
    14,
    40
  );

  autoTable(doc, {
    startY: 47,
    head: [["Source", "Type", "Changes", "Status"]],
    body: results.map((r) => [
      r.sourceName,
      r.sourceType || "—",
      r.skipped ? "—" : String(r.changeCount ?? 0),
      statusText(r, outcomeBySourceId.get(r.sourceId)),
    ]),
    styles: { fontSize: 8, cellWidth: "wrap" },
    columnStyles: { 0: { cellWidth: 45 }, 1: { cellWidth: 35 }, 2: { cellWidth: 20 } },
    headStyles: { fillColor: GREY_HEAD },
  });

  for (const r of results) {
    if (r.skipped || (r.proposed || []).length === 0) continue;

    doc.addPage();
    doc.setFontSize(13);
    doc.setTextColor(20);
    doc.text(r.sourceName, 14, 18);
    doc.setFontSize(9);
    doc.setTextColor(100);
    doc.text(`${r.sourceType || "—"} · ${statusText(r, outcomeBySourceId.get(r.sourceId))}`, 14, 24);

    autoTable(doc, {
      startY: 30,
      head: [["Field", "Target Identity Attribute", "Status", "Reason"]],
      body: r.proposed.map((p) => [p.name, p.target, fieldStatus(p), p.reason || ""]),
      styles: { fontSize: 8, cellWidth: "wrap" },
      headStyles: { fillColor: GREY_HEAD },
    });
  }

  return doc;
}

export function exportAttributeSyncScanPdf({ tenant, scan }) {
  buildAttributeSyncScanPdf({ tenant, scan }).save(attributeSyncScanPdfFilename(tenant));
}

/**
 * Opens the same PDF in a new tab with the print dialog already triggered.
 * Popup blockers can stop the window opening, so fall back to downloading
 * rather than appearing to do nothing.
 */
export function printAttributeSyncScanPdf({ tenant, scan }) {
  const doc = buildAttributeSyncScanPdf({ tenant, scan });
  doc.autoPrint();
  return openPdfOrDownload(doc, attributeSyncScanPdfFilename(tenant));
}
