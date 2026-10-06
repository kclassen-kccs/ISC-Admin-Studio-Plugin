import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { X, Shapes } from "lucide-react";
import { listSegments, getSegmentAccess, getSchemaAnalysis } from "../lib/sailpoint";
import { useUrlState } from "../hooks/useUrlState";
import { Field, PrimaryButton, OutlineButton, SkeletonList, ErrorBox } from "./ui";

// ─── Data Segment filter for the Identities / Roles / Access Profiles /
// Entitlements lists ──────────────────────────────────────────────────────
// Identities: the segment's membership (its own criteria run as a search,
// see the server's /api/segments/:id/members). Roles, access profiles and
// entitlements: the segment's Access Model as /api/segments/:id/access
// resolves it — roles selected on the segment, the access profiles those
// roles reference, and entitlements selected directly or reachable through
// them. Only offered when the tenant has Data Segments on (the same gate
// as the Segments menu itself).

// Packed into ONE url param (id|name) — see the owner filter on
// EntitlementsPage for why two useUrlState writes race.
export function useSegmentFilter(param = "segment") {
  const [raw, setRaw] = useUrlState(param, "");
  let filter = null;
  if (raw) {
    const [id, name] = raw.split("|").map((p) => decodeURIComponent(p || ""));
    if (id) filter = { id, name: name || id };
  }
  const set = (s) => setRaw(s ? [s.id, s.name || ""].map(encodeURIComponent).join("|") : "");
  return { filter, set, clear: () => setRaw("") };
}

// Set of ids in the segment's Access Model for `kind` ("roles" |
// "accessprofiles" | "entitlements") — null while no filter is set.
export function useSegmentMatchIds(kind, filter) {
  const q = useQuery({
    queryKey: ["segment-access", filter?.id],
    queryFn: () => getSegmentAccess(filter.id),
    enabled: !!filter,
    staleTime: 60_000,
  });
  let ids = null;
  if (filter && q.data) {
    const list = kind === "roles" ? q.data.roles : kind === "accessprofiles" ? q.data.accessProfiles : q.data.entitlements;
    ids = new Set((list || []).map((x) => x.id));
  }
  return { ids, isLoading: !!filter && q.isLoading, error: filter ? q.error : null };
}

// A segment-members search document in the same shape the Identities list
// renders (the server's own normalizeSearchIdentity).
export function normalizeSegmentMember(doc) {
  const attrs = doc?.attributes || {};
  return {
    id: doc.id,
    name: doc.displayName || doc.name,
    alias: doc.name,
    email: doc.email || null,
    active: (attrs.cloudLifecycleState || "").toLowerCase() !== "inactive",
    identityProfile: doc.identityProfile ? { id: doc.identityProfile.id, name: doc.identityProfile.name } : null,
    attributes: attrs,
  };
}

function SegmentFilterDialog({ current, onApply, onClear, onClose }) {
  const segmentsQuery = useQuery({ queryKey: ["segments"], queryFn: listSegments });
  const [id, setId] = useState(current?.id || "");
  const segments = Array.isArray(segmentsQuery.data) ? segmentsQuery.data : [];
  const selectClass = "w-full bg-white border border-gray-200 rounded-xl px-3 py-2.5 text-sm text-gray-900 outline-none focus:border-blue-400";
  const label = (s) => `${s.name}${!s.published ? " (draft)" : s.active === false ? " (inactive)" : ""}`;

  return (
    <div className="fixed inset-0 bg-black/30 z-30 flex items-end md:items-center justify-center" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="bg-white w-full max-w-lg md:mx-4 rounded-t-2xl md:rounded-2xl shadow-xl p-5 max-h-[85vh] overflow-y-auto">
        <h2 className="text-base font-semibold text-gray-900 mb-1">Filter by Data Segment</h2>
        <p className="text-xs text-gray-500 mb-4">Show only what belongs to one data segment — its members, or the roles, access profiles and entitlements on its Access Model.</p>
        {segmentsQuery.isLoading && <SkeletonList rows={2} />}
        {segmentsQuery.error && <ErrorBox message={segmentsQuery.error.response?.data?.error || segmentsQuery.error.message} />}
        {!segmentsQuery.isLoading && !segmentsQuery.error && (
          <>
            <Field label="Data segment">
              <select value={id} onChange={(e) => setId(e.target.value)} className={selectClass}>
                <option value="">Choose a segment…</option>
                {segments.map((s) => <option key={s.id} value={s.id}>{label(s)}</option>)}
              </select>
            </Field>
            <PrimaryButton
              onClick={() => { const s = segments.find((x) => x.id === id); onApply({ id, name: s?.name || id }); }}
              disabled={!id}
            >
              Apply
            </PrimaryButton>
            <OutlineButton onClick={onClose} className="mt-2">Cancel</OutlineButton>
            {current && (
              <button type="button" onClick={onClear} className="w-full mt-3 text-xs font-medium text-red-600 hover:text-red-700">
                Clear segment filter
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// The pill for a filter bar's right slot. Renders nothing at all on a
// tenant without Data Segments (unless a filter is somehow already set).
export function SegmentFilterControl({ filter, onApply, onClear }) {
  const [open, setOpen] = useState(false);
  const { data: analysis } = useQuery({ queryKey: ["schema-analysis"], queryFn: getSchemaAnalysis, staleTime: 60_000 });
  if (!analysis?.createDataSegments && !filter) return null;
  return (
    <>
      {filter ? (
        <span className="flex-shrink-0 inline-flex items-center gap-1 text-xs font-medium pl-3 pr-1.5 py-1.5 rounded-full border bg-blue-600 text-white border-blue-600">
          <button type="button" onClick={() => setOpen(true)} className="hover:underline truncate max-w-[10rem] text-left" title={`Segment: ${filter.name}`}>
            Segment: {filter.name}
          </button>
          <button type="button" onClick={onClear} title="Clear segment filter" className="p-0.5 rounded-full hover:bg-blue-700 transition-colors flex-shrink-0">
            <X size={12} />
          </button>
        </span>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex-shrink-0 inline-flex items-center gap-1 text-xs font-medium px-3 py-1.5 rounded-full border border-gray-200 bg-white text-gray-600 hover:border-gray-300 transition-colors"
        >
          <Shapes size={12} />
          Segment…
        </button>
      )}
      {open && (
        <SegmentFilterDialog
          current={filter}
          onApply={(s) => { onApply(s); setOpen(false); }}
          onClear={() => { onClear(); setOpen(false); }}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
