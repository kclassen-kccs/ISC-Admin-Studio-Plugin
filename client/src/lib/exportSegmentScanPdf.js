import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { filenameStamp, PDF_GREY_HEAD as GREY_HEAD, openPdfOrDownload, stampSectionPages, SECTION_TABLE_MARGIN } from "./pdfUtils";

export function segmentScanPdfFilename(tenant) {
  return `${tenant || "segment-scan"}_${filenameStamp(new Date())}.pdf`;
}

function statusText(s) {
  if (s.segmentCreated) return `Created — ${s.segmentCreated.segmentName}`;
  if (s.existingSegmentName) return `Already exists — ${s.existingSegmentName}`;
  return "Proposed";
}

// The scan hasn't created a real segment yet, so there's no memberFilter
// expression tree to read (the way describeSegmentCriteria in
// exportRolePdf.js does for an actual segment) — this is built straight
// from the same boundaryKeys/values pair the real memberFilter gets built
// from at creation time (see server's POST .../segment-scans/:id/create),
// in the same "attr = value" AND-joined style for consistency with that
// other report.
function describeMembershipRule(boundaryKeys, values) {
  return (boundaryKeys || []).map((k, idx) => `${k} = "${values?.[idx] ?? ""}"`).join(" AND ") || "—";
}

/**
 * Renders a segment scan draft into a jsPDF document: a summary table of
 * every proposed segment, then — same shape as the Role Model Draft report
 * (exportRoleScanPdf.js) — a page per segment covering its matching roles
 * and entitlements, for any suggestion that has either.
 */
function buildSegmentScanPdf({ tenant, scan }) {
  const doc = new jsPDF();
  const suggestions = scan.suggestions || [];

  doc.setFontSize(16);
  doc.text("Data Segments Draft", 14, 18);
  doc.setFontSize(10);
  doc.setTextColor(100);
  doc.text(`Tenant: ${tenant || "—"}`, 14, 25);
  doc.text(`Scan started: ${new Date(scan.startedAt).toLocaleString()}`, 14, 30);
  doc.text(`Generated: ${new Date().toLocaleString()}`, 14, 35);
  doc.text(`Boundary: ${(scan.boundaryKeys || []).join(" + ") || "—"}`, 14, 40);
  doc.text(`Combinations found: ${scan.totalCombinations ?? suggestions.length}`, 14, 45);

  autoTable(doc, {
    startY: 52,
    head: [["Data Segment", "Membership Rule", "Members", "Roles", "Entitlements", "Status"]],
    body: suggestions.map((s) => [
      s.name,
      describeMembershipRule(scan.boundaryKeys, s.values),
      String(s.memberCount ?? 0),
      s.suggestedRoles != null ? String(s.suggestedRoles.length) : "—",
      s.suggestedEntitlements != null ? String(s.suggestedEntitlements.length) : "—",
      statusText(s),
    ]),
    styles: { fontSize: 8, cellWidth: "wrap" },
    columnStyles: {
      0: { cellWidth: 32 },
      1: { cellWidth: "auto" },
      2: { cellWidth: 16 },
      3: { cellWidth: 16 },
      4: { cellWidth: 20 },
      5: { cellWidth: 32 },
    },
    headStyles: { fillColor: GREY_HEAD },
  });

  const sections = [];
  for (const s of suggestions) {
    const hasRoles = (s.suggestedRoles || []).length > 0;
    const hasEntitlements = (s.suggestedEntitlements || []).length > 0;
    if (!hasRoles && !hasEntitlements) continue;

    doc.addPage();
    const first = doc.getNumberOfPages();
    doc.setFontSize(13);
    doc.setTextColor(20);
    doc.text(s.name, 14, 18);
    doc.setFontSize(9);
    doc.setTextColor(100);
    doc.text(`${s.memberCount ?? 0} members · ${statusText(s)}`, 14, 24);
    doc.text(`Membership Rule: ${describeMembershipRule(scan.boundaryKeys, s.values)}`, 14, 29);

    let y = 37;
    if (hasRoles) {
      doc.setFontSize(10);
      doc.setTextColor(20);
      doc.text(`Matching roles (${s.suggestedRoles.length})`, 14, y);
      autoTable(doc, {
        startY: y + 4,
        head: [["Role", "Enabled", "Type"]],
        body: s.suggestedRoles.map((r) => [r.name, r.enabled ? "Yes" : "No", r.dimensional ? "Dynamic" : "Standard"]),
        styles: { fontSize: 8 },
        margin: SECTION_TABLE_MARGIN,
        headStyles: { fillColor: GREY_HEAD },
      });
      y = doc.lastAutoTable.finalY + 8;
    }

    if (hasEntitlements) {
      doc.setFontSize(10);
      doc.setTextColor(20);
      doc.text(`Entitlements (${s.suggestedEntitlements.length})`, 14, y);
      autoTable(doc, {
        startY: y + 4,
        head: [["Entitlement", "Source"]],
        body: s.suggestedEntitlements.map((e) => [e.name, e.source || "—"]),
        styles: { fontSize: 8 },
        margin: SECTION_TABLE_MARGIN,
        headStyles: { fillColor: GREY_HEAD },
      });
    }
    sections.push({ name: s.name, first, last: doc.getNumberOfPages() });
  }

  // Footer (segment name, Page X of Y) and a "(continued)" header on every
  // page after a segment's first — see stampSectionPages.
  stampSectionPages(doc, sections);
  return doc;
}

/** Downloads the scan as a PDF. */
export function exportSegmentScanPdf({ tenant, scan }) {
  buildSegmentScanPdf({ tenant, scan }).save(segmentScanPdfFilename(tenant));
}

/**
 * Opens the same PDF in a new tab with the print dialog already triggered.
 * Popup blockers can stop the window opening, so fall back to downloading
 * rather than appearing to do nothing.
 */
export function printSegmentScanPdf({ tenant, scan }) {
  const doc = buildSegmentScanPdf({ tenant, scan });
  doc.autoPrint();
  return openPdfOrDownload(doc, segmentScanPdfFilename(tenant));
}
