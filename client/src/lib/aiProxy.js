/**
 * aiProxy.js
 * Client for the Admin Studio AI proxy (see /ai-proxy). The plugin iframe can't
 * hold a model API key, so text generation is the one thing that leaves the
 * browser: a finished prompt goes to the proxy, which authenticates the caller
 * by their ISC access token and returns generated text.
 *
 * The proxy origin is a build-time setting: REACT_APP_AI_PROXY_URL. It must
 * also be listed in the plugin manifest's connect-src CSP.
 */

import axios from "axios";
import { getApiConfig } from "./pluginSdk";
import { routeError, badRequest } from "./isc";

function proxyUrl() {
  return String(process.env.REACT_APP_AI_PROXY_URL || "").replace(/\/+$/, "");
}

/** True when this build knows where the AI proxy lives. */
export function aiProxyConfigured() {
  return !!proxyUrl();
}

/** One prompt in, generated text out. Throws route-shaped errors. */
export async function generateText(prompt, { maxTokens = 300, strong = false } = {}) {
  const base = proxyUrl();
  if (!base) throw badRequest("AI isn't configured for this plugin build (REACT_APP_AI_PROXY_URL is not set).", 503);
  try {
    const { baseUrl, token } = await getApiConfig();
    const resp = await axios.post(
      `${base}/v1/generate`,
      { prompt, maxTokens, strong },
      { headers: { Authorization: `Bearer ${token}`, "X-ISC-Base-Url": baseUrl }, timeout: 190_000 }
    );
    return typeof resp.data?.text === "string" ? resp.data.text.trim() : "";
  } catch (err) {
    throw routeError(err);
  }
}
