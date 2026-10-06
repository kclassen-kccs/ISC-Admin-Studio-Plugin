// Display helpers for ISC certification campaigns (Browse > Certifications).

// ISC's lifecycle, in the order the list groups them: what needs starting
// first, then in-flight, then done.
export const CAMPAIGN_STATUS_ORDER = [
  { status: "STAGED", label: "Staged — ready to start" },
  { status: "PENDING", label: "Pending — generating certifications" },
  { status: "ACTIVATING", label: "Activating" },
  { status: "ACTIVE", label: "Active" },
  { status: "COMPLETING", label: "Completing" },
  { status: "COMPLETED", label: "Completed" },
  { status: "CANCELING", label: "Canceling" },
  { status: "ERROR", label: "Error" },
  { status: "ARCHIVED", label: "Archived" },
];

export function campaignStatusLabel(status) {
  const s = String(status || "").toUpperCase();
  const found = CAMPAIGN_STATUS_ORDER.find((x) => x.status === s);
  if (found) return found.label.split(" — ")[0];
  return s ? s.charAt(0) + s.slice(1).toLowerCase() : "Unknown";
}

export function campaignStatusTone(status) {
  const s = String(status || "").toUpperCase();
  if (s === "STAGED") return "bg-violet-50 text-violet-700";
  if (s === "PENDING" || s === "ACTIVATING" || s === "COMPLETING" || s === "CANCELING") return "bg-blue-50 text-blue-700";
  if (s === "ACTIVE") return "bg-emerald-50 text-emerald-700";
  if (s === "ERROR") return "bg-red-50 text-red-700";
  return "bg-gray-100 text-gray-600";
}

const TYPE_LABELS = {
  MANAGER: "Manager",
  SOURCE_OWNER: "Source Owner",
  SEARCH: "Search",
  ROLE_COMPOSITION: "Role Composition",
  MACHINE_ACCOUNT: "Machine Account",
};
export function campaignTypeLabel(type) {
  return TYPE_LABELS[String(type || "").toUpperCase()] || type || "—";
}

/** One line describing who/what the campaign covers, by type. */
export function campaignScopeText(c) {
  if (!c) return "—";
  const t = String(c.type || "").toUpperCase();
  if (t === "SEARCH") {
    const info = c.searchCampaignInfo || {};
    const reviewer = info.reviewer?.name ? `reviewer ${info.reviewer.name}` : "reviewed by each identity's manager";
    const what = info.type === "ACCESS" ? "access items" : "identities";
    const constraints = (info.accessConstraints || []).length ? ` · limited to selected ${info.accessConstraints.map((a) => a.type.toLowerCase().replace("_", " ") + "s").join(", ")}` : "";
    return `Search on ${what}: ${info.query || (info.identityIds?.length ? `${info.identityIds.length} selected identities` : "—")} · ${reviewer}${constraints}`;
  }
  if (t === "ROLE_COMPOSITION") {
    const info = c.roleCompositionCampaignInfo || {};
    return `${(info.roleIds || []).length} role(s) · reviewer ${info.reviewer?.name || "—"}`;
  }
  if (t === "SOURCE_OWNER") {
    const info = c.sourceOwnerCampaignInfo || {};
    return `Sources: ${(info.sourceIds || []).length ? `${info.sourceIds.length} selected` : "all"}`;
  }
  if (t === "MANAGER") return "Every identity, reviewed by their manager";
  if (t === "MACHINE_ACCOUNT") return "Machine accounts";
  return "—";
}

/** Source name for an access review item's access, whatever its type. */
function reviewItemSource(it) {
  const a = it.accessSummary || {};
  return a.entitlement?.sourceName || a.accessProfile?.sourceName || a.role?.sourceName || null;
}

/**
 * Review items -> users and access items. Each user carries the items they
 * hold (with decision); each access item carries the users holding it.
 */
export function summarizeReviewItems(items) {
  const users = new Map();
  const access = new Map();
  for (const it of items || []) {
    const idn = it.identitySummary || {};
    const a = it.accessSummary || {};
    const acc = a.access || {};
    const userKey = idn.identityId || idn.id || idn.name;
    const accessKey = acc.id || `${a.type}:${acc.name}`;
    if (!userKey || !accessKey) continue;
    const decided = !!it.completed || (it.decision != null && it.decision !== "");
    if (!users.has(userKey)) {
      users.set(userKey, { id: userKey, name: idn.name || userKey, reviewer: it.certification?.reviewer?.name || null, completed: !!idn.completed, items: [] });
    }
    users.get(userKey).items.push({ id: accessKey, name: acc.name || "—", type: a.type || acc.type || "—", source: reviewItemSource(it), decision: it.decision || null, decided });
    if (!access.has(accessKey)) {
      access.set(accessKey, { id: accessKey, name: acc.name || "—", type: a.type || acc.type || "—", source: reviewItemSource(it), privileged: !!a.entitlement?.privileged, users: [] });
    }
    access.get(accessKey).users.push({ id: userKey, name: idn.name || userKey, reviewer: it.certification?.reviewer?.name || null, decision: it.decision || null, decided });
  }
  const byName = (x, y) => String(x.name).localeCompare(String(y.name));
  return {
    users: [...users.values()].sort(byName).map((u) => ({ ...u, items: u.items.sort((x, y) => x.type.localeCompare(y.type) || byName(x, y)) })),
    access: [...access.values()].sort((x, y) => x.type.localeCompare(y.type) || byName(x, y)).map((a) => ({ ...a, users: a.users.sort(byName) })),
  };
}

export const ACCESS_TYPE_LABELS = { ROLE: "Role", ACCESS_PROFILE: "Access Profile", ENTITLEMENT: "Entitlement" };
export const accessTypeLabel = (t) => ACCESS_TYPE_LABELS[String(t || "").toUpperCase()] || t || "—";

export function canStartCampaign(c) {
  return String(c?.status || "").toUpperCase() === "STAGED";
}
