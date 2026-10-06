// Role Model Draft → roles: the choices the mining screen makes when it
// creates roles from a scan, shared so Auto Convert builds roles exactly the
// same way (same groups, same order, same names, same descriptions).

export const ATTRIBUTE_LABELS = { department: "department", location: "location", jobTitle: "job title" };
// Fallback for scans persisted before attributeKeys was recorded on the scan
// itself (see server's DEFAULT_PEER_GROUP_ATTRIBUTE_KEYS) — every scan since
// should carry its own scan.attributeKeys, which callers pass in explicitly.
export const DEFAULT_PEER_GROUP_ATTRIBUTE_KEYS = ["department", "location"];

export function scanAttributeKeys(scan) {
  return scan?.attributeKeys?.length ? scan.attributeKeys : DEFAULT_PEER_GROUP_ATTRIBUTE_KEYS;
}

// A match on every attribute the scan used leaves nothing to dimension by;
// fewer means the group becomes a SailPoint Dynamic role.
export function isDynamicGroup(group, attributeKeys) {
  return (group.attributeCriteria?.length || 0) < attributeKeys.length;
}

// The Common Access scope proposal always sorts first — it's the "first
// task" of the scan, not a peer group. Dynamic (partial-attribute-match)
// groups come next. Within each tier, sort alphabetically by name.
export function sortScanGroups(groups, attributeKeys) {
  return [...(groups || [])].sort((a, b) => {
    const commonAccessDiff = Number(!!b.isCommonAccessScope) - Number(!!a.isCommonAccessScope);
    if (commonAccessDiff !== 0) return commonAccessDiff;
    const dynamicDiff = Number(isDynamicGroup(b, attributeKeys)) - Number(isDynamicGroup(a, attributeKeys));
    if (dynamicDiff !== 0) return dynamicDiff;
    return a.name.localeCompare(b.name);
  });
}

// Same eligibility create-role itself enforces, so a bulk list matches what
// will actually succeed. A group with no shared base entitlements is not
// excluded — every existing attribute combination gets a role (its access
// may be entirely per-dimension, or it may be a membership-only
// placeholder). The one remaining check is the pre-existing match
// (existingRole), relaxed when Allow Duplicate Roles is on. Always skips a
// group this scan already created (roleCreated).
export function creatableScanGroups(groups, allowDuplicateRoles) {
  return (groups || []).filter((g) => !g.roleCreated && (allowDuplicateRoles || !g.existingRole));
}

// A plain-English default for the role description — shown editable in the
// create-role form rather than sent as-is, so the user can tweak wording
// before it goes into the API call.
export function summarizeGroup(group, attributeKeys) {
  if (group.isCommonAccessScope) {
    return `Auto-generated for every identity in this scan's scope. Grants ${group.commonAccess.length} `
      + `entitlement${group.commonAccess.length === 1 ? "" : "s"} held by all ${group.members.length} `
      + `identit${group.members.length === 1 ? "y" : "ies"} in scope — birthright access, not a peer-group role.`;
  }
  const criteria = group.attributeCriteria || [];
  const criteriaText = criteria.length
    ? `identities that share ${criteria
        .map(({ key, value }) => `the ${ATTRIBUTE_LABELS[key] || key} "${value}"`)
        .join(" and ")}`
    : "identities in this peer group";

  // Dimensions and member/entitlement counts only — no entitlement names,
  // since those are tenant-specific access details that don't belong in a
  // human-facing role description.
  const matchedKeys = new Set(criteria.map((c) => c.key));
  const varyingKeys = attributeKeys.filter((k) => !matchedKeys.has(k));
  const dimensionsText = varyingKeys.length
    ? " " + varyingKeys.map((key) => {
        const values = [...new Set(group.members.map((m) => m[key]).filter((v) => v && v !== "Unknown"))];
        return `Includes ${values.length} dimension${values.length === 1 ? "" : "s"} `
          + `by ${ATTRIBUTE_LABELS[key] || key}: ${values.join(", ")}.`;
      }).join(" ")
    : "";

  // Every existing attribute combination now gets a role even when its
  // members share nothing (see the server's buildPeerGroups), so the
  // zero case is a normal outcome rather than an oddity — worth saying
  // plainly instead of letting it read as "Grants 0 shared entitlements".
  const grantsText = group.commonAccess.length
    ? `Grants ${group.commonAccess.length} shared entitlement${group.commonAccess.length === 1 ? "" : "s"} to its `
      + `${group.members.length} initial member${group.members.length === 1 ? "" : "s"}.`
    : `Its ${group.members.length} initial member${group.members.length === 1 ? "" : "s"} share no common `
      + `entitlements, so this starts as a membership-only role for the combination.`;
  return `Auto-generated for ${criteriaText}. ${grantsText}${dimensionsText}`;
}
