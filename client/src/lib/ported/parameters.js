/**
 * ported/parameters.js
 * Browser-side port of the old Express /api/parameters routes (Browse >
 * Parameters): the type specifications (requested in English — ISC
 * otherwise answers in an arbitrary language), and create / update, whose
 * private fields (passwords, client secrets, header values) are encrypted
 * end to end to SailPoint's enclave before they're sent — see
 * ./parameterCrypto.js. Reads, references and deletes stay on the generic
 * ISC calls in lib/sailpoint.js.
 *
 * NOT ported: /api/parameters/test-http and /api/parameters/test-oauth.
 * They made outbound HTTP calls to arbitrary hosts from the server, which
 * the plugin's CSP forbids from the browser.
 *
 * Each export returns the same body the route used to send. Failures throw
 * routeError()/badRequest() so callers still read err.response.data.error.
 * Private field values are never logged or echoed back.
 */

import { iscGet, iscRaw, describeError, routeError, badRequest } from "../isc";
import { getCredentials } from "../sailpoint";
import { encryptPrivateFields } from "./parameterCrypto";

export async function getParameterSpecifications() {
  try {
    return await iscGet("/v2026/parameter-storage/specifications", undefined, { "Accept-Language": "en" });
  } catch (err) {
    throw routeError(err);
  }
}

// Only non-empty private values are sent; an empty object means "leave the
// stored secrets as they are" on update.
function nonEmptyPrivateFields(privateFields) {
  if (!privateFields || typeof privateFields !== "object") return null;
  const kept = Object.fromEntries(Object.entries(privateFields).filter(([, v]) => v != null && String(v) !== ""));
  return Object.keys(kept).length ? kept : null;
}

// Writes mirror ISC's own Parameter Storage UI exactly (its bundle + a HAR
// of a successful secret update): /v2025/parameter-storage with
// X-SailPoint-Experimental: true. Create sends privateFields in the POST;
// update saves the other fields first, then the secret in its OWN
// PATCH { privateFields } — as the UI does.
const PARAMETER_STORAGE_ROOT = "/v2025/parameter-storage";
const EXPERIMENTAL = { "X-SailPoint-Experimental": "true" };
const WRITE_HEADERS = { "Content-Type": "application/json", ...EXPERIMENTAL };

function encryptForTenant(privateFields) {
  return encryptPrivateFields(privateFields, async (keyParam) => {
    const doc = await iscGet(`${PARAMETER_STORAGE_ROOT}/attestation`, { key: keyParam }, EXPERIMENTAL);
    if (!doc?.attestationDocument) throw new Error("ISC returned no attestation document");
    return doc.attestationDocument;
  });
}

// Encrypt + send, retrying once with a FRESH attestation on a 5xx — the HAR
// shows the UI's first secret PATCH getting a 502 and the retry (new
// handshake) succeeding. `send(jwe)` performs the request.
async function sendSecret(secrets, send) {
  for (let attempt = 1; ; attempt++) {
    const jwe = await encryptForTenant(secrets);
    try {
      return await send(jwe);
    } catch (err) {
      if (attempt < 2 && err.response?.status >= 500) {
        console.warn(`[parameters] secret request got ${err.response.status} — retrying with a fresh attestation`);
        continue;
      }
      throw err;
    }
  }
}

// If ISC refuses the secret, everything else is still saved and the caller
// gets secretNotSaved to explain it, rather than the whole save failing.
const secretNotSavedInfo = (secrets, err) => ({
  fields: Object.keys(secrets),
  reason: `ISC answered ${err.response?.status || ""} "${err.response?.data?.messages?.[0]?.text || describeError(err)}"`,
  trackingId: err.response?.data?.trackingId || null,
});

// body: { type, name, description, ownerId, publicFields, privateFields }
export async function createParameter(input) {
  const { type, name, description, ownerId, publicFields, privateFields } = input || {};
  if (!type || !String(name || "").trim()) throw badRequest("A parameter needs a type and a name.");
  try {
    const secrets = nonEmptyPrivateFields(privateFields);
    const body = {
      type: String(type),
      name: String(name).trim(),
      ownerId: ownerId || getCredentials()?.identityId,
      ...(description ? { description: String(description) } : {}),
      publicFields: publicFields && typeof publicFields === "object" ? publicFields : {},
    };
    const post = (b) => iscRaw("post", `${PARAMETER_STORAGE_ROOT}/parameters`, { data: b, headers: WRITE_HEADERS });
    let resp;
    let secretNotSaved = null;
    if (secrets) {
      try {
        resp = await sendSecret(secrets, (jwe) => post({ ...body, privateFields: jwe }));
      } catch (err) {
        if (err.response?.status !== 400) throw err;
        console.warn("[parameters] create: secret refused —", err.response?.status, "— creating without it");
        secretNotSaved = secretNotSavedInfo(secrets, err);
        resp = await post(body);
      }
    } else {
      try {
        resp = await post(body);
      } catch (err) {
        // Connection-type parameters (2.x, no private fields) are refused with
        // a bare "validation error" unless privateFields carries an encrypted
        // empty object, which is what the ISC UI sends.
        if (err.response?.status !== 400) throw err;
        resp = await sendSecret({}, (jwe) => post({ ...body, privateFields: jwe }));
      }
    }
    return { ...resp.data, ...(secretNotSaved ? { _secretNotSaved: secretNotSaved } : {}) };
  } catch (err) {
    throw routeError(err);
  }
}

// body: any of { name, description, ownerId, publicFields, privateFields } —
// empty private values are left unchanged.
export async function updateParameter(id, input) {
  const { name, description, ownerId, publicFields, privateFields } = input || {};
  try {
    const secrets = nonEmptyPrivateFields(privateFields);
    const path = `${PARAMETER_STORAGE_ROOT}/parameters/${encodeURIComponent(id)}`;
    const patch = (b) => iscRaw("patch", path, { data: b, headers: WRITE_HEADERS });
    const body = {
      ...(name != null ? { name: String(name).trim() } : {}),
      ...(description != null ? { description: String(description) } : {}),
      ...(ownerId ? { ownerId } : {}),
      ...(publicFields && typeof publicFields === "object" ? { publicFields } : {}),
    };
    let resp = Object.keys(body).length ? await patch(body) : null;
    let secretNotSaved = null;
    if (secrets) {
      try {
        resp = await sendSecret(secrets, (jwe) => patch({ privateFields: jwe }));
      } catch (err) {
        if (err.response?.status !== 400) throw err;
        console.warn("[parameters] update: secret refused —", err.response?.status);
        secretNotSaved = secretNotSavedInfo(secrets, err);
      }
    }
    return { ...(resp?.data || {}), ...(secretNotSaved ? { _secretNotSaved: secretNotSaved } : {}) };
  } catch (err) {
    throw routeError(err);
  }
}
