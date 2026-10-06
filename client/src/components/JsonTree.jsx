import { useMemo, useRef, useState } from "react";
import { ChevronRight, ChevronDown, Plus, Trash2, Copy, Undo2, Redo2, ClipboardPaste, Search, Printer } from "lucide-react";
import toast from "react-hot-toast";
import { JsonEditSurface, JsonFindReplaceBar, useJsonFind, jsonParseError, printJson } from "./JsonEditor";
import { getJsonEditMode } from "../lib/jsonEditMode";
import { handleBracketKey, JSON_QUOTES } from "../lib/bracketPairs";
import { JsonAiFix } from "./JsonAiFix";

// ─── Tree mode for JSON editing ─────────────────────────────────────────────
// The document is rendered as an editable tree and REBUILT from it on every
// change, so text that doesn't parse is unrepresentable — no quotes, commas,
// or braces are ever typed, strings need no escaping, duplicate keys and
// trailing commas can't exist. Nothing legitimate is lost: any key can be
// renamed, any value retyped, any node added/removed/duplicated, and a JSON
// fragment can be pasted over any subtree (validated at that one boundary).
// Text mode remains as a synced second tab for power edits.

// Immutable path helpers — path segments are object keys (string) or array
// indices (number).
function getAt(doc, path) {
  let cur = doc;
  for (const seg of path) cur = cur?.[seg];
  return cur;
}
function setAt(doc, path, value) {
  if (path.length === 0) return value;
  const [head, ...rest] = path;
  if (Array.isArray(doc)) {
    const next = [...doc];
    next[head] = setAt(doc[head], rest, value);
    return next;
  }
  return { ...doc, [head]: setAt(doc?.[head], rest, value) };
}
function deleteAt(doc, path) {
  const parent = path.slice(0, -1);
  const last = path[path.length - 1];
  const container = getAt(doc, parent);
  if (Array.isArray(container)) {
    return setAt(doc, parent, container.filter((_, i) => i !== last));
  }
  const next = { ...container };
  delete next[last];
  return setAt(doc, parent, next);
}
// Rename preserving property order.
function renameAt(doc, path, newKey) {
  const parent = path.slice(0, -1);
  const oldKey = path[path.length - 1];
  const container = getAt(doc, parent);
  const rebuilt = {};
  for (const [k, v] of Object.entries(container)) rebuilt[k === oldKey ? newKey : k] = v;
  return setAt(doc, parent, rebuilt);
}

const TYPE_OF = (v) =>
  v === null ? "null" : Array.isArray(v) ? "arr" : typeof v === "object" ? "obj" : typeof v === "number" ? "num" : typeof v === "boolean" ? "bool" : "str";

function convertTo(value, type) {
  switch (type) {
    case "str": return value !== null && typeof value === "object" ? JSON.stringify(value) : String(value ?? "");
    case "num": { const n = Number(value); return Number.isFinite(n) ? n : 0; }
    case "bool": return value === true || value === "true" || value === 1;
    case "null": return null;
    case "obj": return {};
    case "arr": return [];
    default: return value;
  }
}

const TYPE_STYLES = {
  str: "bg-emerald-50 text-emerald-700 border-emerald-200",
  // Fixed blue, not the brand accent — see .json-type-num in index.css.
  num: "json-type-num border",
  bool: "bg-amber-50 text-amber-700 border-amber-200",
  null: "bg-gray-50 text-gray-500 border-gray-200",
  obj: "bg-violet-50 text-violet-700 border-violet-200",
  arr: "bg-pink-50 text-pink-700 border-pink-200",
};

function TypeBadge({ value, onConvert, disabled }) {
  const t = TYPE_OF(value);
  return (
    <select
      value={t}
      disabled={disabled}
      onChange={(e) => onConvert(convertTo(value, e.target.value))}
      title="Change type"
      className={`text-[9px] font-semibold rounded-md border px-1 py-0.5 outline-none flex-shrink-0 ${TYPE_STYLES[t]} ${disabled ? "opacity-60" : "cursor-pointer"}`}
    >
      {["str", "num", "bool", "null", "obj", "arr"].map((x) => (
        <option key={x} value={x}>{x}</option>
      ))}
    </select>
  );
}

// Inline key rename — uncontrolled, committed on blur/Enter; collisions and
// empties revert with a toast instead of silently corrupting the object.
function KeyInput({ k, siblings, onRename, disabled }) {
  return (
    <input
      key={k}
      defaultValue={k}
      disabled={disabled}
      spellCheck={false}
      onKeyDown={(e) => e.key === "Enter" && e.target.blur()}
      onBlur={(e) => {
        const next = e.target.value;
        if (next === k) return;
        if (!next) { e.target.value = k; toast.error("Key can't be empty"); return; }
        if (siblings.includes(next)) { e.target.value = k; toast.error(`Key "${next}" already exists`); return; }
        onRename(next);
      }}
      className="font-mono text-xs text-violet-700 bg-transparent outline-none focus:bg-violet-50 focus:border focus:border-violet-200 rounded px-0.5 min-w-0"
      style={{ width: `${Math.max(3, k.length + 1)}ch` }}
    />
  );
}

function PasteBox({ onApply, onClose }) {
  const [text, setText] = useState("");
  const err = text.trim() ? jsonParseError(text) : null;
  return (
    <div className="ml-5 mt-1 mb-1 border border-blue-200 rounded-lg p-2 bg-blue-50/40">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        spellCheck={false}
        placeholder="Paste a JSON fragment — it replaces this subtree"
        className="w-full font-mono text-[11px] border border-gray-200 rounded-lg px-2 py-1.5 bg-white outline-none focus:border-blue-400"
      />
      {err && <p className="text-[10px] text-red-600 mt-0.5">{err}</p>}
      <div className="flex gap-2 mt-1">
        <button
          type="button"
          disabled={!text.trim() || !!err}
          onClick={() => onApply(JSON.parse(text))}
          className="text-[11px] font-medium text-blue-600 disabled:opacity-40"
        >
          Apply
        </button>
        <button type="button" onClick={onClose} className="text-[11px] text-gray-400">Cancel</button>
      </div>
    </div>
  );
}

// Per-level indent in px, and where the guide line sits within it: the row
// has px-1.5 (6px) then a 14px chevron column, so 13px lands the line under
// the chevron's centre; the rest is the gap to the child row.
const TREE_INDENT = 24;
const TREE_GUIDE_OFFSET = 13;

function TreeNode({ value, path, parentKeys, keyLabel, doc, commit, depth, collapsed, toggleCollapse, readOnly }) {
  const [pasting, setPasting] = useState(false);
  const t = TYPE_OF(value);
  const isContainer = t === "obj" || t === "arr";
  const id = JSON.stringify(path);
  const isCollapsed = collapsed.has(id);
  const inArray = typeof path[path.length - 1] === "number";

  const row = (
    <div className={`group flex items-center gap-1.5 px-1.5 py-1 rounded-lg hover:bg-gray-50 ${readOnly ? "opacity-50" : ""}`}>
      {isContainer ? (
        <button type="button" onClick={() => toggleCollapse(id)} className="text-gray-400 flex-shrink-0 w-3.5">
          {isCollapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
        </button>
      ) : (
        <span className="w-3.5 flex-shrink-0" />
      )}

      {keyLabel !== undefined && (
        inArray ? (
          <span className="font-mono text-[11px] text-gray-400 flex-shrink-0">[{keyLabel}]</span>
        ) : (
          <>
            <KeyInput
              k={String(keyLabel)}
              siblings={parentKeys.filter((x) => x !== keyLabel)}
              disabled={readOnly}
              onRename={(nk) => commit(renameAt(doc, path, nk))}
            />
            <span className="text-gray-300 flex-shrink-0">:</span>
          </>
        )
      )}

      <TypeBadge value={value} disabled={readOnly} onConvert={(nv) => commit(setAt(doc, path, nv))} />

      {t === "str" && (
        <input
          value={value}
          disabled={readOnly}
          spellCheck={false}
          onChange={(e) => commit(setAt(doc, path, e.target.value), { coalesce: true })}
          className="font-mono text-xs text-emerald-700 flex-1 min-w-0 bg-transparent outline-none focus:bg-white focus:border focus:border-blue-300 rounded px-1 py-0.5"
        />
      )}
      {t === "num" && (
        <input
          type="number"
          value={value}
          disabled={readOnly}
          onChange={(e) => commit(setAt(doc, path, e.target.value === "" ? 0 : Number(e.target.value)), { coalesce: true })}
          className="font-mono text-xs text-blue-700 w-32 bg-transparent outline-none focus:bg-white focus:border focus:border-blue-300 rounded px-1 py-0.5"
        />
      )}
      {t === "bool" && (
        <button
          type="button"
          disabled={readOnly}
          onClick={() => commit(setAt(doc, path, !value))}
          title="Flip"
          className="font-mono text-xs text-amber-700 hover:underline"
        >
          {String(value)} ⇄
        </button>
      )}
      {t === "null" && <span className="font-mono text-xs text-gray-400">null</span>}
      {isContainer && (
        <span className="text-[11px] text-gray-400">
          {t === "obj" ? `${Object.keys(value).length} propert${Object.keys(value).length === 1 ? "y" : "ies"}` : `${value.length} item${value.length === 1 ? "" : "s"}`}
        </span>
      )}

      {!readOnly && (
        <span className="ml-auto flex items-center gap-1.5 opacity-0 group-hover:opacity-100 flex-shrink-0">
          {isContainer && (
            <>
              <button
                type="button"
                title={t === "obj" ? "Add property" : "Add item"}
                onClick={() => {
                  if (t === "obj") {
                    let k = "newProperty"; let i = 1;
                    while (k in value) k = `newProperty${i++}`;
                    commit(setAt(doc, path, { ...value, [k]: "" }));
                  } else {
                    commit(setAt(doc, path, [...value, ""]));
                  }
                  if (isCollapsed) toggleCollapse(id);
                }}
                className="text-gray-400 hover:text-blue-600"
              >
                <Plus size={12} />
              </button>
              <button type="button" title="Paste JSON over this subtree" onClick={() => setPasting((v) => !v)} className="text-gray-400 hover:text-blue-600">
                <ClipboardPaste size={12} />
              </button>
            </>
          )}
          {inArray && (
            <button
              type="button"
              title="Duplicate item"
              onClick={() => {
                const parent = getAt(doc, path.slice(0, -1));
                const idx = path[path.length - 1];
                const next = [...parent.slice(0, idx + 1), JSON.parse(JSON.stringify(value)), ...parent.slice(idx + 1)];
                commit(setAt(doc, path.slice(0, -1), next));
              }}
              className="text-gray-400 hover:text-blue-600"
            >
              <Copy size={12} />
            </button>
          )}
          {path.length > 0 && (
            <button type="button" title="Remove" onClick={() => commit(deleteAt(doc, path))} className="text-gray-400 hover:text-red-600">
              <Trash2 size={12} />
            </button>
          )}
        </span>
      )}
    </div>
  );

  return (
    <div>
      {row}
      {pasting && (
        <div style={{ marginLeft: TREE_INDENT }}>
          <PasteBox onApply={(v) => { commit(setAt(doc, path, v)); setPasting(false); }} onClose={() => setPasting(false)} />
        </div>
      )}
      {isContainer && !isCollapsed && !readOnly && (
        /* Indent guide. Each container's children sit in a block with a
           left border, so recursion draws one vertical line per nesting
           level and a child can always be traced back to its parent —
           rows used to just shift right by 16px each with nothing
           connecting them, which at three or four levels deep reads as a
           flat list. The line starts under the parent's chevron; hovering
           anywhere in the block darkens its own level's line. */
        <div
          className="border-l border-gray-200 hover:border-gray-300 transition-colors"
          style={{ marginLeft: TREE_GUIDE_OFFSET, paddingLeft: TREE_INDENT - TREE_GUIDE_OFFSET }}
        >
          {t === "obj"
            ? Object.entries(value).map(([k, v]) => (
                <TreeNode
                  key={k} value={v} path={[...path, k]} parentKeys={Object.keys(value)} keyLabel={k}
                  doc={doc} commit={commit} depth={depth + 1} collapsed={collapsed} toggleCollapse={toggleCollapse} readOnly={false}
                />
              ))
            : value.map((v, i) => (
                <TreeNode
                  key={i} value={v} path={[...path, i]} parentKeys={[]} keyLabel={i}
                  doc={doc} commit={commit} depth={depth + 1} collapsed={collapsed} toggleCollapse={toggleCollapse} readOnly={false}
                />
              ))}
        </div>
      )}
    </div>
  );
}

/**
 * Tree | Text tabbed editor over a JSON text buffer — a drop-in wrapper for
 * places that previously rendered JsonEditSurface directly. `text` stays the
 * single source of truth: tree edits serialize back into it immediately, so
 * whichever mode is active, the buffer the owner saves is current (and, from
 * Tree mode, guaranteed valid). Invalid text disables the Tree tab until fixed.
 */
export function JsonEditTabs({ text, onChange, minHeight = "200px", readOnlyKeys = [], title = "JSON" }) {
  // Opens in the user's preferred view (Preferences > JSON Edit Mode, Text
  // by default). JSON that doesn't parse always opens in Text regardless:
  // Tree can't show it, and Text is where it gets fixed.
  const [mode, setMode] = useState(() => (jsonParseError(text) ? "text" : getJsonEditMode()));
  const [findOpen, setFindOpen] = useState(false);
  const textareaRef = useRef(null);
  // Held here, not in the bar: the editing surface paints every match, so
  // both need the same match list and the same idea of which one is current.
  const find = useJsonFind({ text, onChange, textareaRef, enabled: findOpen });
  const [collapsed, setCollapsed] = useState(() => new Set());
  const [undoStack, setUndoStack] = useState([]);
  const [redoStack, setRedoStack] = useState([]);
  const parseError = jsonParseError(text);
  const doc = useMemo(() => {
    try { return JSON.parse(text); } catch { return undefined; }
  }, [text]);
  const readOnlySet = useMemo(() => new Set(readOnlyKeys), [readOnlyKeys]);

  const commit = (nextDoc, { coalesce = false } = {}) => {
    // Coalesced edits (per-keystroke typing in one field) don't flood the
    // undo stack — only the first change of a burst is recorded.
    setUndoStack((prev) => (coalesce && prev.length && prev[prev.length - 1].coalesce ? prev : [...prev.slice(-49), { text, coalesce }]));
    setRedoStack([]);
    onChange(JSON.stringify(nextDoc, null, 2));
  };
  const undo = () => {
    setUndoStack((prev) => {
      if (!prev.length) return prev;
      const last = prev[prev.length - 1];
      setRedoStack((r) => [...r, { text }]);
      onChange(last.text);
      return prev.slice(0, -1);
    });
  };
  const redo = () => {
    setRedoStack((prev) => {
      if (!prev.length) return prev;
      const last = prev[prev.length - 1];
      setUndoStack((u) => [...u, { text }]);
      onChange(last.text);
      return prev.slice(0, -1);
    });
  };

  const toggleCollapse = (id) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  const switchMode = (m) => {
    if (m === "tree" && parseError) {
      toast.error("Fix the JSON first — Tree mode needs a parseable document.");
      return;
    }
    // Find navigates by selecting in the Text mode textarea, which doesn't
    // exist in Tree mode — leaving the bar open there would strand it.
    if (m === "tree") setFindOpen(false);
    setMode(m);
  };

  const treeUsable = doc !== undefined && (typeof doc === "object" && doc !== null);

  return (
    <div>
      <div className="flex items-center border-b border-gray-100 mb-2">
        {["tree", "text"].map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => switchMode(m)}
            className={`px-4 text-center text-xs font-medium py-2 border-b-2 transition-colors ${
              mode === m ? "text-blue-600 border-blue-600 bg-blue-50" : "text-gray-400 border-transparent hover:text-gray-600"
            }`}
          >
            {m === "tree" ? "Tree" : "Text"}
          </button>
        ))}
        <span className="ml-auto flex items-center gap-2 pr-1">
          {mode === "tree" && (
            <>
              <button type="button" title="Undo" onClick={undo} disabled={!undoStack.length} className="text-gray-400 hover:text-gray-600 disabled:opacity-30">
                <Undo2 size={13} />
              </button>
              <button type="button" title="Redo" onClick={redo} disabled={!redoStack.length} className="text-gray-400 hover:text-gray-600 disabled:opacity-30">
                <Redo2 size={13} />
              </button>
            </>
          )}
          <button
            type="button"
            title="Find and replace"
            onClick={() => {
              // Find works on the raw document and navigates by selecting in
              // the textarea, so it only means anything in Text mode — open
              // it there rather than leaving the bar inert in Tree mode.
              setMode("text");
              setFindOpen((v) => !v);
            }}
            className={findOpen ? "text-blue-600" : "text-gray-400 hover:text-gray-600"}
          >
            <Search size={13} />
          </button>
          <button
            type="button"
            title="Print JSON"
            onClick={() => {
              if (!printJson(text, title)) toast.error("Pop-up blocked — allow pop-ups to print.");
            }}
            className="text-gray-400 hover:text-gray-600"
          >
            <Printer size={13} />
          </button>
        </span>
      </div>

      {findOpen && <JsonFindReplaceBar find={find} onClose={() => setFindOpen(false)} />}

      {mode === "tree" && treeUsable ? (
        <div className="border border-gray-200 rounded-xl py-1.5 px-1 overflow-x-auto" style={{ minHeight }}>
          {Array.isArray(doc) ? (
            <TreeNode value={doc} path={[]} parentKeys={[]} keyLabel={undefined} doc={doc} commit={commit} depth={0} collapsed={collapsed} toggleCollapse={toggleCollapse} readOnly={false} />
          ) : (
            Object.entries(doc).map(([k, v]) =>
              readOnlySet.has(k) ? (
                <div key={k} className="flex items-center gap-1.5 px-1.5 py-1 opacity-50" title="Read-only — never sent on save">
                  <span className="w-3.5" />
                  <span className="font-mono text-xs text-violet-700">{k}</span>
                  <span className="text-gray-300">:</span>
                  <span className="font-mono text-[11px] text-gray-400 truncate">{typeof v === "object" ? "…" : String(v)}</span>
                  <span className="text-[9px] text-gray-400 ml-auto flex-shrink-0">read-only</span>
                </div>
              ) : (
                <TreeNode
                  key={k} value={v} path={[k]} parentKeys={Object.keys(doc)} keyLabel={k}
                  doc={doc} commit={commit} depth={0} collapsed={collapsed} toggleCollapse={toggleCollapse} readOnly={false}
                />
              )
            )
          )}
          {!Array.isArray(doc) && (
            <button
              type="button"
              onClick={() => {
                let k = "newProperty"; let i = 1;
                while (k in doc) k = `newProperty${i++}`;
                commit({ ...doc, [k]: "" });
              }}
              className="flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-700 px-2 py-1.5"
            >
              <Plus size={12} /> Add property
            </button>
          )}
        </div>
      ) : mode === "tree" ? (
        <p className="text-xs text-gray-400 px-1 py-3">
          Tree mode needs an object or array document — this is a {doc === undefined ? "non-parseable" : typeof doc} value. Use Text mode.
        </p>
      ) : (
        <>
          <JsonEditSurface
            text={text}
            onChange={onChange}
            minHeight={minHeight}
            textareaRef={textareaRef}
            matches={findOpen ? find.matches : null}
            activeIndex={find.index}
            // Brackets and the DOUBLE quote only — a single quote is never
            // valid JSON, so pairing it would help type something the parser
            // rejects. This is the raw-text editor, which is mostly where
            // broken JSON gets fixed, so balanced pairs matter most here.
            textareaProps={{
              onKeyDown: (e) => handleBracketKey(e, { textarea: textareaRef.current, onChange, quotes: JSON_QUOTES }),
            }}
          />
          {parseError ? (
            <p className="text-xs text-red-600 mt-2">Invalid JSON: {parseError}</p>
          ) : (
            <p className="text-xs text-emerald-600 mt-2">Valid JSON</p>
          )}
          {/* Always rendered: it shows nothing for valid JSON except, right
              after a fix, its own "Undo fix" — the toolbar's Undo is tree-mode
              only, and invalid JSON can only ever be in text mode. */}
          <JsonAiFix text={text} error={parseError} onApply={onChange} />
        </>
      )}
    </div>
  );
}
