/**
 * pluginSdk.js
 * Single owner of the SailPoint UI Plugin SDK. Admin Studio runs as an ISC UI
 * plugin: a static bundle in a sandboxed iframe whose only line to ISC is the
 * App Shell's postMessage handshake. The SDK instance is created once and the
 * handshake runs once — a second instance's READY request is dropped by the
 * host — so it is cached on globalThis to survive dev-server module reloads.
 */

import { createSDK } from "@sailpoint/ui-plugin-sdk";

const SINGLETON_KEY = Symbol.for("@sailpoint/ui-plugin-sdk#singleton");

function getSingleton() {
  const existing = globalThis[SINGLETON_KEY];
  if (existing) return existing;
  let sdk = null;
  let context;
  try {
    // createSDK() throws when opened outside ISC with no resolvable App Shell
    // origin; callers see that as a rejected context.
    sdk = createSDK();
    context = sdk.getContext();
  } catch (err) {
    context = Promise.reject(err);
  }
  const singleton = { sdk, context };
  globalThis[SINGLETON_KEY] = singleton;
  return singleton;
}

/** Resolves with { tenant, user, page, slot } once the handshake completes. */
export function whenPluginReady() {
  return getSingleton().context;
}

export function getSdk() {
  const { sdk } = getSingleton();
  if (!sdk) {
    throw new Error("SailPoint plugin SDK is not available. Open Admin Studio from within Identity Security Cloud.");
  }
  return sdk;
}

/**
 * The tenant API base URL (context.tenant.apiUrl.idn) and a current scoped
 * access token. The SDK caches the token and refreshes it before expiry;
 * forceRefresh is not needed on every call.
 */
export async function getApiConfig() {
  const ctx = await whenPluginReady();
  const baseUrl = ctx?.tenant?.apiUrl?.idn;
  if (!baseUrl) throw new Error("The ISC App Shell did not provide a tenant API URL.");
  const token = await getSdk().api.getToken();
  if (!token) throw new Error("The ISC App Shell did not provide an access token.");
  return { baseUrl: String(baseUrl).replace(/\/+$/, ""), token };
}

/** Mirrors the plugin's internal route into the host URL (no history entry). */
export function reportRoute(subPath) {
  try {
    return getSdk().navigation.setRoute(subPath).catch(() => {});
  } catch {
    return Promise.resolve();
  }
}
