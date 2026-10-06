import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Settings, Search, CheckCircle2 } from "lucide-react";
import toast from "react-hot-toast";
import {
  getSchemaAnalysis, getTenantSettings, setTenantSettings, validateNameScope, setSchemaRoleBoundary,
} from "../../lib/sailpoint";
import { applyRoleNaming } from "../../lib/roleNaming";
import { TopBar } from "../../components/TopBar";
import { StudioSettingsTitleMenu } from "../../components/StudioSettingsTitleMenu";
import { Spinner, SectionLabel, Field, Input, PrimaryButton, OutlineButton } from "../../components/ui";

// One half of what used to be a single Configuration screen — everything
// that shapes how Scan for Roles (peer-group mining) behaves: its scope,
// Schema Analysis, dynamic-role/duplicate-role behavior, and role naming.
// See EvaluationConfigPage for the other half (Evaluation Scope).
export default function ScanningConfigPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["schema-analysis"],
    queryFn: getSchemaAnalysis,
  });

  const settingsQuery = useQuery({
    queryKey: ["tenant-settings"],
    queryFn: getTenantSettings,
  });

  const updateSettings = useMutation({
    mutationFn: setTenantSettings,
    onSuccess: (updated) => queryClient.setQueryData(["tenant-settings"], updated),
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  // Enable/Create Data Segments toggle for the Multi-Company/Division
  // Boundary — the boundary's own attribute picker (which requires the
  // candidates a Schema Analysis run produces) stays on that page; these
  // two just flip booleans against whatever attributes are already saved,
  // same immediate-save pattern as the Role Mining checkboxes below rather
  // than Schema Analysis's own "edit, then Save" flow.
  const updateBoundary = useMutation({
    mutationFn: setSchemaRoleBoundary,
    onSuccess: (result) => queryClient.setQueryData(["schema-analysis"], result),
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  // Locally-edited prefix/suffix/separator — synced from the persisted
  // settings once they load, but left alone afterward so typing isn't
  // clobbered by anything else touching the query cache.
  const [rolePrefix, setRolePrefix] = useState("");
  const [roleSuffix, setRoleSuffix] = useState("");
  const [attributeSeparator, setAttributeSeparator] = useState(" - ");
  const settingsLoadedAt = settingsQuery.dataUpdatedAt;
  useEffect(() => {
    if (settingsQuery.data) {
      setRolePrefix(settingsQuery.data.rolePrefix || "");
      setRoleSuffix(settingsQuery.data.roleSuffix || "");
      // Nullish, not ||, so a deliberately empty separator isn't replaced.
      setAttributeSeparator(settingsQuery.data.attributeSeparator ?? " - ");
    }
  }, [settingsLoadedAt]);

  const namingDirty =
    settingsQuery.data &&
    (rolePrefix !== (settingsQuery.data.rolePrefix || "") ||
      roleSuffix !== (settingsQuery.data.roleSuffix || "") ||
      attributeSeparator !== (settingsQuery.data.attributeSeparator ?? " - "));

  const namingPreview = applyRoleNaming(
    ["Engineering", "Production Test Engineer I"].join(attributeSeparator),
    rolePrefix,
    roleSuffix
  );

  // Scan Scope — a raw ISC Search query (identities index) that limits
  // which users Role Mining considers. Since it's arbitrary Lucene-style
  // syntax that can be wrong in ways a client-side check can't catch, it's
  // validated against the real Search API rather than saved blindly —
  // `validatedQuery` tracks which exact string the last successful check
  // covered, so editing after a check invalidates it and Save is disabled
  // again until it's re-checked.
  const [nameScope, setNameScope] = useState("");
  const [validatedQuery, setValidatedQuery] = useState(null);
  const [matchCount, setMatchCount] = useState(null);
  useEffect(() => {
    if (settingsQuery.data) {
      const saved = settingsQuery.data.nameScope || "";
      setNameScope(saved);
      setValidatedQuery(saved || null);
      setMatchCount(null);
    }
  }, [settingsLoadedAt]);

  const checkScope = useMutation({
    mutationFn: (query) => validateNameScope(query),
    onSuccess: (count, query) => {
      setMatchCount(count);
      setValidatedQuery(query);
    },
    onError: (err) => {
      setMatchCount(null);
      setValidatedQuery(null);
      toast.error(err.response?.data?.messages?.[0]?.text || err.response?.data?.error || err.message);
    },
  });

  const nameScopeDirty = settingsQuery.data && nameScope !== (settingsQuery.data.nameScope || "");
  // A scope that resolves to 0 users can't be saved — it would silently
  // make every future Role Scan mine nobody. Checked here too (not just
  // server-side) so Save is disabled before the round trip even happens.
  const nameScopeChecked = !nameScope.trim() || nameScope === validatedQuery;
  const nameScopeIsValidated = nameScopeChecked && matchCount !== 0;

  // Entitlement Commonality — kept as a string while editing so a
  // temporarily-empty or partially-typed field doesn't get coerced to 0.
  const [commonalityThreshold, setCommonalityThreshold] = useState("80");
  useEffect(() => {
    if (settingsQuery.data) {
      setCommonalityThreshold(String(settingsQuery.data.entitlementCommonalityThreshold ?? 80));
    }
  }, [settingsLoadedAt]);
  const commonalityNumber = Number(commonalityThreshold);
  const commonalityIsValid = commonalityThreshold.trim() !== "" && Number.isFinite(commonalityNumber) && commonalityNumber >= 1 && commonalityNumber <= 100;
  const commonalityDirty = settingsQuery.data && commonalityThreshold !== String(settingsQuery.data.entitlementCommonalityThreshold ?? 80);

  // Global Metadata attribute Segments by Metadata tags and filters on —
  // same local-edit-then-Save pattern as the naming fields above.
  const [segmentMetadataAttribute, setSegmentMetadataAttribute] = useState("Segments");
  useEffect(() => {
    if (settingsQuery.data) {
      setSegmentMetadataAttribute(settingsQuery.data.segmentMetadataAttribute || "Segments");
    }
  }, [settingsLoadedAt]);
  const segmentMetadataDirty =
    settingsQuery.data && segmentMetadataAttribute !== (settingsQuery.data.segmentMetadataAttribute || "Segments");

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <TopBar title={<StudioSettingsTitleMenu active="Mining Config" />} />
      <div className="flex-1 overflow-y-auto pb-24">
        <div className="px-4 py-4 flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-violet-50 flex items-center justify-center flex-shrink-0">
            <Settings size={18} className="text-violet-600" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-gray-900">Role Mining Configuration</h2>
            <p className="text-xs text-gray-500 mt-0.5">Adjust the settings for the Role Scans that produce Draft Role Models.</p>
          </div>
        </div>

        <SectionLabel bold>Role Mining</SectionLabel>
        <div className="px-4 space-y-3">
          {/* Boundary attribute selection (which requires the candidates a
              Schema Analysis run produces) stays on that page — these two
              toggles just flip booleans against whatever's already saved. */}
          {isLoading ? (
            <div className="flex items-center justify-center py-6">
              <Spinner size={18} />
            </div>
          ) : !data ? (
            <button
              onClick={() => navigate("/studio-settings/schema-analysis")}
              className="w-full text-left border border-gray-100 rounded-xl p-4 hover:bg-gray-50 active:bg-gray-100 transition-colors"
            >
              <p className="text-sm font-medium text-gray-900">Enable Multi-Company or Division Boundary</p>
              <p className="text-xs text-gray-500 mt-0.5">
                Run Schema Analysis first — the boundary is built from its candidate attributes.
              </p>
            </button>
          ) : (
            <>
              <label className="flex items-start gap-3 border border-gray-100 rounded-xl p-4 cursor-pointer">
                <input
                  type="checkbox"
                  checked={!!data.roleBoundaryEnabled}
                  onChange={(e) =>
                    updateBoundary.mutate({
                      enabled: e.target.checked,
                      attributes: data.roleBoundaryAttributes || [],
                      createDataSegments: !!data.createDataSegments,
                    })
                  }
                  disabled={updateBoundary.isPending}
                  className="w-4 h-4 mt-0.5 rounded border-gray-300 flex-shrink-0"
                />
                <div>
                  <p className="text-sm font-medium text-gray-900">Enable Multi-Company or Division Boundary</p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    When on, Role Mining produces a separate set of Role Drafts for each distinct
                    combination of this value. The proposed Roles will not span across this boundary.
                    Pick the attribute(s) in Schema Analysis.
                  </p>
                </div>
              </label>

              <label
                className={`flex items-start gap-3 border border-gray-100 rounded-xl p-4 cursor-pointer ${
                  data.roleBoundaryEnabled ? "" : "opacity-40 pointer-events-none"
                }`}
              >
                <input
                  type="checkbox"
                  checked={!!data.createDataSegments}
                  onChange={(e) =>
                    updateBoundary.mutate({
                      enabled: !!data.roleBoundaryEnabled,
                      attributes: data.roleBoundaryAttributes || [],
                      createDataSegments: e.target.checked,
                    })
                  }
                  disabled={updateBoundary.isPending}
                  className="w-4 h-4 mt-0.5 rounded border-gray-300 flex-shrink-0"
                />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900">Create Data Segments</p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    Use these same boundary attributes to build ISC Data Segments — one per distinct
                    combination of values. Adds a "Data Segments" menu under Browse, with a Build
                    icon to create whatever's missing.
                  </p>
                  {data.createDataSegments && (
                    // Inside the same box, but only relevant once the toggle is
                    // on — Segments by Metadata tags roles/entitlements with
                    // this Global Metadata attribute and filters each created
                    // segment's Access Model on it.
                    <div className="mt-3" onClick={(e) => e.preventDefault()}>
                      <Field label="Global Metadata Attribute Name">
                        <Input
                          value={segmentMetadataAttribute}
                          onChange={(e) => setSegmentMetadataAttribute(e.target.value)}
                          placeholder='e.g. "Segments"'
                          disabled={updateSettings.isPending}
                        />
                      </Field>
                      {segmentMetadataDirty && (
                        <PrimaryButton
                          onClick={() => updateSettings.mutate({ segmentMetadataAttribute: segmentMetadataAttribute.trim() })}
                          loading={updateSettings.isPending}
                          disabled={!segmentMetadataAttribute.trim()}
                        >
                          Save
                        </PrimaryButton>
                      )}
                    </div>
                  )}
                </div>
              </label>
            </>
          )}

          {settingsQuery.isLoading ? (
            <div className="flex items-center justify-center py-6">
              <Spinner size={18} />
            </div>
          ) : (
            <>
              <label className="flex items-start gap-3 border border-gray-100 rounded-xl p-4 cursor-pointer">
                <input
                  type="checkbox"
                  checked={!!settingsQuery.data?.createDynamicRoles}
                  onChange={(e) => updateSettings.mutate({ createDynamicRoles: e.target.checked })}
                  disabled={updateSettings.isPending}
                  className="w-4 h-4 mt-0.5 rounded border-gray-300 flex-shrink-0"
                />
                <div>
                  <p className="text-sm font-medium text-gray-900">Create Dynamic Roles</p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    When Scan for Roles finds a peer group with attributes still varying among its
                    members, create it as a Dynamic role with a dimension per varying value. When
                    off, every role is created as a plain (simple) role instead.
                  </p>
                </div>
              </label>

              <label className="flex items-start gap-3 border border-gray-100 rounded-xl p-4 cursor-pointer">
                <input
                  type="checkbox"
                  checked={settingsQuery.data?.allowDuplicateRoles ?? true}
                  onChange={(e) => updateSettings.mutate({ allowDuplicateRoles: e.target.checked })}
                  disabled={updateSettings.isPending}
                  className="w-4 h-4 mt-0.5 rounded border-gray-300 flex-shrink-0"
                />
                <div>
                  <p className="text-sm font-medium text-gray-900">Allow Duplicate Roles</p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    When Scan for Roles finds a peer group whose exact attribute combination already
                    matches an existing role, show it anyway (with a warning) so you can still decide.
                    When off, those peer groups stay visible too, but offer to merge their proposed
                    access into the existing role instead of creating a duplicate.
                  </p>
                </div>
              </label>
            </>
          )}
        </div>

        <SectionLabel bold>Role Naming</SectionLabel>
        <div className="px-4">
          {settingsQuery.isLoading ? (
            <div className="flex items-center justify-center py-6">
              <Spinner size={18} />
            </div>
          ) : (
            <div className="border border-gray-100 rounded-xl p-4">
              <p className="text-xs text-gray-500 mb-3">
                Prefix and suffix are wrapped around a peer group's criteria to propose each
                Role's name at create-role time. Attribute Separator joins the attribute values
                that make up that criteria in the first place (used whenever Scan for Roles runs)
                — leading/trailing spaces are kept exactly as typed.
              </p>
              <Field label="Attribute Separator">
                <Input
                  value={attributeSeparator}
                  onChange={(e) => setAttributeSeparator(e.target.value)}
                  placeholder='e.g. " - "'
                  disabled={updateSettings.isPending}
                />
              </Field>
              <Field label="Prefix">
                <Input
                  value={rolePrefix}
                  onChange={(e) => setRolePrefix(e.target.value)}
                  placeholder='Optional, e.g. "DRAFT - "'
                  disabled={updateSettings.isPending}
                />
              </Field>
              <Field label="Suffix">
                <Input
                  value={roleSuffix}
                  onChange={(e) => setRoleSuffix(e.target.value)}
                  placeholder='Optional, e.g. " Peer Group"'
                  disabled={updateSettings.isPending}
                />
              </Field>
              <p className="text-xs text-gray-400 mb-3 truncate">
                Preview: {namingPreview}
              </p>
              {namingDirty && (
                <PrimaryButton
                  onClick={() => updateSettings.mutate({ rolePrefix, roleSuffix, attributeSeparator })}
                  loading={updateSettings.isPending}
                >
                  Save
                </PrimaryButton>
              )}
            </div>
          )}
        </div>

        <SectionLabel bold>Entitlement Commonality</SectionLabel>
        <div className="px-4">
          {settingsQuery.isLoading ? (
            <div className="flex items-center justify-center py-6">
              <Spinner size={18} />
            </div>
          ) : (
            <div className="border border-gray-100 rounded-xl p-4">
              <p className="text-xs text-gray-500 mb-3">
                How commonly an entitlement must be held, as a percentage of a group's members, to
                be included when Role Drafts are created. Role Evaluation uses this same percentage
                to decide whether an existing role is missing commonly-held access, so a Role Draft
                and its first evaluation agree on what "shared" means.
              </p>
              <Field label="Commonality threshold (%)">
                <Input
                  type="number"
                  min="1"
                  max="100"
                  value={commonalityThreshold}
                  onChange={(e) => setCommonalityThreshold(e.target.value)}
                  placeholder="e.g. 80"
                  disabled={updateSettings.isPending}
                />
              </Field>
              {commonalityThreshold.trim() !== "" && !commonalityIsValid && (
                <p className="text-xs text-red-600 mb-3">Enter a number between 1 and 100.</p>
              )}
              {commonalityDirty && (
                <PrimaryButton
                  onClick={() => updateSettings.mutate({ entitlementCommonalityThreshold: commonalityNumber })}
                  loading={updateSettings.isPending}
                  disabled={!commonalityIsValid}
                >
                  Save
                </PrimaryButton>
              )}
            </div>
          )}
        </div>

        <SectionLabel bold>Scan Scope</SectionLabel>
        <div className="px-4">
          {settingsQuery.isLoading ? (
            <div className="flex items-center justify-center py-6">
              <Spinner size={18} />
            </div>
          ) : (
            <div className="border border-gray-100 rounded-xl p-4">
              <p className="text-xs text-gray-500 mb-3">
                The Scope will limit the Role Scan process to mine for roles only within the
                context of the scope. This allows for targeted Role Mining. The default scope is
                CloudLifecycleState=active.
              </p>
              <Field label="Scope (ISC Search query)">
                <Input
                  value={nameScope}
                  onChange={(e) => setNameScope(e.target.value)}
                  placeholder='e.g. attributes.cloudLifecycleState:active'
                  disabled={updateSettings.isPending}
                />
              </Field>
              <div className="flex items-center gap-2 mb-3">
                {nameScope.trim() && (
                  <OutlineButton
                    onClick={() => checkScope.mutate(nameScope)}
                    loading={checkScope.isPending}
                    className="!w-auto !py-2 !border-blue-200 !text-blue-600 hover:!bg-blue-50"
                  >
                    <Search size={14} />
                    Check
                  </OutlineButton>
                )}
                {matchCount != null && nameScopeChecked && matchCount > 0 && (
                  <span className="flex items-center gap-1 text-xs text-emerald-600">
                    <CheckCircle2 size={14} />
                    {matchCount} user{matchCount === 1 ? "" : "s"} match
                  </span>
                )}
                {matchCount === 0 && nameScopeChecked && (
                  <span className="text-xs text-red-600">0 users match — can't be saved</span>
                )}
                {!nameScopeChecked && nameScope.trim() && (
                  <span className="text-xs text-amber-600">Check this scope before saving</span>
                )}
              </div>
              {nameScopeDirty && (
                <PrimaryButton
                  onClick={() => updateSettings.mutate({ nameScope })}
                  loading={updateSettings.isPending}
                  disabled={!nameScopeIsValidated}
                >
                  Save
                </PrimaryButton>
              )}
            </div>
          )}
        </div>

      </div>
    </div>
  );
}
