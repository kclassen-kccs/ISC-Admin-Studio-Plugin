/**
 * isc.js
 * Client-side replacements for the helpers the retired Express server used
 * inside its routes (iscGet, withApiRetry, describeError, fetchAllPaged,
 * iscSearchPage ...). Every call goes through the global axios instance, whose
 * request interceptor (lib/sailpoint.js) rewrites "/api/isc/<path>" to the
 * tenant API and attaches the plugin-scoped token. Paths here are ISC paths
 * WITHOUT the /api/isc prefix, e.g. "/v2026/roles/123".
 *
 * Ported route functions must fail the way the old routes did: callers read
 * `err.response.data.error` (a message string) and `err.response.status`.
 * Use routeError(err) when rethrowing from a ported route.
 */

import axios from "axios";

const PREFIX = "/api/isc";

/** Message for an ISC/axios error — same precedence as the server's describeError. */
export function describeError(err) {
  const d = err?.response?.data;
  return (
    d?.error?.message ||
    d?.error_description ||
    d?.messages?.[0]?.text ||
    d?.detailMessage ||
    d?.detailCode ||
    (typeof d?.error === "string" ? d.error : null) ||
    err?.message ||
    "Request failed."
  );
}

/** Error shaped like the old server's `res.status(n).json({ error })` response. */
export function routeError(err, fallbackStatus = 500) {
  if (err?.isRouteError) return err;
  const status = err?.response?.status || fallbackStatus;
  const out = new Error(describeError(err));
  out.isRouteError = true;
  out.response = { status, data: { error: out.message }, headers: err?.response?.headers || {} };
  return out;
}

/** Throws a route-shaped 400 (what the server sent for bad input). */
export function badRequest(message, status = 400) {
  const out = new Error(message);
  out.isRouteError = true;
  out.response = { status, data: { error: message }, headers: {} };
  return out;
}

/** Full axios response (headers included) for an ISC path. */
export function iscRaw(method, path, { params, data, headers } = {}) {
  return axios({
    method,
    url: `${PREFIX}${path}`,
    params,
    data,
    headers: { Accept: "application/json", ...headers },
  });
}

export async function iscGet(path, params, headers) {
  return (await iscRaw("get", path, { params, headers })).data;
}
export async function iscPost(path, data, { params, headers } = {}) {
  return (await iscRaw("post", path, { params, data, headers: { "Content-Type": "application/json", ...headers } })).data;
}
export async function iscPut(path, data, { params, headers } = {}) {
  return (await iscRaw("put", path, { params, data, headers: { "Content-Type": "application/json", ...headers } })).data;
}
/** JSON Patch (RFC 6902) — ISC rejects plain application/json on most PATCH routes. */
export async function iscPatch(path, ops, { params, headers } = {}) {
  return (await iscRaw("patch", path, { params, data: ops, headers: { "Content-Type": "application/json-patch+json", ...headers } })).data;
}
export async function iscDelete(path, { params, headers, data } = {}) {
  return (await iscRaw("delete", path, { params, data, headers })).data;
}

/**
 * Retries a transient (429/5xx/network) failure with backoff, honouring
 * Retry-After. 4xx failures are rethrown immediately.
 */
export async function withApiRetry(fn, { attempts = 3, label } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = err.response?.status;
      const transient = !status || status === 429 || status >= 500;
      if (!transient || err.isPluginUnavailable || attempt === attempts) throw err;
      const retryAfter = Number(err.response?.headers?.["retry-after"]);
      const waitMs = retryAfter > 0 ? retryAfter * 1000 : attempt * 750;
      console.warn(`[isc] ${label || "API call"} failed (attempt ${attempt}/${attempts}), retrying in ${waitMs}ms`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}

/** Every page of a limit/offset collection. */
export async function fetchAllPaged(path, params = {}, pageSize = 250) {
  const all = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = await withApiRetry(() => iscGet(path, { ...params, limit: pageSize, offset }), { label: `${path} page` });
    if (!Array.isArray(page) || page.length === 0) break;
    all.push(...page);
    if (page.length < pageSize) break;
  }
  return all;
}

/** One page of POST /v2026/search -> { items, total }. */
export async function iscSearchPage(body, { limit, offset = 0, count = false } = {}) {
  const resp = await iscRaw("post", "/v2026/search", {
    data: body,
    params: { limit, offset, ...(count ? { count: true } : {}) },
    headers: { "Content-Type": "application/json" },
  });
  const total = resp.headers?.["x-total-count"];
  return { items: Array.isArray(resp.data) ? resp.data : [], total: total != null ? Number(total) : null };
}
