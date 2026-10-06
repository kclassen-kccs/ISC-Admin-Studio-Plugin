// Local evaluator for ISC transform definitions — powers the Transform
// detail page's Test tab. ISC has no public "evaluate this transform with
// these inputs" endpoint, so the documented operation types
// (developer.sailpoint.com/docs/extensibility/transforms/operations) are
// interpreted here client-side: the tester walks the definition to
// discover what it reads (the implicit input, account attributes, identity
// attributes, referenced transforms, reference-identity rules), prompts
// for those values, then evaluates. Types with genuinely server-side
// behavior (usernameGenerator's uniqueness checks, arbitrary custom rules)
// fail loudly with the type name rather than guessing; a few others note
// their approximations (limited country/language tables, naive E.164).

function isTransformNode(v) {
  return v && typeof v === "object" && !Array.isArray(v) && typeof v.type === "string";
}

/**
 * Walks a transform tree and returns the inputs the tester should prompt
 * for. Returns [{ key, label }].
 */
export function collectTransformInputs(transform, transformsByName = new Map()) {
  const inputs = new Map();
  inputs.set("__input__", { key: "__input__", label: "Input — the value fed into the transform" });

  const seenRefs = new Set();
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    if (isTransformNode(node)) {
      const a = node.attributes || {};
      if (node.type === "accountAttribute") {
        const key = `acct:${a.sourceName || "?"}:${a.attributeName || "?"}`;
        inputs.set(key, { key, label: `Account attribute — ${a.sourceName || "?"} · ${a.attributeName || "?"}` });
      } else if (node.type === "identityAttribute") {
        const key = `idn:${a.name || "?"}`;
        inputs.set(key, { key, label: `Identity attribute — ${a.name || "?"}` });
      } else if (node.type === "rule" && a.operation === "getReferenceIdentityAttribute") {
        const key = `refidn:${a.uid || "?"}:${a.attributeName || "?"}`;
        inputs.set(key, { key, label: `Referenced identity (${a.uid || "?"}) — ${a.attributeName || "?"}` });
      } else if (node.type === "reference") {
        const refName = a.id;
        if (refName && !seenRefs.has(refName)) {
          seenRefs.add(refName);
          const ref = transformsByName.get(refName);
          if (ref) walk(ref);
        }
      }
      Object.values(a).forEach(walk);
    } else {
      Object.values(node).forEach(walk);
    }
  };
  walk(transform);
  return [...inputs.values()];
}

// ─── Date handling (dateFormat / dateCompare / dateMath) ────────────────────

const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MONTHS_SHORT = MONTHS_LONG.map((m) => m.slice(0, 3));
const DAYS_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAYS_SHORT = DAYS_LONG.map((d) => d.slice(0, 3));

const NAMED_FORMATS = {
  ISO8601: "yyyy-MM-dd'T'HH:mm:ss.SSSX",
  LDAP: "yyyyMMddHHmmss.0Z'Z'",
  PEOPLE_SOFT: "MM/dd/yyyy",
};

// Splits a SimpleDateFormat pattern into tokens: runs of the same pattern
// letter, quoted literals, or single literal chars.
function tokenizePattern(pattern) {
  const tokens = [];
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "'") {
      let literal = "";
      i++;
      while (i < pattern.length) {
        if (pattern[i] === "'" && pattern[i + 1] === "'") { literal += "'"; i += 2; continue; }
        if (pattern[i] === "'") { i++; break; }
        literal += pattern[i++];
      }
      tokens.push({ literal: literal || "'" });
    } else if (/[a-zA-Z]/.test(c)) {
      let run = c;
      while (pattern[i + 1] === c) { run += c; i++; }
      i++;
      tokens.push({ field: c, width: run.length });
    } else {
      tokens.push({ literal: c });
      i++;
    }
  }
  return tokens;
}

function parseDate(value, format) {
  const s = String(value).trim();
  if (format === "EPOCH_TIME_JAVA") return new Date(Number(s));
  if (format === "EPOCH_TIME_WIN32") return new Date(Number(s) / 10000 - 11644473600000);
  const pattern = NAMED_FORMATS[format] || format;
  if (!pattern || format === "ISO8601") {
    const d = new Date(s);
    if (!isNaN(d)) return d;
  }
  const tokens = tokenizePattern(pattern);
  const parts = { y: 1970, M: 1, d: 1, H: 0, m: 0, s: 0, S: 0, ampm: null, h: null };
  let pos = 0;
  for (const t of tokens) {
    if (t.literal !== undefined) {
      // Literal text must match (whitespace-tolerant).
      if (s.slice(pos, pos + t.literal.length) === t.literal) pos += t.literal.length;
      else if (/^\s$/.test(t.literal) && /^\s$/.test(s[pos] || "")) pos += 1;
      else throw new Error(`Value "${s}" doesn't match format "${pattern}" (expected "${t.literal}" at position ${pos})`);
      continue;
    }
    const f = t.field;
    if (f === "M" && t.width >= 3) {
      const rest = s.slice(pos);
      const idx = (t.width === 3 ? MONTHS_SHORT : MONTHS_LONG).findIndex((m) => rest.toLowerCase().startsWith(m.toLowerCase()));
      if (idx < 0) throw new Error(`Value "${s}" doesn't match format "${pattern}" (month name expected at position ${pos})`);
      parts.M = idx + 1;
      pos += (t.width === 3 ? MONTHS_SHORT : MONTHS_LONG)[idx].length;
      continue;
    }
    if (f === "E") {
      const rest = s.slice(pos);
      const name = [...DAYS_LONG, ...DAYS_SHORT].find((d) => rest.toLowerCase().startsWith(d.toLowerCase()));
      if (name) pos += name.length;
      continue;
    }
    if (f === "a") {
      const rest = s.slice(pos, pos + 2).toUpperCase();
      if (rest === "AM" || rest === "PM") { parts.ampm = rest; pos += 2; }
      continue;
    }
    if (f === "X" || f === "Z") {
      const m = s.slice(pos).match(/^(Z|[+-]\d{2}:?\d{2}|[+-]\d{2})/);
      if (m) pos += m[0].length;
      continue;
    }
    const m = s.slice(pos).match(t.width >= 2 ? new RegExp(`^\\d{1,${Math.max(t.width, 4)}}`) : /^\d{1,4}/);
    if (!m) throw new Error(`Value "${s}" doesn't match format "${pattern}" (number expected at position ${pos})`);
    const n = Number(t.width >= 2 && f !== "y" ? m[0].slice(0, t.width) : m[0]);
    pos += (t.width >= 2 && f !== "y" ? m[0].slice(0, t.width) : m[0]).length;
    if (f === "y") parts.y = m[0].length === 2 ? 2000 + n : n;
    else if (f === "M") parts.M = n;
    else if (f === "d") parts.d = n;
    else if (f === "H") parts.H = n;
    else if (f === "h") parts.h = n;
    else if (f === "m") parts.m = n;
    else if (f === "s") parts.s = n;
    else if (f === "S") parts.S = n;
  }
  let hour = parts.H;
  if (parts.h != null) {
    hour = parts.h % 12;
    if (parts.ampm === "PM") hour += 12;
  }
  const d = new Date(parts.y, parts.M - 1, parts.d, hour, parts.m, parts.s, parts.S);
  if (isNaN(d)) throw new Error(`Couldn't parse "${s}" with format "${pattern}"`);
  return d;
}

function pad(n, width) {
  return String(n).padStart(width, "0");
}

function formatDate(date, format) {
  if (format === "EPOCH_TIME_JAVA") return String(date.getTime());
  if (format === "EPOCH_TIME_WIN32") return String((date.getTime() + 11644473600000) * 10000);
  const pattern = NAMED_FORMATS[format] || format;
  const tokens = tokenizePattern(pattern);
  let out = "";
  for (const t of tokens) {
    if (t.literal !== undefined) { out += t.literal; continue; }
    const f = t.field;
    if (f === "y") out += t.width === 2 ? pad(date.getFullYear() % 100, 2) : pad(date.getFullYear(), t.width);
    else if (f === "M") out += t.width >= 4 ? MONTHS_LONG[date.getMonth()] : t.width === 3 ? MONTHS_SHORT[date.getMonth()] : pad(date.getMonth() + 1, t.width);
    else if (f === "d") out += pad(date.getDate(), t.width);
    else if (f === "E") out += t.width >= 4 ? DAYS_LONG[date.getDay()] : DAYS_SHORT[date.getDay()];
    else if (f === "H") out += pad(date.getHours(), t.width);
    else if (f === "h") out += pad(date.getHours() % 12 || 12, t.width);
    else if (f === "m") out += pad(date.getMinutes(), t.width);
    else if (f === "s") out += pad(date.getSeconds(), t.width);
    else if (f === "S") out += pad(date.getMilliseconds(), 3).slice(0, t.width);
    else if (f === "a") out += date.getHours() < 12 ? "AM" : "PM";
    else if (f === "X" || f === "Z") {
      const off = -date.getTimezoneOffset();
      const sign = off >= 0 ? "+" : "-";
      const abs = Math.abs(off);
      out += `${sign}${pad(Math.floor(abs / 60), 2)}${f === "X" && t.width > 1 ? ":" : ""}${pad(abs % 60, 2)}`;
    } else throw new Error(`Date format letter "${f}" isn't supported by the tester`);
  }
  return out;
}

const DATE_MATH_MS = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 };

function applyDateMath(date, expression, roundUp) {
  let expr = String(expression).trim();
  if (expr.startsWith("now")) expr = expr.slice(3);
  let d = new Date(date.getTime());
  const re = /([+\-/])(\d*)([yMwdhms])/g;
  let m;
  while ((m = re.exec(expr))) {
    const [, op, numStr, unit] = m;
    const n = Number(numStr || 0);
    if (op === "/") {
      // Round down (or up) to the unit boundary.
      if (unit === "y") d = new Date(d.getFullYear() + (roundUp ? 1 : 0), 0, 1);
      else if (unit === "M") d = new Date(d.getFullYear(), d.getMonth() + (roundUp ? 1 : 0), 1);
      else {
        const ms = DATE_MATH_MS[unit];
        d = new Date((roundUp ? Math.ceil : Math.floor)(d.getTime() / ms) * ms);
      }
    } else if (unit === "y") d.setFullYear(d.getFullYear() + (op === "+" ? n : -n));
    else if (unit === "M") d.setMonth(d.getMonth() + (op === "+" ? n : -n));
    else d = new Date(d.getTime() + (op === "+" ? 1 : -1) * n * DATE_MATH_MS[unit]);
  }
  return d;
}

// ─── Country / language tables (subset — noted to the user) ─────────────────

const ISO3166 = {
  "united states": ["US", "USA", "840"], usa: ["US", "USA", "840"], us: ["US", "USA", "840"],
  "united kingdom": ["GB", "GBR", "826"], uk: ["GB", "GBR", "826"], gb: ["GB", "GBR", "826"],
  belgium: ["BE", "BEL", "056"], be: ["BE", "BEL", "056"],
  brazil: ["BR", "BRA", "076"], br: ["BR", "BRA", "076"],
  canada: ["CA", "CAN", "124"], ca: ["CA", "CAN", "124"],
  china: ["CN", "CHN", "156"], cn: ["CN", "CHN", "156"],
  france: ["FR", "FRA", "250"], fr: ["FR", "FRA", "250"],
  germany: ["DE", "DEU", "276"], de: ["DE", "DEU", "276"],
  india: ["IN", "IND", "356"], in: ["IN", "IND", "356"],
  italy: ["IT", "ITA", "380"], it: ["IT", "ITA", "380"],
  japan: ["JP", "JPN", "392"], jp: ["JP", "JPN", "392"],
  mexico: ["MX", "MEX", "484"], mx: ["MX", "MEX", "484"],
  netherlands: ["NL", "NLD", "528"], nl: ["NL", "NLD", "528"],
  singapore: ["SG", "SGP", "702"], sg: ["SG", "SGP", "702"],
  spain: ["ES", "ESP", "724"], es: ["ES", "ESP", "724"],
  australia: ["AU", "AUS", "036"], au: ["AU", "AUS", "036"],
};

const RFC5646 = {
  eng: "en", en: "en", english: "en",
  fra: "fr", fre: "fr", fr: "fr", french: "fr",
  deu: "de", ger: "de", de: "de", german: "de",
  spa: "es", es: "es", spanish: "es",
  ita: "it", it: "it", italian: "it",
  jpn: "ja", ja: "ja", japanese: "ja",
  zho: "zh", chi: "zh", zh: "zh", chinese: "zh",
  nld: "nl", dut: "nl", nl: "nl", dutch: "nl",
  por: "pt", pt: "pt", portuguese: "pt",
};

// ─── Evaluation ─────────────────────────────────────────────────────────────

function resolveToken(token, attributes, ctx) {
  if (typeof token !== "string") return evalNode(token, ctx);
  const m = token.match(/^\$(\w+)$/);
  if (m && attributes && attributes[m[1]] !== undefined) {
    return evalValue(attributes[m[1]], ctx);
  }
  return token;
}

function evalValue(v, ctx, siblingAttrs) {
  if (isTransformNode(v)) return evalNode(v, ctx);
  if (typeof v === "string" && siblingAttrs) {
    return v.replace(/\$(\w+)/g, (whole, name) =>
      siblingAttrs[name] !== undefined ? String(evalValue(siblingAttrs[name], ctx) ?? "") : whole
    );
  }
  return v;
}

function requireString(v) {
  return v == null ? "" : String(v);
}

function randomFrom(chars, length) {
  let out = "";
  for (let i = 0; i < length; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function resolveDate(v, ctx, format) {
  const s = requireString(v);
  if (s.trim().toLowerCase() === "now" || s.trim() === "") return new Date();
  return parseDate(s, format || "ISO8601");
}

function evalNode(node, ctx) {
  if (!isTransformNode(node)) return node;
  const a = node.attributes || {};
  const input = () => (a.input !== undefined ? requireString(evalValue(a.input, ctx)) : requireString(ctx.values.get("__input__") ?? ""));

  switch (node.type) {
    case "static": return requireString(evalValue(a.value, ctx, a));
    case "concat": return (a.values || []).map((v) => requireString(evalValue(v, ctx))).join("");
    case "upper": return input().toUpperCase();
    case "lower": return input().toLowerCase();
    case "trim": return input().trim();
    case "substring": {
      const s = input();
      let begin = Number(evalValue(a.begin, ctx) ?? 0);
      let end = a.end === undefined ? -1 : Number(evalValue(a.end, ctx));
      if (a.beginOffset !== undefined) begin += Number(a.beginOffset);
      if (a.endOffset !== undefined) end += Number(a.endOffset);
      if (begin < 0) begin = 0;
      return end === -1 ? s.slice(begin) : s.slice(begin, end);
    }
    case "indexOf": return String(input().indexOf(requireString(evalValue(a.substring, ctx))));
    case "lastIndexOf": return String(input().lastIndexOf(requireString(evalValue(a.substring, ctx))));
    case "split": {
      const parts = input().split(requireString(a.delimiter ?? ","));
      return parts[Number(a.index ?? 0)] ?? null;
    }
    case "replace": return input().replace(new RegExp(a.regex, "g"), requireString(a.replacement ?? ""));
    case "replaceAll": {
      let s = input();
      for (const [pattern, replacement] of Object.entries(a.table || {})) {
        s = s.replace(new RegExp(pattern, "g"), requireString(replacement));
      }
      return s;
    }
    case "lookup": {
      const table = a.table || {};
      const key = input();
      if (Object.prototype.hasOwnProperty.call(table, key)) return requireString(table[key]);
      return table.default !== undefined ? requireString(table.default) : null;
    }
    case "firstValid": {
      for (const v of a.values || []) {
        try {
          const out = evalValue(v, ctx);
          if (out !== null && out !== undefined && out !== "") return requireString(out);
        } catch (err) {
          if (!a.ignoreErrors) throw err;
        }
      }
      return null;
    }
    case "conditional": {
      const expr = requireString(a.expression);
      const m = expr.match(/^(.+?)\s+eq\s+(.+)$/);
      if (!m) throw new Error(`Unsupported conditional expression: "${expr}" (only "A eq B" is supported)`);
      const left = requireString(resolveToken(m[1].trim(), a, ctx));
      const right = requireString(resolveToken(m[2].trim(), a, ctx));
      const branch = left === right ? a.positiveCondition : a.negativeCondition;
      return requireString(resolveToken(branch, a, ctx));
    }
    case "accountAttribute": return requireString(ctx.values.get(`acct:${a.sourceName || "?"}:${a.attributeName || "?"}`) ?? "");
    case "identityAttribute": return requireString(ctx.values.get(`idn:${a.name || "?"}`) ?? "");
    case "reference": {
      const ref = ctx.transformsByName.get(a.id);
      if (!ref) throw new Error(`Referenced transform "${a.id}" wasn't found in this tenant's transform list`);
      return evalNode(ref, ctx);
    }
    case "dateFormat": {
      const inFmt = a.inputFormat || "ISO8601";
      const outFmt = a.outputFormat || "ISO8601";
      const d = parseDate(input(), inFmt);
      return formatDate(d, outFmt);
    }
    case "dateCompare": {
      const first = resolveDate(evalValue(a.firstDate, ctx), ctx);
      const second = resolveDate(evalValue(a.secondDate, ctx), ctx);
      const op = requireString(a.operator).toUpperCase();
      const cmp = { LT: first < second, LTE: first <= second, GT: first > second, GTE: first >= second }[op];
      if (cmp === undefined) throw new Error(`dateCompare operator "${a.operator}" isn't supported (LT/LTE/GT/GTE)`);
      return requireString(evalValue(cmp ? a.positiveCondition : a.negativeCondition, ctx, a));
    }
    case "dateMath": {
      const base = a.input !== undefined ? resolveDate(evalValue(a.input, ctx), ctx) : new Date();
      const result = applyDateMath(base, a.expression || "now", a.roundUp === true || a.roundUp === "true");
      return formatDate(result, "yyyy-MM-dd'T'HH:mm");
    }
    case "base64Encode": {
      return btoa(unescape(encodeURIComponent(input())));
    }
    case "base64Decode": {
      try {
        return decodeURIComponent(escape(atob(input())));
      } catch {
        throw new Error("Input isn't valid base64");
      }
    }
    case "decomposeDiacriticalMarks": {
      return input().normalize("NFD").replace(/[̀-ͯ]/g, "");
    }
    case "leftPad": {
      return input().padStart(Number(a.length ?? 0), requireString(a.padding ?? " ") || " ");
    }
    case "rightPad": {
      return input().padEnd(Number(a.length ?? 0), requireString(a.padding ?? " ") || " ");
    }
    case "e164phone": {
      ctx.notes.add("e164phone uses a naive digits-only conversion here — region-specific rules aren't simulated.");
      const digits = input().replace(/[^\d+]/g, "");
      if (digits.startsWith("+")) return "+" + digits.slice(1).replace(/\D/g, "");
      return digits.length === 10 && (a.defaultRegion === undefined || a.defaultRegion === "US") ? `+1${digits}` : `+${digits}`;
    }
    case "iso3166": {
      ctx.notes.add("iso3166 uses a limited built-in country table in this tester.");
      const entry = ISO3166[input().trim().toLowerCase()];
      if (!entry) throw new Error(`Country "${input()}" isn't in the tester's ISO3166 subset table`);
      const fmt = requireString(a.format || "alpha2").toLowerCase();
      return fmt === "alpha3" ? entry[1] : fmt === "numeric" ? entry[2] : entry[0];
    }
    case "rfc5646": {
      ctx.notes.add("rfc5646 uses a limited built-in language table in this tester.");
      const tag = RFC5646[input().trim().toLowerCase()];
      if (!tag) throw new Error(`Language "${input()}" isn't in the tester's RFC5646 subset table`);
      return tag;
    }
    case "nameNormalizer": {
      ctx.notes.add("nameNormalizer applies simple title-casing here — ISC's full normalization rules aren't simulated.");
      return input().toLowerCase().replace(/(^|[\s\-'])(\p{L})/gu, (m0, sep, ch) => sep + ch.toUpperCase());
    }
    case "uuid": {
      return (crypto.randomUUID && crypto.randomUUID()) || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }
    case "rule": {
      const op = a.operation;
      if (op === "getEndOfString") {
        const s = input();
        const n = Number(a.numChars ?? 0);
        return n > s.length ? null : s.slice(s.length - n);
      }
      if (op === "generateRandomString") {
        let chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
        if (a.includeNumbers === "true" || a.includeNumbers === true) chars += "0123456789";
        if (a.includeSpecialChars === "true" || a.includeSpecialChars === true) chars += "!@#$%&*()+<>?";
        return randomFrom(chars, Number(a.length ?? 16));
      }
      if (op === "randomAlphaNumeric") {
        return randomFrom("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", Number(a.length ?? 32));
      }
      if (op === "randomNumeric") {
        return randomFrom("0123456789", Number(a.length ?? 32));
      }
      if (op === "getReferenceIdentityAttribute") {
        return requireString(ctx.values.get(`refidn:${a.uid || "?"}:${a.attributeName || "?"}`) ?? "");
      }
      throw new Error(`Rule operation "${op || a.name || "unknown"}" isn't supported by the tester (custom rules run server-side in ISC)`);
    }
    case "usernameGenerator":
      throw new Error("usernameGenerator can't be simulated — its uniqueness checks run against ISC itself");
    default:
      throw new Error(`Transform type "${node.type}" isn't supported by the tester yet`);
  }
}

/**
 * Runs a transform definition against the prompted values.
 * values: Map(inputKey -> string). transformsByName: Map(name -> transform).
 * Returns { result, notes: string[] } or throws with a readable message.
 */
export function evaluateTransform(transform, values, transformsByName = new Map()) {
  const ctx = { values, transformsByName, notes: new Set() };
  const result = evalNode(transform, ctx);
  return { result, notes: [...ctx.notes] };
}
