import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  LayoutGrid, Trash2, Plus, Info, ShieldCheck, Power, PowerOff, Eye, EyeOff,
  CheckCircle2, XCircle, Wand2, Pencil, Link, Braces,
} from "lucide-react";
import { RawJsonPanel } from "../components/RawJsonPanel";
import toast from "react-hot-toast";
import {
  getSourceApp, updateSourceApp, deleteSourceApp, generateSourceAppDescription,
  listSourceAppAccessProfiles, updateSourceAppAccessProfiles, listIdentities, listAccessProfiles, getCredentials,
} from "../lib/sailpoint";
import { useUrlState } from "../hooks/useUrlState";
import { TopBar } from "../components/TopBar";
import {
  InfoRow, SkeletonList, ErrorBox, IconButton, ConfirmModal, SearchBar, EmptyState, Spinner,
  PrimaryButton, OutlineButton, Field, Input, Textarea, Select,
} from "../components/ui";
import { PickerField } from "../components/PickerField";
import { tenantUiHost } from "../lib/tenantHost";

// Search-and-check picker for adding one or more Access Profiles to this
// Application in a single batch — mirrors AccessProfileDetailPage's
// AddEntitlementsModal shape (separate dialog with its own Cancel/Save,
// small enough to duplicate rather than share).
function AddAccessProfilesModal({ sourceId, excludeIds, onClose, onAdd, pending }) {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [selected, setSelected] = useState(new Map());

  const handleSearch = (value) => {
    setQuery(value);
    clearTimeout(window.__appAddAPsTimer);
    window.__appAddAPsTimer = setTimeout(() => setDebounced(value), 350);
  };

  const resultsQuery = useQuery({
    queryKey: ["access-profiles-for-app-add", sourceId, debounced],
    queryFn: () => listAccessProfiles({ limit: 25, query: debounced || undefined, includeNonRequestable: true }),
  });
  const results = (resultsQuery.data || []).filter((p) => p.source?.id === sourceId && !excludeIds.has(p.id));

  const toggle = (p) => {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(p.id)) next.delete(p.id);
      else next.set(p.id, { id: p.id, name: p.name });
      return next;
    });
  };

  return (
    <div
      className="fixed inset-0 bg-black/30 z-30 flex items-end md:items-center justify-center"
      onClick={(e) => e.target === e.currentTarget && !pending && onClose()}
    >
      <div className="bg-white w-full max-w-lg md:mx-4 rounded-t-2xl md:rounded-2xl shadow-xl p-5 max-h-[85vh] overflow-y-auto flex flex-col">
        <h2 className="text-base font-semibold text-gray-900 mb-3">Add Access Profiles</h2>
        <SearchBar value={query} onChange={handleSearch} placeholder="Search access profiles on this source…" />
        {selected.size > 0 && <p className="text-xs text-gray-500 mt-2">{selected.size} selected</p>}
        <div className="flex-1 overflow-y-auto my-2 min-h-[120px]">
          {resultsQuery.isLoading && (
            <div className="flex items-center justify-center py-4"><Spinner size={16} /></div>
          )}
          {!resultsQuery.isLoading && results.length === 0 && (
            <p className="text-sm text-gray-400 text-center py-4">No access profiles found</p>
          )}
          {results.map((p) => (
            <label key={p.id} className="flex items-center gap-3 py-2.5 border-b border-gray-100 cursor-pointer">
              <input
                type="checkbox"
                checked={selected.has(p.id)}
                onChange={() => toggle(p)}
                className="w-4 h-4 rounded border-gray-300 accent-blue-600 flex-shrink-0"
              />
              <span className="text-sm text-gray-900 truncate">{p.name}</span>
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

// Consolidated edit dialog — same shape as AccessProfileDetailPage's
// EditAccessProfileModal (Name/Description/Owner, only changed fields sent),
// plus this object's own Accounts scope and its three on/off flags, which
// otherwise only had one-click TopBar icons and no single place to change
// several of them together.
function EditApplicationModal({ app, searchIdentities, onClose, onSave, pending }) {
  const [name, setName] = useState(app.name || "");
  const [description, setDescription] = useState(app.description || "");
  const [owner, setOwner] = useState(app.owner ? [{ id: app.owner.id, name: app.owner.name }] : []);
  const [matchAllAccounts, setMatchAllAccounts] = useState(!!app.matchAllAccounts);
  const [enabled, setEnabled] = useState(!!app.enabled);
  const [appCenterEnabled, setAppCenterEnabled] = useState(!!app.appCenterEnabled);
  const [provisionRequestEnabled, setProvisionRequestEnabled] = useState(!!app.provisionRequestEnabled);

  const canSave = name.trim() && owner[0]?.id;

  function handleSave() {
    const fields = {};
    if (name !== app.name) fields.name = name;
    if (description !== (app.description || "")) fields.description = description;
    if (owner[0]?.id !== (app.owner?.id || undefined)) fields.owner = owner[0];
    if (matchAllAccounts !== !!app.matchAllAccounts) fields.matchAllAccounts = matchAllAccounts;
    if (enabled !== !!app.enabled) fields.enabled = enabled;
    if (appCenterEnabled !== !!app.appCenterEnabled) fields.appCenterEnabled = appCenterEnabled;
    if (provisionRequestEnabled !== !!app.provisionRequestEnabled) fields.provisionRequestEnabled = provisionRequestEnabled;
    onSave(fields);
  }

  return (
    <div
      className="fixed inset-0 bg-black/30 z-30 flex items-end md:items-center justify-center"
      onClick={(e) => e.target === e.currentTarget && !pending && onClose()}
    >
      <div className="bg-white w-full max-w-lg md:mx-4 rounded-t-2xl md:rounded-2xl shadow-xl p-5 max-h-[85vh] overflow-y-auto">
        <h2 className="text-base font-semibold text-gray-900 mb-4">Edit application</h2>
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Description">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <PickerField
          label="Owner"
          placeholder="Search users…"
          searchFn={searchIdentities}
          multi={false}
          selected={owner}
          onChange={setOwner}
        />
        <p className="text-xs text-gray-400 -mt-2 mb-4">ISC applications have a single owner — additional owners aren't supported for applications.</p>
        <Field label="Accounts">
          <Select value={matchAllAccounts ? "all" : "specific"} onChange={(e) => setMatchAllAccounts(e.target.value === "all")}>
            <option value="all">All Users</option>
            <option value="specific">Specific Users</option>
          </Select>
        </Field>

        <div className="space-y-2 mb-4">
          <label className="flex items-center gap-2.5 text-sm text-gray-700">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="w-4 h-4 rounded border-gray-300" />
            Enabled
          </label>
          <label className="flex items-center gap-2.5 text-sm text-gray-700">
            <input type="checkbox" checked={appCenterEnabled} onChange={(e) => setAppCenterEnabled(e.target.checked)} className="w-4 h-4 rounded border-gray-300" />
            Visible in request center
          </label>
          <label className="flex items-center gap-2.5 text-sm text-gray-700">
            <input type="checkbox" checked={provisionRequestEnabled} onChange={(e) => setProvisionRequestEnabled(e.target.checked)} className="w-4 h-4 rounded border-gray-300" />
            Requestable
          </label>
        </div>

        <div className="flex gap-2 mt-2">
          <PrimaryButton onClick={handleSave} loading={pending} disabled={!canSave} className="!w-auto flex-1">Save</PrimaryButton>
          <OutlineButton onClick={onClose} disabled={pending} className="!w-auto flex-1">Cancel</OutlineButton>
        </div>
      </div>
    </div>
  );
}

// Reviews Claude's suggested description before applying it — same shape as
// AccessProfileDetailPage's GeneratedDescriptionModal.
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

export default function ApplicationDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [addProfilesOpen, setAddProfilesOpen] = useState(false);
  const [suggestedDescription, setSuggestedDescription] = useState(null);
  const [editOpen, setEditOpen] = useState(false);
  const [section, setSection] = useUrlState("tab", "details");

  const { data, isLoading, error } = useQuery({
    queryKey: ["source-app", id],
    queryFn: () => getSourceApp(id),
  });

  const searchIdentities = async (q) => (await listIdentities({ limit: 15, query: q || undefined })).map((i) => ({ id: i.id, name: i.name }));

  const accessProfilesQuery = useQuery({
    queryKey: ["source-app-access-profiles", id],
    queryFn: () => listSourceAppAccessProfiles(id),
    enabled: section === "access-profiles",
  });
  const assignedProfiles = accessProfilesQuery.data || [];
  const assignedIds = new Set(assignedProfiles.map((p) => p.id));

  const save = useMutation({
    mutationFn: (fields) => updateSourceApp(id, fields),
    onSuccess: (updated) => {
      toast.success("Application saved");
      queryClient.setQueryData(["source-app", id], updated);
      setEditOpen(false);
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const togglePillField = useMutation({
    mutationFn: (fields) => updateSourceApp(id, fields),
    onSuccess: (updated) => queryClient.setQueryData(["source-app", id], updated),
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const remove = useMutation({
    mutationFn: () => deleteSourceApp(id),
    onSuccess: () => {
      toast.success("Application deleted");
      queryClient.invalidateQueries({ queryKey: ["all-source-apps"] });
      queryClient.invalidateQueries({ queryKey: ["source-apps"] });
      navigate(-1);
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const generateDescription = useMutation({
    mutationFn: () => generateSourceAppDescription(id),
    onSuccess: (result) => setSuggestedDescription(result.description),
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const saveGeneratedDescription = useMutation({
    mutationFn: (desc) => updateSourceApp(id, { description: desc }),
    onSuccess: (updated) => {
      toast.success("Description updated");
      queryClient.setQueryData(["source-app", id], updated);
      setSuggestedDescription(null);
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const addProfiles = useMutation({
    mutationFn: (ids) => updateSourceAppAccessProfiles(id, { add: ids }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["source-app-access-profiles", id] });
      setAddProfilesOpen(false);
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const removeProfile = useMutation({
    mutationFn: (profileId) => updateSourceAppAccessProfiles(id, { remove: [profileId] }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["source-app-access-profiles", id] }),
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const appIscTenant = getCredentials()?.tenant;
  const appIscUrl = appIscTenant && data ? `https://${tenantUiHost(appIscTenant)}/ui/apps/${data.id}/config` : null;

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <TopBar
        title="Application"
        onBack={() => navigate(-1)}
        action={
          data && (
            <div className="flex items-center gap-2">
              <IconButton
                icon={Link}
                title="View in Identity Security Cloud"
                onClick={() => appIscUrl && window.open(appIscUrl, "_blank", "noopener,noreferrer")}
                disabled={!appIscUrl}
              />
              {data.enabled ? (
                <IconButton icon={PowerOff} title="Disable" onClick={() => togglePillField.mutate({ enabled: false })} loading={togglePillField.isPending} disabled={togglePillField.isPending || remove.isPending} />
              ) : (
                <IconButton icon={Power} title="Enable" onClick={() => togglePillField.mutate({ enabled: true })} loading={togglePillField.isPending} disabled={togglePillField.isPending || remove.isPending} />
              )}
              {data.appCenterEnabled ? (
                <IconButton icon={EyeOff} title="Hide from request center" onClick={() => togglePillField.mutate({ appCenterEnabled: false })} disabled={togglePillField.isPending || remove.isPending} />
              ) : (
                <IconButton icon={Eye} title="Show in request center" onClick={() => togglePillField.mutate({ appCenterEnabled: true })} disabled={togglePillField.isPending || remove.isPending} />
              )}
              {data.provisionRequestEnabled ? (
                <IconButton icon={XCircle} title="Disallow access requests" onClick={() => togglePillField.mutate({ provisionRequestEnabled: false })} disabled={togglePillField.isPending || remove.isPending} />
              ) : (
                <IconButton icon={CheckCircle2} title="Allow access requests" onClick={() => togglePillField.mutate({ provisionRequestEnabled: true })} disabled={togglePillField.isPending || remove.isPending} />
              )}
              <IconButton
                icon={Wand2}
                title="Generate a new description with AI"
                onClick={() => generateDescription.mutate()}
                loading={generateDescription.isPending}
                disabled={togglePillField.isPending || remove.isPending || generateDescription.isPending}
              />
              <IconButton
                icon={Pencil}
                title="Edit"
                onClick={() => setEditOpen(true)}
                disabled={togglePillField.isPending || remove.isPending}
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
        <div className="px-4 py-4">
          {isLoading && <SkeletonList rows={6} />}
          {error && <ErrorBox message={error.message} />}
          {data && (
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-violet-50 flex items-center justify-center flex-shrink-0">
                <LayoutGrid size={18} className="text-violet-600" />
              </div>
              <div className="min-w-0">
                <h2 className="text-base font-semibold text-gray-900 truncate">{data.name}</h2>
                {data.accountSource?.name && <p className="text-xs text-gray-500">{data.accountSource.name}</p>}
              </div>
            </div>
          )}
        </div>

        {data && (
          <div className="flex border-t border-gray-100">
            <div className="w-24 flex-shrink-0 border-r border-gray-100 py-2">
              {[
                { key: "details", label: "Details", Icon: Info },
                { key: "access-profiles", label: "Access", Icon: ShieldCheck },
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
              {section === "details" && (
                <div className="p-4">
                  {data.description && (
                    <p className="text-sm text-gray-600 leading-relaxed mb-4">{data.description}</p>
                  )}
                  <div className="border border-gray-100 rounded-xl overflow-hidden">
                    <InfoRow label="Owner" value={data.owner?.name} />
                    <InfoRow label="Source" value={data.accountSource?.name} />
                    <InfoRow label="Accounts" value={data.matchAllAccounts ? "All Users" : "Specific Users"} />
                    <InfoRow label="Enabled" value={data.enabled != null ? String(data.enabled) : undefined} />
                    <InfoRow label="Visible" value={data.appCenterEnabled != null ? String(data.appCenterEnabled) : undefined} />
                    <InfoRow label="Requestable" value={data.provisionRequestEnabled != null ? String(data.provisionRequestEnabled) : undefined} />
                    <InfoRow label="Created" value={data.created ? new Date(data.created).toLocaleString() : undefined} />
                    <InfoRow label="Modified" value={data.modified ? new Date(data.modified).toLocaleString() : undefined} />
                    <InfoRow label="Application ID" value={data.id} />
                  </div>
                </div>
              )}

              {section === "access-profiles" && (
                <div>
                  <div className="flex items-center justify-between px-4 pt-4 pb-2">
                    <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                      Access Profiles ({assignedProfiles.length})
                    </span>
                    <IconButton
                      icon={Plus}
                      title="Add Access Profiles"
                      onClick={() => setAddProfilesOpen(true)}
                      className="!w-7 !h-7 !border-emerald-200 !text-emerald-600 hover:!bg-emerald-50"
                    />
                  </div>

                  {accessProfilesQuery.isLoading && (
                    <div className="flex items-center justify-center py-6"><Spinner size={18} /></div>
                  )}
                  {!accessProfilesQuery.isLoading && assignedProfiles.length === 0 && (
                    <EmptyState icon={ShieldCheck} title="No access profiles assigned" subtitle="Use the + icon to add some" />
                  )}
                  {!accessProfilesQuery.isLoading && assignedProfiles.length > 0 && (
                    <div className="border-t border-gray-100">
                      {assignedProfiles.map((p) => (
                        <div
                          key={p.id}
                          className="w-full flex items-center gap-3 px-4 py-3.5 border-b border-gray-100 hover:bg-gray-50 transition-colors"
                        >
                          <button
                            onClick={() => navigate(`/access-profiles/${p.id}`)}
                            className="flex items-center gap-3 flex-1 min-w-0 text-left"
                          >
                            <div className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center flex-shrink-0">
                              <ShieldCheck size={14} className="text-gray-500" />
                            </div>
                            <p className="text-sm font-medium text-gray-900 truncate flex-1">{p.name}</p>
                          </button>
                          <button
                            type="button"
                            title="Remove"
                            onClick={() => removeProfile.mutate(p.id)}
                            disabled={removeProfile.isPending && removeProfile.variables === p.id}
                            className="text-gray-400 hover:text-red-600 disabled:opacity-50 flex-shrink-0"
                          >
                            <Trash2 size={16} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {section === "json" && (
                <RawJsonPanel data={data} resource="source-apps" objectId={id} invalidateKeys={[["source-app", id], ["source-apps"]]} />
              )}
            </div>
          </div>
        )}
      </div>

      {confirmDeleteOpen && (
        <ConfirmModal
          title="Delete this application?"
          message="This permanently deletes the application from this tenant. This cannot be undone."
          confirmLabel="Delete"
          danger
          pending={remove.isPending}
          onConfirm={() => remove.mutate()}
          onCancel={() => setConfirmDeleteOpen(false)}
        />
      )}

      {addProfilesOpen && data && (
        <AddAccessProfilesModal
          sourceId={data.accountSource?.id}
          excludeIds={assignedIds}
          onClose={() => setAddProfilesOpen(false)}
          onAdd={(picked) => addProfiles.mutate(picked.map((p) => p.id))}
          pending={addProfiles.isPending}
        />
      )}

      {editOpen && data && (
        <EditApplicationModal
          app={data}
          searchIdentities={searchIdentities}
          onClose={() => setEditOpen(false)}
          onSave={(fields) => save.mutate(fields)}
          pending={save.isPending}
        />
      )}

      {suggestedDescription != null && data && (
        <GeneratedDescriptionModal
          currentDescription={data.description}
          suggestion={suggestedDescription}
          onClose={() => setSuggestedDescription(null)}
          onSave={(desc) => saveGeneratedDescription.mutate(desc)}
          pending={saveGeneratedDescription.isPending}
        />
      )}
    </div>
  );
}
