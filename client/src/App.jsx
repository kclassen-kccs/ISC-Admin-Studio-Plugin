import { lazy, Suspense, useEffect } from "react";
import { reportRoute } from "./lib/pluginSdk";
import { HashRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Toaster } from "react-hot-toast";
import { AuthProvider, useAuth } from "./hooks/useAuth";
import { ThemeProvider, useTheme } from "./hooks/useTheme";
import { useBrandColors } from "./hooks/useBrandColors";
import { setJsonEditMode } from "./lib/jsonEditMode";
import { NavDrawerProvider } from "./hooks/useNavDrawer";
import { SideNav, MobileNavDrawer } from "./components/Nav";
import { RouteErrorBoundary } from "./components/ErrorBoundary";
import { getUserPreferences } from "./lib/sailpoint";
import { Spinner } from "./components/ui";

import HomePage from "./pages/HomePage";
// Pages load on demand so each feature area (Browsing, Role Mining, Studio
// Settings, Tools) and its heavy deps (jsPDF, JSZip) stay out of the first load.
const page = (load, name = "default") => lazy(() => load().then((m) => ({ default: m[name] })));
const IdentitiesPage = page(() => import("./pages/IdentitiesPage"));
const IdentityDetailPage = page(() => import("./pages/IdentityDetailPage"));
const SourcesPage = page(() => import("./pages/SourcesPage"));
const WorkflowsPage = page(() => import("./pages/WorkflowsPage"));
const WorkflowDetailPage = page(() => import("./pages/WorkflowDetailPage"));
const TransformsPage = page(() => import("./pages/TransformsPage"));
const TransformDetailPage = page(() => import("./pages/TransformDetailPage"));
const Base64Page = page(() => import("./pages/tools/Base64Page"));
const UrlEncodePage = page(() => import("./pages/tools/UrlEncodePage"));
const SourceDetailPage = page(() => import("./pages/SourceDetailPage"));
const SourceEditAccountsPage = page(() => import("./pages/SourceEditAccountsPage"));
const ConnectorRulePage = page(() => import("./pages/ConnectorRulePage"));
const ConnectorCustomizerPage = page(() => import("./pages/ConnectorCustomizerPage"));
const AccessProfilesPage = page(() => import("./pages/AccessProfilesPage"));
const AccessProfileDetailPage = page(() => import("./pages/AccessProfileDetailPage"));
const ApplicationsPage = page(() => import("./pages/ApplicationsPage"));
const ApplicationDetailPage = page(() => import("./pages/ApplicationDetailPage"));
const RolesPage = page(() => import("./pages/RolesPage"));
const RoleDetailPage = page(() => import("./pages/RoleDetailPage"));
const RequestsPage = page(() => import("./pages/RequestsPage"));
const ApprovalsPage = page(() => import("./pages/ApprovalsPage"));
const ApprovalDetailPage = page(() => import("./pages/ApprovalsPage"), "ApprovalDetailPage");
const TasksPage = page(() => import("./pages/TasksPage"));
const TaskDetailPage = page(() => import("./pages/TasksPage"), "TaskDetailPage");
const CertificationCampaignsPage = page(() => import("./pages/CertificationCampaignsPage"));
const CampaignDetailPage = page(() => import("./pages/CertificationCampaignsPage"), "CampaignDetailPage");
const ProfilePage = page(() => import("./pages/ProfilePage"));
const ScanForRolesPage = page(() => import("./pages/roleMining/ScanForRolesPage"));
const RoleScanDetailPage = page(() => import("./pages/roleMining/ScanForRolesPage"), "RoleScanDetailPage");
const AttributeSyncPage = page(() => import("./pages/roleMining/AttributeSyncPage"));
const AttributeSyncScanDetailPage = page(() => import("./pages/roleMining/AttributeSyncPage"), "AttributeSyncScanDetailPage");
const SegmentsMiningPage = page(() => import("./pages/roleMining/SegmentsMiningPage"));
const SegmentScanDetailPage = page(() => import("./pages/roleMining/SegmentsMiningPage"), "SegmentScanDetailPage");
const AccessSegmentsMiningPage = page(() => import("./pages/roleMining/AccessSegmentsMiningPage"));
const AccessSegmentScanDetailPage = page(() => import("./pages/roleMining/AccessSegmentsMiningPage"), "AccessSegmentScanDetailPage");
const IscSegmentsPage = page(() => import("./pages/IscSegmentsPage"));
const IscSegmentDetailPage = page(() => import("./pages/IscSegmentsPage"), "IscSegmentDetailPage");
const OrgInfoPage = page(() => import("./pages/OrgInfoPage"));
const GovernanceGroupsPage = page(() => import("./pages/GovernanceGroupsPage"));
const GovernanceGroupDetailPage = page(() => import("./pages/GovernanceGroupsPage"), "GovernanceGroupDetailPage");
const ParametersPage = page(() => import("./pages/ParametersPage"));
const ParameterDetailPage = page(() => import("./pages/ParametersPage"), "ParameterDetailPage");
const DistributionGroupsPage = page(() => import("./pages/roleMining/DistributionGroupsPage"));
const CertificationsPage = page(() => import("./pages/roleMining/CertificationsPage"));
const CertificationRunDetailPage = page(() => import("./pages/roleMining/CertificationsPage"), "CertificationRunDetailPage");
const CertificationCampaignDetailPage = page(() => import("./pages/roleMining/CertificationsPage"), "CertificationCampaignDetailPage");
const FormsPage = page(() => import("./pages/FormsPage"));
const LaunchersPage = page(() => import("./pages/LaunchersPage"));
const LauncherDetailPage = page(() => import("./pages/LaunchersPage"), "LauncherDetailPage");
const MetadataPage = page(() => import("./pages/MetadataPage"));
const MetadataAttributeDetailPage = page(() => import("./pages/MetadataPage"), "MetadataAttributeDetailPage");
const MetadataValueDetailPage = page(() => import("./pages/MetadataPage"), "MetadataValueDetailPage");
const SkeletonRolesPage = page(() => import("./pages/roleMining/SkeletonRolesPage"));
const SkeletonScanDetailPage = page(() => import("./pages/roleMining/SkeletonRolesPage"), "SkeletonScanDetailPage");
const RoleEvaluationPage = page(() => import("./pages/roleMining/RoleEvaluationPage"));
const RoleEvalScanDetailPage = page(() => import("./pages/roleMining/RoleEvaluationPage"), "RoleEvalScanDetailPage");
const ScanningConfigPage = page(() => import("./pages/studioSettings/ScanningConfigPage"));
const EvaluationConfigPage = page(() => import("./pages/studioSettings/EvaluationConfigPage"));
const SchemaAnalysisPage = page(() => import("./pages/studioSettings/SchemaAnalysisPage"));
const PreferencesPage = page(() => import("./pages/studioSettings/PreferencesPage"));
const UserCertificationsPage = page(() => import("./pages/studioSettings/UserCertificationsPage"));
const OperationsPage = page(() => import("./pages/tools/OperationsPage"));
const BackupPage = page(() => import("./pages/BackupPage"));
const RestorePage = page(() => import("./pages/RestorePage"));
const BackupOfflineSourcesPage = page(() => import("./pages/BackupOfflineSourcesPage"));
const RestoreOfflineSourcePage = page(() => import("./pages/RestoreOfflineSourcePage"));
const EntitlementsPage = page(() => import("./pages/EntitlementsPage"));
const EntitlementDetailPage = page(() => import("./pages/EntitlementDetailPage"));
const SegmentsPage = page(() => import("./pages/SegmentsPage"));
const SegmentDetailPage = page(() => import("./pages/SegmentDetailPage"));
const SegmentRoleMatchPage = page(() => import("./pages/SegmentRoleMatchPage"));
const ReportsPage = page(() => import("./pages/ReportsPage"));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
});

// Applies this signed-in user's own server-persisted dark-mode preference
// once a session exists — localStorage (see useTheme) already painted
// something instantly on load, this just reconciles it with the per-user
// value that follows them across devices, in case the two disagree (e.g.
// first time on a new browser, or another device changed it since).
function UserPreferencesSync() {
  const { session } = useAuth();
  const { mode, setMode } = useTheme();
  const { data } = useQuery({
    queryKey: ["user-preferences"],
    queryFn: getUserPreferences,
    enabled: !!session,
    staleTime: Infinity,
  });

  useEffect(() => {
    if (!data) return;
    // themeMode is what follows the user across devices; older records
    // without one are migrated server-side.
    const serverMode = data.themeMode || (data.darkMode ? "dark" : "system");
    if (serverMode !== mode) setMode(serverMode);
    // Mirror the JSON editor preference locally so editors can read it as
    // they mount (see lib/jsonEditMode).
    if (data.jsonEditMode) setJsonEditMode(data.jsonEditMode);
    // Only ever react to a fresh fetch of the server's value, not to `mode`
    // itself changing (that would fight the user's own choice).
  }, [data]);

  return null;
}

// Mirrors the plugin's internal route into the ISC page URL so the browser
// address bar (and a reload or shared link) lands back on the same screen.
function useReportRoute() {
  const location = useLocation();
  useEffect(() => {
    reportRoute(`${location.pathname}${location.search}`.replace(/^\//, ""));
  }, [location.pathname, location.search]);
}

function AppRoutes() {
  const { session, restoring, error } = useAuth();
  const location = useLocation();
  useReportRoute();
  // Paints the app in this tenant's ISC branding colours (no-op when the
  // tenant has none).
  useBrandColors();

  if (restoring) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <Spinner size={24} />
      </div>
    );
  }

  // No session means the App Shell handshake failed — typically the bundle was
  // opened directly instead of from within Identity Security Cloud.
  if (!session) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 p-6 text-center">
        <div className="max-w-sm">
          <h1 className="text-lg font-semibold text-gray-900 mb-2">Admin Studio</h1>
          <p className="text-sm text-gray-600">
            {error || "Could not connect to Identity Security Cloud."} Open Admin Studio from within your ISC tenant.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex md:bg-gray-100">
      <SideNav />
      <MobileNavDrawer />
      <div className="flex-1 flex justify-center">
        <div
          className="w-full max-w-md md:max-w-3xl lg:max-w-5xl xl:max-w-6xl 2xl:max-w-7xl min-h-screen flex flex-col bg-white shadow-sm"
          style={{ paddingLeft: "env(safe-area-inset-left)", paddingRight: "env(safe-area-inset-right)" }}
        >
          <RouteErrorBoundary key={location.pathname}>
          <Suspense fallback={<div className="flex-1 flex items-center justify-center p-10"><Spinner size={24} /></div>}>
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/identities" element={<IdentitiesPage />} />
            <Route path="/identities/:id" element={<IdentityDetailPage />} />
            <Route path="/sources" element={<SourcesPage />} />
            <Route path="/sources/:id" element={<SourceDetailPage />} />
            <Route path="/sources/:id/edit-accounts" element={<SourceEditAccountsPage />} />
            <Route path="/sources/:id/rules/:ruleId" element={<ConnectorRulePage />} />
            <Route path="/sources/:id/customizers/:customizerId" element={<ConnectorCustomizerPage />} />
            <Route path="/workflows" element={<WorkflowsPage />} />
            <Route path="/forms" element={<FormsPage />} />
            <Route path="/launchers" element={<LaunchersPage />} />
            <Route path="/launchers/:id" element={<LauncherDetailPage />} />
            <Route path="/metadata" element={<MetadataPage />} />
            <Route path="/metadata/:key" element={<MetadataAttributeDetailPage />} />
            <Route path="/metadata/:key/values/:value" element={<MetadataValueDetailPage />} />
            <Route path="/workflows/:id" element={<WorkflowDetailPage />} />
            <Route path="/transforms" element={<TransformsPage />} />
            <Route path="/transforms/:id" element={<TransformDetailPage />} />
            <Route path="/tools" element={<Navigate to="/tools/event-log" replace />} />
            <Route path="/tools/base64" element={<Base64Page />} />
            <Route path="/tools/url-encode" element={<UrlEncodePage />} />
            <Route path="/tools/event-log" element={<OperationsPage />} />
            <Route path="/tools/operations" element={<Navigate to="/tools/event-log" replace />} />
            <Route path="/access-profiles" element={<AccessProfilesPage />} />
            <Route path="/access-profiles/:id" element={<AccessProfileDetailPage />} />
            <Route path="/applications" element={<ApplicationsPage />} />
            <Route path="/applications/:id" element={<ApplicationDetailPage />} />
            <Route path="/roles" element={<RolesPage />} />
            <Route path="/roles/:id" element={<RoleDetailPage />} />
            <Route path="/segments" element={<SegmentsPage />} />
            <Route path="/segments/role-matches/:id" element={<SegmentRoleMatchPage />} />
            <Route path="/segments/:id" element={<SegmentDetailPage />} />
            <Route path="/access-segments" element={<IscSegmentsPage />} />
            <Route path="/access-segments/:id" element={<IscSegmentDetailPage />} />
            <Route path="/requests" element={<RequestsPage />} />
            <Route path="/requests/new" element={<RequestsPage />} />
            <Route path="/approvals" element={<ApprovalsPage />} />
            <Route path="/approvals/:id" element={<ApprovalDetailPage />} />
            <Route path="/tasks" element={<TasksPage />} />
            <Route path="/parameters" element={<ParametersPage />} />
            <Route path="/parameters/:id" element={<ParameterDetailPage />} />
            <Route path="/org-info" element={<OrgInfoPage />} />
            <Route path="/governance-groups" element={<GovernanceGroupsPage />} />
            <Route path="/governance-groups/:id" element={<GovernanceGroupDetailPage />} />
            <Route path="/tasks/:id" element={<TaskDetailPage />} />
            <Route path="/certifications" element={<CertificationCampaignsPage />} />
            <Route path="/certifications/:id" element={<CampaignDetailPage />} />
            <Route path="/role-mining" element={<Navigate to="/role-mining/roles" replace />} />
            <Route path="/role-mining/roles" element={<RolesPage />} />
            <Route path="/role-mining/roles/:id" element={<RoleDetailPage />} />
            <Route path="/role-mining/scan-for-roles" element={<ScanForRolesPage />} />
            <Route path="/role-mining/role-scans/:id" element={<RoleScanDetailPage />} />
            <Route path="/role-mining/role-evaluation" element={<RoleEvaluationPage />} />
            <Route path="/role-mining/skeleton-roles" element={<SkeletonRolesPage />} />
            <Route path="/role-mining/skeleton-scans/:id" element={<SkeletonScanDetailPage />} />
            <Route path="/role-mining/role-eval-scans/:id" element={<RoleEvalScanDetailPage />} />
            <Route path="/role-mining/attribute-sync" element={<AttributeSyncPage />} />
            <Route path="/role-mining/attribute-sync-scans/:id" element={<AttributeSyncScanDetailPage />} />
            <Route path="/role-mining/segments" element={<SegmentsMiningPage />} />
            <Route path="/role-mining/segments/scans/:id" element={<SegmentScanDetailPage />} />
            <Route path="/role-mining/distribution-groups" element={<DistributionGroupsPage />} />
            <Route path="/role-mining/certifications" element={<CertificationsPage />} />
            <Route path="/role-mining/certification-runs/:id" element={<CertificationRunDetailPage />} />
            <Route path="/role-mining/certification-runs/:id/campaigns/:index" element={<CertificationCampaignDetailPage />} />
            <Route path="/role-mining/segments-by-metadata" element={<SegmentsMiningPage mode="metadata" />} />
            <Route path="/role-mining/segments-by-metadata/scans/:id" element={<SegmentScanDetailPage />} />
            <Route path="/role-mining/access-segments" element={<AccessSegmentsMiningPage />} />
            <Route path="/role-mining/access-segments/scans/:id" element={<AccessSegmentScanDetailPage />} />
            <Route path="/studio-settings" element={<Navigate to="/studio-settings/scanning-config" replace />} />
            <Route path="/studio-settings/scanning-config" element={<ScanningConfigPage />} />
            <Route path="/studio-settings/evaluation-config" element={<EvaluationConfigPage />} />
            <Route path="/studio-settings/schema-analysis" element={<SchemaAnalysisPage />} />
            <Route path="/studio-settings/preferences" element={<PreferencesPage />} />
            <Route path="/studio-settings/user-certifications" element={<UserCertificationsPage />} />
            <Route path="/backup-restore" element={<Navigate to="/backup-restore/backup" replace />} />
            <Route path="/backup-restore/backup" element={<BackupPage />} />
            <Route path="/backup-restore/restore" element={<RestorePage />} />
            <Route path="/backup-restore/backup-offline-sources" element={<BackupOfflineSourcesPage />} />
            <Route path="/backup-restore/restore-offline-source" element={<RestoreOfflineSourcePage />} />
            {/* Old /insights/* URLs, kept as redirects so any saved/shared links still work. */}
            <Route path="/insights" element={<Navigate to="/role-mining/roles" replace />} />
            <Route path="/insights/roles" element={<Navigate to="/role-mining/roles" replace />} />
            <Route path="/insights/roles/:id" element={<Navigate to="/role-mining/roles" replace />} />
            <Route path="/insights/role-insights" element={<Navigate to="/role-mining/scan-for-roles" replace />} />
            <Route path="/insights/role-evaluation" element={<Navigate to="/role-mining/role-evaluation" replace />} />
            <Route path="/insights/apply" element={<Navigate to="/role-mining/roles" replace />} />
            <Route path="/insights/configuration" element={<Navigate to="/studio-settings/scanning-config" replace />} />
            <Route path="/insights/configuration/role-scanning" element={<Navigate to="/studio-settings/scanning-config" replace />} />
            <Route path="/insights/configuration/role-evaluation" element={<Navigate to="/studio-settings/evaluation-config" replace />} />
            <Route path="/insights/configuration/schema-analysis" element={<Navigate to="/studio-settings/schema-analysis" replace />} />
            <Route path="/reports" element={<ReportsPage />} />
            <Route path="/entitlements" element={<EntitlementsPage />} />
            <Route path="/entitlements/:id" element={<EntitlementDetailPage />} />
            <Route path="/profile" element={<ProfilePage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
          </Suspense>
          </RouteErrorBoundary>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <AuthProvider>
          <HashRouter>
            <UserPreferencesSync />
            <NavDrawerProvider>
              <AppRoutes />
            </NavDrawerProvider>
            <Toaster
              position="top-center"
              containerStyle={{ top: "max(1rem, env(safe-area-inset-top))" }}
              toastOptions={{
                style: {
                  background: "#1f2937",
                  color: "#f9fafb",
                  fontSize: "14px",
                  borderRadius: "12px",
                  padding: "10px 16px",
                },
                success: { iconTheme: { primary: "#10b981", secondary: "#f9fafb" } },
                error: { iconTheme: { primary: "#ef4444", secondary: "#f9fafb" } },
              }}
            />
          </HashRouter>
        </AuthProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
