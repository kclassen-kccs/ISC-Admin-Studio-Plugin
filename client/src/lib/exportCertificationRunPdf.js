import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { filenameStamp, PDF_GREY_HEAD as GREY_HEAD, openPdfOrDownload, stampSectionPages, SECTION_TABLE_MARGIN } from "./pdfUtils";
import { describeCertSettings, describeCertFilters, certificationCriteriaText } from "./certificationSettings";

const ACCESS_TYPE_LABELS = { ROLE: "Role", ACCESS_PROFILE: "Access Profile", ENTITLEMENT: "Entitlement" };
const accessTypeLabel = (t) => ACCESS_TYPE_LABELS[t] || t || "—";

export function certificationRunPdfFilename(tenant, suffix) {
  return `${tenant || "certification-campaigns"}_${suffix}_${filenameStamp(new Date())}.pdf`;
}

function statusText(c) {
  if (c.campaignId) return `Created in ISC${c.campaignStatus ? ` (${c.campaignStatus})` : ""}${c.deadline ? ` · deadline ${new Date(c.deadline).toLocaleDateString()}` : ""}`;
  if (c.tooLarge) return c.error || "Too large — can't be created";
  if (c.status === "failed") return `Failed — ${c.error || "unknown error"}`;
  if (c.status === "empty") return "Nothing to certify — all items excluded by filters";
  return "Not created yet";
}

function accessBreakdown(c) {
  return `${c.accessCount ?? 0} (${c.roleCount ?? 0} roles · ${c.accessProfileCount ?? 0} access profiles · ${c.entitlementCount ?? 0} entitlements${c.excludedAccessCount ? ` · ${c.excludedAccessCount} excluded by filters` : ""})`;
}

/** Report header shared by every variant: tenant, run timing, attributes, campaign defaults. */
function writeRunHeader(doc, { tenant, run, title }) {
  const settings = describeCertSettings(run.settings);
  doc.setFontSize(16);
  doc.setTextColor(20);
  doc.text(title, 14, 18);
  doc.setFontSize(10);
  doc.setTextColor(100);
  const lines = [
    `Tenant: ${tenant || "—"}`,
    `Run started: ${new Date(run.startedAt).toLocaleString()} · Generated: ${new Date().toLocaleString()}`,
    `Attributes: ${(run.attributeKeys || []).join(" > ") || "—"}${run.scopeQuery ? ` · Scope: ${run.scopeQuery}` : ""}`,
    `Reviewer: each user's manager · Duration: ${settings.duration} (deadline set when each campaign is created)`,
    `Notifications: ${settings.notifications} · Undecided Access: ${settings.undecidedAccess} · Comments: ${settings.comments} · Size Limit: ${settings.sizeLimit}`,
    `${run.planned ?? 0} campaigns planned · ${run.created ?? 0} created in ISC${run.tooLarge ? ` · ${run.tooLarge} too large` : ""}${run.failed ? ` · ${run.failed} failed` : ""}`,
    `Filters: ${(run.filters?.summary?.length ? run.filters.summary : describeCertFilters(run.settings)).join("; ") || "None — all access"}`,
  ];
  let y = 25;
  for (const line of lines) {
    doc.text(line, 14, y);
    y += 5;
  }
  return y + 2;
}

function summaryTable(doc, startY, results) {
  autoTable(doc, {
    startY,
    head: [["Campaign", "Criteria", "Users", "Access items", "Status"]],
    body: results.map((c) => [
      c.name,
      certificationCriteriaText(c),
      String(c.identityCount ?? 0),
      accessBreakdown(c),
      statusText(c),
    ]),
    styles: { fontSize: 8, overflow: "linebreak" },
    columnStyles: { 2: { cellWidth: 14 }, 3: { cellWidth: 48 } },
    headStyles: { fillColor: GREY_HEAD },
  });
}

/** One campaign's settings header + members + every access item. */
function writeCampaignPages(doc, { run, campaign, addPage = true }) {
  const settings = describeCertSettings(run.settings);
  if (addPage) doc.addPage();
  const first = doc.getNumberOfPages();
  doc.setFontSize(13);
  doc.setTextColor(20);
  doc.text(campaign.name, 14, 18);
  doc.setFontSize(9);
  doc.setTextColor(100);
  const lines = [
    `${certificationCriteriaText(campaign)} · ${campaign.identityCount ?? 0} users · ${accessBreakdown(campaign)}`,
    `Type: Search (identities) · Reviewer: each user's manager · Status: ${statusText(campaign)}${campaign.campaignId ? ` · ISC id ${campaign.campaignId}` : ""}`,
    `Deadline: ${campaign.deadline ? new Date(campaign.deadline).toLocaleDateString() : `${settings.duration} from creation`} · Notifications: ${settings.notifications} · Undecided Access: ${settings.undecidedAccess} · Comments: ${settings.comments} · Size Limit: ${settings.sizeLimit}`,
    `Query: ${campaign.query || "—"}`,
  ];
  let y = 24;
  for (const line of lines) {
    const wrapped = doc.splitTextToSize(line, 180);
    doc.text(wrapped, 14, y);
    y += 4.5 * wrapped.length;
  }

  const members = campaign.members || [];
  autoTable(doc, {
    startY: y + 2,
    head: [["User", "Email", "Manager", "Roles", "Access Profiles", "Entitlements"]],
    body: members.map((m) => [
      m.name || m.id,
      m.email || "—",
      m.manager || "—",
      String(m.access.filter((a) => a.type === "ROLE").length),
      String(m.access.filter((a) => a.type === "ACCESS_PROFILE").length),
      String(m.access.filter((a) => a.type === "ENTITLEMENT").length),
    ]),
    styles: { fontSize: 8, overflow: "linebreak" },
    columnStyles: { 3: { cellWidth: 16 }, 4: { cellWidth: 26 }, 5: { cellWidth: 24 } },
    margin: SECTION_TABLE_MARGIN,
    headStyles: { fillColor: GREY_HEAD },
  });

  const items = members.flatMap((m) => m.access.map((a) => [m.name || m.id, accessTypeLabel(a.type), a.name, a.source || "—"]));
  if (items.length > 0) {
    autoTable(doc, {
      startY: doc.lastAutoTable.finalY + 6,
      head: [["User", "Type", "Access item", "Source"]],
      body: items,
      styles: { fontSize: 7.5, overflow: "linebreak" },
      columnStyles: { 1: { cellWidth: 26 } },
      margin: SECTION_TABLE_MARGIN,
      headStyles: { fillColor: GREY_HEAD },
    });
  }
  return { name: campaign.name, first, last: doc.getNumberOfPages() };
}

function buildSummaryPdf({ tenant, run }) {
  const doc = new jsPDF();
  const y = writeRunHeader(doc, { tenant, run, title: "User Certification Campaign Drafts — Summary" });
  summaryTable(doc, y, run.results || []);
  stampSectionPages(doc, []);
  return doc;
}

function buildDetailPdf({ tenant, run }) {
  const doc = new jsPDF();
  const y = writeRunHeader(doc, { tenant, run, title: "User Certification Campaign Drafts — Detailed" });
  summaryTable(doc, y, run.results || []);
  const sections = (run.results || []).map((campaign) => writeCampaignPages(doc, { run, campaign }));
  // Footer (campaign name, Page X of Y) and a "(continued)" header on every
  // page after a campaign's first — see stampSectionPages.
  stampSectionPages(doc, sections);
  return doc;
}

function buildCampaignPdf({ run, campaign }) {
  const doc = new jsPDF();
  stampSectionPages(doc, [writeCampaignPages(doc, { run, campaign, addPage: false })]);
  return doc;
}

/** Summary: one table of every campaign in the run. Returns false if the pop-up was blocked (downloaded instead). */
export function printCertificationRunSummaryPdf({ tenant, run }) {
  const doc = buildSummaryPdf({ tenant, run });
  doc.autoPrint();
  return openPdfOrDownload(doc, certificationRunPdfFilename(tenant, "summary"));
}

/** Detailed: the summary table, then a section per campaign with its users and every access item. Needs a run fetched with full: true. */
export function printCertificationRunDetailPdf({ tenant, run }) {
  const doc = buildDetailPdf({ tenant, run });
  doc.autoPrint();
  return openPdfOrDownload(doc, certificationRunPdfFilename(tenant, "detailed"));
}

/** One campaign: settings header, users, access items. */
export function printCertificationCampaignPdf({ tenant, run, campaign }) {
  const doc = buildCampaignPdf({ run, campaign });
  doc.autoPrint();
  const slug = String(campaign.value || "campaign").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  return openPdfOrDownload(doc, certificationRunPdfFilename(tenant, `campaign-${slug}`));
}
