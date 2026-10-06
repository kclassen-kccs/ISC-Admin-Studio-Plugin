/**
 * Admin Studio AI proxy.
 *
 * The plugin runs as a static bundle in a browser iframe, so it can't hold a
 * model API key. This service is the one place that does. It is deliberately
 * dumb: it takes a finished prompt and returns generated text. Prompt
 * building and ISC data access stay in the browser, under the user's own token.
 *
 *   POST /v1/generate
 *     Authorization: Bearer <ISC access token from the App Shell>
 *     X-ISC-Base-Url: https://<tenant>.api.identitynow.com
 *     { prompt: string, maxTokens?: number, strong?: boolean }
 *   -> { text: string }
 *
 * Auth: the token is proven genuine by calling the caller's own tenant with it
 * (the base URL is allowlisted first, so it can't be used to reach arbitrary
 * hosts). Results are cached briefly per token.
 */

const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

const MAX_PROMPT_CHARS = 600_000;
const MAX_TOKENS_CAP = 32_000;
const VALIDATE_TTL_MS = 60_000;
const UPSTREAM_TIMEOUT_MS = 180_000;

const env = () => process.env;

function config() {
  const e = env();
  return {
    provider: (e.AI_PROVIDER || "").toLowerCase(),
    apiKey: e.ANTHROPIC_API_KEY || "",
    model: e.AI_MODEL || "claude-haiku-4-5-20251001",
    strongModel: e.AI_STRONG_MODEL || "claude-opus-5",
    bedrockModel: e.BEDROCK_MODEL_ID || "anthropic.claude-haiku-4-5",
    bedrockStrongModel: e.BEDROCK_STRONG_MODEL_ID || "anthropic.claude-opus-5",
    region: e.AWS_REGION || "us-east-1",
    baseUrlRegex: new RegExp(e.ALLOWED_BASE_URL_REGEX || "^https://[a-z0-9-]+\\.api\\.identitynow(-demo)?\\.com$"),
    baseUrlList: (e.ALLOWED_BASE_URLS || "").split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean),
    validatePath: e.ISC_VALIDATE_PATH || "/v3/public-identities-config",
  };
}

function aiConfigured(c) {
  return c.provider === "bedrock" || !!c.apiKey;
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/** Normalises and allowlists the tenant API base URL the caller claims. */
function checkBaseUrl(raw, c) {
  const baseUrl = String(raw || "").trim().replace(/\/+$/, "");
  if (!baseUrl) throw httpError(400, "X-ISC-Base-Url header is required.");
  if (!c.baseUrlRegex.test(baseUrl)) throw httpError(403, "That ISC tenant is not allowed to use this proxy.");
  if (c.baseUrlList.length && !c.baseUrlList.includes(baseUrl)) throw httpError(403, "That ISC tenant is not allowed to use this proxy.");
  return baseUrl;
}

const validated = new Map(); // sha256(token + baseUrl) -> expiry ms

/**
 * Confirms the token is accepted by the tenant it claims to be from.
 * 401 = not authenticated. A 403 still means the tenant authenticated the
 * token (this user just lacks that one permission), which is all we need.
 */
async function validateToken(token, baseUrl, c, fetchImpl = fetch) {
  const key = crypto.createHash("sha256").update(`${baseUrl}\n${token}`).digest("hex");
  const now = Date.now();
  if ((validated.get(key) || 0) > now) return;
  const resp = await fetchImpl(`${baseUrl}${c.validatePath}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (resp.status === 401 || (!resp.ok && resp.status !== 403)) {
    throw httpError(401, "Your Identity Security Cloud session could not be verified.");
  }
  validated.set(key, now + VALIDATE_TTL_MS);
  if (validated.size > 5000) for (const [k, exp] of validated) if (exp <= now) validated.delete(k);
}

let bedrock = null;
async function generate(prompt, { maxTokens, strong }, c, fetchImpl = fetch) {
  if (c.provider === "bedrock") {
    if (!bedrock) {
      const { AnthropicBedrockMantle } = require("@anthropic-ai/bedrock-sdk");
      bedrock = new AnthropicBedrockMantle({ awsRegion: c.region });
    }
    const resp = await bedrock.messages.create({
      model: strong ? c.bedrockStrongModel : c.bedrockModel,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    });
    return resp.content?.find((b) => b.type === "text")?.text?.trim();
  }
  const resp = await fetchImpl("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": c.apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
    body: JSON.stringify({
      model: strong ? c.strongModel : c.model,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) throw httpError(resp.status === 429 ? 429 : 502, body?.error?.message || `Model provider returned ${resp.status}.`);
  // The text block, wherever it sits — a model that thinks by default
  // returns its (empty-text) thinking block first.
  return body.content?.find((b) => b.type === "text")?.text?.trim();
}

function createApp({ fetchImpl = fetch, generateImpl } = {}) {
  const app = express();
  app.disable("x-powered-by");
  // Auth is an explicit bearer token (no cookies), so any origin may call.
  app.use(cors({ origin: true, methods: ["POST", "OPTIONS"], allowedHeaders: ["Authorization", "Content-Type", "X-ISC-Base-Url"], maxAge: 600 }));
  app.use(express.json({ limit: "2mb" }));

  app.get("/healthz", (req, res) => res.json({ ok: true, configured: aiConfigured(config()) }));

  app.use(
    "/v1",
    rateLimit({
      windowMs: 60_000,
      limit: 60,
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: (req) => String(req.get("x-isc-base-url") || req.ip),
      message: { error: "Too many AI requests — wait a minute and try again." },
    })
  );

  app.post("/v1/generate", async (req, res) => {
    try {
      const c = config();
      const token = (req.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
      if (!token) throw httpError(401, "Authorization bearer token is required.");
      const baseUrl = checkBaseUrl(req.get("x-isc-base-url"), c);

      const { prompt, maxTokens = 300, strong = false } = req.body || {};
      if (typeof prompt !== "string" || !prompt.trim()) throw httpError(400, "prompt is required.");
      if (prompt.length > MAX_PROMPT_CHARS) throw httpError(413, "prompt is too large.");
      if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > MAX_TOKENS_CAP) {
        throw httpError(400, `maxTokens must be an integer between 1 and ${MAX_TOKENS_CAP}.`);
      }
      if (!aiConfigured(c)) throw httpError(503, "AI isn't configured on this proxy (set ANTHROPIC_API_KEY or AI_PROVIDER=bedrock).");

      await validateToken(token, baseUrl, c, fetchImpl);
      const text = await (generateImpl || generate)(prompt, { maxTokens, strong: !!strong }, c, fetchImpl);
      res.json({ text: text || "" });
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error("[ai-proxy] generate failed:", err.message);
      res.status(status).json({ error: status >= 500 && !err.status ? "AI request failed." : err.message });
    }
  });

  return app;
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 8080;
  createApp().listen(port, () => console.log(`[ai-proxy] listening on :${port}`));
}

module.exports = { createApp, checkBaseUrl, validateToken, config, _validated: validated };
