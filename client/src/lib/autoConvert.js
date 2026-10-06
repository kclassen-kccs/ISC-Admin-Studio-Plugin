import {
  backupSpConfig, fetchAllPages, listRoles, updateRole, deleteRole, setRoleEnabled,
  listSegments, deleteSegment, setSegmentActive, publishSegments,
  startRoleScan, getRoleScan, createRoleForPeerGroup,
  startSegmentScan, getSegmentScan, createSegmentsFromScan, addScanSuggestionsToExistingSegments,
  startAttributeSyncScan, getAttributeSyncScan, deployAttributeSyncScan,
  generateAllRoleDescriptions, generateAllAccessProfileDescriptions, generateAllSourceDescriptions,
  listAccessProfiles, listSources, updateAccessProfile, updateSourceDescription,
  runSchemaAnalysis, setSchemaTopAttributes, setSchemaRoleBoundary,
  getTenantSettings, setTenantSettings,
} from "./sailpoint";
import { proposedRoleName } from "./roleNaming";
import { scanAttributeKeys, sortScanGroups, creatableScanGroups, summarizeGroup } from "./roleScanCreate";
import { creatableSegmentSuggestions, mergeableSegmentSuggestions, segmentResultNotes } from "./segmentScanApply";

export const PREVIOUS_PREFIX = "Previous - ";
const ROLE_PREFIX = "The ";
const ROLE_SUFFIX = " Role";

class AutoConvertCancelled extends Error {
  constructor() {
    super("Auto Convert cancelled");
    this.name = "AutoConvertCancelled";
  }
}

function errText(err) {
  return err?.response?.data?.error || err?.message || String(err);
}

// Finds the schema-analysis candidate whose key matches any of `wanted`
// (case-insensitive) — identity attribute keys vary between tenants
// ("title" vs "jobTitle"), and the analysis only accepts keys from its own
// candidate list, so this maps the spec's human names onto whatever this
// tenant actually calls them.
function findCandidateKey(candidates, wanted, label) {
  const byKey = new Map(candidates.map((c) => [c.key.toLowerCase(), c.key]));
  for (const w of wanted) {
    const hit = byKey.get(w.toLowerCase());
    if (hit) return hit;
  }
  throw new Error(
    `No "${label}" attribute found in this tenant's Schema Analysis candidates ` +
    `(looked for ${wanted.join("/")}; available: ${candidates.map((c) => c.key).join(", ") || "none"}).`
  );
}

async function pollScan(getFn, scanId, label) {
  // No overall deadline — these scans legitimately run many minutes on a
  // large tenant; cancellation happens through the error dialog if a scan
  // ends in anything but "completed".
  for (;;) {
    const scan = await getFn(scanId);
    if (scan.status === "running") {
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    if (scan.status !== "completed") {
      throw new Error(`${label} ended with status "${scan.status}"${scan.error ? `: ${scan.error}` : ""}`);
    }
    return scan;
  }
}


function downloadBackupFile(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Runs the whole Auto Convert sequence. `log(level, message)` receives
 * every progress line (level: info|step|success|warn|error). `onError(step,
 * message)` is called when a step throws and must resolve to "retry" |
 * "continue" | "cancel". `owner` is { id, name } for created roles.
 *
 * Returns { cancelled, entriesNote } — the caller keeps its own log array
 * (it also feeds the UI), so nothing is returned beyond the outcome.
 */
export async function runAutoConvert({ options, owner, log, onError }) {
  const { dynamicRoles, dataSegments } = options;

  async function step(label, fn) {
    for (;;) {
      try {
        log("step", label);
        const result = await fn();
        log("success", `${label} — done`);
        return { ok: true, result };
      } catch (err) {
        if (err instanceof AutoConvertCancelled) throw err;
        const msg = errText(err);
        log("error", `${label} — failed: ${msg}`);
        const choice = await onError(label, msg);
        if (choice === "retry") {
          log("info", `Retrying: ${label}`);
          continue;
        }
        if (choice === "continue") {
          log("warn", `Skipped after failure, continuing: ${label}`);
          return { ok: false };
        }
        log("warn", "Cancelled by user.");
        throw new AutoConvertCancelled();
      }
    }
  }

  try {
    // ── Configuration (prerequisite for the scans below) ──
    await step("Configure tenant for conversion", async () => {
      log("info", "Running Schema Analysis to discover this tenant's identity attributes…");
      const analysis = await runSchemaAnalysis();
      const candidates = analysis?.candidates || [];
      const departmentKey = findCandidateKey(candidates, ["department", "dept"], "Department");
      const titleKey = findCandidateKey(candidates, ["title", "jobTitle"], "Title");
      log("info", `Role membership attribute: ${departmentKey} · Role dimension attribute: ${titleKey}`);
      await setSchemaTopAttributes([departmentKey, titleKey]);

      if (dataSegments) {
        const countryKey = findCandidateKey(candidates, ["country"], "Country");
        log("info", `Boundary attribute for Roles and Data Segments: ${countryKey}`);
        await setSchemaRoleBoundary({ enabled: true, attributes: [countryKey], createDataSegments: true });
      }

      await setTenantSettings({
        createDynamicRoles: dynamicRoles,
        allowDuplicateRoles: true, // renamed "Previous - " roles must not block re-creation
        rolePrefix: ROLE_PREFIX,
        roleSuffix: ROLE_SUFFIX,
      });
      log("info", `Dynamic Roles: ${dynamicRoles ? "on" : "off"} · Role naming: "${ROLE_PREFIX}…${ROLE_SUFFIX}"`);
    });

    // ── Step 1: Backup ──
    await step("Step 1 — Backup tenant configuration to local disk", async () => {
      const { filename, data } = await backupSpConfig();
      downloadBackupFile(filename, data);
      log("info", `Backup downloaded as ${filename}`);
    });

    // ── Step 2: Rename existing roles ──
    await step(`Step 2 — Rename existing roles with "${PREVIOUS_PREFIX}"`, async () => {
      const roles = await fetchAllPages((page) => listRoles(page));
      const targets = roles.filter((r) => !r.name.startsWith(PREVIOUS_PREFIX));
      log("info", `${targets.length} role${targets.length === 1 ? "" : "s"} to rename (${roles.length - targets.length} already prefixed).`);
      let renamed = 0;
      const failures = [];
      for (const r of targets) {
        try {
          await updateRole(r.id, { name: `${PREVIOUS_PREFIX}${r.name}` });
          renamed++;
          if (renamed % 20 === 0) log("info", `Renamed ${renamed} of ${targets.length}…`);
        } catch (err) {
          failures.push(`${r.name}: ${errText(err)}`);
        }
      }
      log("info", `Renamed ${renamed} of ${targets.length}.`);
      if (failures.length) throw new Error(`${failures.length} rename${failures.length === 1 ? "" : "s"} failed — first: ${failures[0]}`);
    });

    // ── Step 3: Role Model Draft scan + create suggested roles ──
    await step("Step 3 — Role Model Draft scan and role creation", async () => {
      log("info", "Starting Role Model Draft scan…");
      const { scanId } = await startRoleScan();
      const scan = await pollScan(getRoleScan, scanId, "Role scan");
      // Exactly what the Role Model Draft screen's Create All Roles does:
      // the same eligible groups in the same order, named with the tenant's
      // Role Naming and described with the same summary (Step 6 replaces
      // descriptions with AI ones afterwards).
      const settings = await getTenantSettings();
      const separator = settings?.attributeSeparator ?? " - ";
      const attributeKeys = scanAttributeKeys(scan);
      const allowDuplicates = settings?.allowDuplicateRoles ?? scan.allowDuplicateRoles ?? true;
      const groups = creatableScanGroups(sortScanGroups(scan.groups, attributeKeys), allowDuplicates);
      const skipped = (scan.groups?.length || 0) - groups.length;
      log("info", `Scan found ${scan.groups?.length || 0} peer group${(scan.groups?.length || 0) === 1 ? "" : "s"}; creating ${groups.length} role${groups.length === 1 ? "" : "s"}${skipped ? ` (${skipped} skipped — already created or matching an existing role)` : ""}…`);
      let created = 0;
      const failures = [];
      for (const group of groups) {
        const name = proposedRoleName(group, settings?.rolePrefix ?? ROLE_PREFIX, settings?.roleSuffix ?? ROLE_SUFFIX, separator);
        try {
          const data = await createRoleForPeerGroup(scanId, group.id, {
            name,
            description: summarizeGroup(group, attributeKeys),
            ownerId: owner?.id,
            ownerName: owner?.name,
          });
          created++;
          const dims = data?.dimensions || [];
          const failedDims = dims.filter((d) => !d.ok).length;
          log("info", `Created "${name}"${data?.role?.dimensional ? ` — dynamic, ${dims.length - failedDims}/${dims.length} dimensions` : ""} (${created}/${groups.length})`);
          if (failedDims) log("warn", `"${name}": ${failedDims} dimension${failedDims === 1 ? "" : "s"} failed to create.`);
          const seg = data?.segmentMetadata;
          if (seg?.error) {
            log("warn", `"${name}": segment metadata tagging failed: ${seg.error}`);
          } else {
            for (const v of seg?.values || []) {
              log("info", `"${name}": tagged ${seg.key}: ${v.name}${v.roleTagged ? " on the role" : " (role already tagged)"}, ${v.entitlementsTagged.length} of ${v.entitlementsChecked} entitlement${v.entitlementsChecked === 1 ? "" : "s"} newly tagged.`);
            }
          }
          if (group.isCommonAccessScope && !data?.commonAccessFlagged) {
            log("warn", `"${name}" was created but couldn't be flagged as Common Access in ISC${data?.commonAccessError ? `: ${data.commonAccessError}` : ""} — flag it manually.`);
          }
        } catch (err) {
          failures.push(`${name}: ${errText(err)}`);
          log("warn", `Failed to create "${name}": ${errText(err)}`);
        }
      }
      log("info", `Created ${created} of ${groups.length} role${groups.length === 1 ? "" : "s"}.`);
      if (created === 0 && groups.length > 0) throw new Error(`No roles could be created — first failure: ${failures[0]}`);
    });

    // ── Step 3.5: Remove all existing Data Segments ──
    // Runs whether or not new Data Segments were requested — existing
    // segments reference the OLD role model being replaced, so they're
    // stale either way. listSegments returns published and draft rows as
    // separate entries deduped by id, so deleting each id covers both.
    await step("Step 3.5 — Remove all existing Data Segments", async () => {
      const segments = await listSegments();
      if (!segments.length) {
        log("info", "No existing Data Segments to remove.");
        return;
      }
      log("info", `${segments.length} existing Data Segment${segments.length === 1 ? "" : "s"} to remove.`);
      let removed = 0;
      const failures = [];
      for (const s of segments) {
        try {
          await deleteSegment(s.id);
          removed++;
        } catch (err) {
          failures.push(`${s.name}: ${errText(err)}`);
          log("warn", `Failed to remove segment "${s.name}": ${errText(err)}`);
        }
      }
      log("info", `Removed ${removed} of ${segments.length}.`);
      if (failures.length) throw new Error(`${failures.length} segment removal${failures.length === 1 ? "" : "s"} failed — first: ${failures[0]}`);
    });

    // ── Step 4: Data Segments (optional) ──
    if (dataSegments) {
      await step("Step 4 — Data Segments scan and apply", async () => {
        // Same scan and apply as the Segments by Metadata screen's Merge All:
        // metadata mode tags the roles/entitlements and gives each segment a
        // metadata FILTER (no 50-item cap), with the ROLE filter on the
        // value's GUID.
        log("info", "Starting Data Segments scan by metadata (including roles and entitlements)…");
        const { scanId } = await startSegmentScan({ includeRoles: true, includeEntitlements: true, mode: "metadata" });
        const scan = await pollScan(getSegmentScan, scanId, "Data Segments scan");
        // Never apply a selection-mode scan: its segments carry explicit,
        // 50-capped lists instead of the metadata FILTERs.
        if (scan.mode !== "metadata") {
          throw new Error(`The Data Segments scan ran in "${scan.mode || "selection"}" mode, not metadata — refusing to apply it.`);
        }
        log("info", "Scan mode: metadata — roles and entitlements are tagged, segments filter on the tag.");
        const suggestions = scan.suggestions || [];
        const createIds = creatableSegmentSuggestions(suggestions).map((s) => s.id);
        const mergeIds = mergeableSegmentSuggestions(suggestions).map((s) => s.id);
        log("info", `Scan proposed ${suggestions.length} segment${suggestions.length === 1 ? "" : "s"} — creating ${createIds.length}, merging into ${mergeIds.length} existing.`);
        const outcomes = [];
        if (createIds.length) outcomes.push(...(await createSegmentsFromScan(scanId, createIds)).results);
        if (mergeIds.length) outcomes.push(...(await addScanSuggestionsToExistingSegments(scanId, mergeIds)).results);
        const failed = outcomes.filter((o) => !o.ok);
        for (const o of outcomes.filter((x) => x.ok)) log("info", `Segment "${o.segmentName || o.id}" ${mergeIds.includes(o.id) ? "updated" : "created"}.`);
        for (const f of failed) log("warn", `Segment suggestion failed: ${f.error}`);
        for (const n of segmentResultNotes(outcomes)) log(n.level, n.message);
        log("info", `Applied ${outcomes.length - failed.length} of ${outcomes.length} segment suggestion${outcomes.length === 1 ? "" : "s"}.`);
        if (outcomes.length > 0 && failed.length === outcomes.length) throw new Error(`Every segment suggestion failed — first: ${failed[0].error}`);

        // New segments are created disabled — enable every segment that
        // isn't yet (after Step 3.5's cleanup, everything left is this
        // run's own, deduped by id since drafts list separately).
        const allSegments = await listSegments();
        const toEnable = [...new Map(allSegments.map((s) => [s.id, s])).values()].filter((s) => !s.enabled);
        let enabled = 0;
        const enableFailures = [];
        for (const s of toEnable) {
          try {
            await setSegmentActive(s.id, true);
            enabled++;
          } catch (err) {
            enableFailures.push(`${s.name}: ${errText(err)}`);
            log("warn", `Failed to enable segment "${s.name}": ${errText(err)}`);
          }
        }
        log("info", `Enabled ${enabled} of ${toEnable.length} segment${toEnable.length === 1 ? "" : "s"}.`);
        if (enableFailures.length) throw new Error(`${enableFailures.length} segment enable${enableFailures.length === 1 ? "" : "s"} failed — first: ${enableFailures[0]}`);

        // Publish every remaining draft — enable alone leaves them as
        // drafts with no effect on real identities.
        const draftIds = [...new Map((await listSegments()).map((s) => [s.id, s])).values()]
          .filter((s) => !s.published)
          .map((s) => s.id);
        if (draftIds.length) {
          await publishSegments(draftIds);
          log("info", `Published ${draftIds.length} segment${draftIds.length === 1 ? "" : "s"}.`);
        } else {
          log("info", "No draft segments left to publish.");
        }
      });
    } else {
      log("info", "Step 4 — Data Segments: skipped (not selected).");
    }

    // ── Step 5: Attribute Sync ──
    await step("Step 5 — Attribute Sync scan and deploy", async () => {
      log("info", "Starting Attribute Sync scan…");
      const { scanId } = await startAttributeSyncScan();
      const scan = await pollScan(getAttributeSyncScan, scanId, "Attribute Sync scan");
      if (!scan.proposedChangeCount) {
        log("info", "No recommended Attribute Sync changes to deploy.");
        return;
      }
      log("info", `Deploying ${scan.proposedChangeCount} recommended change${scan.proposedChangeCount === 1 ? "" : "s"} across all sources…`);
      const { outcomes = [] } = await deployAttributeSyncScan(scanId);
      const failed = outcomes.filter((o) => !o.ok);
      for (const f of failed) log("warn", `Attribute Sync deploy failed for a source: ${f.error}`);
      log("info", `Deployed to ${outcomes.length - failed.length} of ${outcomes.length} source${outcomes.length === 1 ? "" : "s"}.`);
      if (outcomes.length > 0 && failed.length === outcomes.length) throw new Error("Attribute Sync deploy failed for every source.");
    });

    // ── Step 6: AI descriptions, auto-accepted ──
    await step("Step 6 — AI descriptions for Roles, Access Profiles, and Sources", async () => {
      const applyDescriptions = async (label, ids, generate, save) => {
        if (ids.length === 0) {
          log("info", `${label}: nothing to describe.`);
          return;
        }
        log("info", `${label}: generating descriptions for ${ids.length}…`);
        const { results = [] } = await generate(ids);
        const good = results.filter((r) => !r.error && r.description);
        const failed = results.length - good.length;
        let saved = 0;
        for (const r of good) {
          try {
            await save(r);
            saved++;
          } catch (err) {
            log("warn", `${label}: saving a description failed: ${errText(err)}`);
          }
        }
        log("info", `${label}: applied ${saved} of ${ids.length}${failed ? ` (${failed} generation failure${failed === 1 ? "" : "s"})` : ""}.`);
      };

      const roles = (await fetchAllPages((page) => listRoles(page))).filter((r) => !r.name.startsWith(PREVIOUS_PREFIX));
      await applyDescriptions(
        "Roles", roles.map((r) => r.id),
        generateAllRoleDescriptions,
        (r) => updateRole(r.roleId, { description: r.description })
      );

      const profiles = await fetchAllPages((page) => listAccessProfiles({ ...page, includeNonRequestable: true }));
      await applyDescriptions(
        "Access Profiles", profiles.map((p) => p.id),
        generateAllAccessProfileDescriptions,
        (r) => updateAccessProfile(r.roleId, { description: r.description })
      );

      const sources = await fetchAllPages((page) => listSources(page));
      await applyDescriptions(
        "Sources", sources.map((s) => s.id),
        generateAllSourceDescriptions,
        (r) => updateSourceDescription(r.roleId, r.description)
      );
    });

    // ── Step 6.5: Enable the new roles ──
    await step("Step 6.5 — Enable the new roles", async () => {
      const roles = await fetchAllPages((page) => listRoles(page));
      const targets = roles.filter((r) => !r.name.startsWith(PREVIOUS_PREFIX) && !r.enabled);
      if (targets.length === 0) {
        log("info", "Every new role is already enabled.");
        return;
      }
      log("info", `${targets.length} role${targets.length === 1 ? "" : "s"} to enable.`);
      let enabled = 0;
      const failures = [];
      for (const r of targets) {
        try {
          await setRoleEnabled(r.id, true);
          enabled++;
          if (enabled % 20 === 0) log("info", `Enabled ${enabled} of ${targets.length}…`);
        } catch (err) {
          failures.push(`${r.name}: ${errText(err)}`);
          log("warn", `Failed to enable "${r.name}": ${errText(err)}`);
        }
      }
      log("info", `Enabled ${enabled} of ${targets.length}.`);
      if (failures.length) throw new Error(`${failures.length} enable${failures.length === 1 ? "" : "s"} failed — first: ${failures[0]}`);
    });

    // ── Step 7: Remove "Previous - " roles ──
    await step(`Step 7 — Remove roles prefixed "${PREVIOUS_PREFIX}"`, async () => {
      const roles = await fetchAllPages((page) => listRoles(page));
      const targets = roles.filter((r) => r.name.startsWith(PREVIOUS_PREFIX));
      log("info", `${targets.length} previous role${targets.length === 1 ? "" : "s"} to remove.`);
      let removed = 0;
      const failures = [];
      for (const r of targets) {
        try {
          await deleteRole(r.id);
          removed++;
          if (removed % 20 === 0) log("info", `Removed ${removed} of ${targets.length}…`);
        } catch (err) {
          failures.push(`${r.name}: ${errText(err)}`);
          log("warn", `Failed to remove "${r.name}": ${errText(err)}`);
        }
      }
      log("info", `Removed ${removed} of ${targets.length}.`);
      if (failures.length) throw new Error(`${failures.length} role removal${failures.length === 1 ? "" : "s"} failed — first: ${failures[0]}`);
    });

    log("success", "Auto Convert completed.");
    return { cancelled: false };
  } catch (err) {
    if (err instanceof AutoConvertCancelled) return { cancelled: true };
    // A non-step error (shouldn't happen — everything runs inside step()) —
    // surface it in the log rather than losing it.
    log("error", `Unexpected failure: ${errText(err)}`);
    return { cancelled: true };
  }
}
