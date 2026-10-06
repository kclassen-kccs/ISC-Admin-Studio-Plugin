// Shared between the on-screen Peer Groups view and the printed/exported
// scan PDF, so both name a group identically.

// The attribute-value combination a peer group was matched on (e.g.
// "Engineering - Production Test Engineer I" with the default separator)
// — the part that actually identifies it, independent of any naming
// wrapper. Used as-is in scan displays/reports; Role Naming's prefix/suffix
// are only applied when actually creating a Role (see proposedRoleName
// below), not here.
//
// `separator` is the tenant's persisted Attribute Separator (Configuration)
// — only defaulted when the caller omits it entirely (undefined), so an
// explicit "" (or a separator that's all whitespace) is honored as-is
// rather than falling back.
export function roleCriteriaText(group, separator = " - ") {
  // The Common Access scope proposal's base name is always literally
  // "Common Access" — but under a Multi-Company/Division Boundary partition,
  // its criteria also carries that partition's own value(s) (flagged
  // isBoundary), which get appended so multiple partitions' proposals in
  // the same scan don't all propose the identical name.
  if (group.isCommonAccessScope) {
    const boundaryValues = (group.attributeCriteria || []).filter((c) => c.isBoundary).map((c) => c.value);
    return boundaryValues.length ? `Common Access - ${boundaryValues.join(separator)}` : "Common Access";
  }
  return (group.attributeCriteria || []).map((c) => c.value).join(separator);
}

// Wraps `baseName` in the given prefix/suffix, but only adds whichever part
// isn't already there — so calling this on a name that's already correctly
// wrapped (e.g. re-proposing a name for a group after Configuration hasn't
// changed, or a caller passing in a name that already has it) doesn't stack
// a second copy of the prefix/suffix on top.
export function applyRoleNaming(baseName, rolePrefix, roleSuffix) {
  const prefix = rolePrefix || "";
  const suffix = roleSuffix || "";
  let result = baseName;
  if (prefix && !result.startsWith(prefix)) result = prefix + result;
  if (suffix && !result.endsWith(suffix)) result = result + suffix;
  return result;
}

// The tenant's persisted Role Naming prefix/suffix (Configuration) wrapped
// around a group's criteria — this is what create-role (individual or bulk)
// proposes as the Role's name by default. Only used at actual role-creation
// time, not for scan displays/reports.
export function proposedRoleName(group, rolePrefix, roleSuffix, separator) {
  return applyRoleNaming(roleCriteriaText(group, separator), rolePrefix, roleSuffix);
}

// What a scan display or report should call this group: the real created
// Role's name once one exists (the authoritative source of truth, already
// includes whatever prefix/suffix it was created with) — otherwise just its
// criteria, deliberately without Role Naming's prefix/suffix, since nothing
// has actually been created yet.
export function displayRoleName(group, separator) {
  return group.roleCreated ? group.roleCreated.name : roleCriteriaText(group, separator);
}
