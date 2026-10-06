import toast from "react-hot-toast";
import { getCampaign, runCampaignRemediationScan, runCampaignReport, CAMPAIGN_REPORT_TYPES } from "./sailpoint";

// Remediation scan -> (optionally) regenerate the campaign's reports once the
// scan has finished.
//
// ISC never announces that a remediation scan has finished: POST
// /campaigns/{id}/run-remediation-scan just answers 202, and the scan never
// appears in /task-status or as an audit event (all verified live). Two
// indirect signals exist, and this uses both:
//  1. the campaign's own `modified` timestamp moves (once) about a minute
//     after a scan is requested;
//  2. ISC runs one operation per campaign at a time, so while the scan is
//     still running a report request is refused with 400 "400.2.0 — A
//     conflicting operation is already in progress" (seen live). Once ISC
//     ACCEPTS the report, the scan is over.
// So: wait for (1) — up to SCAN_WAIT_MS, then carry on regardless — and then
// request each report, retrying while ISC answers (2). The same conflict
// also arises between two reports on one campaign, hence the retry on each.
//
// Jobs live at module level, not in React state, so one keeps running (and
// still toasts when it ends) if the user navigates away from the list. A full
// page reload does drop them — there is nothing server-side to resume.
const SCAN_POLL_MS = 10000;
const SCAN_WAIT_MS = 5 * 60 * 1000;
const SETTLE_MS = 5000;
const CONFLICT_RETRY_MS = 10000;
const CONFLICT_RETRIES = 30; // ~5 minutes per report

const isConflict = (err) => {
  const d = err.response?.data;
  return err.response?.status === 400 &&
    (String(d?.detailCode || "").startsWith("400.2.0") || /conflicting operation/i.test(JSON.stringify(d?.messages || d?.error || "")));
};

const jobs = new Map(); // campaignId -> { id, name, state, regenerate, note }
const listeners = new Set();
let snapshot = [];

function publish() {
  snapshot = [...jobs.values()];
  for (const l of listeners) l();
}
function setJob(id, patch) {
  jobs.set(id, { ...jobs.get(id), ...patch });
  publish();
}

// useSyncExternalStore plumbing — see useCampaignScanJobs in the page.
export function subscribeScanJobs(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export const getScanJobsSnapshot = () => snapshot;

export const isScanJobActive = (j) => j.state === "scanning" || j.state === "regenerating";

/** Drops finished/failed jobs from the banner. */
export function clearFinishedScanJobs() {
  for (const [id, j] of jobs) if (!isScanJobActive(j)) jobs.delete(id);
  publish();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errText = (err) => err.response?.data?.error || err.response?.data?.messages?.[0]?.text || err.message;

async function regenerateReports(campaign, onWaiting) {
  let started = 0;
  const failures = [];
  for (const t of CAMPAIGN_REPORT_TYPES) {
    for (let attempt = 0; ; attempt++) {
      try {
        await runCampaignReport(campaign.id, t.value);
        started += 1;
        break;
      } catch (err) {
        if (isConflict(err) && attempt < CONFLICT_RETRIES) {
          onWaiting?.(t.label);
          await sleep(CONFLICT_RETRY_MS);
          continue;
        }
        failures.push(`${t.label}: ${isConflict(err) ? "ISC was still busy with this campaign after 5 minutes" : errText(err)}`);
        break;
      }
    }
  }
  return { started, failures };
}

async function runJob(campaign, regenerate) {
  const { id, name } = campaign;
  // Read `modified` BEFORE asking for the scan — it's the baseline the
  // completion check compares against.
  let baseline = null;
  if (regenerate) {
    try { baseline = (await getCampaign(id))?.modified || null; } catch { /* fall back to the timeout path */ }
  }

  try {
    await runCampaignRemediationScan(id);
  } catch (err) {
    setJob(id, { state: "failed", note: `Scan couldn't be started: ${errText(err)}` });
    toast.error(`${name}: ${errText(err)}`, { duration: 8000 });
    return { id, name, scanned: false };
  }
  if (!regenerate) {
    setJob(id, { state: "done", note: "Scan started" });
    return { id, name, scanned: true };
  }

  // Wait for the scan's footprint, or give up waiting after SCAN_WAIT_MS.
  let sawFinish = false;
  const deadline = Date.now() + SCAN_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(SCAN_POLL_MS);
    try {
      const modified = (await getCampaign(id))?.modified || null;
      if (modified && modified !== baseline && (!baseline || Date.parse(modified) > Date.parse(baseline))) { sawFinish = true; break; }
    } catch { /* transient — keep polling */ }
  }
  if (sawFinish) await sleep(SETTLE_MS);

  setJob(id, { state: "regenerating", note: sawFinish ? "Scan finished — regenerating reports" : "Couldn't confirm the scan finished — regenerating reports anyway" });
  const { started, failures } = await regenerateReports(campaign, (label) =>
    setJob(id, { note: `ISC is still busy with this campaign — waiting to regenerate the ${label}` })
  );
  const total = CAMPAIGN_REPORT_TYPES.length;
  if (failures.length === 0) {
    setJob(id, { state: "done", note: `${started} of ${total} reports regenerating${sawFinish ? "" : " (scan completion unconfirmed)"}` });
    if (sawFinish) toast.success(`${name}: remediation scan finished — regenerating ${started} report${started === 1 ? "" : "s"}. Give them a minute before downloading.`, { duration: 8000 });
    else toast(`${name}: couldn't confirm the scan finished within 5 minutes, so the ${started} reports were regenerated anyway. If the scan was still running, regenerate them again later.`, { duration: 12000 });
  } else {
    setJob(id, { state: "failed", note: `${started} of ${total} reports regenerating — ${failures.join("; ")}` });
    toast.error(`${name}: ${failures.length} report${failures.length === 1 ? "" : "s"} couldn't be regenerated — ${failures.join("; ")}`, { duration: 12000 });
  }
  return { id, name, scanned: true };
}

/**
 * Starts a remediation scan for each campaign.
 *
 * Without `regenerate`: requests each scan in turn and resolves with the
 * campaigns whose scan ISC accepted (failures toast individually).
 *
 * With `regenerate`: each campaign becomes a background job that requests its
 * scan, watches for it to finish, then regenerates all four reports. Those
 * jobs take minutes, so this resolves straight away with the campaigns that
 * were handed to a job; each job reports its own outcome by toast and in the
 * banner (a scan that can't even be started shows as failed there).
 */
export async function startRemediationScans(campaigns, { regenerate }) {
  const started = [];
  for (const c of campaigns) {
    if (jobs.has(c.id) && isScanJobActive(jobs.get(c.id))) continue; // already being watched
    jobs.set(c.id, { id: c.id, name: c.name, state: "scanning", regenerate, note: regenerate ? "Scan running — reports regenerate when it finishes" : "Starting scan" });
    publish();
    if (regenerate) {
      runJob(c, true); // deliberately not awaited
      started.push(c);
    } else {
      const r = await runJob(c, false);
      if (r.scanned) started.push(c);
    }
  }
  return started;
}
