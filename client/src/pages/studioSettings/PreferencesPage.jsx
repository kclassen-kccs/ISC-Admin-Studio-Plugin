import { useState } from "react";
import { Settings, Monitor, Sun, Moon, Wand2, Check, AlignLeft, ListTree } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { useAuth } from "../../hooks/useAuth";
import { useTheme } from "../../hooks/useTheme";
import { setUserPreferences } from "../../lib/sailpoint";
import { getJsonEditMode, setJsonEditMode } from "../../lib/jsonEditMode";
import { TopBar } from "../../components/TopBar";
import { StudioSettingsTitleMenu } from "../../components/StudioSettingsTitleMenu";
import { AutoConvertModal } from "../../components/AutoConvertModal";
import { SectionLabel, OutlineButton } from "../../components/ui";

// App-level preferences — currently just Dark Mode (moved here from the
// Profile screen) and Sign out. Role Statistics Refresh lives on
// Evaluation Config instead, alongside Role Evaluation's other settings.
//
// Dark mode is USER data, not tenant data — persisted server-side per
// signed-in user within this tenant (see GET/PUT /api/preferences), not
// shared with other users of the same tenant the way Role Scans/Evals/
// tenant settings are. localStorage (see useTheme) still applies it
// instantly on load, before this PUT round-trips or even before a session
// exists at all; this just keeps the server copy — the one that follows
// this user across devices — in sync whenever they toggle it here.
// "System" is the default: the app follows the operating system's appearance
// rather than pinning a theme on someone who never picked one.
//
// It was briefly labelled "Same as ISC", which was a promise the app can't
// keep — ISC's own light/dark choice isn't published by any API (not the
// branding service, not UI metadata, not the identity record), so nothing
// here can read it. Naming it after the OS describes what actually happens,
// and it still agrees with ISC whenever ISC is itself following the OS.
const THEME_OPTIONS = [
  { value: "system", label: "System", hint: "Follows your operating system's appearance", Icon: Monitor },
  { value: "light", label: "Light", hint: "Always light", Icon: Sun },
  { value: "dark", label: "Dark", hint: "Always dark", Icon: Moon },
];

// The view every JSON editor opens in. Text by default — it shows the
// document exactly as ISC stores it, and it's the one that always works:
// JSON that doesn't parse opens in Text whatever this is set to, since Tree
// can't show it. Either way, the editor's own Tree | Text tabs still switch
// views for that one edit.
const JSON_MODE_OPTIONS = [
  { value: "text", label: "Text", hint: "The raw JSON, with find & replace", Icon: AlignLeft },
  { value: "tree", label: "Tree", hint: "Expandable fields, edited in place", Icon: ListTree },
];

export default function PreferencesPage() {
  const { session } = useAuth();
  const { mode, setMode, systemDark } = useTheme();
  const navigate = useNavigate();
  const [autoConvertOpen, setAutoConvertOpen] = useState(false);

  const saveThemeMode = useMutation({
    mutationFn: (themeMode) => setUserPreferences({ themeMode }),
  });

  const [jsonMode, setJsonModeState] = useState(getJsonEditMode);
  const saveJsonMode = useMutation({
    mutationFn: (jsonEditMode) => setUserPreferences({ jsonEditMode }),
  });
  function chooseJsonMode(next) {
    setJsonModeState(next);
    setJsonEditMode(next); // editors read this as they open
    saveJsonMode.mutate(next); // and this follows the user to other devices
  }

  function chooseMode(next) {
    setMode(next);
    saveThemeMode.mutate(next);
  }

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <TopBar title={<StudioSettingsTitleMenu active="Preferences" />} />
      <div className="flex-1 overflow-y-auto pb-24">
        <div className="px-4 py-4 flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-violet-50 flex items-center justify-center flex-shrink-0">
            <Settings size={18} className="text-violet-600" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-gray-900">Preferences</h2>
            <p className="text-xs text-gray-500 mt-0.5">App-level settings that aren't specific to Role Mining or Role Evaluation.</p>
          </div>
        </div>

        <SectionLabel bold>Tenant Conversion</SectionLabel>
        <div className="px-4">
          <div className="border border-gray-100 rounded-xl p-4">
            <p className="text-xs text-gray-500 mb-3">
              Auto-convert a DemoHub tenant to a new Role Model end to end — backup, rename existing
              roles, mine and create new roles, optionally build Data Segments, deploy Attribute
              Sync, apply AI descriptions, and remove the old roles — with a running log and a
              change-log PDF at the end.
            </p>
            <OutlineButton onClick={() => setAutoConvertOpen(true)} className="!w-auto">
              <Wand2 size={16} />
              Auto Convert a Tenant
            </OutlineButton>
          </div>
        </div>

        <SectionLabel bold>Appearance</SectionLabel>
        <div className="px-4">
          <div className="border border-gray-100 rounded-xl overflow-hidden">
            {THEME_OPTIONS.map(({ value, label, hint, Icon }, i) => (
              <button
                key={value}
                onClick={() => chooseMode(value)}
                className={`w-full flex items-center gap-3 px-4 py-3.5 text-left ${i > 0 ? "border-t border-gray-100" : ""}`}
                aria-pressed={mode === value}
              >
                <Icon size={16} className="text-gray-400 flex-shrink-0" />
                <span className="flex-1 min-w-0">
                  <span className="text-sm text-gray-700 block">{label}</span>
                  <span className="text-xs text-gray-400 block">
                    {value === "system" ? `${hint} — currently ${systemDark ? "dark" : "light"}` : hint}
                  </span>
                </span>
                {mode === value && <Check size={16} className="text-blue-600 flex-shrink-0" />}
              </button>
            ))}
          </div>
        </div>

        <SectionLabel bold>JSON Edit Mode</SectionLabel>
        <div className="px-4">
          <div className="border border-gray-100 rounded-xl overflow-hidden">
            {JSON_MODE_OPTIONS.map(({ value, label, hint, Icon }, i) => (
              <button
                key={value}
                onClick={() => chooseJsonMode(value)}
                className={`w-full flex items-center gap-3 px-4 py-3.5 text-left ${i > 0 ? "border-t border-gray-100" : ""}`}
                aria-pressed={jsonMode === value}
              >
                <Icon size={16} className="text-gray-400 flex-shrink-0" />
                <span className="flex-1 min-w-0">
                  <span className="text-sm text-gray-700 block">{label}</span>
                  <span className="text-xs text-gray-400 block">{hint}</span>
                </span>
                {jsonMode === value && <Check size={16} className="text-blue-600 flex-shrink-0" />}
              </button>
            ))}
          </div>
          <p className="text-xs text-gray-400 mt-1.5">
            Where JSON editors open. JSON that doesn&apos;t parse always opens in Text, and each editor&apos;s own
            Tree | Text tabs still switch for that edit.
          </p>
        </div>

        {/* Same treatment as Profile's own sign-out button — a full-width
            outlined red button, last on the page. */}
        <div className="px-4 pt-6">
          <button
            onClick={handleLogout}
            className="w-full flex items-center justify-center gap-2 border border-red-200 text-red-600 font-medium text-sm py-3.5 rounded-xl hover:bg-red-50 transition-colors"
          >
            <LogOut size={16} />
            Sign out
          </button>
        </div>
      </div>

      {autoConvertOpen && <AutoConvertModal session={session} onClose={() => setAutoConvertOpen(false)} />}
    </div>
  );
}
