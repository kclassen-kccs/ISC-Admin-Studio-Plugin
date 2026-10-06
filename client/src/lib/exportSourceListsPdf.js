import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { filenameStamp, PDF_GREY_HEAD as GREY_HEAD, openPdfOrDownload } from "./pdfUtils";

// Printouts for a source's Accounts and Entitlements tabs (Source detail).
// Each is one landscape document: a header naming the source, tenant, time
// and how many rows, then a table of EVERY row the tab could show (the caller
// fetches all pages first — the on-screen list is paged, the printout isn't),
// with a footer on every page. Same jsPDF + autoTable style as the other
// export*.js files so the app's printouts read as one set.

function header(doc, { title, sourceName, tenant, subtitle }) {
  doc.setFontSize(16);
  doc.setTextColor(0);
  doc.text(title, 14, 18);
  doc.setFontSize(10);
  doc.setTextColor(100);
  doc.text(`Source: ${sourceName || "—"}`, 14, 25);
  doc.text(`Tenant: ${tenant || "—"}`, 14, 30);
  doc.text(`Generated: ${new Date().toLocaleString()}`, 14, 35);
  if (subtitle) doc.text(subtitle, 14, 40);
  doc.setTextColor(0);
}

function footer(doc, label) {
  const pages = doc.internal.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFontSize(8);
    doc.setTextColor(150);
    doc.text(label, 14, doc.internal.pageSize.getHeight() - 8);
    doc.text(`Page ${i} of ${pages}`, doc.internal.pageSize.getWidth() - 14, doc.internal.pageSize.getHeight() - 8, { align: "right" });
  }
  doc.setTextColor(0);
}

function safeFile(s) {
  return String(s || "source").replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, "_").slice(0, 60);
}

/**
 * The source's accounts: account name, the identity it's correlated to (or
 * "Uncorrelated"), native identity, and Active / Disabled / Locked.
 * `query` (the tab's current search) is stated in the header when set.
 */
export function printSourceAccountsPdf({ tenant, sourceName, accounts, query }) {
  const doc = new jsPDF({ orientation: "landscape" });
  const n = accounts.length;
  header(doc, {
    title: "Accounts",
    sourceName,
    tenant,
    subtitle: `${n.toLocaleString()} account${n === 1 ? "" : "s"}${query ? ` matching "${query}"` : ""}` +
      ` · ${accounts.filter((a) => a.identity?.id).length.toLocaleString()} correlated to an identity` +
      ` · ${accounts.filter((a) => a.disabled).length.toLocaleString()} disabled`,
  });
  autoTable(doc, {
    startY: 46,
    head: [["Account", "Identity", "Native identity", "Status"]],
    body: accounts.map((a) => [
      a.name || a.displayName || a.nativeIdentity || "—",
      a.identity?.name || "Uncorrelated",
      a.nativeIdentity || "—",
      [a.disabled ? "Disabled" : "Active", a.locked ? "Locked" : null].filter(Boolean).join(", "),
    ]),
    styles: { fontSize: 8, cellPadding: 1.5, overflow: "linebreak" },
    headStyles: { fillColor: GREY_HEAD },
    columnStyles: { 0: { cellWidth: 75 }, 1: { cellWidth: 65 }, 3: { cellWidth: 28 } },
    margin: { left: 14, right: 14, bottom: 14 },
  });
  footer(doc, `${sourceName || "Source"} — accounts`);
  return openPdfOrDownload(doc, `${safeFile(sourceName)}_accounts_${filenameStamp(new Date())}.pdf`);
}

/**
 * The source's entitlements: name, attribute, value, owner, description and
 * flags (privileged / requestable). Same header/footer treatment.
 */
export function printSourceEntitlementsPdf({ tenant, sourceName, entitlements, query }) {
  const doc = new jsPDF({ orientation: "landscape" });
  const n = entitlements.length;
  header(doc, {
    title: "Entitlements",
    sourceName,
    tenant,
    subtitle: `${n.toLocaleString()} entitlement${n === 1 ? "" : "s"}${query ? ` matching "${query}"` : ""}` +
      ` · ${entitlements.filter((e) => e.privileged).length.toLocaleString()} privileged` +
      ` · ${entitlements.filter((e) => e.requestable).length.toLocaleString()} requestable`,
  });
  autoTable(doc, {
    startY: 46,
    head: [["Entitlement", "Attribute", "Value", "Owner", "Flags", "Description"]],
    body: entitlements.map((e) => [
      e.name || e.displayName || "—",
      e.attribute || "—",
      e.value || "—",
      e.owner?.name || "—",
      [e.privileged ? "Privileged" : null, e.requestable ? "Requestable" : null].filter(Boolean).join(", ") || "—",
      e.description || "",
    ]),
    styles: { fontSize: 8, cellPadding: 1.5, overflow: "linebreak" },
    headStyles: { fillColor: GREY_HEAD },
    columnStyles: { 0: { cellWidth: 55 }, 1: { cellWidth: 28 }, 2: { cellWidth: 55 }, 3: { cellWidth: 35 }, 4: { cellWidth: 26 } },
    margin: { left: 14, right: 14, bottom: 14 },
  });
  footer(doc, `${sourceName || "Source"} — entitlements`);
  return openPdfOrDownload(doc, `${safeFile(sourceName)}_entitlements_${filenameStamp(new Date())}.pdf`);
}
