/**
 * ported/tenantInfo.js
 * Browser-side port of the old Express tenant-level info routes:
 * /api/version, /api/tenant-ui-metadata, /api/dashboard/branding (+ /logo),
 * /api/dashboard/api-usage and /api/transforms/last-updated.
 *
 * Each export returns the same body the route used to send. The dashboard
 * routes degrade rather than throw (an "unavailable" shape the card can
 * render); the rest throw routeError() so callers still read
 * err.response.data.error.
 */

import axios from "axios";
import pkg from "../../../package.json";
import { iscGet, iscSearchPage, routeError, badRequest } from "../isc";
import { getApiConfig } from "../pluginSdk";
import { getCredentials } from "../sailpoint";

const EXPERIMENTAL = { "X-SailPoint-Experimental": "true" };

// ─── /api/version ────────────────────────────────────────────────────────────
// There is no server any more: the "server" code is this bundle, so the
// version is the client package's own.
export function getVersion() {
  return { version: pkg.version };
}

// ─── /api/tenant-ui-metadata ─────────────────────────────────────────────────
/**
 * The tenant's instance badge, if it has one.
 *
 * The badge is NOT part of the Branding API (its schema has no badge fields
 * in any published version). It lives on the tenant UI metadata service,
 * GET /ui-metadata/v1/tenant, which is experimental and refuses the call
 * without X-SailPoint-Experimental: true, and is ORG_ADMIN-only
 * (idn:ui-access-metadata-page:read).
 *
 * Returns { badge: null } rather than an error when the tenant has no badge
 * or this account can't read it — the nav just falls back to the site name.
 */
export async function getTenantUiMetadata() {
  try {
    const data = await iscGet("/ui-metadata/v1/tenant", undefined, EXPERIMENTAL);
    const name = typeof data?.instanceBadgeDisplayName === "string" ? data.instanceBadgeDisplayName.trim() : "";
    // instanceBadgeVisible defaults to false, so a configured-but-hidden
    // badge must not be shown.
    if (!data?.instanceBadgeVisible || !name) return { badge: null };
    const color = typeof data.instanceBadgeColor === "string" ? data.instanceBadgeColor.trim().replace(/^#/, "") : "";
    return { badge: { name, color: /^[0-9a-f]{3}([0-9a-f]{3})?$/i.test(color) ? `#${color}` : null } };
  } catch (err) {
    console.warn("[tenant-ui-metadata] unavailable:", err.response?.status || err.message);
    return { badge: null };
  }
}

// ─── /api/dashboard/api-usage ────────────────────────────────────────────────

const USAGE_COUNT_KEYS = ["NumberOfCalls", "count", "total", "totalCount", "value", "apiCallCount", "requests"];
let loggedApiUsageShape = false;

function readUsageCount(data) {
  if (typeof data === "number") return data;
  // Some ISC collection responses wrap a single row in an array.
  if (Array.isArray(data)) return data.length ? readUsageCount(data[0]) : null;
  if (!data || typeof data !== "object") return null;

  const entries = Object.entries(data);
  const lower = new Map(entries.map(([k, v]) => [k.toLowerCase(), v]));
  for (const key of USAGE_COUNT_KEYS) {
    const v = lower.get(key.toLowerCase());
    if (typeof v === "number") return v;
  }
  const numeric = entries.filter(([, v]) => typeof v === "number");
  return numeric.length === 1 ? numeric[0][1] : null;
}

export async function getApiUsageCount({ days: rawDays } = {}) {
  const days = Math.min(Math.max(Number(rawDays) || 30, 1), 365);
  const until = new Date();
  const since = new Date(until.getTime() - days * 24 * 60 * 60 * 1000);
  const iso = (d) => d.toISOString().slice(0, 10);

  try {
    const data = await iscGet(
      "/api-usage/v1/count",
      { filters: `startDate gt "${iso(since)}" and endDate lt "${iso(until)}"` },
      EXPERIMENTAL
    );
    if (!loggedApiUsageShape) {
      loggedApiUsageShape = true;
      console.log("[dashboard] api-usage raw response shape:", JSON.stringify(data)?.slice(0, 400));
    }
    const count = readUsageCount(data);
    return { count, days, since: since.toISOString(), until: until.toISOString(), ...(count == null ? { unrecognized: true } : {}) };
  } catch (err) {
    // Experimental and permission-gated: a tenant or token without access to
    // it shouldn't break the dashboard, so this reports unavailable rather
    // than erroring the whole page.
    const status = err.response?.status;
    console.warn(`[dashboard] api-usage unavailable (${status || err.message})`);
    return { count: null, days, unavailable: true, reason: status === 403 ? "no-access" : status === 404 ? "not-enabled" : "error" };
  }
}

// ─── /api/dashboard/branding ─────────────────────────────────────────────────
// Probed live against the tenant: /v2026/brandings, /v3/brandings and
// /brandings/v1 all answer (401 unauthenticated); /beta/brandings 404s, so
// it isn't tried. Which one a tenant serves varies, so the first that
// answers wins.
const BRANDING_PATHS = ["/v2026/brandings", "/v3/brandings", "/brandings/v1"];

async function fetchBrandingList() {
  let lastErr = null;
  for (const path of BRANDING_PATHS) {
    try {
      const data = await iscGet(path);
      const list = Array.isArray(data) ? data : data ? [data] : [];
      if (list.length) return list;
    } catch (err) {
      lastErr = err;
    }
  }
  if (lastErr) throw lastErr;
  return [];
}

/**
 * The brand a GIVEN USER sees, not just the tenant default.
 *
 * ISC assigns brands by a "brand identity attribute": each brand is created
 * with the attribute VALUE that identifies the users belonging to it, and a
 * user sees the brand matching their own value. Which attribute carries it
 * is a tenant-level choice and isn't exposed on the branding objects, so
 * rather than hard-coding a guess this matches the signed-in identity's
 * attribute values against the brand names and reports which attribute hit.
 * No match falls back to "default", then to the only/first brand.
 */
function resolveBrandForIdentity(list, attributes) {
  const byName = new Map(
    list.filter((b) => b?.name).map((b) => [String(b.name).trim().toLowerCase(), b])
  );
  for (const [key, raw] of Object.entries(attributes || {})) {
    if (raw == null) continue;
    const value = String(raw).trim();
    if (!value) continue;
    const hit = byName.get(value.toLowerCase());
    // "default" is every tenant's baseline brand, not evidence that this
    // user's attribute picked it out.
    if (hit && String(hit.name).toLowerCase() !== "default") {
      return { item: hit, matchedAttribute: key, matchedValue: value };
    }
  }
  const fallback = list.find((b) => String(b.name).toLowerCase() === "default") || list[0] || null;
  return fallback ? { item: fallback, matchedAttribute: null, matchedValue: null } : null;
}

/** The signed-in user's identity attributes, for brand resolution. */
async function fetchSessionIdentityAttributes(identityId) {
  if (!identityId) return {};
  try {
    const rec = await iscGet(`/v2026/identities/${identityId}`);
    return rec?.attributes && typeof rec.attributes === "object" ? rec.attributes : {};
  } catch {
    // Without attributes the tenant default still renders — better than
    // failing the card outright.
    return {};
  }
}

async function fetchBrandingItem() {
  const list = await fetchBrandingList();
  if (!list.length) return null;
  const attributes = list.length > 1 ? await fetchSessionIdentityAttributes(getCredentials()?.identityId) : {};
  return resolveBrandForIdentity(list, attributes);
}

/**
 * GET /api/dashboard/branding — the tenant's branding name and colours.
 * `logoAvailable` tells the client whether to request the image below.
 * { available: false } when the tenant has none or it can't be read.
 */
export async function getBranding() {
  try {
    const found = await fetchBrandingItem();
    if (!found) return { available: false };
    const { item, matchedAttribute, matchedValue } = found;
    // Hex values, normalised to "#rrggbb" — ISC stores them without the
    // leading "#" and a tenant may have left any of them unset.
    const hex = (v) => {
      const h = String(v || "").trim().replace(/^#/, "");
      return /^[0-9a-f]{3}([0-9a-f]{3})?$/i.test(h) ? `#${h}` : null;
    };
    return {
      available: true,
      name: item.name || null,
      productName: item.productName || null,
      logoAvailable: !!(item.standardLogoURL || item.logoURL),
      colors: {
        action: hex(item.actionButtonColor),
        link: hex(item.activeLinkColor),
        navigation: hex(item.navigationColor),
      },
      // How this brand was chosen, so the card can say whether it is the
      // user's own brand or just the tenant default.
      matchedAttribute: matchedAttribute || null,
      matchedValue: matchedValue || null,
      isDefault: String(item.name || "").toLowerCase() === "default",
    };
  } catch (err) {
    console.warn("[dashboard] branding unavailable:", err.response?.status || err.message);
    return { available: false };
  }
}

/**
 * GET /api/dashboard/branding/logo — the logo image itself, as a Blob.
 * The URL ISC returns sits behind the tenant's own auth, so an <img src>
 * can't load it directly; this fetches it with the plugin's token attached
 * (the server used to stream it through with the session's token).
 * Throws a 404-shaped route error when there is no logo or it can't load,
 * and 415 when the URL doesn't serve an image.
 */
export async function fetchBrandingLogoBlob() {
  let found;
  try {
    found = await fetchBrandingItem();
  } catch (err) {
    console.warn("[dashboard] branding logo unavailable:", err.response?.status || err.message);
    throw badRequest("Branding logo could not be loaded.", 404);
  }
  const raw = found?.item?.standardLogoURL || found?.item?.logoURL;
  if (!raw) throw badRequest("This tenant has no branding logo.", 404);
  try {
    const { baseUrl, token } = await getApiConfig();
    // The stored value may be absolute or tenant-relative.
    const url = /^https?:\/\//i.test(raw) ? raw : `${baseUrl}${raw.startsWith("/") ? "" : "/"}${raw}`;
    const img = await axios.get(url, { responseType: "blob", headers: { Authorization: `Bearer ${token}` } });
    const type = img.headers?.["content-type"] || img.data?.type || "image/png";
    if (!/^image\//i.test(type)) throw badRequest("Branding logo is not an image.", 415);
    return img.data instanceof Blob && img.data.type ? img.data : new Blob([img.data], { type });
  } catch (err) {
    if (err?.isRouteError) throw err;
    console.warn("[dashboard] branding logo unavailable:", err.response?.status || err.message);
    throw badRequest("Branding logo could not be loaded.", 404);
  }
}

// ─── /api/transforms/last-updated ────────────────────────────────────────────
// ISC transforms carry no dates, so "last updated" comes from ISC's audit
// events instead: { updated: { [transformId]: { at, by } }, scanned, truncated }.
// A transform with no entry hasn't changed within ISC's audit retention.
const TRANSFORM_EVENT_PAGE = 250;
const TRANSFORM_EVENT_MAX = 5000;

export async function getTransformsLastUpdated() {
  try {
    const updated = {};
    let scanned = 0;
    let truncated = false;
    for (let offset = 0; ; offset += TRANSFORM_EVENT_PAGE) {
      if (offset >= TRANSFORM_EVENT_MAX) { truncated = true; break; }
      const { items } = await iscSearchPage(
        {
          indices: ["events"],
          query: { query: 'type:TRANSFORM AND technicalName:("TRANSFORM_CREATE_PASSED" OR "TRANSFORM_UPDATE_PASSED")' },
          sort: ["-created"],
          queryResultFilter: { includes: ["created", "actor.name", "attributes.transformId"] },
        },
        { limit: TRANSFORM_EVENT_PAGE, offset }
      );
      for (const ev of items) {
        const id = String(ev.attributes?.transformId || "").replace(/^Transform:\s*/i, "").trim();
        if (id && ev.created && !updated[id]) updated[id] = { at: ev.created, by: ev.actor?.name || null };
      }
      scanned += items.length;
      if (items.length < TRANSFORM_EVENT_PAGE) break;
    }
    return { updated, scanned, truncated };
  } catch (err) {
    console.error("[transforms] last-updated failed:", err.response?.data || err.message);
    const out = routeError(err);
    const text = err.response?.data?.messages?.[0]?.text;
    if (text) { out.message = text; out.response.data.error = text; }
    throw out;
  }
}
