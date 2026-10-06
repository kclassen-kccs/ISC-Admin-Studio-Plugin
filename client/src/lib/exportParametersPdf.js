import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { filenameStamp, PDF_GREY_HEAD as GREY_HEAD, openPdfOrDownload, stampSectionPages, SECTION_TABLE_MARGIN } from "./pdfUtils";

// Browse > Parameters reports. Private fields are never in the data (ISC
// only returns public fields) and are printed masked, not omitted, so the
// report still shows the parameter HAS a secret and when it last changed.

const MASK = "•••••••• (encrypted)";
const filename = () => `parameters_${filenameStamp(new Date())}.pdf`;

function header(doc, title, lines) {
  doc.setFontSize(16);
  doc.setTextColor(20);
  doc.text(title, 14, 18);
  doc.setFontSize(10);
  doc.setTextColor(100);
  const kept = lines.filter(Boolean);
  kept.forEach((l, i) => doc.text(l, 14, 25 + i * 5));
  return 25 + kept.length * 5 + 2;
}

const fmtValue = (v) => (Array.isArray(v) ? v.join(", ") : v == null || v === "" ? "—" : String(v));
const fmtDate = (d) => (d ? new Date(d).toLocaleString() : "—");

/** rows: [{ name, typeLabel, category, primaryValue, ownerName, description }] */
export function printParametersListPdf({ tenant, rows, searchQuery }) {
  const doc = new jsPDF();
  const startY = header(doc, "Parameters", [
    `Tenant: ${tenant || "—"}`,
    `Generated: ${new Date().toLocaleString()} · ${rows.length} parameter${rows.length === 1 ? "" : "s"}`,
    searchQuery ? `Search filter: "${searchQuery}"` : null,
  ]);
  autoTable(doc, {
    startY,
    head: [["Name", "Type", "Primary value", "Owner"]],
    body: rows.map((r) => [r.name, r.typeLabel, fmtValue(r.primaryValue), r.ownerName || "—"]),
    styles: { fontSize: 8, overflow: "linebreak" },
    columnStyles: { 0: { cellWidth: 50 }, 1: { cellWidth: 45 }, 2: { cellWidth: "auto" }, 3: { cellWidth: 35 } },
    headStyles: { fillColor: GREY_HEAD },
  });
  stampSectionPages(doc, []);
  return openPdfOrDownload(doc, filename());
}

/**
 * rows: [{ name, typeLabel, category, description, ownerName, lastModifiedAt,
 *          privateFieldsLastModifiedAt, fields: [{ label, value, private }] }]
 */
export function printParametersDetailPdf({ tenant, rows, searchQuery }) {
  const doc = new jsPDF();
  const startY = header(doc, "Parameters — Detail", [
    `Tenant: ${tenant || "—"}`,
    `Generated: ${new Date().toLocaleString()} · ${rows.length} parameter${rows.length === 1 ? "" : "s"}`,
    searchQuery ? `Search filter: "${searchQuery}"` : null,
  ]);
  autoTable(doc, {
    startY,
    head: [["Name", "Category", "Type", "Owner"]],
    body: rows.map((r) => [r.name, r.category || "—", r.typeLabel, r.ownerName || "—"]),
    styles: { fontSize: 8, overflow: "linebreak" },
    columnStyles: { 0: { cellWidth: 60 }, 1: { cellWidth: 30 }, 2: { cellWidth: "auto" }, 3: { cellWidth: 35 } },
    headStyles: { fillColor: GREY_HEAD },
  });

  const sections = [];
  for (const r of rows) {
    doc.addPage();
    const first = doc.getNumberOfPages();
    doc.setFontSize(13);
    doc.setTextColor(20);
    doc.text(doc.splitTextToSize(r.name, 182)[0], 14, 18);
    doc.setFontSize(9);
    doc.setTextColor(100);
    doc.text(`${r.category ? `${r.category} · ` : ""}${r.typeLabel} · Owner: ${r.ownerName || "—"}`, 14, 24);
    doc.text(`Last modified: ${fmtDate(r.lastModifiedAt)}${r.privateFieldsLastModifiedAt ? ` · Secret last changed: ${fmtDate(r.privateFieldsLastModifiedAt)}` : ""}`, 14, 29);
    let y = 35;
    if (r.description) {
      const lines = doc.splitTextToSize(r.description, 182);
      doc.text(lines, 14, y);
      y += lines.length * 4 + 3;
    }
    autoTable(doc, {
      startY: y + 2,
      head: [["Field", "Value"]],
      body: r.fields.map((f) => [f.label, f.private ? MASK : fmtValue(f.value)]),
      styles: { fontSize: 8, overflow: "linebreak" },
      columnStyles: { 0: { cellWidth: 55 }, 1: { cellWidth: "auto" } },
      margin: SECTION_TABLE_MARGIN,
      headStyles: { fillColor: GREY_HEAD },
    });
    sections.push({ name: r.name, first, last: doc.getNumberOfPages() });
  }
  stampSectionPages(doc, sections);
  return openPdfOrDownload(doc, filename());
}
