/**
 * ported/campaignReports.js
 * Browser-side port of the old Express POST /api/campaigns/reports/download
 * route (Browse > User Certifications > Get Reports).
 *
 * ISC's four per-campaign reports. GET /campaigns/{id}/reports lists the last
 * result of each ({ id, reportType, status, lastRunAt }), and
 * GET /reports/{resultId}?fileFormat=csv|pdf downloads one. That download is
 * content-negotiated (asking for JSON gets a 406), so it is fetched as bytes.
 *
 * Returns the same body the route used to send (files as base64, zip built
 * with JSZip). Failures throw routeError()/badRequest() so callers still read
 * err.response.data.error.
 */

import axios from "axios";
import JSZip from "jszip";
import { iscGet, iscPost, describeError, routeError, badRequest } from "../isc";

export const CAMPAIGN_REPORT_TYPES = {
  CAMPAIGN_COMPOSITION_REPORT: "Campaign Composition Report",
  CAMPAIGN_REMEDIATION_STATUS_REPORT: "Campaign Remediation Status Report",
  CAMPAIGN_STATUS_REPORT: "Campaign Status Report",
  CERTIFICATION_SIGNOFF_REPORT: "Certification Signoff Report",
};
const CAMPAIGN_REPORT_MAX_CAMPAIGNS = 25;
const CAMPAIGN_REPORT_POLL_MS = 3000;
const CAMPAIGN_REPORT_POLL_TRIES = 15; // ~45s per report that has to be (re)run
// ISC runs one operation per campaign at a time: asking for a report while a
// remediation scan (or another report) is still running gets 400
// "400.2.0 Operation in progress — A conflicting operation is already in
// progress". That's "not yet", not "no".
const CAMPAIGN_CONFLICT_RETRY_MS = 8000;
const CAMPAIGN_CONFLICT_RETRIES = 12; // ~95s
const isCampaignConflict = (err) =>
  err.response?.status === 400 &&
  (String(err.response?.data?.detailCode || "").startsWith("400.2.0") ||
    /conflicting operation/i.test(JSON.stringify(err.response?.data?.messages || "")));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Bytes ──────────────────────────────────────────────────────────────────

function bytesToBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
const utf8 = (bytes) => new TextDecoder("utf-8").decode(bytes);
const toBytes = (data) => (data instanceof ArrayBuffer ? new Uint8Array(data) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new TextEncoder().encode(String(data ?? "")));

// ─── CSV consolidation ──────────────────────────────────────────────────────

// Minimal RFC-4180 reader/writer for consolidating report CSVs: quoted fields,
// doubled quotes, commas and newlines inside quotes, \r\n or \n, optional BOM.
function parseCsvRows(text) {
  const src = String(text || "").replace(/^﻿/, "");
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => v !== ""));
}
const csvCell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;

// One CSV per report type across every campaign: a leading "Campaign" column
// says which campaign each row came from, and the header is the union of the
// campaigns' own headers in first-seen order, so no column is dropped and a
// campaign that lacks one just leaves it empty.
function consolidateCampaignCsvs(files) {
  const header = [];
  const seen = new Set();
  const parsed = files.map((f) => {
    const rows = parseCsvRows(utf8(f.bytes));
    const cols = rows[0] || [];
    for (const c of cols) if (!seen.has(c)) { seen.add(c); header.push(c); }
    return { campaign: f.campaign, cols, body: rows.slice(1) };
  });
  const lines = [["Campaign", ...header].map(csvCell).join(",")];
  let rowCount = 0;
  for (const { campaign, cols, body } of parsed) {
    const at = new Map(cols.map((c, i) => [c, i]));
    for (const r of body) {
      lines.push([campaign, ...header.map((h) => (at.has(h) ? r[at.get(h)] ?? "" : ""))].map(csvCell).join(","));
      rowCount++;
    }
  }
  return { bytes: new TextEncoder().encode("﻿" + lines.join("\r\n") + "\r\n"), rowCount };
}

// Control characters are folded into the same run as the other unsafe
// characters (mapped to one of them first) so a run collapses to one "-".
const safeFilePart = (s) =>
  Array.from(String(s || ""), (ch) => (ch.charCodeAt(0) < 32 ? "\\" : ch))
    .join("")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "untitled";

// ─── One report file ────────────────────────────────────────────────────────

async function fetchCampaignReportFile(campaignId, reportType, format) {
  const listRefs = async () => {
    const list = await iscGet(`/v2026/campaigns/${campaignId}/reports`);
    return (Array.isArray(list) ? list : []).find((r) => r.reportType === reportType) || null;
  };
  // Runs the report and waits for a NEW successful result (lastRunAt moves).
  const runAndWait = async (previousRunAt) => {
    for (let attempt = 0; ; attempt++) {
      try {
        await iscPost(`/v2026/campaigns/${campaignId}/run-report/${reportType}`, {});
        break;
      } catch (err) {
        if (!isCampaignConflict(err) || attempt >= CAMPAIGN_CONFLICT_RETRIES) {
          if (isCampaignConflict(err)) throw new Error("ISC is still running another operation on this campaign (a remediation scan or another report) — try again in a few minutes.");
          throw err;
        }
        await sleep(CAMPAIGN_CONFLICT_RETRY_MS);
      }
    }
    for (let i = 0; i < CAMPAIGN_REPORT_POLL_TRIES; i++) {
      await sleep(CAMPAIGN_REPORT_POLL_MS);
      const ref = await listRefs();
      const status = String(ref?.status || "").toUpperCase();
      if (ref && status === "SUCCESS" && ref.lastRunAt !== previousRunAt) return ref;
      if (ref && (status === "ERROR" || status === "TERMINATED") && ref.lastRunAt !== previousRunAt) {
        throw new Error(`ISC could not generate the report (status ${status}).`);
      }
    }
    throw new Error("The report was started but didn't finish in time — try again in a minute.");
  };
  // Straight through the global axios instance (the /api/isc interceptor
  // attaches the token) because the file comes back as bytes, not JSON.
  const download = (resultId) =>
    axios.get(`/api/isc/v2026/reports/${resultId}`, {
      params: { fileFormat: format },
      headers: { Accept: format === "pdf" ? "application/pdf, application/octet-stream, */*" : "application/csv, text/csv, application/octet-stream, */*" },
      responseType: "arraybuffer",
    });

  let ref = await listRefs();
  let reran = false;
  if (!ref || String(ref.status || "").toUpperCase() !== "SUCCESS") {
    ref = await runAndWait(ref?.lastRunAt);
    reran = true;
  }
  try {
    const resp = await download(ref.id);
    return { bytes: toBytes(resp.data), reran, lastRunAt: ref.lastRunAt };
  } catch (err) {
    // A listed result whose file has since been purged — run it fresh, once.
    const status = err.response?.status;
    if (reran || (status !== 404 && status !== 410 && status !== 400)) throw err;
    ref = await runAndWait(ref.lastRunAt);
    const resp = await download(ref.id);
    return { bytes: toBytes(resp.data), reran: true, lastRunAt: ref.lastRunAt };
  }
}

// ─── Route ──────────────────────────────────────────────────────────────────

/**
 * POST /api/campaigns/reports/download
 *   { campaignIds: [...], reportTypes: [...], format: "csv" | "pdf", zip: true|false,
 *     consolidate: true|false }   // CSV only: one file per report type, all campaigns
 *
 * { files: [{ name, campaign, reportType, contentBase64 }] } — or, with zip,
 * { zip: { name, contentBase64 }, files: [{ name, campaign, reportType }] } —
 * plus failures: [{ campaign, reportType, error }]. One report failing never
 * sinks the rest; every failure is named. Reports that were never run (or
 * whose file has expired) are run first, which is why this can take a while.
 */
export async function downloadCampaignReports(body = {}) {
  const format = String(body.format || "").toLowerCase();
  const campaignIds = [...new Set((Array.isArray(body.campaignIds) ? body.campaignIds : []).filter((id) => typeof id === "string" && /^[A-Za-z0-9-]+$/.test(id)))];
  const reportTypes = [...new Set((Array.isArray(body.reportTypes) ? body.reportTypes : []).filter((t) => CAMPAIGN_REPORT_TYPES[t]))];
  const wantZip = body.zip !== false;
  const consolidate = body.consolidate === true && format === "csv";
  if (format !== "csv" && format !== "pdf") throw badRequest("format must be csv or pdf.");
  if (campaignIds.length === 0) throw badRequest("Select at least one campaign.");
  if (campaignIds.length > CAMPAIGN_REPORT_MAX_CAMPAIGNS) throw badRequest(`Get reports for at most ${CAMPAIGN_REPORT_MAX_CAMPAIGNS} campaigns at a time.`);
  if (reportTypes.length === 0) throw badRequest("Pick at least one report.");

  try {
    const files = [];
    const failures = [];
    const usedNames = new Set();
    for (const campaignId of campaignIds) {
      let campaignName = campaignId;
      try {
        const c = await iscGet(`/v2026/campaigns/${campaignId}`);
        campaignName = c?.name || campaignId;
      } catch (err) {
        if (err.isPluginUnavailable) throw err;
        for (const reportType of reportTypes) failures.push({ campaign: campaignName, reportType, error: `Couldn't read the campaign: ${describeError(err)}` });
        continue;
      }
      for (const reportType of reportTypes) {
        try {
          const { bytes, reran } = await fetchCampaignReportFile(campaignId, reportType, format);
          let name = `${safeFilePart(campaignName)} - ${CAMPAIGN_REPORT_TYPES[reportType]}.${format}`;
          // Two campaigns can share a name — keep both files.
          for (let n = 2; usedNames.has(name.toLowerCase()); n++) name = `${safeFilePart(campaignName)} (${n}) - ${CAMPAIGN_REPORT_TYPES[reportType]}.${format}`;
          usedNames.add(name.toLowerCase());
          files.push({ name, campaign: campaignName, reportType, reran, bytes });
        } catch (err) {
          if (err.isPluginUnavailable) throw err;
          const raw = err.response?.data;
          const errBody = raw instanceof ArrayBuffer || ArrayBuffer.isView(raw) ? utf8(toBytes(raw)).slice(0, 300) : null;
          console.error(`[campaign-reports] ${campaignName} / ${reportType} failed:`, err.response?.status, errBody || err.response?.data || err.message);
          failures.push({ campaign: campaignName, reportType, error: err.response ? `ISC returned ${err.response.status}${errBody ? ` — ${errBody}` : ""}` : err.message });
        }
      }
    }

    // CSV consolidation: collapse the per-campaign files into one per report
    // type. A report whose CSV can't be parsed is left as its own file rather
    // than being dropped, and says so.
    if (consolidate && files.length > 0) {
      const stamp = new Date().toISOString().slice(0, 10);
      const merged = [];
      for (const reportType of reportTypes) {
        const group = files.filter((f) => f.reportType === reportType);
        if (group.length === 0) continue;
        try {
          const { bytes, rowCount } = consolidateCampaignCsvs(group);
          merged.push({
            name: `${CAMPAIGN_REPORT_TYPES[reportType]} - ${group.length} campaign${group.length === 1 ? "" : "s"} - ${stamp}.csv`,
            campaign: `${group.length} campaign${group.length === 1 ? "" : "s"}`,
            reportType, reran: group.some((f) => f.reran), bytes, rowCount,
          });
        } catch (err) {
          console.error(`[campaign-reports] consolidate ${reportType} failed:`, err.message);
          failures.push({ campaign: "(consolidation)", reportType, error: `Couldn't merge these CSVs (${err.message}) — included them separately instead.` });
          merged.push(...group);
        }
      }
      files.length = 0;
      files.push(...merged);
    }

    const listing = files.map(({ name, campaign, reportType, reran, rowCount }) => ({ name, campaign, reportType, reran, ...(rowCount != null ? { rowCount } : {}) }));
    if (wantZip && files.length > 0) {
      const stamp = new Date().toISOString().slice(0, 10);
      const zip = new JSZip();
      for (const f of files) zip.file(f.name, f.bytes);
      const contentBase64 = await zip.generateAsync({ type: "base64", compression: "DEFLATE" });
      return { zip: { name: `campaign-reports-${format}-${stamp}.zip`, contentBase64 }, files: listing, failures };
    }
    return { files: files.map((f, i) => ({ ...listing[i], contentBase64: bytesToBase64(f.bytes) })), failures };
  } catch (err) {
    console.error("[campaign-reports] download failed:", err.response?.status, err.message);
    throw routeError(err);
  }
}
