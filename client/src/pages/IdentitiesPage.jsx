import { useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Users, ChevronRight, UserCheck, UserX, X, Tag } from "lucide-react";
import toast from "react-hot-toast";
import {
  listIdentitiesPage, setIdentityLifecycleState, getIdentitiesCount,
  listIdentityProfiles, getSchemaAnalysis,
} from "../lib/sailpoint";
import { useUrlSearch } from "../hooks/useUrlSearch";
import { useUrlState } from "../hooks/useUrlState";
import { SegmentFilterControl, useSegmentFilter, normalizeSegmentMember } from "../components/SegmentFilter";
import { listSegmentMembers } from "../lib/sailpoint";
import { TopBar } from "../components/TopBar";
import { BrowseTitleMenu } from "../components/BrowseTitleMenu";
import { Avatar, SearchBar, FilterBar, SkeletonList, EmptyState, ErrorBox, SelectionActionBar, Field, Select, Input, PrimaryButton, OutlineButton, Pager, iscMaxOffset } from "../components/ui";

function AttributeFilterModal({ candidates, initialKey, initialValue, onApply, onClear, onCancel }) {
  const [key, setKey] = useState(initialKey || candidates[0]?.key || "");
  const [value, setValue] = useState(initialValue || "");

  return (
    <div
      className="fixed inset-0 bg-black/30 z-30 flex items-end md:items-center justify-center"
      onClick={(e) => e.target === e.currentTarget && onCancel()}
    >
      <div className="bg-white w-full max-w-md md:mx-4 rounded-t-2xl md:rounded-2xl shadow-xl p-5">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-10 h-10 rounded-full bg-blue-50 flex items-center justify-center flex-shrink-0">
            <Tag size={18} className="text-blue-600" />
          </div>
          <h2 className="text-base font-semibold text-gray-900">Filter by Attribute</h2>
        </div>
        <Field label="Attribute (from Schema Analysis)">
          <Select value={key} onChange={(e) => setKey(e.target.value)}>
            {candidates.map((c) => (
              <option key={c.key} value={c.key}>{c.key}</option>
            ))}
          </Select>
        </Field>
        <Field label="Value">
          <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder={'Text to match, e.g. "Eng" matches Engineer/Engineering…'} />
        </Field>
        <div className="flex gap-2">
          <PrimaryButton onClick={() => onApply(key, value)} disabled={!key || !value.trim()}>
            Apply
          </PrimaryButton>
          <OutlineButton onClick={onCancel}>Cancel</OutlineButton>
        </div>
        {initialKey && initialValue && (
          <button
            onClick={onClear}
            className="mt-3 w-full text-xs font-medium text-red-600 hover:text-red-700"
          >
            Clear attribute filter
          </button>
        )}
      </div>
    </div>
  );
}

export default function IdentitiesPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { search, debouncedSearch, handleSearch } = useUrlSearch();
  const [selected, setSelected] = useState(() => new Set());
  const [progress, setProgress] = useState(0);
  const [lifecycleFilter, setLifecycleFilter] = useUrlState("lifecycle", "ALL");
  const [profileFilter, setProfileFilter] = useUrlState("profile", "ALL");
  // Key and value are packed into ONE url param (not two separate useUrlState
  // calls) — react-router's setSearchParams reads the current URL fresh on
  // each call, so firing it twice in the same handler (once for key, once
  // for value) raced and the second call silently clobbered the first,
  // leaving only the value (or only the key) actually applied.
  const [attrParam, setAttrParam] = useUrlState("attr", "");
  const attrSepIdx = attrParam.indexOf("=");
  const attrKey = attrSepIdx === -1 ? "" : decodeURIComponent(attrParam.slice(0, attrSepIdx));
  const attrValue = attrSepIdx === -1 ? "" : decodeURIComponent(attrParam.slice(attrSepIdx + 1));
  const [attrDialogOpen, setAttrDialogOpen] = useState(false);
  // Page offset in the URL, like the filters, so Back returns to the same
  // page. Any change to the search or a filter starts from page 1.
  const [offsetStr, setOffsetStr] = useUrlState("offset", "0");
  // ISC Search refuses offset + limit past 10,000, so deep pages are clamped
  // to the last one it will serve rather than sent through to a 400.
  const offset = Math.min(Math.max(Number(offsetStr) || 0, 0), iscMaxOffset(50));
  const setOffset = (n) => setOffsetStr(String(n));
  const resetPage = () => { if (offset) setOffset(0); };

  function setAttrFilter(key, value) {
    setAttrParam(key && value ? `${encodeURIComponent(key)}=${encodeURIComponent(value)}` : "");
    resetPage();
  }

  // Just the first page — this tenant can have tens of thousands of
  // identities, and fetching all of them up front (the pattern used for
  // Roles/Access Profiles/Sources, which top out far lower) made this
  // screen take a very long time to show anything. The count below still
  // reflects the true total; search/filters narrow what this first page shows.
  const IDENTITIES_PAGE_SIZE = 50;
  // Data Segment: when set, the list is the segment's own members (the
  // server runs the segment's criteria as the search), with the profile /
  // lifecycle / attribute filters applied to that page client-side, since
  // the members route only takes a name search.
  const segmentFilter = useSegmentFilter();
  const segment = segmentFilter.filter;
  // Each result is { identities, total }: total is ISC's count for exactly
  // this search + filters, so the pager can say "Page 3 of 17 (836)". It's
  // null when a segment view also has profile/lifecycle/attribute filters —
  // those are applied to the page client-side, so no true total exists and
  // the pager just offers Next while a page comes back full.
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["identities", debouncedSearch, profileFilter, lifecycleFilter, attrKey, attrValue, segment?.id, offset],
    queryFn: async () => {
      if (segment) {
        const resp = await listSegmentMembers(segment.id, { limit: IDENTITIES_PAGE_SIZE, offset, query: debouncedSearch || undefined });
        const rows = (Array.isArray(resp?.members) ? resp.members : []).map(normalizeSegmentMember);
        const clientFiltered = profileFilter !== "ALL" || lifecycleFilter !== "ALL" || !!attrKey;
        const identities = rows.filter((idn) =>
          (profileFilter === "ALL" || idn.identityProfile?.id === profileFilter) &&
          (lifecycleFilter === "ALL" || (lifecycleFilter.toLowerCase() === "inactive" ? !idn.active : idn.active)) &&
          (!attrKey || String(idn.attributes?.[attrKey] ?? "").includes(attrValue))
        );
        return { identities, total: clientFiltered ? null : (typeof resp?.total === "number" ? resp.total : null), pageFull: rows.length === IDENTITIES_PAGE_SIZE };
      }
      const page = await listIdentitiesPage({
        limit: IDENTITIES_PAGE_SIZE,
        offset,
        query: debouncedSearch || undefined,
        identityProfileId: profileFilter !== "ALL" ? profileFilter : undefined,
        lifecycleState: lifecycleFilter !== "ALL" ? lifecycleFilter : undefined,
        attributeKey: attrKey || undefined,
        attributeValue: attrValue || undefined,
      });
      return { ...page, pageFull: page.identities.length === IDENTITIES_PAGE_SIZE };
    },
    keepPreviousData: true,
  });

  const { data: totalCount } = useQuery({
    queryKey: ["identities-count"],
    queryFn: getIdentitiesCount,
  });

  const { data: identityProfiles } = useQuery({
    queryKey: ["identity-profiles"],
    queryFn: listIdentityProfiles,
    staleTime: 5 * 60 * 1000,
  });

  const { data: schemaAnalysis } = useQuery({
    queryKey: ["schema-analysis"],
    queryFn: getSchemaAnalysis,
    staleTime: 5 * 60 * 1000,
  });
  const attributeCandidates = schemaAnalysis?.candidates || [];

  const list = Array.isArray(data?.identities) ? data.identities : [];
  const pageTotal = typeof data?.total === "number" ? data.total : undefined;
  const pager = (
    <Pager
      offset={offset}
      pageSize={IDENTITIES_PAGE_SIZE}
      total={pageTotal}
      noun="identity"
      onOffsetChange={setOffset}
      maxOffset={iscMaxOffset(IDENTITIES_PAGE_SIZE)}
      hasNext={pageTotal === undefined ? !!data?.pageFull : undefined}
      busy={isFetching}
    />
  );
  const allSelected = list.length > 0 && list.every((idn) => selected.has(idn.id));
  const filtersActive = profileFilter !== "ALL" || lifecycleFilter !== "ALL" || !!(attrKey && attrValue);

  const toggleOne = useCallback((id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  function toggleAll() {
    setSelected((prev) => {
      if (allSelected) return new Set();
      return new Set(list.map((idn) => idn.id));
    });
  }

  const bulkSetLifecycle = useMutation({
    mutationFn: async (state) => {
      const ids = [...selected];
      const results = [];
      for (const id of ids) {
        try {
          await setIdentityLifecycleState(id, state);
          results.push({ id, ok: true });
        } catch (err) {
          results.push({ id, ok: false, error: err.response?.data?.error || err.message });
        }
        setProgress(results.length);
      }
      return { results, state };
    },
    onSuccess: ({ results, state }) => {
      const failed = results.filter((r) => !r.ok);
      const verb = state === "enable" ? "Enable" : "Disable";
      if (failed.length) {
        toast.error(`${verb} submitted for ${results.length - failed.length} of ${results.length} — ${failed.length} failed`);
      } else {
        toast.success(`${verb} submitted for ${results.length} identit${results.length === 1 ? "y" : "ies"} — this can take a few minutes to reflect.`);
      }
      setSelected(new Set());
      setProgress(0);
      queryClient.invalidateQueries({ queryKey: ["identities"] });
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const toggleOneLifecycle = useMutation({
    mutationFn: ({ id, state }) => setIdentityLifecycleState(id, state),
    onSuccess: (_data, { state }) => {
      toast.success(
        state === "enable"
          ? "Enable request submitted — this can take a few minutes to reflect."
          : "Disable request submitted — this can take a few minutes to reflect."
      );
      queryClient.invalidateQueries({ queryKey: ["identities"] });
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  function applyAttrFilter(key, value) {
    setAttrFilter(key, value);
    setAttrDialogOpen(false);
  }

  function clearAttrFilter() {
    setAttrFilter("", "");
    setAttrDialogOpen(false);
  }

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <TopBar title={<BrowseTitleMenu active="Identities" />} loading={isLoading} />
      <div className="flex-1 overflow-y-auto pb-24">
        <SearchBar
          value={search}
          onChange={(v) => { handleSearch(v); resetPage(); }}
          placeholder="Search by name or email…"
        />
        {typeof totalCount === "number" && (
          <p className="px-4 pb-2 text-xs text-gray-400">
            {totalCount.toLocaleString()} identit{totalCount === 1 ? "y" : "ies"} total
          </p>
        )}

        <FilterBar
          options={[
            { value: "ALL", label: "All" },
            { value: "ACTIVE", label: "Active" },
            { value: "INACTIVE", label: "Inactive" },
          ]}
          active={lifecycleFilter}
          onChange={(v) => { setLifecycleFilter(v); resetPage(); }}
          right={
            // Capped and truncated — an identity profile name or a
            // free-typed attribute value can run long enough to push this
            // row past the right edge of the app's narrow (max-w-md) mobile
            // column, same overflow class fixed on EntitlementsPage's
            // Source/Owner filters.
            <div className="flex items-center gap-2">
              <select
                value={profileFilter}
                onChange={(e) => { setProfileFilter(e.target.value); resetPage(); }}
                className="max-w-[8rem] truncate text-xs font-medium px-2.5 py-1.5 rounded-full border border-gray-200 bg-white text-gray-600 outline-none focus:border-blue-400"
              >
                <option value="ALL">All Identity Profiles</option>
                {(identityProfiles || []).map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
              {attributeCandidates.length > 0 && (
                attrKey && attrValue ? (
                  <span className="flex-shrink-0 inline-flex items-center gap-1 text-xs font-medium pl-3 pr-1.5 py-1.5 rounded-full border bg-blue-600 text-white border-blue-600">
                    <button
                      type="button"
                      onClick={() => setAttrDialogOpen(true)}
                      className="hover:underline truncate max-w-[7rem] text-left"
                    >
                      {attrKey}: {attrValue}
                    </button>
                    <button
                      type="button"
                      onClick={clearAttrFilter}
                      title="Clear attribute filter"
                      className="p-0.5 rounded-full hover:bg-blue-700 transition-colors flex-shrink-0"
                    >
                      <X size={12} />
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => setAttrDialogOpen(true)}
                    className="flex-shrink-0 text-xs font-medium px-3 py-1.5 rounded-full border border-gray-200 bg-white text-gray-600 hover:border-gray-300 transition-colors"
                  >
                    Attribute…
                  </button>
                )
              )}
              <SegmentFilterControl filter={segmentFilter.filter} onApply={(f) => { segmentFilter.set(f); resetPage(); }} onClear={() => { segmentFilter.clear(); resetPage(); }} />
            </div>
          }
        />

        {error && <ErrorBox message={error.message} onRetry={refetch} />}
        {isLoading && <SkeletonList rows={8} />}
        {!isLoading && !error && list.length === 0 && (
          <EmptyState
            icon={Users}
            title={offset > 0 ? "No more identities" : debouncedSearch || filtersActive ? "No results" : "No identities found"}
            subtitle={
              offset > 0
                ? "This page is past the end of the list."
                : debouncedSearch
                ? `No identities match "${debouncedSearch}"`
                : filtersActive
                ? "No identities match the selected filters"
                : "Your tenant has no identities yet"
            }
            action={offset > 0 ? <OutlineButton onClick={() => setOffset(0)} className="!w-auto mt-3">Back to first page</OutlineButton> : undefined}
          />
        )}

        {!isLoading && list.length > 0 && (
          <div>
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
              <p className="text-xs text-gray-400">
                {list.length} on this page{(debouncedSearch || filtersActive || segment) && " matching"}
              </p>
            </div>
            {pager}

            {selected.size > 0 && (
              <SelectionActionBar
                count={selected.size}
                progressText={bulkSetLifecycle.isPending ? `Updating ${progress} of ${selected.size}…` : null}
                actions={[
                  {
                    icon: UserCheck,
                    title: `Enable (${selected.size})`,
                    onClick: () => bulkSetLifecycle.mutate("enable"),
                    loading: bulkSetLifecycle.isPending && bulkSetLifecycle.variables === "enable",
                    disabled: bulkSetLifecycle.isPending,
                  },
                  {
                    icon: UserX,
                    title: `Disable (${selected.size})`,
                    onClick: () => bulkSetLifecycle.mutate("disable"),
                    loading: bulkSetLifecycle.isPending && bulkSetLifecycle.variables === "disable",
                    disabled: bulkSetLifecycle.isPending,
                  },
                ]}
              />
            )}

            {list.map((idn) => {
              const name = idn.name || "Unknown";
              const dept = idn.attributes?.department || "";
              const email = idn.email || "";
              const active = idn.active !== false;
              return (
                <div
                  key={idn.id}
                  className="w-full flex items-center gap-3 px-4 py-3.5 border-b border-gray-100 hover:bg-gray-50 transition-colors"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(idn.id)}
                    onChange={() => toggleOne(idn.id)}
                    className="w-4 h-4 rounded border-gray-300 flex-shrink-0"
                  />
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => navigate(`/identities/${idn.id}`)}
                    onKeyDown={(e) => e.key === "Enter" && navigate(`/identities/${idn.id}`)}
                    className="flex-1 min-w-0 flex items-center gap-3 text-left cursor-pointer active:bg-gray-100"
                  >
                    <Avatar name={name} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900 truncate">{name}</p>
                      <p className="text-xs text-gray-500 mt-0.5 truncate">{dept || email}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        title={active ? "Disable" : "Enable"}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleOneLifecycle.mutate({ id: idn.id, state: active ? "disable" : "enable" });
                        }}
                        disabled={toggleOneLifecycle.isPending && toggleOneLifecycle.variables?.id === idn.id}
                        className={`text-xs font-medium px-2 py-0.5 rounded-full border transition-colors disabled:opacity-50 ${
                          active
                            ? "bg-blue-50 text-blue-700 border-blue-200 hover:bg-red-50 hover:text-red-700 hover:border-red-200"
                            : "bg-gray-100 text-gray-500 border-gray-200 hover:bg-blue-50 hover:text-blue-700 hover:border-blue-200"
                        }`}
                      >
                        {active ? "Active" : "Inactive"}
                      </button>
                      <ChevronRight size={16} className="text-gray-300" />
                    </div>
                  </div>
                </div>
              );
            })}
            {pager}
          </div>
        )}
      </div>

      {attrDialogOpen && (
        <AttributeFilterModal
          candidates={attributeCandidates}
          initialKey={attrKey}
          initialValue={attrValue}
          onApply={applyAttrFilter}
          onClear={clearAttrFilter}
          onCancel={() => setAttrDialogOpen(false)}
        />
      )}
    </div>
  );
}
