import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Tags, Info, Braces, List, X, Shield, ShieldCheck, Key, Pencil, ChevronRight, Trash2 } from "lucide-react";
import toast from "react-hot-toast";
import { listMetadataAttributes, getMetadataAttribute, patchObjectJson, listAccessByMetadataValue, deleteMetadataValues } from "../lib/sailpoint";
import { TopBar } from "../components/TopBar";
import { BrowseTitleMenu } from "../components/BrowseTitleMenu";
import { RawJsonPanel } from "../components/RawJsonPanel";
import { JsonEditTabs } from "../components/JsonTree";
import { jsonParseError, JSON_EDITOR_STYLE, highlightJson, escapeHtml } from "../components/JsonEditor";
import { useUrlState } from "../hooks/useUrlState";
import { SkeletonList, ErrorBox, EmptyState, SearchBar, InfoRow, PrimaryButton, OutlineButton, IconButton, SelectionActionBar, ConfirmModal } from "../components/ui";
import { usePagedList } from "../hooks/usePagedList";

// ─── Access Model Metadata: attribute list + detail ─────────────────────────

function AttrBadges({ attr }) {
  return (
    <>
      {attr.type && (
        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full border bg-gray-50 text-gray-500 border-gray-200">{attr.type}</span>
      )}
      {attr.multiselect && (
        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full border bg-blue-50 text-blue-700 border-blue-200">multi-value</span>
      )}
      {attr.status && attr.status !== "active" && (
        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full border bg-amber-50 text-amber-700 border-amber-200">{attr.status}</span>
      )}
    </>
  );
}

export default function MetadataPage() {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ["metadata-attributes"], queryFn: listMetadataAttributes });
  const all = Array.isArray(data) ? data : [];
  const list = all.filter(
    (a) => !search || (a.name || "").toLowerCase().includes(search.toLowerCase()) || (a.key || "").toLowerCase().includes(search.toLowerCase())
  );
  const { page, pager } = usePagedList(list, { noun: "attribute", resetKey: search });

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <TopBar title={<BrowseTitleMenu active="Metadata" />} loading={isLoading} />
      <div className="flex-1 overflow-y-auto pb-24">
        <SearchBar value={search} onChange={setSearch} placeholder="Search metadata attributes…" />

        {error && <ErrorBox message={error.message} onRetry={refetch} />}
        {isLoading && <SkeletonList rows={6} />}
        {!isLoading && !error && list.length === 0 && (
          <EmptyState
            icon={Tags}
            title={search ? "No results" : "No metadata attributes"}
            subtitle={search ? `No attributes match "${search}"` : "This tenant has no Access Model Metadata attributes"}
          />
        )}

        {!isLoading && list.length > 0 && (
          <>
            <p className="text-xs text-gray-400 px-4 py-2">{list.length} attribute{list.length === 1 ? "" : "s"}</p>
            {pager}
            {page.map((a) => (
              <button
                key={a.key}
                onClick={() => navigate(`/metadata/${encodeURIComponent(a.key)}`)}
                className="w-full flex items-center gap-3 px-4 py-3.5 border-b border-gray-100 hover:bg-gray-50 active:bg-gray-100 text-left transition-colors"
              >
                <div className="w-10 h-10 rounded-full bg-fuchsia-50 flex items-center justify-center flex-shrink-0">
                  <Tags size={16} className="text-fuchsia-600" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <p className="text-sm font-medium text-gray-900 truncate">{a.name || a.key}</p>
                    <AttrBadges attr={a} />
                  </div>
                  <p className="text-xs text-gray-500 mt-0.5 truncate">{a.description || a.key}</p>
                </div>
              </button>
            ))}
            {pager}
          </>
        )}
      </div>
    </div>
  );
}

// Values can only be deleted from a CUSTOM attribute. Decided by the
// attribute alone, and as an allowlist: type must be exactly "custom" (what
// ISC stamps on attributes created by customers — see the server's
// ensureBoundaryMetadataAttribute). Anything else, including a missing or
// unrecognised type, is treated as built-in and left read-only.
function isCustomAttribute(attribute) {
  return String(attribute?.type || "").toLowerCase() === "custom";
}

// The Values tab: every registered value, with select one/all and a batch
// delete for custom attributes. ISC rejects a save that shortens the values
// list, so the server deletes value by value and reports what happened to
// each — a batch can partly succeed, and whatever failed stays selected.
function AttributeValuesPanel({ attrKey, attribute, values, navigate }) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState(() => new Set());
  const [confirming, setConfirming] = useState(false);

  const custom = isCustomAttribute(attribute);
  const deletable = custom ? values : [];
  // Selection is over what's listed — a refetch can drop a selected value.
  const chosen = deletable.filter((v) => selected.has(v.value));
  const allSelected = deletable.length > 0 && deletable.every((v) => selected.has(v.value));

  const toggleOne = (value) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(value)) next.delete(value); else next.add(value);
    return next;
  });
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(deletable.map((v) => v.value)));

  const remove = useMutation({
    mutationFn: async () => {
      if (!custom) throw new Error("Values of a built-in metadata attribute can't be deleted.");
      return deleteMetadataValues(attrKey, chosen.map((v) => v.value));
    },
    onSuccess: ({ deleted = [], failed = [] }) => {
      setConfirming(false);
      // Whatever failed stays selected, so it can be retried or inspected.
      setSelected(new Set(failed.map((f) => f.value)));
      if (deleted.length > 0) toast.success(`Deleted ${deleted.length} value${deleted.length === 1 ? "" : "s"}`);
      if (failed.length > 0) {
        const labelOf = (value) => values.find((v) => v.value === value)?.name || value;
        toast.error(
          `${failed.length} value${failed.length === 1 ? "" : "s"} not deleted — ${failed.slice(0, 3).map((f) => `${labelOf(f.value)}: ${f.error}`).join("; ")}${failed.length > 3 ? "; …" : ""}`,
          { duration: 10000 }
        );
      }
      queryClient.invalidateQueries({ queryKey: ["metadata-attribute", attrKey] });
      queryClient.invalidateQueries({ queryKey: ["metadata-attributes"] });
      queryClient.invalidateQueries({ queryKey: ["metadata-attribute-values", attrKey] });
    },
    onError: (err) => {
      setConfirming(false);
      toast.error(err.response?.data?.error || err.message);
    },
  });

  if (values.length === 0) {
    return (
      <div className="px-4 py-4">
        <EmptyState icon={List} title="No values" subtitle="This attribute has no registered values yet" />
      </div>
    );
  }

  return (
    <div className="py-4">
      <p className="text-xs text-gray-400 mb-2 px-4">
        {values.length} value{values.length === 1 ? "" : "s"} — click one to see what it's attached to, and its JSON
      </p>
      {deletable.length > 0 ? (
        <label className="flex items-center gap-2 px-4 pb-2 text-xs text-gray-500 cursor-pointer w-fit">
          <input type="checkbox" checked={allSelected} onChange={toggleAll} className="w-4 h-4 rounded border-gray-300" />
          Select all
        </label>
      ) : (
        <p className="text-xs text-gray-400 px-4 pb-2">This is a built-in attribute, so its values can't be deleted.</p>
      )}
      {chosen.length > 0 && (
        <SelectionActionBar
          count={chosen.length}
          actions={[{ icon: Trash2, title: `Delete ${chosen.length} selected value${chosen.length === 1 ? "" : "s"}`, onClick: () => setConfirming(true), loading: remove.isPending, danger: true }]}
        />
      )}
      <div className="mx-4 border border-gray-100 rounded-xl overflow-hidden divide-y divide-gray-100">
        {values.map((v) => {
          return (
            <div key={v.value} className="flex items-center hover:bg-gray-50 transition-colors">
              {custom && (
                <input
                  type="checkbox"
                  checked={selected.has(v.value)}
                  onChange={() => toggleOne(v.value)}
                  aria-label={`Select ${v.name || v.value}`}
                  className="w-4 h-4 ml-3 rounded border-gray-300 flex-shrink-0"
                />
              )}
              <button
                onClick={() => navigate(`/metadata/${encodeURIComponent(attrKey)}/values/${encodeURIComponent(v.value)}`)}
                className="flex-1 min-w-0 flex items-center gap-2 px-3 py-2.5 active:bg-gray-100 text-left"
              >
                <span className="text-sm text-gray-900">{v.name || v.value}</span>
                {v.value !== v.name && <span className="text-xs text-gray-400 font-mono">{v.value}</span>}
                {v.status && v.status !== "active" && (
                  <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full border bg-amber-50 text-amber-700 border-amber-200">{v.status}</span>
                )}
                {v.type && (
                  <span className="ml-auto text-[10px] text-gray-400">{v.type}</span>
                )}
                <ChevronRight size={14} className={`text-gray-300 flex-shrink-0 ${v.type ? "" : "ml-auto"}`} />
              </button>
            </div>
          );
        })}
      </div>

      {confirming && (
        <ConfirmModal
          danger
          title={`Delete ${chosen.length} value${chosen.length === 1 ? "" : "s"}?`}
          message={`This removes ${chosen.length === 1 ? "this value" : "these values"} from "${attribute.name || attrKey}". Roles, access profiles and entitlements tagged with ${chosen.length === 1 ? "it lose that tag" : "them lose those tags"}, and any data segment filter that references ${chosen.length === 1 ? "it" : "them"} stops matching. This can't be undone.`}
          confirmLabel="Delete"
          pending={remove.isPending}
          onConfirm={() => remove.mutate()}
          onCancel={() => setConfirming(false)}
        >
          <ul className="text-xs text-gray-600 mb-4 max-h-40 overflow-y-auto border border-gray-100 rounded-lg divide-y divide-gray-100">
            {chosen.map((v) => (
              <li key={v.value} className="px-3 py-1.5 flex items-center gap-2">
                <span className="truncate">{v.name || v.value}</span>
                {v.value !== v.name && <span className="font-mono text-gray-400 truncate">{v.value}</span>}
              </li>
            ))}
          </ul>
        </ConfirmModal>
      )}
    </div>
  );
}

const SECTIONS = [
  { key: "details", label: "Details", Icon: Info },
  { key: "values", label: "Values", Icon: List },
  { key: "json", label: "JSON", Icon: Braces },
];

export function MetadataAttributeDetailPage() {
  const { key } = useParams();
  const navigate = useNavigate();
  const [section, setSection] = useState("details");

  const { data, isLoading, error } = useQuery({
    queryKey: ["metadata-attribute", key],
    queryFn: () => getMetadataAttribute(key),
  });
  // The attribute record carries its values inline — the same array the
  // value screen's JSON tab splices an edit back into.
  const values = Array.isArray(data?.values) ? data.values : [];

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <TopBar title={data?.name || key} onBack={() => navigate(-1)} />
      <div className="flex-1 overflow-y-auto pb-24">
        {isLoading && <SkeletonList rows={5} />}
        {error && <ErrorBox message={error.message} />}
        {data && (
          <div className="flex min-h-full">
            <div className="w-24 flex-shrink-0 border-r border-gray-100 py-2">
              {SECTIONS.map(({ key: k, label, Icon }) => (
                <button
                  key={k}
                  onClick={() => setSection(k)}
                  className={`w-full flex flex-col items-center gap-1 px-2 py-3 text-xs font-medium transition-colors ${
                    section === k ? "text-blue-600 bg-blue-50" : "text-gray-400 hover:text-gray-600"
                  }`}
                >
                  <Icon size={16} />
                  {label}
                </button>
              ))}
            </div>
            <div className="flex-1 min-w-0">
              {section === "details" && (
                <div className="px-4 py-4">
                  <div className="flex items-center gap-2 flex-wrap mb-3">
                    <h2 className="text-base font-semibold text-gray-900">{data.name || data.key}</h2>
                    <AttrBadges attr={data} />
                  </div>
                  {data.description && <p className="text-sm text-gray-600 leading-relaxed mb-4">{data.description}</p>}
                  <div className="border border-gray-100 rounded-xl overflow-hidden">
                    <InfoRow label="Key" value={data.key} />
                    <InfoRow label="Type" value={data.type} />
                    <InfoRow label="Multi-value" value={data.multiselect ? "Yes" : "No"} />
                    <InfoRow label="Allow ad-hoc values" value={data.isAdhoc != null ? (data.isAdhoc ? "Yes" : "No") : undefined} />
                    <InfoRow label="Status" value={data.status} />
                    <InfoRow label="Object types" value={(data.objectTypes || []).join(", ") || undefined} />
                  </div>
                </div>
              )}

              {section === "values" && <AttributeValuesPanel attrKey={key} attribute={data} values={values} navigate={navigate} />}

              {section === "json" && (
                <RawJsonPanel
                  data={data}
                  resource="metadata-attributes"
                  objectId={data.key}
                  invalidateKeys={[["metadata-attribute", key], ["metadata-attributes"], ["metadata-attribute-values", key]]}
                />
              )}
            </div>
          </div>
        )}
      </div>

    </div>
  );
}

// ─── Metadata value detail ──────────────────────────────────────────────────
// One value of one attribute: what it is tagged onto — roles, access
// profiles, entitlements — and its own JSON. (Identities aren't tagged with
// metadata, only hold things that are, so there is no Identities tab.)

const VALUE_SECTIONS = [
  { key: "roles", label: "Roles", Icon: Shield, type: "roles", path: "/roles" },
  { key: "access-profiles", label: "Access Profiles", Icon: ShieldCheck, type: "accessprofiles", path: "/access-profiles" },
  { key: "entitlements", label: "Entitlements", Icon: Key, type: "entitlements", path: "/entitlements" },
  { key: "json", label: "JSON", Icon: Braces },
];
const VALUE_PAGE_SIZE = 100;

// One tab's worth: every item of `type` tagged with the value, by name.
function TaggedAccessPanel({ attrKey, value, section, navigate }) {
  const [search, setSearch] = useState("");
  const { data, isLoading, error, refetch, hasNextPage, fetchNextPage, isFetchingNextPage } = useInfiniteQuery({
    queryKey: ["metadata-value-access", attrKey, value, section.type],
    queryFn: ({ pageParam }) => listAccessByMetadataValue(attrKey, value, section.type, { limit: VALUE_PAGE_SIZE, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (last, all) => {
      const loaded = all.reduce((n, p) => n + (p.items?.length || 0), 0);
      return loaded < (last.total ?? 0) && (last.items?.length || 0) > 0 ? loaded : undefined;
    },
    staleTime: 60_000,
  });
  const items = useMemo(() => (data?.pages || []).flatMap((p) => p.items || []), [data]);
  const total = data?.pages?.[0]?.total ?? 0;
  const q = search.trim().toLowerCase();
  const shown = items.filter((i) => !q || [i.name, i.displayName, i.description, i.source?.name].some((v) => String(v || "").toLowerCase().includes(q)));
  const noun = section.label.toLowerCase();

  if (isLoading) return <SkeletonList rows={6} />;
  if (error) return <div className="px-4 py-4"><ErrorBox message={error.response?.data?.error || error.message} onRetry={refetch} /></div>;
  if (total === 0) return <EmptyState icon={section.Icon} title={`No ${noun}`} subtitle={`No ${noun} are tagged with this value`} />;

  return (
    <div>
      <SearchBar value={search} onChange={setSearch} placeholder={`Search these ${noun}…`} />
      <p className="px-4 pb-1 text-[11px] text-gray-400">
        {q ? `${shown.length} of ${items.length} loaded match` : `${total.toLocaleString()} tagged`}
        {/* The search box filters what's loaded — say so while there's more to load. */}
        {hasNextPage ? ` · ${items.length.toLocaleString()} loaded — load the rest to search all of them` : ""}
      </p>
      <div className="border-t border-gray-100">
        {shown.map((item) => (
          <button
            key={item.id}
            onClick={() => navigate(`${section.path}/${item.id}`)}
            className="w-full flex items-center gap-3 px-4 py-3 border-b border-gray-100 hover:bg-gray-50 active:bg-gray-100 text-left transition-colors"
          >
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-gray-900 truncate">{item.displayName || item.name}</p>
              <p className="text-xs text-gray-500 truncate mt-0.5">
                {[item.source?.name, item.description].filter(Boolean).join(" · ") || item.owner?.name || ""}
              </p>
            </div>
            {item.enabled === false && <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full border bg-gray-50 text-gray-500 border-gray-200 flex-shrink-0">Disabled</span>}
            {item.privileged && <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full border bg-amber-50 text-amber-700 border-amber-200 flex-shrink-0">Privileged</span>}
            <ChevronRight size={16} className="text-gray-300 flex-shrink-0" />
          </button>
        ))}
      </div>
      {q && shown.length === 0 && <p className="text-sm text-gray-400 text-center py-6">Nothing loaded matches "{search}"</p>}
      {hasNextPage && (
        <div className="px-4 py-3">
          <OutlineButton onClick={() => fetchNextPage()} loading={isFetchingNextPage}>Load more</OutlineButton>
        </div>
      )}
    </div>
  );
}

// The value's own JSON — its entry in the attribute's values list. Editing
// splices it back into the attribute (there is no per-value write), exactly
// as the old value sheet did.
function ValueJsonPanel({ attrKey, attribute, value }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const pretty = useMemo(() => JSON.stringify(value, null, 2), [value]);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(pretty);
  const parseError = editing ? jsonParseError(text) : null;

  const save = useMutation({
    mutationFn: async () => {
      const edited = JSON.parse(text);
      const newValues = (attribute.values || []).map((v) => (v.value === value.value ? edited : v));
      await patchObjectJson("metadata-attributes", attrKey, [{ op: "replace", path: "/values", value: newValues }]);
      return edited;
    },
    onSuccess: (edited) => {
      toast.success(`Value "${edited.name || edited.value}" saved`);
      setEditing(false);
      queryClient.invalidateQueries({ queryKey: ["metadata-attribute", attrKey] });
      queryClient.invalidateQueries({ queryKey: ["metadata-attributes"] });
      queryClient.invalidateQueries({ queryKey: ["metadata-attribute-values", attrKey] });
      // The technical name is this screen's address — follow it if it changed.
      if (edited.value !== value.value) navigate(`/metadata/${encodeURIComponent(attrKey)}/values/${encodeURIComponent(edited.value)}?tab=json`, { replace: true });
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  let renamesTechnicalName = false;
  if (editing && !parseError) {
    try { renamesTechnicalName = JSON.parse(text).value !== value.value; } catch { /* parseError covers it */ }
  }

  return (
    <div className="px-4 py-4">
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs text-gray-500">
          {editing ? `Saving splices this entry back into "${attribute.name || attrKey}"'s values list.` : "This value's entry in the attribute's values list."}
        </p>
        {!editing && <IconButton icon={Pencil} title="Edit JSON" onClick={() => { setText(pretty); setEditing(true); }} />}
      </div>
      {!editing ? (
        <pre className="border border-gray-200 rounded-xl overflow-auto text-gray-800 bg-gray-50" style={JSON_EDITOR_STYLE} dangerouslySetInnerHTML={{ __html: highlightJson(escapeHtml(pretty)) }} />
      ) : (
        <>
          <JsonEditTabs text={text} onChange={setText} minHeight="200px" title={`${value.name || value.value} — metadata value`} />
          {renamesTechnicalName && (
            <p className="text-xs text-amber-700 mt-2">
              You've changed <span className="font-mono">value</span> — the technical name. Roles, access profiles and entitlements are tagged by that name, and data segment filters reference it, so existing tags and filters will no longer match this value. Change <span className="font-mono">name</span> instead to rename what people see.
            </p>
          )}
          <div className="flex gap-2 mt-3">
            <PrimaryButton onClick={() => save.mutate()} loading={save.isPending} disabled={!!parseError} className="!w-auto flex-1">Save</PrimaryButton>
            <OutlineButton onClick={() => setEditing(false)} disabled={save.isPending} className="!w-auto flex-1">Cancel</OutlineButton>
          </div>
        </>
      )}
    </div>
  );
}

export function MetadataValueDetailPage() {
  const { key, value } = useParams();
  const navigate = useNavigate();
  const [section, setSection] = useUrlState("tab", "roles");
  const { data: attribute, isLoading, error } = useQuery({ queryKey: ["metadata-attribute", key], queryFn: () => getMetadataAttribute(key) });
  const entry = (attribute?.values || []).find((v) => v.value === value) || null;
  const active = VALUE_SECTIONS.find((s) => s.key === section) || VALUE_SECTIONS[0];

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <TopBar title="Metadata Value" onBack={() => navigate(-1)} />
      <div className="flex-1 overflow-y-auto pb-24">
        {isLoading && <SkeletonList rows={5} />}
        {error && <ErrorBox message={error.response?.data?.error || error.message} />}
        {attribute && !entry && (
          <EmptyState icon={Tags} title="Value not found" subtitle={`"${value}" isn't a value of ${attribute.name || key}`} />
        )}
        {attribute && entry && (
          <>
            <div className="px-4 py-4 border-b border-gray-100 flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-indigo-50 flex items-center justify-center flex-shrink-0">
                <Tags size={18} className="text-indigo-600" />
              </div>
              <div className="min-w-0 flex-1">
                <h2 className="text-base font-semibold text-gray-900 truncate">{entry.name || entry.value}</h2>
                <p className="text-xs text-gray-500 mt-0.5 truncate">
                  {attribute.name || key} · <span className="font-mono">{entry.value}</span>
                </p>
              </div>
              {entry.status && entry.status !== "active" && (
                <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full border bg-amber-50 text-amber-700 border-amber-200 flex-shrink-0">{entry.status}</span>
              )}
            </div>
            <div className="flex min-h-full">
              <div className="w-24 flex-shrink-0 border-r border-gray-100 py-2">
                {VALUE_SECTIONS.map(({ key: k, label, Icon }) => (
                  <button
                    key={k}
                    onClick={() => setSection(k)}
                    className={`w-full flex flex-col items-center gap-1 px-2 py-3 text-xs font-medium text-center transition-colors ${
                      active.key === k ? "text-blue-600 bg-blue-50" : "text-gray-400 hover:text-gray-600"
                    }`}
                  >
                    <Icon size={16} />
                    {label}
                  </button>
                ))}
              </div>
              <div className="flex-1 min-w-0">
                {active.key === "json"
                  ? <ValueJsonPanel attrKey={key} attribute={attribute} value={entry} />
                  // keyed: each tab is its own list, with its own search box.
                  : <TaggedAccessPanel key={active.key} attrKey={key} value={entry.value} section={active} navigate={navigate} />}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
