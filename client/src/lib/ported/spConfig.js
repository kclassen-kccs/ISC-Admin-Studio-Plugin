/**
 * ported/spConfig.js
 * Browser-side port of the old Express /api/sp-config/backup and /restore
 * routes — ISC's sp-config export/import jobs (POST, poll the job to
 * completion, download the result), run from the browser.
 *
 * Each export returns the same body the route used to send. Failures throw
 * routeError()/badRequest() so callers still read err.response.data.error.
 */

import { iscGet, iscPost, iscRaw, routeError, badRequest } from "../isc";
import { getCredentials } from "../sailpoint";

const SP_CONFIG_BASE = "/sp-config/v1";
const SP_CONFIG_POLL_INTERVAL_MS = 2000;
const SP_CONFIG_POLL_TIMEOUT_MS = 120000;

// Every exportable object type is listed explicitly — sp-config treats
// includeTypes as the whole selection (omitting it is not documented to mean
// "everything").
const SP_CONFIG_ALL_TYPES = [
  "ACCESS_PROFILE", "ACCESS_REQUEST_CONFIG", "ATTR_SYNC_SOURCE_CONFIG", "AUTH_ORG",
  "CAMPAIGN_FILTER", "CONNECTOR_RULE", "FORM_DEFINITION", "GOVERNANCE_GROUP",
  "IDENTITY_OBJECT_CONFIG", "IDENTITY_PROFILE", "LIFECYCLE_STATE", "NOTIFICATION_TEMPLATE",
  "PASSWORD_POLICY", "PASSWORD_SYNC_GROUP", "PUBLIC_IDENTITIES_CONFIG", "ROLE", "RULE",
  "SEGMENT", "SERVICE_DESK_INTEGRATION", "SOD_POLICY", "SOURCE", "TAG", "TRANSFORM",
  "TRIGGER_SUBSCRIPTION", "WORKFLOW",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Polls GET <base>/<kind>/<jobId> until COMPLETE; FAILED/CANCELLED or the
// 2-minute deadline throw with the job's own message.
async function waitForJob(kind, jobId) {
  const label = kind === "export" ? "Export" : "Import";
  const deadline = Date.now() + SP_CONFIG_POLL_TIMEOUT_MS;
  while (true) {
    const job = await iscGet(`${SP_CONFIG_BASE}/${kind}/${jobId}`);
    if (job?.status === "COMPLETE") return job;
    if (job?.status === "FAILED" || job?.status === "CANCELLED") {
      throw new Error(`${label} job ${job.status.toLowerCase()}: ${job?.message || "no further detail from SailPoint."}`);
    }
    if (Date.now() > deadline) {
      throw new Error(`${label} job didn't complete within 2 minutes — check its status in ISC directly.`);
    }
    await sleep(SP_CONFIG_POLL_INTERVAL_MS);
  }
}

/**
 * POST /api/sp-config/backup → { filename, data }
 * Runs a full sp-config export and returns the finished export JSON plus a
 * suggested filename.
 */
export async function backupSpConfig() {
  try {
    const started = await iscPost(`${SP_CONFIG_BASE}/export`, {
      description: `Admin Studio backup — ${new Date().toISOString()}`,
      excludeTypes: [],
      includeTypes: SP_CONFIG_ALL_TYPES,
      objectOptions: {},
    });
    const jobId = started?.jobId || started?.id;
    if (!jobId) throw new Error("SailPoint didn't return a job id for the export.");

    await waitForJob("export", jobId);

    const data = await iscGet(`${SP_CONFIG_BASE}/export/${jobId}/download`);
    const tenant = getCredentials()?.tenant || "tenant";
    const filename = `${tenant}-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    return { filename, data };
  } catch (err) {
    console.error("[sp-config] backup failed:", err.response?.data || err.message);
    throw routeError(err);
  }
}

/**
 * POST /api/sp-config/restore — { data: <the selected subset of an export> }
 * → { result: <the finished import job>, details: <per-object results> | null }
 * sp-config's import endpoint takes multipart/form-data: a "data" file part
 * holding the JSON, plus an "options" part.
 */
export async function restoreSpConfig(data) {
  if (!data || typeof data !== "object") throw badRequest("data (the selected objects to restore) is required.");
  try {
    const form = new FormData();
    form.append("data", new Blob([JSON.stringify(data)], { type: "application/json" }), "restore.json");
    form.append("options", new Blob([JSON.stringify({ excludeBackup: false })], { type: "application/json" }));

    // No Content-Type here: the browser sets multipart/form-data with its boundary.
    const started = (await iscRaw("post", `${SP_CONFIG_BASE}/import`, { data: form })).data;
    const jobId = started?.jobId || started?.id;
    if (!jobId) throw new Error("SailPoint didn't return a job id for the import.");

    const job = await waitForJob("import", jobId);

    // Per-object results (what actually imported vs. failed) live in a
    // separate downloadable file, same as export's job-vs-download split.
    let details = null;
    try {
      details = await iscGet(`${SP_CONFIG_BASE}/import/${jobId}/download`);
    } catch {
      // Non-fatal — the job status alone still tells the caller COMPLETE/FAILED.
    }

    return { result: job, details };
  } catch (err) {
    if (err?.isRouteError) throw err;
    console.error("[sp-config] restore failed:", err.response?.data || err.message);
    throw routeError(err);
  }
}
