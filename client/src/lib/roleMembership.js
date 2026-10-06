// Turns SailPoint's membership criteria tree (AND/OR groups over attribute
// comparisons) into a plain-English sentence — shared between the on-screen
// Role Detail view and the printed/exported role PDF, so both describe a
// role's membership rule identically.

const CRITERIA_OPERATION_LABELS = {
  EQUALS: "is",
  NOT_EQUALS: "is not",
  CONTAINS: "contains",
  DOES_NOT_CONTAIN: "does not contain",
  STARTS_WITH: "starts with",
  ENDS_WITH: "ends with",
};

function criteriaPropertyLabel(key) {
  const raw = (key?.property || "").replace(/^attribute\./, "");
  if (!raw) return key?.property || "value";
  return raw.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
}

function criteriaLeafValue(node) {
  if (Array.isArray(node.values) && node.values.length) return node.values.join(" or ");
  if (node.stringValue) return node.stringValue;
  return "—";
}

/**
 * Recurses depth-first through a criteria tree, joining group children with
 * the group's own AND/OR operation, and parenthesizing a nested group only
 * when it has more than one child (a single-child group reads the same
 * without them).
 */
export function describeCriteria(node, depth = 0) {
  if (!node) return null;
  const children = (node.children || []).filter(Boolean);
  if ((node.operation === "AND" || node.operation === "OR") && children.length) {
    const parts = children.map((c) => describeCriteria(c, depth + 1)).filter(Boolean);
    if (parts.length === 0) return null;
    const joined = parts.join(node.operation === "AND" ? " and " : " or ");
    return depth > 0 && parts.length > 1 ? `(${joined})` : joined;
  }
  if (!node.key) return null;
  const label = CRITERIA_OPERATION_LABELS[node.operation]
    || (node.operation || "matches").toLowerCase().replace(/_/g, " ");
  return `${criteriaPropertyLabel(node.key)} ${label} "${criteriaLeafValue(node)}"`;
}

/**
 * Mirrors the server's extractSingleAttributeCriterion — pulls {attrKey,
 * value} out of a membership criteria tree only when it's exactly one
 * EQUALS(attribute.X, value) leaf (optionally wrapped in a single-child
 * AND, the shape this app itself always builds). Anything more complex
 * (multiple conditions, OR, non-EQUALS) returns null — used to decide
 * whether the simple attribute/value edit form can safely round-trip a
 * dimension's existing rule.
 */
export function extractSingleAttributeCriterion(node) {
  if (!node) return null;
  if (node.operation === "AND") {
    const children = (node.children || []).filter(Boolean);
    if (children.length !== 1) return null;
    return extractSingleAttributeCriterion(children[0]);
  }
  if (node.operation !== "EQUALS") return null;
  if (node.key?.type !== "IDENTITY" || !node.key.property?.startsWith("attribute.")) return null;
  const value = Array.isArray(node.values) && node.values.length ? node.values[0] : node.stringValue;
  if (!value) return null;
  return { attrKey: node.key.property.slice("attribute.".length), value };
}

/** Full plain-English membership description, with the same fallbacks used on screen. */
export function describeMembership(membership) {
  const text = describeCriteria(membership?.criteria);
  if (text) return text;
  if (membership?.identities?.length) {
    return `Assigned directly to ${membership.identities.length} identit${membership.identities.length === 1 ? "y" : "ies"}`;
  }
  return "No membership rule — manually assigned";
}

/**
 * A birthright role: any role with a MEMBERSHIP RULE — ISC membership that is
 * decided by criteria rather than an explicit identity list. A role with an
 * identity list, or with no membership at all, is not birthright. Mirrors the
 * server's isBirthrightRole (User Certifications' "Exclude Birthright Roles"),
 * so the Roles list's Birthright filter and that setting agree on every role.
 */
export function isBirthrightRole(role) {
  const m = role?.membership;
  return !!m && String(m.type || "").toUpperCase() !== "IDENTITY_LIST" && m.criteria != null;
}
