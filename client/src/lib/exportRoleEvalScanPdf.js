import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { filenameStamp, PDF_GREY_HEAD as GREY_HEAD, openPdfOrDownload } from "./pdfUtils";

export function roleEvalScanPdfFilename(tenant) {
  return `${tenant || "role-evaluation"}_${filenameStamp(new Date())}.pdf`;
}

function statusText(r) {
  if (r.error) return "Error";
  if (r.accepted) return "Applied";
  if (r.hasSodViolations) return "SOD Violation";
  if (r.hasSuggestions) return "Needs Review";
  return "OK";
}

function sodCount(ev) {
  return (ev?.sodViolations?.length || 0) + (ev?.dimensionEvaluations || []).reduce((n, d) => n + (d.sodViolations?.length || 0), 0);
}

function flattenSodViolations(ev) {
  return [
    ...(ev?.sodViolations || []).map((v) => ({ ...v, dimensionName: null })),
    ...(ev?.dimensionEvaluations || []).flatMap((d) => (d.sodViolations || []).map((v) => ({ ...v, dimensionName: d.dimensionName }))),
  ];
}

/**
 * Renders a Role Evaluation scan into a jsPDF document — same shape as the
 * Role Model Draft / Data Segments Draft reports (exportRoleScanPdf.js /
 * exportSegmentScanPdf.js): a summary table of every role with findings,
 * then a page per role covering its SOD violations, remove/add candidates,
 * per-dimension gaps/redundancies, missing dimensions, and stale
 * dimensions, plus a final section for any suggested new roles.
 */
function buildRoleEvalScanPdf({ tenant, scan }) {
  const doc = new jsPDF();
  const results = scan.results || [];
  const reportable = results.filter((r) => r.hasSuggestions || r.hasSodViolations || r.mitigatedViolationPresent || r.error);

  doc.setFontSize(16);
  doc.text("Role Evaluation Report", 14, 18);
  doc.setFontSize(10);
  doc.setTextColor(100);
  doc.text(`Tenant: ${tenant || "—"}`, 14, 25);
  doc.text(`Started: ${new Date(scan.startedAt).toLocaleString()}`, 14, 30);
  doc.text(`Generated: ${new Date().toLocaleString()}`, 14, 35);
  doc.text(
    `Scope: ${
      scan.scopeRoleIds?.length > 0
        ? `${scan.scopeRoleIds.length} explicitly selected role${scan.scopeRoleIds.length === 1 ? "" : "s"}`
        : scan.scopeQuery
        ? `Search: ${scan.scopeQuery}`
        : "All roles"
    }`,
    14,
    40
  );
  doc.text(
    `${scan.scanned}${scan.totalRoles ? ` of ${scan.totalRoles}` : ""} role${(scan.totalRoles || scan.scanned) === 1 ? "" : "s"} evaluated — ${reportable.length} with findings`,
    14,
    45
  );
  if (scan.commonAccessRolesUsed?.length > 0) {
    doc.text(`Common Access roles in scope: ${scan.commonAccessRolesUsed.map((r) => r.name).join(", ")}`, 14, 50);
  }

  autoTable(doc, {
    startY: scan.commonAccessRolesUsed?.length > 0 ? 57 : 52,
    head: [["Role", "Type", "Status", "To Remove", "To Add", "Dim. Gaps", "SOD"]],
    body: reportable.map((r) => {
      const ev = r.evaluation;
      const dimGaps = (ev?.dimensionEvaluations || []).filter((d) => d.addCandidates.length > 0).length;
      return [
        r.roleName,
        r.dimensional ? "Dynamic" : "Standard",
        statusText(r),
        r.error ? "—" : String(ev?.removeCandidates?.length || 0),
        r.error ? "—" : String(ev?.addCandidates?.length || 0),
        r.error ? "—" : String(dimGaps),
        r.error ? "—" : String(sodCount(ev)),
      ];
    }),
    styles: { fontSize: 8, cellWidth: "wrap" },
    columnStyles: { 0: { cellWidth: 40 }, 2: { cellWidth: 26 } },
    headStyles: { fillColor: GREY_HEAD },
  });

  for (const r of reportable) {
    doc.addPage();
    doc.setFontSize(13);
    doc.setTextColor(20);
    doc.text(r.roleName, 14, 18);
    doc.setFontSize(9);
    doc.setTextColor(100);
    doc.text(`${r.dimensional ? "Dynamic" : "Standard"} · ${statusText(r)}`, 14, 24);

    if (r.error) {
      doc.setFontSize(9);
      doc.setTextColor(180, 40, 40);
      doc.text(doc.splitTextToSize(`Error: ${r.error}`, 180), 14, 32);
      continue;
    }

    const ev = r.evaluation || {};
    let y = 30;
    if (ev.summary) {
      doc.setFontSize(9);
      doc.setTextColor(80);
      const lines = doc.splitTextToSize(ev.summary, 180);
      doc.text(lines, 14, y);
      y += lines.length * 4 + 4;
    }

    const sods = flattenSodViolations(ev);
    if (sods.length > 0) {
      doc.setFontSize(10);
      doc.setTextColor(20);
      doc.text(`SOD Violations (${sods.length})`, 14, y);
      autoTable(doc, {
        startY: y + 4,
        head: [["Policy", "Where"]],
        body: sods.map((v) => [v.policyName, v.dimensionName ? `${v.dimensionName} dimension` : "Base role"]),
        styles: { fontSize: 8 },
        headStyles: { fillColor: GREY_HEAD },
      });
      y = doc.lastAutoTable.finalY + 8;
    }

    if ((ev.removeCandidates || []).length > 0) {
      doc.setFontSize(10);
      doc.setTextColor(20);
      doc.text(`To Remove (${ev.removeCandidates.length})`, 14, y);
      autoTable(doc, {
        startY: y + 4,
        head: [["Entitlement", "Reason"]],
        body: ev.removeCandidates.map((c) => [c.entitlement, c.reason || ""]),
        styles: { fontSize: 8, cellWidth: "wrap" },
        headStyles: { fillColor: GREY_HEAD },
      });
      y = doc.lastAutoTable.finalY + 8;
    }

    if ((ev.addCandidates || []).length > 0) {
      doc.setFontSize(10);
      doc.setTextColor(20);
      doc.text(`To Add (${ev.addCandidates.length})`, 14, y);
      autoTable(doc, {
        startY: y + 4,
        head: [["Entitlement", "Reason"]],
        body: ev.addCandidates.map((c) => [c.entitlement, c.reason || ""]),
        styles: { fontSize: 8, cellWidth: "wrap" },
        headStyles: { fillColor: GREY_HEAD },
      });
      y = doc.lastAutoTable.finalY + 8;
    }

    for (const d of ev.dimensionEvaluations || []) {
      if ((d.addCandidates || []).length === 0 && (d.removeCandidates || []).length === 0) continue;
      doc.setFontSize(10);
      doc.setTextColor(20);
      doc.text(`${d.dimensionName} Dimension`, 14, y);
      y += 4;
      if ((d.addCandidates || []).length > 0) {
        autoTable(doc, {
          startY: y,
          head: [["To Add", "Reason"]],
          body: d.addCandidates.map((c) => [c.entitlement, c.reason || ""]),
          styles: { fontSize: 8, cellWidth: "wrap" },
          headStyles: { fillColor: GREY_HEAD },
        });
        y = doc.lastAutoTable.finalY + 4;
      }
      if ((d.removeCandidates || []).length > 0) {
        autoTable(doc, {
          startY: y,
          head: [["Redundant", "Reason"]],
          body: d.removeCandidates.map((c) => [c.entitlement, c.reason || ""]),
          styles: { fontSize: 8, cellWidth: "wrap" },
          headStyles: { fillColor: GREY_HEAD },
        });
        y = doc.lastAutoTable.finalY + 4;
      }
      y += 4;
    }

    if ((ev.missingDimensions || []).length > 0) {
      doc.setFontSize(10);
      doc.setTextColor(20);
      doc.text(`Missing Dimensions (${ev.missingDimensions.length})`, 14, y);
      autoTable(doc, {
        startY: y + 4,
        head: [["Attribute = Value", "Suggested Entitlements"]],
        body: ev.missingDimensions.map((md) => [
          `${md.attrKey} = "${md.value}"`,
          (md.addCandidates || []).map((c) => c.entitlement).join(", ") || "—",
        ]),
        styles: { fontSize: 8, cellWidth: "wrap" },
        headStyles: { fillColor: GREY_HEAD },
      });
      y = doc.lastAutoTable.finalY + 8;
    }

    if ((ev.staleDimensions || []).length > 0) {
      doc.setFontSize(10);
      doc.setTextColor(20);
      doc.text(`Stale Dimensions (${ev.staleDimensions.length})`, 14, y);
      autoTable(doc, {
        startY: y + 4,
        head: [["Dimension", "Reason"]],
        body: ev.staleDimensions.map((sd) => [sd.dimensionName, sd.reason || ""]),
        styles: { fontSize: 8, cellWidth: "wrap" },
        headStyles: { fillColor: GREY_HEAD },
      });
    }
  }

  if ((scan.newRoleProposals || []).length > 0) {
    doc.addPage();
    doc.setFontSize(14);
    doc.setTextColor(20);
    doc.text("Suggested New Roles", 14, 18);
    doc.setFontSize(9);
    doc.setTextColor(100);
    doc.text("Combinations of attributes within a Common Access role's population that no existing role or dimension covers.", 14, 24);
    autoTable(doc, {
      startY: 30,
      head: [["Suggested Name", "Under", "Members", "Suggested Entitlements"]],
      body: scan.newRoleProposals.map((p) => [
        p.suggestedName,
        p.commonAccessRoleName,
        String(p.memberCount ?? 0),
        (p.suggestedEntitlements || []).map((e) => e.entitlement).join(", ") || "—",
      ]),
      styles: { fontSize: 8, cellWidth: "wrap" },
      headStyles: { fillColor: GREY_HEAD },
    });
  }

  return doc;
}

export function exportRoleEvalScanPdf({ tenant, scan }) {
  buildRoleEvalScanPdf({ tenant, scan }).save(roleEvalScanPdfFilename(tenant));
}

/**
 * Opens the same PDF in a new tab with the print dialog already triggered.
 * Popup blockers can stop the window opening, so fall back to downloading
 * rather than appearing to do nothing.
 */
export function printRoleEvalScanPdf({ tenant, scan }) {
  const doc = buildRoleEvalScanPdf({ tenant, scan });
  doc.autoPrint();
  return openPdfOrDownload(doc, roleEvalScanPdfFilename(tenant));
}
