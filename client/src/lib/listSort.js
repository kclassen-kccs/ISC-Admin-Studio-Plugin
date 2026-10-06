// The list sort shared by Workflows, Forms and Launchers: A–Z (the default) or
// most recently updated first.
export const LIST_SORT_OPTIONS = [
  { value: "name", label: "A–Z" },
  { value: "updated", label: "Last updated" },
];

// When an item last changed — its modified date, or created if never edited.
export const lastUpdated = (item) => item?.modified || item?.created || null;

/** A new array: by name, or (sortBy "updated") newest change first with name as the tie-break. */
export function sortList(items, sortBy) {
  const byName = (a, b) => String(a.name || "").localeCompare(String(b.name || ""), undefined, { sensitivity: "base" });
  const when = (x) => Date.parse(lastUpdated(x) || "") || 0;
  return [...items].sort(sortBy === "updated" ? (a, b) => when(b) - when(a) || byName(a, b) : byName);
}

/** " · updated Sep 19, 2026" — a row only shows it while the list is ordered by it. */
export function updatedSuffix(item, sortBy) {
  const at = sortBy === "updated" ? lastUpdated(item) : null;
  return at ? ` · updated ${new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}` : "";
}
