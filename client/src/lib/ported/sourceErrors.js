/**
 * sourceErrors.js
 * The two error-text variants the old /api/sources/* routes used besides the
 * plain describeError: "messages[0].text first" (most write routes) and
 * "messages + causes joined" (schema / dataset / resource saves).
 */

import { routeError } from "../isc";

function withMessage(err, text) {
  const out = routeError(err);
  if (text && !err?.isRouteError) {
    out.message = text;
    out.response.data = { error: text };
  }
  return out;
}

/** Same as the server's `err.response?.data?.messages?.[0]?.text || describeError(err)`. */
export function routeErrorMessages(err) {
  return withMessage(err, err?.response?.data?.messages?.[0]?.text);
}

/**
 * messages[] is the generic text; causes[] (when present) the specific
 * reason — both surfaced, de-duplicated, joined with " — ".
 */
export function routeErrorCauses(err) {
  const data = err?.response?.data;
  const texts = [];
  for (const m of [...(data?.messages || []), ...(data?.causes || [])]) {
    if (m?.text && !texts.includes(m.text)) texts.push(m.text);
  }
  return withMessage(err, texts.length ? texts.join(" — ") : null);
}

/** Header ISC's still-experimental source-apps/v1 and sources/v1 surfaces require. */
export const EXPERIMENTAL_HEADERS = { "X-SailPoint-Experimental": "true" };

/** base64 -> Blob (for multipart uploads built in the browser). */
export function base64ToBlob(b64, type = "text/csv") {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}
