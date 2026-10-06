import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { filenameStamp, PDF_GREY_HEAD as GREY_HEAD, openPdfOrDownload, stampSectionPages, SECTION_TABLE_MARGIN } from "./pdfUtils";
import { campaignStatusLabel, campaignTypeLabel, campaignScopeText, summarizeReviewItems, accessTypeLabel } from "./campaigns";

function pdfFilename(tenant, suffix) {
  return `${tenant || "certification-campaigns"}_${suffix}_${filenameStamp(new Date())}.pdf`;
}
const date = (d) => (d ? new Date(d).toLocaleDateString() : "—");
const dateTime = (d) => (d ? new Date(d).toLocaleString() : "—");

function campaignRow(c) {
  return [
    c.name || "—",
    campaignTypeLabel(c.type),
    campaignStatusLabel(c.status),
    date(c.deadline),
    c.totalCertifications != null ? `${c.completedCertifications ?? 0} / ${c.totalCertifications}` : "—",
    dateTime(c.created),
  ];
}

/** One table per status group, in the order given. */
function buildListPdf({ tenant, groups, title }) {
  const doc = new jsPDF();
  doc.setFontSize(16);
  doc.setTextColor(20);
  doc.text(title || "Certification Campaigns", 14, 18);
  doc.setFontSize(10);
  doc.setTextColor(100);
  doc.text(`Tenant: ${tenant || "—"}`, 14, 25);
  doc.text(`Generated: ${new Date().toLocaleString()}`, 14, 30);
  const total = groups.reduce((n, g) => n + g.campaigns.length, 0);
  doc.text(`${total} campaign${total === 1 ? "" : "s"}`, 14, 35);
  let y = 42;
  for (const g of groups) {
    if (g.campaigns.length === 0) continue;
    if (y > 250) { doc.addPage(); y = 18; }
    doc.setFontSize(12);
    doc.setTextColor(20);
    doc.text(`${g.label} (${g.campaigns.length})`, 14, y);
    autoTable(doc, {
      startY: y + 4,
      head: [["Campaign", "Type", "Status", "Deadline", "Certs done / total", "Created"]],
      body: g.campaigns.map(campaignRow),
      styles: { fontSize: 8, overflow: "linebreak" },
      columnStyles: { 0: { cellWidth: 60 }, 3: { cellWidth: 22 }, 4: { cellWidth: 26 } },
      headStyles: { fillColor: GREY_HEAD },
    });
    y = doc.lastAutoTable.finalY + 10;
  }
  stampSectionPages(doc, []);
  return doc;
}

function writeCampaignDetail(doc, { campaign: c, reviewItems }) {
  doc.setFontSize(14);
  doc.setTextColor(20);
  doc.text(c.name || "Campaign", 14, 18);
  doc.setFontSize(9);
  doc.setTextColor(100);
  const lines = [
    `${campaignTypeLabel(c.type)} · ${campaignStatusLabel(c.status)} · Deadline ${date(c.deadline)} · Created ${dateTime(c.created)}`,
    `Scope: ${campaignScopeText(c)}`,
    `Certifications: ${c.completedCertifications ?? 0} of ${c.totalCertifications ?? 0} completed · Notifications: ${c.emailNotificationEnabled ? "on" : "off"} · Auto-revoke undecided: ${c.autoRevokeAllowed ? "yes" : "no"} · Recommendations: ${c.recommendationsEnabled ? "on" : "off"} · Comments: ${c.mandatoryCommentRequirement || "—"}`,
    c.description ? `Description: ${c.description}` : null,
    (c.alerts || []).length ? `Alerts: ${c.alerts.map((a) => a.localizations?.[0]?.text || a.text || a.level).join(" · ")}` : null,
  ].filter(Boolean);
  let y = 24;
  for (const line of lines) {
    const wrapped = doc.splitTextToSize(line, 180);
    doc.text(wrapped, 14, y);
    y += 4.5 * wrapped.length;
  }
  const { users, access } = summarizeReviewItems(reviewItems || []);
  if (users.length === 0) {
    doc.text("No review items have been generated for this campaign yet.", 14, y + 4);
    return;
  }
  doc.setFontSize(11);
  doc.setTextColor(20);
  doc.text(`Users (${users.length})`, 14, y + 4);
  autoTable(doc, {
    startY: y + 7,
    head: [["User", "Reviewer", "Access items", "Decided"]],
    body: users.map((u) => [u.name, u.reviewer || "—", String(u.items.length), `${u.items.filter((i) => i.decided).length} / ${u.items.length}`]),
    styles: { fontSize: 8, overflow: "linebreak" },
    margin: SECTION_TABLE_MARGIN,
    headStyles: { fillColor: GREY_HEAD },
  });
  let y2 = doc.lastAutoTable.finalY + 8;
  if (y2 > 260) { doc.addPage(); y2 = 24; }
  doc.setFontSize(11);
  doc.setTextColor(20);
  doc.text(`Access items (${access.length})`, 14, y2);
  autoTable(doc, {
    startY: y2 + 3,
    head: [["Access item", "Type", "Source", "Users", "Held by"]],
    body: access.map((a) => [a.name, accessTypeLabel(a.type), a.source || "—", String(a.users.length), a.users.map((u) => u.name).join(", ")]),
    styles: { fontSize: 7.5, overflow: "linebreak" },
    columnStyles: { 1: { cellWidth: 24 }, 3: { cellWidth: 14 } },
    margin: SECTION_TABLE_MARGIN,
    headStyles: { fillColor: GREY_HEAD },
  });
}

export function printCampaignListPdf({ tenant, groups, title }) {
  const doc = buildListPdf({ tenant, groups, title });
  doc.autoPrint();
  return openPdfOrDownload(doc, pdfFilename(tenant, "list"));
}

/** One section per campaign: settings, then its users and access items from reviewItemsById (optional). */
export function printCampaignsDetailPdf({ tenant, campaigns, reviewItemsById = {} }) {
  const doc = new jsPDF();
  const sections = campaigns.map((c, i) => {
    if (i > 0) doc.addPage();
    const first = doc.getNumberOfPages();
    writeCampaignDetail(doc, { campaign: c, reviewItems: reviewItemsById[c.id] || [] });
    return { name: c.name || "Campaign", first, last: doc.getNumberOfPages() };
  });
  // Footer (campaign name, Page X of Y) and a "(continued)" header on every
  // page after a campaign's first — see stampSectionPages.
  stampSectionPages(doc, sections);
  doc.autoPrint();
  return openPdfOrDownload(doc, pdfFilename(tenant, campaigns.length === 1 ? "campaign" : "campaigns-detail"));
}
