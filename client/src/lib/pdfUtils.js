import JSZip from "jszip";

// File names can't contain slashes/colons — replace anything the OS would
// reject with a dash, and drop the day/time down to minute precision so
// repeat downloads of the same export sort naturally together.
export function filenameStamp(date) {
  return date
    .toLocaleString("sv-SE", { hour12: false })
    .replace(" ", "_")
    .replace(/:/g, "-");
}

// Same download-via-temporary-anchor technique as offlineSourceBackup.js's
// page-local helper — pulled up here so the Email Report dialog's "Download
// All as ZIP" button (shared across Roles/Entitlements/Access Profiles/
// Sources) doesn't have to duplicate it per page.
export function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Bundles the base64 PDFs the Email Report action already built (one per
// owner) into a single in-browser zip — same JSZip technique
// offlineSourceBackup.js's buildBackupZip uses for offline-source CSVs,
// just base64 input instead of plain text.
export async function buildPdfReportsZip(reports) {
  const zip = new JSZip();
  reports.forEach((r) => zip.file(r.filename, r.pdfBase64, { base64: true }));
  return zip.generateAsync({ type: "blob" });
}

export function reportsZipFilename(objectLabel) {
  return `${objectLabel.toLowerCase().replace(/\s+/g, "-")}-reports_${filenameStamp(new Date())}.zip`;
}

export const PDF_GREY_HEAD = [107, 114, 128];

// Popup blockers signal a blocked window inconsistently across browsers:
// Chrome/Firefox return null/undefined from window.open, but Safari (and
// some Chrome configurations) instead return a real Window object that's
// already closed — checking `!win` alone caught the first case but silently
// did nothing in the second ("works in some cases, not others"). Checking
// `.closed` too, and treating a missing `.closed` property as blocked as
// well, catches both.
function isPopupBlocked(win) {
  return !win || win.closed || typeof win.closed === "undefined";
}

export function openPdfOrDownload(doc, filename) {
  const win = window.open(doc.output("bloburl"), "_blank");
  if (isPopupBlocked(win)) {
    doc.save(filename);
    return false;
  }
  return true;
}

// Same fallback, for a plain blob/object URL that isn't a jsPDF document
// (e.g. a saved report fetched from the server as a blob) — downloads via a
// temporary anchor tag instead of jsPDF's own doc.save().
export function openBlobUrlOrDownload(url, filename) {
  const win = window.open(url, "_blank");
  if (isPopupBlocked(win)) {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    return false;
  }
  return true;
}

// Margins for a table on a report stamped by stampSectionPages: room at the
// top of a continuation page for the "(continued)" header, and at the
// bottom for the footer.
export const SECTION_TABLE_MARGIN = { top: 20, bottom: 16 };

/**
 * Stamps every page once the document is complete (only then is the page
 * count known): "Page X of Y" at the bottom right, and for pages belonging
 * to a section (e.g. one segment's own pages) the section's name at the
 * bottom left plus a "<name> (continued)" header on each page after the
 * section's first. `sections` is [{ name, first, last }] in page numbers.
 */
export function stampSectionPages(doc, sections = []) {
  const total = doc.getNumberOfPages();
  const width = doc.internal.pageSize.getWidth();
  const height = doc.internal.pageSize.getHeight();
  for (let p = 1; p <= total; p += 1) {
    doc.setPage(p);
    const section = sections.find((s) => p >= s.first && p <= s.last);
    doc.setFontSize(8);
    doc.setTextColor(140);
    doc.text(`Page ${p} of ${total}`, width - 14, height - 8, { align: "right" });
    if (section) {
      doc.text(doc.splitTextToSize(section.name, width - 60)[0], 14, height - 8);
      if (p > section.first) {
        doc.setFontSize(9);
        doc.setTextColor(90);
        doc.text(doc.splitTextToSize(`${section.name} (continued)`, width - 28)[0], 14, 12);
        doc.setDrawColor(220);
        doc.line(14, 14.5, width - 14, 14.5);
      }
    }
  }
}
