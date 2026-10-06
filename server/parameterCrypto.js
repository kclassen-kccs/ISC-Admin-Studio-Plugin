// Parameter Storage private-field encryption — the exact scheme ISC's own
// Parameter Storage UI uses (read from its bundle, saas-mfe-parameter-store
// build161, and matched against a HAR of a successful secret update):
//
//   1. Random P-384 key pair; its uncompressed public key (0x04||X||Y) goes
//      to GET /v2025/parameter-storage/attestation?key=<base64url, WITH
//      padding> (header X-SailPoint-Experimental: true).
//   2. The response is an AWS Nitro attestation document (COSE_Sign1 over a
//      CBOR map): public_key = the enclave's ephemeral P-384 key for this
//      handshake, user_data = {"ikid": "<ingress key id>"}. Verified here —
//      signature, chain to the AWS Nitro root, nonce, freshness — like the
//      UI does when its PLTFIDE43_UI_ATTESTATION_VERIFICATION flag is on.
//   3. Z = ECDH(our private key, public_key) — the shared X coordinate;
//      transit key = SHA-256(00 00 00 01 || Z || "parameter-storage").
//   4. privateFields = compact JWE of JSON.stringify(<private fields>):
//      protected header {"alg":"dir","enc":"A256GCM","ingress-key-id":ikid},
//      empty encrypted-key segment, 96-bit IV, AAD = the encoded header.
//
// Built only on node:crypto.

const crypto = require("crypto");

// SHA-256 fingerprint of the AWS Nitro Enclaves root certificate, as
// published by AWS (and matched by the live attestation documents).
const NITRO_ROOT_SHA256 = "641A0321A3E244EFE456463195D606317ED7CDCC3C1756E09893F3C68F79BB5B";
const MAX_ATTESTATION_AGE_MS = 5 * 60 * 1000;

// ─── Minimal CBOR (just what COSE / Nitro attestation use) ──────────────────
function decodeCbor(buf) {
  let i = 0;
  const len = (ai) => {
    if (ai < 24) return ai;
    if (ai === 24) return buf[i++];
    if (ai === 25) { const v = buf.readUInt16BE(i); i += 2; return v; }
    if (ai === 26) { const v = buf.readUInt32BE(i); i += 4; return v; }
    if (ai === 27) { const v = Number(buf.readBigUInt64BE(i)); i += 8; return v; }
    throw new Error(`unsupported CBOR length encoding ${ai}`);
  };
  const item = () => {
    const b = buf[i++];
    const mt = b >> 5;
    const ai = b & 31;
    switch (mt) {
      case 0: return len(ai);
      case 1: return -1 - len(ai);
      case 2: { const n = len(ai); const v = buf.subarray(i, i + n); i += n; return Buffer.from(v); }
      case 3: { const n = len(ai); const v = buf.toString("utf8", i, i + n); i += n; return v; }
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
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  if (n < 65536) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b; }
  const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b;
}
const cborBytes = (buf) => Buffer.concat([cborHead(2, buf.length), buf]);
const cborText = (s) => { const b = Buffer.from(s, "utf8"); return Buffer.concat([cborHead(3, b.length), b]); };

// ─── Attestation verification ───────────────────────────────────────────────
function ecPublicKeyFromPoint(point) {
  if (!point || point.length !== 97 || point[0] !== 4) throw new Error("expected an uncompressed P-384 public key");
  return crypto.createPublicKey({
    key: { kty: "EC", crv: "P-384", x: point.subarray(1, 49).toString("base64url"), y: point.subarray(49).toString("base64url") },
    format: "jwk",
  });
}

/**
 * Verifies a base64 attestation document and returns
 * { servicePublicKey: KeyObject, kid } — throws on anything that doesn't check out.
 */
function verifyAttestation(attestationB64, expectedNonce) {
  const cose = decodeCbor(Buffer.from(attestationB64, "base64"));
  if (!Array.isArray(cose) || cose.length !== 4) throw new Error("attestation is not a COSE_Sign1 structure");
  const [protectedHeader, , payloadBytes, signature] = cose;
  const doc = decodeCbor(payloadBytes);

  // Certificate chain: cabundle[0] is the AWS root, each next cert is signed
  // by the previous one, the leaf (doc.certificate) by the last.
  const bundle = (doc.cabundle || []).map((der) => new crypto.X509Certificate(der));
  if (bundle.length === 0) throw new Error("attestation has no CA bundle");
  if (bundle[0].fingerprint256.replace(/:/g, "") !== NITRO_ROOT_SHA256) throw new Error("attestation root is not the AWS Nitro Enclaves root");
  const leaf = new crypto.X509Certificate(doc.certificate);
  let issuer = bundle[0];
  for (const cert of [...bundle.slice(1), leaf]) {
    if (!cert.verify(issuer.publicKey)) throw new Error("attestation certificate chain does not verify");
    const now = Date.now();
    if (now < Date.parse(cert.validFrom) || now > Date.parse(cert.validTo)) throw new Error("attestation certificate is not currently valid");
    issuer = cert;
  }

  // COSE_Sign1 signature (ES384, raw r||s) over Sig_structure.
  const sigStructure = Buffer.concat([
    cborHead(4, 4), cborText("Signature1"), cborBytes(protectedHeader), cborBytes(Buffer.alloc(0)), cborBytes(payloadBytes),
  ]);
  if (!crypto.verify("sha384", sigStructure, { key: leaf.publicKey, dsaEncoding: "ieee-p1363" }, signature)) {
    throw new Error("attestation signature does not verify");
  }

  if (!doc.nonce || !Buffer.from(doc.nonce).equals(expectedNonce)) throw new Error("attestation was not issued for this request (nonce mismatch)");
  if (typeof doc.timestamp !== "number" || Math.abs(Date.now() - doc.timestamp) > MAX_ATTESTATION_AGE_MS) throw new Error("attestation is stale");

  let kid;
  try { kid = doc.user_data ? JSON.parse(Buffer.from(doc.user_data).toString("utf8")).ikid : undefined; } catch { kid = undefined; }
  ecPublicKeyFromPoint(Buffer.from(doc.public_key)); // validates it's an uncompressed P-384 point
  return { servicePoint: Buffer.from(doc.public_key), kid };
}

// ─── Transit key + JWE ───────────────────────────────────────────────────────
const TRANSIT_KEY_CONTEXT = Buffer.from("parameter-storage", "utf8");

// SHA-256(00 00 00 01 || Z || "parameter-storage") — the UI's Vnt().
function deriveTransitKey(z) {
  return crypto.createHash("sha256").update(Buffer.concat([Buffer.from([0, 0, 0, 1]), z, TRANSIT_KEY_CONTEXT])).digest();
}

// Compact JWE, alg "dir" / enc "A256GCM", with the ingress key id header.
function encryptDirJwe(plaintext, key, ingressKeyId) {
  const header = { alg: "dir", enc: "A256GCM", "ingress-key-id": ingressKeyId };
  const protectedB64 = Buffer.from(JSON.stringify(header), "utf8").toString("base64url");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(protectedB64, "ascii"));
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [protectedB64, "", iv.toString("base64url"), ciphertext.toString("base64url"), tag.toString("base64url")].join(".");
}

/**
 * Full handshake. `fetchAttestation(keyParam)` performs
 * GET /v2025/parameter-storage/attestation?key=<keyParam> and returns the
 * attestationDocument string. Returns the privateFields JWE.
 */
async function encryptPrivateFields(privateFields, fetchAttestation) {
  const ecdh = crypto.createECDH("secp384r1");
  ecdh.generateKeys();
  const point = ecdh.getPublicKey(); // 97 bytes, uncompressed
  // base64url WITH padding — exactly the UI's Fnt() (unpadded is rejected).
  const keyParam = point.toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
  const attestation = await fetchAttestation(keyParam);
  const { servicePoint, kid } = verifyAttestation(attestation, point);
  if (!kid) throw new Error("attestation user_data has no ingress key id (ikid)");
  const z = ecdh.computeSecret(servicePoint); // 48-byte shared X coordinate
  return encryptDirJwe(JSON.stringify(privateFields), deriveTransitKey(z), kid);
}

module.exports = { encryptPrivateFields, verifyAttestation, deriveTransitKey, encryptDirJwe, decodeCbor };
