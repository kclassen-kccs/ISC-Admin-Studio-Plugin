// Minimal LDAP v3 client — simple bind, one search, unbind — over LDAPS
// (TLS on 636). Written on node:tls with a small BER codec because no LDAP
// library can be installed here (the npm registry is blocked). Covers only
// what the "Add from LDAP" lookup needs; nothing is cached, and the bind
// password is never logged.

const tls = require("tls");
const net = require("net");

// ─── BER encoding ────────────────────────────────────────────────────────────
function berLength(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  while (n > 0) { bytes.unshift(n & 0xff); n >>= 8; }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag, content) => Buffer.concat([Buffer.from([tag]), berLength(content.length), content]);
function berInt(n, tag = 0x02) {
  const bytes = [];
  do { bytes.unshift(n & 0xff); n >>= 8; } while (n > 0);
  if (bytes[0] & 0x80) bytes.unshift(0);
  return tlv(tag, Buffer.from(bytes));
}
const berStr = (s, tag = 0x04) => tlv(tag, Buffer.from(String(s), "utf8"));
const berBool = (b) => tlv(0x01, Buffer.from([b ? 0xff : 0]));
const berSeq = (parts, tag = 0x30) => tlv(tag, Buffer.concat(parts));

// Filters (RFC 4511 §4.5.1): built as small objects, encoded here.
//   { and: [...] } | { or: [...] } | { eq: [attr, value] }
//   | { contains: [attr, value] } | { present: attr }
function encodeFilter(f) {
  if (f.and) return berSeq(f.and.map(encodeFilter), 0xa0);
  if (f.or) return berSeq(f.or.map(encodeFilter), 0xa1);
  if (f.eq) return berSeq([berStr(f.eq[0]), berStr(f.eq[1])], 0xa3);
  if (f.contains) return berSeq([berStr(f.contains[0]), berSeq([berStr(f.contains[1], 0x81)])], 0xa4);
  if (f.present) return berStr(f.present, 0x87);
  throw new Error("unsupported LDAP filter");
}

// ─── BER decoding ────────────────────────────────────────────────────────────
// Returns { tag, value (Buffer), end } for the TLV at `pos`, or null if the
// buffer doesn't yet hold all of it.
function readTlv(buf, pos) {
  if (pos + 2 > buf.length) return null;
  const tag = buf[pos];
  let len = buf[pos + 1];
  let p = pos + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (p + n > buf.length) return null;
    len = 0;
    for (let i = 0; i < n; i++) len = (len << 8) | buf[p + i];
    p += n;
  }
  if (p + len > buf.length) return null;
  return { tag, value: buf.subarray(p, p + len), end: p + len };
}
function children(buf) {
  const out = [];
  let p = 0;
  while (p < buf.length) {
    const t = readTlv(buf, p);
    if (!t) break;
    out.push(t);
    p = t.end;
  }
  return out;
}
const intOf = (b) => b.reduce((n, x) => (n << 8) | x, 0);

// ─── Client ──────────────────────────────────────────────────────────────────
const RESULT_TEXT = {
  0: "success", 4: "size limit exceeded", 32: "no such object", 34: "invalid DN syntax",
  49: "invalid credentials", 50: "insufficient access rights", 51: "busy", 52: "unavailable", 53: "unwilling to perform",
};

/**
 * Bind (simple) then search; resolves to [{ dn, attributes: { name: [values] } }].
 * opts: { host, port = 636, rejectUnauthorized = true, bindDn, password,
 *         base, scope = 2 (subtree), filter, attributes, sizeLimit = 25, timeoutMs = 15000 }
 * An anonymous bind is used when bindDn is empty (enough for the RootDSE).
 */
function ldapSearch(opts) {
  const { host, port = 636, rejectUnauthorized = true, bindDn = "", password = "", base, scope = 2,
    filter, attributes = [], sizeLimit = 25, timeoutMs = 15000 } = opts;
  return new Promise((resolve, reject) => {
    let done = false;
    let buf = Buffer.alloc(0);
    let socket = null; // stays null if the connection can't even be created
    const entries = [];
    const finish = (err, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (socket) {
        try { socket.end(berSeq([berInt(3), tlv(0x42, Buffer.alloc(0))])); } catch { /* closing anyway */ }
        socket.destroy();
      }
      if (err) reject(err); else resolve(value);
    };
    const timer = setTimeout(() => finish(Object.assign(new Error(`LDAP request to ${host} timed out`), { code: "LDAP_TIMEOUT" })), timeoutMs);

    try {
      // SNI only for hostnames — Node refuses an IP address as servername.
      socket = tls.connect({ host, port, ...(net.isIP(host) ? {} : { servername: host }), rejectUnauthorized }, () => {
        socket.write(berSeq([berInt(1), berSeq([berInt(3), berStr(bindDn), berStr(password, 0x80)], 0x60)]));
      });
    } catch (e) {
      return finish(Object.assign(new Error(`Can't connect to ${host}:${port} — ${e.message}`), { code: "LDAP_CONNECT" }));
    }
    socket.on("error", (e) => {
      const certIssue = /certificate|self[- ]signed|unable to verify|CERT_/i.test(`${e.code} ${e.message}`);
      finish(Object.assign(new Error(certIssue ? `The LDAP server's TLS certificate isn't trusted (${e.code || e.message})` : `Can't reach ${host}:${port} — ${e.message}`),
        { code: certIssue ? "LDAP_CERT_UNTRUSTED" : "LDAP_CONNECT" }));
    });
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const msg = readTlv(buf, 0);
        if (!msg) return;
        buf = buf.subarray(msg.end);
        const [idT, op] = children(msg.value);
        const id = intOf(idT.value);
        if (id === 1 && op.tag === 0x61) { // BindResponse
          const [rc, , diag] = children(op.value);
          const code = intOf(rc.value);
          if (code !== 0) {
            return finish(Object.assign(new Error(`LDAP bind failed: ${RESULT_TEXT[code] || `result ${code}`}${diag?.value?.length ? ` (${diag.value.toString()})` : ""}`), { code: code === 49 ? "LDAP_INVALID_CREDENTIALS" : "LDAP_BIND" }));
          }
          socket.write(berSeq([berInt(2), berSeq([
            berStr(base), berInt(scope, 0x0a), berInt(0, 0x0a), berInt(sizeLimit), berInt(Math.ceil(timeoutMs / 1000)), berBool(false),
            encodeFilter(filter), berSeq(attributes.map((a) => berStr(a))),
          ], 0x63)]));
        } else if (id === 2 && op.tag === 0x64) { // SearchResultEntry
          const [dn, attrs] = children(op.value);
          const attributes = {};
          for (const a of children(attrs.value)) {
            const [type, vals] = children(a.value);
            attributes[type.value.toString()] = children(vals.value).map((v) => v.value.toString("utf8"));
          }
          entries.push({ dn: dn.value.toString(), attributes });
        } else if (id === 2 && op.tag === 0x65) { // SearchResultDone
          const [rc, , diag] = children(op.value);
          const code = intOf(rc.value);
          // 4 = size limit exceeded: the entries so far are still valid.
          if (code !== 0 && code !== 4) {
            return finish(Object.assign(new Error(`LDAP search failed: ${RESULT_TEXT[code] || `result ${code}`}${diag?.value?.length ? ` (${diag.value.toString()})` : ""}`), { code: "LDAP_SEARCH" }));
          }
          return finish(null, Object.assign(entries, { truncated: code === 4 }));
        }
        // SearchResultReference (0x73) and anything else: ignored.
      }
    });
  });
}

module.exports = { ldapSearch, encodeFilter };
