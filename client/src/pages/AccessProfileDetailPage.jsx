import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck, Key, Trash2, Pencil, Plus, X, Info, Users, ChevronLeft, ChevronRight, Power, PowerOff, UserPlus, Wand2, Link, Tags, Braces, CheckSquare } from "lucide-react";
import toast from "react-hot-toast";
import {
  getAccessProfile, deleteAccessProfile, sortByName, updateAccessProfile, updateAccessProfileEntitlements,
  listEntitlementsBySource, listIdentities, listAccessMembers, setAccessProfileEnabled,
  submitAccessRequest, revokeAccessRequest, generateAccessProfileDescription, getCredentials,
} from "../lib/sailpoint";
import { useUrlState } from "../hooks/useUrlState";
import { useUrlSearch } from "../hooks/useUrlSearch";
import { TopBar } from "../components/TopBar";
import { EditableMetadataPanel } from "../components/EditableMetadataPanel";
import { RawJsonPanel } from "../components/RawJsonPanel";
import { ApprovalSettingsPanel } from "../components/ApprovalSettingsPanel";
import { AdditionalOwnersField, additionalOwnersState, additionalOwnersValue, additionalOwnersChanged, formatAdditionalOwners } from "../components/AdditionalOwnersField";
import {
  InfoRow, SkeletonList, ErrorBox, SectionLabel, IconButton, ConfirmModal, SearchBar, Avatar, EmptyState,
  Spinner, PrimaryButton, OutlineButton, Field, Input, Textarea, Pager,
} from "../components/ui";
import { tenantUiHost } from "../lib/tenantHost";

const MEMBERS_PAGE_SIZE = 50;

// Debounced single-identity search-and-pick — used for the owner field in
// EditAccessProfileModal. Same shape as RoleDetailPage's PickerField, kept
// local here since this page doesn't need the multi-select/governance-group
// variants roles do.
function OwnerPickerField({ selected, onChange }) {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [open, setOpen] = useState(false);

  const handleSearch = (value) => {
    setQuery(value);
    setOpen(true);
    clearTimeout(window.__apOwnerPickerTimer);
    window.__apOwnerPickerTimer = setTimeout(() => setDebounced(value), 350);
  };

  const resultsQuery = useQuery({
    queryKey: ["identity-search-for-ap-owner", debounced],
    queryFn: () => listIdentities({ limit: 15, query: debounced || undefined }),
    enabled: open,
  });
  const results = (resultsQuery.data || []).filter((i) => i.id !== selected?.id);

  return (
    <Field label="Owner">
      {selected && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          <span className="inline-flex items-center gap-1 text-xs bg-blue-50 text-blue-700 border border-blue-100 rounded-full pl-2.5 pr-1.5 py-1">
            {selected.name}
            <button type="button" onClick={() => onChange(null)} className="hover:text-blue-900">
              <X size={12} />
            </button>
          </span>
        </div>
      )}
      {!selected && (
        <div className="relative">
          <Input value={query} onChange={(e) => handleSearch(e.target.value)} onFocus={() => setOpen(true)} placeholder="Search users…" />
          {open && (
            <div className="absolute z-10 left-0 right-0 mt-1 bg-white border border-gray-200 rounded-xl shadow-lg max-h-96 overflow-y-auto">
              {resultsQuery.isLoading && (
                <div className="flex items-center justify-center py-3"><Spinner size={14} /></div>
              )}
              {!resultsQuery.isLoading && results.length === 0 && (
                <p className="text-xs text-gray-400 text-center py-3">No results</p>
              )}
              {results.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => { onChange({ id: r.id, name: r.name }); setQuery(""); setDebounced(""); setOpen(false); }}
                  className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
                >
                  {r.name}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </Field>
  );
}

function EditAccessProfileModal({ profile, onClose, onSave, pending }) {
  const [name, setName] = useState(profile.name || "");
  const [description, setDescription] = useState(profile.description || "");
  const [owner, setOwner] = useState(profile.owner ? { id: profile.owner.id, name: profile.owner.name } : null);
  const [additional, setAdditional] = useState(() => additionalOwnersState(profile.additionalOwners));

  const canSave = name.trim() && owner?.id;

  function handleSave() {
    const fields = {};
    if (name !== profile.name) fields.name = name;
    if (description !== (profile.description || "")) fields.description = description;
    if (owner?.id !== profile.owner?.id) fields.owner = owner;
    const nextAdditionalOwners = additionalOwnersValue(additional);
    if (additionalOwnersChanged(nextAdditionalOwners, profile.additionalOwners)) fields.additionalOwners = nextAdditionalOwners;
    onSave(fields);
  }

  return (
    <div
      className="fixed inset-0 bg-black/30 z-30 flex items-end md:items-center justify-center"
      onClick={(e) => e.target === e.currentTarget && !pending && onClose()}
    >
      <div className="bg-white w-full max-w-lg md:mx-4 rounded-t-2xl md:rounded-2xl shadow-xl p-5 max-h-[85vh] overflow-y-auto">
        <h2 className="text-base font-semibold text-gray-900 mb-4">Edit access profile</h2>
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Description">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <OwnerPickerField selected={owner} onChange={setOwner} />
        <AdditionalOwnersField value={additional} onChange={setAdditional} />
        <div className="flex gap-2 mt-2">
          <PrimaryButton onClick={handleSave} loading={pending} disabled={!canSave} className="!w-auto flex-1">Save</PrimaryButton>
          <OutlineButton onClick={onClose} disabled={pending} className="!w-auto flex-1">Cancel</OutlineButton>
        </div>
      </div>
    </div>
  );
}

// Search-and-pick modal for adding entitlements — scoped to the access
// profile's own source, since ISC only allows an access profile to hold
// entitlements from the source it belongs to (verified live: adding one
// from a different source 400s with "Illegal attempt to modify ENTITLEMENT
// field").
function AddEntitlementsModal({ sourceId, sourceName, existingIds, onClose, onAdd, pending }) {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [selected, setSelected] = useState(new Map());

  const handleSearch = (value) => {
    setQuery(value);
    clearTimeout(window.__apAddEntsTimer);
    window.__apAddEntsTimer = setTimeout(() => setDebounced(value), 350);
  };

  const resultsQuery = useQuery({
    queryKey: ["entitlements-for-access-profile", sourceId, debounced],
    queryFn: () => listEntitlementsBySource(sourceId, { limit: 25, query: debounced || undefined }),
  });
  const results = (resultsQuery.data || []).filter((e) => !existingIds.has(e.id));

  const toggle = (ent) => {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(ent.id)) next.delete(ent.id);
      else next.set(ent.id, { id: ent.id, name: ent.name });
      return next;
    });
  };

  return (
    <div
      className="fixed inset-0 bg-black/30 z-30 flex items-end md:items-center justify-center"
      onClick={(e) => e.target === e.currentTarget && !pending && onClose()}
    >
      <div className="bg-white w-full max-w-lg md:mx-4 rounded-t-2xl md:rounded-2xl shadow-xl p-5 max-h-[85vh] overflow-y-auto flex flex-col">
        <h2 className="text-base font-semibold text-gray-900 mb-1">Add entitlements</h2>
        <p className="text-xs text-gray-400 mb-3">From {sourceName || "this profile's source"} only</p>
        <SearchBar value={query} onChange={handleSearch} placeholder="Search entitlements by name…" />
        {selected.size > 0 && <p className="text-xs text-gray-500 my-2">{selected.size} selected</p>}
        <div className="flex-1 overflow-y-auto my-2">
          {resultsQuery.isLoading && (
            <div className="flex items-center justify-center py-4"><Spinner size={16} /></div>
          )}
          {!resultsQuery.isLoading && results.length === 0 && (
            <p className="text-sm text-gray-400 text-center py-4">No entitlements found</p>
          )}
          {results.map((ent) => (
            <label key={ent.id} className="flex items-center gap-3 py-2.5 border-b border-gray-100 cursor-pointer">
              <input
                type="checkbox"
                checked={selected.has(ent.id)}
                onChange={() => toggle(ent)}
                className="w-4 h-4 rounded border-gray-300 accent-blue-600 flex-shrink-0"
              />
              <div className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center flex-shrink-0">
                <Key size={14} className="text-gray-500" />
              </div>
              <p className="text-sm font-medium text-gray-900 truncate flex-1">{ent.name}</p>
            </label>
          ))}
        </div>
        <div className="flex gap-2">
          <PrimaryButton
            onClick={() => onAdd([...selected.values()])}
            loading={pending}
            disabled={selected.size === 0}
            className="!w-auto flex-1"
          >
            <Plus size={16} />
            Add selected ({selected.size})
          </PrimaryButton>
          <OutlineButton onClick={onClose} disabled={pending} className="!w-auto flex-1">Cancel</OutlineButton>
        </div>
      </div>
    </div>
  );
}

// Search-and-pick modal for requesting this access profile for one or more
// identities. Unlike Role Detail's Add Members (a direct list edit), there's
// no "membership" field on an access profile — the only way to grant it is
// a real ISC access request (requestType GRANT_ACCESS), which may need
// approval and isn't instant, so this is framed as "request" throughout
// rather than implying an immediate change.
function AddMembersModal({ existingIds, onClose, onAdd, pending }) {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [selected, setSelected] = useState(new Map());

  const handleSearch = (value) => {
    setQuery(value);
    clearTimeout(window.__apAddMembersTimer);
    window.__apAddMembersTimer = setTimeout(() => setDebounced(value), 350);
  };

  const resultsQuery = useQuery({
    queryKey: ["identity-search-for-ap-members", debounced],
    queryFn: () => listIdentities({ limit: 25, query: debounced || undefined }),
  });
  const results = (resultsQuery.data || []).filter((i) => !existingIds.has(i.id));

  const toggle = (idn) => {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(idn.id)) next.delete(idn.id);
      else next.set(idn.id, { id: idn.id, name: idn.name });
      return next;
    });
  };

  return (
    <div
      className="fixed inset-0 bg-black/30 z-30 flex items-end md:items-center justify-center"
      onClick={(e) => e.target === e.currentTarget && !pending && onClose()}
    >
      <div className="bg-white w-full max-w-lg md:mx-4 rounded-t-2xl md:rounded-2xl shadow-xl p-5 max-h-[85vh] overflow-y-auto flex flex-col">
        <h2 className="text-base font-semibold text-gray-900 mb-1">Request access</h2>
        <p className="text-xs text-gray-400 mb-3">
          Submits a real access request for each identity selected — not an instant grant. It may
          need approval before it takes effect.
        </p>
        <SearchBar value={query} onChange={handleSearch} placeholder="Search identities by name…" />
        {selected.size > 0 && <p className="text-xs text-gray-500 my-2">{selected.size} selected</p>}
        <div className="flex-1 overflow-y-auto my-2">
          {resultsQuery.isLoading && (
            <div className="flex items-center justify-center py-4"><Spinner size={16} /></div>
          )}
          {!resultsQuery.isLoading && results.length === 0 && (
            <p className="text-sm text-gray-400 text-center py-4">No identities found</p>
          )}
          {results.map((idn) => (
            <label key={idn.id} className="flex items-center gap-3 py-2.5 border-b border-gray-100 cursor-pointer">
              <input
                type="checkbox"
                checked={selected.has(idn.id)}
                onChange={() => toggle(idn)}
                className="w-4 h-4 rounded border-gray-300 accent-blue-600 flex-shrink-0"
              />
              <Avatar name={idn.name} size="sm" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-gray-900 truncate">{idn.name}</p>
                {idn.email && <p className="text-xs text-gray-400 truncate">{idn.email}</p>}
              </div>
            </label>
          ))}
        </div>
        <div className="flex gap-2">
          <PrimaryButton
            onClick={() => onAdd([...selected.values()])}
            loading={pending}
            disabled={selected.size === 0}
            className="!w-auto flex-1"
          >
            <UserPlus size={16} />
            Request for selected ({selected.size})
          </PrimaryButton>
          <OutlineButton onClick={onClose} disabled={pending} className="!w-auto flex-1">Cancel</OutlineButton>
        </div>
      </div>
    </div>
  );
}

// Shows Claude's suggested description alongside the profile's current one
// — editable before saving (pre-filled with the suggestion) and never
// applies anything until the user explicitly confirms. Same shape as Role
// Detail's own generate-description modal, duplicated here rather than
// shared since the two pages don't share a component file (same pattern as
// AddMembersModal elsewhere in this app).
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
          <OutlineButton onClick={onClose} disabled={pending} className="!w-auto flex-1">Cancel</OutlineButton>
        </div>
      </div>
    </div>
  );
}

export default function AccessProfileDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [addEntsOpen, setAddEntsOpen] = useState(false);
  const [selectedEntitlements, setSelectedEntitlements] = useState(new Set());
  const [pendingEntRemoval, setPendingEntRemoval] = useState(false);
  const [addMembersOpen, setAddMembersOpen] = useState(false);
  const [selectedMembers, setSelectedMembers] = useState(new Set());
  const [pendingMemberRemoval, setPendingMemberRemoval] = useState(false);
  // URL-backed (not useState) so the active tab and member search survive
  // navigating to an entitlement or member's own detail page and clicking
  // Back — same reasoning as Role Detail.
  const [section, setSection] = useUrlState("tab", "details");
  const { search: memberSearch, debouncedSearch: debouncedMemberSearch, handleSearch: handleUrlMemberSearch } = useUrlSearch("mq");
  const [memberOffset, setMemberOffset] = useState(0);
  const [suggestedDescription, setSuggestedDescription] = useState(null); // string | null

  const handleMemberSearch = (value) => {
    handleUrlMemberSearch(value);
    setMemberOffset(0);
  };

  const { data, isLoading, error } = useQuery({
    queryKey: ["access-profile", id],
    queryFn: () => getAccessProfile(id),
  });

  const entitlements = sortByName(data?.entitlements);
  const existingEntIds = new Set(entitlements.map((e) => e.id));

  const membersQuery = useQuery({
    queryKey: ["access-profile-members", id, debouncedMemberSearch, memberOffset],
    queryFn: () => listAccessMembers(id, { limit: MEMBERS_PAGE_SIZE, offset: memberOffset, query: debouncedMemberSearch || undefined }),
    enabled: section === "members",
    keepPreviousData: true,
  });
  const members = membersQuery.data?.members || [];
  const totalMembers = membersQuery.data?.total ?? 0;
  const memberPageStart = totalMembers === 0 ? 0 : memberOffset + 1;
  const memberPageEnd = Math.min(memberOffset + members.length, totalMembers);

  const remove = useMutation({
    mutationFn: () => deleteAccessProfile(id),
    onSuccess: () => {
      toast.success("Access profile deleted");
      queryClient.invalidateQueries({ queryKey: ["access-profiles"] });
      navigate(-1);
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const toggleEnabled = useMutation({
    mutationFn: (enabled) => setAccessProfileEnabled(id, enabled),
    onSuccess: (updated, enabled) => {
      toast.success(enabled ? "Access profile enabled" : "Access profile disabled");
      queryClient.setQueryData(["access-profile", id], updated);
      queryClient.invalidateQueries({ queryKey: ["access-profiles"] });
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const generateDescription = useMutation({
    mutationFn: () => generateAccessProfileDescription(id),
    onSuccess: (result) => setSuggestedDescription(result.description),
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const saveGeneratedDescription = useMutation({
    mutationFn: (description) => updateAccessProfile(id, { description }),
    onSuccess: (updated) => {
      toast.success("Description updated");
      queryClient.setQueryData(["access-profile", id], updated);
      setSuggestedDescription(null);
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  // Requesting/revoking membership submits real ISC access requests (there's
  // no direct "membership" field on an access profile to edit) — one
  // request per identity, run in parallel. Success just means the requests
  // were submitted, not that access changed yet; the member list itself
  // won't reflect it until the request is approved (if needed) and
  // provisioned, so this doesn't optimistically update the query cache.
  const requestForMembers = useMutation({
    mutationFn: (identities) =>
      Promise.all(identities.map((idn) => submitAccessRequest({ requestedFor: [idn.id], itemId: id, itemType: "ACCESS_PROFILE", comment: "Requested via Admin Studio" }))),
    onSuccess: (_result, identities) => {
      toast.success(`Access requested for ${identities.length} identit${identities.length === 1 ? "y" : "ies"}`);
      setAddMembersOpen(false);
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const revokeForMembers = useMutation({
    mutationFn: (identityIds) =>
      Promise.all(identityIds.map((identityId) => revokeAccessRequest({ requestedFor: [identityId], itemId: id, itemType: "ACCESS_PROFILE", comment: "Revoked via Admin Studio" }))),
    onSuccess: (_result, identityIds) => {
      toast.success(`Revocation requested for ${identityIds.length} identit${identityIds.length === 1 ? "y" : "ies"}`);
      setSelectedMembers(new Set());
      setPendingMemberRemoval(false);
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const toggleMember = (identityId) => {
    setSelectedMembers((prev) => {
      const next = new Set(prev);
      if (next.has(identityId)) next.delete(identityId);
      else next.add(identityId);
      return next;
    });
  };
  const toggleAllMembers = () => {
    setSelectedMembers((prev) =>
      members.length > 0 && prev.size === members.length ? new Set() : new Set(members.map((m) => m.id))
    );
  };

  const editProfile = useMutation({
    mutationFn: (fields) => updateAccessProfile(id, fields),
    onSuccess: (updated) => {
      toast.success("Access profile updated");
      queryClient.setQueryData(["access-profile", id], updated);
      setEditOpen(false);
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const addEntitlements = useMutation({
    mutationFn: (ents) => updateAccessProfileEntitlements(id, { add: ents }),
    onSuccess: (updated) => {
      toast.success("Entitlements added");
      queryClient.setQueryData(["access-profile", id], updated);
      setAddEntsOpen(false);
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const removeEntitlements = useMutation({
    mutationFn: (ids) => updateAccessProfileEntitlements(id, { remove: ids }),
    onSuccess: (updated) => {
      toast.success("Entitlements removed");
      queryClient.setQueryData(["access-profile", id], updated);
      setSelectedEntitlements(new Set());
      setPendingEntRemoval(false);
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const toggleEntitlement = (entId) => {
    setSelectedEntitlements((prev) => {
      const next = new Set(prev);
      if (next.has(entId)) next.delete(entId);
      else next.add(entId);
      return next;
    });
  };
  const toggleAllEntitlements = () => {
    setSelectedEntitlements((prev) =>
      entitlements.length > 0 && prev.size === entitlements.length ? new Set() : new Set(entitlements.map((e) => e.id))
    );
  };

  const apIscTenant = getCredentials()?.tenant;
  const apIscUrl =
    apIscTenant && data
      ? `https://${tenantUiHost(apIscTenant)}/ui/a/admin/access/access-profiles/manage/${data.id}/configuration`
      : null;

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <TopBar
        title="Access Profile"
        onBack={() => navigate(-1)}
        action={
          data && (
            <div className="flex items-center gap-2">
              <IconButton
                icon={Link}
                title="View in Identity Security Cloud"
                onClick={() => apIscUrl && window.open(apIscUrl, "_blank", "noopener,noreferrer")}
                disabled={!apIscUrl}
              />
              {data.enabled ? (
                <IconButton
                  icon={PowerOff}
                  title="Disable"
                  onClick={() => toggleEnabled.mutate(false)}
                  loading={toggleEnabled.isPending && toggleEnabled.variables === false}
                  disabled={toggleEnabled.isPending || remove.isPending}
                />
              ) : (
                <IconButton
                  icon={Power}
                  title="Enable"
                  onClick={() => toggleEnabled.mutate(true)}
                  loading={toggleEnabled.isPending && toggleEnabled.variables === true}
                  disabled={toggleEnabled.isPending || remove.isPending}
                />
              )}
              <IconButton
                icon={Wand2}
                title="Generate a new description with AI"
                onClick={() => generateDescription.mutate()}
                loading={generateDescription.isPending}
                disabled={toggleEnabled.isPending || remove.isPending || generateDescription.isPending}
              />
              <IconButton icon={Pencil} title="Edit" onClick={() => setEditOpen(true)} />
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
        <div className="px-4 py-4">
          {isLoading && <SkeletonList rows={6} />}
          {error && <ErrorBox message={error.message} />}
          {data && (
            <>
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-full bg-violet-50 flex items-center justify-center flex-shrink-0">
                  <ShieldCheck size={18} className="text-violet-600" />
                </div>
                <div className="min-w-0">
                  <h2 className="text-base font-semibold text-gray-900 truncate">{data.name}</h2>
                  {data.source?.name && <p className="text-xs text-gray-500">{data.source.name}</p>}
                </div>
              </div>
              {data.description && (
                <p className="text-sm text-gray-600 leading-relaxed">{data.description}</p>
              )}
            </>
          )}
        </div>

        {data && (
          <div className="flex border-t border-gray-100">
            <div className="w-24 flex-shrink-0 border-r border-gray-100 py-2">
              {[
                { key: "details", label: "Details", Icon: Info },
                { key: "entitlements", label: "Entitlements", Icon: Key },
                { key: "members", label: "Members", Icon: Users },
                { key: "approvals", label: "Approvals", Icon: CheckSquare },
                { key: "metadata", label: "Metadata", Icon: Tags },
                { key: "json", label: "JSON", Icon: Braces },
              ].map(({ key, label, Icon }) => (
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
              {section === "approvals" && <ApprovalSettingsPanel kind="access-profile" object={data} invalidateKeys={[["access-profile", id], ["access-profiles"]]} />}
              {section === "metadata" && <EditableMetadataPanel kind="access-profiles" objectId={id} metadata={data.accessModelMetadata} invalidateKeys={[["access-profile", id], ["access-profiles"]]} />}
              {section === "json" && (
                <RawJsonPanel data={data} resource="access-profiles" objectId={id} invalidateKeys={[["access-profile", id], ["access-profiles"]]} />
              )}
              {section === "details" && (
                <div className="border border-gray-100 rounded-xl overflow-hidden m-4">
                  <InfoRow label="Source" value={data.source?.name} />
                  <InfoRow label="Requestable" value={data.requestable != null ? String(data.requestable) : undefined} />
                  <InfoRow label="Enabled" value={data.enabled != null ? String(data.enabled) : undefined} />
                  <InfoRow label="Owner" value={data.owner?.name} />
                  <InfoRow label="Additional owners" value={formatAdditionalOwners(data.additionalOwners)} />
                  <InfoRow label="Created" value={data.created ? new Date(data.created).toLocaleString() : undefined} />
                  <InfoRow label="Modified" value={data.modified ? new Date(data.modified).toLocaleString() : undefined} />
                  <InfoRow label="Access profile ID" value={data.id} />
                </div>
              )}

              {section === "entitlements" && (
                <div>
                  <div className="flex items-center justify-between px-4 pt-4 pb-2">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={entitlements.length > 0 && selectedEntitlements.size === entitlements.length}
                        onChange={toggleAllEntitlements}
                        className="w-4 h-4 rounded border-gray-300 accent-blue-600"
                      />
                      <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                        Entitlements ({entitlements.length})
                      </span>
                    </label>
                    <div className="flex items-center gap-1.5">
                      {selectedEntitlements.size > 0 && (
                        <IconButton
                          icon={Trash2}
                          title={`Delete selected (${selectedEntitlements.size})`}
                          onClick={() => setPendingEntRemoval(true)}
                          loading={removeEntitlements.isPending}
                          className="!w-7 !h-7 !border-red-200 !text-red-600 hover:!bg-red-50"
                        />
                      )}
                      <IconButton
                        icon={Plus}
                        title="Add entitlements"
                        onClick={() => setAddEntsOpen(true)}
                        className="!w-7 !h-7 !border-emerald-200 !text-emerald-600 hover:!bg-emerald-50"
                      />
                    </div>
                  </div>
                  {entitlements.length === 0 ? (
                    <p className="text-sm text-gray-400 px-4 pb-4">No entitlements on this access profile</p>
                  ) : (
                    <div className="border-t border-gray-100">
                      {entitlements.map((e) => (
                        <div
                          key={e.id}
                          className="w-full flex items-center gap-3 px-4 py-3.5 border-b border-gray-100 hover:bg-gray-50 transition-colors"
                        >
                          <input
                            type="checkbox"
                            checked={selectedEntitlements.has(e.id)}
                            onChange={() => toggleEntitlement(e.id)}
                            className="w-4 h-4 rounded border-gray-300 accent-blue-600 flex-shrink-0"
                          />
                          <button
                            onClick={() => navigate(`/entitlements/${e.id}`)}
                            className="flex items-center gap-3 flex-1 min-w-0 text-left"
                          >
                            <div className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center flex-shrink-0">
                              <Key size={14} className="text-gray-500" />
                            </div>
                            <p className="text-sm font-medium text-gray-900 truncate flex-1">{e.name}</p>
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {section === "members" && (
                <div>
                  <div className="flex items-center justify-between px-4 pt-4 pb-2">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={members.length > 0 && selectedMembers.size === members.length}
                        onChange={toggleAllMembers}
                        className="w-4 h-4 rounded border-gray-300 accent-blue-600"
                      />
                      <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                        Members{totalMembers > 0 && ` (${totalMembers})`}
                      </span>
                    </label>
                    <div className="flex items-center gap-1.5">
                      {selectedMembers.size > 0 && (
                        <IconButton
                          icon={Trash2}
                          title={`Request removal for selected (${selectedMembers.size})`}
                          onClick={() => setPendingMemberRemoval(true)}
                          loading={revokeForMembers.isPending}
                          className="!w-7 !h-7 !border-red-200 !text-red-600 hover:!bg-red-50"
                        />
                      )}
                      <IconButton
                        icon={UserPlus}
                        title="Request access for members"
                        onClick={() => setAddMembersOpen(true)}
                        className="!w-7 !h-7 !border-blue-200 !text-blue-600 hover:!bg-blue-50"
                      />
                    </div>
                  </div>
                  <p className="text-xs text-gray-400 px-4 pb-2">
                    Adding/removing here submits a real ISC access request — it may need approval and isn't instant.
                  </p>
                  <SearchBar value={memberSearch} onChange={handleMemberSearch} placeholder="Search members by name…" />
                  {membersQuery.isLoading && (
                    <div className="flex items-center justify-center py-6">
                      <Spinner size={18} />
                    </div>
                  )}
                  {membersQuery.error && <ErrorBox message={membersQuery.error.message} />}
                  {!membersQuery.isLoading && !membersQuery.error && members.length === 0 && (
                    <EmptyState
                      icon={Users}
                      title={debouncedMemberSearch ? "No results" : "No members"}
                      subtitle={debouncedMemberSearch ? `No members match "${debouncedMemberSearch}"` : "No identities currently hold this access profile"}
                    />
                  )}
                  {totalMembers > 0 && <Pager offset={memberOffset} pageSize={MEMBERS_PAGE_SIZE} total={totalMembers} noun="member" onOffsetChange={setMemberOffset} hasNext={memberOffset + members.length < totalMembers} busy={membersQuery.isFetching} />}
                  {members.length > 0 && (
                    <div className="border-t border-gray-100">
                      {members.map((m) => (
                        <div
                          key={m.id}
                          className="w-full flex items-center gap-3 px-4 py-3 border-b border-gray-100 hover:bg-gray-50 transition-colors"
                        >
                          <input
                            type="checkbox"
                            checked={selectedMembers.has(m.id)}
                            onChange={() => toggleMember(m.id)}
                            className="w-4 h-4 rounded border-gray-300 accent-blue-600 flex-shrink-0"
                          />
                          <button
                            onClick={() => navigate(`/identities/${m.id}`)}
                            className="flex items-center gap-3 flex-1 min-w-0 text-left"
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
                        </div>
                      ))}
                    </div>
                  )}
                  {totalMembers > 0 && (
                    <Pager offset={memberOffset} pageSize={MEMBERS_PAGE_SIZE} total={totalMembers} noun="member" onOffsetChange={setMemberOffset} hasNext={memberOffset + members.length < totalMembers} busy={membersQuery.isFetching} />
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {confirmDeleteOpen && (
        <ConfirmModal
          title="Delete this access profile?"
          message="This permanently deletes the access profile from this tenant. This cannot be undone."
          confirmLabel="Delete"
          danger
          pending={remove.isPending}
          onConfirm={() => remove.mutate()}
          onCancel={() => setConfirmDeleteOpen(false)}
        />
      )}

      {editOpen && data && (
        <EditAccessProfileModal
          profile={data}
          onClose={() => setEditOpen(false)}
          onSave={(fields) => editProfile.mutate(fields)}
          pending={editProfile.isPending}
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

      {addEntsOpen && data && (
        <AddEntitlementsModal
          sourceId={data.source?.id}
          sourceName={data.source?.name}
          existingIds={existingEntIds}
          onClose={() => setAddEntsOpen(false)}
          onAdd={(ents) => addEntitlements.mutate(ents)}
          pending={addEntitlements.isPending}
        />
      )}

      {pendingEntRemoval && (
        <ConfirmModal
          title="Delete selected entitlements?"
          message={`This removes ${selectedEntitlements.size} entitlement${selectedEntitlements.size === 1 ? "" : "s"} directly from this access profile. This cannot be undone.`}
          confirmLabel="Delete"
          danger
          pending={removeEntitlements.isPending}
          onConfirm={() => removeEntitlements.mutate(Array.from(selectedEntitlements))}
          onCancel={() => setPendingEntRemoval(false)}
        />
      )}

      {addMembersOpen && (
        <AddMembersModal
          existingIds={new Set(members.map((m) => m.id))}
          onClose={() => setAddMembersOpen(false)}
          onAdd={(identities) => requestForMembers.mutate(identities)}
          pending={requestForMembers.isPending}
        />
      )}

      {pendingMemberRemoval && (
        <ConfirmModal
          title="Request removal for selected members?"
          message={`This submits a real ISC revoke request for ${selectedMembers.size} identit${selectedMembers.size === 1 ? "y" : "ies"} — it may need approval and isn't instant.`}
          confirmLabel="Request removal"
          danger
          pending={revokeForMembers.isPending}
          onConfirm={() => revokeForMembers.mutate(Array.from(selectedMembers))}
          onCancel={() => setPendingMemberRemoval(false)}
        />
      )}
    </div>
  );
}
