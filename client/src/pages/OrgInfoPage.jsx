import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Building2, Check, X, Copy, Info, ShieldAlert, Braces } from "lucide-react";
import toast from "react-hot-toast";
import { getOrgConfig } from "../lib/sailpoint";
import { useUrlState } from "../hooks/useUrlState";
import { TopBar } from "../components/TopBar";
import { BrowseTitleMenu } from "../components/BrowseTitleMenu";
import { SectionLabel, ErrorBox, SkeletonList, IconButton } from "../components/ui";
import { escapeHtml, highlightJson, JSON_EDITOR_STYLE } from "../components/JsonEditor";

// ─── Org Info ────────────────────────────────────────────────────────────────
// The tenant's org config (GET /v2026/org-config), organised into sections.
// Fields are grouped by what they are rather than listed in API order; any
// field not named below still shows, under "Other settings", so a setting
// ISC adds later is never silently hidden.

// Readable names for fields whose camelCase doesn't read well on its own.
const LABELS = {
  orgName: "Org name",
  timeZone: "Time zone",
  lcsChangeHonorsSourceEnableFeature: "Lifecycle state change honors source enable/disable",
  segmentationEnabled: "Segmentation",
  entitlementStickinessDisabled: "Entitlement stickiness disabled",
  nonOrgAdminsCanManageIscEntitlements: "Non-org-admins can manage ISC entitlements",
  machineAccountDiscoveryEnabled: "Machine account discovery",
  safActivated: "SAF activated",
  iaiEnableCertificationRecommendations: "Certification recommendations",
  iaiEnableAccessRequestRecommendations: "Access request recommendations",
  harborPilotEnabled: "Harbor Pilot",
  naturalLanguageSearchEnabled: "Natural language search",
  aiAgentDeleteRequestEnabled: "AI agent delete requests",
  armCustomerId: "Customer ID",
  armSapSystemIdMappings: "SAP system ID mappings",
  armAuth: "Auth",
  armDb: "Database",
  armSsoUrl: "SSO URL",
};

const GENERAL = ["orgName", "timeZone"];
const AI = [
  "iaiEnableCertificationRecommendations", "iaiEnableAccessRequestRecommendations",
  "harborPilotEnabled", "naturalLanguageSearchEnabled", "aiAgentDeleteRequestEnabled",
];
const FEATURES = [
  "segmentationEnabled", "machineAccountDiscoveryEnabled", "safActivated", "lcsChangeHonorsSourceEnableFeature",
  "entitlementStickinessDisabled", "nonOrgAdminsCanManageIscEntitlements",
];
const isArm = (k) => k.startsWith("arm");
const HANDLED = new Set([...GENERAL, ...AI, ...FEATURES, "sodReportConfigs"]);

function labelOf(key) {
  return LABELS[key] || key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
}

function BoolPill({ value }) {
  return value ? (
    <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full border bg-emerald-50 text-emerald-700 border-emerald-200">
      <Check size={11} /> On
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full border bg-gray-50 text-gray-500 border-gray-200">
      <X size={11} /> Off
    </span>
  );
}

function displayValue(value) {
  if (typeof value === "boolean") return <BoolPill value={value} />;
  if (value == null || value === "") return <span className="text-gray-400">Not set</span>;
  if (typeof value === "object") return <code className="text-xs break-all">{JSON.stringify(value)}</code>;
  return String(value);
}

function Rows({ keys, data }) {
  return (
    <div className="px-4">
      {keys.map((k) => (
        // Own row rather than InfoRow: the label may wrap (some are long),
        // and the value can be a pill rather than text.
        <div key={k} className="flex justify-between items-center gap-4 py-3 border-b border-gray-100 last:border-0">
          <span className="text-sm text-gray-500 min-w-0" title={k}>{labelOf(k)}</span>
          <span className="text-sm text-gray-900 font-medium text-right flex-shrink-0 max-w-[60%] break-words">{displayValue(data[k])}</span>
        </div>
      ))}
    </div>
  );
}

function SodColumnsTable({ columns }) {
  const sorted = [...columns].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  return (
    <div className="px-4 pb-2">
      <div className="border border-gray-100 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-xs text-gray-500">
            <tr>
              <th className="text-left font-medium px-3 py-2 w-14">Order</th>
              <th className="text-left font-medium px-3 py-2">Column</th>
              <th className="text-left font-medium px-3 py-2 w-24">Included</th>
              <th className="text-left font-medium px-3 py-2 w-24">Required</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {sorted.map((c) => (
              <tr key={c.columnName}>
                <td className="px-3 py-2 text-gray-500">{c.order ?? "—"}</td>
                <td className="px-3 py-2 text-gray-900">{c.columnName}</td>
                <td className="px-3 py-2">{c.included ? <Check size={14} className="text-emerald-600" /> : <X size={14} className="text-gray-300" />}</td>
                <td className="px-3 py-2">{c.required ? <Check size={14} className="text-emerald-600" /> : <X size={14} className="text-gray-300" />}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RawJson({ data }) {
  const pretty = useMemo(() => JSON.stringify(data, null, 2), [data]);
  return (
    <div className="px-4 py-4">
      <div className="flex items-center justify-between mb-3 gap-3">
        <p className="text-xs text-gray-500">The org config exactly as ISC returns it.</p>
        <IconButton
          icon={Copy}
          title="Copy JSON"
          onClick={() => navigator.clipboard.writeText(pretty).then(() => toast.success("JSON copied"), () => toast.error("Couldn't copy"))}
        />
      </div>
      <pre
        className="border border-gray-200 rounded-xl overflow-auto text-gray-800 bg-gray-50"
        style={JSON_EDITOR_STYLE}
        dangerouslySetInnerHTML={{ __html: highlightJson(escapeHtml(pretty)) }}
      />
    </div>
  );
}

const SECTIONS = [
  { key: "details", label: "Details", Icon: Info },
  { key: "sod", label: "SOD", Icon: ShieldAlert },
  { key: "json", label: "JSON", Icon: Braces },
];

export default function OrgInfoPage() {
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ["org-config"], queryFn: getOrgConfig });
  const cfg = data && typeof data === "object" ? data : null;

  const present = (keys) => (cfg ? keys.filter((k) => k in cfg) : []);
  const armKeys = cfg ? Object.keys(cfg).filter(isArm) : [];
  const armConfigured = armKeys.some((k) => cfg[k] != null && cfg[k] !== "");
  const otherKeys = cfg ? Object.keys(cfg).filter((k) => !HANDLED.has(k) && !isArm(k)).sort() : [];
  const sod = Array.isArray(cfg?.sodReportConfigs) ? cfg.sodReportConfigs : null;
  const [section, setSection] = useUrlState("tab", "details");

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <TopBar title={<BrowseTitleMenu active="Org Info" />} loading={isLoading} />
      <div className="flex-1 overflow-y-auto pb-24">
        {isLoading && <div className="px-4 py-4"><SkeletonList rows={6} /></div>}
        {error && <ErrorBox message={error.response?.data?.error || error.message} onRetry={refetch} />}

        {cfg && (
          <>
            <div className="px-4 py-4 flex items-center gap-3 border-b border-gray-100">
              <div className="w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center flex-shrink-0">
                <Building2 size={20} className="text-slate-600" />
              </div>
              <div className="min-w-0">
                <h2 className="text-base font-semibold text-gray-900 truncate">{cfg.orgName || "Org"}</h2>
                <p className="text-xs text-gray-500">{cfg.timeZone || "No time zone set"}</p>
              </div>
            </div>

            <div className="flex">
              <div className="w-28 flex-shrink-0 border-r border-gray-100 py-2">
                {SECTIONS.map(({ key, label, Icon }) => (
                  <button
                    key={key}
                    onClick={() => setSection(key)}
                    className={`w-full flex flex-col items-center gap-1 px-2 py-3 text-xs font-medium transition-colors ${
                      section === key ? "text-blue-600 bg-blue-50" : "text-gray-400 hover:text-gray-600"
                    }`}
                  >
                    <Icon size={18} />
                    {label}
                  </button>
                ))}
              </div>

              <div className="flex-1 min-w-0">
                {section === "details" && (
                  <div className="pb-4">
                    <SectionLabel>General</SectionLabel>
                    <Rows keys={present(GENERAL)} data={cfg} />

                    <SectionLabel>Features</SectionLabel>
                    <Rows keys={present(FEATURES)} data={cfg} />

                    <SectionLabel>AI &amp; Recommendations</SectionLabel>
                    <Rows keys={present(AI)} data={cfg} />

                    {armKeys.length > 0 && (
                      <>
                        <SectionLabel>Access Risk Management (ARM)</SectionLabel>
                        {armConfigured ? (
                          <Rows keys={armKeys} data={cfg} />
                        ) : (
                          <p className="px-4 py-2 text-sm text-gray-400">Not configured on this tenant.</p>
                        )}
                      </>
                    )}

                    {otherKeys.length > 0 && (
                      <>
                        <SectionLabel>Other settings</SectionLabel>
                        <Rows keys={otherKeys} data={cfg} />
                      </>
                    )}
                  </div>
                )}

                {section === "sod" && (
                  sod ? (
                    <div className="pb-4">
                      <SectionLabel>SoD Report Columns ({sod.filter((c) => c.included).length} of {sod.length} included)</SectionLabel>
                      <SodColumnsTable columns={sod} />
                    </div>
                  ) : (
                    <p className="px-4 py-6 text-sm text-gray-400">This tenant's org config has no SoD report column settings.</p>
                  )
                )}

                {section === "json" && <RawJson data={cfg} />}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
