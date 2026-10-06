import { useEffect, useMemo, useRef, useState } from "react";
import { Search, Printer, ChevronUp, ChevronDown, X, CaseSensitive, Regex } from "lucide-react";

// Shared JSON view/edit primitives — used by the Workflow detail page's
// JSON tab and step editor, and the Transform detail page's editor.

export function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Small regex JSON highlighter — enough for workflow/transform-sized
// documents without pulling in an editor dependency. Works on
// ALREADY-ESCAPED text.
export function highlightJson(escaped) {
  return escaped.replace(
    /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g,
    (match, str, colon, bool) => {
      // Classes, not inline hex — inline styles can't be re-themed, which
      // left dark-on-dark tokens (green-on-green strings) in dark mode.
      if (str) {
        return colon
          ? `<span class="json-tok-key">${str}</span>${colon}`
          : `<span class="json-tok-str">${str}</span>`;
      }
      if (bool) return `<span class="json-tok-lit">${match}</span>`;
      return `<span class="json-tok-num">${match}</span>`;
    }
  );
}

// BeanShell / Java highlighter for connector rules. Same contract as
// highlightJson: operates on ALREADY-ESCAPED text and only ever wraps, never
// adds or drops characters, so the match-painting walk below still lines up.
//
// Comments and strings are matched FIRST in the alternation so a keyword
// inside a comment, or a brace inside a string, is never mis-tokenised.
// escapeHtml only touches & < >, so quote characters are still literal here.
const CODE_KEYWORDS = "abstract|assert|boolean|break|byte|case|catch|char|class|const|continue|default|do|double|else|enum|extends|final|finally|float|for|goto|if|implements|import|instanceof|int|interface|long|native|new|package|private|protected|public|return|short|static|strictfp|super|switch|synchronized|this|throw|throws|transient|try|void|volatile|while|true|false|null";

const CODE_TOKENS = new RegExp(
  "(\\/\\*[\\s\\S]*?\\*\\/|\\/\\/[^\\n]*)" +      // comments
  "|(\"(?:\\\\.|[^\"\\\\])*\"|'(?:\\\\.|[^'\\\\])*')" + // strings
  `|\\b(${CODE_KEYWORDS})\\b` +                                  // keywords
  "|\\b\\d+(?:\\.\\d+)?[fFdDlL]?\\b",                      // numbers
  "g"
);

export function highlightCode(escaped) {
  return escaped.replace(CODE_TOKENS, (m, comment, str, kw) => {
    if (comment) return `<span class="code-tok-com">${m}</span>`;
    if (str) return `<span class="code-tok-str">${m}</span>`;
    if (kw) return `<span class="code-tok-kw">${m}</span>`;
    return `<span class="code-tok-num">${m}</span>`;
  });
}

/**
 * The same highlighted HTML, with every search match wrapped in a <mark>.
 *
 * Marks can't simply be injected into the text before highlighting: the
 * highlighter would then scan the tags themselves (an attribute's quoted
 * value reads as a JSON string token), and splitting the text at match
 * boundaries first would cut string tokens in half so the highlighter no
 * longer recognises them.
 *
 * Doing it afterwards through the DOM avoids both. The concatenated text
 * nodes of the highlighted HTML are EXACTLY the original document — escaping
 * turns one character into one entity, which decodes back to one character,
 * and the highlighter only ever wraps text, never adds or drops any. So raw
 * offsets index straight into that walk with no mapping table, and a match
 * spanning several tokens just wraps its slice of each one.
 */
export function highlightJsonWithMatches(text, matches, activeIndex, highlight = highlightJson) {
  const html = highlight(escapeHtml(text));
  if (!matches?.length) return html;

  const root = document.createElement("div");
  root.innerHTML = html;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n);

  let pos = 0;
  for (const node of nodes) {
    const start = pos;
    const end = start + node.data.length;
    pos = end;
    // exec() yields matches in order and never overlapping, so a simple
    // forward sweep per node is enough.
    const hits = [];
    for (let i = 0; i < matches.length; i++) {
      if (matches[i].start < end && matches[i].end > start) hits.push({ ...matches[i], i });
    }
    if (!hits.length) continue;

    const frag = document.createDocumentFragment();
    let cursor = start;
    for (const hit of hits) {
      const from = Math.max(hit.start, start);
      const to = Math.min(hit.end, end);
      if (from > cursor) frag.appendChild(document.createTextNode(node.data.slice(cursor - start, from - start)));
      const mark = document.createElement("mark");
      mark.className = hit.i === activeIndex ? "json-match json-match-active" : "json-match";
      mark.textContent = node.data.slice(from - start, to - start);
      frag.appendChild(mark);
      cursor = to;
    }
    if (cursor < end) frag.appendChild(document.createTextNode(node.data.slice(cursor - start)));
    node.parentNode.replaceChild(frag, node);
  }
  return root.innerHTML;
}

// Read-only highlighted code, for the places that DISPLAY a script rather
// than edit it. Shares the highlighter and the editor's own metrics, so a
// rule reads identically whether you're viewing it or editing it.
export function CodeBlock({ text, highlight = highlightCode, minHeight, className = "" }) {
  const html = useMemo(
    () => highlight(escapeHtml(String(text ?? ""))),
    [text, highlight]
  );
  return (
    <pre
      className={`border border-gray-200 rounded-xl overflow-auto bg-gray-50 text-gray-800 m-0 ${className}`}
      style={{ ...JSON_EDITOR_STYLE, ...(minHeight ? { minHeight } : {}) }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

// pre-wrap + break-word on BOTH layers:// pre-wrap + break-word on BOTH layers: the overlay only lines up if the
// highlighted <pre> and the transparent <textarea> wrap at exactly the
// same points, so any wrapping change must be made to this shared style.
export const JSON_EDITOR_STYLE = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: "12px",
  lineHeight: "1.5",
  padding: "12px",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  tabSize: 2,
};

export function jsonParseError(text) {
  try {
    JSON.parse(text);
    return null;
  } catch (err) {
    return err.message;
  }
}

// The live-highlighted editable surface — a transparent textarea overlaid
// on the highlighted rendering (same font metrics, synced scroll).
export function JsonEditSurface({ text, onChange, minHeight = "320px", textareaRef, matches, activeIndex = -1, highlight = highlightJson, textareaProps, children }) {
  const preRef = useRef(null);
  const ownRef = useRef(null);
  const taRef = textareaRef || ownRef;
  // The DOM walk only runs while a search is actually active — with no
  // matches this is the same plain highlight it always was.
  const html = useMemo(
    () => highlightJsonWithMatches(text, matches, activeIndex, highlight) + "\n",
    [text, matches, activeIndex, highlight]
  );
  return (
    <div className="relative border border-gray-200 rounded-xl overflow-hidden bg-gray-50">
      <pre
        ref={preRef}
        aria-hidden="true"
        className="overflow-hidden text-gray-800 m-0"
        style={{ ...JSON_EDITOR_STYLE, minHeight }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      <textarea
        ref={taRef}
        value={text}
        onChange={(e) => onChange(e.target.value)}
        onScroll={(e) => {
          if (preRef.current) {
            preRef.current.scrollTop = e.target.scrollTop;
            preRef.current.scrollLeft = e.target.scrollLeft;
          }
        }}
        spellCheck={false}
        className="code-caret absolute inset-0 w-full h-full resize-none outline-none bg-transparent overflow-auto"
        style={{ ...JSON_EDITOR_STYLE, color: "transparent" }}
        {...textareaProps}
      />
      {/* Anything positioned against the caret (the completion list) renders
          inside this relative box. */}
      {children}
    </div>
  );
}


// ─── Find / Replace ───────────────────────────────────────────────────────────

// A pathological query on a large document shouldn't lock the page up;
// past this the counter just shows "5000+".
const MAX_MATCHES = 5000;

// Every occurrence of `query` in `text`, as {start, end} offsets into the
// raw document. Plain-text search escapes the query so JSON punctuation
// ({, ", $, .) searches for itself rather than being read as a regex.
export function findJsonMatches(text, query, { matchCase = false, useRegex = false } = {}) {
  if (!query) return { matches: [], error: null };
  let re;
  try {
    const source = useRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    re = new RegExp(source, matchCase ? "g" : "gi");
  } catch (err) {
    // Only reachable with Regex mode on — a half-typed pattern ("[") is a
    // normal intermediate state while typing, not an error worth a toast.
    return { matches: [], error: err.message };
  }
  const matches = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    matches.push({ start: m.index, end: m.index + m[0].length });
    // A pattern that can match nothing ("a*") would otherwise spin forever.
    if (m[0].length === 0) re.lastIndex += 1;
    if (matches.length >= MAX_MATCHES) break;
  }
  return { matches, error: null };
}


// A textarea can't say where a character ended up once its text wraps, so
// measure it: a hidden element with the textarea's exact width and text
// metrics, filled with everything BEFORE the match, ends up exactly as tall
// as that match's distance from the top. Depends on nothing but the
// computed style, so it stays correct if JSON_EDITOR_STYLE changes.
function scrollMatchIntoView(textarea, start) {
  const cs = window.getComputedStyle(textarea);
  const mirror = document.createElement("div");
  Object.assign(mirror.style, {
    position: "absolute", visibility: "hidden", pointerEvents: "none",
    top: "0", left: "-9999px",
    width: cs.width, padding: cs.padding, boxSizing: cs.boxSizing,
    fontFamily: cs.fontFamily, fontSize: cs.fontSize, lineHeight: cs.lineHeight,
    whiteSpace: cs.whiteSpace, wordBreak: cs.wordBreak, tabSize: cs.tabSize,
  });
  // Trailing newlines collapse to zero height on their own, which would put
  // a match at the start of a line one row too high — the zero-width space
  // forces that final line to exist.
  mirror.textContent = textarea.value.slice(0, start) + "\u200b";
  document.body.appendChild(mirror);
  const offset = mirror.scrollHeight;
  document.body.removeChild(mirror);
  textarea.scrollTop = Math.max(0, offset - textarea.clientHeight / 2);
}

/**
 * Find/replace state over the raw JSON text. Lives here rather than inside
 * the bar so the editing surface can paint every match too — the bar and the
 * overlay have to agree on which match is current.
 */
export function useJsonFind({ text, onChange, textareaRef, enabled }) {
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [index, setIndex] = useState(0);

  const { matches, error } = useMemo(
    () => (enabled ? findJsonMatches(text, query, { matchCase, useRegex }) : { matches: [], error: null }),
    [enabled, text, query, matchCase, useRegex]
  );

  // Editing the document can shrink the match list under a stale index
  // (replacing the last one, or typing over it), so clamp on read rather
  // than chasing it with an effect that would fight the user's own paging.
  const safeIndex = matches.length ? Math.min(index, matches.length - 1) : 0;

  useEffect(() => { setIndex(0); }, [query, matchCase, useRegex]);

  function goTo(i) {
    if (!matches.length) return;
    const next = (i + matches.length) % matches.length;
    setIndex(next);
    const ta = textareaRef?.current;
    if (!ta) return;
    const { start, end } = matches[next];
    ta.focus();
    ta.setSelectionRange(start, end);
    scrollMatchIntoView(ta, start);
  }

  function replaceCurrent() {
    const m = matches[safeIndex];
    if (!m) return;
    onChange(text.slice(0, m.start) + replacement + text.slice(m.end));
    // The remaining matches shift by the length delta, so the index now
    // points at what was the next one — which is what you want after a
    // replace, and how every editor behaves.
  }

  function replaceAll() {
    if (!matches.length) return;
    let out = "";
    let last = 0;
    for (const m of matches) {
      out += text.slice(last, m.start) + replacement;
      last = m.end;
    }
    onChange(out + text.slice(last));
  }

  return {
    query, setQuery, replacement, setReplacement,
    matchCase, setMatchCase, useRegex, setUseRegex,
    matches, error, index: safeIndex, goTo, replaceCurrent, replaceAll,
  };
}

/**
 * The find/replace bar. Every match is painted in the editing surface (see
 * highlightJsonWithMatches) and the current one is additionally selected in
 * the textarea, so it stays visible even while the caret is elsewhere.
 */
export function JsonFindReplaceBar({ find, onClose }) {
  const {
    query, setQuery, replacement, setReplacement,
    matchCase, setMatchCase, useRegex, setUseRegex,
    matches, error, index, goTo, replaceCurrent, replaceAll,
  } = find;
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const toggleClass = (on) =>
    `px-1.5 py-1 rounded border text-[11px] transition-colors ${
      on ? "bg-blue-50 border-blue-200 text-blue-700" : "bg-white border-gray-200 text-gray-400 hover:text-gray-600"
    }`;

  return (
    <div className="border border-gray-200 rounded-xl bg-gray-50 px-2.5 py-2 mb-2">
      <div className="flex items-center gap-1.5 flex-wrap">
        <Search size={13} className="text-gray-400 flex-shrink-0" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); goTo(e.shiftKey ? index - 1 : index + 1); }
            if (e.key === "Escape") { e.preventDefault(); onClose(); }
          }}
          placeholder="Find"
          spellCheck={false}
          className="flex-1 min-w-[7rem] text-xs font-mono px-2 py-1 rounded border border-gray-200 bg-white outline-none focus:border-blue-400"
        />
        <button type="button" title="Match case" onClick={() => setMatchCase((v) => !v)} className={toggleClass(matchCase)}>
          <CaseSensitive size={13} />
        </button>
        <button type="button" title="Regular expression" onClick={() => setUseRegex((v) => !v)} className={toggleClass(useRegex)}>
          <Regex size={13} />
        </button>
        <span className="text-[11px] text-gray-400 tabular-nums w-16 text-right flex-shrink-0">
          {error ? "bad regex" : matches.length ? `${index + 1} of ${matches.length}${matches.length >= MAX_MATCHES ? "+" : ""}` : query ? "none" : ""}
        </span>
        <button type="button" title="Previous match" onClick={() => goTo(index - 1)} disabled={!matches.length}
          className="text-gray-400 hover:text-gray-600 disabled:opacity-30 px-0.5">
          <ChevronUp size={14} />
        </button>
        <button type="button" title="Next match" onClick={() => goTo(index + 1)} disabled={!matches.length}
          className="text-gray-400 hover:text-gray-600 disabled:opacity-30 px-0.5">
          <ChevronDown size={14} />
        </button>
        <button type="button" title="Close find" onClick={onClose} className="text-gray-400 hover:text-gray-600 px-0.5">
          <X size={14} />
        </button>
      </div>

      <div className="flex items-center gap-1.5 mt-1.5">
        <span className="w-[13px] flex-shrink-0" />
        <input
          value={replacement}
          onChange={(e) => setReplacement(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); replaceCurrent(); }
            if (e.key === "Escape") { e.preventDefault(); onClose(); }
          }}
          placeholder="Replace with"
          spellCheck={false}
          className="flex-1 min-w-[7rem] text-xs font-mono px-2 py-1 rounded border border-gray-200 bg-white outline-none focus:border-blue-400"
        />
        <button type="button" onClick={replaceCurrent} disabled={!matches.length}
          className="text-[11px] font-medium px-2 py-1 rounded border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 disabled:opacity-40">
          Replace
        </button>
        <button type="button" onClick={replaceAll} disabled={!matches.length}
          className="text-[11px] font-medium px-2 py-1 rounded border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 disabled:opacity-40">
          All
        </button>
      </div>
      {useRegex && (
        <p className="text-[10px] text-gray-400 mt-1">
          Replacement text is inserted literally — $1 and friends aren't expanded.
        </p>
      )}
    </div>
  );
}

// ─── Print ────────────────────────────────────────────────────────────────────

/**
 * Opens the document in a print window, syntax-highlighted and wrapped the
 * same way the editor shows it. Returns false when a pop-up blocker stopped
 * the window (same detection as pdfUtils' openPdfOrDownload — Safari hands
 * back an already-closed Window rather than null), so the caller can say so
 * instead of appearing to do nothing.
 */
export function printJson(text, title = "JSON") {
  const win = window.open("", "_blank");
  if (!win || win.closed || typeof win.closed === "undefined") return false;
  // Always the light token palette: this is going onto paper, whatever
  // theme the app itself is in.
  win.document.write(`<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>
  body { margin: 24px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  h1 { font-family: system-ui, sans-serif; font-size: 13px; font-weight: 600; color: #374151; margin: 0 0 12px; }
  pre { font-size: 11px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; margin: 0; }
  .json-tok-key { color: #7c3aed; }
  .json-tok-str { color: #047857; }
  .json-tok-lit { color: #b45309; }
  .json-tok-num { color: #1d4ed8; }
  @page { margin: 12mm; }
</style></head><body>
  <h1>${escapeHtml(title)}</h1>
  <pre>${highlightJson(escapeHtml(text))}</pre>
</body></html>`);
  win.document.close();
  win.focus();
  win.print();
  return true;
}
