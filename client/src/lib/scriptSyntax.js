/**
 * Structural syntax checks for connector rule scripts, run in the browser as
 * you type — ahead of ISC's own validation, which is authoritative but needs
 * a round trip.
 *
 * Deliberately NOT a JavaScript parser. Connector rules are BeanShell, which
 * is Java syntax: `Map m = new HashMap();`, `import sailpoint.object.*;` and
 * casts are all valid here and would be rejected outright by a JS parser, so
 * running one would report confident, wrong errors on perfectly good rules.
 *
 * What's checked instead is structure that is broken in BOTH languages — and
 * in any C-family language — so a reported issue is always a real one:
 *   - unbalanced or mismatched ( ) [ ] { }
 *   - a string literal left open at end of line
 *   - a block comment left open at end of file
 *
 * Returns [{ line, column, message }], the same shape ISC's validation
 * details use, so both render through the same list.
 */

const OPENERS = { "(": ")", "[": "]", "{": "}" };
const CLOSERS = { ")": "(", "]": "[", "}": "{" };
const NAMES = { "(": "parenthesis", "[": "bracket", "{": "brace" };

export function checkScriptStructure(text) {
  const src = String(text || "");
  const issues = [];
  const stack = [];

  let line = 1;
  let col = 1;
  let i = 0;
  // Where the current string/comment started, for "unterminated" reporting.
  let mode = "code"; // code | line-comment | block-comment | string
  let quote = "";
  let openedAt = null;

  const push = (l, c, message) => {
    // One structural complaint is enough to act on; a cascade of follow-on
    // errors from the same root cause is noise.
    if (issues.length < 8) issues.push({ line: l, column: c, message });
  };

  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];

    if (ch === "\n") {
      if (mode === "string") {
        push(openedAt.line, openedAt.column, `Unterminated ${quote === '"' ? "string" : "character"} literal — no closing ${quote} before the end of the line.`);
        mode = "code";
      }
      if (mode === "line-comment") mode = "code";
      line += 1;
      col = 1;
      i += 1;
      continue;
    }

    if (mode === "line-comment") { i += 1; col += 1; continue; }

    if (mode === "block-comment") {
      if (ch === "*" && next === "/") { mode = "code"; i += 2; col += 2; continue; }
      i += 1; col += 1; continue;
    }

    if (mode === "string") {
      // A backslash escapes the next character, including the quote itself.
      if (ch === "\\") { i += 2; col += 2; continue; }
      if (ch === quote) { mode = "code"; quote = ""; }
      i += 1; col += 1; continue;
    }

    // mode === "code"
    if (ch === "/" && next === "/") { mode = "line-comment"; i += 2; col += 2; continue; }
    if (ch === "/" && next === "*") { mode = "block-comment"; openedAt = { line, column: col }; i += 2; col += 2; continue; }
    if (ch === '"' || ch === "'") { mode = "string"; quote = ch; openedAt = { line, column: col }; i += 1; col += 1; continue; }

    if (OPENERS[ch]) {
      stack.push({ ch, line, column: col });
    } else if (CLOSERS[ch]) {
      const top = stack.pop();
      if (!top) {
        push(line, col, `Unexpected closing ${NAMES[CLOSERS[ch]]} "${ch}" — nothing is open here.`);
      } else if (OPENERS[top.ch] !== ch) {
        push(line, col, `Mismatched ${NAMES[CLOSERS[ch]]} — "${top.ch}" opened on line ${top.line} is closed by "${ch}".`);
      }
    }
    i += 1;
    col += 1;
  }

  if (mode === "block-comment") {
    push(openedAt.line, openedAt.column, "Unterminated block comment — no closing */.");
  }
  if (mode === "string") {
    push(openedAt.line, openedAt.column, `Unterminated ${quote === '"' ? "string" : "character"} literal — no closing ${quote}.`);
  }
  for (const open of stack) {
    push(open.line, open.column, `Unclosed ${NAMES[open.ch]} "${open.ch}" — no matching "${OPENERS[open.ch]}".`);
  }

  return issues;
}
