import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock, CheckCircle2, XCircle, Users2, ShieldPlus, X, User, Key, Printer, AlertTriangle, Wand2, ArrowLeft, Settings } from "lucide-react";
import {
  startRoleScan, listRoleScans, getRoleScan, cancelRoleScan, deleteRoleScan, createRoleForPeerGroup,
  getIdentity, getCredentials, getTenantSettings, getSchemaAnalysis, generateRoleScanDescriptions,
  mergeRoleGroupIntoExisting,
} from "../../lib/sailpoint";
import { printRoleScanPdf } from "../../lib/exportRoleScanPdf";
import { roleCriteriaText, proposedRoleName, displayRoleName, applyRoleNaming } from "../../lib/roleNaming";
import {
  ATTRIBUTE_LABELS, DEFAULT_PEER_GROUP_ATTRIBUTE_KEYS, summarizeGroup, isDynamicGroup, sortScanGroups, creatableScanGroups,
} from "../../lib/roleScanCreate";
import { useAuth } from "../../hooks/useAuth";
import { TopBar } from "../../components/TopBar";
import { RoleMiningTitleMenu } from "../../components/RoleMiningTitleMenu";
import { Avatar, PrimaryButton, OutlineButton, EmptyState, Spinner, Field, Input, Textarea, InfoRow, ErrorBox, IconButton } from "../../components/ui";
import { STATUS_META, ScanListItem, ScanMasterDetail, ScanListRow } from "./shared";
import toast from "react-hot-toast";

function DetailSheet({ title, icon: Icon, onClose, children }) {
  return (
    <div className="fixed inset-0 bg-black/30 z-30 flex items-end md:items-center justify-center" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="bg-white w-full max-w-2xl md:mx-4 rounded-t-2xl md:rounded-2xl shadow-xl max-h-[80vh] flex flex-col">
        <div className="flex justify-center pt-3 pb-1">
          <div className="w-10 h-1 bg-gray-200 rounded-full" />
        </div>
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
          <h2 className="text-base font-semibold text-gray-900 flex items-center gap-2">
            <Icon size={18} className="text-gray-500" />
            {title}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={20} /></button>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-4">{children}</div>
      </div>
    </div>
  );
}

function IdentitySummarySheet({ id, onClose }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["identity", id],
    queryFn: () => getIdentity(id),
  });
  const attrs = data?.attributes || {};

  return (
    <DetailSheet title="Identity" icon={User} onClose={onClose}>
      {isLoading && <div className="flex items-center justify-center py-10"><Spinner /></div>}
      {error && <ErrorBox message={error.message} />}
      {data && (
        <>
          <div className="flex items-center gap-3 mb-4">
            <Avatar name={data.name} />
            <div className="min-w-0">
              <h3 className="text-base font-semibold text-gray-900 truncate">{data.name}</h3>
              {attrs.jobTitle && <p className="text-xs text-gray-500 truncate">{attrs.jobTitle}</p>}
            </div>
          </div>
          <div className="border border-gray-100 rounded-xl overflow-hidden">
            <InfoRow label="Email" value={data.emailAddress || attrs.email} />
            <InfoRow label="Department" value={attrs.department} />
            <InfoRow label="Location" value={attrs.location} />
            <InfoRow label="Manager" value={data.managerRef?.name} />
            <InfoRow label="Lifecycle state" value={attrs.cloudLifecycleState} />
            <InfoRow label="Identity ID" value={data.id} />
          </div>
        </>
      )}
    </DetailSheet>
  );
}


// The same entitlement name can legitimately exist on two different
// sources, so scan reports group entitlements by source rather than
// showing a flat list — the grouping itself disambiguates, so individual
// items just show their bare name. Entitlements from scans persisted
// before source resolution existed fall into "Entitlements".
function groupEntitlementsBySource(entitlements) {
  const map = new Map();
  for (const e of entitlements || []) {
    const key = e.source || "Entitlements";
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(e);
  }
  return [...map.entries()]
    .map(([source, ents]) => [source, [...ents].sort((a, b) => (a.name || "").localeCompare(b.name || ""))])
    .sort((a, b) => a[0].localeCompare(b[0]));
}



// Grounds the AI description prompt in exactly what this peer group would
// actually become as a role — same shape as the server's own
// generateRoleDescriptionText facts for an existing role, built client-side
// since this group doesn't exist as a role yet (nothing to fetch from ISC).
function buildGroupFacts(group, name, attributeKeys) {
  if (group.isCommonAccessScope) {
    return {
      facts: [
        `Role name: ${name}`,
        "Type: Standard, flagged as ISC Common Access",
        "Membership: Automatically assigned to every identity in this scan's scope.",
        `Entitlements (${group.commonAccess.length}, held by every identity in scope): ${group.commonAccess.map((e) => e.name).join(", ") || "none"}`,
      ],
      dimensional: false,
    };
  }
  const matchedKeys = new Set((group.attributeCriteria || []).map((c) => c.key));
  const varyingKeys = attributeKeys.filter((k) => !matchedKeys.has(k));
  const facts = [
    `Role name: ${name}`,
    `Type: ${varyingKeys.length > 0 ? "Dynamic (dimensional)" : "Standard"}`,
    `Membership: Automatically assigned to active identities where ${
      (group.attributeCriteria || []).map((c) => `${c.key} = "${c.value}"`).join(" and ") || "no specific criteria"
    }.`,
    `Base entitlements (${group.commonAccess.length}): ${group.commonAccess.map((e) => e.name).join(", ") || "none"}`,
  ];
  if (varyingKeys.length > 0) {
    facts.push(`Dimensions (one per distinct value of ${varyingKeys.join(", ")}, each adds entitlements on top of the base):`);
    for (const d of group.dimensionPreview || []) {
      facts.push(`  - ${d.attribute}=${d.value}: ${(d.entitlements || []).map((e) => e.name).join(", ") || "no additional entitlements"}`);
    }
  }
  return { facts, dimensional: varyingKeys.length > 0 };
}

function PeerGroupCard({ scanId, group, attributeKeys, rolePrefix, roleSuffix, attributeSeparator, currentAllowDuplicateRoles }) {
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  // Every candidate attribute the group didn't match on becomes a dimension
  // — this is exactly what create-role builds as a Dynamic (dimensional)
  // role server-side; a match on every attribute the scan used leaves
  // nothing to vary.
  const matchedKeys = new Set((group.attributeCriteria || []).map((c) => c.key));
  // The Common Access scope proposal is always Standard — see buildGroupFacts above.
  const varyingKeys = group.isCommonAccessScope ? [] : attributeKeys.filter((k) => !matchedKeys.has(k));
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(() => proposedRoleName(group, rolePrefix, roleSuffix, attributeSeparator));
  const [description, setDescription] = useState(() => summarizeGroup(group, attributeKeys));
  const [selectedMemberId, setSelectedMemberId] = useState(null);

  const createRole = useMutation({
    mutationFn: () =>
      createRoleForPeerGroup(scanId, group.id, {
        name,
        description,
        ownerId: session?.identity?.id,
        ownerName: session?.identity?.username,
      }),
    onSuccess: (data) => {
      const failedDimensions = (data.dimensions || []).filter((d) => !d.ok);
      if (data.role.dimensional) {
        toast.success(
          failedDimensions.length
            ? `Dynamic role "${name}" created with ${data.dimensions.length - failedDimensions.length}/${data.dimensions.length} dimensions (some failed)`
            : `Dynamic role "${name}" created with ${data.dimensions.length} dimensions`
        );
      } else {
        toast.success(`Role "${name}" created`);
      }
      // The server already flags a Common Access proposal in ISC right
      // after creating it — this used to fail silently (server-console-only)
      // whenever ISC's own beta Common Access API rejected the call, so the
      // role just quietly never showed up as Common Access with no
      // indication anything went wrong. Surfaced here instead — the role
      // itself is still created fine, it just needs the flag applied
      // manually in ISC's own UI (Admin > Access Model > Roles > Common
      // Access) if this happened.
      if (group.isCommonAccessScope && !data.commonAccessFlagged) {
        toast.error(
          `"${name}" was created, but couldn't be flagged as Common Access in ISC` +
          (data.commonAccessError ? `: ${data.commonAccessError}` : "") +
          " — flag it manually in ISC's own UI (Admin > Access Model > Roles > Common Access).",
          { duration: 8000 }
        );
      }
      setEditing(false);
      queryClient.invalidateQueries({ queryKey: ["roleScan", scanId] });
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const mergeMutation = useMutation({
    mutationFn: () => mergeRoleGroupIntoExisting(scanId, group.id),
    onSuccess: (data) => {
      toast.success(
        data.addedCount > 0
          ? `Merged ${data.addedCount} entitlement${data.addedCount === 1 ? "" : "s"} into "${data.roleName}"`
          : `"${data.roleName}" already has all of this group's proposed access`
      );
      queryClient.invalidateQueries({ queryKey: ["roleScan", scanId] });
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  return (
    <div className="px-4 py-4">
      <div className="flex items-center gap-2 mb-1">
        <Users2 size={16} className="text-violet-600 flex-shrink-0" />
        <p className="text-sm font-semibold text-gray-900">
          {displayRoleName(group, attributeSeparator)}
        </p>
      </div>
      <p className="text-xs text-gray-500 mb-2">
        {group.members.length} members · {group.commonAccess.length} shared entitlements
      </p>

      {group.attributeCriteria?.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {group.attributeCriteria.map(({ key, value, isBoundary }) => (
            <span
              key={key}
              className={`text-xs px-2 py-1 rounded-full border ${
                isBoundary
                  ? "bg-amber-50 text-amber-700 border-amber-200"
                  : "bg-blue-50 text-blue-700 border-blue-100"
              }`}
            >
              {key.replace(/([a-z])([A-Z])/g, "$1 $2")}: {value}
            </span>
          ))}
        </div>
      )}

      {/* An in-app detail sheet, not a target="_blank" link: the native
          iOS/Android WebView has no browser chrome for a new tab to open in,
          and even on web a new tab can't reliably inherit the signed-in
          session (browsers don't consistently clone sessionStorage across
          tabs), so it kept bouncing through the login screen. A same-page
          modal sidesteps both problems. Skipped for the Common Access scope
          proposal — its "members" are every identity in the scan's scope,
          which can be hundreds of pills for no real benefit here. */}
      {!group.isCommonAccessScope && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {group.members.map((m) => (
            <button
              key={m.id}
              onClick={() => setSelectedMemberId(m.id)}
              className="text-xs bg-gray-100 text-gray-700 px-2 py-1 rounded-full hover:bg-gray-200 transition-colors"
            >
              {m.name}
            </button>
          ))}
        </div>
      )}

      <div className="mb-3 space-y-1.5">
        {groupEntitlementsBySource(group.commonAccess).map(([source, ents]) => (
          <div key={source}>
            <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-1">{source}</p>
            <div className="flex flex-wrap gap-1.5">
              {ents.map((e) => (
                <button
                  key={e.id}
                  onClick={() => navigate(`/entitlements/${e.id}`)}
                  className="text-xs bg-violet-50 text-violet-700 border border-violet-100 px-2 py-1 rounded-full hover:bg-violet-100 transition-colors"
                >
                  {e.name}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      {selectedMemberId && (
        <IdentitySummarySheet id={selectedMemberId} onClose={() => setSelectedMemberId(null)} />
      )}

      {group.roleCreated ? (
        <div className="bg-emerald-50 border border-emerald-100 rounded-lg px-3 py-2">
          <div className="flex items-start gap-2 text-xs text-emerald-700">
            <CheckCircle2 size={14} className="flex-shrink-0 mt-0.5" />
            <span>
              {group.roleCreated.dimensional ? "Dynamic role" : "Role"}{" "}
              <button
                type="button"
                onClick={() => navigate(`/roles/${group.roleCreated.id}`)}
                className="underline font-medium"
              >
                "{group.roleCreated.name}"
              </button>{" "}
              created{" "}
              {new Date(group.roleCreated.createdAt).toLocaleDateString()}
              {group.roleCreated.dimensional && (
                <>
                  {" "}— dimensioned by {(group.roleCreated.dimensionAttributes || []).join(" and ")} (
                  {(group.roleCreated.dimensions || []).filter((d) => d.ok).length} of{" "}
                  {(group.roleCreated.dimensions || []).length} values)
                </>
              )}
            </span>
          </div>
          {group.roleCreated.dimensional && (group.roleCreated.dimensionAttributes || []).map((attrKey) => {
            const dims = (group.roleCreated.dimensions || []).filter((d) => d.attribute === attrKey);
            if (dims.length === 0) return null;
            return (
              <div key={attrKey} className="mt-2">
                <p className="text-[11px] font-semibold text-emerald-600 uppercase tracking-wide pl-1">{attrKey}</p>
                <div className="mt-1 pl-1 space-y-1.5">
                  {dims.map((d) => {
                    const dimMembers = group.members.filter((m) => m[attrKey] === d.value);
                    return (
                      <div key={d.value} className="text-xs">
                        <div className="flex items-center gap-1.5">
                          {d.ok
                            ? <CheckCircle2 size={11} className="text-emerald-600 flex-shrink-0" />
                            : <XCircle size={11} className="text-red-500 flex-shrink-0" />}
                          <span className="font-medium text-gray-700">{d.value}</span>
                          <span className="text-gray-400">
                            {dimMembers.length} member{dimMembers.length === 1 ? "" : "s"}
                          </span>
                          {!d.ok && <span className="text-red-500">— {d.error || "failed to create"}</span>}
                        </div>
                        {dimMembers.length > 0 && (
                          <p className="text-gray-400 pl-[18px] truncate">
                            {dimMembers.map((m) => m.name).join(", ")}
                          </p>
                        )}
                        {d.entitlements?.length > 0 && (
                          <div className="pl-[18px]">
                            {groupEntitlementsBySource(d.entitlements).map(([source, ents]) => (
                              <div key={source} className="mb-0.5">
                                <p className="text-violet-300 text-[10px] uppercase tracking-wide">{source}</p>
                                {ents.map((e) => (
                                  <button
                                    key={e.id}
                                    type="button"
                                    onClick={() => navigate(`/entitlements/${e.id}`)}
                                    className="block text-violet-500 hover:underline text-left"
                                  >
                                    + {e.name}
                                  </button>
                                ))}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      ) : editing ? (
        <div className="bg-gray-50 rounded-xl p-3">
          <Field label="Role name">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Description">
            <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional" />
          </Field>
          <div className="flex gap-2">
            <PrimaryButton onClick={() => createRole.mutate()} loading={createRole.isPending}>
              Confirm
            </PrimaryButton>
            <OutlineButton onClick={() => setEditing(false)} disabled={createRole.isPending}>
              Cancel
            </OutlineButton>
          </div>
        </div>
      ) : (
        <>
          {varyingKeys.length > 0 && (
            <div className="bg-emerald-50 border border-emerald-100 rounded-lg px-3 py-2 mb-2">
              <p className="text-xs text-emerald-700">
                Will be created as a Dynamic role, dimensioned by {varyingKeys.join(" and ")} —
                the attribute{varyingKeys.length === 1 ? "" : "s"} that vary among its members:
              </p>
              {varyingKeys.map((key) => (
                <div key={key} className="mt-2">
                  <p className="text-[11px] font-semibold text-emerald-600 uppercase tracking-wide pl-1">{key}</p>
                  <div className="mt-1 pl-1 space-y-1.5">
                    {(() => {
                      // Values are sourced from dimensionPreview (every value
                      // seen anywhere in the scan's scanned population) when
                      // present, so a value with zero members in this
                      // specific group still shows up here. Older scans
                      // predate dimensionPreview and fall back to deriving
                      // values from this group's own members only.
                      const keyPreviews = (group.dimensionPreview || []).filter((d) => d.attribute === key);
                      const byMember = group.members.reduce((acc, m) => {
                        const value = m[key] || "Unknown";
                        (acc[value] ||= []).push(m);
                        return acc;
                      }, {});
                      const values = keyPreviews.length
                        ? keyPreviews.map((d) => d.value)
                        : Object.keys(byMember);
                      return values.map((value) => {
                        const dimMembers = byMember[value] || [];
                        return { value, dimMembers };
                      });
                    })().map(({ value, dimMembers }) => (
                      <div key={value} className="text-xs">
                        <div className="flex items-center gap-1.5">
                          <span className="font-medium text-gray-700">{value}</span>
                          <span className="text-gray-400">
                            {dimMembers.length} member{dimMembers.length === 1 ? "" : "s"}
                          </span>
                        </div>
                        <p className="text-gray-400 pl-[2px] truncate">
                          {dimMembers.length
                            ? dimMembers.map((m) => m.name).join(", ")
                            : "no members yet"}
                        </p>
                        {/* What this dimension will actually grant, computed
                            during the scan so it's visible before committing.
                            Older scans predate it and simply omit the line. */}
                        {(() => {
                          const preview = (group.dimensionPreview || []).find(
                            (d) => d.attribute === key && d.value === value
                          );
                          if (!preview) return null;
                          return preview.entitlements.length ? (
                            <div className="pl-[2px]">
                              {groupEntitlementsBySource(preview.entitlements).map(([source, ents]) => (
                                <div key={source} className="mb-0.5">
                                  <p className="text-violet-300 text-[10px] uppercase tracking-wide">{source}</p>
                                  {ents.map((e) => (
                                  <button
                                    key={e.id}
                                    type="button"
                                    onClick={() => navigate(`/entitlements/${e.id}`)}
                                    className="block text-violet-500 hover:underline text-left"
                                  >
                                    + {e.name}
                                  </button>
                                ))}
                                </div>
                              ))}
                            </div>
                          ) : (
                            <p className="text-gray-300 pl-[2px]">
                              no entitlements unique to this dimension
                            </p>
                          );
                        })()}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
          {group.existingRole && (
            <button
              onClick={() => navigate(`/role-mining/roles/${group.existingRole.id}`)}
              className="w-full text-left bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-2 hover:bg-amber-100 transition-colors"
            >
              <p className="text-xs text-amber-800">
                <AlertTriangle size={12} className="inline mr-1 -mt-0.5" />
                {group.isCommonAccessScope ? (
                  <>
                    Common access for this scope is already provided by:{" "}
                    <span className="font-medium">{group.existingRole.name}</span>
                    {!group.existingRole.enabled && " (disabled)"} — not proposing a new one. Tap to view.
                  </>
                ) : (
                  <>
                    A role with this exact attribute combination already exists:{" "}
                    <span className="font-medium">{group.existingRole.name}</span>
                    {!group.existingRole.enabled && " (disabled)"} — creating another would duplicate it. Tap to view.
                  </>
                )}
              </p>
            </button>
          )}

          {/* Duplicates off + a real match: creating another role isn't
              offered (the server itself refuses it too — see the
              create-role route's own guard), so the only path forward for
              a regular peer group is folding its proposed access into the
              role that already exists. Common Access has nothing computed
              to merge here (see runRoleScan) — its existingRole banner
              above is informational only, same as always. */}
          {group.existingRole && !group.isCommonAccessScope && !currentAllowDuplicateRoles && (
            group.mergedIntoExisting ? (
              <div className="bg-emerald-50 border border-emerald-100 rounded-lg px-3 py-2">
                <p className="text-xs text-emerald-700 flex items-start gap-1.5">
                  <CheckCircle2 size={13} className="flex-shrink-0 mt-0.5" />
                  <span>
                    {group.mergedIntoExisting.addedCount > 0
                      ? `Merged ${group.mergedIntoExisting.addedCount} entitlement${group.mergedIntoExisting.addedCount === 1 ? "" : "s"} into `
                      : ""}
                    <button
                      type="button"
                      onClick={() => group.existingRole?.id && navigate(`/roles/${group.existingRole.id}`)}
                      className="underline font-medium"
                    >
                      "{group.mergedIntoExisting.roleName}"
                    </button>
                    {group.mergedIntoExisting.addedCount > 0 ? "" : " already had all of this group's proposed access"}{" "}
                    {new Date(group.mergedIntoExisting.mergedAt).toLocaleDateString()}
                  </span>
                </p>
              </div>
            ) : group.commonAccess.length > 0 ? (
              <OutlineButton onClick={() => mergeMutation.mutate()} loading={mergeMutation.isPending}>
                <ShieldPlus size={16} />
                Merge into Existing Role
              </OutlineButton>
            ) : (
              <p className="text-xs text-gray-400">No new access proposed to merge into the existing role.</p>
            )
          )}

          {/* Unlike a regular peer group (existingRole there is just a
              warning when duplicates are allowed — the user can still
              choose to create a duplicate), Common Access explicitly
              shouldn't propose a new role once an existing one already
              covers this scope, and a regular peer group's duplicate is
              only offered when Allow Duplicate Roles is currently on (see
              the merge action above for the off case). */}
          {!(group.existingRole && (group.isCommonAccessScope || !currentAllowDuplicateRoles)) && (
            <OutlineButton onClick={() => setEditing(true)}>
              <ShieldPlus size={16} />
              {group.isCommonAccessScope ? "Create Common Access Role" : "Create This Role"}
            </OutlineButton>
          )}
        </>
      )}
    </div>
  );
}

// Prompts for a name prefix/suffix, then creates a Role for every eligible
// group in the scan (skipping groups that already have a role, or that have
// no shared entitlements to provision — same requirement create-role itself
// enforces). Created sequentially rather than in parallel so a rate limit or
// a single failure doesn't take down the rest, and so progress is easy to
// show as it goes.
function BulkCreateRolesSheet({ scanId, groups, attributeKeys, defaultRolePrefix, defaultRoleSuffix, attributeSeparator, onClose, onDone }) {
  const { session } = useAuth();
  // Pre-filled from the tenant's persisted Role Naming (Configuration), but
  // editable here as a one-off override for this batch only.
  const [prefix, setPrefix] = useState(defaultRolePrefix || "");
  const [suffix, setSuffix] = useState(defaultRoleSuffix || "");
  const [progress, setProgress] = useState(0);
  // null while still configuring prefix/suffix; once populated (by
  // Generate descriptions), the list of proposed names + AI descriptions
  // the user reviews before anything is actually created.
  const [proposals, setProposals] = useState(null); // [{group, name, description, descriptionError}] | null

  const namedGroups = groups.map((group) => ({
    group,
    name: applyRoleNaming(roleCriteriaText(group, attributeSeparator), prefix, suffix),
  }));

  const generateDescriptions = useMutation({
    mutationFn: async () => {
      const items = namedGroups.map(({ group, name }) => {
        const { facts, dimensional } = buildGroupFacts(group, name, attributeKeys);
        return { key: group.id, name, facts, dimensional };
      });
      const { results } = await generateRoleScanDescriptions(items);
      const byKey = new Map(results.map((r) => [r.key, r]));
      return namedGroups.map(({ group, name }) => {
        const result = byKey.get(group.id);
        return {
          group,
          name,
          description: result?.description || summarizeGroup(group, attributeKeys),
          descriptionError: result?.error || null,
        };
      });
    },
    onSuccess: (rows) => setProposals(rows),
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  // Same review step as Generate Descriptions leads to, just skipping the
  // AI call entirely — each row starts with the same plain auto-generated
  // summary AI would have fallen back to on its own failure anyway.
  function skipDescriptions() {
    setProposals(namedGroups.map(({ group, name }) => ({
      group, name, description: summarizeGroup(group, attributeKeys), descriptionError: null,
    })));
  }

  const bulkCreate = useMutation({
    mutationFn: async (rows) => {
      const results = [];
      for (const { group, name, description } of rows) {
        try {
          const data = await createRoleForPeerGroup(scanId, group.id, {
            name,
            description,
            ownerId: session?.identity?.id,
            ownerName: session?.identity?.username,
          });
          results.push({ group, name, ok: true, data });
        } catch (err) {
          results.push({ group, name, ok: false, error: err.response?.data?.error || err.message });
        }
        setProgress(results.length);
      }
      return results;
    },
    onSuccess: (results) => {
      const failed = results.filter((r) => !r.ok);
      if (failed.length) {
        toast.error(`Created ${results.length - failed.length} of ${results.length} roles — ${failed.length} failed`);
      } else {
        toast.success(`Created ${results.length} role${results.length === 1 ? "" : "s"}`);
      }
      // Same flag-failure surfacing as the single-role create above — a
      // Common Access proposal that ISC's own beta API refused to flag
      // used to only ever show up in the server console.
      const unflagged = results.filter((r) => r.ok && r.group.isCommonAccessScope && !r.data.commonAccessFlagged);
      if (unflagged.length) {
        toast.error(
          `${unflagged.length} Common Access role${unflagged.length === 1 ? "" : "s"} created but couldn't be flagged as Common Access in ` +
          `ISC — flag ${unflagged.length === 1 ? "it" : "them"} manually in ISC's own UI (Admin > Access Model > Roles > Common Access): ` +
          unflagged.map((r) => r.name).join(", "),
          { duration: 10000 }
        );
      }
      onDone();
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  if (proposals) {
    return (
      <DetailSheet title="Review & Create" icon={ShieldPlus} onClose={onClose}>
        <p className="text-sm text-gray-600 mb-4">
          Descriptions were generated with AI, grounded in each peer group's actual entitlements — review
          before creating. Nothing has been created yet.
        </p>
        <div className="space-y-3 mb-4">
          {proposals.map(({ group, name, description, descriptionError }) => (
            <div key={group.id} className="border border-gray-100 rounded-xl px-3 py-2.5">
              <p className="text-sm font-medium text-gray-900 mb-1">{name}</p>
              <Textarea
                rows={2}
                value={description}
                onChange={(e) =>
                  setProposals((prev) => prev.map((p) => (p.group.id === group.id ? { ...p, description: e.target.value } : p)))
                }
                disabled={bulkCreate.isPending}
              />
              {descriptionError && (
                <p className="text-xs text-amber-600 mt-1">
                  AI generation failed ({descriptionError}) — using the auto-generated summary instead.
                </p>
              )}
            </div>
          ))}
        </div>
        {bulkCreate.isPending && (
          <p className="text-xs text-gray-500 mb-3">Creating {progress} of {proposals.length}…</p>
        )}
        <div className="flex gap-2">
          <PrimaryButton onClick={() => bulkCreate.mutate(proposals)} loading={bulkCreate.isPending}>
            Create {proposals.length} Role{proposals.length === 1 ? "" : "s"}
          </PrimaryButton>
          <OutlineButton onClick={() => setProposals(null)} disabled={bulkCreate.isPending}>
            <ArrowLeft size={16} />
            Back
          </OutlineButton>
        </div>
      </DetailSheet>
    );
  }

  return (
    <DetailSheet title="Create All Roles" icon={ShieldPlus} onClose={onClose}>
      <p className="text-sm text-gray-600 mb-4">
        Creates a Role for all {groups.length} peer group{groups.length === 1 ? "" : "s"} on this
        page that don't already have one. Prefix and suffix are added to each group's default name.
      </p>
      <Field label="Prefix">
        <Input
          value={prefix}
          onChange={(e) => setPrefix(e.target.value)}
          placeholder='Optional, e.g. "DRAFT - "'
          disabled={generateDescriptions.isPending}
        />
      </Field>
      <Field label="Suffix">
        <Input
          value={suffix}
          onChange={(e) => setSuffix(e.target.value)}
          placeholder='Optional, e.g. " (Q3)"'
          disabled={generateDescriptions.isPending}
        />
      </Field>

      {namedGroups.length > 0 && (
        <div className="mb-3">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1.5">
            Roles to be created ({namedGroups.length})
          </p>
          <div className="border border-gray-100 rounded-xl overflow-hidden max-h-40 overflow-y-auto">
            {namedGroups.map(({ group, name }, i) => (
              <div
                key={group.id}
                className={`px-3 py-2 text-sm text-gray-700 truncate ${i < namedGroups.length - 1 ? "border-b border-gray-100" : ""}`}
              >
                {name}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex gap-2">
        <PrimaryButton
          onClick={() => generateDescriptions.mutate()}
          loading={generateDescriptions.isPending}
          disabled={groups.length === 0}
        >
          <Wand2 size={16} />
          Generate Descriptions
        </PrimaryButton>
        <OutlineButton
          onClick={skipDescriptions}
          disabled={generateDescriptions.isPending || groups.length === 0}
        >
          Skip & Review
        </OutlineButton>
      </div>
      <OutlineButton onClick={onClose} disabled={generateDescriptions.isPending} className="mt-2">
        Cancel
      </OutlineButton>
    </DetailSheet>
  );
}

export function RoleScanDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [bulkCreateOpen, setBulkCreateOpen] = useState(false);
  // Which proposed role the md-and-up right-hand pane is showing. Only that
  // layout reads it — below md every group renders its own card, so there's
  // nothing to select.
  const [selectedGroupId, setSelectedGroupId] = useState(null);

  const { data: scan, isLoading } = useQuery({
    queryKey: ["roleScan", id],
    queryFn: () => getRoleScan(id),
    refetchInterval: (query) => (query.state.data?.status === "running" ? 3000 : false),
  });

  // Role naming prefix/suffix reflects the tenant's current Configuration —
  // unlike attributeKeys/createDynamicRoles, this only affects the name
  // proposed at create-role time, not how the scan grouped identities, so
  // there's nothing to lock in at scan time.
  const settingsQuery = useQuery({
    queryKey: ["tenant-settings"],
    queryFn: getTenantSettings,
  });
  const rolePrefix = settingsQuery.data?.rolePrefix || "";
  const roleSuffix = settingsQuery.data?.roleSuffix || "";
  // Nullish (not ||) so a deliberately empty/whitespace-only separator isn't
  // replaced by the default — only "not loaded yet" falls back to it.
  const attributeSeparator = settingsQuery.data?.attributeSeparator ?? " - ";

  if (isLoading || !scan) {
    return (
      <div className="flex flex-col min-h-screen bg-white">
        <TopBar title="Role Model Draft" onBack={() => navigate("/role-mining/scan-for-roles")} />
        <div className="flex-1 flex items-center justify-center"><Spinner size={24} /></div>
      </div>
    );
  }

  const meta = STATUS_META[scan.status] || STATUS_META.running;
  const StatusIcon = meta.icon;
  // The attribute priority this scan actually grouped by — persisted on the
  // scan record so it stays correct even if Schema Analysis is re-run or
  // reordered afterward. Older scans predating that field fall back to the
  // server's own default.
  const attributeKeys = scan.attributeKeys?.length ? scan.attributeKeys : DEFAULT_PEER_GROUP_ATTRIBUTE_KEYS;
  // Common Access first, then Dynamic, then by name — see sortScanGroups.
  const isDynamic = (g) => isDynamicGroup(g, attributeKeys);
  const groups = sortScanGroups(scan.groups, attributeKeys);
  // Falls back to the first group so the desktop detail pane always has
  // something to show, and so a selection that disappears (a still-running
  // scan re-sorting its groups on refetch) degrades to the top of the list
  // instead of a blank pane.
  const selectedGroup = groups.find((g) => g.id === selectedGroupId) || groups[0];
  const tenant = getCredentials()?.tenant;
  // This scan's own locked-in setting (see server's POST /role-scans), not
  // the tenant's current Configuration value — the two can differ if
  // Configuration is changed after the scan ran. Older scans predating this
  // field fall back to the default (on).
  const createDynamicRoles = scan.createDynamicRoles ?? true;
  const allowDuplicateRoles = scan.allowDuplicateRoles ?? true;
  // Create All Roles is an action happening right now, not a property of
  // the scan itself — it should honor Mining Config's CURRENT Allow
  // Duplicate Roles setting, not whatever was locked in when the scan ran
  // (that locked-in value only controls whether the scan itself dropped
  // matched groups from its results; falls back to the scan's own value
  // while settings are still loading, so this doesn't flash restrictive).
  const currentAllowDuplicateRoles = settingsQuery.data?.allowDuplicateRoles ?? allowDuplicateRoles;

  // Same eligibility create-role itself enforces, mirrored here so the
  // bulk list matches what will actually succeed. A group with no shared
  // base entitlements is no longer excluded — every existing attribute
  // combination gets a role, whether or not its members hold anything in
  // common (its access may be entirely per-dimension, or the role may be a
  // membership-only placeholder). The one remaining check is the
  // pre-existing match (existingRole), relaxed when Allow Duplicate Roles
  // is currently on since Mining Config has already said "create whatever's
  // asked for". Always skips a group this scan already created (roleCreated).
  const creatableGroups = creatableScanGroups(groups, currentAllowDuplicateRoles);

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <TopBar
        title="Role Model Draft"
        onBack={() => navigate("/role-mining/scan-for-roles")}
        action={
          <div className="flex items-center gap-3">
            <IconButton
              icon={Settings}
              title="Mining Config"
              onClick={() => navigate("/studio-settings/scanning-config")}
            />
            {groups.length > 0 && (
            <>
              <IconButton
                icon={ShieldPlus}
                title={
                  creatableGroups.length > 0
                    ? `Create All Roles (${creatableGroups.length})`
                    : "Create All Roles — every group already has a role or matches an existing one"
                }
                onClick={() => setBulkCreateOpen(true)}
              />
              <button
                onClick={() => {
                  if (!printRoleScanPdf({ tenant, scan, groups, createDynamicRoles, attributeSeparator })) {
                    toast("Pop-up blocked — downloaded the PDF instead");
                  }
                }}
                className="flex items-center gap-1 text-blue-600 text-sm font-medium"
                title="Print"
              >
                <Printer size={16} />
              </button>
            </>
            )}
          </div>
        }
      />
      <div className="flex-1 overflow-y-auto pb-24">
        <div className="px-4 py-4 border-b border-gray-100">
          {/* Left: what this scan is and what it looked at. Right: the
              settings it ran under. Stacks back to one column below md,
              same breakpoint as the roles list. */}
          <div className="md:grid md:grid-cols-2 md:gap-x-8 md:items-start">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <StatusIcon size={16} className={meta.className} />
                <span className="text-sm font-medium text-gray-900">{meta.label}</span>
              </div>
              <p className="text-xs text-gray-500">
                {scan.tenant ? `${scan.tenant} — ` : ""}Started {new Date(scan.startedAt).toLocaleString()}
              </p>
              {scan.error && <p className="text-xs text-red-600 mt-1">{scan.error}</p>}
              {scan.commonAccessExclusionFailed && (
                <p className="text-xs text-amber-600 mt-1">
                  Couldn't fetch common-access entitlements for this scan — its groups may include
                  access already granted by a common-access role. Re-run the scan to retry.
                </p>
              )}
              <p className="text-xs text-gray-400 mt-2">
                Boundary: {scan.roleBoundaryEnabled && scan.roleBoundaryAttributes?.length
                  ? scan.roleBoundaryAttributes.join(" + ")
                  : "No Boundary set"}
              </p>
              <p className="text-xs text-gray-400 mt-2">
                Scope: {scan.scopeQuery ? <span className="font-mono">{scan.scopeQuery}</span> : "(No Scope Defined)"}
              </p>
              <div className="flex items-center gap-4 mt-2">
                <p className="text-xs text-gray-400">{scan.scanned} combinations scanned</p>
                <p className="text-xs text-gray-400">{groups.length} peer groups</p>
              </div>
            </div>

            <div className="mt-2 md:mt-0">
              <p className="text-xs text-gray-400">
                Attribute priority: {attributeKeys.join(" > ")}
              </p>
              <p className="text-xs font-medium text-gray-500 mt-2">
                Create Dynamic Roles: <span className={createDynamicRoles ? "text-emerald-700" : "text-gray-700"}>
                  {createDynamicRoles ? "On" : "Off"}
                </span>
              </p>
              <p className="text-xs font-medium text-gray-500 mt-1">
                Allow Duplicate Roles: <span className={allowDuplicateRoles ? "text-emerald-700" : "text-gray-700"}>
                  {allowDuplicateRoles ? "On" : "Off"}
                </span>
              </p>
              <p className="text-xs font-medium text-gray-500 mt-1">
                Entitlement Commonality: <span className="text-gray-700">
                  {scan.entitlementCommonalityThreshold ?? 80}%
                </span>
              </p>
            </div>
          </div>

          {/* Full width under both columns — it's a warning about the scan
              as a whole, not about either side. */}
          {scan.entitlementFetchFailures > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mt-2 flex gap-2">
              <AlertTriangle size={14} className="text-amber-600 flex-shrink-0 mt-0.5" />
              <p className="text-xs text-amber-800">
                Couldn't fetch entitlements for {scan.entitlementFetchFailures} identit{scan.entitlementFetchFailures === 1 ? "y" : "ies"} even
                after a retry — they were excluded from grouping, so some peer groups may be missing
                or smaller than they should be. Re-running the scan may resolve a transient issue.
              </p>
            </div>
          )}
        </div>

        {groups.length === 0 && scan.status === "completed" ? (
          <EmptyState
            icon={Users2}
            title="No peer groups found"
            subtitle="No sets of identities shared enough access to form a group"
          />
        ) : (
          <ScanMasterDetail
            listTitle={`Proposed Roles (${groups.length})`}
            single={groups.map((g) => (
              <div key={g.id} className="border-b border-gray-100">
                <PeerGroupCard
                  scanId={id}
                  group={g}
                  attributeKeys={attributeKeys}
                  rolePrefix={rolePrefix}
                  roleSuffix={roleSuffix}
                  attributeSeparator={attributeSeparator}
                  currentAllowDuplicateRoles={currentAllowDuplicateRoles}
                />
              </div>
            ))}
            list={groups.map((g) => (
              <ScanListRow
                key={g.id}
                active={selectedGroup?.id === g.id}
                onClick={() => setSelectedGroupId(g.id)}
                icon={g.roleCreated ? CheckCircle2 : g.existingRole ? AlertTriangle : Users2}
                iconClass={
                  g.roleCreated ? "text-emerald-600" : g.existingRole ? "text-amber-500" : "text-violet-600"
                }
                title={displayRoleName(g, attributeSeparator)}
                subtitle={`${g.members.length} member${g.members.length === 1 ? "" : "s"} · ${g.commonAccess.length} entitlement${g.commonAccess.length === 1 ? "" : "s"}`}
                tag={g.isCommonAccessScope ? "Common Access" : isDynamic(g) ? "Dynamic" : null}
              />
            ))}
            detail={
              selectedGroup && (
                <PeerGroupCard
                  key={selectedGroup.id}
                  scanId={id}
                  group={selectedGroup}
                  attributeKeys={attributeKeys}
                  rolePrefix={rolePrefix}
                  roleSuffix={roleSuffix}
                  attributeSeparator={attributeSeparator}
                  currentAllowDuplicateRoles={currentAllowDuplicateRoles}
                />
              )
            }
          />
        )}
      </div>

      {bulkCreateOpen && (
        <BulkCreateRolesSheet
          scanId={id}
          groups={creatableGroups}
          attributeKeys={attributeKeys}
          defaultRolePrefix={rolePrefix}
          defaultRoleSuffix={roleSuffix}
          attributeSeparator={attributeSeparator}
          onClose={() => setBulkCreateOpen(false)}
          onDone={() => {
            setBulkCreateOpen(false);
            queryClient.invalidateQueries({ queryKey: ["roleScan", id] });
          }}
        />
      )}
    </div>
  );
}

export default function ScanForRolesPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const roleScan = useMutation({
    mutationFn: () => startRoleScan(),
    onSuccess: ({ scanId }) => {
      toast.success("Peer-group discovery started — check back here for results.");
      queryClient.invalidateQueries({ queryKey: ["roleScans"] });
      navigate(`/role-mining/role-scans/${scanId}`);
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const { data: pastRoleScans = [] } = useQuery({
    queryKey: ["roleScans"],
    queryFn: listRoleScans,
    refetchInterval: (query) =>
      query.state.data?.some((s) => s.status === "running") ? 4000 : 15000,
  });

  // Shown up top so it's obvious what a scan started right now would
  // actually use — same tenant settings Scanning Config edits, just
  // read-only here.
  const { data: scanSettings } = useQuery({
    queryKey: ["tenant-settings"],
    queryFn: getTenantSettings,
  });

  // Same keys the server would actually bucket by if a scan started right
  // now (see server's getRoleScanAttributeKeys) — Schema Analysis's chosen
  // top attributes if it's been run, otherwise the department/location
  // default.
  const { data: schemaAnalysis } = useQuery({
    queryKey: ["schema-analysis"],
    queryFn: getSchemaAnalysis,
  });
  const scanAttributeKeys = schemaAnalysis?.topAttributes?.length
    ? schemaAnalysis.topAttributes
    : DEFAULT_PEER_GROUP_ATTRIBUTE_KEYS;

  const cancelRoleScanMutation = useMutation({
    mutationFn: (scanId) => cancelRoleScan(scanId),
    onSuccess: () => {
      toast.success("Scan cancelled");
      queryClient.invalidateQueries({ queryKey: ["roleScans"] });
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const removeRoleScanMutation = useMutation({
    mutationFn: (scanId) => deleteRoleScan(scanId),
    onSuccess: () => {
      toast.success("Scan removed");
      queryClient.invalidateQueries({ queryKey: ["roleScans"] });
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <TopBar
        title={<RoleMiningTitleMenu active="Role Model Drafts" />}
        action={
          <IconButton
            icon={Settings}
            title="Mining Config"
            onClick={() => navigate("/studio-settings/scanning-config")}
          />
        }
      />
      <div className="flex-1 overflow-y-auto pb-24">
        <div className="px-4 py-5 border-b border-gray-100">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-full bg-violet-50 flex items-center justify-center flex-shrink-0">
              <Users2 size={18} className="text-violet-600" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-gray-900">Role Mining</h2>
              <p className="text-xs text-gray-500 mt-0.5">
                Groups identities with near-identical access, names each group by
                location and department, and can turn the shared access into a Role
              </p>
            </div>
          </div>
          <OutlineButton onClick={() => roleScan.mutate()} loading={roleScan.isPending}>
            <Users2 size={16} />
            Create a Role Model Draft
          </OutlineButton>

          {scanSettings && (
            <div className="mt-3 border border-gray-100 rounded-xl px-3 py-2.5 text-xs text-gray-500 space-y-1">
              <p>
                Boundary: {schemaAnalysis?.roleBoundaryEnabled && schemaAnalysis.roleBoundaryAttributes?.length
                  ? schemaAnalysis.roleBoundaryAttributes.join(" + ")
                  : "No Boundary set"}
              </p>
              <p>
                Scope: {scanSettings.nameScope ? <span className="font-mono">{scanSettings.nameScope}</span> : "(No Scope Defined)"}
              </p>
              <p>
                Attributes: <span className="font-medium text-gray-700">{scanAttributeKeys.join(" > ")}</span>
              </p>
              <p>
                Create Dynamic Roles:{" "}
                <span className={scanSettings.createDynamicRoles ? "text-emerald-700 font-medium" : "text-gray-700 font-medium"}>
                  {scanSettings.createDynamicRoles ? "On" : "Off"}
                </span>
                {" · "}
                Allow Duplicate Roles:{" "}
                <span className={scanSettings.allowDuplicateRoles ? "text-emerald-700 font-medium" : "text-gray-700 font-medium"}>
                  {scanSettings.allowDuplicateRoles ? "On" : "Off"}
                </span>
              </p>
            </div>
          )}
        </div>

        {pastRoleScans.length > 0 && (
          <div className="mt-2">
            <div className="px-4 py-2 flex items-center gap-2">
              <Clock size={14} className="text-gray-400" />
              <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Role Mining Drafts</h3>
            </div>
            {pastRoleScans.map((s) => (
              <ScanListItem
                key={s.id}
                scan={s}
                onOpen={() => navigate(`/role-mining/role-scans/${s.id}`)}
                onCancel={() => cancelRoleScanMutation.mutate(s.id)}
                cancelPending={cancelRoleScanMutation.isPending}
                onRemove={() => removeRoleScanMutation.mutate(s.id)}
                removePending={removeRoleScanMutation.isPending}
                detail={`${s.scanned} combinations scanned · ${s.groupCount} peer groups · ${
                  (s.attributeKeys?.length ? s.attributeKeys : DEFAULT_PEER_GROUP_ATTRIBUTE_KEYS).join(" > ")
                }`}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
