import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { filenameStamp, PDF_GREY_HEAD as GREY_HEAD, openPdfOrDownload, stampSectionPages, SECTION_TABLE_MARGIN } from "./pdfUtils";
import { displayRoleName } from "./roleNaming";

export function roleScanPdfFilename(tenant) {
  return `${tenant || "role-scan"}_${filenameStamp(new Date())}.pdf`;
}

// The same entitlement name can legitimately exist on two different
// sources, so the report groups entitlements by source rather than a flat
// list — entitlements from scans persisted before source resolution existed
// fall into "Entitlements".
function groupEntitlementsBySource(entitlements) {
  const map = new Map();
  for (const e of entitlements || []) {
    const key = e.source || "Entitlements";
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(e);
  }
  return [...map.entries()]
    .map(([source, ents]) => [source, [...ents].sort((a, b) => (a.name || "").localeCompare(b.name || ""))])
    .sort((a, b) => a[0].localeCompare(b[0]));
}

/** Entitlement names unique to a dimension, one "Source: Name" per line
 *  (autoTable renders \n as line breaks), sorted by source then name, or a
 *  note when it has none. */
function dimensionEntitlements(d) {
  const groups = groupEntitlementsBySource(d.entitlements || []);
  if (groups.length === 0) return "— none unique to this dimension —";
  return groups
    .flatMap(([source, ents]) => ents.map((e) => `${source}: ${e.name}`))
    .join("\n");
}

function labelizeAttr(key) {
  return (key || "").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
}

// Mirrors exactly what create-role sends as the base role's membership
// criteria (see server's POST .../create-role): lifecycleState-ACTIVE always,
// ANDed with an EQUALS on each of the group's matched attributes.
function groupMembershipRule(group) {
  const parts = [`lifecycle state is "active"`];
  for (const c of group.attributeCriteria || []) {
    parts.push(`${labelizeAttr(c.key)} is "${c.value}"`);
  }
  return parts.join(" and ");
}

// Mirrors exactly what create-role sends as a dimension's own membership
// criteria: a single EQUALS on the attribute/value that dimension is
// scoped by — true both before a role exists (the scan's dimensionPreview)
// and after (the created dimension record).
function dimensionMembershipRule(d) {
  if (!d.attribute) return "—";
  return `${labelizeAttr(d.attribute)} is "${d.value}"`;
}

/**
 * Renders a peer-group role scan into a jsPDF document: a summary table of
 * all groups, then a page per group covering members, the base role's shared
 * entitlements, and each dimension with the entitlements it grants.
 */
function buildRoleScanPdf({ tenant, scan, groups, createDynamicRoles, attributeSeparator }) {
  const doc = new jsPDF();

  doc.setFontSize(16);
  doc.text("Role Model Draft", 14, 18);
  doc.setFontSize(10);
  doc.setTextColor(100);
  doc.text(`Tenant: ${tenant || "—"}`, 14, 25);
  doc.text(`Scan started: ${new Date(scan.startedAt).toLocaleString()}`, 14, 30);
  doc.text(`Generated: ${new Date().toLocaleString()}`, 14, 35);
  doc.text(`Attribute priority: ${(scan.attributeKeys || []).join(" > ") || "—"}`, 14, 40);
  doc.text(`Create Dynamic Roles: ${createDynamicRoles ? "On" : "Off"}`, 14, 45);
  let headerY = 45;
  if (scan.entitlementFetchFailures > 0) {
    headerY = 50;
    doc.setTextColor(180, 100, 0);
    doc.text(
      `Warning: entitlements couldn't be fetched for ${scan.entitlementFetchFailures} identit${scan.entitlementFetchFailures === 1 ? "y" : "ies"} — some peer groups may be missing or incomplete.`,
      14, headerY
    );
    doc.setTextColor(100);
  }

  autoTable(doc, {
    startY: headerY + 7,
    head: [["Peer Group", "Type", "Members", "Shared Entitlements", "Role Created"]],
    body: groups.map((g) => [
      displayRoleName(g, attributeSeparator),
      g.roleCreated?.dimensional ? "Dynamic" : "Standard",
      String(g.members.length),
      String(g.commonAccess.length),
      g.roleCreated ? g.roleCreated.name : "—",
    ]),
    styles: { fontSize: 8 },
    headStyles: { fillColor: [37, 99, 235] },
  });

  const sections = [];
  for (const g of groups) {
    doc.addPage();
    const first = doc.getNumberOfPages();
    doc.setFontSize(13);
    doc.setTextColor(20);
    doc.text(displayRoleName(g, attributeSeparator), 14, 18);
    doc.setFontSize(9);
    doc.setTextColor(100);
    doc.text(
      `${g.members.length} members · ${g.commonAccess.length} shared entitlements`,
      14, 24
    );
    doc.setFontSize(8);
    doc.setTextColor(120);
    const ruleLines = doc.splitTextToSize(`Membership rule: ${groupMembershipRule(g)}`, 180);
    doc.text(ruleLines, 14, 29);

    autoTable(doc, {
      startY: 29 + ruleLines.length * 4 + 3,
      head: [["Member", "Email", "Manager"]],
      body: g.members.map((m) => [m.name, m.email || "—", m.managerName || "—"]),
      styles: { fontSize: 8 },
      margin: SECTION_TABLE_MARGIN,
      headStyles: { fillColor: GREY_HEAD },
    });

    // The base role's entitlements — everything every member already shares.
    let y = doc.lastAutoTable.finalY + 8;
    doc.setFontSize(10);
    doc.setTextColor(20);
    doc.text("Base role entitlements", 14, y);
    autoTable(doc, {
      startY: y + 4,
      head: [["Source", "Entitlement"]],
      body: g.commonAccess.length
        ? groupEntitlementsBySource(g.commonAccess).flatMap(([source, ents]) =>
            ents.map((e) => [source, e.name])
          )
        : [["—", "no shared entitlements"]],
      styles: { fontSize: 8 },
      margin: SECTION_TABLE_MARGIN,
      headStyles: { fillColor: GREY_HEAD },
    });

    // Each dimension's own entitlements: what that value grants on top of the
    // base role, which is the whole point of splitting the role by dimension.
    // Before a role exists these come from the scan's preview, so the file is
    // useful for reviewing a proposed role rather than only a created one.
    const created = g.roleCreated?.dimensional ? g.roleCreated.dimensions || [] : [];
    const proposed = created.length ? [] : g.dimensionPreview || [];

    if (created.length || proposed.length) {
      y = doc.lastAutoTable.finalY + 8;
      doc.setFontSize(10);
      doc.setTextColor(20);
      doc.text(
        created.length ? "Dimensions and their entitlements" : "Proposed dimensions and their entitlements",
        14, y
      );
      autoTable(doc, {
        startY: y + 4,
        head: [["Membership Rule", "Status", "Entitlements"]],
        body: (created.length ? created : proposed).map((d) => [
          dimensionMembershipRule(d),
          created.length
            ? (d.ok ? "Created" : `Failed — ${d.error || "unknown"}`)
            : "Not yet created",
          dimensionEntitlements(d),
        ]),
        styles: { fontSize: 8, cellWidth: "wrap" },
        columnStyles: {
          0: { cellWidth: 45 },
          1: { cellWidth: 24 },
          2: { cellWidth: "auto" },
        },
        margin: SECTION_TABLE_MARGIN,
        headStyles: { fillColor: GREY_HEAD },
      });
    }
    sections.push({ name: displayRoleName(g, attributeSeparator), first, last: doc.getNumberOfPages() });
  }

  // Footer (role name, Page X of Y) and a "(continued)" header on every page
  // after a group's first — see stampSectionPages.
  stampSectionPages(doc, sections);
  return doc;
}

/** Downloads the scan as a PDF. */
export function exportRoleScanPdf({ tenant, scan, groups, createDynamicRoles, attributeSeparator }) {
  buildRoleScanPdf({ tenant, scan, groups, createDynamicRoles, attributeSeparator }).save(roleScanPdfFilename(tenant));
}

/**
 * Opens the same PDF in a new tab with the print dialog already triggered.
 * Popup blockers can stop the window opening, so fall back to downloading
 * rather than appearing to do nothing.
 */
export function printRoleScanPdf({ tenant, scan, groups, createDynamicRoles, attributeSeparator }) {
  const doc = buildRoleScanPdf({ tenant, scan, groups, createDynamicRoles, attributeSeparator });
  doc.autoPrint();
  return openPdfOrDownload(doc, roleScanPdfFilename(tenant));
}
