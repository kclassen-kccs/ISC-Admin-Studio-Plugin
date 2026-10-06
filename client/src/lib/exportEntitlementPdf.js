import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { filenameStamp, PDF_GREY_HEAD as GREY_HEAD, openPdfOrDownload } from "./pdfUtils";

export function entitlementPdfFilename(entitlement) {
  return `${entitlement?.name || entitlement?.value || "entitlement"}_${filenameStamp(new Date())}.pdf`;
}

/**
 * Renders a single entitlement's detail into a jsPDF document — the same
 * fields shown on screen (source, attribute, value, privilege level, owner)
 * plus a table of the members currently holding it, then one table each for
 * the Roles, Access Profiles, Applications, and Data Segments tabs — same
 * data each tab's own panel fetches (listRolesByEntitlement,
 * listAccessProfilesByEntitlement, listEntitlementApplications,
 * getEntitlementSegments), just gathered up front so print doesn't depend
 * on which tab happens to be open. `members`/`totalMembers` mirror what the
 * screen shows (a capped page of members plus the real total), so the PDF
 * states the same "showing X of Y" caveat rather than implying it's an
 * exhaustive list when it isn't.
 *
 * Accepts an existing `doc` (with `newPage`) so buildEntitlementsDetailPdf
 * below can render several entitlements into one document — same
 * multi-item pattern buildAccessProfilePdf/buildRolePdf use in
 * exportRolePdf.js. Each page this entitlement spans gets a footer with its
 * name, so a printed multi-page report never loses track of whose section
 * you're looking at.
 */
function buildEntitlementPdf({ tenant, entitlement, members, totalMembers, roles = [], accessProfiles = [], applications = [], segments = [], doc: existingDoc, newPage }) {
  const doc = existingDoc || new jsPDF();
  if (existingDoc && newPage) doc.addPage();
  const firstPage = doc.internal.getNumberOfPages();

  doc.setFontSize(16);
  doc.text(entitlement.name || entitlement.value || "Entitlement", 14, 18);
  doc.setFontSize(10);
  doc.setTextColor(100);
  doc.text(`Tenant: ${tenant || "—"}`, 14, 25);
  doc.text(`Generated: ${new Date().toLocaleString()}`, 14, 30);

  autoTable(doc, {
    startY: 37,
    body: [
      ["Source", entitlement.source?.name || "—"],
      ["Attribute", entitlement.attribute || "—"],
      ["Value", entitlement.value || "—"],
      ["Privilege level", entitlement.privilegeLevel?.effective || "—"],
      ["Owner", entitlement.owner?.name || "—"],
      ["Entitlement ID", entitlement.id],
    ],
    styles: { fontSize: 9 },
    columnStyles: { 0: { fontStyle: "bold", cellWidth: 32 } },
    theme: "plain",
  });

  let y = doc.lastAutoTable.finalY + 4;
  if (entitlement.description) {
    doc.setFontSize(9);
    doc.setTextColor(80);
    const lines = doc.splitTextToSize(entitlement.description, 180);
    doc.text(lines, 14, y);
    y += lines.length * 4.5 + 4;
  }

  y += 4;
  doc.setFontSize(10);
  doc.setTextColor(20);
  doc.text(`Members (${totalMembers})`, 14, y);
  autoTable(doc, {
    startY: y + 4,
    head: [["Name", "Title", "Department"]],
    body: members.length
      ? members.map((m) => [
          m.displayName || m.name || "—",
          m.attributes?.jobTitle || "—",
          m.attributes?.department || "—",
        ])
      : [["— none —", "", ""]],
    styles: { fontSize: 8 },
    headStyles: { fillColor: GREY_HEAD },
  });
  y = doc.lastAutoTable.finalY + 6;

  if (totalMembers > members.length) {
    doc.setFontSize(8);
    doc.setTextColor(120);
    doc.text(`Showing the first ${members.length} of ${totalMembers} members.`, 14, y);
    y += 6;
  }

  y += 4;
  doc.setFontSize(10);
  doc.setTextColor(20);
  doc.text(`Roles (${roles.length})`, 14, y);
  autoTable(doc, {
    startY: y + 4,
    head: [["Role", "Owner"]],
    body: roles.length ? roles.map((r) => [r.name, r.owner?.name || "—"]) : [["— none —", ""]],
    styles: { fontSize: 8 },
    headStyles: { fillColor: GREY_HEAD },
  });
  y = doc.lastAutoTable.finalY + 10;

  doc.setFontSize(10);
  doc.setTextColor(20);
  doc.text(`Access Profiles (${accessProfiles.length})`, 14, y);
  autoTable(doc, {
    startY: y + 4,
    head: [["Access Profile", "Owner"]],
    body: accessProfiles.length ? accessProfiles.map((p) => [p.name, p.owner?.name || "—"]) : [["— none —", ""]],
    styles: { fontSize: 8 },
    headStyles: { fillColor: GREY_HEAD },
  });
  y = doc.lastAutoTable.finalY + 10;

  doc.setFontSize(10);
  doc.setTextColor(20);
  doc.text(`Applications (${applications.length})`, 14, y);
  autoTable(doc, {
    startY: y + 4,
    head: [["Application", "Via"]],
    body: applications.length ? applications.map((a) => [a.name, (a.via || []).join(", ") || "—"]) : [["— none —", ""]],
    styles: { fontSize: 8 },
    headStyles: { fillColor: GREY_HEAD },
  });
  y = doc.lastAutoTable.finalY + 10;

  doc.setFontSize(10);
  doc.setTextColor(20);
  doc.text(`Data Segments (${segments.length})`, 14, y);
  autoTable(doc, {
    startY: y + 4,
    head: [["Data Segment"]],
    body: segments.length ? segments.map((s) => [s.name]) : [["— none —"]],
    styles: { fontSize: 8 },
    headStyles: { fillColor: GREY_HEAD },
  });

  const lastPage = doc.internal.getNumberOfPages();
  const pageHeight = doc.internal.pageSize.getHeight();
  const pageWidth = doc.internal.pageSize.getWidth();
  for (let p = firstPage; p <= lastPage; p++) {
    doc.setPage(p);
    doc.setFontSize(8);
    doc.setTextColor(150);
    doc.text(entitlement.name || entitlement.value || "Entitlement", pageWidth / 2, pageHeight - 10, { align: "center" });
  }
  doc.setPage(lastPage);

  return doc;
}

/**
 * Opens the entitlement's PDF in a new tab with the print dialog already
 * triggered. Popup blockers can stop the window opening, so fall back to
 * downloading rather than appearing to do nothing.
 */
export function printEntitlementPdf({ tenant, entitlement, members, totalMembers, roles, accessProfiles, applications, segments }) {
  const doc = buildEntitlementPdf({ tenant, entitlement, members, totalMembers, roles, accessProfiles, applications, segments });
  doc.autoPrint();
  return openPdfOrDownload(doc, entitlementPdfFilename(entitlement));
}

export function entitlementsDetailPdfFilename() {
  return `entitlements_${filenameStamp(new Date())}.pdf`;
}

/**
 * Renders a summary table of every given entitlement (name, source, owner)
 * on the first page, then each entitlement's own full detail (same layout
 * as buildEntitlementPdf — details, members, roles, access profiles,
 * applications, segments) starting on a fresh page — the "list then
 * detail" shape the Segment scan report (exportSegmentScanPdf.js) already
 * uses, applied here for the Entitlements list's Print Selected action.
 * Each item in `entitlements` must already carry its own
 * members/totalMembers/roles/accessProfiles/applications/segments —
 * gathering that per-entitlement data is the caller's job (see
 * EntitlementsPage's printSelected mutation), since it takes several API
 * calls per entitlement and this module only renders.
 */
function buildEntitlementsDetailPdf({ tenant, entitlements, searchQuery }) {
  const doc = new jsPDF();

  doc.setFontSize(16);
  doc.text("Entitlements", 14, 18);
  doc.setFontSize(10);
  doc.setTextColor(100);
  doc.text(`Tenant: ${tenant || "—"}`, 14, 25);
  doc.text(`Generated: ${new Date().toLocaleString()} · ${entitlements.length} entitlement${entitlements.length === 1 ? "" : "s"}`, 14, 30);
  if (searchQuery) doc.text(`Search filter: "${searchQuery}"`, 14, 35);

  autoTable(doc, {
    startY: searchQuery ? 42 : 37,
    head: [["Entitlement Name", "Source", "Owner"]],
    body: entitlements.map((e) => [e.name || e.value, e.source?.name || "—", e.owner?.name || "—"]),
    styles: { fontSize: 9 },
    headStyles: { fillColor: GREY_HEAD },
  });

  entitlements.forEach((entitlement) => {
    buildEntitlementPdf({
      tenant,
      entitlement,
      members: entitlement.members || [],
      totalMembers: entitlement.totalMembers ?? 0,
      roles: entitlement.roles,
      accessProfiles: entitlement.accessProfiles,
      applications: entitlement.applications,
      segments: entitlement.segments,
      doc,
      newPage: true,
    });
  });

  return doc;
}

export function printEntitlementsDetailPdf({ tenant, entitlements, searchQuery }) {
  const doc = buildEntitlementsDetailPdf({ tenant, entitlements, searchQuery });
  doc.autoPrint();
  return openPdfOrDownload(doc, entitlementsDetailPdfFilename());
}

// Same detail report as printEntitlementsDetailPdf, but returned as base64
// (no window is opened) — used by the Entitlements list's Email Report
// action, which uploads the PDF to the server (see createRoleReport in
// lib/sailpoint.js — a generic report host, not role-specific despite the
// name) instead of printing it directly. Same technique as
// buildRolesDetailPdfBase64 in exportRolePdf.js.
export function buildEntitlementsDetailPdfBase64({ tenant, entitlements }) {
  const doc = buildEntitlementsDetailPdf({ tenant, entitlements });
  const dataUri = doc.output("datauristring");
  return dataUri.slice(dataUri.indexOf(",") + 1);
}
