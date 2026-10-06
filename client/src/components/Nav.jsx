import { useState } from "react";
import { Home, Users, UsersRound, Send, CheckSquare, ShieldCheck, Sparkles, Settings, Users2, LayoutGrid, Layers, Database, X, ClipboardCheck, ClipboardList, ChevronDown, Shapes, Bone, RefreshCw, Archive, Download, Upload, DatabaseBackup, DatabaseZap, BarChart3, Key, Tags, GitBranch, FunctionSquare, Wrench, Binary, Percent, Mail, BadgeCheck, Activity, Rocket, Split, Building2, KeyRound } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../hooks/useAuth";
import { useNavDrawer } from "../hooks/useNavDrawer";
import { getPendingApprovalsCount, getPendingWorkItemsCount, getSchemaAnalysis, getTenantUiMetadata } from "../lib/sailpoint";
import pkg from "../../package.json";
import { tenantUiHost } from "../lib/tenantHost";

const APP_VERSION = pkg.version;

// Black or white text on a given badge colour, by perceived brightness — the
// badge colour is whatever the tenant configured, so neither is safe to
// assume (ISC's own examples range from near-black navy to bright amber).
function readableOn(hex) {
  const h = String(hex || "").replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  if (full.length !== 6) return undefined;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
  // Rec. 601 luma.
  return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? "#111827" : "#ffffff";
}

const TABS = [
  { path: "/", label: "Home", Icon: Home },
  { path: "/identities", label: "Browse", Icon: LayoutGrid },
  { path: "/tools", label: "Tools", Icon: Wrench },
  { path: "/role-mining", label: "Mining", Icon: Sparkles },
  { path: "/backup-restore", label: "Backup & Restore", Icon: Archive },
  { path: "/studio-settings", label: "Studio Settings", Icon: Settings },
];

// Sidebar-only sub-links shown nested under the Role Mining tab. The
// /role-mining/roles route (same RolesPage as Browse's Roles link) still
// exists — reachable from Role Model Drafts/Role Evaluation, just no
// longer its own nav entry now that Browse's Roles link is the one place
// to reach it from the menu.
const ROLE_MINING_SUBLINKS = [
  { path: "/role-mining/scan-for-roles", label: "Role Model Drafts", Icon: Users2 },
  { path: "/role-mining/role-evaluation", label: "Role Evaluation", Icon: ClipboardCheck },
  { path: "/role-mining/skeleton-roles", label: "Skeleton Roles", Icon: Bone },
  { path: "/role-mining/attribute-sync", label: "Attribute Sync", Icon: RefreshCw },
  { path: "/role-mining/distribution-groups", label: "Mail Distribution Groups", Icon: Mail },
  { path: "/role-mining/certifications", label: "User Certifications", Icon: BadgeCheck },
];
// Only shown when a tenant has both the Multi-Company/Division Boundary
// AND its own "Create Data Segments" toggle on (see Schema Analysis) — same
// gate as Browse's Data Segments link, appended dynamically by
// useRoleMiningSublinks below, never part of the static list itself.
// Created segments get a metadata-FILTER Access Model (Boundary attribute)
// instead of an explicit selection. The /role-mining/segments route
// (explicit-selection Data Segments) still exists but has no nav entry.
const ROLE_MINING_SEGMENTS_BY_METADATA_SUBLINK = { path: "/role-mining/segments-by-metadata", label: "Data Segments", Icon: Tags };
// ISC Segments (access-request Segments — a different object from Data
// Segments). Always shown; its page explains the Boundary prerequisite when
// it isn't set up.
const ROLE_MINING_ACCESS_SEGMENTS_SUBLINK = { path: "/role-mining/access-segments", label: "Segments", Icon: Split };

// Sidebar-only sub-links shown nested under the Tools tab — Event Log
// first (reads the tenant's audit events and offers AI fix suggestions),
// then Requests, Approvals and Tasks (moved here from Browse; they keep
// their own top-level paths, see onTools), then Base64 and URL Encode,
// which run entirely client-side.
const TOOLS_SUBLINKS = [
  { path: "/tools/event-log", label: "Event Log", Icon: Activity },
  { path: "/requests", label: "Requests", Icon: Send },
  { path: "/approvals", label: "Approvals", Icon: CheckSquare },
  { path: "/tasks", label: "Tasks", Icon: ClipboardList },
  { path: "/tools/base64", label: "Base64", Icon: Binary },
  { path: "/tools/url-encode", label: "URL Encode", Icon: Percent },
];

// Sidebar-only sub-links shown nested under the Studio Settings tab.
const STUDIO_SETTINGS_SUBLINKS = [
  { path: "/studio-settings/scanning-config", label: "Mining Config", Icon: Settings },
  { path: "/studio-settings/schema-analysis", label: "Schema Analysis", Icon: BarChart3 },
  { path: "/studio-settings/evaluation-config", label: "Evaluation Config", Icon: Settings },
  { path: "/studio-settings/user-certifications", label: "User Certifications", Icon: BadgeCheck },
  { path: "/studio-settings/preferences", label: "Preferences", Icon: Settings },
];

// Sidebar-only sub-links shown nested under the Backup & Restore tab.
const BACKUP_RESTORE_SUBLINKS = [
  { path: "/backup-restore/backup", label: "Backup Configuration", Icon: Download },
  { path: "/backup-restore/restore", label: "Restore Configuration", Icon: Upload },
  { path: "/backup-restore/backup-offline-sources", label: "Backup Offline Sources", Icon: DatabaseBackup },
  { path: "/backup-restore/restore-offline-source", label: "Restore Offline Source", Icon: DatabaseZap },
];

// Sidebar-only sub-links shown nested under the Browse tab. Each has its own
// path prefix (unlike Role Mining's sub-links, which all share
// "/role-mining"), so the parent tab's active state can't be derived from
// isActive(path) alone — see onBrowse below.
const BROWSE_SUBLINKS = [
  { path: "/identities", label: "Identities", Icon: Users },
  { path: "/roles", label: "Roles", Icon: Layers },
  { path: "/entitlements", label: "Entitlements", Icon: Key },
  { path: "/access-profiles", label: "Access Profiles", Icon: ShieldCheck },
  { path: "/applications", label: "Applications", Icon: LayoutGrid },
  { path: "/sources", label: "Sources", Icon: Database },
  { path: "/workflows", label: "Workflows", Icon: GitBranch },
  { path: "/forms", label: "Forms", Icon: ClipboardList },
  { path: "/governance-groups", label: "Governance Groups", Icon: UsersRound },
  { path: "/launchers", label: "Launchers", Icon: Rocket },
  { path: "/transforms", label: "Transforms", Icon: FunctionSquare },
  { path: "/metadata", label: "Metadata", Icon: Tags },
  { path: "/certifications", label: "User Certifications", Icon: BadgeCheck },
  { path: "/parameters", label: "Parameter Storage", Icon: KeyRound },
  { path: "/org-info", label: "Org Info", Icon: Building2 },
];
// Only shown when a tenant has both the Multi-Company/Division Boundary
// AND its own "Create Data Segments" toggle on (see Schema Analysis) —
// appended to BROWSE_SUBLINKS dynamically by useBrowseSublinks below,
// never part of the static list itself.
const SEGMENTS_SUBLINK = { path: "/segments", label: "Data Segments", Icon: Shapes };
// ISC Segments (access-request Segments) — always shown, directly under
// Data Segments (or where Data Segments would be when it's hidden).
const ACCESS_SEGMENTS_SUBLINK = { path: "/access-segments", label: "Segments", Icon: Split };
const BROWSE_PATHS = [...BROWSE_SUBLINKS.map((s) => s.path), SEGMENTS_SUBLINK.path, ACCESS_SEGMENTS_SUBLINK.path];
export { BROWSE_SUBLINKS, ROLE_MINING_SUBLINKS, STUDIO_SETTINGS_SUBLINKS, BACKUP_RESTORE_SUBLINKS, TOOLS_SUBLINKS };

// Shared by the sidebar/drawer nav and BrowseTitleMenu so the two can never
// show a different set of Browse links from each other.
export function useBrowseSublinks() {
  const { data } = useQuery({ queryKey: ["schema-analysis"], queryFn: getSchemaAnalysis });
  // Alphabetical by label — including the conditional Data Segments entry,
  // so the order stays right whether or not it's shown.
  return [
    ...BROWSE_SUBLINKS,
    ...(data?.createDataSegments ? [SEGMENTS_SUBLINK] : []),
    ACCESS_SEGMENTS_SUBLINK,
  ].sort((a, b) => a.label.localeCompare(b.label));
}

// Shared by the sidebar/drawer nav and RoleMiningTitleMenu so the two can
// never show a different set of Role Mining links from each other — same
// gating pattern as useBrowseSublinks above.
export function useRoleMiningSublinks() {
  const { data } = useQuery({ queryKey: ["schema-analysis"], queryFn: getSchemaAnalysis });
  // Alphabetical by label, including the conditional Data Segments entry.
  return [
    ...ROLE_MINING_SUBLINKS,
    ...(data?.createDataSegments ? [ROLE_MINING_SEGMENTS_BY_METADATA_SUBLINK] : []),
    ROLE_MINING_ACCESS_SEGMENTS_SUBLINK,
  ].sort((a, b) => a.label.localeCompare(b.label));
}

function useActiveTab() {
  const location = useLocation();
  return (path) =>
    path === "/" ? location.pathname === "/" : location.pathname.startsWith(path);
}

// A plain startsWith let a sibling sub-link with a longer, prefix-sharing
// path (e.g. "/backup-restore/restore-offline-source") also match its
// shorter sibling ("/backup-restore/restore"), highlighting both in the
// sidebar at once. Active now means an exact match, or a path nested one
// level deeper under it (subPath + "/...").
function isSubLinkActive(pathname, subPath) {
  return pathname === subPath || pathname.startsWith(`${subPath}/`);
}

// The actual nav — tenant box, tabs, and their nested sub-links. Shared
// between the desktop sidebar (always visible) and the mobile hamburger
// drawer (shown on demand), so the two can never drift apart. `onNavigate`
// fires after every navigation — the sidebar leaves it a no-op, the drawer
// uses it to close itself.
function NavContent({ onNavigate = () => {} }) {
  const navigate = useNavigate();
  const location = useLocation();
  const isActive = useActiveTab();
  const browseSublinks = useBrowseSublinks();
  const roleMiningSublinks = useRoleMiningSublinks();
  const onRoleMining = location.pathname.startsWith("/role-mining");
  const onStudio = location.pathname.startsWith("/studio-settings");
  const onBackupRestore = location.pathname.startsWith("/backup-restore");
  const onTools = location.pathname.startsWith("/tools") || TOOLS_SUBLINKS.some((s) => isSubLinkActive(location.pathname, s.path));
  const onBrowse = BROWSE_PATHS.some((p) => location.pathname.startsWith(p));
  const { session } = useAuth();

  // Browse, Role Mining, and Studio Settings are section headers with
  // sub-links, not destinations of their own — clicking one just reveals
  // its sub-menu instead of navigating anywhere. Being on a route under
  // that section already implies it's expanded (via onBrowse/onRoleMining/
  // onStudio below); this only tracks a manual toggle for when you're
  // elsewhere and want to peek at a section's links before picking one.
  const [expandedTab, setExpandedTab] = useState(null); // "browse" | "roleMining" | "studio" | "backupRestore" | null
  const browseExpanded = onBrowse || expandedTab === "browse";
  const roleMiningExpanded = onRoleMining || expandedTab === "roleMining";
  const studioExpanded = onStudio || expandedTab === "studio";
  const backupRestoreExpanded = onBackupRestore || expandedTab === "backupRestore";
  const toolsExpanded = onTools || expandedTab === "tools";

  // A quiet flag on the Approvals link — no need to open the tab to know
  // there's something waiting.
  const pendingApprovals = useQuery({
    queryKey: ["pending-approvals-count"],
    queryFn: getPendingApprovalsCount,
    enabled: !!session,
  });
  const hasPending = typeof pendingApprovals.data === "number" && pendingApprovals.data > 0;

  // ORG_ADMIN-only and experimental, so a plain user just gets { badge: null }
  // and the box falls back to the registered site name.
  const uiMetadata = useQuery({
    queryKey: ["tenant-ui-metadata"],
    queryFn: getTenantUiMetadata,
    enabled: !!session?.tenant,
    staleTime: 10 * 60 * 1000,
  });
  const badge = uiMetadata.data?.badge || null;

  const pendingTasks = useQuery({
    queryKey: ["pending-work-items-count"],
    queryFn: getPendingWorkItemsCount,
    enabled: !!session,
  });
  const hasPendingTasks = typeof pendingTasks.data === "number" && pendingTasks.data > 0;

  // ISC only honours admin authorities on a strongly authenticated token, so
  // this is the difference between the app working and 403ing everywhere.
  // Green = strong auth, red = not (and admin calls will be refused).
  const strongAuth = session?.strongAuth;
  // Amber sits between the two: the session isn't strongly authenticated, but
  // calls still work because they run on the tenant's service credential —
  // with its permissions, not yours. Worth showing distinctly from green.
  const elevated = session?.elevated;
  const authStyle =
    strongAuth === true
      ? { box: "bg-green-100 border-green-200", icon: "text-green-700", text: "text-green-800" }
      : elevated
      ? { box: "bg-amber-100 border-amber-200", icon: "text-amber-600", text: "text-amber-900" }
      : strongAuth === false
      ? { box: "bg-red-100 border-red-200", icon: "text-red-700", text: "text-red-800" }
      : { box: "border-transparent", icon: "text-blue-600", text: "text-gray-900" };

  function go(path) {
    navigate(path);
    onNavigate();
  }

  return (
    <div className="flex flex-col h-full">
      <button
        type="button"
        onClick={() => {
          // The tenant's ISC console lives at the same host as the API minus
          // the "api" subdomain segment — e.g. tenant.api.identitynow-demo.com
          // becomes tenant.identitynow-demo.com.
          if (session?.tenant) {
            window.open(`https://${tenantUiHost(session.tenant)}`, "_blank", "noopener,noreferrer");
          }
        }}
        disabled={!session?.tenant}
        className={`flex items-center gap-2 px-3 py-2 mb-8 rounded-xl border text-left disabled:cursor-default ${authStyle.box}`}
        title={
          session?.tenant
            ? `Open ${session.tenant} in SailPoint ISC` +
              (strongAuth === true
                ? " — strong authentication active, running with your own permissions"
                : elevated
                ? " — not strongly authenticated; API calls run on this tenant's service credential, not your own permissions"
                : strongAuth === false
                ? " — not strongly authenticated; SailPoint will refuse admin API calls (403)"
                : "")
            : undefined
        }
      >
        <ShieldCheck size={22} className={authStyle.icon} />
        <span className="flex flex-col min-w-0">
          <span className={`font-semibold leading-tight ${authStyle.text}`}>Admin Studio</span>
          {/* The tenant's own instance badge (Sandbox / Production / ...) when
              it has one and it's set visible, in the colour ISC was given;
              otherwise the name this tenant was registered under, falling
              back to the tenant host if it was registered without one. */}
          {badge ? (
            <span
              className="text-xs leading-tight truncate font-medium px-1.5 py-0.5 rounded mt-0.5 self-start max-w-full"
              style={badge.color
                ? { backgroundColor: badge.color, color: readableOn(badge.color) }
                : undefined}
              title={`Instance badge — ${badge.name}`}
            >
              {badge.name}
            </span>
          ) : (
            (session?.siteName || session?.tenant) && (
              <span className={`text-xs leading-tight truncate opacity-70 ${authStyle.text}`}>
                {session.siteName || session.tenant}
              </span>
            )
          )}
        </span>
      </button>
      <nav className="flex-1 flex flex-col gap-1">
        {TABS.map(({ path, label, Icon }) => {
          // Browse's sub-links live under different path prefixes than its
          // own nav target ("/identities"), so its active state has to come
          // from onBrowse rather than the plain prefix check every other tab uses.
          const isBrowseTab = path === "/identities";
          const isRoleMiningTab = path === "/role-mining";
          const isStudioTab = path === "/studio-settings";
          const isBackupRestoreTab = path === "/backup-restore";
          const isToolsTab = path === "/tools";
          const hasSubmenu = isBrowseTab || isRoleMiningTab || isStudioTab || isBackupRestoreTab || isToolsTab;
          const active = isBrowseTab
            ? onBrowse
            : isRoleMiningTab
            ? onRoleMining
            : isStudioTab
            ? onStudio
            : isBackupRestoreTab
            ? onBackupRestore
            : isToolsTab
            ? onTools
            : isActive(path);
          const expandKey = isBrowseTab ? "browse" : isRoleMiningTab ? "roleMining" : isStudioTab ? "studio" : isToolsTab ? "tools" : "backupRestore";
          return (
            <div key={path}>
              <button
                onClick={() => {
                  if (hasSubmenu) {
                    setExpandedTab((prev) => (prev === expandKey ? null : expandKey));
                  } else {
                    go(path);
                  }
                }}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors ${
                  active ? "bg-blue-50 text-blue-600" : "text-gray-500 hover:bg-gray-50 hover:text-gray-700"
                }`}
              >
                <Icon size={20} strokeWidth={active ? 2.5 : 1.8} />
                <span className="flex-1 text-left">{label}</span>
                {isToolsTab && (hasPending || hasPendingTasks) && (
                  <span
                    className="w-2 h-2 rounded-full bg-amber-500 flex-shrink-0"
                    title="Pending approvals or tasks"
                  />
                )}
                {hasSubmenu && (
                  <ChevronDown
                    size={14}
                    className={`flex-shrink-0 transition-transform ${
                      (isBrowseTab
                        ? browseExpanded
                        : isRoleMiningTab
                        ? roleMiningExpanded
                        : isStudioTab
                        ? studioExpanded
                        : isToolsTab
                        ? toolsExpanded
                        : backupRestoreExpanded)
                        ? "rotate-180"
                        : ""
                    }`}
                  />
                )}
              </button>
              {isRoleMiningTab && roleMiningExpanded && (
                <div className="flex flex-col gap-0.5 mt-0.5 ml-4 pl-3 border-l border-gray-100">
                  {roleMiningSublinks.map(({ path: subPath, label: subLabel, Icon: SubIcon }) => {
                    const subActive = isSubLinkActive(location.pathname, subPath);
                    return (
                      <button
                        key={subPath}
                        onClick={() => go(subPath)}
                        className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium transition-colors text-left ${
                          subActive ? "text-blue-600 bg-blue-50" : "text-gray-500 hover:bg-gray-50 hover:text-gray-700"
                        }`}
                      >
                        <SubIcon size={14} strokeWidth={1.8} />
                        {subLabel}
                      </button>
                    );
                  })}
                </div>
              )}
              {isToolsTab && toolsExpanded && (
                <div className="flex flex-col gap-0.5 mt-0.5 ml-4 pl-3 border-l border-gray-100">
                  {TOOLS_SUBLINKS.map(({ path: subPath, label: subLabel, Icon: SubIcon }) => {
                    const subActive = isSubLinkActive(location.pathname, subPath);
                    return (
                      <button
                        key={subPath}
                        onClick={() => go(subPath)}
                        className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium transition-colors text-left ${
                          subActive ? "text-blue-600 bg-blue-50" : "text-gray-500 hover:bg-gray-50 hover:text-gray-700"
                        }`}
                      >
                        <SubIcon size={14} strokeWidth={1.8} />
                        <span className="flex-1">{subLabel}</span>
                        {subPath === "/approvals" && hasPending && (
                          <span
                            className="w-1.5 h-1.5 rounded-full bg-green-500 flex-shrink-0"
                            title={`${pendingApprovals.data} pending approval${pendingApprovals.data === 1 ? "" : "s"}`}
                          />
                        )}
                        {subPath === "/tasks" && hasPendingTasks && (
                          <span
                            className="w-1.5 h-1.5 rounded-full bg-amber-500 flex-shrink-0"
                            title={`${pendingTasks.data} pending task${pendingTasks.data === 1 ? "" : "s"}`}
                          />
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
              {isStudioTab && studioExpanded && (
                <div className="flex flex-col gap-0.5 mt-0.5 ml-4 pl-3 border-l border-gray-100">
                  {STUDIO_SETTINGS_SUBLINKS.map(({ path: subPath, label: subLabel, Icon: SubIcon }) => {
                    const subActive = isSubLinkActive(location.pathname, subPath);
                    return (
                      <button
                        key={subPath}
                        onClick={() => go(subPath)}
                        className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium transition-colors text-left ${
                          subActive ? "text-blue-600 bg-blue-50" : "text-gray-500 hover:bg-gray-50 hover:text-gray-700"
                        }`}
                      >
                        <SubIcon size={14} strokeWidth={1.8} />
                        {subLabel}
                      </button>
                    );
                  })}
                </div>
              )}
              {isBackupRestoreTab && backupRestoreExpanded && (
                <div className="flex flex-col gap-0.5 mt-0.5 ml-4 pl-3 border-l border-gray-100">
                  {BACKUP_RESTORE_SUBLINKS.map(({ path: subPath, label: subLabel, Icon: SubIcon }) => {
                    const subActive = isSubLinkActive(location.pathname, subPath);
                    return (
                      <button
                        key={subPath}
                        onClick={() => go(subPath)}
                        className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium transition-colors text-left ${
                          subActive ? "text-blue-600 bg-blue-50" : "text-gray-500 hover:bg-gray-50 hover:text-gray-700"
                        }`}
                      >
                        <SubIcon size={14} strokeWidth={1.8} />
                        {subLabel}
                      </button>
                    );
                  })}
                </div>
              )}
              {isBrowseTab && browseExpanded && (
                <div className="flex flex-col gap-0.5 mt-0.5 ml-4 pl-3 border-l border-gray-100">
                  {browseSublinks.map(({ path: subPath, label: subLabel, Icon: SubIcon }) => {
                    const subActive = isSubLinkActive(location.pathname, subPath);
                    return (
                      <button
                        key={subPath}
                        onClick={() => go(subPath)}
                        className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium transition-colors text-left ${
                          subActive ? "text-blue-600 bg-blue-50" : "text-gray-500 hover:bg-gray-50 hover:text-gray-700"
                        }`}
                      >
                        <SubIcon size={14} strokeWidth={1.8} />
                        <span className="flex-1">{subLabel}</span>
                        {subPath === "/approvals" && hasPending && (
                          <span
                            className="w-1.5 h-1.5 rounded-full bg-green-500 flex-shrink-0"
                            title={`${pendingApprovals.data} pending approval${pendingApprovals.data === 1 ? "" : "s"}`}
                          />
                        )}
                        {subPath === "/tasks" && hasPendingTasks && (
                          <span
                            className="w-1.5 h-1.5 rounded-full bg-amber-500 flex-shrink-0"
                            title={`${pendingTasks.data} pending task${pendingTasks.data === 1 ? "" : "s"}`}
                          />
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </nav>
      <p className="text-center text-[11px] text-gray-500 mt-4">v{APP_VERSION}</p>
    </div>
  );
}

// Left sidebar nav — desktop / wide viewports.
export function SideNav() {
  return (
    <div className="hidden md:flex md:flex-col w-56 flex-shrink-0 bg-white border-r border-gray-200 min-h-screen px-3 py-6">
      <NavContent />
    </div>
  );
}

// Hamburger-triggered nav drawer — mobile / narrow viewports. Shows the same
// NavContent as the sidebar, as a slide-over panel with a backdrop.
export function MobileNavDrawer() {
  const { open, setOpen } = useNavDrawer();
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 md:hidden">
      <div className="absolute inset-0 bg-black/30" onClick={() => setOpen(false)} />
      <div
        className="absolute left-0 top-0 bottom-0 w-72 max-w-[85vw] bg-white shadow-xl overflow-y-auto px-3 pb-6"
        style={{ paddingTop: "max(1.5rem, env(safe-area-inset-top))" }}
      >
        <button
          onClick={() => setOpen(false)}
          className="absolute right-3 top-3 text-gray-400 hover:text-gray-600"
          style={{ top: "max(0.75rem, env(safe-area-inset-top))" }}
          aria-label="Close menu"
        >
          <X size={22} />
        </button>
        <NavContent onNavigate={() => setOpen(false)} />
      </div>
    </div>
  );
}
