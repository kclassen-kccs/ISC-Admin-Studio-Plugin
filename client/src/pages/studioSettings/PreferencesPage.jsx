import { useState } from "react";
import { Settings, Monitor, Sun, Moon, Wand2, Check, AlignLeft, ListTree, KeyRound, Eye, EyeOff } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../../hooks/useAuth";
import { useTheme } from "../../hooks/useTheme";
import { getUserPreferences, setUserPreferences } from "../../lib/sailpoint";
import { getJsonEditMode, setJsonEditMode } from "../../lib/jsonEditMode";
import { TopBar } from "../../components/TopBar";
import { StudioSettingsTitleMenu } from "../../components/StudioSettingsTitleMenu";
import { AutoConvertModal } from "../../components/AutoConvertModal";
import { SectionLabel, OutlineButton, PrimaryButton } from "../../components/ui";

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

// The Anthropic API key powers the AI features (descriptions, role evaluation
// review, workflow drafting) by calling api.anthropic.com straight from the
// browser. It is user data in the strictest sense: stored only in this
// browser's IndexedDB with the other preferences, never in the bundle, never
// sent to ISC. Once saved it is shown masked (prefix + last four) and can only
// be replaced or removed, not read back. Today ISC's plugin CSP still blocks
// the outbound call, so the key waits until plugins are allowed to reach out.
function AnthropicKeySection({ prefs, onSaved }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [show, setShow] = useState(false);
  const hasKey = !!prefs?.hasAnthropicApiKey;

  const save = useMutation({
    mutationFn: (anthropicApiKey) => setUserPreferences({ anthropicApiKey }),
    onSuccess: (next) => {
      setDraft("");
      setShow(false);
      setEditing(false);
      onSaved(next);
    },
  });

  function submit(e) {
    e.preventDefault();
    const key = draft.trim();
    if (!key) return;
    save.mutate(key);
  }

  const error = save.error ? save.error?.response?.data?.error || save.error.message : null;

  return (
    <>
      <SectionLabel bold>Anthropic API Key</SectionLabel>
      <div className="px-4">
        <div className="border border-gray-100 rounded-xl p-4">
          {hasKey && !editing ? (
            <div className="flex items-center gap-3">
              <KeyRound size={16} className="text-gray-400 flex-shrink-0" />
              <span className="flex-1 min-w-0 font-mono text-sm text-gray-700 truncate" title="Saved key (masked)">
                {prefs.anthropicApiKeyHint}
              </span>
              <OutlineButton onClick={() => setEditing(true)} className="!w-auto !py-2 !px-3 text-xs">
                Change
              </OutlineButton>
              <OutlineButton onClick={() => save.mutate("")} loading={save.isPending} className="!w-auto !py-2 !px-3 text-xs">
                Remove
              </OutlineButton>
            </div>
          ) : (
            <form onSubmit={submit} className="flex items-center gap-2">
              <div className="relative flex-1 min-w-0">
                <input
                  type={show ? "text" : "password"}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="sk-ant-…"
                  autoComplete="off"
                  spellCheck={false}
                  aria-label="Anthropic API key"
                  className="w-full bg-white border border-gray-200 rounded-xl pl-3 pr-10 py-3 font-mono text-sm text-gray-900 placeholder-gray-400 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 transition"
                />
                <button
                  type="button"
                  onClick={() => setShow((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                  title={show ? "Hide key" : "Show key"}
                  aria-label={show ? "Hide key" : "Show key"}
                >
                  {show ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
              <PrimaryButton type="submit" loading={save.isPending} disabled={!draft.trim()} className="!w-auto !py-2.5 !px-4">
                Save
              </PrimaryButton>
              {hasKey && (
                <OutlineButton
                  type="button"
                  onClick={() => {
                    setEditing(false);
                    setDraft("");
                  }}
                  className="!w-auto !py-2.5 !px-3"
                >
                  Cancel
                </OutlineButton>
              )}
            </form>
          )}
          {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
          <p className="text-xs text-gray-400 mt-3">
            Used by the AI features (descriptions, role evaluation review, workflow drafting). The key is kept only in this
            browser and is sent only to api.anthropic.com. ISC does not yet let plugins make that call, so AI stays
            unavailable until it does.
          </p>
        </div>
      </div>
    </>
  );
}

export default function PreferencesPage() {
  const { session } = useAuth();
  const { mode, setMode, systemDark } = useTheme();
  const [autoConvertOpen, setAutoConvertOpen] = useState(false);
  const queryClient = useQueryClient();
  const prefs = useQuery({ queryKey: ["user-preferences"], queryFn: getUserPreferences, enabled: !!session, staleTime: Infinity });

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

        <AnthropicKeySection prefs={prefs.data} onSaved={(next) => queryClient.setQueryData(["user-preferences"], next)} />

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
      </div>

      {autoConvertOpen && <AutoConvertModal session={session} onClose={() => setAutoConvertOpen(false)} />}
    </div>
  );
}
