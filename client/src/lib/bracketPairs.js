/**
 * Auto-closing brackets for the script editor.
 *
 * Written as a pure function over (text, selection, key) so the behaviour can
 * be tested without a DOM: given what's on screen and the key pressed, it
 * returns the resulting text and selection, or null when the key should be
 * left alone.
 *
 * Auto-closing is only half of it. Inserting a closer and nothing else makes
 * an editor worse — you then have to step over the one it added, and deleting
 * an opener strands its partner. So this also handles:
 *   - typing the closer when it's already there: step over it, don't double it
 *   - backspacing between an empty pair: remove both
 *   - typing an opener with text selected: wrap the selection
 *
 * Quotes are paired too, but guarded. A quote is the same character opening
 * and closing, so there's nothing in the character itself to say which is
 * meant — and in BeanShell an apostrophe is as likely to be prose inside a
 * comment ("doesn't") as a char literal. So a quote only auto-closes when it
 * is starting something: not when it butts against a word on either side, and
 * not when it is escaped.
 */

export const PAIRS = { "(": ")", "[": "]", "{": "}" };
const CLOSERS = new Set(Object.values(PAIRS));

// Which quote characters pair is per-language. BeanShell takes both — 'x' is
// a char literal. JSON takes only the double quote: a single quote is never
// valid JSON, so pairing it would help you type something the parser then
// rejects.
export const BEANSHELL_QUOTES = ['"', "'"];
export const JSON_QUOTES = ['"'];

// A quote touching a word character is almost certainly closing a literal or
// sitting inside prose, not opening a new one.
const isWordChar = (c) => !!c && /[A-Za-z0-9_$]/.test(c);

// An odd run of backslashes means this quote is escaped.
function isEscaped(text, at) {
  let n = 0;
  for (let i = at - 1; i >= 0 && text[i] === "\\"; i -= 1) n += 1;
  return n % 2 === 1;
}

/**
 * @returns {{ value: string, selectionStart: number, selectionEnd: number } | null}
 *          null means "let the browser handle this key normally".
 */
export function bracketEdit({ value, selectionStart: start, selectionEnd: end, key, quotes = BEANSHELL_QUOTES }) {
  const text = String(value ?? "");
  const QUOTES = new Set(quotes || []);

  // ── Typing an opener ──
  if (PAIRS[key]) {
    const close = PAIRS[key];
    if (start !== end) {
      // Wrap the selection, keeping it selected so it can be wrapped again.
      const selected = text.slice(start, end);
      return {
        value: text.slice(0, start) + key + selected + close + text.slice(end),
        selectionStart: start + 1,
        selectionEnd: end + 1,
      };
    }
    return {
      value: text.slice(0, start) + key + close + text.slice(start),
      selectionStart: start + 1,
      selectionEnd: start + 1,
    };
  }

  // ── Typing a closer that's already sitting there ──
  if (CLOSERS.has(key) && start === end && text[start] === key) {
    return { value: text, selectionStart: start + 1, selectionEnd: start + 1 };
  }

  // ── Quotes ──
  if (QUOTES.has(key)) {
    if (start !== end) {
      const selected = text.slice(start, end);
      return {
        value: text.slice(0, start) + key + selected + key + text.slice(end),
        selectionStart: start + 1,
        selectionEnd: end + 1,
      };
    }
    // Already closed here — step over rather than add a third quote.
    if (text[start] === key && !isEscaped(text, start)) {
      return { value: text, selectionStart: start + 1, selectionEnd: start + 1 };
    }
    const prev = text[start - 1];
    const next = text[start];
    // "don't" / trailing a word / escaped: type one quote, pair nothing.
    if (isWordChar(prev) || isWordChar(next) || prev === key || isEscaped(text, start)) return null;
    return {
      value: text.slice(0, start) + key + key + text.slice(start),
      selectionStart: start + 1,
      selectionEnd: start + 1,
    };
  }

  // ── Backspace between an empty pair (brackets or quotes) ──
  if (key === "Backspace" && start === end && start > 0) {
    const before = text[start - 1];
    const partner = PAIRS[before] || (QUOTES.has(before) ? before : null);
    if (partner && text[start] === partner) {
      return {
        value: text.slice(0, start - 1) + text.slice(start + 1),
        selectionStart: start - 1,
        selectionEnd: start - 1,
      };
    }
  }

  return null;
}

/**
 * Applies a bracket/quote edit to a controlled textarea from a keydown.
 * Returns true when it handled the key, so the caller can stop there.
 *
 * Lives here rather than in each editor because restoring the caret is the
 * fiddly part: the textarea is controlled, so the selection has to be set
 * after React re-renders it with the new value.
 */
export function handleBracketKey(event, { textarea, onChange, quotes }) {
  if (!textarea || event.ctrlKey || event.metaKey || event.altKey) return false;
  const edit = bracketEdit({
    value: textarea.value,
    selectionStart: textarea.selectionStart,
    selectionEnd: textarea.selectionEnd,
    key: event.key,
    quotes,
  });
  if (!edit) return false;
  event.preventDefault();
  onChange(edit.value);
  requestAnimationFrame(() => {
    if (!textarea.isConnected) return;
    textarea.setSelectionRange(edit.selectionStart, edit.selectionEnd);
  });
  return true;
}
