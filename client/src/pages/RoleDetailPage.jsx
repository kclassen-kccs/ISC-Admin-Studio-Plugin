import { useState, useMemo } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Layers, Key, ShieldCheck, Boxes, Power, PowerOff, Trash2, Printer, Sparkles, Wand2, Info, ListFilter, Globe, Users, UserPlus,
  ChevronLeft, ChevronRight, ChevronDown, Pencil, Plus, Maximize2, Minimize2, Shapes, Link, Tags, Braces, PieChart, CheckSquare } from "lucide-react";
import toast from "react-hot-toast";
import {
  getRole, listRoleDimensions, sortByName, setRoleEnabled, deleteRole, getCredentials, evaluateRole,
  removeRoleEntitlements, removeDimensionEntitlements, addRoleEntitlements, addDimensionEntitlements,
  updateDimensionEntitlements, getEntitlementsByIds, createRoleDimension, updateRoleEntitlements, getRoleCommonAccess,
  listRoleMembers, listDimensionMembers, listAllRoleMembers, listAllDimensionMembers, getIdentitiesByIds, updateRoleMembers, listIdentities,
  updateRole, generateRoleDescription, enableRoleCommonAccess,
  deleteRoleDimension, searchEntitlements, listIdentityAttributes, updateRoleDimension,
  applyRoleSodMitigation, getTenantSettings, getRoleSegments, getSchemaAnalysis,
} from "../lib/sailpoint";
import { describeMembership, extractSingleAttributeCriterion } from "../lib/roleMembership";
import { printRolePdf } from "../lib/exportRolePdf";
import { useUrlState } from "../hooks/useUrlState";
import { useUrlSearch } from "../hooks/useUrlSearch";
import { TopBar } from "../components/TopBar";
import { EditableMetadataPanel } from "../components/EditableMetadataPanel";
import { RawJsonPanel } from "../components/RawJsonPanel";
import { SegmentsTabPanel } from "../components/SegmentsTabPanel";
import {
  InfoRow, SkeletonList, ErrorBox, SectionLabel, Spinner, IconButton, ConfirmModal, OutlineButton, SearchBar,
  Avatar, EmptyState, PrimaryButton, Field, Input, Textarea, Select, Pager,
} from "../components/ui";
import { EvaluationSheet } from "../components/RoleEvaluationSheet";
import { PickerField } from "../components/PickerField";
import { ApprovalSettingsPanel } from "../components/ApprovalSettingsPanel";
import { AdditionalOwnersField, additionalOwnersState, additionalOwnersValue, additionalOwnersChanged, formatAdditionalOwners } from "../components/AdditionalOwnersField";
import { tenantUiHost } from "../lib/tenantHost";
import RoleCompositionPanel from "../components/RoleCompositionPanel";

const MEMBERS_PAGE_SIZE = 50;

// Search-and-pick modal for adding explicit members to a role with no
// membership rule — used only from the Members tab's Add icon. Excludes
// identities already on the role so re-adding an existing member isn't
// even offered.
function AddMembersModal({ existingIds, onClose, onAdd, pending }) {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [selected, setSelected] = useState(new Map()); // id -> {id,name}

  const handleSearch = (value) => {
    setQuery(value);
    clearTimeout(window.__addMembersSearchTimer);
    window.__addMembersSearchTimer = setTimeout(() => setDebounced(value), 350);
  };

  const resultsQuery = useQuery({
    queryKey: ["identity-search-for-role-members", debounced],
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
        <h2 className="text-base font-semibold text-gray-900 mb-3">Add members</h2>
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
            Add selected ({selected.size})
          </PrimaryButton>
          <OutlineButton onClick={onClose} disabled={pending} className="!w-auto flex-1">Cancel</OutlineButton>
        </div>
      </div>
    </div>
  );
}

// Full role-edit form: name, description, owner (single identity),
// additional owners (several identities OR one governance group — a radio
// choice, not a free mix — see the server route's own validation for why),
// role type (Standard/Dynamic), and Common Access. The Common Access
// checkbox is only interactive when the role has no common-access record
// yet — there's no working API to change an existing one (see
// getRoleCommonAccess/enableRoleCommonAccess), so this is disabled with an
// explanation rather than pretending it works.
function EditRoleModal({ role, commonAccessStatus, onClose, onSave, pending }) {
  const [name, setName] = useState(role.name || "");
  const [description, setDescription] = useState(role.description || "");
  const [owner, setOwner] = useState(role.owner ? [{ id: role.owner.id, name: role.owner.name }] : []);
  const [additional, setAdditional] = useState(() => additionalOwnersState(role.additionalOwners));
  const [dimensional, setDimensional] = useState(!!role.dimensional);
  const [requestable, setRequestable] = useState(!!role.requestable);
  const [enableCommonAccess, setEnableCommonAccess] = useState(false);

  const searchIdentities = async (q) => (await listIdentities({ limit: 15, query: q || undefined })).map((i) => ({ id: i.id, name: i.name }));

  // Requestable only makes sense on a role nobody already gets
  // automatically — a Dynamic role or one with a membership rule is
  // assigned by ISC itself. Membership isn't editable from this form, so
  // this checks the role's original (unchangeable-here) membership state,
  // but Dynamic/Standard tracks the live form selection above.
  const requestableEditable = !dimensional && !role.membership?.criteria;

  const commonAccessAlreadySet = commonAccessStatus !== null && commonAccessStatus !== undefined;

  function handleSave() {
    const fields = {};
    if (name !== role.name) fields.name = name;
    if (description !== (role.description || "")) fields.description = description;
    if (owner[0] && owner[0].id !== role.owner?.id) fields.owner = owner[0];
    const nextAdditionalOwners = additionalOwnersValue(additional);
    if (additionalOwnersChanged(nextAdditionalOwners, role.additionalOwners)) fields.additionalOwners = nextAdditionalOwners;
    if (dimensional !== !!role.dimensional) fields.dimensional = dimensional;
    if (requestableEditable && requestable !== !!role.requestable) fields.requestable = requestable;
    onSave({ fields, enableCommonAccess });
  }

  return (
    <div
      className="fixed inset-0 bg-black/30 z-30 flex items-end md:items-center justify-center"
      onClick={(e) => e.target === e.currentTarget && !pending && onClose()}
    >
      <div className="bg-white w-full max-w-lg md:mx-4 rounded-t-2xl md:rounded-2xl shadow-xl p-5 max-h-[85vh] overflow-y-auto">
        <h2 className="text-base font-semibold text-gray-900 mb-4">Edit role</h2>

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

        <AdditionalOwnersField value={additional} onChange={setAdditional} />

        <Field label="Role type">
          <div className="flex gap-4">
            <label className="flex items-center gap-1.5 text-sm text-gray-700 cursor-pointer">
              <input type="radio" checked={!dimensional} onChange={() => setDimensional(false)} className="accent-blue-600" />
              Standard
            </label>
            <label className="flex items-center gap-1.5 text-sm text-gray-700 cursor-pointer">
              <input type="radio" checked={dimensional} onChange={() => setDimensional(true)} className="accent-blue-600" />
              Dynamic
            </label>
          </div>
          {dimensional !== !!role.dimensional && (
            <p className="text-xs text-amber-600 mt-1.5">
              {dimensional
                ? "Switching to Dynamic doesn't create any dimensions — add those afterward."
                : "Switching to Standard doesn't delete existing dimensions from ISC, but this app will stop showing/using them."}
            </p>
          )}
        </Field>

        <Field label="Requestable">
          <label className={`flex items-center gap-2 ${requestableEditable ? "cursor-pointer" : "opacity-50"}`}>
            <input
              type="checkbox"
              checked={requestable}
              onChange={(e) => requestableEditable && setRequestable(e.target.checked)}
              disabled={!requestableEditable}
              className="w-4 h-4 rounded border-gray-300 accent-blue-600"
            />
            <span className="text-sm text-gray-700">Requestable</span>
          </label>
          {!requestableEditable && (
            <p className="text-xs text-gray-400 mt-1.5">
              Only a Standard role with no membership rule can be made requestable — this one is
              {dimensional ? " Dynamic" : " assigned by a membership rule"}, so ISC already decides who gets it.
            </p>
          )}
        </Field>

        <Field label="Common access">
          <label className={`flex items-center gap-2 ${commonAccessAlreadySet ? "opacity-50" : "cursor-pointer"}`}>
            <input
              type="checkbox"
              checked={commonAccessAlreadySet ? commonAccessStatus === "CONFIRMED" : enableCommonAccess}
              onChange={(e) => !commonAccessAlreadySet && setEnableCommonAccess(e.target.checked)}
              disabled={commonAccessAlreadySet}
              className="w-4 h-4 rounded border-gray-300 accent-blue-600"
            />
            <span className="text-sm text-gray-700">Flag as common access</span>
          </label>
          {commonAccessAlreadySet && (
            <p className="text-xs text-gray-400 mt-1.5">
              This role already has a common-access record (status: {commonAccessStatus}) — change it in ISC's own UI
              (Admin &gt; Access Model &gt; Roles &gt; Common Access), there's no API to update an existing one.
            </p>
          )}
        </Field>

        <div className="flex gap-2 mt-2">
          <PrimaryButton onClick={handleSave} loading={pending} className="!w-auto flex-1">Save</PrimaryButton>
          <OutlineButton onClick={onClose} disabled={pending} className="!w-auto flex-1">Cancel</OutlineButton>
        </div>
      </div>
    </div>
  );
}

// Search-and-pick modal for adding entitlements to an existing dimension —
// same shape as AddMembersModal, just searching entitlements instead of
// identities.
function AddEntitlementsModal({ existingIds, onClose, onAdd, pending }) {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [selected, setSelected] = useState(new Map()); // id -> {id,name}

  const handleSearch = (value) => {
    setQuery(value);
    clearTimeout(window.__addEntitlementsSearchTimer);
    window.__addEntitlementsSearchTimer = setTimeout(() => setDebounced(value), 350);
  };

  const resultsQuery = useQuery({
    queryKey: ["entitlement-search-for-dimension", debounced],
    queryFn: () => searchEntitlements({ limit: 25, query: debounced || undefined }),
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
        <h2 className="text-base font-semibold text-gray-900 mb-3">Add entitlements</h2>
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
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-gray-900 truncate">{ent.name}</p>
                {ent.source?.name && <p className="text-xs text-gray-400 truncate">{ent.source.name}</p>}
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
            <Plus size={16} />
            Add selected ({selected.size})
          </PrimaryButton>
          <OutlineButton onClick={onClose} disabled={pending} className="!w-auto flex-1">Cancel</OutlineButton>
        </div>
      </div>
    </div>
  );
}

// Free-form "add a dimension" form — name, the identity attribute this
// dimension splits on (e.g. "jobTitle"), the value that attribute must
// equal, and an optional set of entitlements granted by it. Mirrors what
// createRoleDimensionOnServer builds server-side (a STANDARD membership
// rule with one EQUALS criterion), just entered by hand instead of derived
// from a Role Evaluation "missing dimension" suggestion.
function CreateDimensionModal({ onClose, onCreate, pending }) {
  const [name, setName] = useState("");
  const [attrKey, setAttrKey] = useState("");
  const [value, setValue] = useState("");
  const [entitlements, setEntitlements] = useState([]);

  const attributesQuery = useQuery({
    queryKey: ["identity-attributes"],
    queryFn: listIdentityAttributes,
  });
  const attributes = sortByName((attributesQuery.data || []).map((a) => ({ id: a.name, name: a.displayName || a.name })));

  const searchEnts = async (q) => (await searchEntitlements({ limit: 15, query: q || undefined })).map((e) => ({ id: e.id, name: e.name }));

  const canCreate = name.trim() && attrKey.trim() && value.trim();

  return (
    <div
      className="fixed inset-0 bg-black/30 z-30 flex items-end md:items-center justify-center"
      onClick={(e) => e.target === e.currentTarget && !pending && onClose()}
    >
      <div className="bg-white w-full max-w-lg md:mx-4 rounded-t-2xl md:rounded-2xl shadow-xl p-5 max-h-[85vh] overflow-y-auto">
        <h2 className="text-base font-semibold text-gray-900 mb-4">Add dimension</h2>

        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Tax Accountant" />
        </Field>
        <Field label="Identity attribute">
          {attributesQuery.isLoading ? (
            <div className="flex items-center gap-2 text-xs text-gray-400 py-2">
              <Spinner size={14} /> Loading attributes…
            </div>
          ) : attributesQuery.error ? (
            <Input value={attrKey} onChange={(e) => setAttrKey(e.target.value)} placeholder="e.g. jobTitle" />
          ) : (
            <Select value={attrKey} onChange={(e) => setAttrKey(e.target.value)}>
              <option value="">Select an attribute…</option>
              {attributes.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Value">
          <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder="e.g. Tax Accountant" />
        </Field>
        <p className="text-xs text-gray-400 -mt-2 mb-4">
          Members of this dimension are identities where attribute.{attrKey || "…"} equals "{value || "…"}".
        </p>

        <PickerField
          label="Entitlements (optional)"
          placeholder="Search entitlements…"
          searchFn={searchEnts}
          multi={true}
          selected={entitlements}
          onChange={setEntitlements}
        />

        <div className="flex gap-2 mt-2">
          <PrimaryButton
            onClick={() => onCreate({ name: name.trim(), attrKey: attrKey.trim(), value: value.trim(), entitlements })}
            loading={pending}
            disabled={!canCreate}
            className="!w-auto flex-1"
          >
            <Plus size={16} />
            Create dimension
          </PrimaryButton>
          <OutlineButton onClick={onClose} disabled={pending} className="!w-auto flex-1">Cancel</OutlineButton>
        </div>
      </div>
    </div>
  );
}

// Rename a dimension and/or redefine its membership rule as a single
// identity-attribute EQUALS check (same shape CreateDimensionModal builds).
// If the dimension's existing rule is anything more complex than that
// (multiple conditions, OR, non-EQUALS), the rule fields are disabled —
// this form can't safely represent it, so only the name stays editable
// rather than silently replacing a rule it can't fully parse.
function EditDimensionModal({ dimension, onClose, onSave, pending }) {
  const parsed = extractSingleAttributeCriterion(dimension.membership?.criteria);
  const [name, setName] = useState(dimension.name || "");
  const [attrKey, setAttrKey] = useState(parsed?.attrKey || "");
  const [value, setValue] = useState(parsed?.value || "");
  const ruleEditable = !dimension.membership?.criteria || !!parsed;

  const attributesQuery = useQuery({
    queryKey: ["identity-attributes"],
    queryFn: listIdentityAttributes,
  });
  const attributes = sortByName((attributesQuery.data || []).map((a) => ({ id: a.name, name: a.displayName || a.name })));

  const nameChanged = name.trim() !== (dimension.name || "");
  const ruleChanged = ruleEditable && (attrKey !== (parsed?.attrKey || "") || value !== (parsed?.value || ""));
  const canSave = name.trim() && (!ruleEditable || (attrKey.trim() && value.trim())) && (nameChanged || ruleChanged);

  return (
    <div
      className="fixed inset-0 bg-black/30 z-30 flex items-end md:items-center justify-center"
      onClick={(e) => e.target === e.currentTarget && !pending && onClose()}
    >
      <div className="bg-white w-full max-w-lg md:mx-4 rounded-t-2xl md:rounded-2xl shadow-xl p-5 max-h-[85vh] overflow-y-auto">
        <h2 className="text-base font-semibold text-gray-900 mb-4">Edit dimension</h2>

        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>

        <Field label="Identity attribute">
          {!ruleEditable ? (
            <p className="text-xs text-gray-400">
              This dimension's membership rule is more complex than a single attribute check, so it can't be edited here — only the name above.
            </p>
          ) : attributesQuery.isLoading ? (
            <div className="flex items-center gap-2 text-xs text-gray-400 py-2">
              <Spinner size={14} /> Loading attributes…
            </div>
          ) : attributesQuery.error ? (
            <Input value={attrKey} onChange={(e) => setAttrKey(e.target.value)} placeholder="e.g. jobTitle" />
          ) : (
            <Select value={attrKey} onChange={(e) => setAttrKey(e.target.value)}>
              <option value="">Select an attribute…</option>
              {attributes.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </Select>
          )}
        </Field>

        {ruleEditable && (
          <Field label="Value">
            <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder="e.g. Tax Accountant" />
          </Field>
        )}

        <div className="flex gap-2 mt-2">
          <PrimaryButton
            onClick={() => {
              const fields = {};
              if (nameChanged) fields.name = name.trim();
              if (ruleChanged) {
                fields.attrKey = attrKey.trim();
                fields.value = value.trim();
              }
              onSave(fields);
            }}
            loading={pending}
            disabled={!canSave}
            className="!w-auto flex-1"
          >
            Save
          </PrimaryButton>
          <OutlineButton onClick={onClose} disabled={pending} className="!w-auto flex-1">Cancel</OutlineButton>
        </div>
      </div>
    </div>
  );
}

function MembershipRule({ membership }) {
  return (
    <div className="bg-gray-50 border border-gray-100 rounded-xl px-3 py-2.5">
      <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1">Membership rule</p>
      <p className="text-sm text-gray-700">{describeMembership(membership)}</p>
    </div>
  );
}

const DIMENSION_MEMBERS_PAGE_SIZE = 10;

// Read-only members list for one dimension — only fetched while that
// dimension is expanded (queries are enabled-gated), since evaluating a
// membership rule live against every active identity isn't free. Search
// and paging both work the same as the role-level Members tab, just
// scoped to this one dimension's own (base role ∩ dimension) population.
function DimensionMembers({ roleId, dimensionId, expanded }) {
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const debouncedSearch = search; // short list, no need to debounce a network round-trip separately

  const membersQuery = useQuery({
    queryKey: ["dimension-members", roleId, dimensionId, debouncedSearch, offset],
    queryFn: () => listDimensionMembers(roleId, dimensionId, { limit: DIMENSION_MEMBERS_PAGE_SIZE, offset, query: debouncedSearch || undefined }),
    enabled: expanded,
    keepPreviousData: true,
  });
  const members = membersQuery.data?.members || [];
  const total = membersQuery.data?.total ?? 0;
  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = Math.min(offset + members.length, total);

  return (
    <div className="bg-gray-50 border border-gray-100 rounded-xl px-3 py-2.5">
      <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">Members</p>
      <input
        value={search}
        onChange={(e) => { setSearch(e.target.value); setOffset(0); }}
        placeholder="Search members by name…"
        className="w-full text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 mb-2 outline-none focus:border-blue-400"
      />
      {membersQuery.isLoading && (
        <div className="flex items-center justify-center py-4">
          <Spinner size={16} />
        </div>
      )}
      {membersQuery.error && <p className="text-xs text-red-600">{membersQuery.error.message}</p>}
      {!membersQuery.isLoading && !membersQuery.error && members.length === 0 && (
        <p className="text-xs text-gray-400">
          {debouncedSearch ? `No members match "${debouncedSearch}"` : "No identities currently match this dimension"}
        </p>
      )}
      {total > 0 && <Pager compact offset={offset} pageSize={DIMENSION_MEMBERS_PAGE_SIZE} total={total} noun="member" onOffsetChange={setOffset} hasNext={offset + members.length < total} busy={membersQuery.isFetching} />}
      {members.map((m) => (
        <div key={m.id} className="flex items-center justify-between gap-2 py-1">
          <div className="min-w-0">
            <p className="text-sm text-gray-800 truncate">{m.displayName || m.name}</p>
            {(m.attributes?.jobTitle || m.attributes?.department) && (
              <p className="text-xs text-gray-400 truncate">
                {[m.attributes?.jobTitle, m.attributes?.department].filter(Boolean).join(" · ")}
              </p>
            )}
          </div>
        </div>
      ))}
      {total > 0 && (
        <Pager compact className="pt-2 mt-1 border-t border-gray-200" offset={offset} pageSize={DIMENSION_MEMBERS_PAGE_SIZE} total={total} noun="member" onOffsetChange={setOffset} hasNext={offset + members.length < total} busy={membersQuery.isFetching} />
      )}
    </div>
  );
}

// Header for a selectable entitlement list: a select-all checkbox next to
// the section label, and a "Delete selected" icon that only appears once
// something is actually selected.
function EntitlementsSectionHeader({ label, count, allSelected, onToggleAll, selectedCount, onDeleteSelected, deletePending, onAdd }) {
  return (
    <div className="flex items-center justify-between px-4 pt-5 pb-2">
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={allSelected}
          onChange={onToggleAll}
          className="w-4 h-4 rounded border-gray-300 accent-blue-600"
        />
        <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
          {label} ({count})
        </span>
      </label>
      <div className="flex items-center gap-1.5">
        {selectedCount > 0 && (
          <IconButton
            icon={Trash2}
            title={`Delete selected (${selectedCount})`}
            onClick={onDeleteSelected}
            loading={deletePending}
            className="!w-7 !h-7 !border-red-200 !text-red-600 hover:!bg-red-50"
          />
        )}
        {onAdd && (
          <IconButton
            icon={Plus}
            title="Add entitlements"
            onClick={onAdd}
            className="!w-7 !h-7 !border-emerald-200 !text-emerald-600 hover:!bg-emerald-50"
          />
        )}
      </div>
    </div>
  );
}

// Shows Claude's suggested description alongside the role's current one —
// editable before saving (pre-filled with the suggestion, so a close-but-
// not-quite result doesn't have to be regenerated from scratch) and never
// applies anything until the user explicitly confirms.
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

export default function RoleDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [evaluation, setEvaluation] = useState(null);
  const [selectedEntitlements, setSelectedEntitlements] = useState(new Set());
  const [selectedDimEntitlements, setSelectedDimEntitlements] = useState({});
  const [pendingRemoval, setPendingRemoval] = useState(null); // { type: "role" } | { type: "dimension", dimensionId, dimensionName }
  // URL-backed (not useState) so both the active tab and the in-tab search
  // survive navigating to an entitlement/member/dimension's own detail
  // page and clicking Back — that unmounts this page, and plain useState
  // would silently reset both to their defaults on remount.
  const [section, setSection] = useUrlState("tab", "details");
  const [entitlementSearch, setEntitlementSearch] = useUrlState("eq", "");
  const { search: memberSearch, debouncedSearch: debouncedMemberSearch, handleSearch: handleUrlMemberSearch } = useUrlSearch("mq");
  const [memberOffset, setMemberOffset] = useState(0);
  const [printing, setPrinting] = useState(false);
  const [selectedMembers, setSelectedMembers] = useState(new Set());
  const [pendingMemberRemoval, setPendingMemberRemoval] = useState(false);
  const [addMembersOpen, setAddMembersOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [createDimensionOpen, setCreateDimensionOpen] = useState(false);
  const [addEntsToDimension, setAddEntsToDimension] = useState(null); // dimensionId | null
  const [addEntsOpen, setAddEntsOpen] = useState(false);
  const [pendingDimensionDeletion, setPendingDimensionDeletion] = useState(null); // { id, name } | null
  const [editDimension, setEditDimension] = useState(null); // dimension object | null
  const [suggestedDescription, setSuggestedDescription] = useState(null); // string | null
  // Collapsed by default — each dimension's Membership Rule/Members/
  // Entitlements only render (and only fetch Members) once expanded.
  const [expandedDimensionIds, setExpandedDimensionIds] = useState(() => new Set());

  const handleMemberSearch = (value) => {
    handleUrlMemberSearch(value);
    setMemberOffset(0);
  };

  const { data, isLoading, error } = useQuery({
    queryKey: ["role", id],
    queryFn: () => getRole(id),
  });

  const { data: evalSettings } = useQuery({
    queryKey: ["tenant-settings"],
    queryFn: getTenantSettings,
  });

  // Same gate Nav.jsx uses for the Data Segments feature itself — no point
  // showing a Segments tab (or spending the fetchAllDataSegments call
  // behind it) on a tenant that doesn't use segments at all.
  const { data: schemaAnalysis } = useQuery({
    queryKey: ["schema-analysis"],
    queryFn: getSchemaAnalysis,
    staleTime: 5 * 60 * 1000,
  });

  const dimensionsQuery = useQuery({
    queryKey: ["role-dimensions", id],
    queryFn: () => listRoleDimensions(id),
    enabled: !!data?.dimensional,
  });

  const commonAccessQuery = useQuery({
    queryKey: ["role-common-access", id],
    queryFn: () => getRoleCommonAccess(id),
    enabled: !!data,
  });

  // Same POST /api/roles/:id/common-access the Edit Role modal's checkbox
  // already used (see EditRoleModal below), just as a standalone toolbar
  // action for a role that's already created — no need to reopen Edit just
  // to flag it. Only shown once commonAccessQuery confirms it isn't already
  // set (see the IconButton below), since there's no API to change an
  // existing record — a 409 there means it has to be done in ISC's own UI.
  const flagCommonAccess = useMutation({
    mutationFn: () => enableRoleCommonAccess(id),
    onSuccess: () => {
      toast.success(`"${data?.name}" flagged as Common Access`);
      queryClient.invalidateQueries({ queryKey: ["role-common-access", id] });
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  // commonAccessQuery hits the same /common-access/v1 endpoint that's been
  // 401ing for this tenant (a missing OAuth scope, not a code bug — see
  // POST /api/roles/:id/common-access's own 401 handling), so its error
  // state is the common case, not the exception — gating the name fallback
  // on commonAccessQuery.error specifically turned out to be unreliable in
  // practice (still hidden even for a name match — likely react-query's
  // isLoading/retry window, or an error that isn't populating the way this
  // assumed). Simplified to a more robust rule: a name containing "Common
  // Access" is eligible UNLESS the check has POSITIVELY confirmed true
  // (already flagged — nothing to do) — the name is now the primary
  // signal, not just a fallback for a specific error state that's hard to
  // depend on.
  const nameSignalsCommonAccess = /common access/i.test(data?.name || "");
  const commonAccessFlagEligible =
    commonAccessQuery.data?.commonAccess !== true &&
    (commonAccessQuery.data?.commonAccess === false || nameSignalsCommonAccess);

  // A role with a membership rule has its members computed automatically —
  // shown read-only (paginated, searchable) via the same Search API pattern
  // used for entitlement members. A role with no rule stores its members as
  // a bare id list (membership.identities), which this instead resolves to
  // full identity rows and renders as an editable select/delete/add list.
  const hasMembershipRule = !!data?.membership?.criteria;
  const membersQuery = useQuery({
    queryKey: ["role-members", id, debouncedMemberSearch, memberOffset],
    queryFn: () => listRoleMembers(id, { limit: MEMBERS_PAGE_SIZE, offset: memberOffset, query: debouncedMemberSearch || undefined }),
    enabled: section === "members" && hasMembershipRule,
    keepPreviousData: true,
  });
  const members = membersQuery.data?.members || [];
  const totalMembers = membersQuery.data?.total ?? 0;
  const memberPageStart = totalMembers === 0 ? 0 : memberOffset + 1;
  const memberPageEnd = Math.min(memberOffset + members.length, totalMembers);

  const memberIdentityIds = useMemo(
    () => (data?.membership?.identities || []).map((i) => i.id),
    [data?.membership?.identities]
  );
  const memberIdentitiesQuery = useQuery({
    queryKey: ["role-member-identities", id, memberIdentityIds],
    queryFn: () => getIdentitiesByIds(memberIdentityIds),
    enabled: section === "members" && !hasMembershipRule && memberIdentityIds.length > 0,
  });
  const memberIdentities = sortByName(memberIdentitiesQuery.data);

  const generateDescription = useMutation({
    mutationFn: () => generateRoleDescription(id),
    onSuccess: (result) => setSuggestedDescription(result.description),
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const saveGeneratedDescription = useMutation({
    mutationFn: (description) => updateRole(id, { description }),
    onSuccess: (updatedRole) => {
      toast.success("Description updated");
      queryClient.setQueryData(["role", id], updatedRole);
      setSuggestedDescription(null);
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const editRole = useMutation({
    mutationFn: async ({ fields, enableCommonAccess }) => {
      const tasks = [];
      if (Object.keys(fields).length > 0) tasks.push(updateRole(id, fields));
      if (enableCommonAccess) tasks.push(enableRoleCommonAccess(id));
      const results = await Promise.all(tasks);
      // updateRole's result (the updated role) is whichever task ran first —
      // enableRoleCommonAccess's response isn't a role object, so only trust
      // the first result when fields were actually sent.
      return Object.keys(fields).length > 0 ? results[0] : null;
    },
    onSuccess: (updatedRole) => {
      toast.success("Role updated");
      if (updatedRole) queryClient.setQueryData(["role", id], updatedRole);
      else queryClient.invalidateQueries({ queryKey: ["role", id] });
      queryClient.invalidateQueries({ queryKey: ["role-common-access", id] });
      setEditOpen(false);
    },
    onError: (err) => {
      // Name/description/owner and the common-access flag are separate API
      // calls run in parallel — if one succeeds and the other 409s, the
      // successful half already landed server-side, so refetch rather than
      // leaving stale cached data even though this mutation "failed" overall.
      queryClient.invalidateQueries({ queryKey: ["role", id] });
      queryClient.invalidateQueries({ queryKey: ["role-common-access", id] });
      toast.error(err.response?.data?.error || err.message);
    },
  });

  const addMembers = useMutation({
    mutationFn: (identities) => updateRoleMembers(id, { add: identities }),
    onSuccess: (updatedRole) => {
      toast.success("Members added");
      queryClient.setQueryData(["role", id], updatedRole);
      setAddMembersOpen(false);
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const removeMembers = useMutation({
    mutationFn: (ids) => updateRoleMembers(id, { remove: ids }),
    onSuccess: (updatedRole) => {
      toast.success("Members removed");
      queryClient.setQueryData(["role", id], updatedRole);
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
      memberIdentities.length > 0 && prev.size === memberIdentities.length
        ? new Set()
        : new Set(memberIdentities.map((m) => m.id))
    );
  };

  const dimensions = sortByName(dimensionsQuery.data);
  const allDimensionsExpanded = dimensions.length > 0 && dimensions.every((d) => expandedDimensionIds.has(d.id));
  function toggleDimensionExpanded(dimensionId) {
    setExpandedDimensionIds((prev) => {
      const next = new Set(prev);
      if (next.has(dimensionId)) next.delete(dimensionId);
      else next.add(dimensionId);
      return next;
    });
  }
  function toggleAllDimensionsExpanded() {
    setExpandedDimensionIds(allDimensionsExpanded ? new Set() : new Set(dimensions.map((d) => d.id)));
  }

  const entitlements = sortByName(data?.entitlements);
  const accessProfiles = sortByName(data?.accessProfiles);
  const visibleEntitlements = entitlementSearch
    ? entitlements.filter((e) => (e.name || "").toLowerCase().includes(entitlementSearch.toLowerCase()))
    : entitlements;

  // Different sources can have entitlements with the same short name (e.g.
  // an Active Directory group and an Entra ID group both called
  // "DataArchive") — those render as visually-identical rows unless we show
  // which source each one is from, so bulk-fetch full entitlement details
  // (source included) for everything referenced by this role or its
  // dimensions and look up source name by id when rendering.
  const allEntitlementIds = useMemo(() => {
    const ids = new Set(entitlements.map((e) => e.id));
    for (const d of dimensions) {
      for (const e of d.entitlements || []) ids.add(e.id);
    }
    return Array.from(ids).sort();
  }, [entitlements, dimensions]);

  const entitlementDetailsQuery = useQuery({
    queryKey: ["role-entitlement-sources", id, allEntitlementIds],
    queryFn: () => getEntitlementsByIds(allEntitlementIds),
    enabled: allEntitlementIds.length > 0,
  });
  const entitlementSourceById = useMemo(() => {
    const map = {};
    for (const e of entitlementDetailsQuery.data || []) map[e.id] = e.source?.name;
    return map;
  }, [entitlementDetailsQuery.data]);

  const toggleEnabled = useMutation({
    mutationFn: (enabled) => setRoleEnabled(id, enabled),
    // setRoleEnabled already returns the updated role from ISC's PATCH
    // response — write it straight into the cache instead of just
    // invalidating, so the view flips immediately rather than waiting on a
    // refetch round trip.
    onSuccess: (updatedRole, enabled) => {
      toast.success(enabled ? "Role enabled" : "Role disabled");
      queryClient.setQueryData(["role", id], updatedRole);
      queryClient.invalidateQueries({ queryKey: ["roles"] });
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const remove = useMutation({
    mutationFn: () => deleteRole(id),
    onSuccess: () => {
      toast.success("Role deleted");
      queryClient.invalidateQueries({ queryKey: ["roles"] });
      // Back in history rather than a hardcoded "/roles" — this page is
      // reached from both Browse's /roles and Role Mining's /role-mining/roles,
      // and a hardcoded path would land on the wrong one's list, flipping
      // the sidebar to the wrong section.
      navigate(-1);
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  // "Evaluate" runs immediately. It used to open a picker for which Common
  // Access roles to consider; now no list is sent, and the server works out
  // the ones that apply from the membership rules — a Common Access role
  // counts when its criteria are a subset of this role's, respecting the
  // boundary attributes (filterApplicableCommonAccessEntIds). That's the
  // same answer the picker pre-selected, without the prompt.
  const evaluate = useMutation({
    mutationFn: () => evaluateRole(id),
    onSuccess: (result) => setEvaluation(result),
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const removeEntitlements = useMutation({
    mutationFn: (ids) => removeRoleEntitlements(id, ids),
    onSuccess: (updatedRole) => {
      toast.success("Entitlements removed");
      queryClient.setQueryData(["role", id], updatedRole);
      setSelectedEntitlements(new Set());
      setPendingRemoval(null);
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const addEntitlements = useMutation({
    mutationFn: (entitlements) => addRoleEntitlements(id, entitlements),
    onSuccess: (updatedRole, entitlements) => {
      toast.success("Entitlements added");
      queryClient.setQueryData(["role", id], updatedRole);
      // Drop the just-added items from the open evaluation results so the
      // sheet reflects the role's new state without needing a re-evaluate.
      const addedIds = new Set(entitlements.map((e) => e.id));
      setEvaluation((prev) =>
        prev ? { ...prev, addCandidates: (prev.addCandidates || []).filter((c) => !addedIds.has(c.entitlementId)) } : prev
      );
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const addDimEntitlements = useMutation({
    mutationFn: ({ dimensionId, entitlements }) => addDimensionEntitlements(id, dimensionId, entitlements),
    onSuccess: (_updatedDimension, { dimensionId, entitlements }) => {
      toast.success("Entitlements added");
      queryClient.invalidateQueries({ queryKey: ["role-dimensions", id] });
      const addedIds = new Set(entitlements.map((e) => e.id));
      setEvaluation((prev) =>
        prev
          ? {
              ...prev,
              dimensionEvaluations: (prev.dimensionEvaluations || []).map((d) =>
                d.dimensionId === dimensionId
                  ? { ...d, addCandidates: d.addCandidates.filter((c) => !addedIds.has(c.entitlementId)) }
                  : d
              ),
            }
          : prev
      );
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  // Free-form "Add dimension" from the Dimensions tab itself — distinct
  // from `createDimension` below, which is wired to the Role Evaluation
  // sheet's "missing dimension" suggestions and expects that shape.
  const createDimensionManual = useMutation({
    mutationFn: ({ name, attrKey, value, entitlements }) => createRoleDimension(id, { name, attrKey, value, entitlements }),
    onSuccess: (_newDimension, { name }) => {
      toast.success(`Dimension "${name}" created`);
      queryClient.invalidateQueries({ queryKey: ["role-dimensions", id] });
      setCreateDimensionOpen(false);
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const deleteDimension = useMutation({
    mutationFn: (dimensionId) => deleteRoleDimension(id, dimensionId),
    onSuccess: (_result, dimensionId) => {
      toast.success("Dimension deleted");
      queryClient.invalidateQueries({ queryKey: ["role-dimensions", id] });
      setSelectedDimEntitlements((prev) => {
        const next = { ...prev };
        delete next[dimensionId];
        return next;
      });
      setPendingDimensionDeletion(null);
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const updateDimension = useMutation({
    mutationFn: (fields) => updateRoleDimension(id, editDimension.id, fields),
    onSuccess: () => {
      toast.success("Dimension updated");
      queryClient.invalidateQueries({ queryKey: ["role-dimensions", id] });
      setEditDimension(null);
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const createDimension = useMutation({
    mutationFn: ({ md, entitlements }) =>
      createRoleDimension(id, {
        name: md.value,
        attrKey: md.attrKey,
        value: md.value,
        entitlements,
      }),
    onSuccess: (_newDimension, { md }) => {
      toast.success(`Dimension "${md.value}" created`);
      queryClient.invalidateQueries({ queryKey: ["role-dimensions", id] });
      setEvaluation((prev) =>
        prev
          ? { ...prev, missingDimensions: (prev.missingDimensions || []).filter((d) => d.value !== md.value) }
          : prev
      );
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const acceptAll = useMutation({
    mutationFn: async (result) => {
      const removeIds = (result.removeCandidates || []).map((c) => c.entitlementId).filter(Boolean);
      const addEnts = (result.addCandidates || []).map((c) => ({ id: c.entitlementId, name: c.entitlement }));
      const tasks = [];
      // One combined call for the base role, not two separate ones — two
      // independent PATCH replaces against the same /entitlements array
      // would race and could clobber each other.
      if (removeIds.length || addEnts.length) {
        tasks.push(updateRoleEntitlements(id, { add: addEnts, remove: removeIds }));
      }
      for (const d of result.dimensionEvaluations || []) {
        const dimAddEnts = (d.addCandidates || []).map((c) => ({ id: c.entitlementId, name: c.entitlement }));
        const dimRemoveIds = (d.removeCandidates || []).map((c) => c.entitlementId).filter(Boolean);
        // Combined call, same race-avoidance reasoning as the base role
        // above — this dimension's add and remove candidates both replace
        // the same /entitlements array, so they have to go in one PATCH.
        if (dimAddEnts.length > 0 || dimRemoveIds.length > 0) {
          tasks.push(updateDimensionEntitlements(id, d.dimensionId, { add: dimAddEnts, remove: dimRemoveIds }));
        }
      }
      for (const md of result.missingDimensions || []) {
        tasks.push(
          createRoleDimension(id, {
            name: md.value,
            attrKey: md.attrKey,
            value: md.value,
            entitlements: md.addCandidates.map((c) => ({ id: c.entitlementId, name: c.entitlement })),
          })
        );
      }
      await Promise.all(tasks);
    },
    onSuccess: () => {
      toast.success("All suggestions applied");
      queryClient.invalidateQueries({ queryKey: ["role", id] });
      queryClient.invalidateQueries({ queryKey: ["role-dimensions", id] });
      setEvaluation(null);
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  // Repair Role: removes whichever conflicting entitlements the user picked
  // (grouped by where they actually live — base role vs. a specific
  // dimension, since that determines which PATCH endpoint applies), then
  // re-evaluates the role so the sheet immediately reflects whether the
  // violation is actually gone, rather than trusting the removal alone.
  const repairSod = useMutation({
    mutationFn: async (items) => {
      const baseIds = items.filter((it) => it.origin.type === "base").map((it) => it.id);
      const byDimension = new Map();
      for (const it of items) {
        if (it.origin.type !== "dimension") continue;
        if (!byDimension.has(it.origin.dimensionId)) byDimension.set(it.origin.dimensionId, []);
        byDimension.get(it.origin.dimensionId).push(it.id);
      }
      const tasks = [];
      if (baseIds.length) tasks.push(removeRoleEntitlements(id, baseIds));
      for (const [dimensionId, ids] of byDimension) tasks.push(removeDimensionEntitlements(id, dimensionId, ids));
      await Promise.all(tasks);
      return evaluateRole(id);
    },
    onSuccess: (newEvaluation) => {
      queryClient.invalidateQueries({ queryKey: ["role", id] });
      queryClient.invalidateQueries({ queryKey: ["role-dimensions", id] });
      setEvaluation(newEvaluation);
      const stillViolating = (newEvaluation.sodViolations?.length || 0) > 0 ||
        (newEvaluation.dimensionEvaluations || []).some((d) => (d.sodViolations || []).length > 0);
      if (stillViolating) {
        toast.error("Entitlements removed, but an SOD violation still remains");
      } else {
        toast.success("Role repaired — no SOD violations remain");
      }
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  // Mitigate: no removal, just records a time-limited exception server-side
  // and re-evaluates — the violation drops out of the active list and shows
  // as "Mitigated Violation Present" instead.
  const mitigateSod = useMutation({
    mutationFn: ({ items, expiresAt }) => applyRoleSodMitigation(id, { items, expiresAt, roleName: data?.name }),
    onSuccess: (newEvaluation) => {
      setEvaluation(newEvaluation);
      toast.success("Mitigation applied");
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  // Removing a stale dimension straight from the evaluation sheet — same
  // deleteRoleDimension call as the Dimensions tab's own delete, just
  // dropping the removed one from the open evaluation locally instead of
  // requiring a re-evaluate to see it gone.
  const removeStaleDimension = useMutation({
    mutationFn: (sd) => deleteRoleDimension(id, sd.dimensionId),
    onSuccess: (_result, sd) => {
      toast.success("Dimension removed");
      queryClient.invalidateQueries({ queryKey: ["role-dimensions", id] });
      setEvaluation((prev) =>
        prev ? { ...prev, staleDimensions: (prev.staleDimensions || []).filter((d) => d.dimensionId !== sd.dimensionId) } : prev
      );
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const removeDimEntitlements = useMutation({
    mutationFn: ({ dimensionId, ids }) => removeDimensionEntitlements(id, dimensionId, ids),
    onSuccess: (_updatedDimension, variables) => {
      toast.success("Entitlements removed");
      queryClient.invalidateQueries({ queryKey: ["role-dimensions", id] });
      setSelectedDimEntitlements((prev) => {
        const next = { ...prev };
        delete next[variables.dimensionId];
        return next;
      });
      setPendingRemoval(null);
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
      visibleEntitlements.length > 0 && prev.size === visibleEntitlements.length
        ? new Set()
        : new Set(visibleEntitlements.map((e) => e.id))
    );
  };

  const toggleDimEntitlement = (dimId, entId) => {
    setSelectedDimEntitlements((prev) => {
      const set = new Set(prev[dimId] || []);
      if (set.has(entId)) set.delete(entId);
      else set.add(entId);
      return { ...prev, [dimId]: set };
    });
  };
  const toggleAllDimEntitlements = (dimId, ents) => {
    setSelectedDimEntitlements((prev) => {
      const current = prev[dimId] || new Set();
      const allSelected = ents.length > 0 && current.size === ents.length;
      return { ...prev, [dimId]: allSelected ? new Set() : new Set(ents.map((e) => e.id)) };
    });
  };

  const roleIscTenant = getCredentials()?.tenant;
  const roleIscUrl =
    roleIscTenant && data ? `https://${tenantUiHost(roleIscTenant)}/ui/a/admin/access/roles/landing-page/details/${data.id}` : null;

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <TopBar
        title="Role"
        onBack={() => navigate(-1)}
        action={
          data && (
            <div className="flex items-center gap-2">
              <IconButton
                icon={Link}
                title="View in Identity Security Cloud"
                onClick={() => roleIscUrl && window.open(roleIscUrl, "_blank", "noopener,noreferrer")}
                disabled={!roleIscUrl}
              />
              {data.enabled ? (
                <IconButton
                  icon={PowerOff}
                  title="Disable"
                  onClick={() => toggleEnabled.mutate(false)}
                  loading={toggleEnabled.isPending && toggleEnabled.variables === false}
                  disabled={toggleEnabled.isPending || remove.isPending || evaluate.isPending}
                />
              ) : (
                <IconButton
                  icon={Power}
                  title="Enable"
                  onClick={() => toggleEnabled.mutate(true)}
                  loading={toggleEnabled.isPending && toggleEnabled.variables === true}
                  disabled={toggleEnabled.isPending || remove.isPending || evaluate.isPending}
                />
              )}
              <IconButton
                icon={Sparkles}
                title={data.membership?.criteria ? "Evaluate this role" : "Evaluate this role (no membership rule — only the SOD policy check will run)"}
                onClick={() => evaluate.mutate()}
                loading={evaluate.isPending}
                disabled={toggleEnabled.isPending || remove.isPending || evaluate.isPending}
              />
              <IconButton
                icon={Wand2}
                title="Generate a new description with AI"
                onClick={() => generateDescription.mutate()}
                loading={generateDescription.isPending}
                disabled={toggleEnabled.isPending || remove.isPending || evaluate.isPending || generateDescription.isPending}
              />
              <IconButton
                icon={Pencil}
                title="Edit role"
                onClick={() => setEditOpen(true)}
                disabled={toggleEnabled.isPending || remove.isPending || evaluate.isPending}
              />
              {commonAccessFlagEligible && (
                <IconButton
                  icon={Globe}
                  title="Flag as Common Access in ISC"
                  onClick={() => flagCommonAccess.mutate()}
                  loading={flagCommonAccess.isPending}
                  disabled={toggleEnabled.isPending || remove.isPending || evaluate.isPending || flagCommonAccess.isPending}
                />
              )}
              <IconButton
                icon={Trash2}
                title="Delete"
                onClick={() => setConfirmDeleteOpen(true)}
                disabled={toggleEnabled.isPending || remove.isPending || evaluate.isPending}
                className="!border-red-200 !text-red-600 hover:!bg-red-50"
              />
              <IconButton
                icon={Printer}
                title="Print"
                loading={printing}
                onClick={async () => {
                  setPrinting(true);
                  try {
                    const tenant = getCredentials()?.tenant;
                    const withSource = (ents) => (ents || []).map((e) => ({ ...e, sourceName: entitlementSourceById[e.id] }));
                    // The Members tab only ever holds one page, and it isn't
                    // loaded at all unless that tab has been opened — so the
                    // printout fetches the full membership itself.
                    // A failed member fetch marks its section unavailable
                    // rather than dropping it, so a partial printout can
                    // never pass for a complete one.
                    const settle = (p) => p.then((v) => v).catch(() => null);
                    const [base, ...dimMembers] = await Promise.all([
                      settle(listAllRoleMembers(data.id)),
                      ...(dimensions || []).map((d) => settle(listAllDimensionMembers(data.id, d.id))),
                    ]);
                    const role = {
                      ...data,
                      entitlements: withSource(data.entitlements),
                      ...(base ? { members: base.members, memberTotal: base.total } : { membersUnavailable: true }),
                    };
                    const dims = (dimensions || []).map((d, i) => ({
                      ...d,
                      entitlements: withSource(d.entitlements),
                      ...(dimMembers[i]
                        ? { members: dimMembers[i].members, memberTotal: dimMembers[i].total }
                        : { membersUnavailable: true }),
                    }));
                    const missing = [
                      ...(base ? [] : ["the base role"]),
                      ...(dimensions || []).filter((d, i) => !dimMembers[i]).map((d) => d.name),
                    ];
                    if (missing.length) {
                      toast.error(`Identities could not be loaded for ${missing.join(", ")} — the printout marks those sections.`);
                    }
                    if (!printRolePdf({ tenant, role, dimensions: dims })) {
                      toast("Pop-up blocked — downloaded the PDF instead");
                    }
                  } catch (err) {
                    toast.error(err?.message || "Could not build the printout");
                  } finally {
                    setPrinting(false);
                  }
                }}
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
                <div className="w-10 h-10 rounded-full bg-amber-50 flex items-center justify-center flex-shrink-0">
                  <Layers size={18} className="text-amber-600" />
                </div>
                <div className="min-w-0">
                  <h2 className="text-base font-semibold text-gray-900 truncate">{data.name}</h2>
                  <p className="text-xs text-gray-500">
                    {data.enabled ? "Enabled" : "Disabled"} · {data.dimensional ? "Dynamic role" : "Standard role"}
                  </p>
                </div>
              </div>

              {!commonAccessQuery.isLoading && !commonAccessQuery.error && (
                <div
                  className={`inline-flex items-center gap-1.5 text-xs font-medium px-2 py-1 rounded-full border mb-4 ${
                    commonAccessQuery.data?.commonAccess
                      ? "bg-emerald-50 text-emerald-700 border-emerald-100"
                      : "bg-gray-50 text-gray-500 border-gray-200"
                  }`}
                  title="ISC's own Admin > Access Model > Roles > Common Access designation"
                >
                  <Globe size={12} />
                  {commonAccessQuery.data?.commonAccess ? "Common Access" : "Not Common Access"}
                </div>
              )}

              {data.description && (
                <p className="text-sm text-gray-600 leading-relaxed">{data.description}</p>
              )}
            </>
          )}
        </div>

        {data && (
          <div className="flex border-t border-gray-100">
            <div className="w-28 flex-shrink-0 border-r border-gray-100 py-2">
              {[
                { key: "details", label: "Details", Icon: Info },
                { key: "composition", label: "Composition", Icon: PieChart },
                { key: "membership", label: "Membership Rules", Icon: ListFilter },
                { key: "members", label: "Members", Icon: Users },
                { key: "entitlements", label: "Entitlements", Icon: Key },
                ...(data.dimensional ? [{ key: "dimensions", label: "Dimensions", Icon: Boxes }] : []),
                ...(schemaAnalysis?.createDataSegments ? [{ key: "segments", label: "Data Segments", Icon: Shapes }] : []),
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
              {section === "approvals" && <ApprovalSettingsPanel kind="role" object={data} invalidateKeys={[["role", id], ["roles"]]} />}
              {section === "metadata" && <EditableMetadataPanel kind="roles" objectId={id} metadata={data.accessModelMetadata} invalidateKeys={[["role", id], ["roles"]]} />}
              {section === "details" && (
                <div className="border border-gray-100 rounded-xl overflow-hidden m-4">
                  <InfoRow label="Role type" value={data.dimensional ? "Dynamic" : "Standard"} />
                  <InfoRow label="Requestable" value={data.requestable != null ? String(data.requestable) : undefined} />
                  <InfoRow label="Enabled" value={data.enabled != null ? String(data.enabled) : undefined} />
                  <InfoRow
                    label="Common access"
                    value={
                      commonAccessQuery.isLoading
                        ? undefined
                        : commonAccessQuery.data?.commonAccess
                        ? "Yes"
                        : "No"
                    }
                  />
                  <InfoRow label="Owner" value={data.owner?.name} />
                  <InfoRow
                    label="Additional owners"
                    value={formatAdditionalOwners(data.additionalOwners)}
                  />
                  <InfoRow label="Privilege level" value={data.privilegeLevel} />
                  <InfoRow
                    label="Access request approvals"
                    value={
                      (data.accessRequestConfig?.approvalSchemes || []).length > 0
                        ? data.accessRequestConfig.approvalSchemes.map((s) => s.approverType || s).join(", ")
                        : "None configured"
                    }
                  />
                  <InfoRow label="Reauthorization required" value={data.accessRequestConfig?.reauthorizationRequired != null ? String(data.accessRequestConfig.reauthorizationRequired) : undefined} />
                  <InfoRow label="Requires end date" value={data.accessRequestConfig?.requireEndDate != null ? String(data.accessRequestConfig.requireEndDate) : undefined} />
                  <InfoRow label="Max access duration" value={data.accessRequestConfig?.maxPermittedAccessDuration} />
                  <InfoRow
                    label="Revocation approvals"
                    value={
                      (data.revocationRequestConfig?.approvalSchemes || []).length > 0
                        ? data.revocationRequestConfig.approvalSchemes.map((s) => s.approverType || s).join(", ")
                        : "None configured"
                    }
                  />
                  {(data.accessModelMetadata?.attributes || []).map((attr) => (
                    <InfoRow
                      key={attr.key}
                      label={attr.name || attr.key}
                      value={(attr.values || []).map((v) => v.name || v.value).join(", ")}
                    />
                  ))}
                  <InfoRow label="Created" value={data.created ? new Date(data.created).toLocaleString() : undefined} />
                  <InfoRow label="Modified" value={data.modified ? new Date(data.modified).toLocaleString() : undefined} />
                  <InfoRow label="Role ID" value={data.id} />
                </div>
              )}

              {section === "membership" && (
                <div className="p-4">
                  <MembershipRule membership={data.membership} />
                </div>
              )}

              {section === "entitlements" && (
                <div>
                  {accessProfiles.length > 0 && (
                    <>
                      <SectionLabel>Access profiles ({accessProfiles.length})</SectionLabel>
                      <div className="border-t border-b border-gray-100">
                        {accessProfiles.map((ap) => (
                          <button
                            key={ap.id}
                            onClick={() => navigate(`/access-profiles/${ap.id}`)}
                            className="w-full flex items-center gap-3 px-4 py-3.5 border-b border-gray-100 last:border-b-0 hover:bg-gray-50 active:bg-gray-100 text-left transition-colors"
                          >
                            <div className="w-8 h-8 rounded-full bg-violet-50 flex items-center justify-center flex-shrink-0">
                              <ShieldCheck size={14} className="text-violet-600" />
                            </div>
                            <p className="text-sm font-medium text-gray-900 truncate flex-1">{ap.name}</p>
                          </button>
                        ))}
                      </div>
                    </>
                  )}

                  {entitlements.length > 0 ? (
                    <>
                      <SearchBar
                        value={entitlementSearch}
                        onChange={setEntitlementSearch}
                        placeholder="Search entitlements…"
                      />
                      <EntitlementsSectionHeader
                        label={data.dimensional ? "Base role entitlements" : "Entitlements"}
                        count={visibleEntitlements.length}
                        allSelected={visibleEntitlements.length > 0 && selectedEntitlements.size === visibleEntitlements.length}
                        onToggleAll={toggleAllEntitlements}
                        selectedCount={selectedEntitlements.size}
                        deletePending={removeEntitlements.isPending}
                        onDeleteSelected={() => setPendingRemoval({ type: "role" })}
                        onAdd={() => setAddEntsOpen(true)}
                      />
                      {visibleEntitlements.length === 0 && (
                        <p className="text-sm text-gray-400 px-4 py-6 text-center">No entitlements match your search</p>
                      )}
                      <div className="border-t border-gray-100">
                        {visibleEntitlements.map((e) => (
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
                              <div className="min-w-0 flex-1">
                                <p className="text-sm font-medium text-gray-900 truncate">{e.name}</p>
                                {entitlementSourceById[e.id] && (
                                  <p className="text-xs text-gray-400 truncate">{entitlementSourceById[e.id]}</p>
                                )}
                              </div>
                            </button>
                          </div>
                        ))}
                      </div>
                    </>
                  ) : (
                    <div className="flex items-center justify-between px-4 pt-5 pb-2">
                      {accessProfiles.length === 0 ? (
                        <p className="text-sm text-gray-400 py-1">No entitlements or access profiles on this role</p>
                      ) : <span />}
                      <IconButton
                        icon={Plus}
                        title="Add entitlements"
                        onClick={() => setAddEntsOpen(true)}
                        className="!w-7 !h-7 !border-emerald-200 !text-emerald-600 hover:!bg-emerald-50"
                      />
                    </div>
                  )}
                </div>
              )}

              {section === "members" && (
                <div>
                  {hasMembershipRule ? (
                    <>
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
                          subtitle={debouncedMemberSearch ? `No members match "${debouncedMemberSearch}"` : "No identities currently match this role's membership rule"}
                        />
                      )}
                      {totalMembers > 0 && <Pager offset={memberOffset} pageSize={MEMBERS_PAGE_SIZE} total={totalMembers} noun="member" onOffsetChange={setMemberOffset} hasNext={memberOffset + members.length < totalMembers} busy={membersQuery.isFetching} />}
                      {members.length > 0 && (
                        <div className="border-t border-gray-100">
                          {members.map((m) => (
                            <button
                              key={m.id}
                              onClick={() => navigate(`/identities/${m.id}`)}
                              className="w-full flex items-center gap-3 px-4 py-3 border-b border-gray-100 hover:bg-gray-50 active:bg-gray-100 text-left transition-colors"
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
                          ))}
                        </div>
                      )}
                      {totalMembers > 0 && (
                        <Pager offset={memberOffset} pageSize={MEMBERS_PAGE_SIZE} total={totalMembers} noun="member" onOffsetChange={setMemberOffset} hasNext={memberOffset + members.length < totalMembers} busy={membersQuery.isFetching} />
                      )}
                    </>
                  ) : (
                    <>
                      <div className="flex items-center justify-between px-4 pt-5 pb-2">
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={memberIdentities.length > 0 && selectedMembers.size === memberIdentities.length}
                            onChange={toggleAllMembers}
                            className="w-4 h-4 rounded border-gray-300 accent-blue-600"
                          />
                          <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                            Members ({memberIdentities.length})
                          </span>
                        </label>
                        <div className="flex items-center gap-1.5">
                          {selectedMembers.size > 0 && (
                            <IconButton
                              icon={Trash2}
                              title={`Remove selected (${selectedMembers.size})`}
                              onClick={() => setPendingMemberRemoval(true)}
                              loading={removeMembers.isPending}
                              className="!w-7 !h-7 !border-red-200 !text-red-600 hover:!bg-red-50"
                            />
                          )}
                          <IconButton
                            icon={UserPlus}
                            title="Add members"
                            onClick={() => setAddMembersOpen(true)}
                            className="!w-7 !h-7 !border-blue-200 !text-blue-600 hover:!bg-blue-50"
                          />
                        </div>
                      </div>
                      {memberIdentitiesQuery.isLoading && (
                        <div className="flex items-center justify-center py-6">
                          <Spinner size={18} />
                        </div>
                      )}
                      {memberIdentitiesQuery.error && <ErrorBox message={memberIdentitiesQuery.error.message} />}
                      {!memberIdentitiesQuery.isLoading && memberIdentities.length === 0 && (
                        <EmptyState
                          icon={Users}
                          title="No members"
                          subtitle="This role has no membership rule and no members assigned yet."
                        />
                      )}
                      {memberIdentities.length > 0 && (
                        <div className="border-t border-gray-100">
                          {memberIdentities.map((m) => (
                            <div
                              key={m.id}
                              className="w-full flex items-center gap-3 px-4 py-3.5 border-b border-gray-100 hover:bg-gray-50 transition-colors"
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
                                <Avatar name={m.name} size="sm" />
                                <div className="min-w-0 flex-1">
                                  <p className="text-sm font-medium text-gray-900 truncate">{m.name}</p>
                                  {m.email && <p className="text-xs text-gray-400 truncate">{m.email}</p>}
                                </div>
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}

              {section === "dimensions" && data.dimensional && (
                <div>
                  <div className="flex justify-end gap-1 px-4 pt-4">
                    <IconButton
                      icon={allDimensionsExpanded ? Minimize2 : Maximize2}
                      title={allDimensionsExpanded ? "Collapse all dimensions" : "Expand all dimensions"}
                      onClick={toggleAllDimensionsExpanded}
                      disabled={dimensions.length === 0}
                    />
                    <IconButton
                      icon={Plus}
                      title="Add dimension"
                      onClick={() => setCreateDimensionOpen(true)}
                      className="!border-emerald-200 !text-emerald-600 hover:!bg-emerald-50"
                    />
                  </div>
                  {dimensionsQuery.isLoading && (
                    <div className="flex items-center justify-center py-6">
                      <Spinner size={18} />
                    </div>
                  )}
                  {dimensionsQuery.error && (
                    <ErrorBox message={dimensionsQuery.error.message} />
                  )}
                  {!dimensionsQuery.isLoading && !dimensionsQuery.error && dimensions.length === 0 && (
                    <p className="text-sm text-gray-400 px-4 py-6 text-center">No dimensions on this role</p>
                  )}
                  {dimensions.map((d) => {
                    const isExpanded = expandedDimensionIds.has(d.id);
                    return (
                      <div key={d.id} className="border-b border-gray-100 px-4 py-3.5">
                        <div
                          role="button"
                          tabIndex={0}
                          onClick={() => toggleDimensionExpanded(d.id)}
                          onKeyDown={(e) => e.key === "Enter" && toggleDimensionExpanded(d.id)}
                          className="flex items-center gap-3 cursor-pointer"
                        >
                          <ChevronDown
                            size={16}
                            className={`text-gray-400 flex-shrink-0 transition-transform ${isExpanded ? "" : "-rotate-90"}`}
                          />
                          <div className="w-8 h-8 rounded-full bg-emerald-50 flex items-center justify-center flex-shrink-0">
                            <Boxes size={14} className="text-emerald-600" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium text-gray-900 truncate">{d.name}</p>
                            {d.description && (
                              <p className="text-xs text-gray-500 truncate">{d.description}</p>
                            )}
                          </div>
                          <IconButton
                            icon={Pencil}
                            title="Edit dimension"
                            onClick={(e) => { e.stopPropagation(); setEditDimension(d); }}
                            className="!w-7 !h-7 flex-shrink-0"
                          />
                          <IconButton
                            icon={Plus}
                            title="Add entitlements"
                            onClick={(e) => { e.stopPropagation(); setAddEntsToDimension(d.id); }}
                            className="!w-7 !h-7 !border-emerald-200 !text-emerald-600 hover:!bg-emerald-50 flex-shrink-0"
                          />
                          <IconButton
                            icon={Trash2}
                            title="Delete dimension"
                            onClick={(e) => { e.stopPropagation(); setPendingDimensionDeletion({ id: d.id, name: d.name }); }}
                            className="!w-7 !h-7 !border-red-200 !text-red-600 hover:!bg-red-50 flex-shrink-0"
                          />
                        </div>
                        {isExpanded && (
                          <>
                            <div className="mt-2 pl-11">
                              <MembershipRule membership={d.membership} />
                            </div>
                            <div className="mt-2 pl-11">
                              <DimensionMembers roleId={id} dimensionId={d.id} expanded={isExpanded} />
                            </div>
                            {(d.entitlements || []).length > 0 ? (
                              (() => {
                                const dimEnts = sortByName(d.entitlements);
                                const selected = selectedDimEntitlements[d.id] || new Set();
                                return (
                                  <div className="mt-2 pl-11">
                                    <div className="flex items-center justify-between mb-1.5">
                                      <label className="flex items-center gap-2 cursor-pointer">
                                        <input
                                          type="checkbox"
                                          checked={dimEnts.length > 0 && selected.size === dimEnts.length}
                                          onChange={() => toggleAllDimEntitlements(d.id, dimEnts)}
                                          className="w-3.5 h-3.5 rounded border-gray-300 accent-blue-600"
                                        />
                                        <span className="text-xs text-gray-400">Select all</span>
                                      </label>
                                      {selected.size > 0 && (
                                        <IconButton
                                          icon={Trash2}
                                          title={`Delete selected (${selected.size})`}
                                          onClick={() =>
                                            setPendingRemoval({ type: "dimension", dimensionId: d.id, dimensionName: d.name })
                                          }
                                          loading={removeDimEntitlements.isPending && removeDimEntitlements.variables?.dimensionId === d.id}
                                          className="!w-6 !h-6 !border-red-200 !text-red-600 hover:!bg-red-50"
                                        />
                                      )}
                                    </div>
                                    <div className="space-y-1">
                                      {dimEnts.map((e) => (
                                        <div key={e.id} className="flex items-center gap-2">
                                          <input
                                            type="checkbox"
                                            checked={selected.has(e.id)}
                                            onChange={() => toggleDimEntitlement(d.id, e.id)}
                                            className="w-3.5 h-3.5 rounded border-gray-300 accent-blue-600 flex-shrink-0"
                                          />
                                          <button
                                            onClick={() => navigate(`/entitlements/${e.id}`)}
                                            className="text-left"
                                          >
                                            <span className="text-xs text-violet-600 hover:underline">{e.name}</span>
                                            {entitlementSourceById[e.id] && (
                                              <span className="text-xs text-gray-400"> · {entitlementSourceById[e.id]}</span>
                                            )}
                                          </button>
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                );
                              })()
                            ) : (
                              <p className="text-xs text-gray-400 pl-11 mt-1">
                                No entitlements unique to this dimension
                              </p>
                            )}
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {section === "composition" && <RoleCompositionPanel roleId={id} />}

              {section === "segments" && (
                <SegmentsTabPanel
                  queryKey={["role-segments", id]}
                  queryFn={() => getRoleSegments(id)}
                  navigate={navigate}
                  emptySubtitle="This role isn't selected on any data segment's Access Model"
                />
              )}
              {section === "json" && (
                <RawJsonPanel data={data} resource="roles" objectId={id} invalidateKeys={[["role", id], ["roles"]]} />
              )}
            </div>
          </div>
        )}
      </div>

      {confirmDeleteOpen && (
        <ConfirmModal
          title="Delete this role?"
          message="This permanently deletes the role from this tenant. This cannot be undone."
          confirmLabel="Delete"
          danger
          pending={remove.isPending}
          onConfirm={() => remove.mutate()}
          onCancel={() => setConfirmDeleteOpen(false)}
        />
      )}

      {evaluation && (
        <EvaluationSheet
          result={evaluation}
          onClose={() => setEvaluation(null)}
          onAddSelected={(entitlements) => addEntitlements.mutate(entitlements)}
          addPending={addEntitlements.isPending}
          onAddDimensionSelected={(dimensionId, entitlements) => addDimEntitlements.mutate({ dimensionId, entitlements })}
          addDimPending={addDimEntitlements.isPending ? addDimEntitlements.variables?.dimensionId : null}
          onCreateDimension={(md, entitlements) => createDimension.mutate({ md, entitlements })}
          createDimensionPending={createDimension.isPending ? createDimension.variables?.md?.value : null}
          onAcceptAll={() => acceptAll.mutate(evaluation)}
          acceptAllPending={acceptAll.isPending}
          onRepairSod={(items) => repairSod.mutateAsync(items)}
          repairPending={repairSod.isPending}
          onMitigateSod={evalSettings?.allowSodMitigations === false ? null : (payload) => mitigateSod.mutateAsync(payload)}
          mitigatePending={mitigateSod.isPending}
          onRemoveDimension={(sd) => removeStaleDimension.mutate(sd)}
          removeDimensionPending={removeStaleDimension.isPending ? removeStaleDimension.variables?.dimensionId : null}
        />
      )}

      {pendingRemoval && (
        <ConfirmModal
          title="Delete selected entitlements?"
          message={
            pendingRemoval.type === "role"
              ? `This removes ${selectedEntitlements.size} entitlement${selectedEntitlements.size === 1 ? "" : "s"} directly from this role. This cannot be undone.`
              : `This removes ${(selectedDimEntitlements[pendingRemoval.dimensionId]?.size) || 0} entitlement(s) from the "${pendingRemoval.dimensionName}" dimension. This cannot be undone.`
          }
          confirmLabel="Delete"
          danger
          pending={pendingRemoval.type === "role" ? removeEntitlements.isPending : removeDimEntitlements.isPending}
          onConfirm={() => {
            if (pendingRemoval.type === "role") {
              removeEntitlements.mutate(Array.from(selectedEntitlements));
            } else {
              removeDimEntitlements.mutate({
                dimensionId: pendingRemoval.dimensionId,
                ids: Array.from(selectedDimEntitlements[pendingRemoval.dimensionId] || []),
              });
            }
          }}
          onCancel={() => setPendingRemoval(null)}
        />
      )}

      {addMembersOpen && (
        <AddMembersModal
          existingIds={new Set(memberIdentityIds)}
          onClose={() => setAddMembersOpen(false)}
          onAdd={(identities) => addMembers.mutate(identities)}
          pending={addMembers.isPending}
        />
      )}

      {editOpen && data && (
        <EditRoleModal
          role={data}
          commonAccessStatus={commonAccessQuery.data?.status}
          onClose={() => setEditOpen(false)}
          onSave={(payload) => editRole.mutate(payload)}
          pending={editRole.isPending}
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

      {createDimensionOpen && (
        <CreateDimensionModal
          onClose={() => setCreateDimensionOpen(false)}
          onCreate={(payload) => createDimensionManual.mutate(payload)}
          pending={createDimensionManual.isPending}
        />
      )}

      {editDimension && (
        <EditDimensionModal
          dimension={editDimension}
          onClose={() => setEditDimension(null)}
          onSave={(fields) => updateDimension.mutate(fields)}
          pending={updateDimension.isPending}
        />
      )}

      {addEntsToDimension && (
        <AddEntitlementsModal
          existingIds={new Set((dimensions.find((d) => d.id === addEntsToDimension)?.entitlements || []).map((e) => e.id))}
          onClose={() => setAddEntsToDimension(null)}
          onAdd={(entitlements) => addDimEntitlements.mutate({ dimensionId: addEntsToDimension, entitlements }, { onSuccess: () => setAddEntsToDimension(null) })}
          pending={addDimEntitlements.isPending}
        />
      )}

      {addEntsOpen && (
        <AddEntitlementsModal
          existingIds={new Set(entitlements.map((e) => e.id))}
          onClose={() => setAddEntsOpen(false)}
          onAdd={(ents) => addEntitlements.mutate(ents, { onSuccess: () => setAddEntsOpen(false) })}
          pending={addEntitlements.isPending}
        />
      )}

      {pendingDimensionDeletion && (
        <ConfirmModal
          title="Delete this dimension?"
          message={`This permanently removes the "${pendingDimensionDeletion.name}" dimension from this role. This cannot be undone.`}
          confirmLabel="Delete"
          danger
          pending={deleteDimension.isPending}
          onConfirm={() => deleteDimension.mutate(pendingDimensionDeletion.id)}
          onCancel={() => setPendingDimensionDeletion(null)}
        />
      )}

      {pendingMemberRemoval && (
        <ConfirmModal
          title="Remove selected members?"
          message={`This removes ${selectedMembers.size} member${selectedMembers.size === 1 ? "" : "s"} from this role. This cannot be undone.`}
          confirmLabel="Remove"
          danger
          pending={removeMembers.isPending}
          onConfirm={() => removeMembers.mutate(Array.from(selectedMembers))}
          onCancel={() => setPendingMemberRemoval(false)}
        />
      )}
    </div>
  );
}
