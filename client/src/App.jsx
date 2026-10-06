import { useEffect } from "react";
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

import HomePage from "./pages/HomePage";
import IdentitiesPage from "./pages/IdentitiesPage";
import IdentityDetailPage from "./pages/IdentityDetailPage";
import SourcesPage from "./pages/SourcesPage";
import WorkflowsPage from "./pages/WorkflowsPage";
import WorkflowDetailPage from "./pages/WorkflowDetailPage";
import TransformsPage from "./pages/TransformsPage";
import TransformDetailPage from "./pages/TransformDetailPage";
import Base64Page from "./pages/tools/Base64Page";
import UrlEncodePage from "./pages/tools/UrlEncodePage";
import SourceDetailPage from "./pages/SourceDetailPage";
import SourceEditAccountsPage from "./pages/SourceEditAccountsPage";
import ConnectorRulePage from "./pages/ConnectorRulePage";
import ConnectorCustomizerPage from "./pages/ConnectorCustomizerPage";
import AccessProfilesPage from "./pages/AccessProfilesPage";
import AccessProfileDetailPage from "./pages/AccessProfileDetailPage";
import ApplicationsPage from "./pages/ApplicationsPage";
import ApplicationDetailPage from "./pages/ApplicationDetailPage";
import RolesPage from "./pages/RolesPage";
import RoleDetailPage from "./pages/RoleDetailPage";
import RequestsPage from "./pages/RequestsPage";
import ApprovalsPage, { ApprovalDetailPage } from "./pages/ApprovalsPage";
import TasksPage, { TaskDetailPage } from "./pages/TasksPage";
import CertificationCampaignsPage, { CampaignDetailPage } from "./pages/CertificationCampaignsPage";
import ProfilePage from "./pages/ProfilePage";
import ScanForRolesPage, { RoleScanDetailPage } from "./pages/roleMining/ScanForRolesPage";
import AttributeSyncPage, { AttributeSyncScanDetailPage } from "./pages/roleMining/AttributeSyncPage";
import SegmentsMiningPage, { SegmentScanDetailPage } from "./pages/roleMining/SegmentsMiningPage";
import AccessSegmentsMiningPage, { AccessSegmentScanDetailPage } from "./pages/roleMining/AccessSegmentsMiningPage";
import IscSegmentsPage, { IscSegmentDetailPage } from "./pages/IscSegmentsPage";
import OrgInfoPage from "./pages/OrgInfoPage";
import GovernanceGroupsPage, { GovernanceGroupDetailPage } from "./pages/GovernanceGroupsPage";
import ParametersPage, { ParameterDetailPage } from "./pages/ParametersPage";
import DistributionGroupsPage from "./pages/roleMining/DistributionGroupsPage";
import CertificationsPage, { CertificationRunDetailPage, CertificationCampaignDetailPage } from "./pages/roleMining/CertificationsPage";
import FormsPage from "./pages/FormsPage";
import LaunchersPage, { LauncherDetailPage } from "./pages/LaunchersPage";
import MetadataPage, { MetadataAttributeDetailPage, MetadataValueDetailPage } from "./pages/MetadataPage";
import SkeletonRolesPage, { SkeletonScanDetailPage } from "./pages/roleMining/SkeletonRolesPage";
import RoleEvaluationPage, { RoleEvalScanDetailPage } from "./pages/roleMining/RoleEvaluationPage";
import ScanningConfigPage from "./pages/studioSettings/ScanningConfigPage";
import EvaluationConfigPage from "./pages/studioSettings/EvaluationConfigPage";
import SchemaAnalysisPage from "./pages/studioSettings/SchemaAnalysisPage";
import PreferencesPage from "./pages/studioSettings/PreferencesPage";
import UserCertificationsPage from "./pages/studioSettings/UserCertificationsPage";
import OperationsPage from "./pages/tools/OperationsPage";
import BackupPage from "./pages/BackupPage";
import RestorePage from "./pages/RestorePage";
import BackupOfflineSourcesPage from "./pages/BackupOfflineSourcesPage";
import RestoreOfflineSourcePage from "./pages/RestoreOfflineSourcePage";
import EntitlementsPage from "./pages/EntitlementsPage";
import EntitlementDetailPage from "./pages/EntitlementDetailPage";
import SegmentsPage from "./pages/SegmentsPage";
import SegmentDetailPage from "./pages/SegmentDetailPage";
import SegmentRoleMatchPage from "./pages/SegmentRoleMatchPage";
import ReportsPage from "./pages/ReportsPage";
import { Spinner } from "./components/ui";

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
