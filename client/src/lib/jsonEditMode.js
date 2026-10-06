/**
 * Which view JSON editors open in — "text" or "tree" — chosen on
 * Studio Settings > Preferences. Text by default.
 *
 * The server copy (GET/PUT /api/preferences, jsonEditMode) is what follows a
 * user across devices. This mirror in localStorage exists because an editor
 * decides its mode once, as it mounts, and can't wait on a network round
 * trip; UserPreferencesSync refreshes it whenever the server copy loads.
 */
export const JSON_EDIT_MODES = ["text", "tree"];
const KEY = "json-edit-mode";

export function getJsonEditMode() {
  try {
    const v = localStorage.getItem(KEY);
    return JSON_EDIT_MODES.includes(v) ? v : "text";
  } catch {
    return "text";
  }
}

export function setJsonEditMode(mode) {
  if (!JSON_EDIT_MODES.includes(mode)) return;
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    // Storage unavailable — the editor falls back to Text, the default.
  }
}
