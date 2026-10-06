/**
 * aiProxy.js
 * Text generation for the plugin. Two ways out of the browser, tried in order:
 *
 *  1. A direct call to api.anthropic.com with the Anthropic API key the user
 *     saved on Studio Settings → Preferences. The key lives in this browser's
 *     IndexedDB only (never in the bundle, never sent to ISC) and goes out as
 *     the x-api-key header of that one request.
 *  2. The Admin Studio AI proxy (see /ai-proxy), whose origin is the build-time
 *     setting REACT_APP_AI_PROXY_URL; it authenticates the caller by their ISC
 *     access token and holds the model key server-side.
 *
 * Either way the plugin manifest's connect-src CSP must allow the origin, and
 * today ISC accepts only script-src/style-src there, so both calls are blocked
 * by the App Shell. The failure is reported as such rather than as a vague
 * network error, so AI "works" the moment SailPoint lets plugins reach out.
 */

import axios from "axios";
import { getApiConfig } from "./pluginSdk";
import { routeError, badRequest } from "./isc";
import { getAnthropicApiKey } from "./ported/settings";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
// Same tiers as the proxy: a fast model for the many short description
// prompts, the strong one where a call asks for it (role evaluation review).
const MODEL = "claude-haiku-4-5-20251001";
const STRONG_MODEL = "claude-opus-5-5";
const TIMEOUT_MS = 190_000;

function proxyUrl() {
  return String(process.env.REACT_APP_AI_PROXY_URL || "").replace(/\/+$/, "");
}

/** True when this build knows where the AI proxy lives. */
export function aiProxyConfigured() {
  return !!proxyUrl();
}

/** True when some route to a model exists: a saved key or a proxy URL. */
export async function aiConfigured() {
  return aiProxyConfigured() || !!(await getAnthropicApiKey());
}

const CSP_BLOCKED =
  "ISC blocked the call to the model provider: the plugin's content security policy doesn't allow external connections yet.";

/** A fetch that never reached the server (CSP, DNS, offline) has no status. */
function isBlocked(err) {
  return !err?.response && (err?.name === "TypeError" || err?.code === "ERR_NETWORK" || /network error|failed to fetch/i.test(err?.message || ""));
}

async function generateDirect(apiKey, prompt, { maxTokens, strong }) {
  let resp;
  try {
    resp = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "anthropic-dangerous-direct-browser-access": "true",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: strong ? STRONG_MODEL : MODEL,
        max_tokens: maxTokens,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    if (err?.name === "TimeoutError" || err?.name === "AbortError") throw badRequest("The model provider didn't answer in time.", 504);
    if (isBlocked(err)) throw badRequest(CSP_BLOCKED, 503);
    throw routeError(err);
  }
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const message = body?.error?.message || `Model provider returned ${resp.status}.`;
    throw badRequest(resp.status === 401 ? `Anthropic rejected the saved API key: ${message}` : message, resp.status === 429 ? 429 : 502);
  }
  // The text block, wherever it sits — a model that thinks by default
  // returns its (empty-text) thinking block first.
  return body.content?.find((b) => b.type === "text")?.text?.trim() || "";
}

async function generateViaProxy(base, prompt, { maxTokens, strong }) {
  try {
    const { baseUrl, token } = await getApiConfig();
    const resp = await axios.post(
      `${base}/v1/generate`,
      { prompt, maxTokens, strong },
      { headers: { Authorization: `Bearer ${token}`, "X-ISC-Base-Url": baseUrl }, timeout: TIMEOUT_MS }
    );
    return typeof resp.data?.text === "string" ? resp.data.text.trim() : "";
  } catch (err) {
    if (isBlocked(err)) throw badRequest(CSP_BLOCKED, 503);
    throw routeError(err);
  }
}

/** One prompt in, generated text out. Throws route-shaped errors. */
export async function generateText(prompt, { maxTokens = 300, strong = false } = {}) {
  const apiKey = await getAnthropicApiKey();
  if (apiKey) return generateDirect(apiKey, prompt, { maxTokens, strong });
  const base = proxyUrl();
  if (!base) {
    throw badRequest("AI isn't configured: enter your Anthropic API key under Studio Settings → Preferences.", 503);
  }
  return generateViaProxy(base, prompt, { maxTokens, strong });
}
