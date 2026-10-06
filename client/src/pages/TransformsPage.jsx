import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { FunctionSquare, Plus } from "lucide-react";
import { listTransforms, fetchAllPages, getTransformsLastUpdated } from "../lib/sailpoint";
import { useUrlSearch } from "../hooks/useUrlSearch";
import { useUrlState } from "../hooks/useUrlState";
import { LIST_SORT_OPTIONS, sortList, updatedSuffix } from "../lib/listSort";
import { TopBar } from "../components/TopBar";
import { BrowseTitleMenu } from "../components/BrowseTitleMenu";
import { SearchBar, SkeletonList, EmptyState, ErrorBox, IconButton, SegmentedPill } from "../components/ui";
import { CreateTransformModal } from "../components/CreateTransformModal";
import { usePagedList } from "../hooks/usePagedList";

export default function TransformsPage() {
  const navigate = useNavigate();
  const { search, debouncedSearch, handleSearch } = useUrlSearch();
  const [createOpen, setCreateOpen] = useState(false);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["transforms"],
    queryFn: () => fetchAllPages((page) => listTransforms(page)),
  });

  // A–Z by default; "Last updated" like Workflows / Forms / Launchers. ISC's
  // transform records carry no dates at all, so the dates come from ISC's
  // audit events (every create/update, whoever made it) and are only fetched
  // once that sort is actually chosen. A transform untouched for longer than
  // ISC keeps audit events has no date — those sort last, A–Z.
  const [sortBy, setSortBy] = useUrlState("sort", "name");
  const byUpdated = sortBy === "updated";
  const updates = useQuery({
    queryKey: ["transforms-last-updated"],
    queryFn: getTransformsLastUpdated,
    enabled: byUpdated,
    staleTime: 60_000,
  });
  const updatedById = updates.data?.updated || {};

  const list = sortList(
    (Array.isArray(data) ? data : [])
      .filter((t) => {
        if (!debouncedSearch) return true;
        const q = debouncedSearch.toLowerCase();
        return (t.name || "").toLowerCase().includes(q) || (t.type || "").toLowerCase().includes(q);
      })
      .map((t) => ({ ...t, modified: updatedById[t.id]?.at || null, modifiedBy: updatedById[t.id]?.by || null })),
    sortBy
  );
  const datedCount = byUpdated ? list.filter((t) => t.modified).length : 0;
  const { page, pager } = usePagedList(list, { noun: "transform", resetKey: `${debouncedSearch}|${sortBy}` });

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <TopBar
        title={<BrowseTitleMenu active="Transforms" />}
        action={<IconButton icon={Plus} title="Create Transform" onClick={() => setCreateOpen(true)} />}
      />
      <div className="flex-1 overflow-y-auto pb-24">
        <SearchBar value={search} onChange={handleSearch} placeholder="Search transforms…" />
        <div className="flex items-center gap-3 flex-wrap px-4 pb-2">
          <SegmentedPill label="Sort by" options={LIST_SORT_OPTIONS} active={sortBy} onChange={setSortBy} />
          {byUpdated && updates.isLoading && <span className="text-xs text-gray-400">Reading ISC's audit history…</span>}
          {byUpdated && updates.error && (
            <span className="text-xs text-red-600">Couldn't read update history ({updates.error.response?.data?.error || updates.error.message}) — showing A–Z.</span>
          )}
          {byUpdated && updates.data && !isLoading && (
            <span className="text-xs text-gray-400">
              {datedCount} of {list.length} changed within ISC's audit history{updates.data.truncated ? " (history truncated)" : ""} — the rest follow, A–Z
            </span>
          )}
        </div>

        {error && <ErrorBox message={error.message} onRetry={refetch} />}
        {isLoading && <SkeletonList rows={8} />}
        {!isLoading && !error && list.length === 0 && (
          <EmptyState
            icon={FunctionSquare}
            title={debouncedSearch ? "No results" : "No transforms"}
            subtitle={debouncedSearch ? `No transforms match "${debouncedSearch}"` : "This tenant has no transforms yet"}
          />
        )}

        {!isLoading && pager}
        {!isLoading && page.map((t) => (
          <button
            key={t.id}
            onClick={() => navigate(`/transforms/${t.id}`)}
            className="w-full flex items-center gap-3 px-4 py-3.5 border-b border-gray-100 hover:bg-gray-50 active:bg-gray-100 text-left transition-colors"
          >
            <div className="w-10 h-10 rounded-full bg-fuchsia-50 flex items-center justify-center flex-shrink-0">
              <FunctionSquare size={16} className="text-fuchsia-700" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-gray-900 truncate">{t.name}</p>
              <p className="text-xs text-gray-500 truncate mt-0.5">
                {t.type}{updatedSuffix(t, sortBy)}{byUpdated && t.modified && t.modifiedBy ? ` by ${t.modifiedBy}` : ""}
              </p>
            </div>
            {t.internal && (
              <span className="text-xs font-medium px-2 py-0.5 rounded-full border flex-shrink-0 bg-gray-50 text-gray-500 border-gray-200">
                Internal
              </span>
            )}
          </button>
        ))}
        {!isLoading && pager}
      </div>

      {createOpen && (
        <CreateTransformModal
          onClose={() => setCreateOpen(false)}
          onCreated={(created) => created?.id && navigate(`/transforms/${created.id}`)}
        />
      )}
    </div>
  );
}
