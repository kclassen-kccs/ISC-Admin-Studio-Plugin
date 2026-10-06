import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { UsersRound, Plus, Pencil, Trash2, Info, Users, Network, X, UserPlus, ChevronRight, Shield, ShieldCheck, Database, Key, GitBranch, Scale, LayoutGrid, Box } from "lucide-react";
import toast from "react-hot-toast";
import {
  listAllGovernanceGroups, getGovernanceGroup, listGovernanceGroupMembers, createGovernanceGroup,
  updateGovernanceGroup, deleteGovernanceGroup, updateGovernanceGroupMembers, getGovernanceGroupUsage, listIdentities,
} from "../lib/sailpoint";
import { useUrlSearch } from "../hooks/useUrlSearch";
import { useUrlState } from "../hooks/useUrlState";
import { usePagedList } from "../hooks/usePagedList";
import { TopBar } from "../components/TopBar";
import { BrowseTitleMenu } from "../components/BrowseTitleMenu";
import { PickerField } from "../components/PickerField";
import {
  SearchBar, SkeletonList, EmptyState, ErrorBox, IconButton, Avatar, InfoRow, ConfirmModal,
  PrimaryButton, OutlineButton, Field, Input, Textarea, Spinner, SelectionActionBar,
} from "../components/ui";

// ─── Governance Groups (Browse) ──────────────────────────────────────────────
// ISC governance groups (the API calls them workgroups): list, create, edit
// name/description/owner, add and remove member identities, and see where
// each group is used.

const searchOwners = async (q) => (await listIdentities({ limit: 15, query: q || undefined })).map((i) => ({ id: i.id, name: i.name }));

// Create (group omitted) or edit (group given) — only changed fields sent.
function GroupFormModal({ group, onClose, onSaved }) {
  const [name, setName] = useState(group?.name || "");
  const [description, setDescription] = useState(group?.description || "");
  const [owner, setOwner] = useState(group?.owner ? [{ id: group.owner.id, name: group.owner.name }] : []);
  const save = useMutation({
    mutationFn: () => {
      if (!group) return createGovernanceGroup({ name: name.trim(), description, owner: owner[0] });
      const fields = {};
      if (name.trim() !== group.name) fields.name = name.trim();
      if (description !== (group.description || "")) fields.description = description;
      if (owner[0]?.id !== group.owner?.id) fields.owner = owner[0];
      if (Object.keys(fields).length === 0) return Promise.resolve(group);
      return updateGovernanceGroup(group.id, fields);
    },
    onSuccess: (saved) => {
      toast.success(group ? "Governance group updated" : "Governance group created");
      onSaved(saved);
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message, { duration: 8000 }),
  });
  const canSave = name.trim() && owner[0]?.id;

  return (
    <div className="fixed inset-0 bg-black/30 z-30 flex items-end md:items-center justify-center" onClick={(e) => e.target === e.currentTarget && !save.isPending && onClose()}>
      <div className="bg-white w-full max-w-lg md:mx-4 rounded-t-2xl md:rounded-2xl shadow-xl p-5 max-h-[85vh] overflow-y-auto">
        <h2 className="text-base font-semibold text-gray-900 mb-4">{group ? "Edit governance group" : "Create governance group"}</h2>
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Description">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <PickerField label="Owner" cacheKey="governance-group-owner" placeholder="Search users…" searchFn={searchOwners} multi={false} selected={owner} onChange={setOwner} />
        <div className="flex gap-2 mt-2">
          <PrimaryButton onClick={() => save.mutate()} loading={save.isPending} disabled={!canSave} className="!w-auto flex-1">{group ? "Save" : "Create"}</PrimaryButton>
          <OutlineButton onClick={onClose} disabled={save.isPending} className="!w-auto flex-1">Cancel</OutlineButton>
        </div>
      </div>
    </div>
  );
}

export default function GovernanceGroupsPage() {
  const navigate = useNavigate();
  const { search, debouncedSearch, handleSearch } = useUrlSearch();
  const [createOpen, setCreateOpen] = useState(false);
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ["governance-groups"], queryFn: listAllGovernanceGroups });

  const q = debouncedSearch.toLowerCase();
  const list = (Array.isArray(data) ? data : [])
    .filter((g) => !q || (g.name || "").toLowerCase().includes(q) || (g.description || "").toLowerCase().includes(q) || (g.owner?.name || "").toLowerCase().includes(q))
    .sort((a, b) => (a.name || "").localeCompare(b.name || "", undefined, { sensitivity: "base" }));
  const { page, pager } = usePagedList(list, { noun: "governance group", resetKey: debouncedSearch });

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <TopBar
        title={<BrowseTitleMenu active="Governance Groups" />}
        action={<IconButton icon={Plus} title="Create Governance Group" onClick={() => setCreateOpen(true)} />}
      />
      <div className="flex-1 overflow-y-auto pb-24">
        <SearchBar value={search} onChange={handleSearch} placeholder="Search governance groups…" />
        {error && <ErrorBox message={error.response?.data?.error || error.message} onRetry={refetch} />}
        {isLoading && <SkeletonList rows={8} />}
        {!isLoading && !error && list.length === 0 && (
          <EmptyState
            icon={UsersRound}
            title={debouncedSearch ? "No results" : "No governance groups"}
            subtitle={debouncedSearch ? `No governance groups match "${debouncedSearch}"` : "This tenant has no governance groups yet"}
          />
        )}
        {!isLoading && pager}
        {!isLoading && page.map((g) => (
          <button
            key={g.id}
            onClick={() => navigate(`/governance-groups/${g.id}`)}
            className="w-full flex items-center gap-3 px-4 py-3.5 border-b border-gray-100 hover:bg-gray-50 active:bg-gray-100 text-left transition-colors"
          >
            <div className="w-10 h-10 rounded-full bg-violet-50 flex items-center justify-center flex-shrink-0">
              <UsersRound size={16} className="text-violet-700" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-gray-900 truncate">{g.name}</p>
              <p className="text-xs text-gray-500 truncate mt-0.5">
                {[g.description, g.owner?.name && `Owner: ${g.owner.name}`].filter(Boolean).join(" · ")}
              </p>
            </div>
            <span className="text-xs text-gray-400 flex-shrink-0 text-right">
              {g.memberCount ?? 0} member{g.memberCount === 1 ? "" : "s"}
              <br />
              {g.connectionCount ?? 0} connection{g.connectionCount === 1 ? "" : "s"}
            </span>
          </button>
        ))}
        {!isLoading && pager}
      </div>
      {createOpen && (
        <GroupFormModal
          onClose={() => setCreateOpen(false)}
          onSaved={(created) => { setCreateOpen(false); refetch(); if (created?.id) navigate(`/governance-groups/${created.id}`); }}
        />
      )}
    </div>
  );
}

// ─── Detail ─────────────────────────────────────────────────────────────────

const SECTIONS = [
  { key: "details", label: "Details", Icon: Info },
  { key: "members", label: "Members", Icon: Users },
  { key: "usage", label: "Usage", Icon: Network },
];

function DetailsPanel({ group }) {
  return (
    <div className="px-4 py-4">
      {group.description && <p className="text-sm text-gray-600 leading-relaxed mb-4">{group.description}</p>}
      <div className="border border-gray-100 rounded-xl overflow-hidden">
        <InfoRow label="Owner" value={group.owner?.displayName || group.owner?.name} />
        <InfoRow label="Owner e-mail" value={group.owner?.emailAddress} />
        <InfoRow label="Members" value={group.memberCount != null ? String(group.memberCount) : undefined} />
        <InfoRow label="Connections" value={group.connectionCount != null ? String(group.connectionCount) : undefined} />
        <InfoRow label="Created" value={group.created ? new Date(group.created).toLocaleString() : undefined} />
        <InfoRow label="Modified" value={group.modified ? new Date(group.modified).toLocaleString() : undefined} />
        <InfoRow label="Group ID" value={group.id} />
      </div>
    </div>
  );
}

// Search identities and tick any number to add — existing members hidden.
function AddMembersModal({ memberIds, onClose, onAdd, pending }) {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [picked, setPicked] = useState(() => new Map());
  const handleSearch = (value) => {
    setQuery(value);
    clearTimeout(window.__ggAddMembersTimer);
    window.__ggAddMembersTimer = setTimeout(() => setDebounced(value), 350);
  };
  const results = useQuery({
    queryKey: ["identity-search-for-governance-group", debounced],
    queryFn: () => listIdentities({ limit: 25, query: debounced || undefined }),
  });
  const list = (results.data || []).filter((i) => !memberIds.has(i.id));
  const toggle = (i) => setPicked((prev) => { const next = new Map(prev); next.has(i.id) ? next.delete(i.id) : next.set(i.id, { id: i.id, name: i.name }); return next; });

  return (
    <div className="fixed inset-0 bg-black/30 z-30 flex items-end md:items-center justify-center" onClick={(e) => e.target === e.currentTarget && !pending && onClose()}>
      <div className="bg-white w-full max-w-lg md:mx-4 rounded-t-2xl md:rounded-2xl shadow-xl p-5 max-h-[85vh] overflow-y-auto flex flex-col">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-base font-semibold text-gray-900">Add members</h2>
          <button onClick={onClose} disabled={pending} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
        </div>
        <SearchBar value={query} onChange={handleSearch} placeholder="Search identities…" />
        {picked.size > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-2">
            {[...picked.values()].map((p) => (
              <span key={p.id} className="inline-flex items-center gap-1 text-xs bg-blue-50 text-blue-700 border border-blue-100 rounded-full pl-2.5 pr-1.5 py-1">
                {p.name}
                <button type="button" onClick={() => toggle(p)} className="hover:text-blue-900"><X size={12} /></button>
              </span>
            ))}
          </div>
        )}
        <div className="border border-gray-100 rounded-xl overflow-hidden divide-y divide-gray-100">
          {(results.isLoading || query !== debounced) && <div className="flex justify-center py-3"><Spinner size={16} /></div>}
          {!results.isLoading && query === debounced && list.map((i) => (
            <label key={i.id} className="px-3 py-2.5 flex items-center gap-3 cursor-pointer hover:bg-gray-50">
              <input type="checkbox" checked={picked.has(i.id)} onChange={() => toggle(i)} disabled={pending} className="w-4 h-4 rounded border-gray-300 flex-shrink-0" />
              <div className="min-w-0">
                <p className="text-sm font-medium text-gray-900 truncate">{i.name}</p>
                {(i.email || i.emailAddress) && <p className="text-xs text-gray-500 truncate">{i.email || i.emailAddress}</p>}
              </div>
            </label>
          ))}
          {results.isSuccess && query === debounced && list.length === 0 && <p className="px-3 py-3 text-sm text-gray-400">No identities to add match.</p>}
        </div>
        <div className="flex gap-2 mt-4">
          <PrimaryButton onClick={() => onAdd([...picked.values()])} loading={pending} disabled={picked.size === 0} className="!w-auto flex-1">
            <UserPlus size={16} /> Add {picked.size || ""} member{picked.size === 1 ? "" : "s"}
          </PrimaryButton>
          <OutlineButton onClick={onClose} disabled={pending} className="!w-auto flex-1">Cancel</OutlineButton>
        </div>
      </div>
    </div>
  );
}

function MembersPanel({ groupId }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState(() => new Set());
  const [adding, setAdding] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ["governance-group-members", groupId], queryFn: () => listGovernanceGroupMembers(groupId) });
  const members = [...(data || [])].sort((a, b) => (a.name || "").localeCompare(b.name || "", undefined, { sensitivity: "base" }));
  const q = filter.toLowerCase();
  const shown = members.filter((m) => !q || (m.name || "").toLowerCase().includes(q) || (m.email || "").toLowerCase().includes(q));

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["governance-group-members", groupId] });
    queryClient.invalidateQueries({ queryKey: ["governance-group", groupId] });
    queryClient.invalidateQueries({ queryKey: ["governance-groups"] });
  };
  const report = (r, verb) => {
    if (r?.errors?.length) toast.error(r.errors.join("; "), { duration: 9000 });
    else toast.success(verb);
  };
  const add = useMutation({
    mutationFn: (people) => updateGovernanceGroupMembers(groupId, { add: people }),
    onSuccess: (r) => { report(r, `Added ${r.added} member${r.added === 1 ? "" : "s"}`); setAdding(false); refresh(); },
    onError: (err) => toast.error(err.response?.data?.error || err.message, { duration: 8000 }),
  });
  const remove = useMutation({
    mutationFn: () => updateGovernanceGroupMembers(groupId, { remove: members.filter((m) => selected.has(m.id)).map((m) => ({ id: m.id, name: m.name })) }),
    onSuccess: (r) => { report(r, `Removed ${r.removed} member${r.removed === 1 ? "" : "s"}`); setSelected(new Set()); setConfirmRemove(false); refresh(); },
    onError: (err) => toast.error(err.response?.data?.error || err.message, { duration: 8000 }),
  });

  if (isLoading) return <SkeletonList rows={4} />;
  if (error) return <ErrorBox message={error.response?.data?.error || error.message} onRetry={refetch} />;
  const toggle = (id) => setSelected((prev) => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next; });
  const allShownSelected = shown.length > 0 && shown.every((m) => selected.has(m.id));

  return (
    <div>
      <div className="flex items-center gap-2 px-4 pt-3">
        <div className="flex-1"><SearchBar value={filter} onChange={setFilter} placeholder="Filter members…" /></div>
        <IconButton icon={UserPlus} title="Add members" onClick={() => setAdding(true)} />
      </div>
      {selected.size > 0 && (
        <SelectionActionBar
          count={selected.size}
          actions={[{ icon: Trash2, title: `Remove (${selected.size})`, onClick: () => setConfirmRemove(true), disabled: remove.isPending, danger: true }]}
        />
      )}
      {members.length === 0 ? (
        <EmptyState icon={Users} title="No members" subtitle="Add identities to this governance group." />
      ) : (
        <>
          <div className="flex items-center gap-3 px-4 py-2 border-b border-gray-100">
            <input
              type="checkbox"
              checked={allShownSelected}
              onChange={() => setSelected(allShownSelected ? new Set() : new Set(shown.map((m) => m.id)))}
              className="w-4 h-4 rounded border-gray-300"
              title="Select all shown"
            />
            <span className="text-xs text-gray-400">{shown.length} of {members.length} member{members.length === 1 ? "" : "s"}</span>
          </div>
          {shown.map((m) => (
            <div key={m.id} className="flex items-center gap-3 px-4 py-3 border-b border-gray-100 hover:bg-gray-50">
              <input type="checkbox" checked={selected.has(m.id)} onChange={() => toggle(m.id)} className="w-4 h-4 rounded border-gray-300 flex-shrink-0" />
              <button onClick={() => navigate(`/identities/${m.id}`)} className="flex-1 min-w-0 flex items-center gap-3 text-left">
                <Avatar name={m.name || "?"} />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate">{m.name}</p>
                  {m.email && <p className="text-xs text-gray-500 truncate">{m.email}</p>}
                </div>
              </button>
              <ChevronRight size={16} className="text-gray-300 flex-shrink-0" />
            </div>
          ))}
        </>
      )}
      {adding && <AddMembersModal memberIds={new Set(members.map((m) => m.id))} pending={add.isPending} onClose={() => setAdding(false)} onAdd={(people) => add.mutate(people)} />}
      {confirmRemove && (
        <ConfirmModal
          title="Remove members"
          message={`Remove ${selected.size} member${selected.size === 1 ? "" : "s"} from this governance group?`}
          confirmLabel="Remove"
          danger
          pending={remove.isPending}
          onConfirm={() => remove.mutate()}
          onCancel={() => setConfirmRemove(false)}
        />
      )}
    </div>
  );
}

const USAGE_TYPES = {
  ROLE: { label: "Role", Icon: Shield, path: (id) => `/roles/${id}` },
  ACCESS_PROFILE: { label: "Access Profile", Icon: ShieldCheck, path: (id) => `/access-profiles/${id}` },
  ENTITLEMENT: { label: "Entitlement", Icon: Key, path: (id) => `/entitlements/${id}` },
  SOURCE: { label: "Source", Icon: Database, path: (id) => `/sources/${id}` },
  APPLICATION: { label: "Application", Icon: LayoutGrid, path: (id) => `/applications/${id}` },
  WORKFLOW: { label: "Workflow", Icon: GitBranch, path: (id) => `/workflows/${id}` },
  SOD_POLICY: { label: "SOD Policy", Icon: Scale, path: null },
};

function UsagePanel({ groupId }) {
  const navigate = useNavigate();
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ["governance-group-usage", groupId], queryFn: () => getGovernanceGroupUsage(groupId) });
  if (isLoading) {
    return (
      <div className="px-4 py-6 text-center">
        <Spinner />
        <p className="text-xs text-gray-400 mt-2">Scanning roles, access profiles, sources, SOD policies and workflows…</p>
      </div>
    );
  }
  if (error) return <ErrorBox message={error.response?.data?.error || error.message} onRetry={refetch} />;
  const usage = data?.usage || [];

  return (
    <div className="px-4 py-2">
      <p className="text-xs text-gray-400 py-2">
        ISC's own connections for this group plus a scan of roles, access profiles, sources, SOD policies and workflows. Entitlements show only when ISC reports them as connections.
      </p>
      {data?.errors?.length > 0 && <p className="text-xs text-amber-700 mb-2">Some objects couldn't be checked: {data.errors.join("; ")}</p>}
      {usage.length === 0 ? (
        <EmptyState icon={Network} title="Not used" subtitle="Nothing scanned refers to this governance group." />
      ) : (
        <div className="border border-gray-100 rounded-xl overflow-hidden divide-y divide-gray-100">
          {usage.map((u) => {
            const t = USAGE_TYPES[u.type] || { label: u.type, Icon: Box, path: null };
            const Row = t.path ? "button" : "div";
            return (
              <Row
                key={`${u.type}:${u.id}`}
                {...(t.path ? { onClick: () => navigate(t.path(u.id)) } : {})}
                className={`w-full px-3 py-2.5 flex items-center gap-3 text-left ${t.path ? "hover:bg-gray-50" : ""}`}
              >
                <t.Icon size={16} className="text-gray-500 flex-shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-gray-900 truncate">{u.name}</p>
                  <p className="text-xs text-gray-500 truncate">{t.label} · {u.how.join(", ")}</p>
                </div>
                {t.path && <ChevronRight size={16} className="text-gray-300 flex-shrink-0" />}
              </Row>
            );
          })}
        </div>
      )}
      <div className="mt-3">
        <OutlineButton onClick={() => refetch()} className="!w-auto">Rescan</OutlineButton>
      </div>
    </div>
  );
}

export function GovernanceGroupDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [section, setSection] = useUrlState("tab", "details");
  const [editOpen, setEditOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ["governance-group", id], queryFn: () => getGovernanceGroup(id) });

  const del = useMutation({
    mutationFn: () => deleteGovernanceGroup(id),
    onSuccess: () => {
      toast.success("Governance group deleted");
      queryClient.invalidateQueries({ queryKey: ["governance-groups"] });
      navigate("/governance-groups");
    },
    onError: (err) => { toast.error(err.response?.data?.error || err.message, { duration: 8000 }); setConfirmDelete(false); },
  });

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <TopBar
        title="Governance Group"
        onBack={() => navigate(-1)}
        action={data && (
          <div className="flex items-center gap-2">
            <IconButton icon={Pencil} title="Edit" onClick={() => setEditOpen(true)} />
            <IconButton icon={Trash2} title="Delete" onClick={() => setConfirmDelete(true)} />
          </div>
        )}
      />
      <div className="flex-1 overflow-y-auto pb-24">
        {isLoading && <SkeletonList rows={6} />}
        {error && <ErrorBox message={error.response?.data?.error || error.message} onRetry={refetch} />}
        {data && (
          <>
            <div className="px-4 py-5 border-b border-gray-100 flex items-start gap-4">
              <div className="w-12 h-12 rounded-full bg-violet-50 flex items-center justify-center flex-shrink-0">
                <UsersRound size={22} className="text-violet-700" />
              </div>
              <div className="min-w-0">
                <h2 className="text-lg font-semibold text-gray-900">{data.name}</h2>
                <p className="text-sm text-gray-500 mt-0.5">
                  {data.memberCount ?? 0} member{data.memberCount === 1 ? "" : "s"} · Owner: {data.owner?.displayName || data.owner?.name || "—"}
                </p>
              </div>
            </div>
            {/* Side menu + panel — same vertical tabs as the other detail screens. */}
            <div className="flex">
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
                {section === "details" && <DetailsPanel group={data} />}
                {section === "members" && <MembersPanel groupId={id} />}
                {section === "usage" && <UsagePanel groupId={id} />}
              </div>
            </div>
          </>
        )}
      </div>
      {editOpen && data && (
        <GroupFormModal
          group={data}
          onClose={() => setEditOpen(false)}
          onSaved={(saved) => {
            setEditOpen(false);
            if (saved?.id) queryClient.setQueryData(["governance-group", id], saved);
            queryClient.invalidateQueries({ queryKey: ["governance-group", id] });
            queryClient.invalidateQueries({ queryKey: ["governance-groups"] });
          }}
        />
      )}
      {confirmDelete && data && (
        <ConfirmModal
          title="Delete governance group"
          message={`Delete "${data.name}"? ${data.connectionCount ? `ISC reports ${data.connectionCount} connection${data.connectionCount === 1 ? "" : "s"} to it — check the Usage tab first. ` : ""}This can't be undone.`}
          confirmLabel="Delete"
          danger
          pending={del.isPending}
          onConfirm={() => del.mutate()}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </div>
  );
}
