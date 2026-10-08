/**
 * ported/settings.js
 * Port of the server's tenant settings, studio preferences and user
 * preferences routes (GET/PUT /api/insights/settings,
 * /api/insights/studio-preferences, /api/preferences).
 *
 * Storage is the IndexedDB recordStore, which is namespaced by tenant and
 * lives in the plugin iframe's origin. Unlike the old server, nothing is
 * shared between browsers: each person's tenant settings and studio
 * preferences are their own copy. User preferences were already per user.
 */

import { badRequest, describeError, iscSearchPage } from "../isc";
import { recordStore } from "../store";
import {
  DEFAULT_TENANT_SETTINGS,
  currentUser,
  getTenantSettings,
  tenantKey,
} from "./roleShared";

export { getTenantSettings };

// ─── Tenant settings (Role Mining / Evaluation configuration) ────────────────

const tenantSettingsStore = () => recordStore("tenant-settings");

const ROLE_FILTER_MODES = ["ALL", "ENABLED_ONLY", "DISABLED_ONLY"];

/** Number of identities an ISC Search query matches (0 = nobody). */
async function countIdentityMatches(query) {
  const { total } = await iscSearchPage(
    { indices: ["identities"], query: { query } },
    { limit: 1, count: true }
  );
  return total || 0;
}

const requireBoolean = (name, v) => {
  if (typeof v !== "boolean") throw badRequest(`${name} must be a boolean.`);
  return v;
};
const requireString = (name, v) => {
  if (typeof v !== "string") throw badRequest(`${name} must be a string.`);
  return v;
};

/** PUT /api/insights/settings — validates only the fields present, keeps the rest. */
export async function setTenantSettings(body = {}) {
  const next = { ...(await getTenantSettings()) };

  for (const f of ["createDynamicRoles", "allowDuplicateRoles", "considerCommonRoles", "checkSodViolations", "allowSodMitigations"]) {
    if (body[f] !== undefined) next[f] = requireBoolean(f, body[f]);
  }
  // Stored exactly as sent — attributeSeparator " - " depends on its spaces.
  for (const f of ["rolePrefix", "roleSuffix", "attributeSeparator"]) {
    if (body[f] !== undefined) next[f] = requireString(f, body[f]);
  }
  if (body.nameScope !== undefined) {
    requireString("nameScope", body.nameScope);
    if (body.nameScope.trim()) {
      let count;
      try {
        count = await countIdentityMatches(body.nameScope);
      } catch (err) {
        const out = new Error(err?.response?.data?.messages?.[0]?.text || describeError(err));
        out.isRouteError = true;
        out.response = { status: err?.response?.status || 500, data: { error: out.message }, headers: {} };
        throw out;
      }
      // A scope nobody matches would silently make every Role Scan mine nothing.
      if (count === 0) throw badRequest("This scope matches 0 users — not saved.");
    }
    next.nameScope = body.nameScope;
  }
  if (body.roleFilterMode !== undefined) {
    if (!ROLE_FILTER_MODES.includes(body.roleFilterMode)) {
      throw badRequest("roleFilterMode must be one of ALL, ENABLED_ONLY, DISABLED_ONLY.");
    }
    next.roleFilterMode = body.roleFilterMode;
  }
  if (body.entitlementCommonalityThreshold !== undefined) {
    const v = body.entitlementCommonalityThreshold;
    if (typeof v !== "number" || v < 1 || v > 100) {
      throw badRequest("entitlementCommonalityThreshold must be a number between 1 and 100.");
    }
    next.entitlementCommonalityThreshold = v;
  }
  if (body.roleEvalRetention !== undefined) {
    const v = body.roleEvalRetention;
    if (!Number.isInteger(v) || v < 1 || v > 20) {
      throw badRequest("roleEvalRetention must be a whole number between 1 and 20.");
    }
    next.roleEvalRetention = v;
  }
  if (body.segmentMetadataAttribute !== undefined) {
    const v = body.segmentMetadataAttribute;
    if (typeof v !== "string" || !v.trim()) {
      throw badRequest("segmentMetadataAttribute must be a non-empty string.");
    }
    next.segmentMetadataAttribute = v.trim();
  }

  await tenantSettingsStore().put(tenantKey(), next);
  return next;
}

// ─── Studio preferences (tenant-wide app preferences) ────────────────────────

const CERT_ACCESS_ITEM_TYPES = ["ROLE", "ACCESS_PROFILE", "ENTITLEMENT"];
const CERT_PRIVILEGE_LEVELS = new Set(["IGNORE", "HIGH", "MEDIUM", "LOW"]);
const CERT_FILTER_MODES = new Set(["INCLUDE", "EXCLUDE"]);
const CERT_DURATION_DAYS = new Set([7, 14, 30]);
const CERT_UNDECIDED_ACCESS = new Set(["MAINTAIN", "REVOKE"]);
const CERT_COMMENT_REQUIREMENTS = new Set(["NO_DECISIONS", "ALL_DECISIONS", "REVOKE_ONLY_DECISIONS"]);
const CERT_NAME_AFFIX_MAX = 50;

export const DEFAULT_STUDIO_PREFERENCES = {
  roleStatsRefreshEnabled: false,
  roleStatsRefreshFrequency: "DAILY", // "HOURLY" | "DAILY" | "WEEKLY"
  roleStatsRefreshTimeOfDay: "06:00", // HH:mm, 24h
  roleStatsRefreshStartDate: null, // "YYYY-MM-DD"
  // Scheduler bookkeeping, never accepted from the UI.
  roleStatsLastRunSlot: null,
  // User Certifications defaults applied to every campaign draft.
  certAttributeKeys: [],
  certNotificationsEnabled: true,
  certUndecidedAccess: "MAINTAIN",
  certCommentRequirement: "NO_DECISIONS",
  certDurationDays: 30,
  // A saved value (even "") always wins over these defaults.
  certCampaignPrefix: "",
  certCampaignSuffix: " user access review ",
  certSizeLimit: 10000,
  certAccessItemTypes: ["ROLE", "ACCESS_PROFILE", "ENTITLEMENT"],
  certExcludeBirthrightRoles: false,
  certIncludeCommonAccessRoles: false,
  certPrivilegeFilters: [],
  certPrivilegeLevel: "IGNORE", // legacy, honoured only while certPrivilegeFilters is empty
  certPrivilegeMode: "INCLUDE",
  certMetadataFilters: [],
  certMetadataMode: "INCLUDE",
  certExcludedSources: [],
  certSearchFilter: "attributes.cloudLifecycleState:active",
  certSearchMode: "INCLUDE",
};

const studioPreferencesStore = () => recordStore("studio-preferences");

export async function getStudioPreferences() {
  return { ...DEFAULT_STUDIO_PREFERENCES, ...((await studioPreferencesStore().get(tenantKey())) || {}) };
}

/** Merges a patch without validation — for internal bookkeeping such as roleStatsLastRunSlot. */
export async function updateStudioPreferences(patch) {
  const next = { ...(await getStudioPreferences()), ...patch };
  await studioPreferencesStore().put(tenantKey(), next);
  return next;
}

/** prefix + name + suffix, joined exactly as typed. */
export function certificationCampaignName(baseName, settings) {
  const part = (v) => (typeof v === "string" ? v : "");
  return `${part(settings?.certCampaignPrefix)}${baseName}${part(settings?.certCampaignSuffix)}`;
}

/** PUT /api/insights/studio-preferences */
export async function setStudioPreferences(body = {}) {
  const next = { ...(await getStudioPreferences()) };

  if (body.roleStatsRefreshEnabled !== undefined) {
    next.roleStatsRefreshEnabled = requireBoolean("roleStatsRefreshEnabled", body.roleStatsRefreshEnabled);
  }
  if (body.roleStatsRefreshFrequency !== undefined) {
    if (!["HOURLY", "DAILY", "WEEKLY"].includes(body.roleStatsRefreshFrequency)) {
      throw badRequest("roleStatsRefreshFrequency must be HOURLY, DAILY, or WEEKLY.");
    }
    next.roleStatsRefreshFrequency = body.roleStatsRefreshFrequency;
  }
  if (body.roleStatsRefreshTimeOfDay !== undefined) {
    if (!/^\d{2}:\d{2}$/.test(body.roleStatsRefreshTimeOfDay)) {
      throw badRequest("roleStatsRefreshTimeOfDay must be in HH:mm form.");
    }
    next.roleStatsRefreshTimeOfDay = body.roleStatsRefreshTimeOfDay;
  }
  if (body.roleStatsRefreshStartDate !== undefined) {
    const d = body.roleStatsRefreshStartDate;
    if (d !== null && !/^\d{4}-\d{2}-\d{2}$/.test(d)) {
      throw badRequest("roleStatsRefreshStartDate must be in YYYY-MM-DD form.");
    }
    next.roleStatsRefreshStartDate = d;
  }

  if (body.certAttributeKeys !== undefined) {
    const keys = body.certAttributeKeys;
    if (!Array.isArray(keys) || keys.some((k) => typeof k !== "string" || !k.trim())) {
      throw badRequest("certAttributeKeys must be an array of attribute keys.");
    }
    if (new Set(keys).size !== keys.length) {
      throw badRequest("certAttributeKeys must not repeat an attribute.");
    }
    // Only keys Schema Analysis found on this tenant's identities. That
    // analysis is stored under "schema-analysis" (not ported yet, so until it
    // is, only an empty list can be saved).
    const analysis = await recordStore("schema-analysis").get(tenantKey());
    if (analysis) {
      const valid = new Set((analysis.candidates || []).map((c) => c.key));
      if (keys.some((k) => !valid.has(k))) {
        throw badRequest("certAttributeKeys must be keys from this tenant's Schema Analysis candidates.");
      }
    } else if (keys.length > 0) {
      throw badRequest("Run Schema Analysis first.");
    }
    next.certAttributeKeys = keys;
  }
  if (body.certNotificationsEnabled !== undefined) {
    next.certNotificationsEnabled = requireBoolean("certNotificationsEnabled", body.certNotificationsEnabled);
  }
  if (body.certUndecidedAccess !== undefined) {
    if (!CERT_UNDECIDED_ACCESS.has(body.certUndecidedAccess)) throw badRequest("certUndecidedAccess must be MAINTAIN or REVOKE.");
    next.certUndecidedAccess = body.certUndecidedAccess;
  }
  if (body.certCommentRequirement !== undefined) {
    if (!CERT_COMMENT_REQUIREMENTS.has(body.certCommentRequirement)) {
      throw badRequest("certCommentRequirement must be NO_DECISIONS, ALL_DECISIONS, or REVOKE_ONLY_DECISIONS.");
    }
    next.certCommentRequirement = body.certCommentRequirement;
  }
  for (const field of ["certCampaignPrefix", "certCampaignSuffix"]) {
    const value = body[field];
    if (value === undefined) continue;
    // eslint-disable-next-line no-control-regex
    if (typeof value !== "string" || value.length > CERT_NAME_AFFIX_MAX || /[\x00-\x1f\x7f]/.test(value)) {
      throw badRequest(`${field} must be text of at most ${CERT_NAME_AFFIX_MAX} characters, with no line breaks.`);
    }
    next[field] = value;
  }
  if (body.certDurationDays !== undefined) {
    if (!CERT_DURATION_DAYS.has(body.certDurationDays)) throw badRequest("certDurationDays must be 7, 14, or 30.");
    next.certDurationDays = body.certDurationDays;
  }
  if (body.certSizeLimit !== undefined) {
    const v = body.certSizeLimit;
    if (!Number.isInteger(v) || v < 1 || v > 1000000) throw badRequest("certSizeLimit must be a whole number from 1 to 1,000,000.");
    next.certSizeLimit = v;
  }
  if (body.certAccessItemTypes !== undefined) {
    const t = body.certAccessItemTypes;
    const ok = Array.isArray(t) && t.length >= 1 && t.every((x) => CERT_ACCESS_ITEM_TYPES.includes(x)) && new Set(t).size === t.length;
    if (!ok) {
      throw badRequest("certAccessItemTypes must be one or more of ROLE, ACCESS_PROFILE, ENTITLEMENT, without repeats — a campaign has to certify something.");
    }
    // Fixed order so two saves of the same choice are identical.
    next.certAccessItemTypes = CERT_ACCESS_ITEM_TYPES.filter((x) => t.includes(x));
  }
  for (const f of ["certExcludeBirthrightRoles", "certIncludeCommonAccessRoles"]) {
    if (body[f] !== undefined) next[f] = requireBoolean(f, body[f]);
  }
  if (body.certExcludedSources !== undefined) {
    const s = body.certExcludedSources;
    const ok = Array.isArray(s) && s.length <= 1000 && s.every(
      (x) => x && typeof x.id === "string" && /^[A-Za-z0-9-]{8,64}$/.test(x.id) && (x.name === undefined || x.name === null || typeof x.name === "string")
    );
    if (!ok) throw badRequest("certExcludedSources must be an array of { id, name } sources (max 1000).");
    const seen = new Set();
    next.certExcludedSources = s
      .filter((x) => (seen.has(x.id) ? false : seen.add(x.id)))
      .map((x) => ({ id: x.id, name: x.name ? String(x.name).slice(0, 200) : null }));
  }
  if (body.certPrivilegeFilters !== undefined) {
    const p = body.certPrivilegeFilters;
    const ok = Array.isArray(p) && p.length <= 4 && p.every(
      (x) => x && ["HIGH", "MEDIUM", "LOW", "NOT_SET"].includes(x.level) && (x.mode === undefined || CERT_FILTER_MODES.has(x.mode))
    );
    if (!ok) throw badRequest("certPrivilegeFilters must be up to 4 { level: HIGH|MEDIUM|LOW|NOT_SET, mode: INCLUDE|EXCLUDE } entries.");
    if (new Set(p.map((x) => x.level)).size !== p.length) throw badRequest("Each privilege level may appear only once.");
    next.certPrivilegeFilters = p.map((x) => ({ level: x.level, mode: x.mode === "EXCLUDE" ? "EXCLUDE" : "INCLUDE" }));
    // The list supersedes the legacy single-level setting.
    next.certPrivilegeLevel = "IGNORE";
  }
  if (body.certPrivilegeLevel !== undefined) {
    if (!CERT_PRIVILEGE_LEVELS.has(body.certPrivilegeLevel)) throw badRequest("certPrivilegeLevel must be IGNORE, HIGH, MEDIUM, or LOW.");
    next.certPrivilegeLevel = body.certPrivilegeLevel;
  }
  for (const name of ["certPrivilegeMode", "certMetadataMode", "certSearchMode"]) {
    if (body[name] !== undefined) {
      if (!CERT_FILTER_MODES.has(body[name])) throw badRequest(`${name} must be INCLUDE or EXCLUDE.`);
      next[name] = body[name];
    }
  }
  if (body.certMetadataFilters !== undefined) {
    const m = body.certMetadataFilters;
    const ok = Array.isArray(m) && m.length <= 50 && m.every(
      (x) => x && typeof x.key === "string" && x.key.trim() && typeof x.value === "string" && x.value.trim()
    );
    if (!ok) throw badRequest("certMetadataFilters must be an array of { key, value } pairs (max 50).");
    if (m.some((x) => x.mode !== undefined && !CERT_FILTER_MODES.has(x.mode))) {
      throw badRequest("Each metadata filter's mode must be INCLUDE or EXCLUDE.");
    }
    const seen = new Set();
    next.certMetadataFilters = m
      .map((x) => ({
        key: x.key.trim(), value: x.value.trim(), mode: x.mode === "EXCLUDE" ? "EXCLUDE" : "INCLUDE",
        attributeName: x.attributeName || null, valueName: x.valueName || null,
      }))
      .filter((x) => {
        const k = `${x.key}::${x.value}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
  }
  if (body.certSearchFilter !== undefined) {
    const f = body.certSearchFilter;
    if (typeof f !== "string" || f.length > 2000) throw badRequest("certSearchFilter must be a string of at most 2000 characters.");
    next.certSearchFilter = f.trim();
  }
  if (next.roleStatsRefreshEnabled && (!next.roleStatsRefreshStartDate || !next.roleStatsRefreshTimeOfDay)) {
    throw badRequest("A start date and time of day are required to enable Role Statistics Refresh.");
  }

  await studioPreferencesStore().put(tenantKey(), next);
  return next;
}

// ─── User preferences (per signed-in user) ───────────────────────────────────

// "system" follows the host's appearance rather than pinning light or dark.
const THEME_MODES = new Set(["system", "light", "dark"]);
// Which view JSON editors open in; Text always works, Tree needs parseable JSON.
const JSON_EDIT_MODES = new Set(["text", "tree"]);
// How AI calls leave the plugin: through the tenant's "Admin Studio AI
// Query" workflow (default) or straight from this browser with a key held
// in memory for the open tab (lib/aiProxy.js). The key itself is never a
// stored preference: it lives in ISC Parameter Storage only.
const AI_ROUTES = new Set(["workflow", "direct"]);
const DEFAULT_USER_PREFERENCES = { themeMode: "system", jsonEditMode: "text", aiRoute: "workflow" };

// Older records hold only the darkMode boolean: true was a deliberate choice
// ("dark"); false was also the default for anyone who never chose, so it maps
// to "system".
function normalizeUserPreferences(stored) {
  const prefs = { ...DEFAULT_USER_PREFERENCES, ...(stored || {}) };
  // Test the STORED mode: the merged one always looks valid thanks to the default.
  if (!THEME_MODES.has(stored?.themeMode)) prefs.themeMode = stored?.darkMode === true ? "dark" : "system";
  if (!JSON_EDIT_MODES.has(prefs.jsonEditMode)) prefs.jsonEditMode = "text";
  if (!AI_ROUTES.has(prefs.aiRoute)) prefs.aiRoute = "workflow";
  prefs.darkMode = prefs.themeMode === "dark"; // kept so an older client reads something sensible
  delete prefs.anthropicApiKey; // an earlier build stored the key here; it is never kept now
  return prefs;
}

const userPreferencesStore = () => recordStore("user-preferences");

/** Records are keyed by tenant, then by user, as on the server. */
async function userKey() {
  const { id, username } = await currentUser();
  const key = username || id;
  if (!key) throw badRequest("No user on this session.");
  return key;
}

async function readUserPreferences() {
  const forTenant = (await userPreferencesStore().get(tenantKey())) || {};
  const user = await userKey();
  const stored = forTenant[user];
  // An earlier build kept the Anthropic key in this record. Scrub it the
  // first time it is read: the key belongs in ISC Parameter Storage only.
  if (stored && Object.prototype.hasOwnProperty.call(stored, "anthropicApiKey")) {
    forTenant[user] = normalizeUserPreferences(stored);
    await userPreferencesStore().put(tenantKey(), forTenant);
  }
  return normalizeUserPreferences(stored);
}

export async function getUserPreferences() {
  return readUserPreferences();
}

/** "workflow" or "direct"; "workflow" when there is no session yet. */
export async function getAiRoute() {
  try {
    return (await readUserPreferences()).aiRoute;
  } catch {
    return "workflow";
  }
}

/**
 * PUT /api/preferences — only ever writes the signed-in user's own entry.
 * The Anthropic key is not a preference: it goes to ISC Parameter Storage
 * (lib/aiSetup.js) and is refused here.
 */
export async function setUserPreferences(body = {}) {
  const { themeMode, darkMode, jsonEditMode, anthropicApiKey, aiRoute } = body;
  const patch = {};
  if (anthropicApiKey !== undefined) throw badRequest("The Anthropic API key is kept in ISC Parameter Storage, not in preferences.");
  if (aiRoute !== undefined) {
    if (!AI_ROUTES.has(aiRoute)) throw badRequest('aiRoute must be "workflow" or "direct".');
    patch.aiRoute = aiRoute;
  }
  if (jsonEditMode !== undefined) {
    if (!JSON_EDIT_MODES.has(jsonEditMode)) throw badRequest('jsonEditMode must be "text" or "tree".');
    patch.jsonEditMode = jsonEditMode;
  }
  if (themeMode !== undefined) {
    if (!THEME_MODES.has(themeMode)) throw badRequest('themeMode must be "system", "light" or "dark".');
    patch.themeMode = themeMode;
  } else if (darkMode !== undefined) {
    // Legacy clients still send the boolean.
    if (typeof darkMode !== "boolean") throw badRequest("darkMode must be a boolean.");
    patch.themeMode = darkMode ? "dark" : "light";
  }
  if (patch.themeMode !== undefined) patch.darkMode = patch.themeMode === "dark";

  const user = await userKey();
  const forTenant = (await userPreferencesStore().get(tenantKey())) || {};
  forTenant[user] = normalizeUserPreferences({ ...(forTenant[user] || {}), ...patch });
  await userPreferencesStore().put(tenantKey(), forTenant);
  return forTenant[user];
}
