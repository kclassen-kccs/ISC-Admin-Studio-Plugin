import { useMemo, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Shapes, ChevronRight, ChevronLeft, FileText, FilePlus2, Shield, Key, Link2, Link, Power, PowerOff, UploadCloud, Trash2, Info, Users, Braces, Maximize2, Minimize2,
} from "lucide-react";
import toast from "react-hot-toast";
import {
  getSegment, setSegmentActive, publishSegments, getSegmentAccess, listSegmentMembers, startSegmentRoleMatch, deleteSegment, createSegmentDraft,
  getCredentials,
  getMetadataValueGuids,
  sortByName,
} from "../lib/sailpoint";
import { useUrlState } from "../hooks/useUrlState";
import { usePagedList } from "../hooks/usePagedList";
import { useUrlSearch } from "../hooks/useUrlSearch";
import { TopBar } from "../components/TopBar";
import {
  Spinner, ErrorBox, InfoRow, SectionLabel, ListRow, EmptyState, SkeletonList, IconButton, ConfirmModal, Avatar, SearchBar, Pager,
} from "../components/ui";
import { RawJsonPanel } from "../components/RawJsonPanel";
import { tenantUiHost } from "../lib/tenantHost";

const MEMBERS_PAGE_SIZE = 50;

// Renders a segment's visibilityCriteria expression tree (ISC's own DSL for
// this — see server's segmentEqualsLeaf/segmentAndExpression — distinct
// from a role's membership.criteria shape) into a plain-English line.
/**
 * `byGuid` reverse-resolves an Access Model Metadata value GUID to its
 * readable name. ISC records a segment's ROLE filter by the value's internal
 * GUID while the ENTITLEMENT filter beside it uses the technical name, so
 * without this one scope reads as an opaque id and the other doesn't.
 *
 * A GUID that isn't in the map is printed as-is rather than hidden — an
 * unresolved id the reader can still search for beats a blank.
 */
// Shared by the criteria lines on this screen. React Query dedupes on the
// key, so both callers cost one request between them.
function useMetadataValueGuids() {
  const { data } = useQuery({
    queryKey: ["metadata-value-guids"],
    queryFn: getMetadataValueGuids,
    staleTime: 5 * 60 * 1000,
  });
  return data?.byGuid || null;
}

function describeExpression(expr, byGuid) {
  if (!expr) return "No criteria set";
  if (expr.operator === "AND" && expr.children?.length) {
    return expr.children.map((c) => describeExpression(c, byGuid)).join(" AND ");
  }
  if (expr.operator === "EQUALS") {
    const raw = expr.value?.value ?? "";
    const known = byGuid?.[raw];
    return known ? `${expr.attribute} = "${known.name}"` : `${expr.attribute} = "${raw}"`;
  }
  return expr.operator || "Unrecognized criteria";
}

const SECTIONS = [
  { key: "details", label: "Details", Icon: Info },
  { key: "members", label: "Members", Icon: Users },
  { key: "roles", label: "Roles", Icon: Shield },
  { key: "entitlements", label: "Entitlements", Icon: Key },
  { key: "json", label: "JSON", Icon: Braces },
];

// Identities inside this segment's boundary — segment membership is never
// denormalized anywhere in ISC, so the server evaluates the segment's own
// memberFilter criteria as a Search API query (see GET /api/segments/:id/
// members). A segment with no criteria matches nobody, same as ISC itself.
function MembersPanel({ segmentId, navigate }) {
  const { search, debouncedSearch, handleSearch: handleUrlSearch } = useUrlSearch("q");
  const [offset, setOffset] = useState(0);

  const handleSearch = (value) => {
    handleUrlSearch(value);
    setOffset(0); // a new search always starts back at page 1
  };

  const membersQuery = useQuery({
    queryKey: ["segment-members", segmentId, debouncedSearch, offset],
    queryFn: () => listSegmentMembers(segmentId, { limit: MEMBERS_PAGE_SIZE, offset, query: debouncedSearch || undefined }),
    keepPreviousData: true,
  });
  const members = membersQuery.data?.members || [];
  const totalMembers = membersQuery.data?.total ?? 0;
  const pageStart = totalMembers === 0 ? 0 : offset + 1;
  const pageEnd = Math.min(offset + members.length, totalMembers);
  const hasPrev = offset > 0;
  const hasNext = offset + members.length < totalMembers;

  return (
    <div>
      <SearchBar value={search} onChange={handleSearch} placeholder="Search members by name…" />

      {membersQuery.isLoading && (
        <div className="flex items-center justify-center py-6">
          <Spinner size={18} />
        </div>
      )}
      {membersQuery.error && <ErrorBox message={membersQuery.error.message} />}
      {!membersQuery.isLoading && !membersQuery.error && members.length === 0 && (
        <EmptyState
          icon={Users}
          title={debouncedSearch ? "No results" : "No members"}
          subtitle={
            debouncedSearch
              ? `No members match "${debouncedSearch}"`
              : "No identities currently fall inside this segment's visibility criteria"
          }
        />
      )}
      {totalMembers > 0 && <Pager offset={offset} pageSize={MEMBERS_PAGE_SIZE} total={totalMembers} noun="member" onOffsetChange={setOffset} hasNext={hasNext} busy={membersQuery.isFetching} />}
      {members.length > 0 && (
        <div className="border-t border-gray-100">
          {members.map((m) => (
            <button
              key={m.id}
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
            </button>
          ))}
        </div>
      )}

      {totalMembers > 0 && (
        <Pager offset={offset} pageSize={MEMBERS_PAGE_SIZE} total={totalMembers} noun="member" onOffsetChange={setOffset} hasNext={hasNext} busy={membersQuery.isFetching} />
      )}
    </div>
  );
}

/**
 * Roles and entitlements for a segment — same left-tab-bar layout as Role
 * Detail's own Details/Membership/Entitlements/Members tabs.
 *
 * Roles are exact — a role records the segments it belongs to. Entitlements are
 * derived from those roles and the segment's access profiles, because ISC has no
 * way to query entitlements by segment: the field is not filterable and is
 * absent from the search index, so the alternative is scanning every
 * entitlement in the tenant on each view. The distinction is stated in the UI
 * rather than left for someone to infer from a surprising number.
 */
// How the current tab's list is actually populated, read from the
// segment's own Access Model scope for that type — explicit selection,
// metadata filter (Segments by Metadata), or nothing configured.
function scopeCriteriaText(scope, typeLabel, byGuid) {
  if (!scope) return `No ${typeLabel} scope configured on this data segment's Access Model.`;
  if (scope.visibility === "FILTER") {
    return `Metadata filter — ${typeLabel}s whose metadata matches ${describeExpression(scope.scopeFilter?.expression, byGuid)}.`;
  }
  if (scope.visibility === "SELECTION") {
    const n = (scope.scopeSelection || []).length;
    return `Explicit selection — ${n} ${typeLabel}${n === 1 ? "" : "s"} chosen on this data segment's Access Model.`;
  }
  if (scope.visibility === "ALL") return `All ${typeLabel}s.`;
  if (scope.visibility === "UNSEGMENTED") return `Unsegmented — no ${typeLabel} restriction is configured.`;
  return String(scope.visibility || "");
}

/**
 * The segment's entitlements rolled up by source — same behaviour as the
 * Identity detail screen's Entitlements tab: groups collapsed by default,
 * expand/collapse all, and a search that auto-expands whichever groups
 * match. A segment can grant hundreds of entitlements across a handful of
 * sources, so the collapsed roll-up is the readable shape.
 *
 * Paging applies to the GROUPS, not the rows: collapsed, the list is one
 * line per source, so the pager only appears on a segment spanning more
 * sources than fit a page.
 */
export function EntitlementRollup({ entitlements, segmentId }) {
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState(() => new Set());

  const filtered = useMemo(
    () => (search
      ? entitlements.filter((e) => (e.name || "").toLowerCase().includes(search.toLowerCase()))
      : entitlements),
    [entitlements, search]
  );

  const groups = useMemo(() => {
    const map = new Map();
    filtered.forEach((ent) => {
      const sourceName = ent.sourceName || "Other";
      if (!map.has(sourceName)) map.set(sourceName, []);
      map.get(sourceName).push(ent);
    });
    return Array.from(map.entries())
      .map(([sourceName, items]) => [sourceName, sortByName(items)])
      .sort((a, b) => a[0].localeCompare(b[0]));
  }, [filtered]);

  const groupPage = usePagedList(groups, { urlKey: "eo", noun: "source", resetKey: `${segmentId}:${search}` });

  const allExpanded = groups.length > 0 && groups.every(([sourceName]) => expanded.has(sourceName));
  const toggleAll = () =>
    setExpanded(allExpanded ? new Set() : new Set(groups.map(([sourceName]) => sourceName)));
  const toggleSource = (sourceName) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(sourceName)) next.delete(sourceName);
      else next.add(sourceName);
      return next;
    });

  return (
    <div>
      {entitlements.length > 0 && (
        <SearchBar value={search} onChange={setSearch} placeholder="Search entitlements…" />
      )}
      {groups.length > 0 && (
        <div className="flex items-center justify-between gap-3 px-4">
          <p className="text-xs text-gray-400">
            {search && filtered.length !== entitlements.length ? `${filtered.length} of ${entitlements.length}` : filtered.length}
            {" "}entitlement{entitlements.length === 1 ? "" : "s"} across {groups.length} source{groups.length === 1 ? "" : "s"}
          </p>
          <IconButton
            icon={allExpanded ? Minimize2 : Maximize2}
            title={allExpanded ? "Collapse all sources" : "Expand all sources"}
            onClick={toggleAll}
            disabled={!!search}
          />
        </div>
      )}
      {filtered.length === 0 && (
        <p className="text-sm text-gray-400 text-center py-6">
          {entitlements.length === 0 ? "No entitlements" : "No entitlements match your search"}
        </p>
      )}
      <div className="px-4">{groupPage.pager}</div>
      {groupPage.page.map(([sourceName, items]) => {
        // While searching every matching group opens, so a hit is never
        // hidden behind a collapsed header.
        const isOpen = search ? true : expanded.has(sourceName);
        return (
          <div key={sourceName}>
            <button
              onClick={() => toggleSource(sourceName)}
              className="w-full flex items-center justify-between px-4 pt-3 pb-1 text-left"
            >
              <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                {sourceName} ({items.length})
              </span>
              <ChevronRight size={14} className={`text-gray-300 transition-transform ${isOpen ? "rotate-90" : ""}`} />
            </button>
            {isOpen && items.map((ent) => (
              <div key={ent.id} className="flex items-center gap-3 px-4 py-3.5 border-b border-gray-100">
                <div className="w-10 h-10 rounded-full bg-amber-50 flex items-center justify-center flex-shrink-0">
                  <Key size={16} className="text-amber-600" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate">{ent.name || "Unnamed entitlement"}</p>
                  <p className="text-xs text-gray-400 truncate">{(ent.via || []).join(" · ")}</p>
                </div>
              </div>
            ))}
          </div>
        );
      })}
      <div className="px-4">{groupPage.pager}</div>
    </div>
  );
}

function AccessPanel({ segmentId, scopes, section, navigate }) {
  const byGuid = useMetadataValueGuids();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["segment-access", segmentId],
    queryFn: () => getSegmentAccess(segmentId),
    enabled: section === "roles" || section === "entitlements",
  });

  const roles = data?.roles ?? [];
  const entitlements = data?.entitlements ?? [];
  const scope = (scopes || []).find((s) => s.scope === (section === "roles" ? "ROLE" : "ENTITLEMENT"));

  // Roles page client-side like the other browse screens (the list arrives
  // whole from one call). Entitlements are rolled up by source instead — see
  // EntitlementRollup, which pages its groups under its own URL key.
  const rolePage = usePagedList(roles, { urlKey: "ro", noun: "role", resetKey: segmentId });

  return (
    <div>
      <div className="px-4 pt-3">
        <div className="border border-gray-100 rounded-xl px-3 py-2.5 bg-gray-50">
          <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-0.5">Criteria</p>
          <p className="text-xs text-gray-700">{scopeCriteriaText(scope, section === "roles" ? "role" : "entitlement", byGuid)}</p>
        </div>
      </div>

      {isLoading && <div className="px-4 py-4"><SkeletonList rows={4} /></div>}
      {error && <ErrorBox message={error.message} onRetry={refetch} />}

      {data && section === "roles" && (
        roles.length === 0 ? (
          <EmptyState
            icon={Shield}
            title="No roles in this data segment"
            subtitle="This data segment's Access Model has no roles selected — use Assign Matching Roles & Entitlements to propose some."
          />
        ) : (
          <div className="px-4 py-2">
            {rolePage.pager}
            <div className="border border-gray-100 rounded-xl overflow-hidden divide-y divide-gray-100">
              {rolePage.page.map((r) => (
                <ListRow
                  key={r.id}
                  onClick={() => navigate(`/roles/${r.id}`)}
                  left={
                    <div className="w-8 h-8 rounded-full bg-blue-50 flex items-center justify-center flex-shrink-0">
                      <Shield size={14} className="text-blue-600" />
                    </div>
                  }
                  title={r.name}
                  subtitle={`${r.entitlementCount} entitlement${r.entitlementCount === 1 ? "" : "s"}${r.enabled ? "" : " · disabled"}`}
                  right={<ChevronRight size={16} className="text-gray-300 flex-shrink-0" />}
                />
              ))}
            </div>
            {rolePage.pager}
          </div>
        )
      )}

      {data && section === "entitlements" && (
        <>
          <div className="px-4 pt-3">
            <p className="text-xs text-gray-500 leading-relaxed">
              Entitlements directly selected on this data segment&apos;s Access Model, plus
              everything granted <span className="font-medium">through</span> its roles and
              their access profiles — each row shows which.
            </p>
          </div>
          {entitlements.length === 0 ? (
            <EmptyState
              icon={Key}
              title="No entitlements"
              subtitle="The roles and access profiles in this data segment grant none."
            />
          ) : (
            <EntitlementRollup entitlements={entitlements} segmentId={segmentId} />
          )}
        </>
      )}
    </div>
  );
}

// Read-only for now. Note: a Data Segment has no owner field at all in
// ISC's API (verified against the public spec's data-segment.yaml — no
// "owner" property exists, unlike Roles/Access Profiles/Applications) —
// an earlier "Assign Owner" feature attempted to PATCH one anyway and
// 400'd ("semantically invalid"); removed rather than fixed, since there's
// nothing valid to write.
export default function SegmentDetailPage() {
  const byGuid = useMetadataValueGuids();
  const { id } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [section, setSection] = useUrlState("tab", "details");

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["segment", id],
    queryFn: () => getSegment(id),
  });

  const toggleActive = useMutation({
    mutationFn: (active) => setSegmentActive(id, active),
    onSuccess: (_data, active) => {
      toast.success(active ? "Enabled" : "Disabled");
      queryClient.invalidateQueries({ queryKey: ["segment", id] });
      queryClient.invalidateQueries({ queryKey: ["segments"] });
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  // Draft -> Publish is a real ISC action. Published -> Draft has no real
  // API equivalent — ISC rejects patching "published" back to false
  // (verified live); disabling is the closest non-destructive stand-in.
  const togglePublishState = useMutation({
    mutationFn: (published) => (published ? setSegmentActive(id, false) : publishSegments([id])),
    onSuccess: (_data, published) => {
      toast.success(published ? "Disabled" : "Published");
      queryClient.invalidateQueries({ queryKey: ["segment", id] });
      queryClient.invalidateQueries({ queryKey: ["segments"] });
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  // A published segment with no draft can't be PATCHed at all (verified
  // live — see getSegmentPatchTargetId server-side), so this is the
  // explicit way to get one before making any change, rather than only
  // ever happening as a side effect of some other action. The common case
  // reverts THIS record in place (same id, now published:false — verified
  // live against ISC's own UI network traffic) rather than creating a
  // second linked one, which is why this stops being published and its
  // criteria stops taking effect until it's published again — worth
  // saying plainly rather than leaving that as a silent side effect. Only
  // navigates away when the draft really is a separate record (a
  // pre-existing, differently-id'd one found by name).
  const createDraft = useMutation({
    mutationFn: () => createSegmentDraft(id),
    onSuccess: (result) => {
      if (result.wasAlreadyDraft) {
        toast("This is already a draft");
      } else if (result.created) {
        toast.success(`"${result.segmentName}" reverted to draft — publish it again once you're done editing`, { duration: 6000 });
      } else {
        toast(`"${result.segmentName}" already has a draft`);
      }
      queryClient.invalidateQueries({ queryKey: ["segment", id] });
      queryClient.invalidateQueries({ queryKey: ["segments"] });
      if (result.draftId !== id) navigate(`/segments/${result.draftId}`);
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  // Same actions as the Segments list's SelectionActionBar, single-item
  // versions — kept available as icons here too rather than only from the
  // list's multi-select.
  const assignMatchingRoles = useMutation({
    mutationFn: () => startSegmentRoleMatch([id]),
    onSuccess: ({ matchId }) => navigate(`/segments/role-matches/${matchId}`),
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const remove = useMutation({
    mutationFn: () => deleteSegment(id),
    onSuccess: () => {
      toast.success("Data segment deleted");
      queryClient.invalidateQueries({ queryKey: ["segments"] });
      navigate("/segments");
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const segmentIscTenant = getCredentials()?.tenant;
  const segmentIscUrl =
    segmentIscTenant && data ? `https://${tenantUiHost(segmentIscTenant)}/ui/h/admin/global/segments/${data.id}/segment-review` : null;

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <TopBar
        title="Data Segment"
        onBack={() => navigate(-1)}
        action={
          data && (
            <div className="flex items-center gap-2">
              <IconButton
                icon={Link}
                title="View in Identity Security Cloud"
                onClick={() => segmentIscUrl && window.open(segmentIscUrl, "_blank", "noopener,noreferrer")}
                disabled={!segmentIscUrl}
              />
              {data.published && (
                <IconButton
                  icon={FilePlus2}
                  title="Create Draft — reverts this segment to draft (unpublishes it) so it can be edited"
                  onClick={() => createDraft.mutate()}
                  loading={createDraft.isPending}
                  disabled={remove.isPending}
                />
              )}
              <IconButton
                icon={Link2}
                title="Assign Matching Roles & Entitlements"
                onClick={() => assignMatchingRoles.mutate()}
                loading={assignMatchingRoles.isPending}
                disabled={remove.isPending}
              />
              {data.enabled ? (
                <IconButton icon={PowerOff} title="Disable" onClick={() => toggleActive.mutate(false)} loading={toggleActive.isPending} disabled={toggleActive.isPending || remove.isPending} />
              ) : (
                <IconButton icon={Power} title="Enable" onClick={() => toggleActive.mutate(true)} loading={toggleActive.isPending} disabled={toggleActive.isPending || remove.isPending} />
              )}
              <IconButton
                icon={UploadCloud}
                title={data.published ? "Disable — ISC has no way to unpublish a data segment directly" : "Publish"}
                onClick={() => togglePublishState.mutate(data.published)}
                loading={togglePublishState.isPending}
                disabled={togglePublishState.isPending || remove.isPending}
              />
              <IconButton
                icon={Trash2}
                title="Delete"
                onClick={() => setConfirmDeleteOpen(true)}
                disabled={remove.isPending}
                className="!border-red-200 !text-red-600 hover:!bg-red-50"
              />
            </div>
          )
        }
      />
      <div className="flex-1 overflow-y-auto pb-24">
        {isLoading && (
          <div className="flex items-center justify-center py-16"><Spinner size={24} /></div>
        )}
        {error && <ErrorBox message={error.message} onRetry={refetch} />}

        {data && (
          <>
            <div className="px-4 py-4 flex items-center gap-3">
              <div className="w-12 h-12 rounded-full bg-violet-50 flex items-center justify-center flex-shrink-0">
                <Shapes size={20} className="text-violet-600" />
              </div>
              <div className="flex-1 min-w-0">
                <h2 className="text-base font-semibold text-gray-900 truncate">{data.name}</h2>
                <button
                  type="button"
                  title={data.enabled ? "Disable" : "Enable"}
                  onClick={() => toggleActive.mutate(!data.enabled)}
                  disabled={toggleActive.isPending}
                  className={`text-xs font-medium px-2 py-0.5 rounded-full border inline-block mt-1 mr-1 transition-colors disabled:opacity-50 ${
                    data.enabled
                      ? "bg-blue-50 text-blue-700 border-blue-200 hover:bg-red-50 hover:text-red-700 hover:border-red-200"
                      : "bg-gray-50 text-gray-500 border-gray-200 hover:bg-blue-50 hover:text-blue-700 hover:border-blue-200"
                  }`}
                >
                  {data.enabled ? "Active" : "Inactive"}
                </button>
                <button
                  type="button"
                  title={data.published ? "Disable — ISC has no way to unpublish a data segment directly" : "Publish"}
                  onClick={() => togglePublishState.mutate(data.published)}
                  disabled={togglePublishState.isPending}
                  className={`text-xs font-medium px-2 py-0.5 rounded-full border inline-block mt-1 transition-colors disabled:opacity-50 ${
                    data.published
                      ? "bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-gray-50 hover:text-gray-500 hover:border-gray-200"
                      : "bg-amber-50 text-amber-700 border-amber-200 hover:bg-emerald-50 hover:text-emerald-700 hover:border-emerald-200"
                  }`}
                >
                  {data.published ? "Published" : "Draft"}
                </button>
              </div>
            </div>

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
                  <div>
                    <SectionLabel>Details</SectionLabel>
                    <div className="px-4">
                      <InfoRow label="Description" value={data.description || "—"} />
                      <InfoRow label="Created" value={data.created ? new Date(data.created).toLocaleString() : "—"} />
                      <InfoRow label="Modified" value={data.modified ? new Date(data.modified).toLocaleString() : "—"} />
                    </div>

                    <SectionLabel>Visibility Criteria</SectionLabel>
                    <div className="px-4">
                      <div className="border border-gray-100 rounded-xl p-4">
                        <p className="text-sm text-gray-900 font-mono break-words">
                          {describeExpression(data.memberFilter?.expression, byGuid)}
                        </p>
                      </div>
                    </div>

                    {data.drafts?.length > 0 && (
                      <>
                        <SectionLabel>
                          Other Drafts ({data.drafts.length}) — ISC lets a data segment have more than one draft alongside a published version
                        </SectionLabel>
                        <div className="px-4 pb-4">
                          <div className="border border-gray-100 rounded-xl overflow-hidden divide-y divide-gray-100">
                            {data.drafts.map((d) => (
                              <button
                                key={d.id}
                                type="button"
                                onClick={() => navigate(`/segments/${d.id}`)}
                                className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-gray-50 active:bg-gray-100"
                              >
                                <div className="w-8 h-8 rounded-full bg-amber-50 flex items-center justify-center flex-shrink-0">
                                  <FileText size={14} className="text-amber-600" />
                                </div>
                                <div className="flex-1 min-w-0">
                                  <p className="text-sm font-medium text-gray-900 truncate">Draft</p>
                                  <p className="text-xs text-gray-500 mt-0.5 truncate">
                                    {d.modified ? `Modified ${new Date(d.modified).toLocaleString()}` : d.description || "—"}
                                  </p>
                                </div>
                                <span
                                  className={`text-xs font-medium px-2 py-0.5 rounded-full border flex-shrink-0 ${
                                    d.enabled
                                      ? "bg-blue-50 text-blue-700 border-blue-200"
                                      : "bg-gray-50 text-gray-500 border-gray-200"
                                  }`}
                                >
                                  {d.enabled ? "Active" : "Inactive"}
                                </span>
                                <ChevronRight size={16} className="text-gray-300 flex-shrink-0" />
                              </button>
                            ))}
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                )}

                {section === "members" && <MembersPanel segmentId={id} navigate={navigate} />}

                {(section === "roles" || section === "entitlements") && (
                  <AccessPanel segmentId={id} scopes={data.scopes} section={section} navigate={navigate} />
                )}

                {section === "json" && (
                  <RawJsonPanel data={data} resource="data-segments" objectId={id} invalidateKeys={[["segment", id], ["segments"]]} />
                )}
              </div>
            </div>
          </>
        )}
      </div>

      {confirmDeleteOpen && (
        <ConfirmModal
          title="Delete this data segment?"
          message="This permanently deletes the data segment from this tenant. This cannot be undone."
          confirmLabel="Delete"
          danger
          pending={remove.isPending}
          onConfirm={() => remove.mutate()}
          onCancel={() => setConfirmDeleteOpen(false)}
        />
      )}
    </div>
  );
}
