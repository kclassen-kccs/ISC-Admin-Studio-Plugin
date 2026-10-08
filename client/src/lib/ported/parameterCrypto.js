/**
 * ported/parameterCrypto.js
 * Browser port of server/parameterCrypto.js — Parameter Storage private-field
 * encryption, the exact scheme ISC's own Parameter Storage UI uses (read
 * from its bundle, saas-mfe-parameter-store build161, and matched against a
 * HAR of a successful secret update):
 *
 *   1. Random P-384 key pair; its uncompressed public key (0x04||X||Y) goes
 *      to GET /v2025/parameter-storage/attestation?key=<base64url, WITH
 *      padding> (header X-SailPoint-Experimental: true).
 *   2. The response is an AWS Nitro attestation document (COSE_Sign1 over a
 *      CBOR map): public_key = the enclave's ephemeral P-384 key for this
 *      handshake, user_data = {"ikid": "<ingress key id>"}. Verified here —
 *      signature, chain to the AWS Nitro root, nonce, freshness — like the
 *      UI does when its PLTFIDE43_UI_ATTESTATION_VERIFICATION flag is on.
 *   3. Z = ECDH(our private key, public_key) — the shared X coordinate;
 *      transit key = SHA-256(00 00 00 01 || Z || "parameter-storage").
 *   4. privateFields = compact JWE of JSON.stringify(<private fields>):
 *      protected header {"alg":"dir","enc":"A256GCM","ingress-key-id":ikid},
 *      empty encrypted-key segment, 96-bit IV, AAD = the encoded header.
 *
 * Built only on WebCrypto (crypto.subtle) + crypto.getRandomValues, with a
 * minimal CBOR decoder and a small ASN.1/DER walker standing in for Node's
 * X509Certificate.
 *
 * Attestation checks, compared with the server's node:crypto version:
 *   - root fingerprint (SHA-256 of cabundle[0] DER) — same;
 *   - certificate chain: each certificate's signature over its
 *     tbsCertificate is verified with crypto.subtle.verify (ECDSA, hash per
 *     the certificate's signatureAlgorithm OID) against the issuer's
 *     SubjectPublicKeyInfo, root -> intermediates -> leaf — same as
 *     X509Certificate.verify(issuer.publicKey);
 *   - certificate validity window (notBefore / notAfter) — same;
 *   - COSE_Sign1 ES384 signature against the leaf key — same;
 *   - nonce and timestamp freshness — same.
 *   Weaker: only EC (P-256/P-384/P-521) signatures and keys are understood,
 *   which is all the Nitro chain uses — anything else fails verification
 *   rather than being accepted. Like the server, no revocation checks, no
 *   name constraints / basicConstraints / key-usage extension processing.
 *
 * Private values are never logged.
 */

// SHA-256 fingerprint of the AWS Nitro Enclaves root certificate, as
// published by AWS (and matched by the live attestation documents).
const NITRO_ROOT_SHA256 = "641A0321A3E244EFE456463195D606317ED7CDCC3C1756E09893F3C68F79BB5B";
const MAX_ATTESTATION_AGE_MS = 5 * 60 * 1000;

const subtle = crypto.subtle;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8");

// ─── Bytes / base64 helpers ─────────────────────────────────────────────────
function concatBytes(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
}

function bytesEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Accepts base64 or base64url, padded or not. */
export function base64ToBytes(s) {
  let str = String(s).replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");
  while (str.length % 4) str += "=";
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/** base64url without padding (JWE segments). */
export function bytesToBase64Url(bytes) {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** base64url WITH padding — exactly the UI's Fnt() (unpadded is rejected by the attestation route). */
export function bytesToBase64UrlPadded(bytes) {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_");
}

function hexUpper(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

// ─── Minimal CBOR (just what COSE / Nitro attestation use) ──────────────────
export function decodeCbor(input) {
  const buf = input instanceof Uint8Array ? input : new Uint8Array(input);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let i = 0;
  const len = (ai) => {
    if (ai < 24) return ai;
    if (ai === 24) return buf[i++];
    if (ai === 25) { const v = dv.getUint16(i); i += 2; return v; }
    if (ai === 26) { const v = dv.getUint32(i); i += 4; return v; }
    if (ai === 27) { const v = Number(dv.getBigUint64(i)); i += 8; return v; }
    throw new Error(`unsupported CBOR length encoding ${ai}`);
  };
  const item = () => {
    if (i >= buf.length) throw new Error("truncated CBOR");
    const b = buf[i++];
    const mt = b >> 5;
    const ai = b & 31;
    switch (mt) {
      case 0: return len(ai);
      case 1: return -1 - len(ai);
      case 2: { const n = len(ai); const v = buf.slice(i, i + n); i += n; return v; }
      case 3: { const n = len(ai); const v = textDecoder.decode(buf.subarray(i, i + n)); i += n; return v; }
      case 4: {
        const a = [];
        if (ai === 31) { while (buf[i] !== 0xff) a.push(item()); i++; return a; }
        const n = len(ai);
        for (let k = 0; k < n; k++) a.push(item());
        return a;
      }
      case 5: {
        const m = {};
        if (ai === 31) { while (buf[i] !== 0xff) { const key = item(); m[key] = item(); } i++; return m; }
        const n = len(ai);
        for (let k = 0; k < n; k++) { const key = item(); m[key] = item(); }
        return m;
      }
      case 6: len(ai); return item(); // tag — the tagged value is what matters
      case 7: return ai === 20 ? false : ai === 21 ? true : ai === 22 ? null : undefined;
      default: throw new Error(`unsupported CBOR major type ${mt}`);
    }
  };
  return item();
}

function cborHead(major, n) {
  if (n < 24) return Uint8Array.of((major << 5) | n);
  if (n < 256) return Uint8Array.of((major << 5) | 24, n);
  if (n < 65536) return Uint8Array.of((major << 5) | 25, n >> 8, n & 0xff);
  return Uint8Array.of((major << 5) | 26, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
}
const cborBytes = (bytes) => concatBytes(cborHead(2, bytes.length), bytes);
const cborText = (s) => { const b = textEncoder.encode(s); return concatBytes(cborHead(3, b.length), b); };

// ─── Minimal ASN.1 / DER (X.509 certificates) ───────────────────────────────
function derNode(bytes, offset) {
  if (offset + 2 > bytes.length) throw new Error("truncated DER");
  const tag = bytes[offset];
  let i = offset + 1;
  let length = bytes[i++];
  if (length & 0x80) {
    const n = length & 0x7f;
    if (n === 0 || n > 4) throw new Error("unsupported DER length");
    length = 0;
    for (let k = 0; k < n; k++) length = length * 256 + bytes[i++];
  }
  if (i + length > bytes.length) throw new Error("truncated DER");
  return { tag, start: offset, contentStart: i, end: i + length };
}

function derChildren(bytes, node) {
  const out = [];
  let i = node.contentStart;
  while (i < node.end) { const c = derNode(bytes, i); out.push(c); i = c.end; }
  return out;
}

function expectTag(node, tag, what) {
  if (node?.tag !== tag) throw new Error(`malformed certificate: expected ${what}`);
  return node;
}

function decodeOid(bytes, node) {
  expectTag(node, 0x06, "OBJECT IDENTIFIER");
  const parts = [];
  let v = 0;
  for (let i = node.contentStart; i < node.end; i++) {
    v = v * 128 + (bytes[i] & 0x7f);
    if (!(bytes[i] & 0x80)) {
      if (parts.length === 0) parts.push(Math.floor(v / 40), v % 40);
      else parts.push(v);
      v = 0;
    }
  }
  return parts.join(".");
}

// UTCTime (YYMMDDHHMMSSZ) or GeneralizedTime (YYYYMMDDHHMMSS[.fff]Z) -> ms.
function parseTime(bytes, node) {
  const s = textDecoder.decode(bytes.subarray(node.contentStart, node.end));
  let m;
  if (node.tag === 0x17 && (m = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(s))) {
    const yy = Number(m[1]);
    return Date.UTC(yy >= 50 ? 1900 + yy : 2000 + yy, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  }
  if (node.tag === 0x18 && (m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.\d+)?Z$/.exec(s))) {
    return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  }
  throw new Error("malformed certificate: unsupported validity time");
}

const SIGNATURE_HASH = {
  "1.2.840.10045.4.3.2": "SHA-256", // ecdsa-with-SHA256
  "1.2.840.10045.4.3.3": "SHA-384", // ecdsa-with-SHA384
  "1.2.840.10045.4.3.4": "SHA-512", // ecdsa-with-SHA512
};
const NAMED_CURVE = {
  "1.2.840.10045.3.1.7": "P-256",
  "1.3.132.0.34": "P-384",
  "1.3.132.0.35": "P-521",
};
const COORDINATE_BYTES = { "P-256": 32, "P-384": 48, "P-521": 66 };
const ID_EC_PUBLIC_KEY = "1.2.840.10045.2.1";

/**
 * The parts of an X.509 certificate the chain check needs: the raw
 * tbsCertificate (what the issuer signed), the signature algorithm's hash,
 * the DER ECDSA signature, the validity window, the raw SubjectPublicKeyInfo
 * and its named curve.
 */
export function parseCertificate(der) {
  const bytes = der instanceof Uint8Array ? der : new Uint8Array(der);
  const cert = expectTag(derNode(bytes, 0), 0x30, "Certificate SEQUENCE");
  const [tbs, sigAlg, sigValue] = derChildren(bytes, cert);
  expectTag(tbs, 0x30, "tbsCertificate");
  expectTag(sigAlg, 0x30, "signatureAlgorithm");
  expectTag(sigValue, 0x03, "signatureValue");

  const fields = derChildren(bytes, tbs);
  const k = fields[0]?.tag === 0xa0 ? 1 : 0; // optional [0] EXPLICIT version
  const validity = expectTag(fields[k + 3], 0x30, "validity");
  const spki = expectTag(fields[k + 5], 0x30, "subjectPublicKeyInfo");
  const [notBefore, notAfter] = derChildren(bytes, validity).map((n) => parseTime(bytes, n));

  const sigOid = decodeOid(bytes, derChildren(bytes, sigAlg)[0]);
  const hash = SIGNATURE_HASH[sigOid];
  if (!hash) throw new Error(`unsupported certificate signature algorithm ${sigOid}`);
  if (bytes[sigValue.contentStart] !== 0) throw new Error("malformed certificate: signature BIT STRING");
  const signature = bytes.slice(sigValue.contentStart + 1, sigValue.end);

  const [spkiAlg] = derChildren(bytes, spki);
  const [keyTypeOid, curveOid] = derChildren(bytes, expectTag(spkiAlg, 0x30, "SPKI algorithm"));
  if (decodeOid(bytes, keyTypeOid) !== ID_EC_PUBLIC_KEY) throw new Error("unsupported certificate key type (expected EC)");
  const namedCurve = NAMED_CURVE[decodeOid(bytes, curveOid)];
  if (!namedCurve) throw new Error("unsupported certificate EC curve");

  return {
    der: bytes,
    tbs: bytes.slice(tbs.start, tbs.end),
    spki: bytes.slice(spki.start, spki.end),
    namedCurve,
    hash,
    signature,
    notBefore,
    notAfter,
  };
}

// DER ECDSA-Sig-Value { r INTEGER, s INTEGER } -> raw r||s, each left-padded
// to the curve's coordinate size (what crypto.subtle.verify expects).
function derSignatureToRaw(der, size) {
  const seq = expectTag(derNode(der, 0), 0x30, "ECDSA signature");
  const [r, s] = derChildren(der, seq);
  const fixed = (node) => {
    expectTag(node, 0x02, "ECDSA signature INTEGER");
    let start = node.contentStart;
    while (start < node.end - 1 && der[start] === 0) start++;
    const v = der.subarray(start, node.end);
    if (v.length > size) throw new Error("malformed ECDSA signature");
    const out = new Uint8Array(size);
    out.set(v, size - v.length);
    return out;
  };
  return concatBytes(fixed(r), fixed(s));
}

async function importVerifyKey(cert) {
  return subtle.importKey("spki", cert.spki, { name: "ECDSA", namedCurve: cert.namedCurve }, false, ["verify"]);
}

/** Is `cert`'s signature over its tbsCertificate valid under `issuer`'s key? */
async function verifyCertificateSignature(cert, issuer) {
  const key = await importVerifyKey(issuer);
  const raw = derSignatureToRaw(cert.signature, COORDINATE_BYTES[issuer.namedCurve]);
  return subtle.verify({ name: "ECDSA", hash: cert.hash }, key, raw, cert.tbs);
}

// ─── Attestation verification ───────────────────────────────────────────────
function assertP384Point(point) {
  if (!point || point.length !== 97 || point[0] !== 4) throw new Error("expected an uncompressed P-384 public key");
  return point;
}

/**
 * Verifies a base64 attestation document and returns
 * { servicePoint: Uint8Array(97), kid } — throws on anything that doesn't
 * check out. `expectedNonce` is our public point (the ?key= we sent).
 * `options.now` / `options.rootSha256` exist for tests only.
 */
export async function verifyAttestation(attestationB64, expectedNonce, options = {}) {
  const now = options.now ?? Date.now();
  const rootSha256 = options.rootSha256 ?? NITRO_ROOT_SHA256;

  const cose = decodeCbor(base64ToBytes(attestationB64));
  if (!Array.isArray(cose) || cose.length !== 4) throw new Error("attestation is not a COSE_Sign1 structure");
  const [protectedHeader, , payloadBytes, signature] = cose;
  if (!(protectedHeader instanceof Uint8Array) || !(payloadBytes instanceof Uint8Array) || !(signature instanceof Uint8Array)) {
    throw new Error("attestation is not a COSE_Sign1 structure");
  }
  const doc = decodeCbor(payloadBytes);

  // Certificate chain: cabundle[0] is the AWS root, each next cert is signed
  // by the previous one, the leaf (doc.certificate) by the last.
  const bundleDer = Array.isArray(doc.cabundle) ? doc.cabundle : [];
  if (bundleDer.length === 0) throw new Error("attestation has no CA bundle");
  const rootFingerprint = hexUpper(new Uint8Array(await subtle.digest("SHA-256", bundleDer[0])));
  if (rootFingerprint !== rootSha256.toUpperCase()) throw new Error("attestation root is not the AWS Nitro Enclaves root");
  const bundle = bundleDer.map(parseCertificate);
  if (!(doc.certificate instanceof Uint8Array)) throw new Error("attestation has no certificate");
  const leaf = parseCertificate(doc.certificate);
  let issuer = bundle[0];
  for (const cert of [...bundle.slice(1), leaf]) {
    if (!(await verifyCertificateSignature(cert, issuer))) throw new Error("attestation certificate chain does not verify");
    if (now < cert.notBefore || now > cert.notAfter) throw new Error("attestation certificate is not currently valid");
    issuer = cert;
  }

  // COSE_Sign1 signature (ES384, raw r||s) over Sig_structure.
  const sigStructure = concatBytes(
    cborHead(4, 4), cborText("Signature1"), cborBytes(protectedHeader), cborBytes(new Uint8Array(0)), cborBytes(payloadBytes)
  );
  const leafKey = await importVerifyKey(leaf);
  if (!(await subtle.verify({ name: "ECDSA", hash: "SHA-384" }, leafKey, signature, sigStructure))) {
    throw new Error("attestation signature does not verify");
  }

  if (!(doc.nonce instanceof Uint8Array) || !bytesEqual(doc.nonce, expectedNonce)) {
    throw new Error("attestation was not issued for this request (nonce mismatch)");
  }
  if (typeof doc.timestamp !== "number" || Math.abs(now - doc.timestamp) > MAX_ATTESTATION_AGE_MS) throw new Error("attestation is stale");

  let kid;
  try { kid = doc.user_data ? JSON.parse(textDecoder.decode(doc.user_data)).ikid : undefined; } catch { kid = undefined; }
  const servicePoint = assertP384Point(doc.public_key instanceof Uint8Array ? doc.public_key : null);
  return { servicePoint, kid };
}

// ─── Transit key + JWE ───────────────────────────────────────────────────────
const TRANSIT_KEY_CONTEXT = textEncoder.encode("parameter-storage");

/** SHA-256(00 00 00 01 || Z || "parameter-storage") — the UI's Vnt(). Returns 32 raw bytes. */
export async function deriveTransitKey(z) {
  const material = concatBytes(Uint8Array.of(0, 0, 0, 1), z, TRANSIT_KEY_CONTEXT);
  return new Uint8Array(await subtle.digest("SHA-256", material));
}

/** Compact JWE, alg "dir" / enc "A256GCM", with the ingress key id header. `key` = 32 raw bytes. */
export async function encryptDirJwe(plaintext, keyBytes, ingressKeyId) {
  const header = { alg: "dir", enc: "A256GCM", "ingress-key-id": ingressKeyId };
  const protectedB64 = bytesToBase64Url(textEncoder.encode(JSON.stringify(header)));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt"]);
  const sealed = new Uint8Array(
    await subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: textEncoder.encode(protectedB64), tagLength: 128 },
      key,
      textEncoder.encode(plaintext)
    )
  );
  const ciphertext = sealed.subarray(0, sealed.length - 16);
  const tag = sealed.subarray(sealed.length - 16);
  return [protectedB64, "", bytesToBase64Url(iv), bytesToBase64Url(ciphertext), bytesToBase64Url(tag)].join(".");
}

/**
 * Full handshake. `fetchAttestation(keyParam)` performs
 * GET /v2025/parameter-storage/attestation?key=<keyParam> and returns the
 * attestationDocument string. Returns the privateFields JWE.
 * `options` is passed to verifyAttestation (tests only).
 */
export async function encryptPrivateFields(privateFields, fetchAttestation, options) {
  const ecdh = { name: "ECDH", namedCurve: "P-384" };
  const pair = await subtle.generateKey(ecdh, false, ["deriveBits"]);
  const point = new Uint8Array(await subtle.exportKey("raw", pair.publicKey)); // 97 bytes, uncompressed
  const keyParam = bytesToBase64UrlPadded(point);
  const attestation = await fetchAttestation(keyParam);
  const { servicePoint, kid } = await verifyAttestation(attestation, point, options);
  if (!kid) throw new Error("attestation user_data has no ingress key id (ikid)");
  const serviceKey = await subtle.importKey("raw", servicePoint, ecdh, false, []);
  const z = new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: serviceKey }, pair.privateKey, 384)); // 48-byte shared X
  return encryptDirJwe(JSON.stringify(privateFields), await deriveTransitKey(z), kid);
}
