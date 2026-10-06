// Display labels for the User Certifications preferences (Studio Settings >
// User Certifications), shared with Mining > Certifications so the launcher's
// summary and the settings page can never disagree on wording. The stored
// values are ISC's own enum values where one exists
// (mandatoryCommentRequirement), so a run can pass them straight through.

export const CERT_UNDECIDED_ACCESS_OPTIONS = [
  { value: "MAINTAIN", label: "Maintain" },
  { value: "REVOKE", label: "Revoke" },
];

export const CERT_COMMENT_OPTIONS = [
  { value: "NO_DECISIONS", label: "None" },
  { value: "ALL_DECISIONS", label: "All Decisions" },
  { value: "REVOKE_ONLY_DECISIONS", label: "For Revoke" },
];

export const CERT_DURATION_OPTIONS = [
  { value: 7, label: "1 week" },
  { value: 14, label: "2 weeks" },
  { value: 30, label: "30 days" },
];

export const CERT_PRIVILEGE_LEVEL_OPTIONS = [
  { value: "HIGH", label: "High" },
  { value: "MEDIUM", label: "Medium" },
  { value: "LOW", label: "Low" },
  { value: "NOT_SET", label: "No Value Set for Privilege (null)" }, // no privilege level on the item at all
];

// The privilege filters in effect: the per-level list, or — for a tenant
// saved before the list existed — the legacy single level/mode pair.
export function effectivePrivilegeFilters(prefs = {}) {
  const list = Array.isArray(prefs.certPrivilegeFilters) ? prefs.certPrivilegeFilters : [];
  if (list.length) return list;
  if (prefs.certPrivilegeLevel && prefs.certPrivilegeLevel !== "IGNORE") {
    return [{ level: prefs.certPrivilegeLevel, mode: prefs.certPrivilegeMode === "EXCLUDE" ? "EXCLUDE" : "INCLUDE" }];
  }
  return [];
}

export const CERT_FILTER_MODE_OPTIONS = [
  { value: "INCLUDE", label: "Include only matching items" },
  { value: "EXCLUDE", label: "Exclude matching items" },
];

export const CERT_IDENTITY_FILTER_MODE_OPTIONS = [
  { value: "INCLUDE", label: "Include only matching identities" },
  { value: "EXCLUDE", label: "Exclude matching identities" },
];

export const CERT_DEFAULTS = {
  certAttributeKeys: [], // empty = fall back to the Role Creation Priority Order
  certNotificationsEnabled: true,
  certUndecidedAccess: "MAINTAIN",
  certCommentRequirement: "NO_DECISIONS",
  certDurationDays: 30,
  certCampaignPrefix: "", // text before every drafted campaign's root name — no default
  certCampaignSuffix: " user access review ", // text after it; spaces included. Mirrors the server default.
  certSizeLimit: 10000, // max access items per campaign
  certAccessItemTypes: ["ROLE", "ACCESS_PROFILE", "ENTITLEMENT"], // all three = no type filter
  certExcludeBirthrightRoles: false, // birthright role = any role with a membership rule
  certIncludeCommonAccessRoles: false, // keep Common Access roles even while birthright roles are excluded
  // Included Sources, stored as the UNTICKED ones ([{ id, name }]) so the
  // default is every source and a source added later is included automatically.
  certExcludedSources: [],
  certPrivilegeFilters: [], // [{ level: HIGH|MEDIUM|LOW, mode: INCLUDE|EXCLUDE }]
  certPrivilegeLevel: "IGNORE", // legacy single-level form
  certPrivilegeMode: "INCLUDE",
  certMetadataFilters: [],
  certMetadataMode: "INCLUDE",
  certSearchFilter: "attributes.cloudLifecycleState:active", // identity query — who each campaign covers
  certSearchMode: "INCLUDE",
};

/** "High or Medium privilege items", "items with no value set for privilege (null)", or both joined with " or ". */
function privilegePhrase(entries) {
  const levels = entries.filter((x) => x.level !== "NOT_SET").map((x) => labelOf(CERT_PRIVILEGE_LEVEL_OPTIONS, x.level));
  const parts = [];
  if (levels.length) parts.push(`${levels.join(" or ")} privilege items`);
  if (entries.some((x) => x.level === "NOT_SET")) parts.push("items with no value set for privilege (null)");
  return parts.join(" or ");
}

/** Human summary of the item filters, one line per active filter (empty when none). */
export const CERT_ACCESS_ITEM_TYPE_OPTIONS = [
  { value: "ROLE", label: "Roles" },
  { value: "ACCESS_PROFILE", label: "Access Profiles" },
  { value: "ENTITLEMENT", label: "Entitlements" },
];
/** The chosen types in fixed order; an empty/absent setting means all three. */
export function effectiveAccessItemTypes(prefs = {}) {
  const chosen = Array.isArray(prefs.certAccessItemTypes) ? prefs.certAccessItemTypes : [];
  const all = CERT_ACCESS_ITEM_TYPE_OPTIONS.map((o) => o.value);
  return chosen.length ? all.filter((t) => chosen.includes(t)) : all;
}

export function describeCertFilters(prefs = {}) {
  const p = { ...CERT_DEFAULTS, ...prefs };
  const out = [];
  const types = effectiveAccessItemTypes(p);
  if (types.length < CERT_ACCESS_ITEM_TYPE_OPTIONS.length) {
    out.push(`Only ${types.map((t) => CERT_ACCESS_ITEM_TYPE_OPTIONS.find((o) => o.value === t).label).join(" and ")}`);
  }
  if (types.includes("ROLE") && p.certExcludeBirthrightRoles) {
    out.push(p.certIncludeCommonAccessRoles ? "Exclude birthright roles, but keep Common Access roles" : "Exclude birthright roles");
  }
  const excludedSources = Array.isArray(p.certExcludedSources) ? p.certExcludedSources.filter((x) => x?.id) : [];
  if (excludedSources.length) {
    const names = excludedSources.map((x) => x.name || x.id);
    out.push(
      `Exclude access profiles and entitlements from ${excludedSources.length} source${excludedSources.length === 1 ? "" : "s"} ` +
      `(${names.slice(0, 5).join(", ")}${names.length > 5 ? `, +${names.length - 5} more` : ""})`
    );
  }
  const modeWord = (m) => (m === "EXCLUDE" ? "Exclude" : "Only");
  const priv = effectivePrivilegeFilters(p);
  const privInc = priv.filter((x) => x.mode !== "EXCLUDE");
  const privExc = priv.filter((x) => x.mode === "EXCLUDE");
  if (privInc.length) out.push(`Only ${privilegePhrase(privInc)}`);
  if (privExc.length) out.push(`Exclude ${privilegePhrase(privExc)}`);
  const pairs = Array.isArray(p.certMetadataFilters) ? p.certMetadataFilters : [];
  const pairText = (x) => `${x.attributeName || x.key} = ${x.valueName || x.value}`;
  const inc = pairs.filter((x) => (x.mode || p.certMetadataMode || "INCLUDE") !== "EXCLUDE");
  const exc = pairs.filter((x) => (x.mode || p.certMetadataMode || "INCLUDE") === "EXCLUDE");
  if (inc.length) out.push(`Only items tagged ${inc.map(pairText).join(" or ")}`);
  if (exc.length) out.push(`Exclude items tagged ${exc.map(pairText).join(" or ")}`);
  if (p.certSearchFilter && String(p.certSearchFilter).trim()) {
    out.push(`${p.certSearchMode === "EXCLUDE" ? "Identities excluding" : "Identities matching"} "${String(p.certSearchFilter).trim()}"`);
  }
  return out;
}

const labelOf = (options, value) => options.find((o) => o.value === value)?.label ?? String(value ?? "");

export function describeCertSettings(prefs = {}) {
  const p = { ...CERT_DEFAULTS, ...prefs };
  return {
    notifications: p.certNotificationsEnabled ? "Yes" : "No",
    undecidedAccess: labelOf(CERT_UNDECIDED_ACCESS_OPTIONS, p.certUndecidedAccess),
    comments: labelOf(CERT_COMMENT_OPTIONS, p.certCommentRequirement),
    duration: labelOf(CERT_DURATION_OPTIONS, p.certDurationDays),
    sizeLimit: Number(p.certSizeLimit || 0).toLocaleString(),
  };
}

/** Structured criteria -> 'department = "Engineering" · location = "Austin"' (falls back to the flat label). */
export function certificationCriteriaText(campaign) {
  if (Array.isArray(campaign?.values) && campaign.values.length) {
    return campaign.values.map((v) => `${humanizeAttributeKey(v.key)} = "${v.value}"`).join(" · ");
  }
  return `${humanizeAttributeKey(campaign?.attributeKey)} = "${campaign?.value ?? ""}"`;
}

/** "jobTitle" -> "job title" — same rule the server uses for campaign prose. */
export function humanizeAttributeKey(key) {
  return String(key || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase()
    .trim();
}

export const CERT_NAME_AFFIX_MAX = 50;
/** prefix + name + suffix exactly as typed, spaces included — mirrors the server's certificationCampaignName. */
export function certificationCampaignName(baseName, { certCampaignPrefix, certCampaignSuffix } = {}) {
  const part = (v) => (typeof v === "string" ? v : "");
  return `${part(certCampaignPrefix)}${baseName}${part(certCampaignSuffix)}`;
}
