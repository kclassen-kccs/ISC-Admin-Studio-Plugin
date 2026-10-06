import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { BadgeCheck, UsersRound, KeyRound, Pencil, Plus, X, ChevronRight } from "lucide-react";
import toast from "react-hot-toast";
import {
  getIdentityUserLevels, listIdentityGovernanceGroups, setIdentityUserLevels,
  updateIdentityGovernanceGroups, listGovernanceGroups,
} from "../lib/sailpoint";
import { SkeletonList, ErrorBox, EmptyState, SectionLabel, PrimaryButton, OutlineButton, SearchBar, ConfirmModal, Spinner } from "./ui";

// Identity detail: User Levels and Governance Groups tabs — both viewable
// and editable.

// ISC's built-in user levels, by the capability value the API returns.
const USER_LEVEL_LABELS = {
  ORG_ADMIN: ["Admin", "Full access to every admin feature"],
  HELPDESK: ["Helpdesk", "Manages identities' passwords, accounts and access requests"],
  CERT_ADMIN: ["Certification Admin", "Creates and manages certification campaigns"],
  REPORT_ADMIN: ["Report Admin", "Views and runs reports"],
  ROLE_ADMIN: ["Role Admin", "Manages all roles and access profiles"],
  ROLE_SUBADMIN: ["Role Subadmin", "Manages roles and access profiles for assigned sources"],
  SOURCE_ADMIN: ["Source Admin", "Manages sources"],
  SOURCE_SUBADMIN: ["Source Subadmin", "Manages assigned sources"],
  POLICY_ADMIN: ["Policy Admin", "Manages separation-of-duties policies"],
  CLOUD_GOV_ADMIN: ["Cloud Governance Admin", "Administers cloud governance"],
  CLOUD_GOV_USER: ["Cloud Governance User", "Uses cloud governance"],
  SAAS_MANAGEMENT_ADMIN: ["SaaS Management Admin", "Administers SaaS Management"],
  SAAS_MANAGEMENT_READER: ["SaaS Management Reader", "Read-only SaaS Management"],
  DASHBOARD: ["Dashboard", "Views the admin dashboard"],
  AUDITOR: ["Auditor", "Read-only audit access"],
  INTERNAL: ["Internal", "SailPoint internal"],
};
const ASSIGNABLE_LEVELS = Object.keys(USER_LEVEL_LABELS).filter((c) => c !== "INTERNAL");

export function UserLevelsPanel({ identityId }) {
  const queryClient = useQueryClient();
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ["identity-user-levels", identityId], queryFn: () => getIdentityUserLevels(identityId) });
  const [editing, setEditing] = useState(null); // Set of picked built-in levels while editing
  const save = useMutation({
    // Built-in levels come from the checkboxes; "sp:" rights (custom user
    // levels) and any unknown codes are passed through untouched.
    mutationFn: () => {
      const caps = data?.capabilities || [];
      const kept = caps.filter((c) => c.includes(":") || !ASSIGNABLE_LEVELS.includes(c));
      return setIdentityUserLevels(identityId, [...ASSIGNABLE_LEVELS.filter((c) => editing.has(c)), ...kept]);
    },
    onSuccess: () => {
      toast.success("User levels updated.");
      setEditing(null);
      queryClient.invalidateQueries({ queryKey: ["identity-user-levels", identityId] });
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message, { duration: 8000 }),
  });

  if (isLoading) return <div className="px-4 py-4"><SkeletonList rows={3} /></div>;
  if (error) {
    if (error.response?.status === 404) return <EmptyState icon={BadgeCheck} title="No user record" subtitle="This identity has no ISC login, so it has no user levels." />;
    return <ErrorBox message={error.response?.data?.error || error.message} onRetry={refetch} />;
  }
  const caps = data?.capabilities || [];
  // Built-in levels are upper-case codes; "sp:…" entries are individual
  // rights granted through custom user levels.
  const levels = caps.filter((c) => !c.includes(":"));
  const rights = caps.filter((c) => c.includes(":")).sort();

  return (
    <div className="px-4 pb-4">
      <div className="flex items-center justify-between">
        <SectionLabel>User Levels</SectionLabel>
        {!editing && (
          <button type="button" onClick={() => setEditing(new Set(levels))} className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-700 mt-3">
            <Pencil size={12} /> Edit
          </button>
        )}
      </div>

      {editing ? (
        <>
          <div className="border border-gray-100 rounded-xl overflow-hidden divide-y divide-gray-100">
            {ASSIGNABLE_LEVELS.map((c) => {
              const [label, desc] = USER_LEVEL_LABELS[c];
              return (
                <label key={c} className="px-3 py-2.5 flex items-start gap-3 cursor-pointer hover:bg-gray-50">
                  <input
                    type="checkbox"
                    checked={editing.has(c)}
                    onChange={() => setEditing((prev) => { const next = new Set(prev); next.has(c) ? next.delete(c) : next.add(c); return next; })}
                    disabled={save.isPending}
                    className="w-4 h-4 rounded border-gray-300 flex-shrink-0 mt-0.5"
                  />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-900">{label} <span className="text-xs font-mono text-gray-400">{c}</span></p>
                    <p className="text-xs text-gray-500">{desc}</p>
                  </div>
                </label>
              );
            })}
          </div>
          <p className="text-xs text-gray-500 mt-2">No boxes ticked means the standard User level. Rights from custom user levels are kept as they are.</p>
          <div className="flex gap-2 mt-3">
            <PrimaryButton onClick={() => save.mutate()} loading={save.isPending}>Save user levels</PrimaryButton>
            <OutlineButton onClick={() => setEditing(null)} disabled={save.isPending}>Cancel</OutlineButton>
          </div>
        </>
      ) : (
        <div className="border border-gray-100 rounded-xl overflow-hidden divide-y divide-gray-100">
          {levels.length === 0 && (
            <div className="px-3 py-2.5">
              <p className="text-sm font-medium text-gray-900">User</p>
              <p className="text-xs text-gray-500">The standard level — no admin user levels assigned.</p>
            </div>
          )}
          {levels.map((c) => {
            const [label, desc] = USER_LEVEL_LABELS[c] || [c, null];
            return (
              <div key={c} className="px-3 py-2.5 flex items-start gap-3">
                <BadgeCheck size={16} className="text-blue-600 flex-shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-900">{label} <span className="text-xs font-mono text-gray-400">{c}</span></p>
                  {desc && <p className="text-xs text-gray-500">{desc}</p>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {rights.length > 0 && (
        <>
          <SectionLabel>Additional rights ({rights.length})</SectionLabel>
          <p className="text-xs text-gray-500 mb-2">Individual rights granted through custom user levels.</p>
          <div className="flex flex-wrap gap-1.5">
            {rights.map((r) => (
              <span key={r} className="inline-flex items-center gap-1 text-xs font-mono bg-gray-50 text-gray-700 border border-gray-200 rounded-full px-2 py-0.5">
                <KeyRound size={10} /> {r}
              </span>
            ))}
          </div>
        </>
      )}
      {data?.enabled === false && <p className="text-xs text-amber-700 mt-3">This user's ISC login is disabled.</p>}
    </div>
  );
}

function reportGroupResults(results, verb) {
  const failed = (results || []).filter((r) => !r.ok);
  if (failed.length) toast.error(`${failed.length} change${failed.length === 1 ? "" : "s"} failed: ${failed.map((f) => f.error).join("; ")}`, { duration: 9000 });
  else toast.success(verb);
}

// Picker for adding the identity to more groups — search by name, tick any
// number, add them in one go.
function AddToGroupsModal({ identityId, identityName, memberOf, onClose }) {
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState(() => new Map()); // id -> name
  const groups = useQuery({ queryKey: ["governance-groups-picker", query], queryFn: () => listGovernanceGroups({ limit: 50, query: query.trim() || undefined }) });
  const add = useMutation({
    mutationFn: () => updateIdentityGovernanceGroups(identityId, { add: [...picked.keys()], name: identityName }),
    onSuccess: (data) => {
      reportGroupResults(data?.results, `Added to ${picked.size} governance group${picked.size === 1 ? "" : "s"}.`);
      queryClient.invalidateQueries({ queryKey: ["identity-governance-groups", identityId] });
      onClose();
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message, { duration: 8000 }),
  });
  const toggle = (g) => setPicked((prev) => { const next = new Map(prev); next.has(g.id) ? next.delete(g.id) : next.set(g.id, g.name); return next; });
  const available = (groups.data || []).filter((g) => !memberOf.has(g.id));

  return (
    <div className="fixed inset-0 bg-black/30 z-30 flex items-end md:items-center justify-center" onClick={(e) => e.target === e.currentTarget && !add.isPending && onClose()}>
      <div className="bg-white w-full max-w-lg md:mx-4 rounded-t-2xl md:rounded-2xl shadow-xl p-5 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-semibold text-gray-900">Add {identityName} to governance groups</h2>
          <button onClick={onClose} disabled={add.isPending} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
        </div>
        <SearchBar value={query} onChange={setQuery} placeholder="Search governance groups…" />
        <div className="mt-3 border border-gray-100 rounded-xl overflow-hidden divide-y divide-gray-100">
          {groups.isLoading && <div className="px-3 py-3 flex justify-center"><Spinner /></div>}
          {groups.error && <ErrorBox message={groups.error.response?.data?.error || groups.error.message} />}
          {available.map((g) => (
            <label key={g.id} className="px-3 py-2.5 flex items-center gap-3 cursor-pointer hover:bg-gray-50">
              <input type="checkbox" checked={picked.has(g.id)} onChange={() => toggle(g)} disabled={add.isPending} className="w-4 h-4 rounded border-gray-300 flex-shrink-0" />
              <div className="min-w-0">
                <p className="text-sm font-medium text-gray-900 truncate">{g.name}</p>
                {g.description && <p className="text-xs text-gray-500 truncate">{g.description}</p>}
              </div>
            </label>
          ))}
          {groups.isSuccess && available.length === 0 && <p className="px-3 py-3 text-sm text-gray-400">No other groups match.</p>}
        </div>
        <div className="flex gap-2 mt-4">
          <PrimaryButton onClick={() => add.mutate()} loading={add.isPending} disabled={picked.size === 0}>
            <Plus size={16} /> {picked.size ? `Add to ${picked.size} group${picked.size === 1 ? "" : "s"}` : "Add"}
          </PrimaryButton>
          <OutlineButton onClick={onClose} disabled={add.isPending}>Cancel</OutlineButton>
        </div>
      </div>
    </div>
  );
}

export function GovernanceGroupsPanel({ identityId, identityName }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ["identity-governance-groups", identityId], queryFn: () => listIdentityGovernanceGroups(identityId) });
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState(null); // group to confirm removal from
  const remove = useMutation({
    mutationFn: (g) => updateIdentityGovernanceGroups(identityId, { remove: [g.id], name: identityName }),
    onSuccess: (data, g) => {
      reportGroupResults(data?.results, `Removed from ${g.name}.`);
      setRemoving(null);
      queryClient.invalidateQueries({ queryKey: ["identity-governance-groups", identityId] });
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message, { duration: 8000 }),
  });

  if (isLoading) return <div className="px-4 py-4"><SkeletonList rows={3} /></div>;
  if (error) return <ErrorBox message={error.response?.data?.error || error.message} onRetry={refetch} />;
  const groups = [...(data || [])].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  const addButton = (
    <button type="button" onClick={() => setAdding(true)} className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-700">
      <Plus size={12} /> Add to group
    </button>
  );

  return (
    <div className="px-4 py-2">
      {groups.length === 0 ? (
        <EmptyState icon={UsersRound} title="No governance groups" subtitle="This identity isn't a member of any governance group." action={<div className="mt-3">{addButton}</div>} />
      ) : (
        <>
          <div className="flex items-center justify-between py-2">
            <p className="text-xs text-gray-400">{groups.length} governance group{groups.length === 1 ? "" : "s"}</p>
            {addButton}
          </div>
          <div className="border border-gray-100 rounded-xl overflow-hidden divide-y divide-gray-100">
            {groups.map((g) => (
              <div key={g.id} className="px-3 py-2.5 flex items-start gap-3 hover:bg-gray-50">
                <button type="button" onClick={() => navigate(`/governance-groups/${g.id}`)} className="flex items-start gap-3 min-w-0 flex-1 text-left">
                  <UsersRound size={16} className="text-violet-600 flex-shrink-0 mt-0.5" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-gray-900 truncate">{g.name}</p>
                    <p className="text-xs text-gray-500 truncate">
                      {[g.description, g.owner?.name && `Owner: ${g.owner.name}`, g.memberCount != null && `${g.memberCount} member${g.memberCount === 1 ? "" : "s"}`].filter(Boolean).join(" · ")}
                    </p>
                  </div>
                  <ChevronRight size={16} className="text-gray-300 flex-shrink-0 mt-0.5" />
                </button>
                <button type="button" title={`Remove from ${g.name}`} onClick={() => setRemoving(g)} className="text-gray-400 hover:text-red-600 flex-shrink-0">
                  <X size={16} />
                </button>
              </div>
            ))}
          </div>
        </>
      )}
      {adding && <AddToGroupsModal identityId={identityId} identityName={identityName} memberOf={new Set(groups.map((g) => g.id))} onClose={() => setAdding(false)} />}
      {removing && (
        <ConfirmModal
          title="Remove from governance group"
          message={`Remove ${identityName} from ${removing.name}?`}
          confirmLabel="Remove"
          danger
          pending={remove.isPending}
          onConfirm={() => remove.mutate(removing)}
          onCancel={() => setRemoving(null)}
        />
      )}
    </div>
  );
}
