/**
 * ported/roleStats.js
 * Port of the server's Role Statistics Refresh routes:
 *   POST /api/insights/role-stats-refresh/run-now
 *   GET  /api/insights/role-stats-summary
 *
 * On the server a 60s scheduler tick also ran the scan on the configured
 * Preferences schedule; the plugin has no always-on process, so only the
 * "Run Now" path is ported — a scan runs while the tab is open (see
 * scanJobs.js) and the Home screen reads whatever the latest completed
 * scheduled-tagged scan recorded.
 *
 * Store "role-eval-scans" (shared with the Role Evaluation scan port): one
 * record per scan, keyed by scan id, in the server's record shape.
 */

import { iscGet, withApiRetry } from "../isc";
import { recordStore } from "../store";
import { tenantKey, mapWithConcurrency, getTenantSettings } from "./roleShared";
import { getCommonAccessRoleStatus } from "./roleCommonAccess";
import { startScheduledRoleEvalScan } from "./roleEvalScans";

const ROLE_EVAL_SCANS_STORE = "role-eval-scans";
const ROLE_EVAL_DIMENSION_CONCURRENCY = 2;

const roleEvalScans = () => recordStore(ROLE_EVAL_SCANS_STORE);

/**
 * POST /api/insights/role-stats-refresh/run-now
 * Runs a Role Evaluation scan across every role, tagged triggeredBy
 * "scheduled" — so it counts toward the Home screen's stats exactly like a
 * real scheduled run. Returns { scanId } immediately; the scan runs in the
 * background (see roleEvalScans).
 */
export async function runRoleStatsRefreshNow() {
  return startScheduledRoleEvalScan();
}

/**
 * GET /api/insights/role-stats-summary
 * The Home screen's pass/needs-update counts, based on the most recently
 * COMPLETED scan tagged triggeredBy "scheduled" (the Role Statistics
 * Refresh schedule, or its Run Now button) — an ad-hoc Role Evaluation scan
 * never counts, even if it covered every role too. { available: false,
 * commonRoleCount } when no such scan has completed yet.
 */
export async function getRoleStatsSummary() {
  const tenant = tenantKey();

  // Counted straight from the live API — ISC's own CONFIRMED common-access
  // list, unioned with every role this app has itself flagged or created as
  // one — not tied to whether a Role Statistics Refresh scan has ever run.
  // Only counts roles that are actually enabled AND currently grant at
  // least one entitlement (base or, for a dynamic role, any dimension's
  // own). Non-fatal: a failure just leaves this uncounted.
  let commonRoleCount = 0;
  try {
    const { confirmed, locallyTracked } = await getCommonAccessRoleStatus();
    const commonRoleIds = [...new Set([...confirmed, ...locallyTracked])];
    const activeAndGranting = await mapWithConcurrency(commonRoleIds, ROLE_EVAL_DIMENSION_CONCURRENCY, async (roleId) => {
      try {
        const role = await withApiRetry(() => iscGet(`/v2026/roles/${roleId}`), { label: `role-stats-summary: fetch role ${roleId}` });
        if (!role.enabled) return false;
        if ((role.entitlements || []).length > 0) return true;
        if (role.dimensional) {
          const dimensions = await withApiRetry(() => iscGet(`/v2026/roles/${roleId}/dimensions`), { label: `role-stats-summary: fetch role ${roleId} dimensions` });
          return (dimensions || []).some((d) => (d.entitlements || []).length > 0);
        }
        return false;
      } catch {
        return false; // deleted/inaccessible role doesn't count either
      }
    });
    commonRoleCount = activeAndGranting.filter(Boolean).length;
  } catch (err) {
    console.error("[insights] role-stats-summary: common-access count failed:", err.response?.data || err.message);
  }

  const scans = Object.values(await roleEvalScans().all())
    .filter((s) => (!s.tenant || s.tenant === tenant) && s.triggeredBy === "scheduled" && s.status === "completed")
    .sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt));
  const latest = scans[0];
  if (!latest) return { available: false, commonRoleCount };

  // Gated on the CURRENT setting, not whatever it was when this scan ran —
  // if SOD checking has since been turned off, a role flagged for an SOD
  // violation back then shouldn't still count as "needing updates" today.
  const checkSodViolations = (await getTenantSettings()).checkSodViolations !== false;
  const results = latest.results || [];
  // hasSodViolations already only reflects still-ACTIVE violations as of
  // scan time, so a role whose only violation was mitigated never counts
  // here. mitigatedSodCount is purely informational.
  const hasSod = (r) => checkSodViolations && r.hasSodViolations;
  const okCount = results.filter((r) => !r.error && !r.hasSuggestions && !hasSod(r)).length;
  const needsUpdateCount = results.filter((r) => r.hasSuggestions || hasSod(r)).length;
  const sodViolationCount = results.filter((r) => hasSod(r)).length;
  const mitigatedSodCount = checkSodViolations ? results.filter((r) => r.mitigatedViolationPresent).length : 0;

  return {
    available: true,
    scanId: latest.id,
    asOf: latest.completedAt,
    okCount,
    needsUpdateCount,
    sodViolationCount,
    mitigatedSodCount,
    commonRoleCount,
    totalRoles: results.length,
  };
}
