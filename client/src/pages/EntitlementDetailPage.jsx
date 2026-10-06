import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Key, Printer, Pencil, Wand2, ChevronLeft, ChevronRight, Info, Users, Layers, LayoutGrid, Grid3x3, Shapes, CheckSquare, Link, Tags, ArrowUpCircle, ArrowDownCircle, Braces, ChevronRight as ChevronRightIcon } from "lucide-react";
import toast from "react-hot-toast";
import {
  getEntitlement, listEntitlementMembers, getCredentials, updateEntitlement, listIdentities,
  listRolesByEntitlement, listAccessProfilesByEntitlement, listEntitlementApplications,
  listEntitlementParents, listEntitlementChildren,
  getEntitlementSegments, getSchemaAnalysis, generateEntitlementDescription,
  listEntitlementAccountMembers,
} from "../lib/sailpoint";
import { printEntitlementPdf } from "../lib/exportEntitlementPdf";
import { useUrlSearch } from "../hooks/useUrlSearch";
import { useUrlState } from "../hooks/useUrlState";
import { TopBar } from "../components/TopBar";
import { ApprovalSettingsPanel } from "../components/ApprovalSettingsPanel";
import { EditableMetadataPanel } from "../components/EditableMetadataPanel";
import { RawJsonPanel } from "../components/RawJsonPanel";
import { SegmentsTabPanel } from "../components/SegmentsTabPanel";
import { PickerField } from "../components/PickerField";
import {
  InfoRow, SkeletonList, ErrorBox, Avatar, Spinner, IconButton, SearchBar, EmptyState,
  Field, Input, Textarea, Select, PrimaryButton, OutlineButton, Pager,
} from "../components/ui";
import { tenantUiHost } from "../lib/tenantHost";

const MEMBERS_PAGE_SIZE = 50;

const BASE_SECTIONS = [
  { key: "details", label: "Details", Icon: Info },
  { key: "members", label: "Members", Icon: Users },
  { key: "roles", label: "Roles", Icon: Layers },
  { key: "accessProfiles", label: "Access Profiles", Icon: LayoutGrid },
  { key: "applications", label: "Applications", Icon: Grid3x3 },
  { key: "metadata", label: "Metadata", Icon: Tags },
];

const searchIdentitiesForOwner = async (q) =>
  (await listIdentities({ limit: 15, query: q || undefined })).map((i) => ({ id: i.id, name: i.name }));

// Name/description/owner/requestable/privilege level — the fields PATCH
// /api/entitlements/:id supports (see that route's own comment on why
// renaming an entitlement can be worthwhile: its native `name` is often
// just a raw synced attribute value from the source, not a human-chosen
// one). Privilege level is written as an override in ISC.
const PRIVILEGE_LEVELS = [
  { value: "HIGH", label: "High" },
  { value: "MEDIUM", label: "Medium" },
  { value: "LOW", label: "Low" },
  { value: "NONE", label: "None (not privileged)" },
];
const privilegeLabel = (v) => PRIVILEGE_LEVELS.find((p) => p.value === String(v || "").toUpperCase())?.label || (v ? String(v) : "Not set");

function EditEntitlementModal({ entitlement, onClose, onSave, pending }) {
  const [name, setName] = useState(entitlement.name || "");
  const [description, setDescription] = useState(entitlement.description || "");
  const [owner, setOwner] = useState(entitlement.owner ? [{ id: entitlement.owner.id, name: entitlement.owner.name }] : []);
  const [requestable, setRequestable] = useState(!!entitlement.requestable);
  // "" = leave the privilege level as it is (whether set or inherited).
  const currentDirect = String(entitlement.privilegeLevel?.direct || "").toUpperCase();
  const [privilegeLevel, setPrivilegeLevel] = useState(currentDirect);

  const canSave = name.trim() && owner[0]?.id;

  function handleSave() {
    const fields = {};
    if (name !== (entitlement.name || "")) fields.name = name;
    if (description !== (entitlement.description || "")) fields.description = description;
    if (owner[0]?.id !== entitlement.owner?.id) fields.owner = owner[0];
    if (requestable !== !!entitlement.requestable) fields.requestable = requestable;
    if (privilegeLevel && privilegeLevel !== currentDirect) fields.privilegeLevel = privilegeLevel;
    if (Object.keys(fields).length === 0) return onClose();
    onSave(fields);
  }

  return (
    <div
      className="fixed inset-0 bg-black/30 z-30 flex items-end md:items-center justify-center"
      onClick={(e) => e.target === e.currentTarget && !pending && onClose()}
    >
      <div className="bg-white w-full max-w-lg md:mx-4 rounded-t-2xl md:rounded-2xl shadow-xl p-5 max-h-[85vh] overflow-y-auto">
        <h2 className="text-base font-semibold text-gray-900 mb-4">Edit entitlement</h2>
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Description">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <PickerField
          label="Owner"
          placeholder="Search users…"
          searchFn={searchIdentitiesForOwner}
          multi={false}
          selected={owner}
          onChange={setOwner}
        />
        <Field label="Requestable">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={requestable}
              onChange={(e) => setRequestable(e.target.checked)}
              className="w-4 h-4 rounded border-gray-300 accent-blue-600"
            />
            <span className="text-sm text-gray-700">Requestable</span>
          </label>
        </Field>
        <Field label="Privilege level">
          <Select value={privilegeLevel} onChange={(e) => setPrivilegeLevel(e.target.value)}>
            <option value="">
              {currentDirect ? `Keep ${privilegeLabel(currentDirect)}` : entitlement.privilegeLevel?.inherited
                ? `Keep inherited (${privilegeLabel(entitlement.privilegeLevel.inherited)})`
                : "Keep as is (not set)"}
            </option>
            {PRIVILEGE_LEVELS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </Select>
          <p className="text-xs text-gray-500 mt-1.5">
            Sets a direct override on the entitlement in ISC; the effective level follows it. Currently effective:{" "}
            <span className="font-medium text-gray-700">{privilegeLabel(entitlement.privilegeLevel?.effective)}</span>
            {entitlement.privilegeLevel?.setByType ? ` (${String(entitlement.privilegeLevel.setByType).toLowerCase().replace(/_/g, " ")})` : ""}.
          </p>
        </Field>
        <div className="flex gap-2 mt-2">
          <PrimaryButton onClick={handleSave} loading={pending} disabled={!canSave} className="!w-auto flex-1">
            Save
          </PrimaryButton>
          <OutlineButton onClick={onClose} disabled={pending} className="!w-auto flex-1">
            Cancel
          </OutlineButton>
        </div>
      </div>
    </div>
  );
}

// Shows Claude's suggested description alongside the entitlement's current
// one — editable before saving (pre-filled with the suggestion), never
// applies anything until confirmed. Same shape as RoleDetailPage's own
// GeneratedDescriptionModal.
function GeneratedDescriptionModal({ currentDescription, suggestion, onClose, onSave, pending }) {
  const [description, setDescription] = useState(suggestion);

  return (
    <div
      className="fixed inset-0 bg-black/30 z-30 flex items-end md:items-center justify-center"
      onClick={(e) => e.target === e.currentTarget && !pending && onClose()}
    >
      <div className="bg-white w-full max-w-lg md:mx-4 rounded-t-2xl md:rounded-2xl shadow-xl p-5 max-h-[85vh] overflow-y-auto">
        <h2 className="text-base font-semibold text-gray-900 mb-1 flex items-center gap-2">
          <Wand2 size={16} className="text-violet-600" />
          AI-generated description
        </h2>
        <p className="text-xs text-gray-400 mb-4">Review and edit before saving — nothing is applied until you confirm.</p>

        <Field label="Current description">
          <p className="text-sm text-gray-500 bg-gray-50 border border-gray-100 rounded-xl px-3 py-2.5">
            {currentDescription || "(none)"}
          </p>
        </Field>
        <Field label="Suggested description">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>

        <div className="flex gap-2 mt-2">
          <PrimaryButton onClick={() => onSave(description)} loading={pending} disabled={!description.trim()} className="!w-auto flex-1">
            Save
          </PrimaryButton>
          <OutlineButton onClick={onClose} disabled={pending} className="!w-auto flex-1">
            Cancel
          </OutlineButton>
        </div>
      </div>
    </div>
  );
}

// Read-only field list. Editing lives in two places only: the header's
// pencil (the edit form) and the JSON tab's own pencil.
function DetailsPanel({ data }) {
  return (
    <div className="px-4 py-4">
      <p className="text-xs text-gray-400 mb-3">Entitlement details</p>
      {data.description && (
        <p className="text-sm text-gray-600 leading-relaxed mb-4">{data.description}</p>
      )}
      <div className="border border-gray-100 rounded-xl overflow-hidden">
        <InfoRow label="Source" value={data.source?.name} />
        <InfoRow label="Attribute" value={data.attribute} />
        <InfoRow label="Value" value={data.value} />
        <InfoRow label="Privilege level" value={privilegeLabel(data.privilegeLevel?.effective)} />
        <InfoRow
          label="Privilege set by"
          value={data.privilegeLevel?.setByType || data.privilegeLevel?.setBy
            ? [data.privilegeLevel?.setByType ? String(data.privilegeLevel.setByType).toLowerCase().replace(/_/g, " ") : null, data.privilegeLevel?.setBy].filter(Boolean).join(" · ")
            : undefined}
        />
        <InfoRow label="Direct privilege" value={data.privilegeLevel?.direct ? privilegeLabel(data.privilegeLevel.direct) : undefined} />
        <InfoRow label="Inherited privilege" value={data.privilegeLevel?.inherited ? privilegeLabel(data.privilegeLevel.inherited) : undefined} />
        <InfoRow label="Owner" value={data.owner?.name} />
        <InfoRow
          label="Additional owners"
          value={(data.additionalOwners || []).length > 0 ? data.additionalOwners.map((o) => o.name).join(", ") : undefined}
        />
        <InfoRow label="Requestable" value={data.requestable != null ? String(data.requestable) : undefined} />
        <InfoRow label="Entitlement ID" value={data.id} />
      </div>
    </div>
  );
}

// Only reachable when the entitlement is requestable (see SECTIONS below) —
// a non-requestable entitlement can't be requested at all, so it has no
// approval workflow to manage. Approval workflow configuration for
// entitlements (who approves, comment requirements, reauthorization,
// revocation approvals) isn't reliably readable through ISC's own APIs —
// verified live: it's not on the entitlement resource itself, the
// entitlement-level request-config endpoint 404s for entitlements that
// have never had an explicit per-entitlement override saved, and even the
// source-level default can come back with an empty approver list while
// ISC's own admin UI still resolves a real approver for that entitlement
// (almost certainly via an org-wide default this app has no read access
// path for). Rather than show a misleading "None configured" for
// something ISC itself knows the real answer to, this just deep-links into
// ISC's own management screen for it.

// Pages through every member of one entitlement (not just one page) —
// needed once results from several entitlements (this one plus each
// child) have to be merged and sorted together before any display
// pagination can happen; a single server page from each source wouldn't
// sort correctly against the others.
async function fetchAllEntitlementMembers(entitlementId, query) {
  const all = [];
  const limit = 250;
  let offset = 0;
  while (true) {
    const { members, total } = await listEntitlementMembers(entitlementId, { limit, offset, query });
    all.push(...members);
    offset += members.length;
    if (members.length === 0 || offset >= total) break;
  }
  return all;
}

const MAX_CHILD_DEPTH = 4;

// Child entitlements can themselves have children (nested AD groups can
// nest further), so indirect membership isn't just one level away. Walks
// the hierarchy breadth-first, level by level, capped at MAX_CHILD_DEPTH
// levels below the entitlement being viewed so a deep or cyclic hierarchy
// can't run away. Each descendant carries `path`: the chain of names from
// the direct child down through itself, so a member found several levels
// down can be flagged with the whole lineage that led to them, not just
// the entitlement holding them directly.
async function collectDescendantEntitlements(directChildren, maxDepth) {
  const descendants = [];
  const seenIds = new Set(directChildren.map((c) => c.id));
  let level = directChildren.map((c) => ({ ...c, path: [c.name || c.value] }));
  let depth = 1;
  const batchSize = 3;

  while (level.length > 0 && depth <= maxDepth) {
    descendants.push(...level);
    if (depth === maxDepth) break;

    const nextLevel = [];
    for (let i = 0; i < level.length; i += batchSize) {
      const batch = level.slice(i, i + batchSize);
      const results = await Promise.all(batch.map((c) => listEntitlementChildren(c.id).catch(() => []).then((kids) => ({ parent: c, kids }))));
      for (const { parent, kids } of results) {
        for (const k of kids || []) {
          if (seenIds.has(k.id)) continue;
          seenIds.add(k.id);
          nextLevel.push({ ...k, path: [...parent.path, k.name || k.value] });
        }
      }
    }
    level = nextLevel;
    depth++;
  }
  return descendants;
}

// Direct holders of this entitlement, plus everyone who holds it
// indirectly through a descendant entitlement anywhere in its child
// hierarchy (a nested AD group's members effectively have every ancestor
// group too) — see collectDescendantEntitlements for the depth-limited
// traversal. Descendant entitlements are fetched a few at a time, not all
// in parallel, same reasoning as enrichEntitlementsForReport on the
// Entitlements list. A person already counted as Direct is never also
// listed as Indirect, and someone reachable via more than one branch is
// only listed once, credited to whichever descendant was reached first.
// Sort: Direct first, then Indirect grouped by which descendant granted it
// (alphabetically), then by name within each group.
async function fetchMembersWithIndirect(entitlementId, childEntitlements, query) {
  const directMembers = await fetchAllEntitlementMembers(entitlementId, query);
  const directIds = new Set(directMembers.map((m) => m.id));
  const rows = directMembers.map((m) => ({ ...m, via: "Direct", viaLabel: null }));

  const descendants = await collectDescendantEntitlements(childEntitlements, MAX_CHILD_DEPTH);
  const indirectIds = new Set();

  const batchSize = 3;
  for (let i = 0; i < descendants.length; i += batchSize) {
    const batch = descendants.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map((c) =>
        fetchAllEntitlementMembers(c.id, query)
          .then((members) => ({ child: c, members }))
          .catch(() => ({ child: c, members: [] }))
      )
    );
    for (const { child, members } of results) {
      for (const m of members) {
        if (directIds.has(m.id) || indirectIds.has(m.id)) continue;
        indirectIds.add(m.id);
        rows.push({ ...m, via: "Indirect", viaLabel: child.path.join(", ") });
      }
    }
  }

  rows.sort((a, b) => {
    if (a.via !== b.via) return a.via === "Direct" ? -1 : 1;
    if (a.via === "Indirect" && a.viaLabel !== b.viaLabel) return (a.viaLabel || "").localeCompare(b.viaLabel || "");
    return (a.displayName || a.name || "").localeCompare(b.displayName || b.name || "");
  });
  return rows;
}

// `childEntitlements` is undefined while EntitlementDetailPage's own
// children query is still loading, an array (possibly empty) once it
// resolves — reusing that fetch here instead of re-requesting children
// again. With none, this stays exactly the old single-entitlement
// server-paginated Search API call (fast, no merge needed). With any, both
// direct and indirect members have to be gathered in full and sorted
// together first (see fetchMembersWithIndirect) — a "Direct first, then
// grouped by child" order only makes sense across the whole set — so
// display pagination becomes a client-side slice over that merged array
// instead of a server offset.
function MembersPanel({ entitlementId, childEntitlements, navigate }) {
  const { search, debouncedSearch, handleSearch: handleUrlSearch } = useUrlSearch("q");
  const [offset, setOffset] = useState(0);

  const handleSearch = (value) => {
    handleUrlSearch(value);
    setOffset(0); // a new search always starts back at page 1
  };

  const childrenLoaded = childEntitlements !== undefined;
  const hasChildren = childrenLoaded && childEntitlements.length > 0;

  const directOnlyQuery = useQuery({
    queryKey: ["entitlement-members", entitlementId, debouncedSearch, offset],
    queryFn: () => listEntitlementMembers(entitlementId, { limit: MEMBERS_PAGE_SIZE, offset, query: debouncedSearch || undefined }),
    keepPreviousData: true,
    enabled: childrenLoaded && !hasChildren,
  });

  const mergedQuery = useQuery({
    queryKey: ["entitlement-members-with-indirect", entitlementId, debouncedSearch],
    queryFn: () => fetchMembersWithIndirect(entitlementId, childEntitlements, debouncedSearch || undefined),
    enabled: hasChildren,
  });

  const isLoading = !childrenLoaded || (hasChildren ? mergedQuery.isLoading : directOnlyQuery.isLoading);
  const isFetching = hasChildren ? mergedQuery.isFetching : directOnlyQuery.isFetching;
  const error = hasChildren ? mergedQuery.error : directOnlyQuery.error;

  const members = hasChildren
    ? (mergedQuery.data || []).slice(offset, offset + MEMBERS_PAGE_SIZE)
    : directOnlyQuery.data?.members || [];
  const totalPrimary = hasChildren ? mergedQuery.data?.length ?? 0 : directOnlyQuery.data?.total ?? 0;

  // Fresh delimited-source grants live on ACCOUNTS long before @access()
  // search can see them (aggregation + identity refresh + indexing all have
  // to land first). When search says nobody holds this, read the source's
  // own accounts instead so the tab reflects reality immediately.
  const primaryEmpty = !isLoading && !error && totalPrimary === 0;
  const accountFallback = useQuery({
    queryKey: ["entitlement-account-members", entitlementId],
    queryFn: () => listEntitlementAccountMembers(entitlementId),
    enabled: primaryEmpty,
  });
  const fallbackMembers = primaryEmpty
    ? (accountFallback.data?.members || []).filter(
        (m) => !debouncedSearch || (m.name || "").toLowerCase().includes(debouncedSearch.toLowerCase())
      )
    : [];
  const usingFallback = primaryEmpty && fallbackMembers.length > 0;

  const displayMembers = usingFallback ? fallbackMembers.slice(offset, offset + MEMBERS_PAGE_SIZE) : members;
  const totalMembers = usingFallback ? fallbackMembers.length : totalPrimary;
  const pageStart = totalMembers === 0 ? 0 : offset + 1;
  const pageEnd = Math.min(offset + displayMembers.length, totalMembers);
  const hasPrev = offset > 0;
  const hasNext = offset + displayMembers.length < totalMembers;

  return (
    <div>
      <SearchBar value={search} onChange={handleSearch} placeholder="Search members by name…" />

      {isLoading && (
        <div className="flex items-center justify-center py-6">
          <Spinner size={18} />
        </div>
      )}
      {error && <ErrorBox message={error.message} />}
      {!isLoading && !error && accountFallback.isFetching && displayMembers.length === 0 && (
        <div className="flex items-center justify-center py-6">
          <Spinner size={18} />
        </div>
      )}
      {!isLoading && !error && !accountFallback.isFetching && displayMembers.length === 0 && (
        <EmptyState
          icon={Users}
          title={debouncedSearch ? "No results" : "No members"}
          subtitle={debouncedSearch ? `No members match "${debouncedSearch}"` : "No identities currently hold this entitlement"}
        />
      )}
      {usingFallback && (
        <p className="text-xs text-amber-600 px-4 py-2">
          Read from the source's account data — identity search hasn't indexed these grants yet.
          {accountFallback.data?.uncorrelated > 0 &&
            ` ${accountFallback.data.uncorrelated} uncorrelated account${accountFallback.data.uncorrelated === 1 ? "" : "s"} also hold${accountFallback.data.uncorrelated === 1 ? "s" : ""} it.`}
        </p>
      )}
      {totalMembers > 0 && <Pager offset={offset} pageSize={MEMBERS_PAGE_SIZE} total={totalMembers} noun="member" onOffsetChange={setOffset} hasNext={hasNext} busy={isFetching} />}
      {displayMembers.length > 0 && (
        <div className="border-t border-gray-100">
          {displayMembers.map((m) => (
            <button
              key={hasChildren ? `${m.via}-${m.viaLabel || ""}-${m.id}` : m.id}
              onClick={() => navigate(`/identities/${m.id}`)}
              className="w-full flex items-center gap-3 px-4 py-3 border-b border-gray-100 hover:bg-gray-50 active:bg-gray-100 text-left transition-colors"
            >
              <Avatar name={m.displayName || m.name} size="sm" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-gray-900 truncate">{m.displayName || m.name}</p>
                {(m.attributes?.jobTitle || m.attributes?.department) && (
                  <p className="text-xs text-gray-500 truncate mt-0.5">
                    {[m.attributes?.jobTitle, m.attributes?.department].filter(Boolean).join(" · ")}
                  </p>
                )}
              </div>
              {hasChildren && !usingFallback && (
                <span
                  className={`text-xs font-medium px-2 py-0.5 rounded-full border flex-shrink-0 ${
                    m.via === "Direct"
                      ? "bg-blue-50 text-blue-700 border-blue-200"
                      : "bg-amber-50 text-amber-700 border-amber-200"
                  }`}
                >
                  {m.via === "Direct" ? "Direct" : `Indirect via ${m.viaLabel}`}
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      {totalMembers > 0 && (
        <Pager offset={offset} pageSize={MEMBERS_PAGE_SIZE} total={totalMembers} noun="member" onOffsetChange={setOffset} hasNext={hasNext} busy={isFetching} />
      )}
    </div>
  );
}

function RolesPanel({ entitlementId, navigate }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["entitlement-roles", entitlementId],
    queryFn: () => listRolesByEntitlement(entitlementId),
  });
  const roles = Array.isArray(data) ? data : [];

  if (isLoading) return <SkeletonList rows={4} />;
  if (error) return <ErrorBox message={error.message} />;
  if (roles.length === 0) {
    return (
      <EmptyState icon={Layers} title="No roles" subtitle="No roles currently include this entitlement" />
    );
  }
  return (
    <div className="border-t border-gray-100">
      <p className="text-xs text-gray-400 px-4 py-2">
        {roles.length} role{roles.length === 1 ? "" : "s"}
      </p>
      {roles.map((r) => (
        <button
          key={r.id}
          onClick={() => navigate(`/roles/${r.id}`)}
          className="w-full flex items-center gap-3 px-4 py-3 border-b border-gray-100 hover:bg-gray-50 active:bg-gray-100 text-left transition-colors"
        >
          <div className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center flex-shrink-0">
            <Layers size={14} className="text-gray-500" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-gray-900 truncate">{r.name}</p>
            {r.owner?.name && <p className="text-xs text-gray-500 truncate mt-0.5">{r.owner.name}</p>}
          </div>
          <ChevronRightIcon size={16} className="text-gray-300 flex-shrink-0" />
        </button>
      ))}
    </div>
  );
}

function AccessProfilesPanel({ entitlementId, navigate }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["entitlement-access-profiles", entitlementId],
    queryFn: () => listAccessProfilesByEntitlement(entitlementId),
  });
  const profiles = Array.isArray(data) ? data : [];

  if (isLoading) return <SkeletonList rows={4} />;
  if (error) return <ErrorBox message={error.message} />;
  if (profiles.length === 0) {
    return (
      <EmptyState icon={LayoutGrid} title="No access profiles" subtitle="No access profiles currently include this entitlement" />
    );
  }
  return (
    <div className="border-t border-gray-100">
      <p className="text-xs text-gray-400 px-4 py-2">
        {profiles.length} access profile{profiles.length === 1 ? "" : "s"}
      </p>
      {profiles.map((p) => (
        <button
          key={p.id}
          onClick={() => navigate(`/access-profiles/${p.id}`)}
          className="w-full flex items-center gap-3 px-4 py-3 border-b border-gray-100 hover:bg-gray-50 active:bg-gray-100 text-left transition-colors"
        >
          <div className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center flex-shrink-0">
            <LayoutGrid size={14} className="text-gray-500" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-gray-900 truncate">{p.name}</p>
            {p.owner?.name && <p className="text-xs text-gray-500 truncate mt-0.5">{p.owner.name}</p>}
          </div>
          <ChevronRightIcon size={16} className="text-gray-300 flex-shrink-0" />
        </button>
      ))}
    </div>
  );
}

// Entitlements have no direct app link in ISC's model — an Application only
// grants access through the Access Profiles assigned to it — so the server
// route joins access-profiles-containing-this-entitlement against apps on
// this entitlement's own source, tagging each app with which profile(s)
// brought it in (same "via" idea as Segment Detail's derived entitlements).
function ApplicationsPanel({ entitlementId, navigate }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["entitlement-applications", entitlementId],
    queryFn: () => listEntitlementApplications(entitlementId),
  });
  const apps = Array.isArray(data) ? data : [];

  if (isLoading) return <SkeletonList rows={4} />;
  if (error) return <ErrorBox message={error.message} />;
  if (apps.length === 0) {
    return (
      <EmptyState icon={Grid3x3} title="No applications" subtitle="No applications currently reach this entitlement" />
    );
  }
  return (
    <div className="border-t border-gray-100">
      <p className="text-xs text-gray-400 px-4 py-2">
        {apps.length} application{apps.length === 1 ? "" : "s"}
      </p>
      {apps.map((a) => (
        <button
          key={a.id}
          onClick={() => navigate(`/applications/${a.id}`)}
          className="w-full flex items-center gap-3 px-4 py-3 border-b border-gray-100 hover:bg-gray-50 active:bg-gray-100 text-left transition-colors"
        >
          <div className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center flex-shrink-0">
            <Grid3x3 size={14} className="text-gray-500" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-gray-900 truncate">{a.name}</p>
            {a.via?.length > 0 && (
              <p className="text-xs text-gray-500 truncate mt-0.5">via {a.via.join(", ")}</p>
            )}
          </div>
          <ChevronRightIcon size={16} className="text-gray-300 flex-shrink-0" />
        </button>
      ))}
    </div>
  );
}

// Hierarchical entitlements (e.g. nested AD groups via memberOf) — ISC's
// own dedicated parents/children sub-resources, shared between the two
// tabs since they're the same shape either direction. Query key matches
// what EntitlementDetailPage's own parents/children queries use to decide
// whether these tabs show at all, so this reuses that cached result
// instead of refetching.
function RelatedEntitlementsPanel({ entitlementId, kind, navigate }) {
  const fetchFn = kind === "parents" ? listEntitlementParents : listEntitlementChildren;
  const label = kind === "parents" ? "parent" : "child";
  const { data, isLoading, error } = useQuery({
    queryKey: [`entitlement-${kind}`, entitlementId],
    queryFn: () => fetchFn(entitlementId),
  });
  const items = Array.isArray(data) ? data : [];

  if (isLoading) return <SkeletonList rows={4} />;
  if (error) return <ErrorBox message={error.message} />;
  if (items.length === 0) {
    return (
      <EmptyState icon={Key} title={`No ${label} entitlements`} subtitle={`This entitlement has no ${label} entitlements`} />
    );
  }
  return (
    <div className="border-t border-gray-100">
      <p className="text-xs text-gray-400 px-4 py-2">
        {items.length} {label} entitlement{items.length === 1 ? "" : "s"}
      </p>
      {items.map((e) => (
        <button
          key={e.id}
          onClick={() => navigate(`/entitlements/${e.id}`)}
          className="w-full flex items-center gap-3 px-4 py-3 border-b border-gray-100 hover:bg-gray-50 active:bg-gray-100 text-left transition-colors"
        >
          <div className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center flex-shrink-0">
            <Key size={14} className="text-gray-500" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-gray-900 truncate">{e.name || e.value}</p>
            {e.source?.name && <p className="text-xs text-gray-500 truncate mt-0.5">{e.source.name}</p>}
          </div>
          <ChevronRightIcon size={16} className="text-gray-300 flex-shrink-0" />
        </button>
      ))}
    </div>
  );
}

export default function EntitlementDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [section, setSection] = useUrlState("tab", "details");
  const [editOpen, setEditOpen] = useState(false);
  const [suggestedDescription, setSuggestedDescription] = useState(null); // string | null

  const { data, isLoading, error } = useQuery({
    queryKey: ["entitlement", id],
    queryFn: () => getEntitlement(id),
  });

  const editEntitlement = useMutation({
    mutationFn: (fields) => updateEntitlement(id, fields),
    onSuccess: (result) => {
      const dropped = Array.isArray(result?.unapplied) ? result.unapplied : [];
      if (dropped.length) {
        toast.error(
          `ISC accepted the edit but did not keep: ${dropped.join(", ")}. Entitlements from a read-only source can't be changed in ISC.`,
          { duration: 8000 }
        );
      } else {
        toast.success("Entitlement updated");
      }
      // Always refresh: show ISC's own re-read straight away, then fetch
      // again shortly after in case ISC applies the change with a lag.
      if (result && typeof result === "object" && result.id) {
        const { unapplied, ...fresh } = result;
        queryClient.setQueryData(["entitlement", id], fresh);
      }
      queryClient.invalidateQueries({ queryKey: ["entitlement", id] });
      queryClient.invalidateQueries({ queryKey: ["entitlements"] });
      setTimeout(() => queryClient.invalidateQueries({ queryKey: ["entitlement", id] }), 3000);
      setEditOpen(false);
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const generateDescription = useMutation({
    mutationFn: () => generateEntitlementDescription(id),
    onSuccess: (result) => setSuggestedDescription(result.description),
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const saveGeneratedDescription = useMutation({
    mutationFn: (description) => updateEntitlement(id, { description }),
    onSuccess: () => {
      toast.success("Description updated");
      queryClient.invalidateQueries({ queryKey: ["entitlement", id] });
      queryClient.invalidateQueries({ queryKey: ["entitlements"] });
      setSuggestedDescription(null);
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const membersCountQuery = useQuery({
    queryKey: ["entitlement-members", id, "", 0],
    queryFn: () => listEntitlementMembers(id, { limit: MEMBERS_PAGE_SIZE, offset: 0 }),
    enabled: !!data,
  });

  // Same gate Nav.jsx uses for the Data Segments feature itself — no point
  // showing a Segments tab (or spending the fetchAllDataSegments call
  // behind it) on a tenant that doesn't use segments at all.
  const { data: schemaAnalysis } = useQuery({
    queryKey: ["schema-analysis"],
    queryFn: getSchemaAnalysis,
    staleTime: 5 * 60 * 1000,
  });

  // Fetched here (not just inside RelatedEntitlementsPanel) purely to
  // decide whether the Parents/Children tabs show at all — most
  // entitlements have neither, and a tab that's always empty isn't worth
  // showing. Same query key the panel itself uses, so this doesn't cause a
  // second fetch once a tab is actually opened.
  const parentsQuery = useQuery({
    queryKey: ["entitlement-parents", id],
    queryFn: () => listEntitlementParents(id),
    enabled: !!data,
  });
  const childrenQuery = useQuery({
    queryKey: ["entitlement-children", id],
    queryFn: () => listEntitlementChildren(id),
    enabled: !!data,
  });

  const SECTIONS = [
    ...BASE_SECTIONS,
    // Only reachable when this entitlement is requestable — a non-
    // requestable one can't be requested at all, so there's no approval
    // workflow to show.
    { key: "approvals", label: "Approvals", Icon: CheckSquare },
    ...(parentsQuery.data?.length > 0 ? [{ key: "parents", label: "Parents", Icon: ArrowUpCircle }] : []),
    ...(childrenQuery.data?.length > 0 ? [{ key: "children", label: "Children", Icon: ArrowDownCircle }] : []),
    ...(schemaAnalysis?.createDataSegments ? [{ key: "segments", label: "Data Segments", Icon: Shapes }] : []),
    { key: "json", label: "JSON", Icon: Braces },
  ];

  // The print report covers every tab, not just whichever one happens to be
  // open, so it fetches Roles/Access Profiles/Applications/Segments fresh
  // here rather than relying on those tabs' own panel-scoped queries (which
  // may never have mounted). Segments is only fetched when the tenant
  // actually has the feature on — same gate the tab itself uses.
  const printEntitlement = useMutation({
    mutationFn: async () => {
      const tenant = getCredentials()?.tenant;
      const members = membersCountQuery.data?.members || [];
      const totalMembers = membersCountQuery.data?.total ?? 0;
      const [roles, accessProfiles, applications, segments] = await Promise.all([
        listRolesByEntitlement(id),
        listAccessProfilesByEntitlement(id),
        listEntitlementApplications(id),
        schemaAnalysis?.createDataSegments ? getEntitlementSegments(id) : Promise.resolve([]),
      ]);
      return printEntitlementPdf({ tenant, entitlement: data, members, totalMembers, roles, accessProfiles, applications, segments });
    },
    onSuccess: (opened) => {
      if (!opened) toast("Pop-up blocked — downloaded the PDF instead");
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const entitlementIscTenant = getCredentials()?.tenant;
  const entitlementIscUrl =
    entitlementIscTenant && data
      ? `https://${tenantUiHost(entitlementIscTenant)}/ui/a/admin/access/entitlements/landing-page/details/${data.id}`
      : null;

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <TopBar
        title="Entitlement"
        onBack={() => navigate(-1)}
        action={
          data && (
            <div className="flex items-center gap-2">
              <IconButton
                icon={Link}
                title="View in Identity Security Cloud"
                onClick={() => entitlementIscUrl && window.open(entitlementIscUrl, "_blank", "noopener,noreferrer")}
                disabled={!entitlementIscUrl}
              />
              <IconButton
                icon={Wand2}
                title="Generate a new description with AI"
                onClick={() => generateDescription.mutate()}
                loading={generateDescription.isPending}
              />
              <IconButton icon={Pencil} title="Edit name, description, owner, requestable & privilege level" onClick={() => setEditOpen(true)} />
              <IconButton
                icon={Printer}
                title="Print"
                onClick={() => printEntitlement.mutate()}
                loading={printEntitlement.isPending}
              />
            </div>
          )
        }
      />
      <div className="flex-1 overflow-y-auto pb-24">
        <div className="px-4 py-4">
          {isLoading && <SkeletonList rows={6} />}
          {error && <ErrorBox message={error.message} />}
          {data && (
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-gray-100 flex items-center justify-center flex-shrink-0">
                <Key size={18} className="text-gray-500" />
              </div>
              <div className="min-w-0">
                <h2 className="text-base font-semibold text-gray-900 truncate">{data.name || data.value}</h2>
                <p className="text-xs text-gray-500 truncate">
                  {[data.source?.name, data.owner?.name && `Owner: ${data.owner.name}`].filter(Boolean).join(" · ")}
                </p>
              </div>
            </div>
          )}
        </div>

        {data && (
          <div className="flex border-t border-gray-100">
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
                <DetailsPanel data={data} />
              )}
              {section === "metadata" && <EditableMetadataPanel kind="entitlements" objectId={id} metadata={data.accessModelMetadata} invalidateKeys={[["entitlement", id], ["entitlements"]]} />}
              {section === "members" && (
                <MembersPanel entitlementId={id} childEntitlements={childrenQuery.data} navigate={navigate} />
              )}
              {section === "roles" && <RolesPanel entitlementId={id} navigate={navigate} />}
              {section === "accessProfiles" && <AccessProfilesPanel entitlementId={id} navigate={navigate} />}
              {section === "applications" && <ApplicationsPanel entitlementId={id} navigate={navigate} />}
              {section === "approvals" && (
                <ApprovalSettingsPanel
                  kind="entitlement"
                  object={data}
                  invalidateKeys={[["entitlement", id], ["entitlements"]]}
                  iscUrl={getCredentials()?.tenant ? `https://${tenantUiHost(getCredentials().tenant)}/ui/a/admin/access/entitlements/manage/${data.id}/access-requests` : null}
                />
              )}
              {section === "parents" && <RelatedEntitlementsPanel entitlementId={id} kind="parents" navigate={navigate} />}
              {section === "children" && <RelatedEntitlementsPanel entitlementId={id} kind="children" navigate={navigate} />}
              {section === "segments" && (
                <SegmentsTabPanel
                  queryKey={["entitlement-segments", id]}
                  queryFn={() => getEntitlementSegments(id)}
                  navigate={navigate}
                  emptySubtitle="This entitlement isn't selected on any data segment's Access Model"
                />
              )}
              {section === "json" && (
                <RawJsonPanel
                  data={data}
                  resource="entitlements"
                  objectId={id}
                  invalidateKeys={[["entitlement", id], ["entitlements"]]}
                />
              )}
            </div>
          </div>
        )}
      </div>

      {editOpen && data && (
        <EditEntitlementModal
          entitlement={data}
          onClose={() => setEditOpen(false)}
          onSave={(fields) => editEntitlement.mutate(fields)}
          pending={editEntitlement.isPending}
        />
      )}

      {suggestedDescription != null && data && (
        <GeneratedDescriptionModal
          currentDescription={data.description}
          suggestion={suggestedDescription}
          onClose={() => setSuggestedDescription(null)}
          onSave={(description) => saveGeneratedDescription.mutate(description)}
          pending={saveGeneratedDescription.isPending}
        />
      )}
    </div>
  );
}
