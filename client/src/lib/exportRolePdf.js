import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { filenameStamp, PDF_GREY_HEAD as GREY_HEAD, openPdfOrDownload, stampSectionPages, SECTION_TABLE_MARGIN } from "./pdfUtils";
import { describeMembership } from "./roleMembership";

// Identities as a wrapped, comma-separated run of names rather than a table
// — a role with hundreds of members costs a page or two as a table and only a
// few lines like this. `members` carries displayName (the person's actual
// name; `name` is the username — see the server's note on that mixup).
// `total` is the count the server matched, so a list capped by the request
// limit says so instead of silently printing a partial roster.
const IDENTITY_LIST_WIDTH = 180;

function renderIdentityList(doc, y, label, members, total, unavailable) {
  const list = members || [];
  const count = typeof total === "number" ? total : list.length;
  doc.setFontSize(10);
  doc.setTextColor(20);
  doc.text(unavailable ? label : `${label} (${count.toLocaleString()})`, 14, y);
  y += 5;

  doc.setFontSize(8);
  // A list that couldn't be fetched must SAY so. Printing nothing at all
  // makes a partial document look complete — which is exactly how a missing
  // dimension went unnoticed.
  doc.setTextColor(unavailable ? 170 : 80);
  const names = list.map((m) => m.displayName || m.name || m.id).filter(Boolean);
  const truncated = count > names.length;
  const text = unavailable
    ? "— could not be loaded —"
    : names.length
      ? names.join(", ") + (truncated ? `, … and ${(count - names.length).toLocaleString()} more` : "")
      : "— none —";
  const lines = doc.splitTextToSize(text, IDENTITY_LIST_WIDTH);

  // Break the run across pages rather than letting it run off the bottom.
  const pageHeight = doc.internal.pageSize.getHeight();
  for (const line of lines) {
    if (y > pageHeight - 20) {
      doc.addPage();
      y = 18;
      doc.setFontSize(8);
      doc.setTextColor(80);
    }
    doc.text(line, 14, y);
    y += 4.5;
  }
  return y + 4;
}

export function rolePdfFilename(role) {
  return `${role?.name || "role"}_${filenameStamp(new Date())}.pdf`;
}

/**
 * Renders a single role's full detail into a jsPDF document — the same
 * fields shown on screen (type, status, owner, dates, membership rule,
 * entitlements/access profiles) plus a section per dimension with its own
 * membership rule and entitlements, for a dimensional role.
 */
function buildRolePdf({ tenant, role, dimensions, doc: existingDoc, newPage, searchQuery }) {
  const doc = existingDoc || new jsPDF();
  if (existingDoc && newPage) doc.addPage();
  const firstPage = doc.internal.getNumberOfPages();

  doc.setFontSize(16);
  doc.text(role.name, 14, 18);
  doc.setFontSize(10);
  doc.setTextColor(100);
  doc.text(`Tenant: ${tenant || "—"}`, 14, 25);
  doc.text(`Generated: ${new Date().toLocaleString()}`, 14, 30);
  if (searchQuery) doc.text(`Search filter: "${searchQuery}"`, 14, 35);

  autoTable(doc, {
    startY: searchQuery ? 42 : 37,
    body: [
      ["Type", role.dimensional ? "Dynamic" : "Standard"],
      ["Enabled", role.enabled ? "Yes" : "No"],
      ["Requestable", role.requestable ? "Yes" : "No"],
      ["Owner", role.owner?.name || "—"],
      ["Created", role.created ? new Date(role.created).toLocaleString() : "—"],
      ["Modified", role.modified ? new Date(role.modified).toLocaleString() : "—"],
      ["Role ID", role.id],
    ],
    styles: { fontSize: 9 },
    columnStyles: { 0: { fontStyle: "bold", cellWidth: 32 } },
    theme: "plain",
  });

  let y = doc.lastAutoTable.finalY + 4;
  if (role.description) {
    doc.setFontSize(9);
    doc.setTextColor(80);
    const lines = doc.splitTextToSize(role.description, 180);
    doc.text(lines, 14, y);
    y += lines.length * 4.5 + 4;
  }

  doc.setFontSize(10);
  doc.setTextColor(20);
  doc.text("Membership rule", 14, y);
  doc.setFontSize(9);
  doc.setTextColor(80);
  const membershipLines = doc.splitTextToSize(describeMembership(role.membership), 180);
  doc.text(membershipLines, 14, y + 5);
  y += 5 + membershipLines.length * 4.5 + 6;

  // Who the rule actually matches, immediately below the rule that defines
  // them. Only rendered when the caller supplied the members (the Role
  // Detail and Roles-list Detailed prints do; anywhere without member data
  // simply omits the section).
  if (role.members || role.membersUnavailable) {
    y = renderIdentityList(doc, y, role.dimensional ? "Base role identities" : "Identities",
      role.members, role.memberTotal, role.membersUnavailable);
  }

  if ((role.accessProfiles || []).length) {
    doc.setFontSize(10);
    doc.setTextColor(20);
    doc.text(`Access profiles (${role.accessProfiles.length})`, 14, y);
    autoTable(doc, {
      startY: y + 4,
      head: [["Access Profile"]],
      body: role.accessProfiles.map((ap) => [ap.name]),
      styles: { fontSize: 8 },
      headStyles: { fillColor: GREY_HEAD },
    });
    y = doc.lastAutoTable.finalY + 8;
  }

  const entitlements = role.entitlements || [];
  doc.setFontSize(10);
  doc.setTextColor(20);
  doc.text(
    `${role.dimensional ? "Base role entitlements" : "Entitlements"} (${entitlements.length})`,
    14, y
  );
  autoTable(doc, {
    startY: y + 4,
    head: [["Entitlement", "Source"]],
    body: entitlements.length ? entitlements.map((e) => [e.name, e.sourceName || "—"]) : [["— none —", ""]],
    styles: { fontSize: 8 },
    headStyles: { fillColor: GREY_HEAD },
  });
  y = doc.lastAutoTable.finalY + 8;

  if (role.dimensional) {
    for (const d of dimensions || []) {
      if (y > 250) {
        doc.addPage();
        y = 18;
      }
      doc.setFontSize(11);
      doc.setTextColor(20);
      doc.text(`Dimension: ${d.name}`, 14, y);
      y += 5;
      if (d.description) {
        doc.setFontSize(8);
        doc.setTextColor(100);
        doc.text(d.description, 14, y);
        y += 5;
      }
      doc.setFontSize(9);
      doc.setTextColor(80);
      const dimMembershipLines = doc.splitTextToSize(describeMembership(d.membership), 180);
      doc.text(dimMembershipLines, 14, y);
      y += dimMembershipLines.length * 4.5 + 3;

      if (d.members || d.membersUnavailable) {
        y = renderIdentityList(doc, y, "Identities", d.members, d.memberTotal, d.membersUnavailable);
      }

      const dimEnts = d.entitlements || [];
      autoTable(doc, {
        startY: y,
        head: [["Entitlement", "Source"]],
        body: dimEnts.length ? dimEnts.map((e) => [e.name, e.sourceName || "—"]) : [["— none unique to this dimension —", ""]],
        styles: { fontSize: 8 },
        headStyles: { fillColor: GREY_HEAD },
      });
      y = doc.lastAutoTable.finalY + 8;
    }
  }

  // Stamp every page this role's content landed on (it may have spilled
  // across several via the addPage() calls above) — not just the last one
  // — so the role name is identifiable from any page when printed loose.
  const lastPage = doc.internal.getNumberOfPages();
  const pageHeight = doc.internal.pageSize.getHeight();
  const pageWidth = doc.internal.pageSize.getWidth();
  for (let p = firstPage; p <= lastPage; p++) {
    doc.setPage(p);
    doc.setFontSize(8);
    doc.setTextColor(150);
    doc.text(role.name, pageWidth / 2, pageHeight - 10, { align: "center" });
  }
  doc.setPage(lastPage);

  return doc;
}

/**
 * Opens the role's PDF in a new tab with the print dialog already
 * triggered. Popup blockers can stop the window opening, so fall back to
 * downloading rather than appearing to do nothing.
 */
export function printRolePdf({ tenant, role, dimensions }) {
  const doc = buildRolePdf({ tenant, role, dimensions });
  doc.autoPrint();
  return openPdfOrDownload(doc, rolePdfFilename(role));
}

export function rolesListPdfFilename() {
  return `roles_${filenameStamp(new Date())}.pdf`;
}

/**
 * Renders a simple list of roles — name and owner only, one row per role —
 * for a quick roster-style printout rather than the full-detail version.
 */
function buildRolesListPdf({ tenant, roles, searchQuery }) {
  const doc = new jsPDF();

  doc.setFontSize(16);
  doc.text("Roles", 14, 18);
  doc.setFontSize(10);
  doc.setTextColor(100);
  doc.text(`Tenant: ${tenant || "—"}`, 14, 25);
  doc.text(`Generated: ${new Date().toLocaleString()} · ${roles.length} role${roles.length === 1 ? "" : "s"}`, 14, 30);
  if (searchQuery) doc.text(`Search filter: "${searchQuery}"`, 14, 35);

  autoTable(doc, {
    startY: searchQuery ? 42 : 37,
    head: [["Role Name", "Owner"]],
    body: roles.map((r) => [r.name, r.owner?.name || "—"]),
    styles: { fontSize: 9 },
    headStyles: { fillColor: GREY_HEAD },
  });

  return doc;
}

/**
 * Renders every role's full detail (same layout as buildRolePdf) into one
 * document, starting each role on a fresh page. `roles` must already carry
 * each role's `dimensions` array (fetched alongside the role detail), since
 * dimensional roles need it for their per-dimension sections.
 */
function buildRolesDetailPdf({ tenant, roles, searchQuery }) {
  let doc = null;
  roles.forEach((role, i) => {
    doc = buildRolePdf({ tenant, role, dimensions: role.dimensions, doc, newPage: i > 0, searchQuery });
  });
  return doc;
}

/**
 * Renders a brief report: each role's name, with its dimension names (if
 * any) indented on their own line underneath — no owner, entitlements, or
 * membership detail, just enough to see each role's dimensional shape at a
 * glance. `roles` must carry each role's `dimensions` array (dimension name
 * only is used).
 */
function buildRolesBriefPdf({ tenant, roles, searchQuery }) {
  const doc = new jsPDF();

  doc.setFontSize(16);
  doc.text("Roles — Brief Report", 14, 18);
  doc.setFontSize(10);
  doc.setTextColor(100);
  doc.text(`Tenant: ${tenant || "—"}`, 14, 25);
  doc.text(`Generated: ${new Date().toLocaleString()} · ${roles.length} role${roles.length === 1 ? "" : "s"}`, 14, 30);
  if (searchQuery) doc.text(`Search filter: "${searchQuery}"`, 14, 35);

  let y = searchQuery ? 45 : 40;
  const pageBottom = 285;
  for (const role of roles) {
    const dimensionNames = (role.dimensions || []).map((d) => d.name);
    const neededHeight = 6 + dimensionNames.length * 5;
    if (y + neededHeight > pageBottom) {
      doc.addPage();
      y = 18;
    }
    doc.setFontSize(10);
    doc.setTextColor(20);
    doc.setFont(undefined, "bold");
    doc.text(role.name, 14, y);
    doc.setFont(undefined, "normal");
    y += 6;

    doc.setFontSize(9);
    doc.setTextColor(90);
    for (const name of dimensionNames) {
      if (y > pageBottom) {
        doc.addPage();
        y = 18;
      }
      doc.text(name, 20, y);
      y += 5;
    }
    y += 2;
  }

  return doc;
}

export function printRolesBriefPdf({ tenant, roles, searchQuery }) {
  const doc = buildRolesBriefPdf({ tenant, roles, searchQuery });
  doc.autoPrint();
  return openPdfOrDownload(doc, rolesListPdfFilename());
}

export function printRolesListPdf({ tenant, roles, searchQuery }) {
  const doc = buildRolesListPdf({ tenant, roles, searchQuery });
  doc.autoPrint();
  return openPdfOrDownload(doc, rolesListPdfFilename());
}

export function printRolesDetailPdf({ tenant, roles, searchQuery }) {
  const doc = buildRolesDetailPdf({ tenant, roles, searchQuery });
  doc.autoPrint();
  return openPdfOrDownload(doc, rolesListPdfFilename());
}

// Same detail report as printRolesDetailPdf, but returned as base64 (no
// window is opened) — used by the Roles list's Email Report action, which
// uploads the PDF to the server (see createRoleReport in lib/sailpoint.js)
// instead of printing it directly.
export function buildRolesDetailPdfBase64({ tenant, roles, searchQuery }) {
  const doc = buildRolesDetailPdf({ tenant, roles, searchQuery });
  // jsPDF's datauristring is "data:application/pdf;filename=...;base64,<data>" —
  // only the part after the last comma is the actual base64 payload.
  const dataUri = doc.output("datauristring");
  return dataUri.slice(dataUri.indexOf(",") + 1);
}

export function segmentsListPdfFilename() {
  return `data_segments_${filenameStamp(new Date())}.pdf`;
}

// Simple list of Data Segments — name and description only, same roster
// style as printRolesListPdf.
function buildSegmentsListPdf({ tenant, segments, searchQuery }) {
  const doc = new jsPDF();

  doc.setFontSize(16);
  doc.text("Data Segments", 14, 18);
  doc.setFontSize(10);
  doc.setTextColor(100);
  doc.text(`Tenant: ${tenant || "—"}`, 14, 25);
  doc.text(`Generated: ${new Date().toLocaleString()} · ${segments.length} data segment${segments.length === 1 ? "" : "s"}`, 14, 30);
  if (searchQuery) doc.text(`Search filter: "${searchQuery}"`, 14, 35);

  autoTable(doc, {
    startY: searchQuery ? 42 : 37,
    head: [["Data Segment Name", "Description"]],
    body: segments.map((s) => [s.name, s.description || "—"]),
    styles: { fontSize: 9 },
    headStyles: { fillColor: GREY_HEAD },
  });

  return doc;
}

export function printSegmentsListPdf({ tenant, segments, searchQuery }) {
  const doc = buildSegmentsListPdf({ tenant, segments, searchQuery });
  doc.autoPrint();
  return openPdfOrDownload(doc, segmentsListPdfFilename());
}

// Same plain-English rendering as SegmentDetailPage's own describeExpression
// (a segment's memberFilter — distinct DSL from a role's membership.criteria,
// see server's segmentEqualsLeaf/segmentAndExpression) — duplicated here
// rather than shared, same reasoning as every other small client/server or
// page/export-lib pair in this app.
function describeSegmentCriteria(expr) {
  if (!expr) return "—";
  if (expr.operator === "AND" && expr.children?.length) {
    return expr.children.map(describeSegmentCriteria).filter(Boolean).join(" AND ");
  }
  if (expr.operator === "EQUALS") {
    return `${expr.attribute} = "${expr.value?.value ?? ""}"`;
  }
  return expr.operator || "—";
}

// A segment's Access Model carries one scopes[] entry per object type
// (ROLE/ENTITLEMENT) with a visibility mode — SELECTION is the only one
// with a specific count worth showing, the rest are just their mode.
function describeSegmentScope(scopes, type) {
  const s = (scopes || []).find((x) => x.scope === type);
  if (!s) return "—";
  if (s.visibility === "SELECTION") {
    const n = (s.scopeSelection || []).length;
    return `${n} selected`;
  }
  if (s.visibility === "ALL") return "All";
  if (s.visibility === "UNSEGMENTED") return "None";
  if (s.visibility === "FILTER") return "Filtered";
  return s.visibility || "—";
}

/**
 * Detailed list of Data Segments — one row per segment, but with status
 * (active/inactive, published/draft), membership criteria, and Access
 * Model summary (Roles/Entitlements) alongside name and description,
 * instead of just name and description.
 */
function buildSegmentsDetailPdf({ tenant, segments, searchQuery }) {
  const doc = new jsPDF();

  doc.setFontSize(16);
  doc.text("Data Segments — Detailed List", 14, 18);
  doc.setFontSize(10);
  doc.setTextColor(100);
  doc.text(`Tenant: ${tenant || "—"}`, 14, 25);
  doc.text(`Generated: ${new Date().toLocaleString()} · ${segments.length} data segment${segments.length === 1 ? "" : "s"}`, 14, 30);
  if (searchQuery) doc.text(`Search filter: "${searchQuery}"`, 14, 35);

  autoTable(doc, {
    startY: searchQuery ? 42 : 37,
    head: [["Name", "Status", "Criteria", "Roles", "Entitlements", "Description"]],
    body: segments.map((s) => [
      s.name,
      `${s.enabled ? "Active" : "Inactive"} · ${s.published ? "Published" : "Draft"}`,
      describeSegmentCriteria(s.memberFilter?.expression),
      describeSegmentScope(s.scopes, "ROLE"),
      describeSegmentScope(s.scopes, "ENTITLEMENT"),
      s.description || "—",
    ]),
    styles: { fontSize: 8, cellWidth: "wrap" },
    columnStyles: {
      0: { cellWidth: 28 },
      1: { cellWidth: 26 },
      2: { cellWidth: 42 },
      3: { cellWidth: 16 },
      4: { cellWidth: 20 },
      5: { cellWidth: "auto" },
    },
    headStyles: { fillColor: GREY_HEAD },
  });

  // Summary table above, then every segment gets its own page — same
  // "summary table, then a detail page per item" shape as the Segments
  // scan's own report (exportSegmentScanPdf.js) and Roles' own full-detail
  // print, just unconditional here rather than skipping a segment with no
  // assigned roles/entitlements (enrichSegmentsForReport on SegmentsPage
  // attaches assignedRoles/assignedEntitlements from GET /:id/access before
  // calling this — an empty list is "confirmed none," not "not fetched,"
  // so it's worth a page saying so rather than silently omitting it). Each
  // page gets a footer naming the segment and its page number, stamped once
  // the whole document exists (stampSectionPages below).
  const sections = [];
  for (const s of segments) {
    const roles = s.assignedRoles || [];
    const ents = s.assignedEntitlements || [];

    doc.addPage();
    const first = doc.getNumberOfPages();
    doc.setFontSize(13);
    doc.setTextColor(20);
    doc.text(s.name, 14, 18);
    doc.setFontSize(9);
    doc.setTextColor(100);
    doc.text(`${s.enabled ? "Active" : "Inactive"} · ${s.published ? "Published" : "Draft"}`, 14, 24);
    doc.text(`Criteria: ${describeSegmentCriteria(s.memberFilter?.expression)}`, 14, 29);
    if (s.description) doc.text(`Description: ${s.description}`, 14, 34);


    let y = s.description ? 41 : 36;
    doc.setFontSize(10);
    doc.setTextColor(20);
    doc.text(`Assigned Roles (${roles.length})`, 14, y);
    if (roles.length > 0) {
      autoTable(doc, {
        startY: y + 4,
        head: [["Role", "Enabled", "Entitlements"]],
        body: roles.map((r) => [r.name, r.enabled ? "Yes" : "No", String(r.entitlementCount ?? "—")]),
        styles: { fontSize: 8 },
        headStyles: { fillColor: GREY_HEAD },
        margin: SECTION_TABLE_MARGIN,
      });
      y = doc.lastAutoTable.finalY + 8;
    } else {
      doc.setFontSize(9);
      doc.setTextColor(140);
      doc.text("None", 14, y + 6);
      y += 14;
    }

    doc.setFontSize(10);
    doc.setTextColor(20);
    doc.text(`Assigned Entitlements (${ents.length})`, 14, y);
    if (ents.length > 0) {
      autoTable(doc, {
        startY: y + 4,
        head: [["Entitlement", "Via"]],
        body: ents.map((e) => [e.name, (e.via || []).join(" · ")]),
        styles: { fontSize: 8 },
        headStyles: { fillColor: GREY_HEAD },
        margin: SECTION_TABLE_MARGIN,
      });
    } else {
      doc.setFontSize(9);
      doc.setTextColor(140);
      doc.text("None", 14, y + 6);
    }

    sections.push({ name: s.name, first, last: doc.getNumberOfPages() });
  }

  // Footer (segment name, Page X of Y) and a "(continued)" header on every
  // page after a segment's first — see stampSectionPages.
  stampSectionPages(doc, sections);
  return doc;
}

export function printSegmentsDetailPdf({ tenant, segments, searchQuery }) {
  const doc = buildSegmentsDetailPdf({ tenant, segments, searchQuery });
  doc.autoPrint();
  return openPdfOrDownload(doc, segmentsListPdfFilename());
}

// ─── Sources ─────────────────────────────────────────────────────────────────

export function sourcesListPdfFilename() {
  return `sources_${filenameStamp(new Date())}.pdf`;
}

// Simple list of Sources — name, connector, and health, same roster style
// as printRolesListPdf/printSegmentsListPdf.
function buildSourcesListPdf({ tenant, sources, searchQuery }) {
  const doc = new jsPDF();

  doc.setFontSize(16);
  doc.text("Sources", 14, 18);
  doc.setFontSize(10);
  doc.setTextColor(100);
  doc.text(`Tenant: ${tenant || "—"}`, 14, 25);
  doc.text(`Generated: ${new Date().toLocaleString()} · ${sources.length} source${sources.length === 1 ? "" : "s"}`, 14, 30);
  if (searchQuery) doc.text(`Search filter: "${searchQuery}"`, 14, 35);

  autoTable(doc, {
    startY: searchQuery ? 42 : 37,
    head: [["Source Name", "Connector", "Health"]],
    body: sources.map((s) => [s.name, s.connectorName || s.type || "—", s.healthy ? "Healthy" : "Unhealthy"]),
    styles: { fontSize: 9 },
    headStyles: { fillColor: GREY_HEAD },
  });

  return doc;
}

export function printSourcesListPdf({ tenant, sources, searchQuery }) {
  const doc = buildSourcesListPdf({ tenant, sources, searchQuery });
  doc.autoPrint();
  return openPdfOrDownload(doc, sourcesListPdfFilename());
}

// Full detail for a set of (typically selected) Sources — one page per
// source, same "one entity per page" pattern as printRolesDetailPdf.
function buildSourcePdf({ tenant, source, doc: existingDoc, newPage }) {
  const doc = existingDoc || new jsPDF();
  if (existingDoc && newPage) doc.addPage();

  doc.setFontSize(16);
  doc.text(source.name, 14, 18);
  doc.setFontSize(10);
  doc.setTextColor(100);
  doc.text(`Tenant: ${tenant || "—"}`, 14, 25);
  doc.text(`Generated: ${new Date().toLocaleString()}`, 14, 30);

  autoTable(doc, {
    startY: 37,
    body: [
      ["Connector", source.connectorName || source.type || "—"],
      ["Health", source.healthy ? "Healthy" : "Unhealthy"],
      ["Owner", source.owner?.name || "—"],
      ["Description", source.description || "—"],
      ["Source ID", source.id],
    ],
    styles: { fontSize: 9 },
    columnStyles: { 0: { fontStyle: "bold", cellWidth: 32 } },
    theme: "plain",
  });

  return doc;
}

function buildSourcesDetailPdf({ tenant, sources }) {
  let doc = null;
  sources.forEach((source, i) => {
    doc = buildSourcePdf({ tenant, source, doc, newPage: i > 0 });
  });
  return doc;
}

export function printSourcesDetailPdf({ tenant, sources }) {
  const doc = buildSourcesDetailPdf({ tenant, sources });
  doc.autoPrint();
  return openPdfOrDownload(doc, sourcesListPdfFilename());
}

// Same base64 technique as buildRolesDetailPdfBase64 — used by the Sources
// list's Email Report action, which uploads the PDF to the server instead
// of printing it directly.
export function buildSourcesDetailPdfBase64({ tenant, sources }) {
  const doc = buildSourcesDetailPdf({ tenant, sources });
  const dataUri = doc.output("datauristring");
  return dataUri.slice(dataUri.indexOf(",") + 1);
}

export function accessProfilesListPdfFilename() {
  return `access_profiles_${filenameStamp(new Date())}.pdf`;
}

/**
 * Renders a simple list of access profiles — name, source, and owner, one
 * row per profile — for a quick roster-style printout. Same shape as
 * buildRolesListPdf.
 */
function buildAccessProfilesListPdf({ tenant, profiles, searchQuery }) {
  const doc = new jsPDF();

  doc.setFontSize(16);
  doc.text("Access Profiles", 14, 18);
  doc.setFontSize(10);
  doc.setTextColor(100);
  doc.text(`Tenant: ${tenant || "—"}`, 14, 25);
  doc.text(`Generated: ${new Date().toLocaleString()} · ${profiles.length} access profile${profiles.length === 1 ? "" : "s"}`, 14, 30);
  if (searchQuery) doc.text(`Search filter: "${searchQuery}"`, 14, 35);

  autoTable(doc, {
    startY: searchQuery ? 42 : 37,
    head: [["Access Profile Name", "Source", "Owner"]],
    body: profiles.map((p) => [p.name, p.source?.name || "—", p.owner?.name || "—"]),
    styles: { fontSize: 9 },
    headStyles: { fillColor: GREY_HEAD },
  });

  return doc;
}

export function printAccessProfilesListPdf({ tenant, profiles, searchQuery }) {
  const doc = buildAccessProfilesListPdf({ tenant, profiles, searchQuery });
  doc.autoPrint();
  return openPdfOrDownload(doc, accessProfilesListPdfFilename());
}

/**
 * Renders one access profile's full detail into a jsPDF document — same
 * fields shown on screen (source, requestable, enabled, owner, dates,
 * entitlements) — plus a centered role-name-style footer on every page it
 * lands on. Same pattern as buildRolePdf.
 */
function buildAccessProfilePdf({ tenant, profile, doc: existingDoc, newPage, searchQuery }) {
  const doc = existingDoc || new jsPDF();
  if (existingDoc && newPage) doc.addPage();
  const firstPage = doc.internal.getNumberOfPages();

  doc.setFontSize(16);
  doc.text(`${profile.name} Access Profile`, 14, 18);
  doc.setFontSize(10);
  doc.setTextColor(100);
  doc.text(`Tenant: ${tenant || "—"}`, 14, 25);
  doc.text(`Generated: ${new Date().toLocaleString()}`, 14, 30);
  if (searchQuery) doc.text(`Search filter: "${searchQuery}"`, 14, 35);

  autoTable(doc, {
    startY: searchQuery ? 42 : 37,
    body: [
      ["Source", profile.source?.name || "—"],
      ["Enabled", profile.enabled ? "Yes" : "No"],
      ["Requestable", profile.requestable ? "Yes" : "No"],
      ["Owner", profile.owner?.name || "—"],
      ["Created", profile.created ? new Date(profile.created).toLocaleString() : "—"],
      ["Modified", profile.modified ? new Date(profile.modified).toLocaleString() : "—"],
      ["Access Profile ID", profile.id],
    ],
    styles: { fontSize: 9 },
    columnStyles: { 0: { fontStyle: "bold", cellWidth: 32 } },
    theme: "plain",
  });

  let y = doc.lastAutoTable.finalY + 4;
  if (profile.description) {
    doc.setFontSize(9);
    doc.setTextColor(80);
    const lines = doc.splitTextToSize(profile.description, 180);
    doc.text(lines, 14, y);
    y += lines.length * 4.5 + 4;
  }

  const entitlements = profile.entitlements || [];
  doc.setFontSize(10);
  doc.setTextColor(20);
  doc.text(`Entitlements (${entitlements.length})`, 14, y);
  autoTable(doc, {
    startY: y + 4,
    head: [["Entitlement"]],
    body: entitlements.length ? entitlements.map((e) => [e.name]) : [["— none —"]],
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
    doc.text(profile.name, pageWidth / 2, pageHeight - 10, { align: "center" });
  }
  doc.setPage(lastPage);

  return doc;
}

/**
 * Renders every access profile's full detail (same layout as
 * buildAccessProfilePdf) into one document, starting each profile on a
 * fresh page. Same shape as buildRolesDetailPdf.
 */
function buildAccessProfilesDetailPdf({ tenant, profiles, searchQuery }) {
  let doc = null;
  profiles.forEach((profile, i) => {
    doc = buildAccessProfilePdf({ tenant, profile, doc, newPage: i > 0, searchQuery });
  });
  return doc;
}

export function printAccessProfilesDetailPdf({ tenant, profiles, searchQuery }) {
  const doc = buildAccessProfilesDetailPdf({ tenant, profiles, searchQuery });
  doc.autoPrint();
  return openPdfOrDownload(doc, accessProfilesListPdfFilename());
}

// Same base64 technique as buildRolesDetailPdfBase64 — used by the Access
// Profiles list's Email Report action, which uploads the PDF to the server
// instead of printing it directly.
export function buildAccessProfilesDetailPdfBase64({ tenant, profiles, searchQuery }) {
  const doc = buildAccessProfilesDetailPdf({ tenant, profiles, searchQuery });
  const dataUri = doc.output("datauristring");
  return dataUri.slice(dataUri.indexOf(",") + 1);
}

// ─── Applications ───────────────────────────────────────────────────────────

export function applicationsListPdfFilename() {
  return `applications_${filenameStamp(new Date())}.pdf`;
}

/**
 * Renders a simple list of applications — name, source, and owner, one row
 * per application — for a quick roster-style printout. Same shape as
 * buildAccessProfilesListPdf.
 */
function buildApplicationsListPdf({ tenant, apps, searchQuery }) {
  const doc = new jsPDF();

  doc.setFontSize(16);
  doc.text("Applications", 14, 18);
  doc.setFontSize(10);
  doc.setTextColor(100);
  doc.text(`Tenant: ${tenant || "—"}`, 14, 25);
  doc.text(`Generated: ${new Date().toLocaleString()} · ${apps.length} application${apps.length === 1 ? "" : "s"}`, 14, 30);
  if (searchQuery) doc.text(`Search filter: "${searchQuery}"`, 14, 35);

  autoTable(doc, {
    startY: searchQuery ? 42 : 37,
    head: [["Application Name", "Source", "Owner"]],
    body: apps.map((a) => [a.name, a.accountSource?.name || "—", a.owner?.name || "—"]),
    styles: { fontSize: 9 },
    headStyles: { fillColor: GREY_HEAD },
  });

  return doc;
}

export function printApplicationsListPdf({ tenant, apps, searchQuery }) {
  const doc = buildApplicationsListPdf({ tenant, apps, searchQuery });
  doc.autoPrint();
  return openPdfOrDownload(doc, applicationsListPdfFilename());
}


/**
 * Renders one application's full detail into a jsPDF document — the same
 * fields shown on screen (source, enabled, visible, requestable, owner,
 * accounts, dates) plus a centered app-name-style footer on every page it
 * lands on. Same pattern as buildAccessProfilePdf.
 */
function buildApplicationPdf({ tenant, app, doc: existingDoc, newPage, searchQuery }) {
  const doc = existingDoc || new jsPDF();
  if (existingDoc && newPage) doc.addPage();
  const firstPage = doc.internal.getNumberOfPages();

  doc.setFontSize(16);
  doc.text(`${app.name} Application`, 14, 18);
  doc.setFontSize(10);
  doc.setTextColor(100);
  doc.text(`Tenant: ${tenant || "—"}`, 14, 25);
  doc.text(`Generated: ${new Date().toLocaleString()}`, 14, 30);
  if (searchQuery) doc.text(`Search filter: "${searchQuery}"`, 14, 35);

  autoTable(doc, {
    startY: searchQuery ? 42 : 37,
    body: [
      ["Source", app.accountSource?.name || "—"],
      ["Enabled", app.enabled ? "Yes" : "No"],
      ["Visible", app.appCenterEnabled ? "Yes" : "No"],
      ["Requestable", app.provisionRequestEnabled ? "Yes" : "No"],
      ["Accounts", app.matchAllAccounts ? "All Users" : "Specific Users"],
      ["Owner", app.owner?.name || "—"],
      ["Created", app.created ? new Date(app.created).toLocaleString() : "—"],
      ["Modified", app.modified ? new Date(app.modified).toLocaleString() : "—"],
      ["Application ID", app.id],
    ],
    styles: { fontSize: 9 },
    columnStyles: { 0: { fontStyle: "bold", cellWidth: 32 } },
    theme: "plain",
  });

  let y = doc.lastAutoTable.finalY + 4;
  if (app.description) {
    doc.setFontSize(9);
    doc.setTextColor(80);
    const lines = doc.splitTextToSize(app.description, 180);
    doc.text(lines, 14, y);
    y += lines.length * 4.5 + 4;
  }

  const accessProfiles = app.accessProfiles || [];
  doc.setFontSize(10);
  doc.setTextColor(20);
  doc.text(`Access Profiles (${accessProfiles.length})`, 14, y);
  autoTable(doc, {
    startY: y + 4,
    head: [["Access Profile"]],
    body: accessProfiles.length ? accessProfiles.map((p) => [p.name]) : [["— none —"]],
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
    doc.text(app.name, pageWidth / 2, pageHeight - 10, { align: "center" });
  }
  doc.setPage(lastPage);

  return doc;
}

/**
 * Renders every application's full detail (same layout as
 * buildApplicationPdf) into one document, starting each application on a
 * fresh page. Same shape as buildAccessProfilesDetailPdf.
 */
function buildApplicationsDetailPdf({ tenant, apps, searchQuery }) {
  let doc = null;
  apps.forEach((app, i) => {
    doc = buildApplicationPdf({ tenant, app, doc, newPage: i > 0, searchQuery });
  });
  return doc;
}

export function printApplicationsDetailPdf({ tenant, apps, searchQuery }) {
  const doc = buildApplicationsDetailPdf({ tenant, apps, searchQuery });
  doc.autoPrint();
  return openPdfOrDownload(doc, applicationsListPdfFilename());
}
