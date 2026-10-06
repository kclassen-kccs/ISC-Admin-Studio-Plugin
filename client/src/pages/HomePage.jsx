import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { RefreshCw, ChevronRight, CheckCircle2, AlertTriangle, FileText } from "lucide-react";
import {
  getIdentitiesCount, getSourcesCount, getRolesCount,
  getRoleStatsSummary, listMyReports, getSchemaAnalysis, NO_ACCESS,
} from "../lib/sailpoint";
import { useAuth } from "../hooks/useAuth";
import { TopBar } from "../components/TopBar";
import { MetricCard, SectionLabel } from "../components/ui";
import toast from "react-hot-toast";
import { tenantUiHost } from "../lib/tenantHost";

export default function HomePage() {
  const { session } = useAuth();
  const navigate = useNavigate();
  const displayName = session?.identity?.displayName || session?.identity?.username || "?";

  const ids = useQuery({ queryKey: ["identities-count"], queryFn: getIdentitiesCount });
  const srcs = useQuery({ queryKey: ["sources-count"], queryFn: getSourcesCount });
  const roles = useQuery({ queryKey: ["roles-count"], queryFn: getRolesCount });
  const roleStats = useQuery({ queryKey: ["role-stats-summary"], queryFn: getRoleStatsSummary });
  const myReports = useQuery({ queryKey: ["my-reports"], queryFn: listMyReports });

  // A tenant that has never run Schema Analysis has no mining attributes
  // yet, so the first person to sign in lands on that screen to pick them
  // (running it also turns the default boundary/segments toggles on — see
  // the server's first-run defaults). Once per browser session per tenant,
  // so deliberately navigating Home before running it doesn't bounce back.
  const schemaAnalysis = useQuery({ queryKey: ["schema-analysis"], queryFn: getSchemaAnalysis });
  useEffect(() => {
    if (!session?.tenant || !schemaAnalysis.isSuccess || schemaAnalysis.data) return;
    const promptedKey = `schema-analysis-prompted:${session.tenant}`;
    if (sessionStorage.getItem(promptedKey)) return;
    sessionStorage.setItem(promptedKey, "1");
    navigate("/studio-settings/schema-analysis");
  }, [session?.tenant, schemaAnalysis.isSuccess, schemaAnalysis.data, navigate]);

  function refresh() {
    ids.refetch(); srcs.refetch(); roles.refetch();
    roleStats.refetch(); myReports.refetch();
    toast.success("Dashboard refreshed");
  }

  const myReportsCount = Array.isArray(myReports.data) ? myReports.data.length : 0;


  return (
    <div className="flex flex-col min-h-screen bg-white">
      <TopBar
        subtitle={`${tenantUiHost(session?.tenant)}`}
        title="Dashboard"
        action={
          <div className="flex items-center gap-3">
            <button onClick={refresh} className="text-gray-400 hover:text-gray-600">
              <RefreshCw size={17} />
            </button>
            <button onClick={() => navigate("/profile")} className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center text-blue-700 text-xs font-bold">
              {displayName.charAt(0).toUpperCase()}
            </button>
          </div>
        }
      />

      <div className="flex-1 overflow-y-auto pb-24">
        {/* Metrics */}
        <SectionLabel>At a glance</SectionLabel>
        <div className="grid grid-cols-2 gap-3 px-4">
          <MetricCard
            label="Identities"
            value={ids.isLoading ? undefined : (typeof ids.data === "number" ? ids.data : "—")}
            sub={ids.data === NO_ACCESS ? "No access for this account" : "Total in tenant"}
            onClick={() => navigate("/identities")}
          />
          <MetricCard
            label="Sources"
            value={srcs.isLoading ? undefined : (typeof srcs.data === "number" ? srcs.data : "—")}
            sub={srcs.data === NO_ACCESS ? "No access for this account" : "Connected"}
            onClick={() => navigate("/sources")}
          />
          <MetricCard
            label="Roles"
            value={roles.isLoading ? undefined : (typeof roles.data === "number" ? roles.data : "—")}
            sub={roles.data === NO_ACCESS ? "No access for this account" : "Total in tenant"}
            onClick={() => navigate("/roles")}
          />
          <MetricCard
            label="Common Access Roles"
            value={roleStats.isLoading ? undefined : (typeof roleStats.data?.commonRoleCount === "number" ? roleStats.data.commonRoleCount : "—")}
            sub="Flagged as ISC common access"
            onClick={() => navigate(
              roleStats.data?.available
                ? `/role-mining/role-eval-scans/${roleStats.data.scanId}`
                : "/role-mining/role-evaluation"
            )}
          />
        </div>

        {/* Role Statistics — from the most recent Role Statistics Refresh
            scan (see Studio Settings > Preferences), never a one-off manual
            Role Evaluation scan. Every box links straight to that scan's own
            results, not just the Role Evaluation list. */}
        {roleStats.data?.available && (
          <>
            <SectionLabel>Active Role Statistics</SectionLabel>
            <div className="grid grid-cols-2 gap-3 px-4">
              <button
                onClick={() => navigate(`/role-mining/role-eval-scans/${roleStats.data.scanId}`)}
                className="bg-emerald-50 border border-emerald-100 rounded-xl p-4 text-left hover:bg-emerald-100 transition-colors"
              >
                <div className="flex items-center gap-1.5 mb-1">
                  <CheckCircle2 size={14} className="text-emerald-600" />
                  <p className="text-xs text-emerald-700">Roles OK</p>
                </div>
                <p className="text-3xl font-semibold text-emerald-700">{roleStats.data.okCount}</p>
              </button>
              {(() => {
                const hasSod = roleStats.data.sodViolationCount > 0;
                const hasUpdates = roleStats.data.needsUpdateCount > 0;
                // Red (SOD violation present) beats yellow (updates needed,
                // no SOD) beats green (nothing needed) — a role can need
                // updates for non-SOD reasons too, so needsUpdateCount alone
                // isn't enough to tell yellow from red.
                const tone = hasSod
                  ? { bg: "bg-red-50", border: "border-red-100", hover: "hover:bg-red-100", text: "text-red-700", icon: "text-red-600" }
                  : hasUpdates
                  ? { bg: "bg-amber-50", border: "border-amber-100", hover: "hover:bg-amber-100", text: "text-amber-700", icon: "text-amber-600" }
                  : { bg: "bg-emerald-50", border: "border-emerald-100", hover: "hover:bg-emerald-100", text: "text-emerald-700", icon: "text-emerald-600" };
                return (
                  <button
                    onClick={() => navigate(`/role-mining/role-eval-scans/${roleStats.data.scanId}`)}
                    className={`${tone.bg} border ${tone.border} rounded-xl p-4 text-left ${tone.hover} transition-colors`}
                  >
                    <div className="flex items-center gap-1.5 mb-1">
                      <AlertTriangle size={14} className={tone.icon} />
                      <p className={`text-xs ${tone.text}`}>Roles Needing Updates</p>
                    </div>
                    <p className={`text-3xl font-semibold ${tone.text}`}>{roleStats.data.needsUpdateCount}</p>
                    {hasSod && <p className={`text-xs font-semibold ${tone.text} mt-1`}>SOD Violation!</p>}
                    {/* Informational only — mitigated SODs never factor into
                        needsUpdateCount/sodViolationCount or which tone
                        (color) this box renders, so this note always uses
                        neutral gray text regardless of tone. */}
                    {roleStats.data.mitigatedSodCount > 0 && (
                      <p className="text-xs font-medium text-gray-500 mt-1">Mitigated SOD Present</p>
                    )}
                  </button>
                );
              })()}
            </div>
            <p className="text-xs text-gray-400 px-4 mt-1.5">
              As of {new Date(roleStats.data.asOf).toLocaleString()}
            </p>
          </>
        )}

        {/* Quick actions */}
        <SectionLabel>Quick actions</SectionLabel>
        <div className="px-4 space-y-2">
          {[
            ...(myReportsCount > 0
              ? [{
                  label: `View my ${myReportsCount} report${myReportsCount === 1 ? "" : "s"}`,
                  sub: "PDF reports you've generated",
                  icon: FileText,
                  color: "bg-purple-50 text-purple-600",
                  path: "/reports",
                }]
              : []),
          ].map(({ label, sub, icon: Icon, color, path }) => (
            <button
              key={path}
              onClick={() => navigate(path)}
              className="w-full flex items-center gap-3 bg-white border border-gray-100 rounded-xl px-4 py-3.5 hover:bg-gray-50 active:bg-gray-100 transition-colors text-left"
            >
              <div className={`w-10 h-10 rounded-full ${color} flex items-center justify-center flex-shrink-0`}>
                <Icon size={18} />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-900">{label}</p>
                <p className="text-xs text-gray-500 mt-0.5">{sub}</p>
              </div>
              <ChevronRight size={16} className="text-gray-300" />
            </button>
          ))}
        </div>

      </div>
    </div>
  );
}
