import { useMemo, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Upload, ChevronRight, ChevronDown, ChevronUp, FileJson, X, Copy } from "lucide-react";
import toast from "react-hot-toast";
import { restoreSpConfig, getCredentials } from "../lib/sailpoint";
import { TopBar } from "../components/TopBar";
import { BackupRestoreTitleMenu } from "../components/BackupRestoreTitleMenu";
import { ResultDialog } from "../components/ResultDialog";
import { PrimaryButton, OutlineButton, EmptyState, ConfirmModal, SearchBar, IconButton } from "../components/ui";
import { escapeHtml, highlightJson, JSON_EDITOR_STYLE } from "../components/JsonEditor";

const MAX_BROWSE_DEPTH = 3;

// SP-Config export metadata fields, shown as a read-only header rather than
// browsable/selectable rows — "options" is excluded even from the header
// since it's the export's own request config, not a restorable object.
const HEADER_FIELDS = ["version", "timestamp", "tenant", "description"];
const EXCLUDE_FROM_SELECTION = new Set(["version", "timestamp", "tenant", "description", "options"]);

// How many of the file's own top-level keys count as "near the top" when
// checking for the header fields — generous enough to cover version/tenant/
// timestamp/description plus a couple of export-bookkeeping fields (options,
// excludedTypes/includedTypes) ahead of the real objects list, in whatever
// order SailPoint happens to emit them, without accepting a JSON file that
// merely has these words buried deep in unrelated content.
const HEADER_FIELD_SCAN_WINDOW = 8;

// A real SP-Config export always carries its own version/timestamp/tenant/
// description near the top — checking for them here rejects an unrelated or
// hand-edited JSON file before it's browsable, rather than letting someone
// select all/none of a tree that was never a real backup to begin with.
function isValidSpConfigExport(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  const topKeys = new Set(Object.keys(obj).slice(0, HEADER_FIELD_SCAN_WINDOW));
  return HEADER_FIELDS.every((k) => topKeys.has(k));
}

function childEntries(value) {
  if (Array.isArray(value)) return value.map((v, i) => [i, v]);
  if (value && typeof value === "object") return Object.entries(value);
  return [];
}

function humanizeKey(key) {
  const s = String(key);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function humanizeType(type) {
  return String(type)
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatHeaderValue(key, value) {
  if (key === "timestamp") {
    const d = new Date(value);
    if (!isNaN(d.getTime())) return d.toLocaleString();
  }
  return String(value);
}

// Prefers an SP-Config-style exported object's own self.type/self.name over
// the raw key/index, since "SOURCE: Active Directory" is a lot more useful
// to browse by than "objects[7]" — falls back to a generic label for any
// other JSON shape.
function nodeLabel(key, value) {
  if (value && typeof value === "object" && !Array.isArray(value) && value.self && typeof value.self === "object") {
    const { type, name } = value.self;
    if (type) return name ? `${type}: ${name}` : String(type);
  }
  if (Array.isArray(value)) return `${key} (${value.length} item${value.length === 1 ? "" : "s"})`;
  if (value && typeof value === "object") {
    const n = Object.keys(value).length;
    return `${key} (${n} field${n === 1 ? "" : "s"})`;
  }
  return `${key}: ${JSON.stringify(value)}`;
}

// Keeps only the branches under a selected path — a selected node is
// included whole (no need to look further down it); an unselected node is
// kept only as a container for whichever descendants ARE selected, so the
// original nested shape (e.g. { objects: [...] }) is preserved without
// dragging along everything that wasn't picked.
function pruneToSelection(value, path, selected) {
  if (selected.has(JSON.stringify(path))) return value;
  if (Array.isArray(value)) {
    const kept = [];
    value.forEach((v, i) => {
      const child = pruneToSelection(v, [...path, i], selected);
      if (child !== undefined) kept.push(child);
    });
    return kept.length > 0 ? kept : undefined;
  }
  if (value && typeof value === "object") {
    const kept = {};
    let any = false;
    for (const [k, v] of Object.entries(value)) {
      const child = pruneToSelection(v, [...path, k], selected);
      if (child !== undefined) {
        kept[k] = child;
        any = true;
      }
    }
    return any ? kept : undefined;
  }
  return undefined;
}

// Groups each top-level array (in practice, sp-config's "objects" list) by
// object type so the tree can be browsed/collapsed by type instead of as
// one long flat list. Header/options fields are dropped entirely — they're
// shown separately as read-only metadata, not selectable restore targets.
function buildSections(rootData) {
  if (!rootData || typeof rootData !== "object") return [];
  const sections = [];
  for (const [key, value] of Object.entries(rootData)) {
    if (EXCLUDE_FROM_SELECTION.has(key)) continue;
    if (Array.isArray(value)) {
      const groupsMap = new Map();
      value.forEach((item, idx) => {
        const type = (item && typeof item === "object" && item.self && item.self.type) || "Other";
        if (!groupsMap.has(type)) groupsMap.set(type, []);
        groupsMap.get(type).push({ path: [key, idx], value: item });
      });
      const groups = [...groupsMap.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([type, items]) => ({
          type,
          groupKey: JSON.stringify([key, "::group::", type]),
          items,
        }));
      sections.push({ key, kind: "grouped", groups });
    } else {
      sections.push({ key, kind: "single", path: [key], value });
    }
  }
  return sections;
}

// Every path (real or, for group headers, synthetic) that should get a
// collapse/expand chevron — real object fields are capped at
// MAX_BROWSE_DEPTH, matching the "browse up to 3 levels deep" behavior.
function collectExpandableKeys(value, path, out) {
  if (path.length >= MAX_BROWSE_DEPTH) return;
  const children = childEntries(value);
  if (children.length === 0) return;
  out.push(JSON.stringify(path));
  for (const [k, v] of children) collectExpandableKeys(v, [...path, k], out);
}

// sp-config export items are wrapped as { version, self: {...}, object: {...} }
// — version/self are export bookkeeping, not restorable content, so when
// browsing into an item, skip straight to its "object" contents rather than
// showing version/self/object as three rows to click through.
function unwrapObjectShape(value) {
  const isWrapped =
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    value.object &&
    typeof value.object === "object" &&
    (Object.prototype.hasOwnProperty.call(value, "self") || Object.prototype.hasOwnProperty.call(value, "version"));
  return isWrapped ? { value: value.object, prefix: ["object"] } : { value, prefix: [] };
}

// Browsing goes 3 levels deep (group/section → item → item's own fields),
// but selection only makes sense at the first two — picking a single nested
// field within an item isn't a meaningful restore unit, so the deepest level
// is browsable (still expandable) but not checkable; checking an item always
// carries all of its fields along.
const MAX_SELECTABLE_DEPTH = 2;

// Read-only view of one backup object's JSON, opened by clicking a
// selectable node's name. An sp-config item shows its "object" (what gets
// restored) — its version/self export bookkeeping is summarised above it.
function JsonViewModal({ title, value, onClose }) {
  const { value: shown } = unwrapObjectShape(value);
  const pretty = useMemo(() => JSON.stringify(shown, null, 2), [shown]);
  const self = value && typeof value === "object" && !Array.isArray(value) ? value.self : null;
  return (
    <div className="fixed inset-0 bg-black/30 z-40 flex items-end md:items-center justify-center" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="bg-white w-full max-w-3xl md:mx-4 rounded-t-2xl md:rounded-2xl shadow-xl max-h-[85vh] flex flex-col">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-100">
          <FileJson size={18} className="text-gray-500 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <h2 className="text-base font-semibold text-gray-900 truncate">{title}</h2>
            {self?.type && (
              <p className="text-xs text-gray-500 truncate">{humanizeType(self.type)}{self.id ? ` · ${self.id}` : ""}</p>
            )}
          </div>
          <IconButton
            icon={Copy}
            title="Copy JSON"
            onClick={() => navigator.clipboard.writeText(pretty).then(() => toast.success("JSON copied"), () => toast.error("Couldn't copy"))}
          />
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-1" title="Close"><X size={20} /></button>
        </div>
        <div className="flex-1 overflow-auto p-4">
          <pre
            className="border border-gray-200 rounded-xl text-gray-800 bg-gray-50"
            style={JSON_EDITOR_STYLE}
            dangerouslySetInnerHTML={{ __html: highlightJson(escapeHtml(pretty)) }}
          />
        </div>
      </div>
    </div>
  );
}

function TreeNode({ path, keyLabel, value, depth, label, selected, onToggleSelect, expandedKeys, onToggleExpand, onViewJson }) {
  const pathKey = JSON.stringify(path);
  const { value: effectiveValue, prefix } = unwrapObjectShape(value);
  const children = depth < MAX_BROWSE_DEPTH ? childEntries(effectiveValue) : [];
  const hasChildren = children.length > 0;
  const expanded = expandedKeys.has(pathKey);
  const isSelected = selected.has(pathKey);
  const selectable = depth <= MAX_SELECTABLE_DEPTH;

  return (
    <div>
      <div className="flex items-center gap-2 py-1.5 pr-3" style={{ paddingLeft: (depth - 1) * 18 + 8 }}>
        {hasChildren ? (
          <button onClick={() => onToggleExpand(pathKey)} className="text-gray-400 flex-shrink-0">
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        ) : (
          <span className="w-3.5 flex-shrink-0" />
        )}
        {selectable ? (
          <input
            type="checkbox"
            checked={isSelected}
            onChange={() => onToggleSelect(pathKey)}
            className="w-4 h-4 rounded border-gray-300 flex-shrink-0"
          />
        ) : (
          <span className="w-4 flex-shrink-0" />
        )}
        {selectable && onViewJson ? (
          <button
            type="button"
            onClick={() => onViewJson(label || nodeLabel(keyLabel, value), value)}
            className="text-sm text-gray-800 truncate text-left hover:text-blue-600 hover:underline"
            title="View JSON"
          >
            {label || nodeLabel(keyLabel, value)}
          </button>
        ) : (
          <span className="text-sm text-gray-800 truncate">{label || nodeLabel(keyLabel, value)}</span>
        )}
      </div>
      {hasChildren && expanded && (
        <div>
          {children.map(([k, v]) => (
            <TreeNode
              key={k}
              path={[...path, ...prefix, k]}
              keyLabel={k}
              value={v}
              depth={depth + 1}
              selected={selected}
              onToggleSelect={onToggleSelect}
              expandedKeys={expandedKeys}
              onToggleExpand={onToggleExpand}
              onViewJson={onViewJson}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// selected.size counts every real path needed to restore the right data
// (e.g. all N items in a fully-checked group), which is the correct payload
// but not what the user actually clicked. This instead counts UI selection
// actions: a fully-selected group counts as the one row the user checked,
// not its N underlying items; individually-checked items/fields each count
// as one.
function computeSelectionCount(sections, selected) {
  let count = 0;
  const selectedArr = [...selected].map((s) => JSON.parse(s));
  sections.forEach((s) => {
    if (s.kind === "grouped") {
      s.groups.forEach((g) => {
        const selectedItemPaths = g.items.filter((item) => selected.has(JSON.stringify(item.path)));
        if (g.items.length > 0 && selectedItemPaths.length === g.items.length) {
          count += 1;
        } else {
          count += selectedItemPaths.length;
        }
      });
      selectedArr.forEach((p) => {
        if (p[0] === s.key && p.length > 2) count += 1; // a granular field pick within an item
      });
    } else if (selected.has(JSON.stringify(s.path))) {
      count += 1;
    }
  });
  return count;
}

function itemLabel(item) {
  const name = item.value && typeof item.value === "object" ? item.value.self?.name : null;
  return name || `Item ${item.path[item.path.length - 1] + 1}`;
}

function GroupNode({ group, selected, onToggleGroup, expandedKeys, onToggleExpand, onToggleSelect, forceExpanded, onViewJson }) {
  const expanded = forceExpanded || expandedKeys.has(group.groupKey);
  const groupSelected = group.items.length > 0 && group.items.every((item) => selected.has(JSON.stringify(item.path)));

  return (
    <div>
      <div className="flex items-center gap-2 py-1.5 pr-3" style={{ paddingLeft: 8 }}>
        <button onClick={() => onToggleExpand(group.groupKey)} className="text-gray-400 flex-shrink-0">
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <input
          type="checkbox"
          checked={groupSelected}
          onChange={() => onToggleGroup(group)}
          className="w-4 h-4 rounded border-gray-300 flex-shrink-0"
        />
        <span className="text-sm font-medium text-gray-800 truncate">
          {humanizeType(group.type)} ({group.items.length})
        </span>
      </div>
      {expanded && (
        <div>
          {group.items.map((item) => (
            <TreeNode
              key={JSON.stringify(item.path)}
              path={item.path}
              keyLabel={item.path[item.path.length - 1]}
              value={item.value}
              depth={2}
              label={itemLabel(item)}
              selected={selected}
              onToggleSelect={onToggleSelect}
              expandedKeys={expandedKeys}
              onToggleExpand={onToggleExpand}
              onViewJson={onViewJson}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function RestorePage() {
  const fileInputRef = useRef(null);
  const [fileName, setFileName] = useState(null);
  const [rootData, setRootData] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [expandedKeys, setExpandedKeys] = useState(() => new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [jsonView, setJsonView] = useState(null); // { title, value } of the object whose JSON is open
  const [result, setResult] = useState(null);
  const [search, setSearch] = useState("");

  const sections = rootData ? buildSections(rootData) : [];
  const groupedKeys = new Set(sections.filter((s) => s.kind === "grouped").map((s) => s.key));

  // Search only narrows what's browsable/visible — it never changes what's
  // selected, so Select All / Expand All / the restore payload all still
  // operate against the full, unfiltered `sections`.
  const query = search.trim().toLowerCase();
  const displaySections = !query
    ? sections
    : sections
        .map((s) => {
          if (s.kind !== "grouped") return s;
          const groups = s.groups
            .map((g) => ({
              ...g,
              items: g.items.filter(
                (item) => itemLabel(item).toLowerCase().includes(query) || humanizeType(g.type).toLowerCase().includes(query)
              ),
            }))
            .filter((g) => g.items.length > 0);
          return { ...s, groups };
        })
        .filter((s) => s.kind !== "grouped" || s.groups.length > 0);
  const hasSearchResults = !query || displaySections.some((s) => (s.kind === "grouped" ? s.groups.length > 0 : true));

  const allSelectablePaths = sections.flatMap((s) =>
    s.kind === "grouped" ? s.groups.flatMap((g) => g.items.map((i) => i.path)) : [s.path]
  );

  const rawExpandable = [];
  if (rootData) collectExpandableKeys(rootData, [], rawExpandable);
  const expandableKeys = rawExpandable.filter((keyStr) => {
    const p = JSON.parse(keyStr);
    if (EXCLUDE_FROM_SELECTION.has(p[0])) return false;
    if (p.length === 1 && groupedKeys.has(p[0])) return false; // replaced by group headers below
    return true;
  });
  sections.forEach((s) => {
    if (s.kind === "grouped") {
      s.groups.forEach((g) => {
        if (g.items.length > 0) expandableKeys.push(g.groupKey);
      });
    }
  });
  const allExpanded = expandableKeys.length > 0 && expandableKeys.every((k) => expandedKeys.has(k));

  const headerInfo = HEADER_FIELDS.filter((k) => rootData && rootData[k] !== undefined && rootData[k] !== null && rootData[k] !== "");
  const selectionCount = computeSelectionCount(sections, selected);

  function handleFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        if (!isValidSpConfigExport(parsed)) {
          toast.error(
            "That doesn't look like a Backup Configuration export — expected Version, Timestamp, Tenant, and " +
            "Description near the top of the file."
          );
          return;
        }
        const currentTenant = getCredentials()?.tenant;
        if (currentTenant && parsed.tenant !== currentTenant) {
          toast.error(`This backup is from "${parsed.tenant}" — you're signed in to "${currentTenant}". Sign in to that tenant to restore it.`);
          return;
        }
        setRootData(parsed);
        setFileName(file.name);
        setSelected(new Set());
        setExpandedKeys(new Set());
      } catch (err) {
        toast.error("That file isn't valid JSON.");
      }
    };
    reader.onerror = () => toast.error("Couldn't read that file.");
    reader.readAsText(file);
    e.target.value = ""; // allow re-selecting the same file after a reset
  }

  function toggleSelect(pathKey) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(pathKey)) next.delete(pathKey);
      else next.add(pathKey);
      return next;
    });
  }

  function toggleGroup(group) {
    setSelected((prev) => {
      const next = new Set(prev);
      const groupSelected = group.items.length > 0 && group.items.every((item) => next.has(JSON.stringify(item.path)));
      group.items.forEach((item) => {
        const key = JSON.stringify(item.path);
        if (groupSelected) next.delete(key);
        else next.add(key);
      });
      return next;
    });
  }

  function toggleSelectAll() {
    const allSelected = allSelectablePaths.length > 0 && allSelectablePaths.every((p) => selected.has(JSON.stringify(p)));
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(allSelectablePaths.map((p) => JSON.stringify(p))));
    }
  }

  function toggleExpandAll() {
    if (allExpanded) {
      setExpandedKeys(new Set());
    } else {
      setExpandedKeys(new Set(expandableKeys));
    }
  }

  function toggleExpandOne(pathKey) {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(pathKey)) next.delete(pathKey);
      else next.add(pathKey);
      return next;
    });
  }

  const selectedPathSet = new Set(selected);

  const restoreMutation = useMutation({
    mutationFn: () => {
      const payload = pruneToSelection(rootData, [], selectedPathSet) || {};
      return restoreSpConfig(payload);
    },
    onSuccess: () => {
      setConfirmOpen(false);
      setResult({ success: true, message: "The selected objects were imported successfully." });
    },
    onError: (err) => {
      setConfirmOpen(false);
      setResult({ success: false, message: err.response?.data?.error || err.message });
    },
  });

  function reset() {
    setRootData(null);
    setFileName(null);
    setSelected(new Set());
    setExpandedKeys(new Set());
    setSearch("");
  }

  const allSelected = allSelectablePaths.length > 0 && allSelectablePaths.every((p) => selected.has(JSON.stringify(p)));

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <TopBar title={<BackupRestoreTitleMenu active="Restore Configuration" />} />
      <div className="flex-1 overflow-y-auto pb-24">
        <div className="px-4 py-5 border-b border-gray-100">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-full bg-slate-100 flex items-center justify-center flex-shrink-0">
              <Upload size={18} className="text-slate-700" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-gray-900">Restore</h2>
              <p className="text-xs text-gray-500 mt-0.5">
                Upload a previous backup file, choose which objects to restore, then import just those into ISC.
              </p>
            </div>
          </div>

          <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 mb-3">
            <p className="text-xs text-amber-800">
              Restore is additive only. It brings back the objects you select as they existed in the backup, but it
              will not remove any objects created after that backup was taken.
            </p>
          </div>

          <input ref={fileInputRef} type="file" accept=".json,application/json" onChange={handleFile} className="hidden" />
          <div className="flex items-center gap-2">
            <OutlineButton onClick={() => fileInputRef.current?.click()} className="!w-auto">
              <FileJson size={16} />
              {fileName ? "Choose a Different File" : "Choose Backup File"}
            </OutlineButton>
            {fileName && (
              <button onClick={reset} className="text-xs font-medium text-red-600 hover:text-red-700">
                Clear
              </button>
            )}
          </div>
          {fileName && <p className="text-xs text-gray-400 mt-2">{fileName}</p>}

          {headerInfo.length > 0 && (
            <div className="mt-3 rounded-lg bg-gray-50 border border-gray-100 px-3 py-2 space-y-0.5">
              {headerInfo.map((k) => (
                <p key={k} className="text-xs text-gray-500">
                  <span className="font-medium text-gray-600">{humanizeKey(k)}:</span> {formatHeaderValue(k, rootData[k])}
                </p>
              ))}
            </div>
          )}
        </div>

        {!rootData && (
          <EmptyState icon={FileJson} title="No file loaded" subtitle="Choose a backup JSON file to browse its contents" />
        )}

        {rootData && allSelectablePaths.length === 0 && (
          <EmptyState icon={FileJson} title="Empty file" subtitle="This JSON file has no restorable objects" />
        )}

        {rootData && allSelectablePaths.length > 0 && (
          <>
            <div className="border-b border-gray-100">
              <SearchBar value={search} onChange={setSearch} placeholder="Search by type or name…" />
            </div>
            <div className="flex items-center justify-between px-4 py-2 border-b border-gray-100">
              <label className="flex items-center gap-2 text-xs text-gray-500">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleSelectAll}
                  className="w-4 h-4 rounded border-gray-300"
                />
                Select All
              </label>
              {expandableKeys.length > 0 && (
                <button
                  onClick={toggleExpandAll}
                  className="flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-700"
                >
                  {allExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                  {allExpanded ? "Collapse All" : "Expand All"}
                </button>
              )}
            </div>
            {!hasSearchResults && (
              <EmptyState icon={FileJson} title="No matches" subtitle={`No objects match "${search}"`} />
            )}
            <div className="pb-2">
              {displaySections.map((s) =>
                s.kind === "grouped" ? (
                  <div key={s.key}>
                    {s.groups.map((g) => (
                      <GroupNode
                        key={g.groupKey}
                        group={g}
                        forceExpanded={!!query}
                        selected={selected}
                        onToggleGroup={toggleGroup}
                        expandedKeys={expandedKeys}
                        onToggleExpand={toggleExpandOne}
                        onToggleSelect={toggleSelect}
                        onViewJson={(title, value) => setJsonView({ title, value })}
                      />
                    ))}
                  </div>
                ) : (
                  <TreeNode
                    key={s.key}
                    path={s.path}
                    keyLabel={s.key}
                    value={s.value}
                    depth={1}
                    selected={selected}
                    onToggleSelect={toggleSelect}
                    expandedKeys={expandedKeys}
                    onToggleExpand={toggleExpandOne}
                    onViewJson={(title, value) => setJsonView({ title, value })}
                  />
                )
              )}
            </div>
          </>
        )}
      </div>

      {rootData && (
        <div className="flex-shrink-0 border-t border-gray-100 bg-white px-4 py-3">
          <PrimaryButton onClick={() => setConfirmOpen(true)} disabled={selected.size === 0 || restoreMutation.isPending}>
            <Upload size={16} />
            {selectionCount > 0 ? `Restore Selected (${selectionCount})` : "Select objects to restore"}
          </PrimaryButton>
        </div>
      )}

      {confirmOpen && (
        <ConfirmModal
          title={`Restore ${selectionCount} selected item${selectionCount === 1 ? "" : "s"}?`}
          message="This imports the selected objects into ISC via SP-Config — it writes live configuration and can overwrite existing objects with the same identifiers. It is additive only and will not remove objects created since the backup. This cannot be undone automatically."
          confirmLabel="Restore"
          danger
          pending={restoreMutation.isPending}
          onConfirm={() => restoreMutation.mutate()}
          onCancel={() => setConfirmOpen(false)}
        />
      )}

      {jsonView && <JsonViewModal title={jsonView.title} value={jsonView.value} onClose={() => setJsonView(null)} />}

      {result && (
        <ResultDialog
          title={result.success ? "Restore Complete" : "Restore Failed"}
          success={result.success}
          message={result.message}
          onClose={() => setResult(null)}
        />
      )}
    </div>
  );
}
