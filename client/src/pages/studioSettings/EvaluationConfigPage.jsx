import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Settings, PlayCircle, ListChecks, Trash2, X, Clock3 } from "lucide-react";
import toast from "react-hot-toast";
import {
  getTenantSettings, setTenantSettings, getStudioPreferences, setStudioPreferences, runRoleStatsRefreshNow,
  listTenantSodMitigations, updateSodMitigation, deleteSodMitigation,
} from "../../lib/sailpoint";
import { TopBar } from "../../components/TopBar";
import { StudioSettingsTitleMenu } from "../../components/StudioSettingsTitleMenu";
import { Spinner, SectionLabel, Field, Input, Select, PrimaryButton, OutlineButton, IconButton, EmptyState } from "../../components/ui";

const FREQUENCIES = [
  { value: "HOURLY", label: "Hourly" },
  { value: "DAILY", label: "Daily" },
  { value: "WEEKLY", label: "Weekly" },
];

// One mitigation, two lines — role name on top, policy name (plus location)
// smaller and lighter underneath. Purely a summary row; editing/deleting
// happens in MitigationDetailModal, opened by clicking the row.
function MitigationListItem({ mitigation, onClick }) {
  return (
    <button
      onClick={onClick}
      className="w-full text-left border border-gray-100 rounded-xl px-3 py-3 hover:bg-gray-50 transition-colors"
    >
      <p className="text-sm font-medium text-gray-900 truncate">{mitigation.roleName || mitigation.roleId}</p>
      <p className="text-xs text-gray-500 mt-0.5 truncate">
        {mitigation.policyName || mitigation.policyId}
        {mitigation.dimensionName ? ` — ${mitigation.dimensionName} dimension` : " — Base role"}
      </p>
    </button>
  );
}

// Detail dialog for one mitigation — role name, policy name, an editable
// expiration date, and a delete icon. Deleting closes both this dialog and
// (via onDeleted) drops back to the list; no confirm-modal, since revoking a
// mitigation just puts the violation back to "active," it doesn't destroy
// anything.
function MitigationDetailModal({ mitigation, onClose, onSave, savePending, onDelete, deletePending }) {
  const [date, setDate] = useState(mitigation.expiresAt.slice(0, 10));
  const dirty = date !== mitigation.expiresAt.slice(0, 10);
  const expired = new Date(mitigation.expiresAt).getTime() < Date.now();

  return (
    <div
      className="fixed inset-0 bg-black/40 z-50 flex items-end md:items-center justify-center"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-white w-full max-w-md md:mx-4 rounded-t-2xl md:rounded-2xl shadow-xl p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold text-gray-900">Mitigation</h2>
          <div className="flex items-center gap-2">
            <IconButton
              icon={Trash2}
              title="Delete mitigation"
              onClick={() => onDelete(mitigation.id)}
              loading={deletePending}
              className="!w-8 !h-8 !border-red-200 !text-red-600 hover:!bg-red-50"
            />
            <IconButton icon={X} title="Close" onClick={onClose} className="!w-8 !h-8" />
          </div>
        </div>

        <Field label="Role">
          <p className="text-sm text-gray-900 py-1">{mitigation.roleName || mitigation.roleId}</p>
        </Field>
        <Field label="SOD Policy">
          <p className="text-sm text-gray-900 py-1">
            {mitigation.policyName || mitigation.policyId}
            {mitigation.dimensionName ? ` — ${mitigation.dimensionName} dimension` : " — Base role"}
          </p>
        </Field>
        <Field label="Mitigated until">
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        {expired && !dirty && <p className="text-xs text-red-600 -mt-3 mb-3">Expired</p>}

        {dirty && (
          <PrimaryButton onClick={() => onSave(mitigation.id, date)} loading={savePending}>
            Save
          </PrimaryButton>
        )}
      </div>
    </div>
  );
}

function ManageMitigationsModal({ onClose }) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState(null);
  const { data: mitigations = [], isLoading } = useQuery({
    queryKey: ["sod-mitigations"],
    queryFn: listTenantSodMitigations,
  });
  // Keeps the detail dialog showing the live version of whatever's
  // selected (e.g. right after a save) rather than a stale snapshot from
  // when it was opened.
  const selectedMitigation = selected ? mitigations.find((m) => m.id === selected) : null;

  const saveMutation = useMutation({
    mutationFn: ({ mitigationId, expiresAt }) => updateSodMitigation(mitigationId, { expiresAt }),
    onSuccess: () => {
      toast.success("Mitigation updated");
      queryClient.invalidateQueries({ queryKey: ["sod-mitigations"] });
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (mitigationId) => deleteSodMitigation(mitigationId),
    onSuccess: () => {
      toast.success("Mitigation deleted");
      queryClient.invalidateQueries({ queryKey: ["sod-mitigations"] });
      setSelected(null);
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  return (
    <div
      className="fixed inset-0 bg-black/40 z-40 flex items-end md:items-center justify-center"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-white w-full max-w-lg md:mx-4 rounded-t-2xl md:rounded-2xl shadow-xl p-5 max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-amber-50 flex items-center justify-center flex-shrink-0">
              <Clock3 size={18} className="text-amber-600" />
            </div>
            <h2 className="text-base font-semibold text-gray-900">Manage Mitigations</h2>
          </div>
          <IconButton icon={X} title="Close" onClick={onClose} className="!w-8 !h-8" />
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-10"><Spinner size={20} /></div>
        ) : mitigations.length === 0 ? (
          <EmptyState icon={Clock3} title="No mitigations" subtitle="No SOD violations are currently mitigated" />
        ) : (
          <div className="space-y-2">
            {mitigations.map((m) => (
              <MitigationListItem key={m.id} mitigation={m} onClick={() => setSelected(m.id)} />
            ))}
          </div>
        )}
      </div>

      {selectedMitigation && (
        <MitigationDetailModal
          mitigation={selectedMitigation}
          onClose={() => setSelected(null)}
          onSave={(mitigationId, expiresAt) => saveMutation.mutate({ mitigationId, expiresAt })}
          savePending={saveMutation.isPending && saveMutation.variables?.mitigationId === selected}
          onDelete={(mitigationId) => deleteMutation.mutate(mitigationId)}
          deletePending={deleteMutation.isPending && deleteMutation.variables === selected}
        />
      )}
    </div>
  );
}

// The other half of what used to be a single Configuration screen — see
// ScanningConfigPage for Scan Scope/Schema Analysis/Role Mining/Role
// Naming. This one is Behavior toggles plus Role Statistics Refresh —
// Evaluation Scope moved to the Role Evaluation screen itself as an ad-hoc
// search (not persisted), since it's really "which roles to evaluate this
// run", not a standing tenant setting.
export default function EvaluationConfigPage() {
  const queryClient = useQueryClient();
  const location = useLocation();
  const navigate = useNavigate();

  const settingsQuery = useQuery({
    queryKey: ["tenant-settings"],
    queryFn: getTenantSettings,
  });

  const updateSettings = useMutation({
    mutationFn: setTenantSettings,
    onSuccess: (updated) => queryClient.setQueryData(["tenant-settings"], updated),
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  // Kept as a string while editing so a temporarily-empty or
  // partially-typed field doesn't get coerced to 0 (same pattern
  // ScanningConfigPage's Entitlement Commonality field uses).
  const [retention, setRetention] = useState("10");
  const settingsUpdatedAt = settingsQuery.dataUpdatedAt;
  useEffect(() => {
    if (settingsQuery.data) {
      setRetention(String(settingsQuery.data.roleEvalRetention ?? 10));
    }
  }, [settingsUpdatedAt]);
  const retentionNumber = Number(retention);
  const retentionIsValid = retention.trim() !== "" && Number.isInteger(retentionNumber) && retentionNumber >= 1 && retentionNumber <= 20;
  const retentionDirty = settingsQuery.data && retention !== String(settingsQuery.data.roleEvalRetention ?? 10);

  const prefsQuery = useQuery({
    queryKey: ["studio-preferences"],
    queryFn: getStudioPreferences,
  });

  // Locally-edited copy — synced from the persisted result, then left alone
  // until saved, same pattern every other settings screen here uses.
  const [enabled, setEnabled] = useState(false);
  const [frequency, setFrequency] = useState("DAILY");
  const [timeOfDay, setTimeOfDay] = useState("06:00");
  const [startDate, setStartDate] = useState("");
  const prefsUpdatedAt = prefsQuery.dataUpdatedAt;
  useEffect(() => {
    if (prefsQuery.data) {
      setEnabled(!!prefsQuery.data.roleStatsRefreshEnabled);
      setFrequency(prefsQuery.data.roleStatsRefreshFrequency || "DAILY");
      setTimeOfDay(prefsQuery.data.roleStatsRefreshTimeOfDay || "06:00");
      setStartDate(prefsQuery.data.roleStatsRefreshStartDate || "");
    }
  }, [prefsUpdatedAt]);

  const dirty =
    prefsQuery.data &&
    (enabled !== !!prefsQuery.data.roleStatsRefreshEnabled ||
      frequency !== (prefsQuery.data.roleStatsRefreshFrequency || "DAILY") ||
      timeOfDay !== (prefsQuery.data.roleStatsRefreshTimeOfDay || "06:00") ||
      startDate !== (prefsQuery.data.roleStatsRefreshStartDate || ""));

  const savePreferences = useMutation({
    mutationFn: () =>
      setStudioPreferences({
        roleStatsRefreshEnabled: enabled,
        roleStatsRefreshFrequency: frequency,
        roleStatsRefreshTimeOfDay: timeOfDay,
        roleStatsRefreshStartDate: startDate || null,
      }),
    onSuccess: (result) => {
      queryClient.setQueryData(["studio-preferences"], result);
      toast.success("Role Statistics Refresh saved");
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const runNow = useMutation({
    mutationFn: runRoleStatsRefreshNow,
    onSuccess: () => {
      toast.success("Role Statistics Refresh started");
      queryClient.invalidateQueries({ queryKey: ["role-stats-summary"] });
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const needsStartDate = enabled && !startDate;
  const [manageMitigationsOpen, setManageMitigationsOpen] = useState(false);
  // Arrived here via the "Mitigated Violation Present" link in a role's
  // evaluation sheet — open straight to the management list instead of
  // making the user find and click the button themselves. The state is
  // cleared right after so navigating back here later (or refreshing)
  // doesn't keep popping the modal open.
  useEffect(() => {
    if (location.state?.openManageMitigations) {
      setManageMitigationsOpen(true);
      navigate(location.pathname, { replace: true, state: {} });
    }
  }, [location.state, location.pathname, navigate]);

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <TopBar title={<StudioSettingsTitleMenu active="Evaluation Config" />} />
      <div className="flex-1 overflow-y-auto pb-24">
        <div className="px-4 py-4 flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-violet-50 flex items-center justify-center flex-shrink-0">
            <Settings size={18} className="text-violet-600" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-gray-900">Role Evaluation Configuration</h2>
            <p className="text-xs text-gray-500 mt-0.5">Adjust the settings for the Role Evaluation scans of exisitng Roles.</p>
          </div>
        </div>

        <SectionLabel bold>Behavior</SectionLabel>
        <div className="px-4 space-y-3">
          {settingsQuery.isLoading ? (
            <div className="flex items-center justify-center py-6">
              <Spinner size={18} />
            </div>
          ) : (
            <>
              <div className="border border-gray-100 rounded-xl p-4">
                <p className="text-sm font-medium text-gray-900 mb-0.5">Role Filtering</p>
                <p className="text-xs text-gray-500 mb-3">
                  Which roles a manual Role Evaluation (the Start button) evaluates. Role Statistics
                  Refresh always evaluates enabled roles only, regardless of this setting.
                </p>
                <Select
                  value={settingsQuery.data?.roleFilterMode ?? "ENABLED_ONLY"}
                  onChange={(e) => updateSettings.mutate({ roleFilterMode: e.target.value })}
                  disabled={updateSettings.isPending}
                >
                  <option value="ALL">Enabled & Disabled Roles</option>
                  <option value="ENABLED_ONLY">Enabled Roles Only</option>
                  <option value="DISABLED_ONLY">Disabled Roles Only</option>
                </Select>
              </div>

              <label className="flex items-start gap-3 border border-gray-100 rounded-xl p-4 cursor-pointer">
                <input
                  type="checkbox"
                  checked={settingsQuery.data?.considerCommonRoles ?? true}
                  onChange={(e) => updateSettings.mutate({ considerCommonRoles: e.target.checked })}
                  disabled={updateSettings.isPending}
                  className="w-4 h-4 mt-0.5 rounded border-gray-300 flex-shrink-0"
                />
                <div>
                  <p className="text-sm font-medium text-gray-900">Consider Common Roles</p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    Exclude entitlements already granted by a confirmed common-access role from
                    "commonly held but missing" suggestions and flag a role's own entitlements that
                    duplicate one as redundant. When off, common-access roles are ignored and Role
                    Evaluation treats every entitlement on its own.
                  </p>
                </div>
              </label>

              <label className="flex items-start gap-3 border border-gray-100 rounded-xl p-4 cursor-pointer">
                <input
                  type="checkbox"
                  checked={settingsQuery.data?.checkSodViolations ?? true}
                  onChange={(e) => updateSettings.mutate({ checkSodViolations: e.target.checked })}
                  disabled={updateSettings.isPending}
                  className="w-4 h-4 mt-0.5 rounded border-gray-300 flex-shrink-0"
                />
                <div>
                  <p className="text-sm font-medium text-gray-900">Check for SOD Violations</p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    Check a role's entitlements (base and each dimension) against every
                    conflicting-access SOD policy in the tenant. When off, Role Evaluation skips the
                    SOD check entirely — no violations are flagged, and Repair Role isn't offered.
                  </p>
                </div>
              </label>

              {settingsQuery.data?.checkSodViolations !== false && (
                <div className="border border-gray-100 rounded-xl p-4">
                  <label className="flex items-start gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={settingsQuery.data?.allowSodMitigations ?? true}
                      onChange={(e) => updateSettings.mutate({ allowSodMitigations: e.target.checked })}
                      disabled={updateSettings.isPending}
                      className="w-4 h-4 mt-0.5 rounded border-gray-300 flex-shrink-0"
                    />
                    <div>
                      <p className="text-sm font-medium text-gray-900">Allow SOD Mitigations</p>
                      <p className="text-xs text-gray-500 mt-0.5">
                        Let Repair Role accept the risk on a violation for a chosen period instead of
                        removing access. When off, the mitigate option isn't offered, and any existing
                        mitigation stops being honored — its violation goes back to being flagged as
                        active immediately.
                      </p>
                    </div>
                  </label>
                  <OutlineButton
                    onClick={() => setManageMitigationsOpen(true)}
                    className="!w-auto !py-1.5 !px-3 !text-xs mt-3"
                  >
                    <ListChecks size={14} />
                    Manage Mitigations
                  </OutlineButton>
                </div>
              )}
            </>
          )}
        </div>

        <SectionLabel bold>Role Evaluation Retention</SectionLabel>
        <div className="px-4">
          {settingsQuery.isLoading ? (
            <div className="flex items-center justify-center py-6">
              <Spinner size={18} />
            </div>
          ) : (
            <div className="border border-gray-100 rounded-xl p-4">
              <p className="text-xs text-gray-500 mb-3">
                This value limits the number of Evaluation Results the system stores. At the end of
                each Role Evaluation scan, the oldest scan results beyond this count are purged.
              </p>
              <Field label="Scans to retain (1–20)">
                <Input
                  type="number"
                  min="1"
                  max="20"
                  step="1"
                  value={retention}
                  onChange={(e) => setRetention(e.target.value)}
                  disabled={updateSettings.isPending}
                />
              </Field>
              {retention.trim() !== "" && !retentionIsValid && (
                <p className="text-xs text-red-600 mb-3">Enter a whole number between 1 and 20.</p>
              )}
              {retentionDirty && (
                <PrimaryButton
                  onClick={() => updateSettings.mutate({ roleEvalRetention: retentionNumber })}
                  loading={updateSettings.isPending}
                  disabled={!retentionIsValid}
                >
                  Save
                </PrimaryButton>
              )}
            </div>
          )}
        </div>

        <SectionLabel bold>Role Statistics Refresh</SectionLabel>
        <div className="px-4">
          {prefsQuery.isLoading ? (
            <div className="flex items-center justify-center py-6">
              <Spinner size={18} />
            </div>
          ) : (
            <div className="border border-gray-100 rounded-xl p-4">
              <p className="text-xs text-gray-500 mb-3">
                Runs a Role Evaluation across every role in the background, on the schedule below, so
                the Home screen's pass/needs-update counts reflect a recent scan automatically. Only
                this scheduled run (or Run Now below) counts toward those numbers — a one-off scan you
                start from Role Evaluation never does.
              </p>
              <label className="flex items-start gap-3 cursor-pointer mb-3">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(e) => setEnabled(e.target.checked)}
                  disabled={savePreferences.isPending}
                  className="w-4 h-4 mt-0.5 rounded border-gray-300 flex-shrink-0"
                />
                <span className="text-sm font-medium text-gray-900">Enable Role Statistics Refresh</span>
              </label>

              <div className={enabled ? "" : "opacity-40 pointer-events-none"}>
                <Field label="Frequency">
                  <Select
                    value={frequency}
                    onChange={(e) => setFrequency(e.target.value)}
                    disabled={savePreferences.isPending}
                  >
                    {FREQUENCIES.map(({ value, label }) => (
                      <option key={value} value={value}>{label}</option>
                    ))}
                  </Select>
                </Field>
                <Field label={frequency === "HOURLY" ? "Minute of the hour" : "Time of day"}>
                  <Input
                    type="time"
                    value={timeOfDay}
                    onChange={(e) => setTimeOfDay(e.target.value)}
                    disabled={savePreferences.isPending}
                  />
                </Field>
                <Field label="Start date">
                  <Input
                    type="date"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                    disabled={savePreferences.isPending}
                  />
                </Field>
                {needsStartDate && (
                  <p className="text-xs text-red-600 mb-3">A start date is required to enable this.</p>
                )}
              </div>

              <div className="flex gap-2 mt-1">
                {dirty && (
                  <PrimaryButton
                    onClick={() => savePreferences.mutate()}
                    loading={savePreferences.isPending}
                    disabled={needsStartDate}
                    className="!w-auto flex-1"
                  >
                    Save
                  </PrimaryButton>
                )}
                <OutlineButton onClick={() => runNow.mutate()} loading={runNow.isPending} className="!w-auto flex-1">
                  <PlayCircle size={16} />
                  Run Now
                </OutlineButton>
              </div>
            </div>
          )}
        </div>
      </div>

      {manageMitigationsOpen && <ManageMitigationsModal onClose={() => setManageMitigationsOpen(false)} />}
    </div>
  );
}
