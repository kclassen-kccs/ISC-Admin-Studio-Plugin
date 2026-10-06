import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BadgeCheck, ChevronUp, ChevronDown, X, Plus, Tags, ShieldAlert, Database } from "lucide-react";
import { useNavigate } from "react-router-dom";
import toast from "react-hot-toast";
import {
  getStudioPreferences, setStudioPreferences, getSchemaAnalysis, listMetadataAttributes, listMetadataAttributeValues,
  listSources, fetchAllPages,
} from "../../lib/sailpoint";
import {
  CERT_DEFAULTS, CERT_UNDECIDED_ACCESS_OPTIONS, CERT_COMMENT_OPTIONS, CERT_DURATION_OPTIONS,
  CERT_PRIVILEGE_LEVEL_OPTIONS, CERT_IDENTITY_FILTER_MODE_OPTIONS, effectivePrivilegeFilters,
  CERT_NAME_AFFIX_MAX, certificationCampaignName, CERT_ACCESS_ITEM_TYPE_OPTIONS, effectiveAccessItemTypes,
} from "../../lib/certificationSettings";
import { TopBar } from "../../components/TopBar";
import { StudioSettingsTitleMenu } from "../../components/StudioSettingsTitleMenu";
import { Spinner, SectionLabel, Select, OutlineButton, Input, PrimaryButton } from "../../components/ui";

// Tenant-wide defaults applied to every certification campaign draft that
// Mining > Certifications creates. Each control saves immediately (same
// pattern as Evaluation Config's Behavior section) — there's no separate
// Save button to forget.
function SettingBox({ title, help, children }) {
  return (
    <div className="border border-gray-100 rounded-xl p-4">
      <p className="text-sm font-medium text-gray-900 mb-0.5">{title}</p>
      <p className="text-xs text-gray-500 mb-3">{help}</p>
      {children}
    </div>
  );
}

export default function UserCertificationsPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const prefsQuery = useQuery({ queryKey: ["studio-preferences"], queryFn: getStudioPreferences });
  const prefs = { ...CERT_DEFAULTS, ...(prefsQuery.data || {}) };
  // The pick-list for Certification Attributes is Schema Analysis's own
  // candidate set — every identity attribute it found dividing the tenant —
  // so only attributes that actually exist on identities can be chosen.
  const analysisQuery = useQuery({ queryKey: ["schema-analysis"], queryFn: getSchemaAnalysis });
  const candidates = analysisQuery.data?.candidates || [];
  const chosenKeys = Array.isArray(prefs.certAttributeKeys) ? prefs.certAttributeKeys : [];
  const priorityKeys = analysisQuery.data?.topAttributes || [];

  // Campaign Prefix / Suffix are typed too, so they save on a button. The
  // prefix has no default; the suffix defaults to " user access review "
  // (the phrase that used to be fixed in the name). `prefs` already merges
  // the defaults under the tenant's saved values, so a saved "" stays "".
  // Stored per tenant with the rest of these settings,
  // EXACTLY as typed: leading/trailing spaces are the user's separator
  // ("Q3 - ", " (SOX)"), so nothing here trims them.
  const [namePrefix, setNamePrefix] = useState("");
  const [nameSuffix, setNameSuffix] = useState("");
  useEffect(() => {
    if (prefsQuery.data) {
      setNamePrefix(prefsQuery.data.certCampaignPrefix ?? CERT_DEFAULTS.certCampaignPrefix);
      setNameSuffix(prefsQuery.data.certCampaignSuffix ?? CERT_DEFAULTS.certCampaignSuffix);
    }
  }, [prefsQuery.data]);
  const savedPrefix = prefs.certCampaignPrefix ?? "";
  const savedSuffix = prefs.certCampaignSuffix ?? "";
  const affixTooLong = namePrefix.length > CERT_NAME_AFFIX_MAX || nameSuffix.length > CERT_NAME_AFFIX_MAX;
  const affixDirty = namePrefix !== savedPrefix || nameSuffix !== savedSuffix;

  // Size Limit is typed, so it saves on an explicit button rather than per
  // keystroke — same treatment as Mining Config's Entitlement Commonality.
  const [sizeLimit, setSizeLimit] = useState("");
  useEffect(() => {
    if (prefsQuery.data) setSizeLimit(String(prefsQuery.data.certSizeLimit ?? CERT_DEFAULTS.certSizeLimit));
  }, [prefsQuery.data]);
  const sizeLimitNumber = Number(sizeLimit.replace(/[,\s]/g, ""));
  const sizeLimitValid = Number.isInteger(sizeLimitNumber) && sizeLimitNumber >= 1 && sizeLimitNumber <= 1000000;
  const sizeLimitDirty = sizeLimitValid && sizeLimitNumber !== (prefs.certSizeLimit ?? CERT_DEFAULTS.certSizeLimit);

  // Campaign Filters — Access Item Types. Each tick saves immediately, like
  // the dropdowns. At least one type has to stay chosen (a campaign must
  // certify something), so the last ticked box can't be cleared. The two role
  // options only apply — and are only enabled — while Roles is chosen; their
  // saved values are kept when Roles is unticked, so re-ticking restores them.
  const accessItemTypes = effectiveAccessItemTypes(prefs);
  const rolesChosen = accessItemTypes.includes("ROLE");
  function toggleAccessItemType(type) {
    const next = accessItemTypes.includes(type) ? accessItemTypes.filter((t) => t !== type) : [...accessItemTypes, type];
    if (next.length === 0) return;
    update.mutate({ certAccessItemTypes: next });
  }

  // Included Sources — every source in the tenant, ticked unless the admin
  // unticked it. What's saved is the UNTICKED list, so "all selected" is a
  // true default and a source created later is included automatically. ISC
  // sources have no active/inactive switch, so "every source that exists" is
  // the list; each tick saves immediately.
  const sourcesQuery = useQuery({
    queryKey: ["sources-all-for-cert-settings"],
    queryFn: () => fetchAllPages((page) => listSources(page), { pageSize: 250 }),
    staleTime: 60_000,
  });
  const allSources = Array.isArray(sourcesQuery.data) ? sourcesQuery.data : [];
  const excludedSources = Array.isArray(prefs.certExcludedSources) ? prefs.certExcludedSources.filter((x) => x?.id) : [];
  const excludedSourceIds = new Set(excludedSources.map((x) => x.id));
  const [sourceSearch, setSourceSearch] = useState("");
  const shownSources = allSources.filter((s) => !sourceSearch.trim() || String(s.name || "").toLowerCase().includes(sourceSearch.trim().toLowerCase()));
  // Unticked sources that no longer exist in the tenant — still saved, so
  // shown (and removable) rather than silently lingering.
  const staleExcluded = sourcesQuery.data ? excludedSources.filter((x) => !allSources.some((s) => s.id === x.id)) : [];
  function toggleSource(source) {
    const next = excludedSourceIds.has(source.id)
      ? excludedSources.filter((x) => x.id !== source.id)
      : [...excludedSources, { id: source.id, name: source.name }];
    update.mutate({ certExcludedSources: next });
  }
  function setShownSources(include) {
    const shownIds = new Set(shownSources.map((s) => s.id));
    const kept = excludedSources.filter((x) => !shownIds.has(x.id));
    update.mutate({ certExcludedSources: include ? kept : [...kept, ...shownSources.map((s) => ({ id: s.id, name: s.name }))] });
  }

  // Campaign Filters — privilege levels, each with its own mode.
  const privilegeFilters = effectivePrivilegeFilters(prefs);
  const [newPrivLevel, setNewPrivLevel] = useState("");
  const [newPrivMode, setNewPrivMode] = useState("INCLUDE");
  const availablePrivilegeLevels = CERT_PRIVILEGE_LEVEL_OPTIONS.filter((o) => !privilegeFilters.some((p) => p.level === o.value));
  const privilegeLabel = (level) => CERT_PRIVILEGE_LEVEL_OPTIONS.find((o) => o.value === level)?.label || level;
  function addPrivilegeFilter() {
    if (!newPrivLevel || privilegeFilters.some((p) => p.level === newPrivLevel)) return;
    update.mutate({ certPrivilegeFilters: [...privilegeFilters, { level: newPrivLevel, mode: newPrivMode }] });
    setNewPrivLevel("");
  }
  function removePrivilegeFilter(entry) {
    update.mutate({ certPrivilegeFilters: privilegeFilters.filter((p) => p.level !== entry.level) });
  }
  function setPrivilegeFilterMode(entry, mode) {
    update.mutate({ certPrivilegeFilters: privilegeFilters.map((p) => (p.level === entry.level ? { ...p, mode } : p)) });
  }

  // Campaign Filters — metadata pairs (attribute + value from the tenant's
  // Access Model Metadata registry) and a typed search string.
  const metadataFilters = Array.isArray(prefs.certMetadataFilters) ? prefs.certMetadataFilters : [];
  const [newMetaKey, setNewMetaKey] = useState("");
  const [newMetaValue, setNewMetaValue] = useState("");
  const [newMetaMode, setNewMetaMode] = useState("INCLUDE");
  const metaAttrsQuery = useQuery({ queryKey: ["metadata-attributes"], queryFn: listMetadataAttributes });
  const metaValuesQuery = useQuery({
    queryKey: ["metadata-attribute-values", newMetaKey],
    queryFn: () => listMetadataAttributeValues(newMetaKey),
    enabled: !!newMetaKey,
  });
  const metaAttrs = Array.isArray(metaAttrsQuery.data) ? metaAttrsQuery.data : [];
  const metaValues = Array.isArray(metaValuesQuery.data) ? metaValuesQuery.data : [];
  function addMetadataFilter() {
    if (!newMetaKey || !newMetaValue) return;
    if (metadataFilters.some((p) => p.key === newMetaKey && p.value === newMetaValue)) { setNewMetaValue(""); return; }
    const attr = metaAttrs.find((a) => a.key === newMetaKey);
    const val = metaValues.find((v) => v.value === newMetaValue);
    update.mutate({
      certMetadataFilters: [...metadataFilters, { key: newMetaKey, value: newMetaValue, mode: newMetaMode, attributeName: attr?.name || null, valueName: val?.name || null }],
    });
    setNewMetaValue("");
  }
  function setMetadataFilterMode(pair, mode) {
    update.mutate({ certMetadataFilters: metadataFilters.map((p) => (p.key === pair.key && p.value === pair.value ? { ...p, mode } : p)) });
  }
  function removeMetadataFilter(pair) {
    update.mutate({ certMetadataFilters: metadataFilters.filter((p) => !(p.key === pair.key && p.value === pair.value)) });
  }
  const [searchFilter, setSearchFilter] = useState("");
  useEffect(() => {
    if (prefsQuery.data) setSearchFilter(prefsQuery.data.certSearchFilter || "");
  }, [prefsQuery.data]);
  const searchFilterDirty = searchFilter.trim() !== String(prefs.certSearchFilter || "").trim();

  // The chosen list is an ordered sequence: it decides the order values
  // appear in each campaign's name and how the drafts screen groups them.
  // Every change saves immediately, like the dropdowns below.
  const availableCandidates = candidates.filter((c) => !chosenKeys.includes(c.key));
  function addAttribute(key) {
    if (chosenKeys.includes(key)) return;
    update.mutate({ certAttributeKeys: [...chosenKeys, key] });
  }
  function removeAttribute(key) {
    update.mutate({ certAttributeKeys: chosenKeys.filter((k) => k !== key) });
  }
  function moveAttribute(index, dir) {
    const target = index + dir;
    if (target < 0 || target >= chosenKeys.length) return;
    const next = [...chosenKeys];
    [next[index], next[target]] = [next[target], next[index]];
    update.mutate({ certAttributeKeys: next });
  }

  const update = useMutation({
    mutationFn: (patch) => setStudioPreferences(patch),
    onSuccess: (data) => {
      queryClient.setQueryData(["studio-preferences"], data);
      toast.success("Saved");
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <TopBar title={<StudioSettingsTitleMenu active="User Certifications" />} />
      <div className="flex-1 overflow-y-auto pb-24">
        <div className="px-4 py-4 flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-violet-50 flex items-center justify-center flex-shrink-0">
            <BadgeCheck size={18} className="text-violet-600" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-gray-900">User Certifications</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Campaign defaults for the user access reviews that Mining → Certifications drafts.
              Changes apply to campaigns created from now on; existing drafts in ISC are untouched.
            </p>
          </div>
        </div>

        <SectionLabel bold>Campaign Defaults</SectionLabel>
        <div className="px-4 space-y-3">
          {prefsQuery.isLoading ? (
            <div className="flex items-center justify-center py-6">
              <Spinner size={18} />
            </div>
          ) : (
            <>
              <SettingBox
                title="Campaign Prefix and Suffix"
help="Text added before and after each drafted campaign's root name, which is the certification attribute value(s) — “Engineering”, or “Engineering - Austin”. The suffix starts as “ user access review ”; change it to reword every campaign. Both are joined exactly as typed, spaces included, so type your own separator: a prefix of “Q3 - ” (with its trailing space), a suffix of “ (SOX)” (with its leading space). Leave either blank to add nothing there. Saved for this tenant."
              >
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <label className="block">
                    <span className="block text-xs font-medium text-gray-700 mb-1">Campaign Prefix</span>
                    <Input
                      value={namePrefix}
                      onChange={(e) => setNamePrefix(e.target.value)}
                      maxLength={CERT_NAME_AFFIX_MAX + 10}
                      placeholder="None"
                      aria-label="Campaign Prefix"
                    />
                  </label>
                  <label className="block">
                    <span className="block text-xs font-medium text-gray-700 mb-1">Campaign Suffix</span>
                    <Input
                      value={nameSuffix}
                      onChange={(e) => setNameSuffix(e.target.value)}
                      maxLength={CERT_NAME_AFFIX_MAX + 10}
                      placeholder="None"
                      aria-label="Campaign Suffix"
                    />
                  </label>
                </div>
                <p className="text-xs text-gray-500 mt-3">
                  Example name:{" "}
                  <span className="font-medium text-gray-800 whitespace-pre bg-gray-50 border border-gray-100 rounded px-1.5 py-0.5">
                    {certificationCampaignName("Engineering", { certCampaignPrefix: namePrefix, certCampaignSuffix: nameSuffix })}
                  </span>
                </p>
                {affixTooLong && <p className="text-xs text-red-600 mt-1">Keep each to {CERT_NAME_AFFIX_MAX} characters or fewer.</p>}
                <div className="flex items-center gap-3 mt-3">
                  <PrimaryButton
                    onClick={() => update.mutate({ certCampaignPrefix: namePrefix, certCampaignSuffix: nameSuffix })}
                    disabled={!affixDirty || affixTooLong || update.isPending}
                    loading={update.isPending && affixDirty}
                    className="!w-auto !py-2.5 px-5"
                  >
                    Save
                  </PrimaryButton>
                  {!affixDirty && (savedPrefix || savedSuffix) && <span className="text-xs text-gray-400">Saved</span>}
                  {!affixDirty && !savedPrefix && !savedSuffix && <span className="text-xs text-gray-400">None set — campaigns are named with the attribute value alone</span>}
                  {nameSuffix !== CERT_DEFAULTS.certCampaignSuffix && (
                    <button
                      type="button"
                      onClick={() => setNameSuffix(CERT_DEFAULTS.certCampaignSuffix)}
                      className="text-xs text-blue-600 hover:underline ml-auto"
                      title="Put the default suffix back in the field — press Save to keep it"
                    >
                      Reset suffix to default
                    </button>
                  )}
                </div>
              </SettingBox>

              <div className="border border-gray-100 rounded-xl p-4">
                <p className="text-sm font-medium text-gray-900 mb-0.5">Certification Attributes</p>
                <p className="text-xs text-gray-500 mb-3">
                  The identity attribute(s) each user access review is scoped by. One campaign is created per
                  distinct combination of their values, and the values appear in the campaign name in this
                  sequence — e.g. department then location gives the root name "Engineering - Austin", which the
                  Campaign Prefix and Suffix above then wrap.
                  The list comes from Schema Analysis's candidate attributes. With nothing chosen, the Role
                  Creation Priority Order{priorityKeys.length ? ` (${priorityKeys.join(" > ")})` : ""} is
                  used instead.
                </p>
                {analysisQuery.isLoading ? (
                  <div className="flex items-center justify-center py-4"><Spinner size={18} /></div>
                ) : candidates.length === 0 ? (
                  <div className="text-xs text-gray-500">
                    <p className="mb-2">Run Schema Analysis first — the attributes are chosen from its candidates.</p>
                    <OutlineButton onClick={() => navigate("/studio-settings/schema-analysis")} className="!w-auto">
                      Open Schema Analysis
                    </OutlineButton>
                  </div>
                ) : (
                  <>
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 mb-1.5">Sequence</p>
                    <div className="flex flex-col gap-2 mb-3">
                      {chosenKeys.length === 0 && (
                        <p className="text-sm text-gray-400">
                          No attributes selected — add one or more below. The Role Creation Priority Order will be used.
                        </p>
                      )}
                      {chosenKeys.map((key, i) => (
                        <div key={key} className="flex items-center gap-3 border border-gray-100 rounded-xl px-3 py-2.5">
                          <span className="w-6 h-6 rounded-full bg-violet-50 text-violet-600 text-xs font-semibold flex items-center justify-center flex-shrink-0">
                            {i + 1}
                          </span>
                          <span className="text-sm font-medium text-gray-900 flex-1 truncate">{key}</span>
                          <button
                            onClick={() => moveAttribute(i, -1)}
                            disabled={i === 0 || update.isPending}
                            title="Move up"
                            className="text-gray-400 hover:text-gray-700 disabled:opacity-30 disabled:hover:text-gray-400"
                          >
                            <ChevronUp size={16} />
                          </button>
                          <button
                            onClick={() => moveAttribute(i, 1)}
                            disabled={i === chosenKeys.length - 1 || update.isPending}
                            title="Move down"
                            className="text-gray-400 hover:text-gray-700 disabled:opacity-30 disabled:hover:text-gray-400"
                          >
                            <ChevronDown size={16} />
                          </button>
                          <button
                            onClick={() => removeAttribute(key)}
                            disabled={update.isPending}
                            title="Remove"
                            className="text-gray-400 hover:text-red-500 disabled:opacity-30"
                          >
                            <X size={16} />
                          </button>
                        </div>
                      ))}
                    </div>

                    <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 mb-1.5">Available attributes</p>
                    {availableCandidates.length === 0 ? (
                      <p className="text-sm text-gray-400">All candidate attributes are selected.</p>
                    ) : (
                      <div className="border border-gray-100 rounded-xl overflow-hidden">
                        {availableCandidates.map((c) => (
                          <div key={c.key} className="flex items-center gap-3 px-3 py-2.5 border-b border-gray-100 last:border-0">
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium text-gray-900 truncate">{c.key}</p>
                              <p className="text-xs text-gray-500">
                                {c.distinctValues} values · {Math.round((c.coverage || 0) * 100)}% coverage
                              </p>
                            </div>
                            <button
                              onClick={() => addAttribute(c.key)}
                              disabled={update.isPending}
                              className="flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-700 disabled:opacity-50 flex-shrink-0"
                            >
                              <Plus size={14} />
                              Add
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                    <p className="text-xs text-gray-500 mt-2">
                      {chosenKeys.length
                        ? <>Campaigns per combination of: <span className="font-medium text-gray-700">{chosenKeys.join(" > ")}</span></>
                        : "Nothing selected — the Role Creation Priority Order will be used."}
                    </p>
                  </>
                )}
              </div>

              <SettingBox
                title="Enable Notifications"
                help="Whether ISC emails reviewers when a campaign is activated, as it approaches its deadline, and when it closes."
              >
                <Select
                  value={prefs.certNotificationsEnabled ? "YES" : "NO"}
                  onChange={(e) => update.mutate({ certNotificationsEnabled: e.target.value === "YES" })}
                  disabled={update.isPending}
                >
                  <option value="YES">Yes</option>
                  <option value="NO">No</option>
                </Select>
              </SettingBox>

              <SettingBox
                title="Undecided Access"
                help="What happens to access a reviewer never makes a decision on by the deadline. Maintain keeps it; Revoke removes it automatically when the campaign closes."
              >
                <Select
                  value={prefs.certUndecidedAccess}
                  onChange={(e) => update.mutate({ certUndecidedAccess: e.target.value })}
                  disabled={update.isPending}
                >
                  {CERT_UNDECIDED_ACCESS_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </Select>
              </SettingBox>

              <SettingBox
                title="Require Comments"
                help="Whether reviewers must leave a comment: on no decisions, on every decision, or only when revoking access."
              >
                <Select
                  value={prefs.certCommentRequirement}
                  onChange={(e) => update.mutate({ certCommentRequirement: e.target.value })}
                  disabled={update.isPending}
                >
                  {CERT_COMMENT_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </Select>
              </SettingBox>

              <SettingBox
                title="Duration"
                help="How long reviewers have. The campaign deadline is set this far from the moment the draft is created."
              >
                <Select
                  value={String(prefs.certDurationDays)}
                  onChange={(e) => update.mutate({ certDurationDays: Number(e.target.value) })}
                  disabled={update.isPending}
                >
                  {CERT_DURATION_OPTIONS.map((o) => (
                    <option key={o.value} value={String(o.value)}>{o.label}</option>
                  ))}
                </Select>
              </SettingBox>

              <SettingBox
                title="Size Limit"
                help="The most access items (roles, access profiles and entitlements across all of its users) one campaign may contain. A draft that would exceed it is flagged as too large and not created — add another Certification Attribute to sub-divide it."
              >
                <div className="flex items-center gap-2">
                  <div className="flex-1">
                    <Input
                      type="text"
                      inputMode="numeric"
                      value={sizeLimit}
                      onChange={(e) => setSizeLimit(e.target.value)}
                      placeholder={String(CERT_DEFAULTS.certSizeLimit)}
                    />
                  </div>
                  <PrimaryButton
                    onClick={() => update.mutate({ certSizeLimit: sizeLimitNumber })}
                    loading={update.isPending}
                    disabled={!sizeLimitDirty || update.isPending}
                    className="!w-auto"
                  >
                    Save
                  </PrimaryButton>
                </div>
                {!sizeLimitValid && sizeLimit !== "" && (
                  <p className="text-xs text-red-600 mt-2">Enter a whole number from 1 to 1,000,000.</p>
                )}
                {sizeLimitValid && !sizeLimitDirty && (
                  <p className="text-xs text-gray-500 mt-2">Current limit: {Number(prefs.certSizeLimit ?? CERT_DEFAULTS.certSizeLimit).toLocaleString()} access items per campaign.</p>
                )}
              </SettingBox>
            </>
          )}
        </div>

        <SectionLabel bold>Campaign Filters</SectionLabel>
        <div className="px-4 space-y-3">
          <p className="text-xs text-gray-500">
            Access Item Types, Access Privilege and Metadata narrow which access items each campaign certifies; the Search Filter
            narrows which identities it covers. Include filters combine (an item must satisfy every one); an
            exclude filter removes its matches. Applied when a run is planned — item filters become the
            campaign's access constraints, the identity filter becomes part of its search query.
          </p>
          {prefsQuery.isLoading ? null : (
            <>
              <SettingBox
                title="Access Item Types"
                help="Which kinds of access each campaign certifies. All three selected means no type filter. At least one has to stay selected."
              >
                <div className="flex flex-wrap gap-x-6 gap-y-2">
                  {CERT_ACCESS_ITEM_TYPE_OPTIONS.map((o) => {
                    const checked = accessItemTypes.includes(o.value);
                    const lastOne = checked && accessItemTypes.length === 1;
                    return (
                      <label
                        key={o.value}
                        className={`flex items-center gap-2 text-sm text-gray-800 ${lastOne ? "opacity-60" : "cursor-pointer"}`}
                        title={lastOne ? "At least one access item type has to stay selected" : undefined}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleAccessItemType(o.value)}
                          disabled={lastOne || update.isPending}
                          className="w-4 h-4 rounded border-gray-300"
                        />
                        {o.label}
                      </label>
                    );
                  })}
                </div>

                <div className={`mt-4 pt-3 border-t border-gray-100 space-y-3 ${rolesChosen ? "" : "opacity-50"}`}>
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">
                    Role options{rolesChosen ? "" : " — select Roles to use these"}
                  </p>
                  <label className={`flex items-start gap-2.5 ${rolesChosen ? "cursor-pointer" : ""}`}>
                    <input
                      type="checkbox"
                      checked={!!prefs.certExcludeBirthrightRoles}
                      onChange={() => update.mutate({ certExcludeBirthrightRoles: !prefs.certExcludeBirthrightRoles })}
                      disabled={!rolesChosen || update.isPending}
                      className="w-4 h-4 mt-0.5 rounded border-gray-300"
                    />
                    <span>
                      <span className="block text-sm text-gray-800">Exclude Birthright Roles</span>
                      <span className="block text-xs text-gray-500 mt-0.5">
                        A birthright role is any role with a membership rule — people get it automatically by matching the rule, so there is
                        little for a reviewer to decide. Roles assigned to an explicit list of people, or by request, are not birthright and
                        stay in. If every role in the tenant has a membership rule, this removes all roles from the campaigns.
                      </span>
                    </span>
                  </label>
                  <label className={`flex items-start gap-2.5 ${rolesChosen && prefs.certExcludeBirthrightRoles ? "cursor-pointer" : "opacity-60"}`}>
                    <input
                      type="checkbox"
                      checked={!!prefs.certIncludeCommonAccessRoles}
                      onChange={() => update.mutate({ certIncludeCommonAccessRoles: !prefs.certIncludeCommonAccessRoles })}
                      disabled={!rolesChosen || !prefs.certExcludeBirthrightRoles || update.isPending}
                      className="w-4 h-4 mt-0.5 rounded border-gray-300"
                    />
                    <span>
                      <span className="block text-sm text-gray-800">Include Common Access Roles</span>
                      <span className="block text-xs text-gray-500 mt-0.5">
                        Common Access roles usually have a membership rule too, so excluding birthright roles would drop them with the rest.
                        Select this to keep them in the campaigns while other roles with membership rules are still excluded.
                        {prefs.certExcludeBirthrightRoles ? "" : " Only matters while Exclude Birthright Roles is on — without it, Common Access roles are already included."}
                      </span>
                    </span>
                  </label>
                </div>
              </SettingBox>

              <SettingBox
                title="Access Privilege"
                help="Add one filter per privilege level (ISC's privilege level on entitlements, roles and access profiles), each set to Include or Exclude. 'No Value Set for Privilege (null)' covers items with no privilege level at all, so you can keep or drop unclassified access explicitly. Items at any Include level are kept (an item needs only one of them); items at any Exclude level are removed — and Exclude wins where both apply. No filters means privilege is ignored."
              >
                {privilegeFilters.length > 0 && (
                  <div className="border border-gray-100 rounded-xl overflow-hidden mb-3">
                    {privilegeFilters.map((p) => (
                      <div key={p.level} className="flex items-center gap-3 px-3 py-2.5 border-b border-gray-100 last:border-0">
                        <ShieldAlert size={14} className="text-violet-600 flex-shrink-0" />
                        <p className="text-sm font-medium text-gray-900 flex-1 min-w-0 truncate">
                          {p.level === "NOT_SET" ? privilegeLabel(p.level) : `${privilegeLabel(p.level)} privilege`}
                        </p>
                        <select
                          value={p.mode === "EXCLUDE" ? "EXCLUDE" : "INCLUDE"}
                          onChange={(e) => setPrivilegeFilterMode(p, e.target.value)}
                          disabled={update.isPending}
                          title="Include or exclude items at this level"
                          className={`text-xs font-medium rounded-lg border px-2 py-1 outline-none flex-shrink-0 ${
                            p.mode === "EXCLUDE" ? "border-red-200 text-red-700 bg-red-50" : "border-emerald-200 text-emerald-700 bg-emerald-50"
                          }`}
                        >
                          <option value="INCLUDE">Include</option>
                          <option value="EXCLUDE">Exclude</option>
                        </select>
                        <button
                          onClick={() => removePrivilegeFilter(p)}
                          disabled={update.isPending}
                          title="Remove"
                          className="text-gray-400 hover:text-red-500 disabled:opacity-30"
                        >
                          <X size={16} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                {availablePrivilegeLevels.length === 0 ? (
                  <p className="text-xs text-gray-500">Every privilege level has a filter.</p>
                ) : (
                  <div className="flex flex-col md:flex-row gap-2">
                    <div className="flex-1">
                      <Select value={newPrivLevel} onChange={(e) => setNewPrivLevel(e.target.value)} disabled={update.isPending}>
                        <option value="">Choose a privilege level…</option>
                        {availablePrivilegeLevels.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </Select>
                    </div>
                    <div className="md:w-32">
                      <Select value={newPrivMode} onChange={(e) => setNewPrivMode(e.target.value)} disabled={update.isPending}>
                        <option value="INCLUDE">Include</option>
                        <option value="EXCLUDE">Exclude</option>
                      </Select>
                    </div>
                    <OutlineButton onClick={addPrivilegeFilter} disabled={!newPrivLevel || update.isPending} className="!w-auto">
                      <Plus size={14} />
                      Add
                    </OutlineButton>
                  </div>
                )}
                {privilegeFilters.length === 0 && (
                  <p className="text-xs text-gray-500 mt-2">No privilege filters — privilege level is ignored.</p>
                )}
              </SettingBox>

              <SettingBox
                title="Metadata Filter"
                help="Add as many Access Model Metadata attribute/value filters as needed, each set to Include or Exclude. Items tagged with any Include value are kept (an item needs only one of them); items tagged with any Exclude value are removed — and Exclude wins where both apply."
              >
                {metadataFilters.length > 0 && (
                  <div className="border border-gray-100 rounded-xl overflow-hidden mb-3">
                    {metadataFilters.map((p) => (
                      <div key={`${p.key}::${p.value}`} className="flex items-center gap-3 px-3 py-2.5 border-b border-gray-100 last:border-0">
                        <Tags size={14} className="text-violet-600 flex-shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-gray-900 truncate">{p.attributeName || p.key}: {p.valueName || p.value}</p>
                          <p className="text-xs text-gray-500 font-mono truncate">{p.key} = {p.value}</p>
                        </div>
                        <select
                          value={p.mode === "EXCLUDE" ? "EXCLUDE" : "INCLUDE"}
                          onChange={(e) => setMetadataFilterMode(p, e.target.value)}
                          disabled={update.isPending}
                          title="Include or exclude items tagged with this value"
                          className={`text-xs font-medium rounded-lg border px-2 py-1 outline-none flex-shrink-0 ${
                            p.mode === "EXCLUDE" ? "border-red-200 text-red-700 bg-red-50" : "border-emerald-200 text-emerald-700 bg-emerald-50"
                          }`}
                        >
                          <option value="INCLUDE">Include</option>
                          <option value="EXCLUDE">Exclude</option>
                        </select>
                        <button
                          onClick={() => removeMetadataFilter(p)}
                          disabled={update.isPending}
                          title="Remove"
                          className="text-gray-400 hover:text-red-500 disabled:opacity-30"
                        >
                          <X size={16} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex flex-col md:flex-row gap-2">
                  <div className="flex-1">
                    <Select
                      value={newMetaKey}
                      onChange={(e) => { setNewMetaKey(e.target.value); setNewMetaValue(""); }}
                      disabled={update.isPending || metaAttrsQuery.isLoading}
                    >
                      <option value="">{metaAttrsQuery.isLoading ? "Loading attributes…" : "Choose an attribute…"}</option>
                      {metaAttrs.map((a) => <option key={a.key} value={a.key}>{a.name || a.key}</option>)}
                    </Select>
                  </div>
                  <div className="flex-1">
                    <Select
                      value={newMetaValue}
                      onChange={(e) => setNewMetaValue(e.target.value)}
                      disabled={!newMetaKey || update.isPending || metaValuesQuery.isLoading}
                    >
                      <option value="">{!newMetaKey ? "Pick an attribute first" : metaValuesQuery.isLoading ? "Loading values…" : "Choose a value…"}</option>
                      {metaValues.map((v) => <option key={v.value} value={v.value}>{v.name || v.value}</option>)}
                    </Select>
                  </div>
                  <div className="md:w-32">
                    <Select value={newMetaMode} onChange={(e) => setNewMetaMode(e.target.value)} disabled={update.isPending}>
                      <option value="INCLUDE">Include</option>
                      <option value="EXCLUDE">Exclude</option>
                    </Select>
                  </div>
                  <OutlineButton
                    onClick={addMetadataFilter}
                    disabled={!newMetaKey || !newMetaValue || update.isPending}
                    className="!w-auto"
                  >
                    <Plus size={14} />
                    Add
                  </OutlineButton>
                </div>
                {metaAttrsQuery.error && <p className="text-xs text-red-600 mt-2">{metaAttrsQuery.error.response?.data?.error || metaAttrsQuery.error.message}</p>}
              </SettingBox>

              <SettingBox
                title="Search Filter (identities)"
                help={'An ISC Search query over identities that every campaign is limited to — combined with each campaign\'s own attribute query. Default attributes.cloudLifecycleState:active keeps reviews to active users; e.g. add AND attributes.department:"Sales". Leave blank to cover every identity.'}
              >
                <div className="flex flex-col md:flex-row gap-2">
                  <div className="flex-1">
                    <Input
                      type="text"
                      value={searchFilter}
                      onChange={(e) => setSearchFilter(e.target.value)}
                      placeholder={CERT_DEFAULTS.certSearchFilter}
                      spellCheck={false}
                    />
                  </div>
                  <div className="md:w-44">
                    <Select
                      value={prefs.certSearchMode}
                      onChange={(e) => update.mutate({ certSearchMode: e.target.value })}
                      disabled={update.isPending}
                    >
                      {CERT_IDENTITY_FILTER_MODE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </Select>
                  </div>
                  <PrimaryButton
                    onClick={() => update.mutate({ certSearchFilter: searchFilter.trim() })}
                    loading={update.isPending}
                    disabled={!searchFilterDirty || update.isPending}
                    className="!w-auto"
                  >
                    Save
                  </PrimaryButton>
                </div>
                {!searchFilterDirty && (
                  <p className="text-xs text-gray-500 mt-2">
                    {prefs.certSearchFilter ? <>Current: <span className="font-mono">{prefs.certSearchFilter}</span></> : "No identity filter — every identity in scope is covered."}
                  </p>
                )}
              </SettingBox>

              <SettingBox
                title="Included Sources"
                help="Campaigns only certify access profiles and entitlements that come from the selected sources. Every source is selected by default, and a source added to the tenant later is included automatically. Roles aren't tied to a source, so this never removes a role — use Access Item Types for that."
              >
                {sourcesQuery.isLoading ? (
                  <div className="flex items-center justify-center py-4"><Spinner size={18} /></div>
                ) : sourcesQuery.error ? (
                  <p className="text-xs text-red-600">Couldn't load the tenant's sources: {sourcesQuery.error.response?.data?.error || sourcesQuery.error.message}</p>
                ) : allSources.length === 0 ? (
                  <p className="text-sm text-gray-400">This tenant has no sources.</p>
                ) : (
                  <>
                    <div className="flex items-center gap-3 flex-wrap mb-2">
                      <p className="text-xs text-gray-500">
                        <span className="font-medium text-gray-800">{allSources.length - allSources.filter((s) => excludedSourceIds.has(s.id)).length}</span> of {allSources.length} sources included
                      </p>
                      <div className="flex items-center gap-3 ml-auto text-xs">
                        <button type="button" onClick={() => setShownSources(true)} disabled={update.isPending} className="text-blue-600 hover:underline disabled:opacity-50">
                          Select all{sourceSearch.trim() ? " shown" : ""}
                        </button>
                        <button type="button" onClick={() => setShownSources(false)} disabled={update.isPending} className="text-blue-600 hover:underline disabled:opacity-50">
                          Clear all{sourceSearch.trim() ? " shown" : ""}
                        </button>
                      </div>
                    </div>
                    {allSources.length > 8 && (
                      <div className="mb-2">
                        <Input value={sourceSearch} onChange={(e) => setSourceSearch(e.target.value)} placeholder="Filter sources by name…" aria-label="Filter sources" />
                      </div>
                    )}
                    <div className="border border-gray-100 rounded-xl divide-y divide-gray-100 max-h-72 overflow-y-auto">
                      {shownSources.length === 0 && <p className="text-sm text-gray-400 px-3 py-3">No sources match "{sourceSearch}".</p>}
                      {shownSources.map((s) => (
                        <label key={s.id} className="flex items-center gap-2.5 px-3 py-2 cursor-pointer hover:bg-gray-50">
                          <input
                            type="checkbox"
                            checked={!excludedSourceIds.has(s.id)}
                            onChange={() => toggleSource(s)}
                            disabled={update.isPending}
                            className="w-4 h-4 rounded border-gray-300 flex-shrink-0"
                          />
                          <Database size={13} className="text-gray-400 flex-shrink-0" />
                          <span className="text-sm text-gray-900 truncate flex-1 min-w-0">{s.name}</span>
                          <span className="text-[10px] text-gray-400 flex-shrink-0 truncate max-w-[40%]">{s.connectorName || s.type}</span>
                        </label>
                      ))}
                    </div>
                    {allSources.every((s) => excludedSourceIds.has(s.id)) && (
                      <p className="text-xs text-amber-700 mt-2">
                        No source is included, so campaigns will contain no access profiles or entitlements — only roles, if Roles is a chosen Access Item Type.
                      </p>
                    )}
                    {staleExcluded.length > 0 && (
                      <p className="text-xs text-gray-500 mt-2">
                        Also deselected, but no longer in this tenant: {staleExcluded.map((x) => x.name || x.id).join(", ")}.{" "}
                        <button
                          type="button"
                          onClick={() => update.mutate({ certExcludedSources: excludedSources.filter((x) => allSources.some((s) => s.id === x.id)) })}
                          className="text-blue-600 hover:underline"
                        >
                          Forget {staleExcluded.length === 1 ? "it" : "them"}
                        </button>
                      </p>
                    )}
                  </>
                )}
              </SettingBox>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
