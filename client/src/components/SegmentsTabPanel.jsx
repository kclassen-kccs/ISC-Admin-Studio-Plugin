import { useQuery } from "@tanstack/react-query";
import { Shapes, ChevronRight } from "lucide-react";
import { SkeletonList, ErrorBox, EmptyState } from "./ui";

/**
 * Shared "Segments" tab body for Identity/Role/Entitlement Detail pages —
 * lists the data segments a given object belongs to (see getIdentitySegments/
 * getRoleSegments/getEntitlementSegments in lib/sailpoint.js for how each
 * object type's membership is actually determined) and links each into
 * Segment Detail.
 */
// basePath/noun/Icon default to Data Segments; ISC Segments pass their own.
export function SegmentsTabPanel({ queryKey, queryFn, navigate, emptySubtitle, basePath = "/segments", noun = "data segment", Icon = Shapes }) {
  const { data, isLoading, error, refetch } = useQuery({ queryKey, queryFn });
  const segments = Array.isArray(data) ? data : [];

  if (isLoading) return <SkeletonList rows={4} />;
  if (error) return <ErrorBox message={error.message} onRetry={refetch} />;
  if (segments.length === 0) {
    return <EmptyState icon={Icon} title={`No ${noun}s`} subtitle={emptySubtitle} />;
  }
  return (
    <div className="border-t border-gray-100">
      <p className="text-xs text-gray-400 px-4 py-2">
        {segments.length} {noun}{segments.length === 1 ? "" : "s"}
      </p>
      {segments.map((s) => (
        <button
          key={s.id}
          onClick={() => navigate(`${basePath}/${s.id}`)}
          className="w-full flex items-center gap-3 px-4 py-3 border-b border-gray-100 hover:bg-gray-50 active:bg-gray-100 text-left transition-colors"
        >
          <div className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center flex-shrink-0">
            <Icon size={14} className="text-gray-500" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-gray-900 truncate">{s.name}</p>
            {!s.active && <p className="text-xs text-gray-500 truncate mt-0.5">Inactive</p>}
          </div>
          <ChevronRight size={16} className="text-gray-300 flex-shrink-0" />
        </button>
      ))}
    </div>
  );
}
