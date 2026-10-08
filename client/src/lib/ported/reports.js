/**
 * ported/reports.js
 * Browser-side port of the old Express /api/role-reports and /api/reports
 * routes. The server kept the PDFs on disk (or S3) with small metadata
 * records; the plugin keeps both in the per-tenant IndexedDB record store
 * (lib/store.js), with the same 2-week retention.
 *
 * The role-reports token link was a PUBLIC URL the server served without a
 * session, so an email recipient could open it. There is no server now, so
 * the link returned by createRoleReport() only resolves in THIS browser (the
 * PDF never leaves it) — it points at the plugin's own My Reports page, where
 * the sender's saved copy of the same report is listed.
 *
 * Each export returns the same body the route used to send. Failures throw
 * routeError()/badRequest() so callers still read err.response.data.error.
 */

import { badRequest } from "../isc";
import { recordStore } from "../store";
import { getCredentials } from "../sailpoint";

// token -> { filename, createdAt, tenant, pdfBase64 }
const roleReports = () => recordStore("role-reports");
// id -> { filename, title, generatedBy, tenant, createdAt, pdfBase64 }
const savedReports = () => recordStore("saved-reports");

// Matches what the email body itself tells the recipient ("available for
// 2 weeks"). Pruned on every report created, so no separate scheduler.
const ROLE_REPORT_RETENTION_MS = 14 * 24 * 60 * 60 * 1000; // 2 weeks

const randomHex = (bytes) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");

function pdfBlob(base64) {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return new Blob([bytes], { type: "application/pdf" });
}

const fresh = (meta) => meta && new Date(meta.createdAt).getTime() >= Date.now() - ROLE_REPORT_RETENTION_MS;

async function prune(store) {
  const cutoff = Date.now() - ROLE_REPORT_RETENTION_MS;
  for (const [key, meta] of Object.entries(await store.all())) {
    if (new Date(meta.createdAt).getTime() < cutoff) await store.delete(key);
  }
}

// Where a role-report link points: the plugin's My Reports page, carrying
// the token so the report can be looked up again in this browser.
function roleReportUrl(token) {
  const base = `${window.location.origin}${window.location.pathname}${window.location.search}`;
  return `${base}#/reports?role-report=${token}`;
}

// ─── Role reports (Email Report links) ─────────────────────────────────────

/**
 * POST /api/role-reports — { filename, pdfBase64 } → { token, url }
 * Stores a PDF (built client-side via jsPDF) and returns a link to it. The
 * link is only usable in this browser (see the file header).
 */
export async function createRoleReport({ filename, pdfBase64 } = {}) {
  if (typeof pdfBase64 !== "string" || !pdfBase64) throw badRequest("pdfBase64 is required.");
  try {
    const token = randomHex(24);
    const createdAt = new Date().toISOString();
    await roleReports().put(
      token,
      {
        filename: typeof filename === "string" && filename ? filename : "role-report.pdf",
        createdAt,
        tenant: getCredentials()?.tenant || null,
        pdfBase64,
      },
      { ttlEpochMs: Date.now() + ROLE_REPORT_RETENTION_MS }
    );
    await prune(roleReports());
    return { token, url: roleReportUrl(token) };
  } catch (err) {
    if (err?.isRouteError) throw err;
    console.error("[role-reports] create failed:", err.message);
    throw badRequest("Failed to store the report.", 500);
  }
}

/**
 * GET /api/role-reports/:token → the PDF as a Blob (plus its filename).
 * Kept for ROLE_REPORT_RETENTION_MS, then 404s like it never existed.
 */
export async function getRoleReportBlob(token) {
  const meta = await roleReports().get(token);
  if (!fresh(meta) || !meta.pdfBase64) throw badRequest("This report link has expired or doesn't exist.", 404);
  const blob = pdfBlob(meta.pdfBase64);
  blob.filename = meta.filename;
  return blob;
}

// ─── My Reports (private, per-user saved copies) ───────────────────────────

/**
 * POST /api/reports — { filename, title, pdfBase64 } → { id }
 * Saves a private, per-user copy of a generated PDF for the signed-in
 * user's own "My Reports" list.
 */
export async function saveReport({ filename, title, pdfBase64 } = {}) {
  if (typeof pdfBase64 !== "string" || !pdfBase64) throw badRequest("pdfBase64 is required.");
  try {
    const id = randomHex(16);
    const creds = getCredentials();
    await savedReports().put(
      id,
      {
        filename: typeof filename === "string" && filename ? filename : "report.pdf",
        title: typeof title === "string" && title ? title : typeof filename === "string" && filename ? filename : "Report",
        generatedBy: creds?.identityId || null,
        tenant: creds?.tenant || null,
        createdAt: new Date().toISOString(),
        pdfBase64,
      },
      { ttlEpochMs: Date.now() + ROLE_REPORT_RETENTION_MS }
    );
    await prune(savedReports());
    return { id };
  } catch (err) {
    if (err?.isRouteError) throw err;
    console.error("[reports] create failed:", err.message);
    throw badRequest("Failed to save the report.", 500);
  }
}

/** GET /api/reports — the signed-in user's saved reports, newest first. */
export async function listMyReports() {
  const creds = getCredentials();
  return Object.entries(await savedReports().all())
    .filter(([, r]) => r.tenant === (creds?.tenant || null) && r.generatedBy === (creds?.identityId || null))
    .map(([id, r]) => ({ id, filename: r.filename, title: r.title, createdAt: r.createdAt }))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

/**
 * GET /api/reports/:id → the PDF as a Blob. Only the user who generated the
 * report can view it; 404 "Report not found." otherwise or once expired.
 */
export async function getReportBlob(id) {
  const creds = getCredentials();
  const meta = await savedReports().get(id);
  const ownedByCaller = meta && meta.generatedBy === (creds?.identityId || null) && meta.tenant === (creds?.tenant || null);
  if (!ownedByCaller || !meta.pdfBase64) throw badRequest("Report not found.", 404);
  const blob = pdfBlob(meta.pdfBase64);
  blob.filename = meta.filename;
  return blob;
}
