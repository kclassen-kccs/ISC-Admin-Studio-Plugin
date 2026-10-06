import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Key, ChevronRight, ChevronLeft, User, X, Printer, Wand2, UserCog, Mail, CheckCircle2, XCircle, Tags } from "lucide-react";
import {
  listEntitlements, getEntitlementsCount, listSources, getCredentials, getSchemaAnalysis, listIdentities,
  listEntitlementMembers, listRolesByEntitlement, listAccessProfilesByEntitlement,
  listEntitlementApplications, getEntitlementSegments, updateEntitlement, generateAllEntitlementDescriptions, NO_OWNER,
  fetchAllPages,
} from "../lib/sailpoint";
import { printEntitlementsDetailPdf, buildEntitlementsDetailPdfBase64 } from "../lib/exportEntitlementPdf";
import { useUrlSearch } from "../hooks/useUrlSearch";
import { useUrlState } from "../hooks/useUrlState";
import { MetadataFilterControl, useMetadataFilter } from "../components/MetadataFilter";
import { SegmentFilterControl, useSegmentFilter } from "../components/SegmentFilter";
import { searchAccessIdsByMetadata, getSegmentAccess, getEntitlementsByIds, METADATA_NOT_SET } from "../lib/sailpoint";
import { useEmailReportAction } from "../hooks/useEmailReportAction";
import { TopBar } from "../components/TopBar";
import { BrowseTitleMenu } from "../components/BrowseTitleMenu";
import {
  SearchBar, FilterBar, SkeletonList, EmptyState, ErrorBox, IconButton, SelectionActionBar,
  PrimaryButton, OutlineButton, ConfirmModal, Pager, iscMaxOffset,
} from "../components/ui";
import { useBulkTagMetadata } from "../components/BulkTagMetadata";
import { PickerField } from "../components/PickerField";
import { ChangeOwnerModal } from "../components/ChangeOwnerModal";
import { BulkDescriptionReviewSheet } from "../components/BulkDescriptionReviewSheet";
import { EmailReportDialog } from "../components/EmailReportDialog";
import toast from "react-hot-toast";

// A tenant's entitlement count routinely dwarfs its identity count (every
// group on every source is one), so this follows IdentitiesPage's paginated
// pattern rather than Roles'/Access Profiles' fetchAllPages one.
const PAGE_SIZE = 100;

const searchIdentitiesForOwner = async (q) =>
  (await listIdentities({ limit: 15, query: q || undefined })).map((i) => ({ id: i.id, name: i.name }));

// Shared by Print Selected and Email Report — both need each entitlement's
// own Members/Roles/Access Profiles/Applications/Segments (same detail
// Entitlement Detail's own print shows), which the list endpoint doesn't
// return. Fetched a few entitlements at a time, same reasoning as
// AccessProfilesPage's enrichProfilesForReport: a large selection firing
// hundreds of requests at once isn't worth the risk. `includeSegments`
// mirrors the Segments tab's own gate — skip the fetch entirely on a
// tenant that doesn't use the feature.
async function enrichEntitlementsForReport(entitlements, includeSegments) {
  const enriched = [];
  const batchSize = 3;
  for (let i = 0; i < entitlements.length; i += batchSize) {
    const batch = entitlements.slice(i, i + batchSize);
    enriched.push(
      ...(await Promise.all(
        batch.map(async (entitlement) => {
          const [membersResult, roles, accessProfiles, applications, segments] = await Promise.all([
            listEntitlementMembers(entitlement.id, { limit: 50, offset: 0 }),
            listRolesByEntitlement(entitlement.id),
            listAccessProfilesByEntitlement(entitlement.id),
            listEntitlementApplications(entitlement.id),
            includeSegments ? getEntitlementSegments(entitlement.id) : Promise.resolve([]),
          ]);
          return {
            ...entitlement,
            members: membersResult.members,
            totalMembers: membersResult.total,
            roles,
            accessProfiles,
            applications,
            segments,
          };
        })
      ))
    );
  }
  return enriched;
}

// A single-identity search-and-pick, same PickerField the Owner field on
// AccessProfilesPage's create form uses — not a free-text name, since a
// typed name can't reliably resolve to one identity (duplicates, nicknames)
// the way filtering by owner.id does.
function OwnerFilterModal({ initialOwner, onApply, onClear, onCancel }) {
  const [owner, setOwner] = useState(initialOwner ? [initialOwner] : []);

  return (
    <div
      className="fixed inset-0 bg-black/30 z-30 flex items-end md:items-center justify-center"
      onClick={(e) => e.target === e.currentTarget && onCancel()}
    >
      <div className="bg-white w-full max-w-md md:mx-4 rounded-t-2xl md:rounded-2xl shadow-xl p-5">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-10 h-10 rounded-full bg-blue-50 flex items-center justify-center flex-shrink-0">
            <User size={18} className="text-blue-600" />
          </div>
          <h2 className="text-base font-semibold text-gray-900">Filter by Owner</h2>
        </div>
        <PickerField
          label="Owner"
          placeholder="Search users…"
          searchFn={searchIdentitiesForOwner}
          multi={false}
          selected={owner}
          onChange={setOwner}
        />
        <button
          type="button"
          onClick={() => onApply({ id: NO_OWNER, name: "No Owner" })}
          className={`w-full text-left text-sm px-3 py-2.5 mb-3 rounded-xl border transition-colors ${
            owner[0]?.id === NO_OWNER
              ? "border-blue-200 bg-blue-50 text-blue-700"
              : "border-gray-200 text-gray-600 hover:border-gray-300"
          }`}
        >
          No Owner — entitlements with nothing set in Owner
        </button>
        <div className="flex gap-2">
          <PrimaryButton onClick={() => onApply(owner[0])} disabled={!owner[0]}>
            Apply
          </PrimaryButton>
          <OutlineButton onClick={onCancel}>Cancel</OutlineButton>
        </div>
        {initialOwner && (
          <button
            onClick={onClear}
            className="mt-3 w-full text-xs font-medium text-red-600 hover:text-red-700"
          >
            Clear owner filter
          </button>
        )}
      </div>
    </div>
  );
}

export default function EntitlementsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { search, debouncedSearch, handleSearch: handleUrlSearch } = useUrlSearch();
  const [sourceFilter, setSourceFilter] = useUrlState("source", "ALL");
  // ALL | REQUESTABLE | NOT_REQUESTABLE — same left-pill pattern as Roles'/
  // Access Profiles' Active/Disabled filter, URL-backed so it survives
  // navigating into an entitlement's detail page and clicking Back.
  const [requestableFilter, setRequestableFilter] = useUrlState("requestable", "ALL");
  // ALL | NONE | LOW | MEDIUM | HIGH — matched against each entitlement's
  // EFFECTIVE privilege level (an entitlement with no level at all counts
  // as NONE). ISC's list API can only filter the DIRECT level, so this
  // takes the same fetch-every-page path the No Owner filter uses.
  const [privilegeFilter, setPrivilegeFilter] = useUrlState("privilege", "ALL");
  // Access Model Metadata attribute + value — resolved to matching ids via
  // ISC Search, then applied on the same fetch-every-page path as No Owner.
  const metadataFilter = useMetadataFilter();
  // Data Segment — the entitlements on the segment's Access Model.
  const segmentFilter = useSegmentFilter();
  // Id and name packed into ONE url param — same reasoning as Identities'
  // attribute filter (attrParam in IdentitiesPage.jsx): firing two separate
  // useUrlState calls back-to-back races, since each reads the current URL
  // fresh and the second silently clobbers the first.
  const [ownerParam, setOwnerParam] = useUrlState("owner", "");
  const ownerSepIdx = ownerParam.indexOf("|");
  const ownerId = ownerSepIdx === -1 ? "" : ownerParam.slice(0, ownerSepIdx);
  const ownerName = ownerSepIdx === -1 ? "" : decodeURIComponent(ownerParam.slice(ownerSepIdx + 1));
  const [ownerDialogOpen, setOwnerDialogOpen] = useState(false);
  // Page offset in the URL (like every filter here), so Back returns to the
  // same page and a bookmarked page reopens on it.
  const [offsetStr, setOffsetStr] = useUrlState("offset", "0");
  const rawOffset = Math.max(Number(offsetStr) || 0, 0);
  const setOffset = (n) => setOffsetStr(String(n));
  const [selected, setSelected] = useState(() => new Set());
  const [descriptionResults, setDescriptionResults] = useState(null);
  const [changeOwnerOpen, setChangeOwnerOpen] = useState(false);
  const [progress, setProgress] = useState(0);

  const handleSearch = (value) => {
    handleUrlSearch(value);
    setOffset(0); // a new search always starts back at page 1
  };

  function handleSourceFilter(value) {
    setSourceFilter(value);
    setOffset(0);
  }

  function handleRequestableFilter(value) {
    setRequestableFilter(value);
    setOffset(0);
  }

  function handlePrivilegeFilter(value) {
    setPrivilegeFilter(value);
    setOffset(0);
  }

  function applyMetadataFilter(f) {
    metadataFilter.set(f);
    setOffset(0);
  }
  function clearMetadataFilter() {
    metadataFilter.clear();
    setOffset(0);
  }
  function applySegmentFilter(s) {
    segmentFilter.set(s);
    setOffset(0);
  }
  function clearSegmentFilter() {
    segmentFilter.clear();
    setOffset(0);
  }

  function applyOwnerFilter(owner) {
    setOwnerParam(owner ? `${owner.id}|${encodeURIComponent(owner.name)}` : "");
    setOwnerDialogOpen(false);
    setOffset(0);
  }

  function clearOwnerFilter() {
    setOwnerParam("");
    setOwnerDialogOpen(false);
    setOffset(0);
  }

  const sourceId = sourceFilter !== "ALL" ? sourceFilter : undefined;
  const requestable = requestableFilter === "REQUESTABLE" ? true : requestableFilter === "NOT_REQUESTABLE" ? false : undefined;

  const { data: sources } = useQuery({
    queryKey: ["sources-for-entitlements-filter"],
    queryFn: () => listSources({ limit: 250 }),
    staleTime: 5 * 60 * 1000,
  });

  // Same gate the Segments tab itself uses — no point fetching segments per
  // entitlement in the print report on a tenant that doesn't use them.
  const { data: schemaAnalysis } = useQuery({
    queryKey: ["schema-analysis"],
    queryFn: getSchemaAnalysis,
    staleTime: 5 * 60 * 1000,
  });

  const emailReport = useEmailReportAction({
    objectLabel: "Entitlement",
    buildDetailPdfBase64: async ({ tenant, items }) => {
      const enriched = await enrichEntitlementsForReport(items, !!schemaAnalysis?.createDataSegments);
      return buildEntitlementsDetailPdfBase64({ tenant, entitlements: enriched });
    },
    itemLabel: (e) => e.name || e.value,
    onDone: () => setSelected(new Set()),
  });

  const isNoOwner = ownerId === NO_OWNER;

  // "No owner" can't be a server-side filter at all on this endpoint (see
  // the long comment on entitlementListFilters in lib/sailpoint.js — every
  // operator ISC offers for owner.id besides plain EQ against a real id was
  // rejected live). The only way left to answer "which entitlements have no
  // owner" is to fetch every page matching the other filters (source/name)
  // and check `owner` client-side — same fetchAllPages Roles/Access
  // Profiles already use, just gated to this one filter combination rather
  // than every load, since a tenant's full entitlement set can be large.
  // The privilege filter shares this client-side path: every page matching
  // the server-side filters is fetched once, then owner / effective
  // privilege are checked locally.
  const privilege = privilegeFilter !== "ALL" ? privilegeFilter : undefined;
  const metadata = metadataFilter.filter;
  const segment = segmentFilter.filter;
  const isClientFiltered = isNoOwner || !!privilege || !!metadata || !!segment;
  // ISC refuses offset + limit past 10,000 on /v2026/entitlements, so a
  // server-paged list stops there however many entitlements the tenant has —
  // clamped here as well as in the pager, so a bookmarked deep offset doesn't
  // come back 400. The client-filtered path already holds every row in memory
  // and isn't subject to it.
  const maxOffset = isClientFiltered ? undefined : iscMaxOffset(PAGE_SIZE);
  const offset = maxOffset == null ? rawOffset : Math.min(rawOffset, maxOffset);
  const effectivePrivilege = (e) => String(e.privilegeLevel?.effective || e.privilegeLevel?.direct || e.privilegeLevel?.inherited || "NONE").toUpperCase();
  const noOwnerQuery = useQuery({
    queryKey: ["entitlements-client-filtered", debouncedSearch, sourceId, requestable, isNoOwner ? NO_OWNER : ownerId, privilege, metadata?.key, metadata?.value, segment?.id],
    queryFn: async () => {
      // Metadata / segment filters start from their matched ids and fetch
      // just those rows (a tenant can have thousands of entitlements, so
      // crawling every page for them never finished). The other filters —
      // source, name, requestable, owner, privilege — are then applied to
      // that set client-side. Without an id-based filter, the No Owner /
      // privilege path still crawls every page matching the server filters.
      //
      // "(Not Set)" is the complement, which on a large tenant is most of the
      // entitlements — too many to fetch by id. So it fetches the ids that DO
      // have a value for the attribute (the small side) and excludes them from
      // the normal candidate set instead.
      const notSet = metadata?.value === METADATA_NOT_SET;
      const [metadataIds, segmentAccess] = await Promise.all([
        metadata ? searchAccessIdsByMetadata("entitlements", metadata.key, notSet ? null : metadata.value) : null,
        segment ? getSegmentAccess(segment.id) : null,
      ]);
      const taggedIds = notSet ? null : metadataIds;
      const excludedIds = notSet ? metadataIds : null;
      const segmentIds = segmentAccess ? new Set((segmentAccess.entitlements || []).map((e) => e.id)) : null;
      let candidates;
      if (taggedIds || segmentIds) {
        let ids = taggedIds ? [...taggedIds] : [...segmentIds];
        if (taggedIds && segmentIds) ids = ids.filter((id) => segmentIds.has(id));
        // Chunked — the by-ids route takes ids on the query string, and a
        // segment can carry hundreds of entitlements.
        const chunks = [];
        for (let i = 0; i < ids.length; i += 100) chunks.push(ids.slice(i, i + 100));
        candidates = (await Promise.all(chunks.map((c) => getEntitlementsByIds(c)))).flat();
        const term = debouncedSearch.trim().toLowerCase();
        candidates = candidates.filter((e) =>
          (!sourceId || e.source?.id === sourceId) &&
          (!term || String(e.name || e.value || "").toLowerCase().includes(term)) &&
          (requestable === undefined || !!e.requestable === requestable) &&
          (isNoOwner || !ownerId || e.owner?.id === ownerId)
        );
      } else {
        candidates = await fetchAllPages((page) => listEntitlements({ ...page, query: debouncedSearch || undefined, sourceId, ownerId: !isNoOwner && ownerId ? ownerId : undefined, requestable }));
      }
      return candidates.filter((e) =>
        (!excludedIds || !excludedIds.has(e.id)) &&
        (!isNoOwner || !e.owner?.id) &&
        (!privilege || effectivePrivilege(e) === privilege)
      );
    },
    enabled: isClientFiltered,
  });

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["entitlements", debouncedSearch, sourceId, ownerId, requestable, offset],
    queryFn: () => listEntitlements({ limit: PAGE_SIZE, offset, query: debouncedSearch || undefined, sourceId, ownerId: ownerId || undefined, requestable }),
    keepPreviousData: true,
    enabled: !isClientFiltered,
  });

  const { data: totalCount } = useQuery({
    queryKey: ["entitlements-count", debouncedSearch, sourceId, ownerId, requestable],
    queryFn: () => getEntitlementsCount({ query: debouncedSearch || undefined, sourceId, ownerId: ownerId || undefined, requestable }),
    enabled: !isClientFiltered,
  });

  const list = isClientFiltered ? (noOwnerQuery.data || []).slice(offset, offset + PAGE_SIZE) : Array.isArray(data) ? data : [];
  const total = isClientFiltered ? noOwnerQuery.data?.length ?? null : typeof totalCount === "number" ? totalCount : null;
  const listIsLoading = isClientFiltered ? noOwnerQuery.isLoading : isLoading;
  const listIsFetching = isClientFiltered ? noOwnerQuery.isFetching : isFetching;
  const listError = isClientFiltered ? noOwnerQuery.error : error;
  const listRefetch = isClientFiltered ? noOwnerQuery.refetch : refetch;
  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = total != null ? Math.min(offset + list.length, total) : offset + list.length;
  const hasPrev = offset > 0;
  const hasNext = total != null ? offset + list.length < total : list.length === PAGE_SIZE;
  const allSelected = list.length > 0 && list.every((e) => selected.has(e.id));
  // Tag Metadata: add a metadata value to — or remove it from — the selection.
  const tagMetadata = useBulkTagMetadata({
    kind: "entitlements",
    noun: "entitlements",
    ids: [...selected],
    names: new Map(list.map((x) => [x.id, x.displayName || x.name])),
    invalidateKeys: [["entitlements"], ["entitlement"]],
    onDone: () => setSelected(new Set()),
  });
  const filtersActive = !!sourceId || !!ownerId || requestable !== undefined;
  const entitlementById = new Map(list.map((e) => [e.id, e]));

  function toggleOne(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) => {
      if (allSelected) return new Set();
      return new Set(list.map((e) => e.id));
    });
  }

  // Selection is scoped to the current (100-row) page, same as IdentitiesPage's
  // "Select all shown" — there's no bulk-select-across-pages concept here.
  const printSelected = useMutation({
    mutationFn: async () => {
      const tenant = getCredentials()?.tenant;
      const chosen = list.filter((e) => selected.has(e.id));
      const enriched = await enrichEntitlementsForReport(chosen, !!schemaAnalysis?.createDataSegments);
      return printEntitlementsDetailPdf({ tenant, entitlements: enriched });
    },
    onSuccess: (opened) => {
      if (!opened) toast("Pop-up blocked — downloaded the PDF instead");
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const generateDescriptions = useMutation({
    mutationFn: () => generateAllEntitlementDescriptions([...selected]),
    onSuccess: (result) => {
      setDescriptionResults(result.results);
      setSelected(new Set());
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const saveDescriptions = useMutation({
    mutationFn: (items) => Promise.all(items.map(({ roleId, description }) => updateEntitlement(roleId, { description }))),
    onSuccess: (_result, items) => {
      toast.success(`${items.length} description${items.length === 1 ? "" : "s"} saved`);
      queryClient.invalidateQueries({ queryKey: ["entitlements"] });
      setDescriptionResults(null);
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const bulkChangeOwner = useMutation({
    mutationFn: async (owner) => {
      const ids = [...selected];
      const results = [];
      for (const id of ids) {
        try {
          await updateEntitlement(id, { owner: { id: owner.id, name: owner.name } });
          results.push({ id, ok: true });
        } catch (err) {
          results.push({ id, ok: false, error: err.response?.data?.error || err.message });
        }
        setProgress(results.length);
      }
      return results;
    },
    onSuccess: (results) => {
      const failed = results.filter((r) => !r.ok);
      if (failed.length) {
        toast.error(`Changed owner for ${results.length - failed.length} of ${results.length} entitlements — ${failed.length} failed`);
      } else {
        toast.success(`Changed owner for ${results.length} entitlement${results.length === 1 ? "" : "s"}`);
      }
      setSelected(new Set());
      setChangeOwnerOpen(false);
      setProgress(0);
      queryClient.invalidateQueries({ queryKey: ["entitlements"] });
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  // Same sequential-loop-with-progress shape as bulkChangeOwner — used by
  // both the Make Requestable and No Requests bulk actions below (the run
  // callback is the only thing that differs between them).
  function makeBulkRequestableToggle(nextValue) {
    return async () => {
      const ids = [...selected];
      const results = [];
      for (const id of ids) {
        try {
          await updateEntitlement(id, { requestable: nextValue });
          results.push({ id, ok: true });
        } catch (err) {
          results.push({ id, ok: false, error: err.response?.data?.error || err.message });
        }
        setProgress(results.length);
      }
      return results;
    };
  }

  function onBulkRequestableSettled(results, verb) {
    const failed = results.filter((r) => !r.ok);
    if (failed.length) {
      toast.error(`${verb} ${results.length - failed.length} of ${results.length} entitlements — ${failed.length} failed`);
    } else {
      toast.success(`${verb} ${results.length} entitlement${results.length === 1 ? "" : "s"}`);
    }
    setSelected(new Set());
    setProgress(0);
    queryClient.invalidateQueries({ queryKey: ["entitlements"] });
  }

  const bulkMakeRequestable = useMutation({
    mutationFn: makeBulkRequestableToggle(true),
    onSuccess: (results) => onBulkRequestableSettled(results, "Made requestable"),
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const bulkNoRequests = useMutation({
    mutationFn: makeBulkRequestableToggle(false),
    onSuccess: (results) => onBulkRequestableSettled(results, "Set to no requests"),
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const bulkRequestablePending = bulkMakeRequestable.isPending || bulkNoRequests.isPending;

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <TopBar title={<BrowseTitleMenu active="Entitlements" />} loading={listIsLoading} />
      <div className="flex-1 overflow-y-auto pb-24">
        <SearchBar value={search} onChange={handleSearch} placeholder="Search entitlements by name…" />

        <FilterBar
          options={[
            { value: "ALL", label: "All" },
            { value: "REQUESTABLE", label: "Requestable" },
            { value: "NOT_REQUESTABLE", label: "Not Requestable" },
          ]}
          active={requestableFilter}
          onChange={handleRequestableFilter}
          right={
            <div className="flex items-center gap-2">
              {/* Capped and truncated — unlike an identity profile name, a
                  SailPoint source name routinely runs long enough (e.g.
                  "Workday - HRIS Connector - Production") that this select's
                  intrinsic width could push the whole filter row past the
                  right edge of the app's narrow (max-w-md) column. */}
              <select
                value={sourceFilter}
                onChange={(e) => handleSourceFilter(e.target.value)}
                className="max-w-[9rem] truncate text-xs font-medium px-2.5 py-1.5 rounded-full border border-gray-200 bg-white text-gray-600 outline-none focus:border-blue-400"
              >
                <option value="ALL">All Sources</option>
                {(sources || []).map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
              <select
                value={privilegeFilter}
                onChange={(e) => handlePrivilegeFilter(e.target.value)}
                title="Effective privilege level"
                className={`max-w-[9rem] truncate text-xs font-medium px-2.5 py-1.5 rounded-full border outline-none focus:border-blue-400 ${
                  privilegeFilter !== "ALL" ? "bg-blue-600 text-white border-blue-600" : "bg-white text-gray-600 border-gray-200"
                }`}
              >
                <option value="ALL">All Privilege</option>
                <option value="NONE">Privilege: None</option>
                <option value="LOW">Privilege: Low</option>
                <option value="MEDIUM">Privilege: Medium</option>
                <option value="HIGH">Privilege: High</option>
              </select>
              <MetadataFilterControl filter={metadataFilter.filter} onApply={applyMetadataFilter} onClear={clearMetadataFilter} />
              <SegmentFilterControl filter={segmentFilter.filter} onApply={applySegmentFilter} onClear={clearSegmentFilter} />
              {ownerId ? (
                <span className="flex-shrink-0 inline-flex items-center gap-1 text-xs font-medium pl-3 pr-1.5 py-1.5 rounded-full border bg-blue-600 text-white border-blue-600">
                  <button
                    type="button"
                    onClick={() => setOwnerDialogOpen(true)}
                    className="hover:underline truncate max-w-[7rem] text-left"
                  >
                    {ownerId === NO_OWNER ? "No Owner" : `Owner: ${ownerName}`}
                  </button>
                  <button
                    type="button"
                    onClick={clearOwnerFilter}
                    title="Clear owner filter"
                    className="p-0.5 rounded-full hover:bg-blue-700 transition-colors flex-shrink-0"
                  >
                    <X size={12} />
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => setOwnerDialogOpen(true)}
                  className="flex-shrink-0 text-xs font-medium px-3 py-1.5 rounded-full border border-gray-200 bg-white text-gray-600 hover:border-gray-300 transition-colors"
                >
                  Owner…
                </button>
              )}
            </div>
          }
        />

        {listError && <ErrorBox message={listError.message} onRetry={listRefetch} />}
        {listIsLoading && <SkeletonList rows={8} />}
        {!listIsLoading && !listError && list.length === 0 && (
          <EmptyState
            icon={Key}
            title={debouncedSearch || filtersActive ? "No results" : "No entitlements found"}
            subtitle={
              debouncedSearch
                ? `No entitlements match "${debouncedSearch}"`
                : filtersActive
                ? "No entitlements match the selected filters"
                : "Your tenant has no entitlements yet"
            }
          />
        )}

        {!listIsLoading && list.length > 0 && (
          <div>
            <Pager offset={offset} pageSize={PAGE_SIZE} total={total} noun="entitlement" onOffsetChange={setOffset} hasNext={hasNext} busy={listIsFetching} maxOffset={maxOffset} />
            <div className="flex items-center justify-between px-4 py-2 gap-3">
              <label className="flex items-center gap-2 text-xs text-gray-500">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  className="w-4 h-4 rounded border-gray-300"
                />
                Select all shown
              </label>
              {total != null && (
                <p className="text-xs text-gray-400">
                  {pageStart.toLocaleString()}–{pageEnd.toLocaleString()} of {total.toLocaleString()}
                </p>
              )}
            </div>

            {selected.size > 0 && (
              <SelectionActionBar
                count={selected.size}
                progressText={
                  bulkChangeOwner.isPending
                    ? `Changing owner for ${progress} of ${selected.size}…`
                    : bulkRequestablePending
                    ? `Updating ${progress} of ${selected.size}…`
                    : null
                }
                actions={[
                  { icon: Tags, title: `Tag Metadata (${selected.size})`, onClick: tagMetadata.open, loading: tagMetadata.pending },
                  {
                    icon: Wand2,
                    title: `Generate Descriptions (${selected.size})`,
                    onClick: () => generateDescriptions.mutate(),
                    loading: generateDescriptions.isPending,
                  },
                  {
                    icon: UserCog,
                    title: `Change Owner (${selected.size})`,
                    onClick: () => setChangeOwnerOpen(true),
                    disabled: bulkChangeOwner.isPending,
                  },
                  {
                    icon: CheckCircle2,
                    title: `Make Requestable (${selected.size})`,
                    onClick: () => bulkMakeRequestable.mutate(),
                    loading: bulkMakeRequestable.isPending,
                    disabled: bulkRequestablePending,
                  },
                  {
                    icon: XCircle,
                    title: `No Requests (${selected.size})`,
                    onClick: () => bulkNoRequests.mutate(),
                    loading: bulkNoRequests.isPending,
                    disabled: bulkRequestablePending,
                  },
                  {
                    icon: Mail,
                    title: `Email Report (${selected.size})`,
                    onClick: () => emailReport.setConfirmOpen(true),
                    loading: emailReport.mutation.isPending,
                    disabled: emailReport.mutation.isPending,
                  },
                  {
                    icon: Printer,
                    title: `Print Selected (${selected.size})`,
                    onClick: () => printSelected.mutate(),
                    loading: printSelected.isPending,
                  },
                ]}
              />
            )}

            {list.map((e) => (
              <div
                key={e.id}
                className="w-full flex items-center gap-3 px-4 py-3.5 border-b border-gray-100 hover:bg-gray-50 transition-colors"
              >
                <input
                  type="checkbox"
                  checked={selected.has(e.id)}
                  onChange={() => toggleOne(e.id)}
                  className="w-4 h-4 rounded border-gray-300 flex-shrink-0"
                />
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => navigate(`/entitlements/${e.id}`)}
                  onKeyDown={(ev) => ev.key === "Enter" && navigate(`/entitlements/${e.id}`)}
                  className="flex-1 min-w-0 flex items-center gap-3 text-left cursor-pointer active:bg-gray-100"
                >
                  <div className="w-10 h-10 rounded-full bg-orange-50 flex items-center justify-center flex-shrink-0">
                    <Key size={16} className="text-orange-600" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{e.name || e.value}</p>
                    <p className="text-xs text-gray-500 mt-0.5 truncate">
                      {[e.source?.name, e.owner?.name].filter(Boolean).join(" · ") || "—"}
                    </p>
                  </div>
                  <span
                    className={`text-xs font-medium px-2 py-0.5 rounded-full border flex-shrink-0 ${
                      e.requestable
                        ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                        : "bg-gray-50 text-gray-500 border-gray-200"
                    }`}
                  >
                    {e.requestable ? "Requestable" : "No Requests"}
                  </span>
                  <ChevronRight size={16} className="text-gray-300 flex-shrink-0" />
                </div>
              </div>
            ))}

            <Pager offset={offset} pageSize={PAGE_SIZE} total={total} noun="entitlement" onOffsetChange={setOffset} hasNext={hasNext} busy={listIsFetching} maxOffset={maxOffset} />
          </div>
        )}
      </div>

      {ownerDialogOpen && (
        <OwnerFilterModal
          initialOwner={ownerId ? { id: ownerId, name: ownerName } : null}
          onApply={applyOwnerFilter}
          onClear={clearOwnerFilter}
          onCancel={() => setOwnerDialogOpen(false)}
        />
      )}

      {descriptionResults && (
        <BulkDescriptionReviewSheet
          items={descriptionResults}
          roleById={entitlementById}
          onClose={() => setDescriptionResults(null)}
          onSaveSelected={(items) => saveDescriptions.mutate(items)}
          pending={saveDescriptions.isPending}
        />
      )}

      {changeOwnerOpen && (
        <ChangeOwnerModal
          count={selected.size}
          pending={bulkChangeOwner.isPending}
          progressText={`Changing owner for ${progress} of ${selected.size}…`}
          onConfirm={(owner) => bulkChangeOwner.mutate(owner)}
          onClose={() => setChangeOwnerOpen(false)}
        />
      )}

      {emailReport.confirmOpen && (
        <ConfirmModal
          title={`Email report for ${selected.size} entitlement${selected.size === 1 ? "" : "s"}?`}
          message={
            `Builds one Entitlement Report PDF per entitlement owner (entitlements sharing an owner are combined ` +
            `into one report) and publishes each to a link — the link is used instead of an attachment since email ` +
            `links can't carry files. Nothing is sent automatically: you'll get a list to review, and each email ` +
            `only opens your mail app when you click its own send icon, one at a time. An entitlement with no ` +
            `owner, or an owner with no email address on file, is skipped.`
          }
          confirmLabel="Build Reports"
          pending={emailReport.mutation.isPending}
          onConfirm={() => emailReport.mutation.mutate(list.filter((e) => selected.has(e.id)))}
          onCancel={() => emailReport.setConfirmOpen(false)}
        />
      )}

      {emailReport.dialog && (
        <EmailReportDialog
          objectLabel="Entitlement"
          dialog={emailReport.dialog}
          onClose={() => emailReport.setDialog(null)}
          onMarkSent={(ownerId) =>
            emailReport.setDialog((prev) => ({
              ...prev,
              prepared: prev.prepared.map((r) => (r.ownerId === ownerId ? { ...r, sent: true } : r)),
            }))
          }
        />
      )}
      {tagMetadata.element}
    </div>
  );
}
