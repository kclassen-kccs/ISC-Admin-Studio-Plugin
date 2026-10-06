import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { filenameStamp, PDF_GREY_HEAD as GREY_HEAD, openPdfOrDownload, stampSectionPages, SECTION_TABLE_MARGIN } from "./pdfUtils";

// PDFs for ISC Segments (access-request Segments, not Data Segments): the
// Mining > Segments draft, and the Browse > Segments list (basic and
// detailed). Same report conventions as the Data Segments ones
// (exportSegmentScanPdf.js, exportRolePdf.js).

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function describeExpression(expr) {
  if (!expr) return "—";
  if ((expr.operator === "AND" || expr.operator === "OR") && expr.children?.length) {
    return expr.children.map(describeExpression).join(` ${expr.operator} `);
  }
  if (expr.operator === "EQUALS") return `${expr.attribute} = "${expr.value?.value ?? ""}"`;
  return expr.operator || "—";
}

function header(doc, title, lines) {
  doc.setFontSize(16);
  doc.setTextColor(20);
  doc.text(title, 14, 18);
  doc.setFontSize(10);
  doc.setTextColor(100);
  lines.filter(Boolean).forEach((l, i) => doc.text(l, 14, 25 + i * 5));
  return 25 + lines.filter(Boolean).length * 5 + 2;
}

// One page section per access type: a titled table, skipped when empty.
function accessTables(doc, y, { roles, accessProfiles, entitlements }) {
  const sections = [
    ["Roles", roles, [["Role"]], (r) => [r.name]],
    ["Access Profiles", accessProfiles, [["Access Profile", "Source"]], (a) => [a.name, a.source || "—"]],
    ["Entitlements", entitlements, [["Entitlement", "Source"]], (e) => [e.name, e.source || "—"]],
  ];
  for (const [title, items, head, row] of sections) {
    if (!items?.length) continue;
    if (y > 260) { doc.addPage(); y = 24; }
    doc.setFontSize(10);
    doc.setTextColor(20);
    doc.text(`${title} (${items.length})`, 14, y);
    autoTable(doc, {
      startY: y + 4,
      head,
      body: [...items].sort((a, b) => (a.name || "").localeCompare(b.name || "")).map(row),
      styles: { fontSize: 8, overflow: "linebreak" },
      columnStyles: head[0].length > 1 ? { 0: { cellWidth: "auto" }, 1: { cellWidth: 55 } } : {},
      margin: SECTION_TABLE_MARGIN,
      headStyles: { fillColor: GREY_HEAD },
    });
    y = doc.lastAutoTable.finalY + 8;
  }
  return y;
}

function print(doc, filename) {
  doc.autoPrint();
  return openPdfOrDownload(doc, filename);
}

// ─── Mining > Segments draft ─────────────────────────────────────────────────

function draftStatus(s) {
  if (s.segmentCreated) return `Created — ${s.segmentCreated.segmentName}`;
  if (s.addedToExisting) return `Added to — ${s.addedToExisting.segmentName}`;
  if (s.existingSegment) return `Exists — ${s.existingSegment.name}`;
  return "Proposed";
}

function buildAccessSegmentScanPdf({ tenant, scan }) {
  const doc = new jsPDF();
  const suggestions = scan.suggestions || [];
  const startY = header(doc, "Segments Draft", [
    `Tenant: ${tenant || "—"}`,
    `Scan started: ${new Date(scan.startedAt).toLocaleString()}`,
    `Generated: ${new Date().toLocaleString()}`,
    `Boundary: ${(scan.boundaryKeys || []).join(" + ") || "—"}`,
    `Boundary values found: ${scan.totalCombinations ?? suggestions.length}`,
  ]);

  autoTable(doc, {
    startY,
    head: [["Segment", "Members Rule", "Members", "Roles", "Access Profiles", "Entitlements", "Status"]],
    body: suggestions.map((s) => [
      s.name,
      describeExpression(s.visibilityCriteria?.expression),
      String(s.memberCount ?? 0),
      String(s.roles?.length || 0),
      String(s.accessProfiles?.length || 0),
      String(s.entitlements?.length || 0),
      draftStatus(s),
    ]),
    // Long names and rules wrap inside fixed columns that fit the page
    // (182mm between the margins) instead of widening the table.
    styles: { fontSize: 8, overflow: "linebreak" },
    columnStyles: { 0: { cellWidth: 34 }, 1: { cellWidth: "auto" }, 2: { cellWidth: 16 }, 3: { cellWidth: 13 }, 4: { cellWidth: 17 }, 5: { cellWidth: 20 }, 6: { cellWidth: 30 } },
    tableWidth: "auto",
    headStyles: { fillColor: GREY_HEAD },
  });

  // A page per segment with its access, for any that has some.
  const sections = [];
  for (const s of suggestions) {
    if (!(s.roles?.length || s.accessProfiles?.length || s.entitlements?.length)) continue;
    doc.addPage();
    const first = doc.getNumberOfPages();
    doc.setFontSize(13);
    doc.setTextColor(20);
    doc.text(s.name, 14, 18);
    doc.setFontSize(9);
    doc.setTextColor(100);
    doc.text(`${plural(s.memberCount ?? 0, "member")} · ${draftStatus(s)}`, 14, 24);
    const ruleLines = doc.splitTextToSize(`Members Rule: ${describeExpression(s.visibilityCriteria?.expression)}`, 182);
    doc.text(ruleLines, 14, 29);
    accessTables(doc, 29 + ruleLines.length * 4 + 4, s);
    sections.push({ name: s.name, first, last: doc.getNumberOfPages() });
  }
  // Footer (segment name, Page X of Y) and a "(continued)" header on every
  // page after a segment's first — same as the detail reports.
  stampSectionPages(doc, sections);
  return doc;
}

export function printAccessSegmentScanPdf({ tenant, scan }) {
  return print(buildAccessSegmentScanPdf({ tenant, scan }), `${tenant || "segments"}_segments-draft_${filenameStamp(new Date())}.pdf`);
}

// ─── Browse > Segments list ──────────────────────────────────────────────────

const listFilename = () => `segments_${filenameStamp(new Date())}.pdf`;

export function printIscSegmentsListPdf({ tenant, segments, searchQuery }) {
  const doc = new jsPDF();
  const startY = header(doc, "Segments", [
    `Tenant: ${tenant || "—"}`,
    `Generated: ${new Date().toLocaleString()} · ${plural(segments.length, "segment")}`,
    searchQuery ? `Search filter: "${searchQuery}"` : null,
  ]);
  autoTable(doc, {
    startY,
    head: [["Segment", "Description", "Status"]],
    body: segments.map((s) => [s.name, s.description || "—", s.active ? "Active" : "Inactive"]),
    styles: { fontSize: 9, overflow: "linebreak" },
    columnStyles: { 0: { cellWidth: 50 }, 1: { cellWidth: "auto" }, 2: { cellWidth: 20 } },
    headStyles: { fillColor: GREY_HEAD },
  });
  return print(doc, listFilename());
}

// `segments` carry roles / accessProfiles / entitlements ({ name, source })
// fetched by the caller.
export function printIscSegmentsDetailPdf({ tenant, segments, searchQuery }) {
  const doc = new jsPDF();
  const startY = header(doc, "Segments — Detail", [
    `Tenant: ${tenant || "—"}`,
    `Generated: ${new Date().toLocaleString()} · ${plural(segments.length, "segment")}`,
    searchQuery ? `Search filter: "${searchQuery}"` : null,
  ]);
  autoTable(doc, {
    startY,
    head: [["Segment", "Members Rule", "Status", "Roles", "Access Profiles", "Entitlements"]],
    body: segments.map((s) => [
      s.name,
      describeExpression(s.visibilityCriteria?.expression),
      s.active ? "Active" : "Inactive",
      String(s.roles?.length || 0),
      String(s.accessProfiles?.length || 0),
      String(s.entitlements?.length || 0),
    ]),
    styles: { fontSize: 8, overflow: "linebreak" },
    columnStyles: { 0: { cellWidth: 44 }, 1: { cellWidth: "auto" }, 2: { cellWidth: 18 }, 3: { cellWidth: 14 }, 4: { cellWidth: 18 }, 5: { cellWidth: 22 } },
    tableWidth: "auto",
    headStyles: { fillColor: GREY_HEAD },
  });
  const sections = [];
  for (const s of segments) {
    doc.addPage();
    const first = doc.getNumberOfPages();
    doc.setFontSize(13);
    doc.setTextColor(20);
    doc.text(s.name, 14, 18);
    doc.setFontSize(9);
    doc.setTextColor(100);
    doc.text(`${s.active ? "Active" : "Inactive"}${s.owner?.name ? ` · Owner: ${s.owner.name}` : ""}`, 14, 24);
    const ruleLines = doc.splitTextToSize(`Members Rule: ${describeExpression(s.visibilityCriteria?.expression)}`, 182);
    doc.text(ruleLines, 14, 29);
    let y = 29 + ruleLines.length * 4 + 2;
    if (s.description) {
      const lines = doc.splitTextToSize(s.description, 180);
      doc.text(lines, 14, y);
      y += lines.length * 4 + 3;
    }
    y = accessTables(doc, y + 2, s);
    if (!(s.roles?.length || s.accessProfiles?.length || s.entitlements?.length)) {
      doc.text("No roles, access profiles or entitlements assigned.", 14, y);
    }
    sections.push({ name: s.name, first, last: doc.getNumberOfPages() });
  }
  // Footer (segment name, Page X of Y) and a "(continued)" header on every
  // page after a segment's first.
  stampSectionPages(doc, sections);
  return print(doc, listFilename());
}
