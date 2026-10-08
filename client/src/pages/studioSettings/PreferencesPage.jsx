import { useState } from "react";
import { Settings, Monitor, Sun, Moon, Wand2, Check, AlignLeft, ListTree, KeyRound, Eye, EyeOff, Workflow, Globe } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../../hooks/useAuth";
import { useTheme } from "../../hooks/useTheme";
import { getUserPreferences, setUserPreferences, provisionAiWorkflow, describeAiSetup, getAiTenantSetup } from "../../lib/sailpoint";
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

// How the AI features reach Claude. "workflow" runs the tenant's "Admin
// Studio AI Query" workflow, which holds the key in ISC Parameter Storage and
// makes the outbound call on the plugin's behalf; "direct" calls
// api.anthropic.com from this browser with the key saved below, which ISC's
// plugin policy blocks today but is kept for when it doesn't.
const AI_ROUTE_OPTIONS = [
  { value: "workflow", label: "ISC workflow", hint: "Runs the \"Admin Studio AI Query\" workflow on this tenant; the key stays in ISC Parameter Storage", Icon: Workflow },
  { value: "direct", label: "Direct from this browser", hint: "Uses a key typed below, held for this tab only; ISC doesn't yet allow this call from a plugin", Icon: Globe },
];

// The Anthropic API key is never persisted by the plugin. Saving it here
// writes it, encrypted end to end, into the tenant's "Admin Studio AI Key"
// parameter and creates the "Admin Studio AI Connection" parameter and the
// "Admin Studio AI Query" workflow when they are missing (lib/aiSetup.js);
// that is what the default ISC workflow route runs on. The only other copy
// is held in memory for this tab so the direct route can use it. The screen
// shows whether the tenant has the parameter, never a value: ISC does not
// hand a private value back, and the plugin keeps none.
function AnthropicKeySection({ session }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [show, setShow] = useState(false);
  const [setupNote, setSetupNote] = useState(null);
  const setup = useQuery({ queryKey: ["ai-tenant-setup"], queryFn: getAiTenantSetup, enabled: !!session, staleTime: 60_000 });
  const stored = !!setup.data?.key?.present;
  const missing = setup.data
    ? [
        !setup.data.connection.present && '"Admin Studio AI Connection" parameter',
        !setup.data.workflow.present && '"Admin Studio AI Query" workflow',
        setup.data.workflow.present && setup.data.workflow.enabled && "the workflow is enabled (it must stay disabled)",
      ].filter(Boolean)
    : [];

  const save = useMutation({
    mutationFn: (apiKey) => provisionAiWorkflow(apiKey),
    onMutate: () => setSetupNote(null),
    onSuccess: (result) => {
      setDraft("");
      setShow(false);
      setEditing(false);
      setSetupNote(describeAiSetup(result));
      queryClient.invalidateQueries({ queryKey: ["ai-tenant-setup"] });
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
          {stored && !editing ? (
            <div className="flex items-center gap-3">
              <KeyRound size={16} className="text-gray-400 flex-shrink-0" />
              <span className="flex-1 min-w-0 text-sm text-gray-700 truncate">
                Stored in this tenant&apos;s &quot;Admin Studio AI Key&quot; parameter
                {missing.length > 0 && <span className="text-amber-700">; missing: {missing.join(", ")}</span>}
              </span>
              <OutlineButton onClick={() => setEditing(true)} className="!w-auto !py-2 !px-3 text-xs">
                Replace
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
                Save to ISC
              </PrimaryButton>
              {stored && (
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
          {setupNote && !error && <p className="text-xs text-green-700 mt-2">{setupNote}</p>}
          {setup.error && !error && (
            <p className="text-xs text-amber-700 mt-2">Couldn&apos;t read this tenant&apos;s AI setup: {setup.error?.response?.data?.error || setup.error.message}</p>
          )}
          <p className="text-xs text-gray-400 mt-3">
            The key is stored only in this tenant&apos;s &quot;Admin Studio AI Key&quot; parameter, encrypted on the way
            there; the plugin keeps no copy. Saving also creates the &quot;Admin Studio AI Connection&quot; parameter and
            the &quot;Admin Studio AI Query&quot; workflow if they are missing, which is what the ISC workflow route runs
            on, and replacing the key checks they are still in place. The &quot;Direct from this browser&quot; route can
            use a key typed here until this tab is closed or reloaded.
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
  const aiRoute = prefs.data?.aiRoute || "workflow";
  const saveAiRoute = useMutation({
    mutationFn: (route) => setUserPreferences({ aiRoute: route }),
    onSuccess: (next) => queryClient.setQueryData(["user-preferences"], next),
  });
  function chooseAiRoute(next) {
    queryClient.setQueryData(["user-preferences"], (cur) => ({ ...(cur || {}), aiRoute: next }));
    saveAiRoute.mutate(next);
  }

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

        <SectionLabel bold>AI Route</SectionLabel>
        <div className="px-4">
          <div className="border border-gray-100 rounded-xl overflow-hidden">
            {AI_ROUTE_OPTIONS.map(({ value, label, hint, Icon }, i) => (
              <button
                key={value}
                onClick={() => chooseAiRoute(value)}
                className={`w-full flex items-center gap-3 px-4 py-3.5 text-left ${i > 0 ? "border-t border-gray-100" : ""}`}
                aria-pressed={aiRoute === value}
              >
                <Icon size={16} className="text-gray-400 flex-shrink-0" />
                <span className="flex-1 min-w-0">
                  <span className="text-sm text-gray-700 block">{label}</span>
                  <span className="text-xs text-gray-400 block">{hint}</span>
                </span>
                {aiRoute === value && <Check size={16} className="text-blue-600 flex-shrink-0" />}
              </button>
            ))}
          </div>
          <p className="text-xs text-gray-400 mt-1.5">
            The workflow reads its URL from the &quot;Admin Studio AI Connection&quot; parameter and its key from
            &quot;Admin Studio AI Key&quot;; set the key&apos;s header value in ISC Parameter Storage.
          </p>
        </div>

        <AnthropicKeySection session={session} />

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
