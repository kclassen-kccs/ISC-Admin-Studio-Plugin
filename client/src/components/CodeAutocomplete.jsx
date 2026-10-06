import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * Autocomplete for the connector rule editor.
 *
 * The completions that matter most aren't keywords — they're the rule's OWN
 * input variables, which come from its signature and differ per rule type
 * (a BuildMap rule gets `map` and `application`, a WebService rule gets
 * `requestEndPoint`, and so on). Those are offered first, with their declared
 * type and description, because they're the names an author can't guess and
 * can't look up without leaving the editor.
 *
 * Everything else is ordinary word completion: identifiers already present in
 * the script, then BeanShell/Java keywords.
 */

// Identifier characters, Java-style (BeanShell allows $ and _ to lead).
const WORD_RE = /[A-Za-z_$][A-Za-z0-9_$]*$/;

export const BEANSHELL_KEYWORDS = [
  "abstract", "assert", "boolean", "break", "byte", "case", "catch", "char", "class", "continue",
  "default", "do", "double", "else", "enum", "extends", "final", "finally", "float", "for",
  "if", "implements", "import", "instanceof", "int", "interface", "long", "new", "package",
  "private", "protected", "public", "return", "short", "static", "super", "switch",
  "synchronized", "this", "throw", "throws", "transient", "try", "void", "volatile", "while",
  "true", "false", "null",
];

// A deliberately small set of things that actually appear in connector rules,
// rather than a sprawling Java API dump that would bury the useful entries.
export const SAILPOINT_SNIPPETS = [
  { label: "sailpoint.object.Application", kind: "class" },
  { label: "sailpoint.object.Identity", kind: "class" },
  { label: "sailpoint.object.ResourceObject", kind: "class" },
  { label: "sailpoint.object.Schema", kind: "class" },
  { label: "sailpoint.connector.Connector", kind: "class" },
  { label: "HashMap", kind: "class" },
  { label: "ArrayList", kind: "class" },
  { label: "String", kind: "class" },
  { label: "getStringAttribute", kind: "method" },
  { label: "getAttribute", kind: "method" },
  { label: "setAttribute", kind: "method" },
  { label: "getAttributes", kind: "method" },
  { label: "put", kind: "method" },
  { label: "get", kind: "method" },
  { label: "containsKey", kind: "method" },
  { label: "isEmpty", kind: "method" },
  { label: "equals", kind: "method" },
  { label: "toString", kind: "method" },
];

/** Identifiers the author has already written — their own variables. */
export function identifiersIn(text, exclude) {
  const seen = new Map();
  for (const m of String(text || "").matchAll(/[A-Za-z_$][A-Za-z0-9_$]{2,}/g)) {
    const w = m[0];
    if (!exclude.has(w)) seen.set(w, (seen.get(w) || 0) + 1);
  }
  // Most-used first: a name written several times is more likely wanted than
  // one that appeared once.
  return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([label]) => ({ label, kind: "local" }));
}

/**
 * The full candidate list for a rule, ordered by usefulness. `inputs` is the
 * rule signature's argument list ([{ name, type, description }]).
 */
export function buildCompletions(inputs, script) {
  const args = (inputs || [])
    .filter((a) => a?.name)
    .map((a) => ({ label: a.name, kind: "input", detail: a.type || "argument", doc: a.description || null }));

  const taken = new Set(args.map((a) => a.label));
  const keywords = BEANSHELL_KEYWORDS.filter((k) => !taken.has(k)).map((label) => ({ label, kind: "keyword" }));
  keywords.forEach((k) => taken.add(k.label));
  const snippets = SAILPOINT_SNIPPETS.filter((s) => !taken.has(s.label));
  snippets.forEach((s) => taken.add(s.label));
  const locals = identifiersIn(script, taken);

  return [...args, ...locals, ...snippets, ...keywords];
}

/** Prefix matches first, then substring — both case-insensitive. */
export function rankCompletions(all, prefix, limit = 12) {
  if (!prefix) return [];
  const p = prefix.toLowerCase();
  const starts = [];
  const contains = [];
  for (const c of all) {
    const l = c.label.toLowerCase();
    if (l === p) continue; // already typed in full
    if (l.startsWith(p)) starts.push(c);
    else if (l.includes(p)) contains.push(c);
    if (starts.length >= limit) break;
  }
  return [...starts, ...contains].slice(0, limit);
}

/**
 * Pixel position of the caret inside a textarea, by rendering the text before
 * it into a mirror with the same metrics and measuring a marker. The editor's
 * own <pre> overlay can't be used for this — it's shared with the JSON
 * editors and shouldn't grow a marker span per keystroke.
 */
const MIRRORED = [
  "boxSizing", "width", "fontFamily", "fontSize", "fontWeight", "letterSpacing",
  "lineHeight", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
  "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
  "whiteSpace", "wordBreak", "tabSize",
];

export function caretPosition(textarea) {
  if (!textarea) return null;
  const cs = window.getComputedStyle(textarea);
  const mirror = document.createElement("div");
  for (const prop of MIRRORED) mirror.style[prop] = cs[prop];
  mirror.style.position = "absolute";
  mirror.style.visibility = "hidden";
  mirror.style.top = "0";
  mirror.style.left = "-9999px";
  mirror.style.height = "auto";
  mirror.style.overflow = "hidden";
  mirror.textContent = textarea.value.slice(0, textarea.selectionStart);
  const marker = document.createElement("span");
  marker.textContent = "​";
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  const top = marker.offsetTop - textarea.scrollTop;
  const left = marker.offsetLeft - textarea.scrollLeft;
  document.body.removeChild(mirror);
  return { top, left, lineHeight: parseFloat(cs.lineHeight) || 18 };
}

/**
 * Completion state for a textarea. Returns the props to spread onto it plus
 * what the list needs to render.
 */
export function useCodeCompletion({ text, onChange, textareaRef, completions, enabled = true }) {
  const [prefix, setPrefix] = useState("");
  const [index, setIndex] = useState(0);
  const [pos, setPos] = useState(null);
  const dismissedAt = useRef(-1);

  const items = useMemo(() => rankCompletions(completions, prefix), [completions, prefix]);
  const open = enabled && !!prefix && items.length > 0;

  const close = useCallback(() => { setPrefix(""); setPos(null); setIndex(0); }, []);

  // Recompute the prefix from wherever the caret now is.
  const refresh = useCallback(() => {
    const ta = textareaRef?.current;
    if (!ta || !enabled) return;
    const caret = ta.selectionStart;
    if (caret !== ta.selectionEnd) return close();
    if (dismissedAt.current === caret) return;
    const word = WORD_RE.exec(ta.value.slice(0, caret));
    // One character is too little — it would pop open constantly.
    if (!word || word[0].length < 2) return close();
    setPrefix(word[0]);
    setIndex(0);
    setPos(caretPosition(ta));
  }, [textareaRef, enabled, close]);

  const accept = useCallback((item) => {
    const ta = textareaRef?.current;
    const chosen = item || items[index];
    if (!ta || !chosen) return;
    const caret = ta.selectionStart;
    const start = caret - prefix.length;
    const next = text.slice(0, start) + chosen.label + text.slice(caret);
    onChange(next);
    close();
    // Put the caret after what was just inserted, once React has re-rendered
    // the textarea with the new value.
    const at = start + chosen.label.length;
    requestAnimationFrame(() => {
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(at, at);
    });
  }, [textareaRef, items, index, prefix, text, onChange, close]);

  const onKeyDown = useCallback((e) => {
    if (!open) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setIndex((i) => (i + 1) % items.length); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); setIndex((i) => (i - 1 + items.length) % items.length); return; }
    if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); accept(); return; }
    if (e.key === "Escape") {
      // Stay dismissed until the caret moves, so Escape doesn't just reopen
      // on the next keystroke at the same spot.
      e.preventDefault();
      e.stopPropagation();
      dismissedAt.current = textareaRef?.current?.selectionStart ?? -1;
      close();
    }
  }, [open, items, accept, close, textareaRef]);

  // After any edit or caret move, re-evaluate.
  useEffect(() => { refresh(); }, [text, refresh]);

  return {
    open, items, index, position: pos, prefix,
    accept, close, setIndex,
    textareaProps: { onKeyDown, onKeyUp: refresh, onClick: refresh, onBlur: () => setTimeout(close, 120) },
  };
}

const KIND_STYLE = {
  input: "text-violet-700 bg-violet-50",
  local: "text-emerald-700 bg-emerald-50",
  class: "text-blue-700 bg-blue-50",
  method: "text-blue-700 bg-blue-50",
  keyword: "text-gray-600 bg-gray-100",
};

export function CompletionList({ completion }) {
  const { open, items, index, position, accept, setIndex } = completion;
  if (!open || !position) return null;
  return (
    <ul
      className="absolute z-20 max-h-56 w-72 overflow-y-auto rounded-xl border border-gray-200 bg-white shadow-lg py-1 text-xs"
      style={{ top: position.top + position.lineHeight + 4, left: Math.max(0, position.left) }}
      // The textarea must keep focus — clicking an entry shouldn't blur it.
      onMouseDown={(e) => e.preventDefault()}
    >
      {items.map((item, i) => (
        <li key={`${item.kind}:${item.label}`}>
          <button
            type="button"
            onClick={() => accept(item)}
            onMouseEnter={() => setIndex(i)}
            className={`w-full text-left px-2.5 py-1.5 flex items-baseline gap-2 ${i === index ? "bg-blue-50" : "hover:bg-gray-50"}`}
          >
            <span className={`px-1 rounded text-[10px] font-medium flex-shrink-0 ${KIND_STYLE[item.kind] || KIND_STYLE.keyword}`}>
              {item.kind}
            </span>
            <span className="font-mono text-gray-900 truncate">{item.label}</span>
            {item.detail && <span className="text-gray-400 truncate ml-auto flex-shrink-0">{item.detail}</span>}
          </button>
          {i === index && item.doc && (
            <p className="px-2.5 pb-1.5 text-[11px] text-gray-500 leading-snug">{item.doc}</p>
          )}
        </li>
      ))}
    </ul>
  );
}
