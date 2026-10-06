// Data Segments Draft → segments: which suggestions the mining screen's
// Create All / Merge All acts on, shared so Auto Convert applies a scan
// exactly the same way.

// Nothing created for it yet and no existing segment already has its name.
export function creatableSegmentSuggestions(suggestions) {
  return (suggestions || []).filter((s) => !s.segmentCreated && !s.existingSegmentName);
}

// Matches an existing segment, hasn't been merged in yet, and actually has
// something to add — same eligibility the row's own "Add suggested roles &
// entitlements" button and the server's add-to-existing route require.
export function mergeableSegmentSuggestions(suggestions) {
  return (suggestions || []).filter(
    (s) => s.existingSegmentName && !s.addedToExisting &&
      ((s.suggestedRoles?.length || 0) > 0 || (s.suggestedEntitlements?.length || 0) > 0)
  );
}

// One-line notes on a create/merge result worth surfacing — the same things
// the mining screen toasts: items left off by ISC's 50-item cap (selection
// mode), what metadata mode tagged, and a refused identity scope.
export function segmentResultNotes(results) {
  const ok = (results || []).filter((r) => r.ok);
  const notes = [];
  const trimmed = ok.filter((r) => r.dropped && (r.dropped.entitlements || r.dropped.roles));
  if (trimmed.length) {
    const ents = trimmed.reduce((n, r) => n + (r.dropped.entitlements || 0), 0);
    const roles = trimmed.reduce((n, r) => n + (r.dropped.roles || 0), 0);
    notes.push({ level: "warn", message: `${trimmed.length} segment(s) hit ISC's 50-item Access Model limit — ${ents} entitlement(s) and ${roles} role(s) left off.` });
  }
  const tagged = ok.filter((r) => r.tagged);
  if (tagged.length) {
    const ents = tagged.reduce((n, r) => n + (r.tagged.entitlements || 0), 0);
    const roles = tagged.reduce((n, r) => n + (r.tagged.roles || 0), 0);
    notes.push({ level: "info", message: `Tagged ${ents} entitlement(s) and ${roles} role(s) with their segment metadata value.` });
  }
  for (const r of ok.filter((x) => x.identityScope && !x.identityScope.applied)) {
    notes.push({ level: "warn", message: `"${r.segmentName || r.id}" was created WITHOUT the identity scope — ISC refused it (${r.identityScope.reason}).` });
  }
  return notes;
}
