import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { filenameStamp, PDF_GREY_HEAD as GREY_HEAD, openPdfOrDownload } from "./pdfUtils";

export function skeletonScanPdfFilename(tenant) {
  return `${tenant || "skeleton-role-model"}_draft_${filenameStamp(new Date())}.pdf`;
}

export function skeletonRoleStatus(r) {
  if (r.roleId) return "created";
  if (r.status === "failed" || r.ok === false) return "failed";
  return "planned";
}
export function criteriaText(r) {
  return (r.criteria || []).map((c) => `${c.key} = "${c.value}"`).join(" AND ") || "—";
}
/** The plain-English membership rule, same wording the Role Model Draft report uses. */
function membershipRule(r) {
  const parts = (r.criteria || []).map((c) => `${c.key} = "${c.value}"`);
  if (!r.isCommonAccess) parts.push('cloudLifecycleState = "active"');
  return parts.join(" AND ") || "—";
}
function dimensionRule(r, value) {
  return `${membershipRule(r)} AND ${r.dimensionAttribute} = "${value}"`;
}
function typeText(r) {
  if (r.isCommonAccess) return "Common Access";
  return r.dimensional ? "Dynamic" : "Standard";
}
function dimensionRows(r) {
  return Array.isArray(r.dimensionCounts) && r.dimensionCounts.length
    ? r.dimensionCounts
    : (r.dimensionValues || []).map((value) => ({ value, members: null }));
}

/**
 * Renders a Skeleton Role Model draft into a jsPDF document — same shape as
 * the Role Model Draft report: a summary table of all proposed roles, then a
 * page per role covering its membership rule, members and each dimension
 * with its member count and status. Skeleton roles carry no entitlements.
 */
function buildSkeletonScanPdf({ tenant, scan }) {
  const doc = new jsPDF();
  const results = scan.results || [];

  doc.setFontSize(16);
  doc.text("Skeleton Role Model Draft", 14, 18);
  doc.setFontSize(10);
  doc.setTextColor(100);
  doc.text(`Tenant: ${tenant || "—"}`, 14, 25);
  doc.text(`Scan started: ${new Date(scan.startedAt).toLocaleString()}`, 14, 30);
  doc.text(`Generated: ${new Date().toLocaleString()}`, 14, 35);
  doc.text(`Attribute priority: ${(scan.attributeKeys || []).join(" > ") || "—"}`, 14, 40);
  doc.text(`Create Dynamic Roles: ${scan.createDynamicRoles ? "On" : "Off"} · Boundary: ${scan.roleBoundaryEnabled ? (scan.roleBoundaryAttributes || []).join(" + ") : "Off"}`, 14, 45);
  doc.text(`Naming: "${scan.rolePrefix || ""}" + value + "${scan.roleSuffix || ""}" · separator "${scan.attributeSeparator || ""}"${scan.scopeQuery ? ` · Scope: ${scan.scopeQuery}` : ""}`, 14, 50);

  autoTable(doc, {
    startY: 57,
    head: [["Proposed Role", "Type", "Members", "Dimensions", "Role Created"]],
    body: results.map((r) => [
      r.roleName,
      typeText(r),
      String(r.memberCount ?? 0),
      r.dimensional ? String(dimensionRows(r).length) : "—",
      skeletonRoleStatus(r) === "created" ? r.roleName : skeletonRoleStatus(r) === "failed" ? `Failed — ${r.error || "unknown"}` : "—",
    ]),
    styles: { fontSize: 8, cellWidth: "wrap" },
    columnStyles: { 0: { cellWidth: 60 }, 1: { cellWidth: 28 }, 2: { cellWidth: 18 }, 3: { cellWidth: 22 } },
    headStyles: { fillColor: [37, 99, 235] },
  });

  for (const r of results) {
    doc.addPage();
    doc.setFontSize(13);
    doc.setTextColor(20);
    doc.text(r.roleName, 14, 18);
    doc.setFontSize(9);
    doc.setTextColor(100);
    const dims = dimensionRows(r);
    doc.text(
      `${typeText(r)} · ${r.memberCount ?? 0} members · ${r.dimensional ? `${dims.length} dimensions` : "no dimensions"} · no entitlements${r.roleId ? ` · created in ISC (${r.roleId})` : ""}`,
      14, 24
    );
    doc.setFontSize(8);
    doc.setTextColor(120);
    const ruleLines = doc.splitTextToSize(`Membership rule: ${membershipRule(r)}`, 180);
    doc.text(ruleLines, 14, 29);

    autoTable(doc, {
      startY: 29 + ruleLines.length * 4 + 3,
      head: [["Member", "Email", "Manager"]],
      body: (r.members || []).length
        ? r.members.map((m) => [m.name || m.id, m.email || "—", m.manager || "—"])
        : [["—", "—", "—"]],
      styles: { fontSize: 8 },
      headStyles: { fillColor: GREY_HEAD },
    });

    if (r.dimensional) {
      const outcomes = new Map((r.dimensions || []).map((d) => [d.value, d]));
      const y = doc.lastAutoTable.finalY + 8;
      doc.setFontSize(10);
      doc.setTextColor(20);
      doc.text(r.roleId ? "Dimensions" : "Proposed dimensions", 14, y);
      autoTable(doc, {
        startY: y + 4,
        head: [["Membership Rule", "Members", "Status"]],
        body: dims.map((d) => {
          const o = outcomes.get(d.value);
          return [
            dimensionRule(r, d.value),
            d.members != null ? String(d.members) : "—",
            o ? (o.ok ? "Created" : `Failed — ${o.error || "unknown"}`) : "Not yet created",
          ];
        }),
        styles: { fontSize: 8, cellWidth: "wrap" },
        columnStyles: { 0: { cellWidth: "auto" }, 1: { cellWidth: 20 }, 2: { cellWidth: 40 } },
        headStyles: { fillColor: GREY_HEAD },
      });
    }
  }

  return doc;
}

/** Opens the PDF in a new tab with the print dialog already triggered; falls back to a download if blocked. */
export function printSkeletonScanPdf({ tenant, scan }) {
  const doc = buildSkeletonScanPdf({ tenant, scan });
  doc.autoPrint();
  return openPdfOrDownload(doc, skeletonScanPdfFilename(tenant));
}
