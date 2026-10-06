import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link2, Shield, Key, CheckCircle2, AlertTriangle } from "lucide-react";
import toast from "react-hot-toast";
import { getSegmentRoleMatch, assignSegmentRoleMatches } from "../lib/sailpoint";
import { TopBar } from "../components/TopBar";
import { PrimaryButton, EmptyState, Spinner, IconButton, ConfirmModal } from "../components/ui";
import { STATUS_META } from "./roleMining/shared";

// Same convention as the Data Segments scan report's own groupEntitlementsBySource
// — the same entitlement name can legitimately exist on two different
// sources, so entitlements are grouped by source rather than shown flat.
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

function MatchRow({ icon: Icon, iconClassName, title, subtitle, assigned, selected, onToggle }) {
  return (
    <label
      className={`flex items-center gap-3 px-4 py-3 border-b border-gray-100 transition-colors ${
        assigned ? "" : "hover:bg-gray-50 cursor-pointer"
      }`}
    >
      {assigned ? (
        <CheckCircle2 size={16} className="text-emerald-600 flex-shrink-0" />
      ) : (
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          className="w-4 h-4 rounded border-gray-300 flex-shrink-0"
        />
      )}
      <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${iconClassName}`}>
        <Icon size={14} />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-gray-900 truncate">{title}</p>
        <p className="text-xs text-gray-400">{subtitle}{assigned && " · Assigned"}</p>
      </div>
    </label>
  );
}

function SegmentMatchSection({ segment, selected, onToggle, onToggleAll }) {
  const unassignedRoles = segment.matches.filter((m) => !m.assigned);
  const entitlementMatches = segment.entitlementMatches || [];
  const unassignedEnts = entitlementMatches.filter((m) => !m.assigned);
  const unassignedCount = unassignedRoles.length + unassignedEnts.length;
  const allSelected =
    unassignedCount > 0 &&
    unassignedRoles.every((m) => selected.has(`${segment.segmentId}:ROLE:${m.id}`)) &&
    unassignedEnts.every((m) => selected.has(`${segment.segmentId}:ENTITLEMENT:${m.id}`));

  return (
    <div className="border-b border-gray-100">
      <div className="px-4 py-3 bg-gray-50">
        <p className="text-sm font-semibold text-gray-900">{segment.segmentName}</p>
        {segment.criteria.length > 0 ? (
          <div className="flex flex-wrap gap-1.5 mt-1.5">
            {segment.criteria.map((c) => (
              <span
                key={c.attrKey}
                className="text-xs px-2 py-1 rounded-full border bg-amber-50 text-amber-700 border-amber-200"
              >
                {c.attrKey}: {c.value}
              </span>
            ))}
          </div>
        ) : (
          <p className="text-xs text-gray-400 mt-0.5">no criteria</p>
        )}
        {unassignedCount > 0 && (
          <label className="flex items-center gap-2 text-xs text-gray-500 mt-2">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={() => onToggleAll(segment)}
              className="w-4 h-4 rounded border-gray-300"
            />
            Select all ({unassignedCount})
          </label>
        )}
      </div>

      {segment.matches.length === 0 && entitlementMatches.length === 0 ? (
        <p className="px-4 py-3 text-xs text-gray-400">No matching roles or entitlements found for this data segment's criteria.</p>
      ) : (
        <>
          {segment.matches.map((role) => (
            <MatchRow
              key={`role-${role.id}`}
              icon={Shield}
              iconClassName="bg-blue-50 text-blue-600"
              title={role.name}
              subtitle={`${role.dimensional ? "Dynamic" : "Standard"} · ${role.enabled ? "Enabled" : "Disabled"}`}
              assigned={role.assigned}
              selected={selected.has(`${segment.segmentId}:ROLE:${role.id}`)}
              onToggle={() => onToggle(segment.segmentId, "ROLE", role.id)}
            />
          ))}
          {groupEntitlementsBySource(entitlementMatches).map(([source, ents]) => (
            <div key={source}>
              <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide px-4 pt-2">{source}</p>
              {ents.map((ent) => (
                <MatchRow
                  key={`ent-${ent.id}`}
                  icon={Key}
                  iconClassName="bg-violet-50 text-violet-600"
                  title={ent.name}
                  subtitle={source}
                  assigned={ent.assigned}
                  selected={selected.has(`${segment.segmentId}:ENTITLEMENT:${ent.id}`)}
                  onToggle={() => onToggle(segment.segmentId, "ENTITLEMENT", ent.id)}
                />
              ))}
            </div>
          ))}
        </>
      )}
    </div>
  );
}

export default function SegmentRoleMatchPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState(() => new Set());
  const [assignAllConfirmOpen, setAssignAllConfirmOpen] = useState(false);

  const { data: match, isLoading } = useQuery({
    queryKey: ["segmentRoleMatch", id],
    queryFn: () => getSegmentRoleMatch(id),
    refetchInterval: (query) => (query.state.data?.status === "running" ? 3000 : false),
  });

  const assignMutation = useMutation({
    mutationFn: (items) => assignSegmentRoleMatches(id, items),
    onSuccess: (data) => {
      const failed = data.results.filter((r) => !r.ok);
      const ok = data.results.filter((r) => r.ok);
      if (failed.length) {
        toast.error(`Assigned ${ok.length} of ${data.results.length} — ${failed.length} failed`);
      } else {
        toast.success(`Assigned ${ok.length} item${ok.length === 1 ? "" : "s"}`);
      }
      setSelected(new Set());
      setAssignAllConfirmOpen(false);
      queryClient.invalidateQueries({ queryKey: ["segmentRoleMatch", id] });
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  if (isLoading || !match) {
    return (
      <div className="flex flex-col min-h-screen bg-white">
        <TopBar title="Assign Matching Roles & Entitlements" onBack={() => navigate("/segments")} />
        <div className="flex-1 flex items-center justify-center"><Spinner size={24} /></div>
      </div>
    );
  }

  const meta = STATUS_META[match.status] || STATUS_META.running;
  const StatusIcon = meta.icon;
  const results = match.results || [];
  const allUnassignedItems = results.flatMap((s) => [
    ...s.matches.filter((m) => !m.assigned).map((m) => ({ segmentId: s.segmentId, type: "ROLE", id: m.id })),
    ...(s.entitlementMatches || []).filter((m) => !m.assigned).map((m) => ({ segmentId: s.segmentId, type: "ENTITLEMENT", id: m.id })),
  ]);

  function toggleOne(segmentId, type, itemId) {
    const key = `${segmentId}:${type}:${itemId}`;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleAllForSegment(segment) {
    const unassignedRoles = segment.matches.filter((m) => !m.assigned);
    const unassignedEnts = (segment.entitlementMatches || []).filter((m) => !m.assigned);
    const allSelected =
      unassignedRoles.every((m) => selected.has(`${segment.segmentId}:ROLE:${m.id}`)) &&
      unassignedEnts.every((m) => selected.has(`${segment.segmentId}:ENTITLEMENT:${m.id}`));
    setSelected((prev) => {
      const next = new Set(prev);
      unassignedRoles.forEach((m) => {
        const key = `${segment.segmentId}:ROLE:${m.id}`;
        if (allSelected) next.delete(key);
        else next.add(key);
      });
      unassignedEnts.forEach((m) => {
        const key = `${segment.segmentId}:ENTITLEMENT:${m.id}`;
        if (allSelected) next.delete(key);
        else next.add(key);
      });
      return next;
    });
  }

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <TopBar
        title="Assign Matching Roles & Entitlements"
        onBack={() => navigate("/segments")}
        action={
          allUnassignedItems.length > 0 && (
            <IconButton
              icon={Link2}
              title={`Assign All Matches (${allUnassignedItems.length})`}
              onClick={() => setAssignAllConfirmOpen(true)}
            />
          )
        }
      />
      <div className="flex-1 overflow-y-auto pb-24">
        <div className="px-4 py-4 border-b border-gray-100">
          <div className="flex items-center gap-2 mb-1">
            <StatusIcon size={16} className={meta.className} />
            <span className="text-sm font-medium text-gray-900">{meta.label}</span>
          </div>
          <p className="text-xs text-gray-500">
            {match.tenant ? `${match.tenant} — ` : ""}Started {new Date(match.startedAt).toLocaleString()}
          </p>
          {match.error && <p className="text-xs text-red-600 mt-1">{match.error}</p>}
          <p className="text-xs text-gray-400 mt-2">{results.length} data segment{results.length === 1 ? "" : "s"} scanned</p>
        </div>

        {match.status === "completed" &&
        results.every((s) => s.matches.length === 0 && (s.entitlementMatches || []).length === 0) ? (
          <EmptyState
            icon={Link2}
            title="No matching roles or entitlements found"
            subtitle="Nothing matched any of the selected data segments' criteria"
          />
        ) : (
          results.map((s) => (
            <SegmentMatchSection
              key={s.segmentId}
              segment={s}
              selected={selected}
              onToggle={toggleOne}
              onToggleAll={toggleAllForSegment}
            />
          ))
        )}

        {results.some((s) => s.criteria.length === 0) && (
          <div className="mx-4 mt-3 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 flex gap-2">
            <AlertTriangle size={14} className="text-amber-600 flex-shrink-0 mt-0.5" />
            <p className="text-xs text-amber-800">
              One or more selected data segments have no attribute criteria on their membership rule, so nothing could
              be proposed for them.
            </p>
          </div>
        )}
      </div>

      {selected.size > 0 && (
        <div className="flex-shrink-0 border-t border-gray-100 bg-white px-4 py-3">
          <PrimaryButton
            onClick={() =>
              assignMutation.mutate(
                [...selected].map((key) => {
                  const [segmentId, type, itemId] = key.split(":");
                  return { segmentId, type, id: itemId };
                })
              )
            }
            loading={assignMutation.isPending}
          >
            <Link2 size={16} />
            Assign Selected ({selected.size})
          </PrimaryButton>
        </div>
      )}

      {assignAllConfirmOpen && (
        <ConfirmModal
          title={`Assign all ${allUnassignedItems.length} suggested match${allUnassignedItems.length === 1 ? "" : "es"}?`}
          message="Adds each proposed role/entitlement to its matched data segment's own Access Model. This can be undone in ISC if a suggestion turns out to be wrong."
          confirmLabel="Assign All"
          pending={assignMutation.isPending}
          onConfirm={() => assignMutation.mutate(allUnassignedItems)}
          onCancel={() => setAssignAllConfirmOpen(false)}
        />
      )}
    </div>
  );
}
