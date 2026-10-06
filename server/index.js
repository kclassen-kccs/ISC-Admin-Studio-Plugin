/**
 * SailPoint ISC Proxy Server
 *
 * Solves CORS by running API calls server-side.
 * The browser never touches SailPoint directly.
 *
 * Architecture:
 *   Browser → localhost:3001 (this server) → [tenant].api.identitynow-demo.com
 *
 * Token storage: in-memory per session. In production, use Redis or a DB.
 */

require("dotenv").config();
const express = require("express");
// Routes here are async end-to-end; without this, an exception thrown inside
// an async handler is an unhandled rejection and the request hangs forever.
// This patches Express 4 to forward those to the error pipeline as 500s.
require("express-async-errors");
const cors = require("cors");
const helmet = require("helmet");
const axios = require("axios");
const rateLimit = require("express-rate-limit");
const fs = require("fs");
const path = require("path");
const storage = require("./storage");
const { createRecordStore } = storage;

// The async record-store shape over a plain Map — used for session/login
// state when running on a local backend, where a single process is a given
// and tokens deliberately never touch disk. (On AWS the same state goes to
// DynamoDB instead; see each store's declaration.)
function inMemoryRecordStore() {
  const m = new Map();
  return {
    async get(key) { return m.get(String(key)); },
    async all() { return Object.fromEntries(m); },
    async put(key, value) { m.set(String(key), value); },
    async delete(key) { m.delete(String(key)); },
  };
}

// A 429 means the request was rejected before any processing happened, so
// retrying it (even a POST/PATCH) is always safe — unlike a 5xx, which might
// reflect a request that partially succeeded server-side. Installed once on
// the shared axios instance so every outbound call in this file (SailPoint,
// Anthropic, OAuth token exchange — all of it) gets this for free instead of
// needing each of the 30+ call sites wrapped individually. Honors the
// server's own Retry-After header when given, same as the role-scan
// entitlement-fetch retry and withApiRetry below do for their own cases.
const MAX_429_RETRIES = 5;

// A request whose body is a stream (multipart form-data uploads: account
// CSV loads, schema detection, config imports) can't be replayed — the
// stream was consumed by the first attempt, so axios(config) would resend
// an empty body. Those few sites surface the 429 instead of retrying
// with garbage.
function isReplayableRequest(config) {
  return !(config?.data && typeof config.data.pipe === "function");
}

async function retry429(config, response) {
  config.__retryCount429 = (config.__retryCount429 || 0) + 1;
  if (config.__retryCount429 > MAX_429_RETRIES) return null;
  if (!isReplayableRequest(config)) {
    console.warn(`[http] 429 on ${(config.method || "GET").toUpperCase()} ${config.url} — stream body can't be replayed, not retrying`);
    return null;
  }
  const retryAfterSeconds = Number(response.headers?.["retry-after"]);
  const waitMs = retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : config.__retryCount429 * 750;
  console.warn(
    `[http] 429 rate limited on ${(config.method || "GET").toUpperCase()} ${config.url} — ` +
    `retry ${config.__retryCount429}/${MAX_429_RETRIES} in ${waitMs}ms`
  );
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  return axios(config);
}

axios.interceptors.response.use(
  // Fulfilled path: a call made with validateStatus:()=>true (the generic
  // /api/isc/* proxy — most of the app's reads) resolves successfully even
  // on 429, so throttling has to be caught here too, not just on rejection.
  async (resp) => {
    if (resp?.status === 429 && resp.config) {
      const retried = await retry429(resp.config, resp);
      if (retried) return retried;
    }
    return resp;
  },
  async (err) => {
    if (err.config && err.response?.status === 429) {
      const retried = await retry429(err.config, err.response);
      if (retried) return retried;
    }
    return Promise.reject(err);
  }
);

const app = express();
const PORT = process.env.PORT || 3001;
app.set('trust proxy', 1); 

// ─── Security ────────────────────────────────────────────────────────────────

app.use(helmet({ contentSecurityPolicy: false }));
// "capacitor://localhost" and "ionic://localhost" are the origins the iOS/Android
// Capacitor WebView sends; the bare null-ish "http://localhost" covers some Android cases.
const ALLOWED_ORIGINS = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "capacitor://localhost",
  "ionic://localhost",
  "https://adminstudio.vercel.app",
];
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    // Signal rejection via the CORS `false` origin flag (no headers granted)
    // rather than throwing — throwing here surfaces as an unhandled 500,
    // masking the real "origin not allowed" reason from the client.
    callback(null, false);
  },
  credentials: true,
  // Without this, browser JS can't read x-total-count even though the
  // server forwards it — only a small CORS-safelisted header set is
  // readable cross-origin by default.
  exposedHeaders: ["x-total-count"],
}));
// Express's default body-size limit is 100kb — fine for almost every route
// here, but POST /api/role-reports sends a whole base64-encoded PDF as
// JSON (jsPDF output, ~33% larger than the raw PDF once base64-encoded),
// which blows past that easily even for a single role's report. Verified
// live: a real one-role report 413'd outright. Raised globally rather than
// per-route, since a route-specific body-parser can't override the global
// one's limit once it's already registered first — every route here is
// already session-gated (or, for role-reports' own GET, intentionally
// public and read-only), so a higher ceiling doesn't add meaningful risk.
app.use(express.json({ limit: "20mb" }));

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  message: { error: "Too many requests, slow down." },
});
app.use(limiter);

// ─── Sessions (OAuth authorization code flow) ────────────────────────────────

/*
 * Users sign in on SailPoint's own hosted login page — this app never sees a
 * password, which is what lets SSO and MFA work. The browser is redirected to
 * /oauth/authorize, comes back to our callback with a short-lived code, and
 * the server (which alone holds the client secret) exchanges that code for
 * tokens.
 *
 * What the browser gets back is an opaque session id; the SailPoint tokens
 * stay server-side in the map below. The native app uses the same server, so
 * no secret ever ships in an app bundle.
 */
const crypto = require("crypto");

/*
 * OAuth clients are tenant-scoped in ISC — a client registered in one tenant
 * is unknown to every other one, so a single client id cannot serve a
 * multi-tenant app. Sign-in therefore needs one registered client per tenant,
 * held here as a registry.
 *
 * SP_OAUTH_CLIENTS is JSON: {"tenant-name": {"clientId": "...", "clientSecret": "..."}}
 * Use scripts/register-oauth-client.js to create a client in a new tenant.
 */
function loadOAuthClients() {
  const registry = {};

  const raw = process.env.SP_OAUTH_CLIENTS;
  if (raw) {
    try {
      for (const [tenant, entry] of Object.entries(JSON.parse(raw))) {
        if (entry?.clientId && entry?.clientSecret) {
          registry[tenant.trim().toLowerCase()] = entry;
        } else {
          console.error(`[auth] SP_OAUTH_CLIENTS entry for "${tenant}" is missing clientId/clientSecret — ignored.`);
        }
      }
    } catch (err) {
      console.error("[auth] SP_OAUTH_CLIENTS is not valid JSON — ignoring it:", err.message);
    }
  }

  // Back-compat with the original single-tenant pair. SP_OAUTH_TENANT says
  // which tenant it belongs to; without it we can't place it in the registry.
  const {
    SP_OAUTH_CLIENT_ID, SP_OAUTH_CLIENT_SECRET, SP_OAUTH_TENANT,
    SP_DEFAULT_TENANT, SP_DEFAULT_CLIENT_ID, SP_DEFAULT_CLIENT_SECRET,
  } = process.env;
  if (SP_OAUTH_CLIENT_ID && SP_OAUTH_CLIENT_SECRET) {
    const tenant = (SP_OAUTH_TENANT || SP_DEFAULT_TENANT || "").trim().toLowerCase();
    if (tenant && !registry[tenant]) {
      registry[tenant] = { clientId: SP_OAUTH_CLIENT_ID, clientSecret: SP_OAUTH_CLIENT_SECRET };
    } else if (!tenant) {
      console.error("[auth] SP_OAUTH_CLIENT_ID/SECRET are set but SP_OAUTH_TENANT is not — can't tell which tenant they belong to, so they're unused.");
    }
  }

  // The legacy PAT doubles as the service credential for its own tenant.
  const defTenant = (SP_DEFAULT_TENANT || "").trim().toLowerCase();
  if (defTenant && registry[defTenant] && SP_DEFAULT_CLIENT_ID && SP_DEFAULT_CLIENT_SECRET) {
    registry[defTenant].adminClientId ||= SP_DEFAULT_CLIENT_ID;
    registry[defTenant].adminClientSecret ||= SP_DEFAULT_CLIENT_SECRET;
  }

  console.log(`[auth] OAuth client registry loaded for ${Object.keys(registry).length} tenant(s): ${Object.keys(registry).join(", ") || "(none)"}`);
  return registry;
}

// Clients registered at runtime through the app's "set up a tenant" flow are
// persisted here so they survive a restart. Note this is container-local
// storage: a redeploy starts from a clean filesystem, so anything registered
// this way should also be added to SP_OAUTH_CLIENTS to be permanent.
// Everything persistent lives here: tenant sign-in clients and scan history.
// On a container host the default path is ephemeral — set DATA_DIR to a
// mounted volume so registrations and scans survive a redeploy.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
console.log(`[startup] DATA_DIR = ${DATA_DIR}`);

// The name of the OAuth client this server registers/looks up in each
// tenant. Registration deletes-and-recreates any existing client with this
// name, so two servers pointed at the same tenant with the same name fight
// over one client — e.g. a local dev server clobbering production's. Give
// each deployment its own name (SP_SIGNIN_CLIENT_NAME) to run independently.
const SIGNIN_CLIENT_NAME = process.env.SP_SIGNIN_CLIENT_NAME || "identity-app-user-login";
console.log(`[startup] SIGNIN_CLIENT_NAME = ${SIGNIN_CLIENT_NAME}`);

const OAUTH_CLIENTS_FILE = path.join(DATA_DIR, "oauth-clients.json");

/*
 * The client registry holds OAuth client secrets and tenant PATs, so it is
 * encrypted at rest with AES-256-GCM. The key lives in the environment
 * (DATA_ENCRYPTION_KEY), deliberately not on the volume beside the data —
 * whoever gets the disk alone gets ciphertext.
 *
 * GCM also authenticates: tampering with the file makes decryption fail
 * loudly rather than silently yielding altered credentials.
 */
function encryptionKey() {
  const raw = process.env.DATA_ENCRYPTION_KEY;
  if (!raw) return null;
  const key = Buffer.from(raw, /^[0-9a-fA-F]{64}$/.test(raw) ? "hex" : "base64");
  if (key.length !== 32) {
    console.error("[startup] DATA_ENCRYPTION_KEY must be 32 bytes (64 hex chars or base64) — storing credentials in plaintext.");
    return null;
  }
  return key;
}

function encryptJson(obj) {
  const key = encryptionKey();
  if (!key) return JSON.stringify(obj, null, 2);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(obj), "utf8"), cipher.final()]);
  return JSON.stringify({
    alg: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: body.toString("base64"),
  });
}

function decryptJson(raw) {
  const parsed = JSON.parse(raw);
  // Files written before encryption existed are plaintext; read them so they
  // can be migrated on the next write rather than losing every tenant.
  if (parsed?.alg !== "aes-256-gcm") return { value: parsed, encrypted: false };

  const key = encryptionKey();
  if (!key) {
    throw new Error("stored credentials are encrypted but DATA_ENCRYPTION_KEY is not set");
  }
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(parsed.iv, "base64"));
  decipher.setAuthTag(Buffer.from(parsed.tag, "base64"));
  const out = Buffer.concat([decipher.update(Buffer.from(parsed.data, "base64")), decipher.final()]);
  return { value: JSON.parse(out.toString("utf8")), encrypted: true };
}

// Set when the file on disk was read as plaintext, so startup can migrate it.
let persistedWasPlaintext = false;

// The env-supplied part of the registry never changes at runtime — load once.
const envOAuthClients = loadOAuthClients();

// On AWS the persisted half of the registry is one S3 object (encrypted at
// the app layer before upload, same format as the local file). Locally it
// stays the DATA_DIR file. Read fresh on every lookup — no cache — so a
// registration made by one instance is immediately visible to every other.
const registryObject = storage.isAws()
  ? storage.createS3ObjectStore(storage.AWS_BUCKET, "oauth-clients.json")
  : null;

async function readPersistedClientsRaw() {
  if (registryObject) return registryObject.readRaw();
  try {
    return fs.readFileSync(OAUTH_CLIENTS_FILE, "utf8");
  } catch {
    return null;
  }
}

async function writePersistedClients(obj) {
  const content = encryptJson(obj);
  if (registryObject) {
    await registryObject.writeRaw(content);
  } else {
    fs.mkdirSync(path.dirname(OAUTH_CLIENTS_FILE), { recursive: true });
    fs.writeFileSync(OAUTH_CLIENTS_FILE, content, { mode: 0o600 });
  }
}

async function loadPersistedClientsAsync() {
  const raw = await readPersistedClientsRaw();
  if (raw == null) return {};
  try {
    const { value, encrypted } = decryptJson(raw);
    persistedWasPlaintext = !encrypted;
    return value;
  } catch (err) {
    console.error(`[startup] could not read stored credentials: ${err.message}`);
    return {};
  }
}

// Runtime registrations take precedence over SP_OAUTH_CLIENTS: re-running
// setup for a tenant deletes its old client in SailPoint, so a stale env
// entry would point at a client that no longer exists.
//
// Merge per field, not per tenant: a persisted entry written before service
// credentials existed has no adminClientId, and replacing the whole entry
// would discard one supplied via the environment.
//
// Read live on every call — deliberately uncached, so a second server
// instance sees registrations/removals made by the first. The registry is
// tiny and these lookups only sit on auth paths, not the request hot path.
async function mergedOAuthClients() {
  const merged = {};
  for (const [tenant, entry] of Object.entries(envOAuthClients)) {
    merged[tenant] = { ...entry };
  }
  for (const [tenant, entry] of Object.entries(await loadPersistedClientsAsync())) {
    merged[tenant] = { ...merged[tenant], ...entry };
  }
  return merged;
}

async function persistClient(tenant, entry) {
  const onDisk = { ...(await loadPersistedClientsAsync()), [tenant]: entry };
  await writePersistedClients(onDisk);
}

// Removes a tenant's registration from the persisted store. An entry that
// also exists in SP_OAUTH_CLIENTS (env) will re-merge on the next lookup —
// env config can only be removed by changing the environment.
async function removeClient(tenant) {
  const onDisk = await loadPersistedClientsAsync();
  delete onDisk[tenant];
  await writePersistedClients(onDisk);
}

/** The registered OAuth client for a tenant, or null if it has none. */
async function clientFor(tenant) {
  const merged = await mergedOAuthClients();
  return merged[String(tenant || "").trim().toLowerCase()] || null;
}

/** Whether a tenant has a stored service credential we can fall back to. */
async function hasServiceCredential(tenant) {
  const c = await clientFor(tenant);
  return !!(c?.adminClientId && c?.adminClientSecret);
}

// Startup housekeeping: log the registry once, and (local backend only)
// migrate a plaintext file to encrypted straight away — waiting for the next
// registration would leave secrets readable on the volume indefinitely.
async function initCredentialStore() {
  const merged = await mergedOAuthClients();
  for (const [tenant, entry] of Object.entries(merged)) {
    console.log(`[auth] tenant ${tenant}: sign-in client ${entry.clientId ? "yes" : "NO"}, service credential ${entry.adminClientId ? "yes" : "no"}`);
  }
  const key = encryptionKey();
  if (!key) {
    console.warn("[startup] DATA_ENCRYPTION_KEY is not set — stored credentials are NOT encrypted.");
    return;
  }
  if (persistedWasPlaintext) {
    try {
      await writePersistedClients(await loadPersistedClientsAsync());
      console.log("[startup] stored credentials: migrated from plaintext to encrypted");
    } catch (err) {
      console.error("[startup] failed to encrypt stored credentials:", err.message);
    }
  } else {
    console.log("[startup] stored credentials: encrypted (or nothing stored yet)");
  }
}

/*
 * ISC only honours admin authorities on a strongly authenticated token. A
 * browser sign-in without MFA yields strong_auth=false, and every admin call
 * is refused — so when that happens we fall back to the tenant's stored
 * service credential (the PAT supplied at setup), whose client_credentials
 * token does carry strong_auth.
 *
 * This is deliberately a fallback, not the default: as soon as MFA is
 * configured and sessions come back strongly authenticated, calls go back to
 * running as the signed-in user with their own permissions.
 */
// tenant -> { token, expiresAt }. In-memory locally; DynamoDB (encrypted,
// TTL'd) on AWS so instances share instead of each minting their own.
const serviceTokensStore = storage.isAws()
  ? createRecordStore(DATA_DIR, "service-tokens.json", { encrypt: true })
  : inMemoryRecordStore();

async function serviceToken(tenant) {
  const key = String(tenant || "").trim().toLowerCase();
  const cached = await serviceTokensStore.get(key);
  if (cached && Date.now() < cached.expiresAt - 60_000) return cached.token;

  const client = await clientFor(key);
  if (!client?.adminClientId || !client?.adminClientSecret) return null;

  try {
    const data = (await axios.post(
      oauthTokenUrl(key),
      new URLSearchParams({
        grant_type: "client_credentials",
        client_id: client.adminClientId,
        client_secret: client.adminClientSecret,
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    )).data;
    const expiresAt = Date.now() + (data.expires_in || 3600) * 1000;
    await serviceTokensStore.put(key, { token: data.access_token, expiresAt }, { ttlEpochMs: expiresAt });
    return data.access_token;
  } catch (err) {
    console.error(`[auth] service credential for ${key} failed:`, err.response?.status, err.response?.data?.error || err.message);
    return null;
  }
}

/*
 * sessionId -> { id, tenant, username, accessToken, refreshToken, expiresAt,
 * identity, ... }. Locally an in-memory Map (single process, tokens never
 * touch disk). On AWS: DynamoDB, encrypted at the app layer with
 * DATA_ENCRYPTION_KEY before writing — a session carries live SailPoint
 * access/refresh tokens, so DynamoDB's own at-rest encryption alone isn't
 * treated as enough. Items carry a TTL just past the refresh token's own
 * 24h lifetime so dead sessions clean themselves up.
 */
const sessionsStore = storage.isAws()
  ? createRecordStore(DATA_DIR, "sessions.json", { encrypt: true })
  : inMemoryRecordStore();
const SESSION_TTL_MS = 25 * 3600 * 1000;

async function putSession(session) {
  await sessionsStore.put(session.id, session, { ttlEpochMs: Date.now() + SESSION_TTL_MS });
}

// In-flight token refreshes, deduped per session PER PROCESS. Cross-instance
// dedup isn't needed for correctness (a lost race just wastes one refresh
// grant), and a Promise can't be serialized anyway — which is exactly why
// this lives beside the session store instead of inside the session record.
const refreshPromises = new Map(); // sessionId -> Promise<accessToken>

function oauthTokenUrl(tenant) {
  return `https://${tenantApiHost(tenant)}/oauth/token`;
}

async function requestGrant(tenant, params) {
  const client = await clientFor(tenant);
  if (!client) {
    const err = new Error(`No OAuth client is registered for tenant "${tenant}".`);
    err.noClient = true;
    throw err;
  }
  const resp = await axios.post(
    oauthTokenUrl(tenant),
    new URLSearchParams({
      ...params,
      client_id: client.clientId,
      client_secret: client.clientSecret,
    }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );
  return resp.data;
}

async function getSession(req) {
  const id = req.headers["x-sp-session"];
  if (!id) return null;
  return (await sessionsStore.get(id)) || null;
}

// ─── Local admin ─────────────────────────────────────────────────────────────
// A break-glass account defined entirely by two env vars, with exactly one
// capability: removing entries from the stored OAuth client registry (e.g. a
// registration whose client was deleted in SailPoint, or whose secret was
// lost). It signs in with a username/password held only in the server's
// environment, and its session cannot reach any tenant data or SailPoint API.
const LOCAL_ADMIN_USERNAME = process.env.LOCAL_ADMIN_USERNAME || "";
const LOCAL_ADMIN_PASSWORD = process.env.LOCAL_ADMIN_PASSWORD || "";

function localAdminEnabled() {
  return !!(LOCAL_ADMIN_USERNAME && LOCAL_ADMIN_PASSWORD);
}

// A tenant is registered in one of two forms:
//  - a SHORT NAME ("acme")            -> https://acme.api.identitynow-demo.com
//  - a FULL HOST  (contains a ".")    -> used exactly as typed, only https://
//    ("acme.api.identitynow.com")        is added; no domain is appended.
//
// Either way the string becomes the host this server connects to — and
// register-client sends it a client id and secret — so it is validated
// strictly. A short name must be one DNS label: a "/", "@", ":" or "#" would
// otherwise redirect the outbound request to an attacker-chosen host. A full
// host must be a plain lowercase DNS name (no scheme, port, path, userinfo or
// IP literal) AND end in an allowed domain: register-client can be called
// anonymously on an Internet-facing deployment, and without the domain
// allowlist a full host would let anyone point this server at any machine it
// can reach, internal ones included. TENANT_HOST_SUFFIXES (comma-separated)
// replaces the default list for a deployment that needs another domain.
const TENANT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const TENANT_HOST_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
const DEFAULT_TENANT_DOMAIN = "identitynow-demo.com";
const TENANT_HOST_SUFFIXES = (process.env.TENANT_HOST_SUFFIXES || "identitynow.com,identitynow-demo.com")
  .split(",").map((d) => d.trim().toLowerCase().replace(/^\.+/, "")).filter(Boolean);

const isFullHostTenant = (tenant) => String(tenant).includes(".");
function isAllowedTenantHost(host) {
  return TENANT_HOST_RE.test(host) && TENANT_HOST_SUFFIXES.some((d) => host.endsWith(`.${d}`));
}
function isValidTenantName(tenant) {
  if (typeof tenant !== "string") return false;
  return isFullHostTenant(tenant) ? isAllowedTenantHost(tenant) : TENANT_NAME_RE.test(tenant);
}
const INVALID_TENANT_MESSAGE =
  `Enter a tenant name (lowercase letters, digits and hyphens), or the tenant's full API host ending in ` +
  `${TENANT_HOST_SUFFIXES.map((d) => `.${d}`).join(" or ")} — for example acme.api.identitynow.com.`;

/**
 * What someone typed or pasted -> the tenant key. Lowercased; a pasted
 * "https://", path, port or trailing dot is dropped. A host on the DEFAULT
 * domain collapses to its short name ("acme.identitynow-demo.com" and
 * "acme.api.identitynow-demo.com" -> "acme") so existing registrations and
 * old habits keep resolving to the same tenant. Anything else with a "." is
 * kept whole. Validate the result with isValidTenantName.
 */
function normalizeTenantInput(raw) {
  let t = String(raw || "").trim().toLowerCase();
  t = t.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/[/?#].*$/, "").replace(/:\d+$/, "").replace(/\.+$/, "");
  const m = t.match(/^([a-z0-9][a-z0-9-]{0,62})(?:\.api)?\.identitynow-demo\.com$/);
  return m ? m[1] : t;
}

/** The host API calls go to. A full-host tenant IS that host, exactly as registered. */
function tenantApiHost(tenant) {
  return isFullHostTenant(tenant) ? tenant : `${tenant}.api.${DEFAULT_TENANT_DOMAIN}`;
}
/** The host of the tenant's web UI (sign-in page, "Manage in ISC" links): the API host without its ".api" label. */
function tenantUiHost(tenant) {
  return isFullHostTenant(tenant) ? tenant.replace(/\.api\./, ".") : `${tenant}.${DEFAULT_TENANT_DOMAIN}`;
}

// Constant-time comparison — a plain === leaks where the first mismatching
// character is via response timing. Length differences still short-circuit,
// so compare against self first to keep the timing profile flat.
function timingSafeEquals(a, b) {
  const bufA = Buffer.from(String(a ?? ""));
  const bufB = Buffer.from(String(b ?? ""));
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufB, bufB);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

// Failed-attempt lockout for local admin. Keyed per submitted username and
// held in the shared record store, so the counter is one global counter —
// not per-IP (trivially rotated) and not per-instance (reset by scaling).
const localLoginAttempts = storage.isAws()
  ? createRecordStore(DATA_DIR, "local-login-attempts.json")
  : inMemoryRecordStore();
const LOCAL_LOGIN_MAX_FAILURES = 5;
const LOCAL_LOGIN_LOCKOUT_MS = 15 * 60 * 1000;

app.post("/api/auth/local-login", async (req, res) => {
  if (!localAdminEnabled()) {
    return res.status(404).json({ error: "Local admin sign-in is not enabled on this server." });
  }
  const { username, password } = req.body || {};

  const attemptKey = String(username ?? "").slice(0, 64) || "(empty)";
  const attempts = (await localLoginAttempts.get(attemptKey)) || { failures: 0, lockedUntil: 0 };
  if (attempts.lockedUntil > Date.now()) {
    console.warn("[auth] local admin sign-in refused — locked out");
    return res.status(429).json({
      error: "Too many failed attempts. Try again later.",
    });
  }

  const userOk = timingSafeEquals(username, LOCAL_ADMIN_USERNAME);
  const passOk = timingSafeEquals(password, LOCAL_ADMIN_PASSWORD);
  if (!userOk || !passOk) {
    const failures = attempts.failures + 1;
    const lockedUntil = failures >= LOCAL_LOGIN_MAX_FAILURES ? Date.now() + LOCAL_LOGIN_LOCKOUT_MS : 0;
    await localLoginAttempts.put(
      attemptKey,
      { failures: lockedUntil ? 0 : failures, lockedUntil },
      { ttlEpochMs: Date.now() + 24 * 3600 * 1000 }
    );
    console.warn(`[auth] local admin sign-in failed (${failures}/${LOCAL_LOGIN_MAX_FAILURES}${lockedUntil ? " — locked out" : ""})`);
    return res.status(401).json({ error: "Invalid username or password." });
  }
  await localLoginAttempts.delete(attemptKey);
  const sessionId = crypto.randomUUID();
  const identity = { username: LOCAL_ADMIN_USERNAME, displayName: "Local Admin" };
  await putSession({ id: sessionId, localAdmin: true, tenant: null, username: LOCAL_ADMIN_USERNAME, identity });
  console.log("[auth] local admin signed in");
  res.json({ ok: true, sessionId, localAdmin: true, identity });
});

// The allowlist IS the local admin's entire capability surface — session
// validation, sign-out, and the OAuth client registry endpoints below.
// Everything else on /api is refused before its handler ever runs. Regular
// SailPoint sessions pass straight through.
const LOCAL_ADMIN_ALLOWED_PATHS = new Set([
  "/api/auth/session",
  "/api/auth/logout",
  // Tenant registration moved behind local admin (see register-client) —
  // it manages the same registry the /api/admin routes do.
  "/api/auth/register-client",
]);
app.use(async (req, res, next) => {
  const session = await getSession(req);
  if (!session?.localAdmin) return next();
  if (
    LOCAL_ADMIN_ALLOWED_PATHS.has(req.path) ||
    req.path.startsWith("/api/admin/oauth-clients") ||
    // Read-only view of who has signed into each tenant — same registry
    // screen, so part of the local admin's capability surface.
    req.path.startsWith("/api/admin/tenant-logins/")
  ) {
    return next();
  }
  res.status(403).json({ error: "The local admin account can only manage OAuth clients." });
});

async function requireLocalAdmin(req, res) {
  const session = await getSession(req);
  if (!session?.localAdmin) {
    res.status(403).json({ error: "Local admin sign-in required." });
    return null;
  }
  return session;
}

/**
 * GET /api/admin/oauth-clients — the stored registry, identifiers only.
 * Deliberately returns no secrets of any kind: not the sign-in client
 * secret, not the service credential. clientId alone appears in every
 * authorize URL, so it identifies without revealing.
 */
app.get("/api/admin/oauth-clients", async (req, res) => {
  if (!(await requireLocalAdmin(req, res))) return;
  const clients = Object.entries(await mergedOAuthClients())
    .map(([tenant, entry]) => ({
      tenant,
      siteName: entry.siteName || tenant,
      clientId: entry.clientId || null,
      hasServiceCredential: !!(entry.adminClientId && entry.adminClientSecret),
    }))
    .sort((a, b) => a.siteName.localeCompare(b.siteName));
  res.json({ clients });
});

/**
 * DELETE /api/admin/oauth-clients/:tenant — un-register a tenant from this
 * server. Removes only the stored entry; the OAuth client inside SailPoint
 * itself is untouched (deleting that needs a tenant admin credential this
 * account deliberately doesn't have).
 */
app.delete("/api/admin/oauth-clients/:tenant", async (req, res) => {
  if (!(await requireLocalAdmin(req, res))) return;
  const tenant = String(req.params.tenant || "").trim().toLowerCase();
  if (!(await mergedOAuthClients())[tenant]) {
    return res.status(404).json({ error: `No OAuth client is registered for "${tenant}".` });
  }
  await removeClient(tenant);
  // The login history is only meaningful while the tenant is registered —
  // drop it with the registration so a later re-register starts clean.
  await tenantLogins.delete(tenant);
  console.log(`[admin] local admin removed the OAuth client registration for ${tenant}`);
  res.json({ ok: true });
});

// ─── Tenant login history ────────────────────────────────────────────────────
// One record per tenant: { [username]: { count, displayName, firstLoginAt,
// lastLoginAt } }. Written on every completed sign-in (the OAuth callback —
// web and native both land there), read only by the local-admin screen.
// Local admin's own sign-ins are not tenant logins and never recorded.
const tenantLogins = createRecordStore(DATA_DIR, "tenant-logins.json");

async function recordTenantLogin(tenant, identity) {
  const username = identity?.username || identity?.id;
  if (!username) return; // nothing stable to key the count on
  const forTenant = (await tenantLogins.get(tenant)) || {};
  const previous = forTenant[username] || { count: 0, firstLoginAt: new Date().toISOString() };
  forTenant[username] = {
    ...previous,
    count: previous.count + 1,
    // Kept current rather than first-seen, so a rename in ISC shows up here.
    displayName: identity?.displayName || previous.displayName || username,
    lastLoginAt: new Date().toISOString(),
  };
  await tenantLogins.put(tenant, forTenant);
}

/**
 * GET /api/admin/tenant-logins/:tenant — every user who has signed into the
 * tenant through this server, with how many times and when last. Local admin
 * only, same gate as the registry above.
 */
app.get("/api/admin/tenant-logins/:tenant", async (req, res) => {
  if (!(await requireLocalAdmin(req, res))) return;
  const tenant = String(req.params.tenant || "").trim().toLowerCase();
  const forTenant = (await tenantLogins.get(tenant)) || {};
  const users = Object.entries(forTenant)
    .map(([username, entry]) => ({
      username,
      displayName: entry.displayName || username,
      count: entry.count || 0,
      firstLoginAt: entry.firstLoginAt || null,
      lastLoginAt: entry.lastLoginAt || null,
    }))
    .sort((a, b) => b.count - a.count || a.username.localeCompare(b.username));
  res.json({ tenant, users });
});

/**
 * Returns a usable access token for the session, refreshing it first if it's
 * within a minute of expiry. Throws if the session can no longer be renewed
 * (no refresh token, or the refresh itself was rejected) — callers surface
 * that as a 401 so the client can bounce the user back to the login screen.
 */
async function sessionToken(session) {
  // A local admin session has no SailPoint identity behind it at all — it
  // must never be able to mint a tenant token. The route gate already blocks
  // these requests; this is the backstop if a future route forgets.
  if (session.localAdmin) {
    const err = new Error("The local admin account cannot access SailPoint APIs.");
    err.sessionExpired = true;
    throw err;
  }
  // Without strong auth the user's own token can't reach admin APIs at all,
  // so prefer the tenant's service credential when one is available.
  if (session.strongAuth !== true) {
    const svc = await serviceToken(session.tenant);
    if (svc) return svc;
  }

  if (Date.now() < session.expiresAt - 60_000) return session.accessToken;

  if (!session.refreshToken) {
    const err = new Error("Session expired. Please sign in again.");
    err.sessionExpired = true;
    throw err;
  }

  // Concurrent callers landing on this exact moment (token just past
  // expiry) — e.g. Role Evaluation's bounded-concurrency batch scan, where
  // several roles' evaluations can each call this within the same tick —
  // used to each fire their own refresh_token grant. Refresh tokens
  // typically rotate (single-use), so a second concurrent refresh using
  // the now-stale token would fail with invalid_grant, needlessly failing
  // whatever that caller was doing even though the FIRST refresh actually
  // succeeded. Concurrent callers share one in-flight refresh — deduped in
  // the process-local refreshPromises map (a Promise can't live inside the
  // session record; see its declaration), and the refreshed tokens are
  // written back to the session store so other instances see them.
  if (!refreshPromises.has(session.id)) {
    refreshPromises.set(session.id, (async () => {
      try {
        const data = await requestGrant(session.tenant, {
          grant_type: "refresh_token",
          refresh_token: session.refreshToken,
        });
        session.accessToken = data.access_token;
        if (data.refresh_token) session.refreshToken = data.refresh_token;
        session.expiresAt = Date.now() + (data.expires_in || 3600) * 1000;
        await putSession(session);
        return session.accessToken;
      } catch (err) {
        const wrapped = new Error("Session expired. Please sign in again.");
        wrapped.sessionExpired = true;
        throw wrapped;
      } finally {
        refreshPromises.delete(session.id);
      }
    })());
  }
  return refreshPromises.get(session.id);
}

/*
 * Pulls a human-readable reason out of an error, whichever upstream produced
 * it. Anthropic, SailPoint and OAuth all nest the useful message differently,
 * and falling through to err.message yields "Request failed with status code
 * 400", which tells the user nothing about what to fix.
 */
function describeError(err) {
  const d = err.response?.data;
  return (
    d?.error?.message ||        // Anthropic
    d?.error_description ||     // OAuth
    d?.messages?.[0]?.text ||   // SailPoint (most endpoints)
    d?.detailMessage ||         // SailPoint (some, e.g. JSONPatch validation errors)
    d?.detailCode ||
    (typeof d?.error === "string" ? d.error : null) ||
    err.message
  );
}

/**
 * Standard 401 body for a missing/expired LOCAL session — sessionExpired:true
 * is what the client's axios interceptor keys off of to bounce back to the
 * login screen. A 401 an upstream ISC call itself returns (insufficient
 * scope for one specific beta/experimental endpoint, say) is forwarded with
 * plain describeError() and no such flag — see the sessionExpired ?
 * pattern below. Verified live: a tenant's own /beta/common-access call
 * 401ing (a scope issue unrelated to the app's own session) used to force
 * a full logout on every visit to Roles, even though the local session and
 * every other endpoint were completely fine.
 */
function unauthorized(res, message) {
  return res.status(401).json({ error: message || "Not signed in, or your session has expired.", sessionExpired: true });
}

// ─── Auth endpoint ────────────────────────────────────────────────────────────

// Decodes the JWT payload without verifying the signature — fine here since
// we only read claims out of a token we just received directly from SailPoint's
// own /oauth/token endpoint over TLS.
function decodeJwtPayload(token) {
  try {
    const payload = token.split(".")[1];
    return JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
  } catch {
    return {};
  }
}

/** Resolves the signed-in user's identity record for display. */
async function buildIdentity(tenant, token) {
  const claims = decodeJwtPayload(token);
  const identity = {
    id: claims.identity_id || null,
    username: claims.user_name || null,
  };
  if (identity.id) {
    try {
      const [record] = await iscGet(tenant, token, "/v2026/public-identities", {
        filters: `id eq "${identity.id}"`,
        limit: 1,
      });
      if (record?.name) identity.displayName = record.name;
    } catch {
      // Display name is a nice-to-have — fall back to the username claim.
    }
  }
  return identity;
}

// Short-lived CSRF state for in-flight logins: state -> { tenant, redirectUri, createdAt }.
// A login that never completes just ages out.
const pendingLoginsStore = storage.isAws()
  ? createRecordStore(DATA_DIR, "pending-logins.json")
  : inMemoryRecordStore();
const LOGIN_STATE_TTL_MS = 10 * 60 * 1000;

/*
 * Completed native logins, waiting to be collected: state -> { sessionId }.
 *
 * iOS sandboxes SFSafariViewController — it will not open a custom URL
 * scheme, so the browser sheet cannot hand the session back to the app. The
 * app instead polls with the state it started the login with, and collects
 * the session here. Entries are single-use and expire with the same TTL.
 */
const completedNativeLoginsStore = storage.isAws()
  ? createRecordStore(DATA_DIR, "completed-native-logins.json")
  : inMemoryRecordStore();

// Freshness is ALWAYS checked at read time (stateIsFresh below) — DynamoDB's
// TTL deletion is best-effort background cleanup, never the expiry check.
function stateIsFresh(entry) {
  return !!entry && entry.createdAt >= Date.now() - LOGIN_STATE_TTL_MS;
}

async function reapPendingLogins() {
  if (storage.isAws()) return; // DynamoDB item TTL does this in the background
  const cutoff = Date.now() - LOGIN_STATE_TTL_MS;
  for (const [state, entry] of Object.entries(await pendingLoginsStore.all())) {
    if (entry.createdAt < cutoff) await pendingLoginsStore.delete(state);
  }
  for (const [state, entry] of Object.entries(await completedNativeLoginsStore.all())) {
    if (entry.createdAt < cutoff) await completedNativeLoginsStore.delete(state);
  }
}

/**
 * POST /api/auth/authorize-url
 * Body: { tenant, redirectUri }
 * Returns: { url } — where the browser should be sent to sign in.
 */
/**
 * GET /api/auth/tenants — which tenants are set up for sign-in.
 * Tenant name + its display Site Name only; never the client ids or secrets.
 * A tenant registered before Site Name existed has none stored, so it
 * falls back to the tenant name itself.
 */
// ─── Parameter Storage (Browse > Parameters) ────────────────────────────────
// Reads, references and deletes go through the generic /api/isc proxy; these
// routes cover what the proxy can't do safely:
//   - the type specifications, requested in English (ISC otherwise answers
//     in an arbitrary language — verified live: Polish, then Portuguese);
//   - create / update, whose private fields (passwords, client secrets,
//     header values) must be encrypted end to end to SailPoint's enclave
//     before they leave this server (see parameterCrypto.js).
// Private field values are never logged or echoed back.
const { encryptPrivateFields } = require("./parameterCrypto");

app.get("/api/parameters/specifications", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  try {
    const token = await sessionToken(session);
    res.json(await iscGet(session.tenant, token, "/v2026/parameter-storage/specifications", undefined, { "Accept-Language": "en" }));
  } catch (err) {
    if (err.sessionExpired) return res.status(401).json({ error: describeError(err), sessionExpired: true });
    res.status(err.response?.status || 500).json({ error: describeError(err) });
  }
});

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
const parameterStorageHeaders = (token) => ({
  Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json", "X-SailPoint-Experimental": "true",
});

function encryptForTenant(tenant, token, privateFields) {
  return encryptPrivateFields(privateFields, async (keyParam) => {
    const doc = await iscGet(tenant, token, `${PARAMETER_STORAGE_ROOT}/attestation`, { key: keyParam }, { "X-SailPoint-Experimental": "true" });
    if (!doc?.attestationDocument) throw new Error("ISC returned no attestation document");
    return doc.attestationDocument;
  });
}

// Encrypt + send, retrying once with a FRESH attestation on a 5xx — the HAR
// shows the UI's first secret PATCH getting a 502 and the retry (new
// handshake) succeeding. `send(jwe)` performs the request.
async function sendSecret(tenant, token, secrets, send) {
  for (let attempt = 1; ; attempt++) {
    const jwe = await encryptForTenant(tenant, token, secrets);
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

app.post("/api/parameters", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { type, name, description, ownerId, publicFields, privateFields } = req.body || {};
  if (!type || !String(name || "").trim()) return res.status(400).json({ error: "A parameter needs a type and a name." });
  try {
    const token = await sessionToken(session);
    const tenant = session.tenant;
    const secrets = nonEmptyPrivateFields(privateFields);
    const body = {
      type: String(type),
      name: String(name).trim(),
      ownerId: ownerId || session.identity?.id,
      ...(description ? { description: String(description) } : {}),
      publicFields: publicFields && typeof publicFields === "object" ? publicFields : {},
    };
    const post = (b) => axios.post(`https://${tenantApiHost(tenant)}${PARAMETER_STORAGE_ROOT}/parameters`, b, { headers: parameterStorageHeaders(token) });
    let resp;
    let secretNotSaved = null;
    if (secrets) {
      try {
        resp = await sendSecret(tenant, token, secrets, (jwe) => post({ ...body, privateFields: jwe }));
      } catch (err) {
        if (err.response?.status !== 400) throw err;
        console.warn("[parameters] create: secret refused —", err.response?.status, JSON.stringify(err.response?.data), "— creating without it");
        secretNotSaved = secretNotSavedInfo(secrets, err);
        resp = await post(body);
      }
    } else {
      resp = await post(body);
    }
    console.log(`[parameters] created "${body.name}" (type ${body.type}${secrets && !secretNotSaved ? `, private fields: ${Object.keys(secrets).join(", ")}` : ""})`);
    res.status(201).json({ ...resp.data, ...(secretNotSaved ? { _secretNotSaved: secretNotSaved } : {}) });
  } catch (err) {
    if (err.sessionExpired) return res.status(401).json({ error: describeError(err), sessionExpired: true });
    console.warn("[parameters] create failed:", err.response?.status, JSON.stringify(err.response?.data || err.message));
    res.status(err.response?.status || 500).json({ error: describeError(err) });
  }
});

app.patch("/api/parameters/:id", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { name, description, ownerId, publicFields, privateFields } = req.body || {};
  try {
    const token = await sessionToken(session);
    const tenant = session.tenant;
    const secrets = nonEmptyPrivateFields(privateFields);
    const url = `https://${tenantApiHost(tenant)}${PARAMETER_STORAGE_ROOT}/parameters/${encodeURIComponent(req.params.id)}`;
    const patch = (b) => axios.patch(url, b, { headers: parameterStorageHeaders(token) });
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
        resp = await sendSecret(tenant, token, secrets, (jwe) => patch({ privateFields: jwe }));
      } catch (err) {
        if (err.response?.status !== 400) throw err;
        console.warn("[parameters] update: secret refused —", err.response?.status, JSON.stringify(err.response?.data));
        secretNotSaved = secretNotSavedInfo(secrets, err);
      }
    }
    console.log(`[parameters] updated ${req.params.id}${secrets && !secretNotSaved ? ` (private fields: ${Object.keys(secrets).join(", ")})` : ""}`);
    res.json({ ...(resp?.data || {}), ...(secretNotSaved ? { _secretNotSaved: secretNotSaved } : {}) });
  } catch (err) {
    if (err.sessionExpired) return res.status(401).json({ error: describeError(err), sessionExpired: true });
    console.warn("[parameters] update failed:", err.response?.status, JSON.stringify(err.response?.data || err.message));
    res.status(err.response?.status || 500).json({ error: describeError(err) });
  }
});

// ─── Parameters: OAuth client-credentials test ──────────────────────────────
// Tries the credentials a user is about to save: a real client_credentials
// token request, made from this server. Only the outcome comes back — never
// the token. The token URL is user-supplied, so the request is fenced:
// https only, no redirects, a short timeout, and an agent whose DNS lookup
// refuses private / loopback / link-local / metadata addresses AT CONNECT
// TIME (so a hostname can't resolve publicly for a check and privately for
// the request).
const dnsLookup = require("dns").lookup;
const httpsModule = require("https");

function isBlockedAddress(addr, family) {
  if (family === 6 || addr.includes(":")) {
    const a = addr.toLowerCase();
    if (a === "::1" || a === "::") return true;
    if (a.startsWith("fc") || a.startsWith("fd") || a.startsWith("fe8") || a.startsWith("fe9") || a.startsWith("fea") || a.startsWith("feb")) return true;
    const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mapped ? isBlockedAddress(mapped[1], 4) : false;
  }
  const [o1, o2] = addr.split(".").map(Number);
  return (
    o1 === 0 || o1 === 10 || o1 === 127 ||
    (o1 === 169 && o2 === 254) ||
    (o1 === 172 && o2 >= 16 && o2 <= 31) ||
    (o1 === 192 && o2 === 168) ||
    (o1 === 100 && o2 >= 64 && o2 <= 127) ||
    o1 >= 224
  );
}

const guardedHttpsAgent = new httpsModule.Agent({
  lookup(hostname, options, callback) {
    dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err);
      const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: options.family }];
      const blocked = list.find((a) => isBlockedAddress(a.address, a.family));
      if (blocked) return callback(new Error(`${hostname} resolves to a private or internal address — not allowed for a credential test`));
      if (options.all) return callback(null, list);
      return callback(null, list[0].address, list[0].family);
    });
  },
});

app.post("/api/parameters/test-oauth", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { kind, tokenURL, tenantId, clientId, clientSecret, credentialLocation, scope } = req.body || {};
  if (!clientId || !clientSecret) return res.status(400).json({ error: "A client ID and client secret are required to test." });

  let url;
  let effectiveScope = scope ? String(scope).trim() : "";
  if (kind === "entra") {
    if (!/^[A-Za-z0-9.-]+$/.test(String(tenantId || ""))) return res.status(400).json({ error: "Enter the Entra tenant ID (or domain) to test against." });
    url = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
    if (!effectiveScope) effectiveScope = "https://graph.microsoft.com/.default";
  } else {
    try { url = new URL(String(tokenURL || "")).toString(); } catch { return res.status(400).json({ error: "The token URL isn't a valid URL." }); }
  }
  if (!url.startsWith("https://")) return res.status(400).json({ error: "The token URL must use https." });
  // An IP-literal host never goes through the agent's DNS lookup (Node
  // skips lookup for literals — verified: 169.254.169.254 slipped past it),
  // so literals are checked here directly.
  const urlHost = new URL(url).hostname.replace(/^\[|\]$/g, "");
  const ipFamily = require("net").isIP(urlHost);
  if (ipFamily && isBlockedAddress(urlHost, ipFamily)) {
    return res.status(400).json({ error: `${urlHost} is a private or internal address — not allowed for a credential test.` });
  }

  const form = new URLSearchParams({ grant_type: "client_credentials" });
  if (effectiveScope) form.set("scope", effectiveScope);
  const headers = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };
  if (credentialLocation === "BODY" || kind === "entra") {
    form.set("client_id", clientId);
    form.set("client_secret", clientSecret);
  } else {
    // RFC 6749 §2.3.1: both parts form-urlencoded before Basic encoding.
    const enc = (v) => encodeURIComponent(v).replace(/%20/g, "+");
    headers.Authorization = `Basic ${Buffer.from(`${enc(clientId)}:${enc(clientSecret)}`).toString("base64")}`;
  }

  const started = Date.now();
  try {
    const resp = await axios.post(url, form.toString(), {
      headers, timeout: 15000, maxRedirects: 0, httpsAgent: guardedHttpsAgent, validateStatus: () => true,
    });
    const ms = Date.now() - started;
    const data = resp.data && typeof resp.data === "object" ? resp.data : {};
    const host = new URL(url).host;
    if (resp.status >= 200 && resp.status < 300 && data.access_token) {
      console.log(`[parameters] OAuth test OK against ${host} (${resp.status}, ${ms}ms)`);
      return res.json({
        ok: true, status: resp.status, ms, host,
        tokenType: data.token_type || null, expiresIn: data.expires_in ?? null, scope: data.scope || effectiveScope || null,
      });
    }
    console.log(`[parameters] OAuth test failed against ${host} (${resp.status}, ${ms}ms)`);
    res.json({
      ok: false, status: resp.status, ms, host,
      error: data.error || (resp.status >= 300 && resp.status < 400 ? "redirect (not followed)" : `HTTP ${resp.status}`),
      errorDescription: data.error_description || (typeof resp.data === "string" ? resp.data.slice(0, 300) : null),
    });
  } catch (err) {
    res.json({ ok: false, status: null, ms: Date.now() - started, error: err.code === "ECONNABORTED" ? "timed out after 15s" : err.message });
  }
});

// ─── Parameters: web reachability / auth tests ──────────────────────────────
// Tests for the web-accessible parameter types other than OAuth:
//   kind "web"     — Web Application: can the URL be reached?
//   kind "basic"   — Credential: does the URL accept these as HTTP Basic auth?
//   kind "header"  — HTTP Custom Authorization: does the URL accept the header?
//   kind "entra-tenant" — Entra ID: does Microsoft know this tenant?
// Same fencing as the OAuth test (https only, guarded DNS + IP literals, no
// redirects followed, 15s timeout). Only the outcome comes back — never a
// body, and never the credential.
function checkTestUrl(raw) {
  let url;
  try { url = new URL(String(raw || "")); } catch { return { error: "That isn't a valid URL." }; }
  if (url.protocol !== "https:") return { error: "The URL must use https." };
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const fam = require("net").isIP(host);
  if (fam && isBlockedAddress(host, fam)) return { error: `${host} is a private or internal address — not allowed for a test.` };
  return { url: url.toString(), host: url.host };
}

app.post("/api/parameters/test-http", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { kind, url: rawUrl, username, password, headerName, headerValue, tenantId } = req.body || {};

  let target;
  const headers = { Accept: "*/*", "User-Agent": "AdminStudio-ParameterTest" };
  if (kind === "entra-tenant") {
    if (!/^[A-Za-z0-9.-]+$/.test(String(tenantId || ""))) return res.status(400).json({ error: "Enter a tenant ID or domain." });
    target = { url: `https://login.microsoftonline.com/${tenantId}/v2.0/.well-known/openid-configuration`, host: "login.microsoftonline.com" };
  } else {
    target = checkTestUrl(rawUrl);
    if (target.error) return res.status(400).json({ error: target.error });
    if (kind === "basic") {
      if (!username || !password) return res.status(400).json({ error: "A username and password are required to test." });
      headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
    } else if (kind === "header") {
      if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(String(headerName || ""))) return res.status(400).json({ error: "Enter a valid header name." });
      if (!headerValue) return res.status(400).json({ error: "Enter the header value to test." });
      headers[headerName] = String(headerValue);
    } else if (kind !== "web") {
      return res.status(400).json({ error: "Unknown test." });
    }
  }

  const started = Date.now();
  try {
    const resp = await axios.get(target.url, {
      headers, timeout: 15000, maxRedirects: 0, httpsAgent: guardedHttpsAgent, validateStatus: () => true,
      responseType: "text", maxContentLength: 2 * 1024 * 1024, transformResponse: (d) => d,
    });
    const ms = Date.now() - started;
    const status = resp.status;
    const out = { status, ms, host: target.host, location: resp.headers?.location || null, contentType: resp.headers?.["content-type"] || null };
    if (kind === "entra-tenant") {
      let issuer = null;
      try { issuer = JSON.parse(resp.data)?.issuer || null; } catch { /* not JSON */ }
      const tenantGuid = issuer?.match(/[0-9a-f-]{36}/i)?.[0] || null;
      return res.json({ ...out, ok: status === 200 && !!issuer, tenantGuid, error: status === 200 ? null : `Microsoft didn't recognise "${tenantId}" (HTTP ${status})` });
    }
    // Auth tests: 401/403 mean the credential was refused; any other non-5xx
    // means the request got past authentication.
    const authRefused = (kind === "basic" || kind === "header") && (status === 401 || status === 403);
    const ok = status < 500 && !authRefused && !(kind === "web" && status >= 400);
    console.log(`[parameters] ${kind} test against ${target.host}: ${status} (${ms}ms)`);
    res.json({
      ...out, ok,
      error: ok ? null : authRefused ? `Authentication refused (HTTP ${status})` : `HTTP ${status}`,
      wwwAuthenticate: authRefused ? (resp.headers?.["www-authenticate"] || null) : null,
    });
  } catch (err) {
    res.json({ ok: false, status: null, ms: Date.now() - started, host: target.host, error: err.code === "ECONNABORTED" ? "timed out after 15s" : err.message });
  }
});

// ─── LDAP user lookup (Sources > ISC Admins > Add from LDAP) ────────────────
// Searches the corporate directory for a person to add to the ISC Admins
// source. The DCs are fixed server-side — never taken from the request — in
// order of preference: dc1-austin.sailpoint.com, then the fallback
// dc1-awsct-core.sailpoint.com (LDAP_SEARCH_HOSTS, comma-separated, to
// override; LDAP_SEARCH_HOST still accepted for a single host). Reached over
// LDAPS with certificate verification on. The caller's own directory
// credentials are used for one bind + search and then dropped: never stored,
// logged or echoed back. Both DCs are private-network hosts, so this only
// works where the server can route to at least one of them.
const { ldapSearch } = require("./ldapClient");
const LDAP_SEARCH_HOSTS = (process.env.LDAP_SEARCH_HOSTS || process.env.LDAP_SEARCH_HOST || "dc1-austin.sailpoint.com,dc1-awsct-core.sailpoint.com")
  .split(",").map((h) => h.trim()).filter(Boolean);
const LDAP_USER_ATTRS = ["sAMAccountName", "userPrincipalName", "givenName", "sn", "displayName", "mail", "telephoneNumber", "mobile", "l", "title", "department", "manager", "userAccountControl"];
const isLdapConnectError = (err) => err?.code === "LDAP_CONNECT" || err?.code === "LDAP_TIMEOUT";

// Anonymous RootDSE read of one DC -> { base, domain }; throws if it can't be
// reached. Results are cached per host for a minute (success or failure), so
// status checks and searches don't re-probe constantly.
const LDAP_PROBE_TTL_MS = 60 * 1000;
const ldapProbeCache = new Map(); // host -> { at, info?, error? }
async function probeLdapHost(host) {
  const hit = ldapProbeCache.get(host);
  if (hit && Date.now() - hit.at < LDAP_PROBE_TTL_MS) {
    if (hit.error) throw hit.error;
    return hit.info;
  }
  try {
    const [root] = await ldapSearch({ host, base: "", scope: 0, filter: { present: "objectClass" }, attributes: ["defaultNamingContext"], timeoutMs: 4000 });
    const base = root?.attributes?.defaultNamingContext?.[0];
    if (!base) throw Object.assign(new Error(`${host} didn't report a default naming context`), { code: "LDAP_CONNECT" });
    const domain = base.split(",").filter((p) => /^DC=/i.test(p.trim())).map((p) => p.trim().slice(3)).join(".");
    const info = { host, base, domain };
    ldapProbeCache.set(host, { at: Date.now(), info });
    return info;
  } catch (error) {
    ldapProbeCache.set(host, { at: Date.now(), error });
    throw error;
  }
}

// The first DC, in preference order, that answers. { host, base, domain,
// tried: [{ host, error }] } — or throws with every host's failure.
async function activeLdapHost() {
  const tried = [];
  for (const host of LDAP_SEARCH_HOSTS) {
    try {
      return { ...(await probeLdapHost(host)), tried };
    } catch (err) {
      tried.push({ host, error: err.message });
    }
  }
  throw Object.assign(new Error(tried.map((t) => `${t.host}: ${t.error}`).join("; ")), { code: "LDAP_CONNECT", tried });
}

// Is any DC reachable right now? Drives whether the ISC Admins source's
// "Add SailPoint User" pill is active or shows the crossed-out logo.
app.get("/api/ldap/status", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  try {
    const active = await activeLdapHost();
    res.json({ reachable: true, host: active.host, hosts: LDAP_SEARCH_HOSTS, fallback: active.host !== LDAP_SEARCH_HOSTS[0], unreachable: active.tried });
  } catch (err) {
    res.json({ reachable: false, host: LDAP_SEARCH_HOSTS.join(" / "), hosts: LDAP_SEARCH_HOSTS, error: err.message });
  }
});

app.get("/api/ldap/info", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  try {
    const { host, base, domain } = await activeLdapHost();
    res.json({ host, base, domain });
  } catch (err) {
    res.status(502).json({ host: LDAP_SEARCH_HOSTS.join(" / "), error: err.message });
  }
});

app.post("/api/ldap/search", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { username, password, query } = req.body || {};
  const q = String(query || "").trim();
  if (!username || !password) return res.status(400).json({ error: "Enter your SailPoint username and password." });
  if (q.length < 2) return res.status(400).json({ error: "Enter at least 2 characters to search for." });

  const search = async ({ host, base, domain }) => {
    // "jane.doe" -> "jane.doe@<domain>"; UPNs and DOMAIN\user pass through.
    const user = String(username).trim();
    const bindDn = /[@\\]/.test(user) || /^CN=/i.test(user) ? user : `${user}@${domain}`;
    return ldapSearch({
      host, bindDn, password: String(password), base,
      filter: {
        and: [
          { eq: ["objectCategory", "person"] },
          { eq: ["objectClass", "user"] },
          { or: ["sAMAccountName", "displayName", "mail", "givenName", "sn"].map((a) => ({ contains: [a, q] })) },
        ],
      },
      attributes: LDAP_USER_ATTRS,
      sizeLimit: 25,
    });
  };

  try {
    // Preferred reachable DC first; if the search itself can't connect,
    // the next one. A credential or search error stops here — retrying a
    // bad password on another DC would only add a lockout strike.
    let active = await activeLdapHost();
    let entries;
    for (;;) {
      try {
        entries = await search(active);
        break;
      } catch (err) {
        if (!isLdapConnectError(err)) throw err;
        ldapProbeCache.set(active.host, { at: Date.now(), error: err });
        const next = LDAP_SEARCH_HOSTS.slice(LDAP_SEARCH_HOSTS.indexOf(active.host) + 1);
        let found = null;
        for (const host of next) {
          try { found = await probeLdapHost(host); break; } catch { /* try the next */ }
        }
        if (!found) throw err;
        console.warn(`[ldap] ${active.host} failed (${err.message}) — falling back to ${found.host}`);
        active = found;
      }
    }
    const first = (e, a) => e.attributes[a]?.[0] || "";
    const users = entries.map((e) => ({
      dn: e.dn,
      sAMAccountName: first(e, "sAMAccountName"),
      userPrincipalName: first(e, "userPrincipalName"),
      givenName: first(e, "givenName"),
      sn: first(e, "sn"),
      displayName: first(e, "displayName"),
      mail: first(e, "mail"),
      telephoneNumber: first(e, "telephoneNumber") || first(e, "mobile"),
      l: first(e, "l"),
      title: first(e, "title"),
      department: first(e, "department"),
      manager: first(e, "manager"),
      disabled: (Number(first(e, "userAccountControl")) & 2) === 2,
    }));
    console.log(`[ldap] search on ${active.host} by ${session.username || "user"}: ${users.length} result(s)${entries.truncated ? " (truncated)" : ""}`);
    res.json({ users, truncated: !!entries.truncated, host: active.host });
  } catch (err) {
    // Never 401 here: the client treats 401 as an expired Admin Studio
    // session. Wrong directory credentials are a 400 with a clear message.
    const status = isLdapConnectError(err) ? 502 : 400;
    console.warn(`[ldap] search failed: ${err.code || ""} ${err.message}`);
    res.status(status).json({ error: err.message, code: err.code || null });
  }
});

// ─── Identity admin: invite, user levels, governance group membership ──────
// Dedicated routes because each needs something the generic proxy doesn't
// send: the invite endpoint is experimental (X-SailPoint-Experimental), the
// auth-user update is a JSON Patch (application/json-patch+json).

// POST /api/identities/:id/invite — sends ISC's registration invitation.
app.post("/api/identities/:id/invite", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  try {
    const token = await sessionToken(session);
    const resp = await axios.post(
      `https://${tenantApiHost(session.tenant)}/v2026/identities/invite`,
      { ids: [req.params.id], uninvited: false },
      { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-SailPoint-Experimental": "true" } }
    );
    console.log(`[identities] ${session.username || "user"} invited ${req.params.id}`);
    res.json(resp.data || { ok: true });
  } catch (err) {
    if (err.sessionExpired) return res.status(401).json({ error: describeError(err), sessionExpired: true });
    console.warn("[identities] invite failed:", err.response?.status, JSON.stringify(err.response?.data || err.message));
    res.status(err.response?.status || 500).json({ error: describeError(err) });
  }
});

// PUT /api/identities/:id/user-levels { capabilities: [...] } — replaces the
// identity's auth-user capabilities (built-in levels + any "sp:…" rights the
// caller passes through unchanged).
app.put("/api/identities/:id/user-levels", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const caps = req.body?.capabilities;
  if (!Array.isArray(caps) || caps.some((c) => typeof c !== "string" || !c.trim())) {
    return res.status(400).json({ error: "capabilities must be an array of strings." });
  }
  // Removing Admin from yourself would lock this session out of the admin
  // APIs mid-flight — refuse; another admin can do it.
  if (req.params.id === session.identity?.id && !caps.includes("ORG_ADMIN")) {
    try {
      const token = await sessionToken(session);
      const current = await iscGet(session.tenant, token, `/v2026/auth-users/${req.params.id}`);
      if ((current?.capabilities || []).includes("ORG_ADMIN")) {
        return res.status(400).json({ error: "You can't remove the Admin user level from your own account — ask another admin to do it." });
      }
    } catch { /* fall through to the update */ }
  }
  try {
    const token = await sessionToken(session);
    const resp = await axios.patch(
      `https://${tenantApiHost(session.tenant)}/v2026/auth-users/${encodeURIComponent(req.params.id)}`,
      [{ op: "replace", path: "/capabilities", value: [...new Set(caps.map((c) => c.trim()))] }],
      { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json-patch+json" } }
    );
    console.log(`[identities] ${session.username || "user"} set user levels on ${req.params.id}: ${caps.join(", ") || "(none)"}`);
    res.json(resp.data);
  } catch (err) {
    if (err.sessionExpired) return res.status(401).json({ error: describeError(err), sessionExpired: true });
    console.warn("[identities] user level update failed:", err.response?.status, JSON.stringify(err.response?.data || err.message));
    res.status(err.response?.status || 500).json({ error: describeError(err) });
  }
});

// POST /api/identities/:id/governance-groups { add: [groupId], remove: [groupId] }
// — adds/removes this identity as a member of each group (bulk-add /
// bulk-delete per group). Continues past individual failures and reports.
app.post("/api/identities/:id/governance-groups", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const add = Array.isArray(req.body?.add) ? req.body.add : [];
  const remove = Array.isArray(req.body?.remove) ? req.body.remove : [];
  const member = [{ type: "IDENTITY", id: req.params.id, ...(req.body?.name ? { name: String(req.body.name) } : {}) }];
  const results = [];
  try {
    const token = await sessionToken(session);
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    for (const [op, ids] of [["bulk-add", add], ["bulk-delete", remove]]) {
      for (const groupId of ids) {
        try {
          await withApiRetry(
            () => axios.post(`https://${tenantApiHost(session.tenant)}/v2026/workgroups/${encodeURIComponent(groupId)}/members/${op}`, member, { headers }),
            { label: `workgroup ${groupId} ${op}` }
          );
          results.push({ groupId, op, ok: true });
        } catch (err) {
          results.push({ groupId, op, ok: false, error: describeError(err) });
        }
      }
    }
    console.log(`[identities] ${session.username || "user"} governance groups for ${req.params.id}: +${add.length} -${remove.length}, ${results.filter((r) => !r.ok).length} failed`);
    res.json({ results });
  } catch (err) {
    if (err.sessionExpired) return res.status(401).json({ error: describeError(err), sessionExpired: true });
    res.status(err.response?.status || 500).json({ error: describeError(err) });
  }
});

// ─── Launcher → entitlement ────────────────────────────────────────────────
// ISC creates an entitlement for every launcher on its internal "IdentityNow"
// source (that's what gets requested/assigned so the launcher shows in the
// Launchpad). The API has no link from launcher to entitlement and ISC
// doesn't document the entitlement's attribute/value format, so this finds
// it on that source: an entitlement whose value carries the launcher's id
// first, else one named like the launcher that isn't a plain user-level
// group. The match (and how it matched) is logged so the real format shows.
async function identityNowSourceId(tenant, token) {
  const byName = await iscGet(tenant, token, "/v2026/sources", { filters: 'name eq "IdentityNow"', limit: 1 });
  if (Array.isArray(byName) && byName[0]?.id) return byName[0].id;
  const hits = await axios.post(
    `https://${tenantApiHost(tenant)}/v2026/search`,
    { indices: ["entitlements"], query: { query: 'source.name:"IdentityNow"' }, queryResultFilter: { includes: ["source"] } },
    { headers: { Authorization: `Bearer ${token}` }, params: { limit: 1 } }
  );
  return hits.data?.[0]?.source?.id || null;
}

// Finds the launcher's entitlement on the IdentityNow source — see above.
// Resolves to { entitlement | null, matchedBy, sourceId, reason? }.
async function findLauncherEntitlement(tenant, token, launcher) {
  const sourceId = await identityNowSourceId(tenant, token);
  if (!sourceId) return { entitlement: null, matchedBy: null, sourceId: null, reason: "This tenant's internal IdentityNow source wasn't found." };
  const ents = await fetchAllPaged(tenant, token, "/v2026/entitlements", { filters: `source.id eq "${sourceId}"` });
  const id = String(launcher.id || "").toLowerCase();
  const name = String(launcher.name || "").trim().toLowerCase();
  const nameOf = (e) => String(e.displayName || e.name || "").trim().toLowerCase();
  let matchedBy = null;
  let entitlement = ents.find((e) => id && String(e.value || "").toLowerCase().includes(id));
  if (entitlement) matchedBy = "value";
  if (!entitlement) {
    entitlement = ents.find((e) => /launch/i.test(`${e.attribute} ${e.sourceSchemaObjectType} ${e.schema || ""}`) && nameOf(e) === name);
    if (entitlement) matchedBy = "launcher-type name";
  }
  if (!entitlement) {
    entitlement = ents.find((e) => e.attribute !== "assignedGroups" && nameOf(e) === name);
    if (entitlement) matchedBy = "name";
  }
  if (entitlement) {
    console.log(`[launchers] ${launcher.id} entitlement ${entitlement.id} matched by ${matchedBy}: attribute=${entitlement.attribute} type=${entitlement.sourceSchemaObjectType} value=${entitlement.value}`);
  } else {
    console.log(`[launchers] ${launcher.id} ("${launcher.name}"): no entitlement found among ${ents.length} on the IdentityNow source`);
  }
  return { entitlement: entitlement || null, matchedBy, sourceId };
}

// Launchers waiting for ISC to create their entitlement so it can be made
// requestable: `${tenant}:${launcherId}` -> { startedAt, until }.
const pendingLauncherRequestable = new Map();
const LAUNCHER_ENT_POLL_MS = 20 * 1000;
const LAUNCHER_ENT_WAIT_MS = 10 * 60 * 1000;

app.get("/api/launchers/:id/entitlement", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  try {
    const token = await sessionToken(session);
    const launcher = await iscGet(tenant, token, `/v2026/launchers/${encodeURIComponent(req.params.id)}`);
    const result = await findLauncherEntitlement(tenant, token, launcher);
    res.json({ ...result, pendingRequestable: pendingLauncherRequestable.has(`${tenant}:${req.params.id}`) });
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[launchers] entitlement lookup failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

// POST /api/launchers/:id/entitlement/requestable — make the launcher's
// entitlement requestable. ISC creates that entitlement a few minutes after
// the launcher, so when it isn't there yet this keeps checking in the
// background (every 20 s, up to 10 min) and applies it once it appears.
// Answers { status: "done" | "pending", entitlementId? }.
app.post("/api/launchers/:id/entitlement/requestable", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  const launcherId = req.params.id;
  const key = `${tenant}:${launcherId}`;
  const makeRequestable = async (entitlementId) => {
    const token = await sessionToken(session);
    await axios.patch(
      `https://${tenantApiHost(tenant)}/v2026/entitlements/${encodeURIComponent(entitlementId)}`,
      [{ op: "replace", path: "/requestable", value: true }],
      { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json-patch+json" } }
    );
    console.log(`[launchers] ${launcherId}: entitlement ${entitlementId} made requestable`);
  };
  try {
    const token = await sessionToken(session);
    const launcher = await iscGet(tenant, token, `/v2026/launchers/${encodeURIComponent(launcherId)}`);
    const { entitlement } = await findLauncherEntitlement(tenant, token, launcher);
    if (entitlement) {
      if (!entitlement.requestable) await makeRequestable(entitlement.id);
      return res.json({ status: "done", entitlementId: entitlement.id });
    }
    if (!pendingLauncherRequestable.has(key)) {
      const until = Date.now() + LAUNCHER_ENT_WAIT_MS;
      pendingLauncherRequestable.set(key, { startedAt: Date.now(), until });
      console.log(`[launchers] ${launcherId}: entitlement not there yet — will make it requestable when ISC creates it`);
      (async () => {
        try {
          while (Date.now() < until) {
            await new Promise((r) => setTimeout(r, LAUNCHER_ENT_POLL_MS));
            try {
              const t = await sessionToken(session);
              const found = await findLauncherEntitlement(tenant, t, launcher);
              if (found.entitlement) {
                if (!found.entitlement.requestable) await makeRequestable(found.entitlement.id);
                return;
              }
            } catch (err) {
              if (err.sessionExpired) { console.warn(`[launchers] ${launcherId}: session ended before the entitlement appeared`); return; }
              console.warn(`[launchers] ${launcherId}: requestable check failed: ${describeError(err)}`);
            }
          }
          console.warn(`[launchers] ${launcherId}: entitlement didn't appear within ${LAUNCHER_ENT_WAIT_MS / 60000} min — not made requestable`);
        } finally {
          pendingLauncherRequestable.delete(key);
        }
      })();
    }
    res.status(202).json({ status: "pending" });
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[launchers] make requestable failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

// ─── Governance groups (Browse > Governance Groups) ────────────────────────
// Reads go through the generic proxy; writes are here because ISC wants a
// JSON Patch for the group itself and per-chunk bulk calls for members.

// Every page of a v2026 collection (limit/offset).
async function fetchAllPaged(tenant, token, iscPath, params = {}, pageSize = 250) {
  const all = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = await withApiRetry(() => iscGet(tenant, token, iscPath, { ...params, limit: pageSize, offset }), { label: `${iscPath} page` });
    if (!Array.isArray(page) || page.length === 0) break;
    all.push(...page);
    if (page.length < pageSize) break;
  }
  return all;
}

// POST /api/workgroups { name, description, owner: {id,name} }
app.post("/api/workgroups", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { name, description, owner } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: "name is required." });
  if (!owner?.id) return res.status(400).json({ error: "owner is required." });
  try {
    const token = await sessionToken(session);
    const resp = await axios.post(
      `https://${tenantApiHost(session.tenant)}/v2026/workgroups`,
      { name: String(name).trim(), description: description || "", owner: { type: "IDENTITY", id: owner.id, name: owner.name } },
      { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }
    );
    res.json(resp.data);
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[workgroups] create failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

// PATCH /api/workgroups/:id { name?, description?, owner? } — the three
// fields ISC lets you patch on a governance group.
app.patch("/api/workgroups/:id", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { name, description, owner } = req.body || {};
  const ops = [];
  if (name !== undefined) {
    if (!name || !String(name).trim()) return res.status(400).json({ error: "name can't be empty." });
    ops.push({ op: "replace", path: "/name", value: String(name).trim() });
  }
  if (description !== undefined) ops.push({ op: "replace", path: "/description", value: description });
  if (owner !== undefined) {
    if (!owner?.id) return res.status(400).json({ error: "owner must have an id." });
    ops.push({ op: "replace", path: "/owner", value: { type: "IDENTITY", id: owner.id, name: owner.name } });
  }
  if (ops.length === 0) return res.status(400).json({ error: "Provide at least one field to update." });
  try {
    const token = await sessionToken(session);
    const resp = await axios.patch(
      `https://${tenantApiHost(session.tenant)}/v2026/workgroups/${encodeURIComponent(req.params.id)}`,
      ops,
      { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json-patch+json" } }
    );
    res.json(resp.data);
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[workgroups] edit failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

// DELETE /api/workgroups/:id
app.delete("/api/workgroups/:id", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  try {
    const token = await sessionToken(session);
    await axios.delete(`https://${tenantApiHost(session.tenant)}/v2026/workgroups/${encodeURIComponent(req.params.id)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    console.log(`[workgroups] ${session.username || "user"} deleted ${req.params.id}`);
    res.status(204).end();
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[workgroups] delete failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

// POST /api/workgroups/:id/members { add: [{id,name}], remove: [{id,name}] }
// — bulk-add / bulk-delete in chunks of 100. Reports per-chunk failures.
app.post("/api/workgroups/:id/members", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const toRef = (m) => ({ type: "IDENTITY", id: String(m.id), ...(m.name ? { name: String(m.name) } : {}) });
  const add = (Array.isArray(req.body?.add) ? req.body.add : []).filter((m) => m?.id).map(toRef);
  const remove = (Array.isArray(req.body?.remove) ? req.body.remove : []).filter((m) => m?.id).map(toRef);
  if (!add.length && !remove.length) return res.status(400).json({ error: "Nothing to add or remove." });
  try {
    const token = await sessionToken(session);
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const errors = [];
    let added = 0;
    let removed = 0;
    for (const [op, list] of [["bulk-add", add], ["bulk-delete", remove]]) {
      for (let i = 0; i < list.length; i += 100) {
        const chunk = list.slice(i, i + 100);
        try {
          await withApiRetry(
            () => axios.post(`https://${tenantApiHost(session.tenant)}/v2026/workgroups/${encodeURIComponent(req.params.id)}/members/${op}`, chunk, { headers }),
            { label: `workgroup ${req.params.id} ${op}` }
          );
          if (op === "bulk-add") added += chunk.length; else removed += chunk.length;
        } catch (err) {
          if (err.sessionExpired) throw err;
          errors.push(`${op === "bulk-add" ? "Adding" : "Removing"} ${chunk.length}: ${describeError(err)}`);
        }
      }
    }
    console.log(`[workgroups] ${session.username || "user"} members of ${req.params.id}: +${added} -${removed}${errors.length ? `, ${errors.length} failed` : ""}`);
    res.json({ added, removed, errors });
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

// Where in an object a governance group's id appears, as readable labels
// ("Additional owner", "Access request approver", …). Scans the whole object
// so a reference ISC adds in a new field still shows (labelled by its path).
function workgroupRefLabels(obj, groupId) {
  const hits = [];
  const walk = (node, path) => {
    if (node == null) return;
    if (Array.isArray(node)) return node.forEach((v, i) => walk(v, `${path}[${i}]`));
    if (typeof node === "object") return Object.entries(node).forEach(([k, v]) => walk(v, path ? `${path}.${k}` : k));
    if (node === groupId && path) hits.push(path);
  };
  walk(obj, "");
  const labelFor = (p) => {
    if (/^additionalOwners/.test(p)) return "Additional owner";
    if (/^managementWorkgroup/.test(p)) return "Management workgroup (additional owner)";
    if (/^owner\b/.test(p)) return "Owner";
    if (/^accessRequestConfig\.approvalSchemes/.test(p)) return "Access request approver";
    if (/^revokeRequestConfig\.approvalSchemes|^revocationRequestConfig/.test(p)) return "Revoke request approver";
    if (/violationOwnerAssignmentConfig/.test(p)) return "Violation owner";
    if (/^secondaryOwnerRefs/.test(p)) return "Secondary owner";
    if (/^ownerRef/.test(p)) return "Owner";
    if (/^definition|^trigger/.test(p)) return "Referenced in workflow steps";
    return p.replace(/\[\d+\]/g, "").replace(/\.id$/, "");
  };
  return [...new Set(hits.filter((p) => p !== "id").map(labelFor))];
}

// GET /api/workgroups/:id/usage — where this governance group is used.
// ISC's own connections list (access-request reviewer, owner, management
// workgroup) plus a scan of roles, access profiles, sources, SOD policies
// and workflows for the group's id. Entitlements are too many to scan, so
// they only show when ISC's connections list reports them.
app.get("/api/workgroups/:id/usage", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  const groupId = req.params.id;
  try {
    const token = await sessionToken(session);
    const usage = [];
    const errors = [];
    const seen = new Set();
    const push = (type, obj, how) => {
      const key = `${type}:${obj.id}:${how.join(",")}`;
      if (seen.has(key)) return;
      seen.add(key);
      usage.push({ type, id: obj.id, name: obj.name || obj.displayName || obj.id, how });
    };

    const scans = [
      ["CONNECTIONS", async () => {
        const list = await fetchAllPaged(tenant, token, `/v2026/workgroups/${encodeURIComponent(groupId)}/connections`, {}, 50);
        for (const c of list) {
          const o = c.object || {};
          const how = { AccessRequestReviewer: "Access request reviewer", Owner: "Owner", ManagementWorkgroup: "Management workgroup (additional owner)" }[c.connectionType] || c.connectionType;
          push(o.type || "OBJECT", o, [how]);
        }
      }],
      ["ROLE", () => fetchAllPaged(tenant, token, "/v2026/roles")],
      ["ACCESS_PROFILE", () => fetchAllPaged(tenant, token, "/v2026/access-profiles")],
      ["SOURCE", () => fetchAllPaged(tenant, token, "/v2026/sources")],
      ["SOD_POLICY", () => fetchAllPaged(tenant, token, "/v2026/sod-policies")],
      ["WORKFLOW", () => iscGet(tenant, token, "/v2026/workflows")],
    ];
    await Promise.all(scans.map(async ([type, fn]) => {
      try {
        const list = await fn();
        if (type === "CONNECTIONS" || !Array.isArray(list)) return;
        for (const obj of list) {
          if (!JSON.stringify(obj).includes(groupId)) continue;
          const how = workgroupRefLabels(obj, groupId);
          if (how.length) push(type, obj, how);
        }
      } catch (err) {
        if (err.sessionExpired) throw err;
        errors.push(`${type}: ${describeError(err)}`);
      }
    }));
    // Collapse a connection and a scan hit on the same object into one row.
    const merged = new Map();
    for (const u of usage) {
      const k = `${u.type}:${u.id}`;
      const prev = merged.get(k);
      merged.set(k, prev ? { ...prev, how: [...new Set([...prev.how, ...u.how])] } : u);
    }
    res.json({ usage: [...merged.values()].sort((a, b) => a.type.localeCompare(b.type) || String(a.name).localeCompare(String(b.name))), errors });
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[workgroups] usage failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

// Lets a long-open browser tab tell it's running an older client than the
// server (see Auto Convert, which refuses to start from a stale page).
const SERVER_VERSION = require("./package.json").version;
app.get("/api/version", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ version: SERVER_VERSION });
});

app.get("/api/auth/tenants", async (_req, res) => {
  const tenants = Object.entries(await mergedOAuthClients())
    .map(([tenant, entry]) => ({ tenant, siteName: entry.siteName || tenant }))
    .sort((a, b) => a.siteName.localeCompare(b.siteName));
  // localAdmin tells the login screen whether to offer the Local Admin entry;
  // it says nothing about credentials, only that the feature is configured.
  res.json({ tenants, localAdmin: localAdminEnabled() });
});

/**
 * POST /api/auth/register-client
 * Body: { tenant, adminClientId, adminClientSecret, siteName }
 *
 * Registers this app's sign-in client in a tenant the caller administers.
 * The admin credentials are a Personal Access Token for that tenant, used
 * once to create the client and never stored — only the resulting sign-in
 * client is kept, and its secret is never returned to the browser.
 *
 * Local admin may register or RE-register any tenant. An anonymous caller
 * (the native app's first-run setup) may only register a tenant with no
 * existing registration — the PAT it presents is the authorization — while
 * rewriting an existing tenant's shared client still requires the local
 * admin (Internet-exposure review finding #1 kept for that case). The redirect
 * URI list is fixed at build time — the request's origin is deliberately NOT
 * reflected into it, since the registered client is shared tenant-wide and a
 * reflected origin would become a code-exfiltration redirect for everyone.
 */
app.post("/api/auth/register-client", async (req, res) => {
  const session = await getSession(req);
  const isLocalAdmin = !!session?.localAdmin;
  const tenant = normalizeTenantInput(req.body?.tenant);
  const { adminClientId, adminClientSecret } = req.body || {};
  const siteName = String(req.body?.siteName || "").trim() || tenant;

  if (!tenant || !adminClientId || !adminClientSecret) {
    return res.status(400).json({ error: "Tenant, client ID, and client secret are required." });
  }
  if (!isValidTenantName(tenant)) {
    return res.status(400).json({ error: INVALID_TENANT_MESSAGE });
  }
  // Anonymous callers (the native app's first-time setup on its login
  // screen) may only register a tenant that ISN'T registered yet — the
  // tenant admin PAT they present is the real authorization for that.
  // Overwriting an existing registration rewrites the shared sign-in
  // client for everyone on that tenant, so it stays local-admin-only
  // (Internet-exposure review finding #1 kept intact for that case).
  if (!isLocalAdmin && (await mergedOAuthClients())[tenant]) {
    return res.status(403).json({
      error: `"${tenant}" is already registered. Sign in as Local Admin to re-register it.`,
    });
  }
  // A tenant that's already set up may be registered again — the old client
  // is deleted below and replaced, which is the recovery path when its
  // secret has been lost (e.g. the registration predates the data volume).

  const api = `https://${tenantApiHost(tenant)}`;
  // Every surface that can sign in must be registered up front — SailPoint
  // only redirects to an exact match.
  const redirectUris = [...new Set([
    "http://localhost:3000/auth/callback",
    "https://adminstudio.vercel.app/auth/callback",
    "https://adminstudio.kccs.net/auth/callback",
    "com.kccs.identitysecurity://auth/callback",
  ])];

  try {
    const token = (await axios.post(
      `${api}/oauth/token`,
      new URLSearchParams({
        grant_type: "client_credentials",
        client_id: adminClientId,
        client_secret: adminClientSecret,
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    )).data.access_token;

    const auth = { Authorization: `Bearer ${token}` };

    // The secret is only revealed at creation, so an existing client from a
    // previous setup can never be adopted — delete it and start fresh. This
    // also makes re-running setup the recovery path for a lost secret. Only
    // a client with THIS server's name is touched, so other deployments
    // registered under a different SP_SIGNIN_CLIENT_NAME are untouched.
    const existing = (await axios.get(`${api}/beta/oauth-clients`, { headers: auth })).data
      .filter((c) => c.name === SIGNIN_CLIENT_NAME);
    for (const old of existing) {
      await axios.delete(`${api}/beta/oauth-clients/${old.id}`, { headers: auth });
      console.log(`[auth] deleted previous sign-in client "${SIGNIN_CLIENT_NAME}" in ${tenant}: ${old.id}`);
    }

    const created = (await axios.post(
      `${api}/beta/oauth-clients`,
      {
        name: SIGNIN_CLIENT_NAME,
        description: "Admin Studio",
        businessName: "KCCS",
        homepageUrl: "https://adminstudio.vercel.app",
        type: "CONFIDENTIAL",
        grantTypes: ["AUTHORIZATION_CODE", "REFRESH_TOKEN"],
        redirectUris,
        accessType: "OFFLINE",
        enabled: true,
        internal: false,
        strongAuthSupported: true,
        claimsSupported: true,
        accessTokenValiditySeconds: 3600,
        refreshTokenValiditySeconds: 86400,
      },
      { headers: { ...auth, "Content-Type": "application/json" } }
    )).data;

    if (!created.secret) {
      return res.status(502).json({
        error: "SailPoint created the client but returned no secret. Delete the \"identity-app-user-login\" client in that tenant and try again.",
      });
    }

    // The PAT is kept as this tenant's service credential, used only when a
    // signed-in user's token lacks strong auth (see serviceToken).
    await persistClient(tenant, {
      clientId: created.id,
      clientSecret: created.secret,
      adminClientId,
      adminClientSecret,
      siteName,
    });
    console.log(`[auth] registered sign-in client for tenant=${tenant} clientId=${created.id} siteName=${siteName}`);

    // A brand-new tenant starts with Role Statistics Refresh already
    // scheduled — daily at 06:00, starting the day the tenant was set up.
    // Only seeded when the tenant has no preferences record at all, so
    // re-running setup (the lost-secret recovery path) never clobbers a
    // schedule someone has since changed or turned off.
    if (!(await studioPreferences.get(tenant))) {
      const today = new Date();
      const startDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
      await studioPreferences.put(tenant, {
        ...DEFAULT_STUDIO_PREFERENCES,
        roleStatsRefreshEnabled: true,
        roleStatsRefreshStartDate: startDate,
      });
      console.log(`[auth] seeded default Role Statistics Refresh schedule for new tenant=${tenant} (daily 06:00 from ${startDate})`);
    }

    res.json({ ok: true, tenant, siteName, clientId: created.id, redirectUris });
  } catch (err) {
    const status = err.response?.status;
    const oauthError = err.response?.data?.error;
    console.error(
      `[auth] client registration failed for ${tenant}:`,
      status, oauthError || err.message, err.response?.data?.error_description || ""
    );
    if (oauthError === "invalid_client" || status === 401) {
      return res.status(401).json({ error: "That Client ID and secret weren't accepted by this tenant." });
    }
    if (status === 403) {
      return res.status(403).json({ error: "Those credentials lack permission to create an OAuth client in this tenant." });
    }
    // A full host is used exactly as typed, so the usual slip is entering the
    // tenant's WEB address (acme.identitynow.com) where the API host
    // (acme.api.identitynow.com) was needed — say so rather than leaving a
    // bare "not found".
    const apiHostHint = isFullHostTenant(tenant) && !/\.api\./.test(tenant)
      ? ` A full host is used exactly as entered — this one has no ".api" part. If it's the tenant's web address, enter its API host instead (for example ${tenant.replace(/^([^.]+)\./, "$1.api.")}).`
      : "";
    if (err.code === "ENOTFOUND" || err.code === "EAI_AGAIN") {
      return res.status(400).json({ error: `No SailPoint tenant found at "${tenantApiHost(tenant)}".${apiHostHint}` });
    }
    res.status(status || 500).json({
      error: (err.response?.data?.messages?.[0]?.text || err.response?.data?.error_description || "Could not set up this tenant.") + apiHostHint,
    });
  }
});

app.post("/api/auth/authorize-url", async (req, res) => {
  // Tenant names are case-insensitive as hostnames but are echoed back into
  // the UI and stored on scan records, so normalize once here.
  const tenant = normalizeTenantInput(req.body?.tenant);
  const redirectUri = req.body?.redirectUri;

  if (!tenant || !redirectUri) {
    return res.status(400).json({ error: "Tenant and redirectUri are required." });
  }
  if (!isValidTenantName(tenant)) {
    return res.status(400).json({ error: "Invalid tenant name." });
  }

  // Fail here with a clear message rather than sending the user to SailPoint
  // with a client id that tenant has never heard of — which it rejects by
  // simply never redirecting back, and so looks like a broken redirect.
  const client = await clientFor(tenant);
  if (!client) {
    console.warn(`[auth] no OAuth client registered for tenant "${tenant}" — sign-in refused`);
    return res.status(400).json({
      error: `"${tenant}" isn't set up for sign-in yet. Each tenant needs its own registered OAuth client.`,
    });
  }

  await reapPendingLogins();
  const state = crypto.randomUUID();
  // SailPoint will not redirect to a non-HTTPS scheme — it authenticates and
  // then renders a dead-end page — so the native app also comes back through
  // the web callback, which hands off into the app afterwards.
  await pendingLoginsStore.put(
    state,
    { tenant, redirectUri, native: !!req.body?.native, createdAt: Date.now() },
    { ttlEpochMs: Date.now() + LOGIN_STATE_TTL_MS }
  );
  console.log(`[auth] authorize-url issued: tenant=${tenant} native=${!!req.body?.native} redirect=${redirectUri} state=${state.slice(0, 8)}`);

  const url =
    `https://${tenantUiHost(tenant)}/oauth/authorize?` +
    new URLSearchParams({
      client_id: client.clientId,
      response_type: "code",
      redirect_uri: redirectUri,
      state,
    });

  // The native app needs the state so it can collect the finished session.
  res.json({ url, state });
});

/**
 * GET /api/auth/native-session?state=...
 * Collects a completed native login. Single-use: the session is handed over
 * once and then forgotten, so a replayed state gets nothing.
 */
app.get("/api/auth/native-session", async (req, res) => {
  const state = String(req.query.state || "");
  if (!state) return res.status(400).json({ error: "state is required." });

  await reapPendingLogins();
  const rawDone = await completedNativeLoginsStore.get(state);
  const done = stateIsFresh(rawDone) ? rawDone : null;
  if (!done) {
    // Still in progress (or expired) — the app keeps polling.
    return res.json({ ready: false });
  }
  await completedNativeLoginsStore.delete(state);
  console.log(`[auth] native session collected for state=${state.slice(0, 8)}`);
  res.json({ ready: true, sessionId: done.sessionId });
});

/**
 * POST /api/auth/callback
 * Body: { code, state }
 * Exchanges the authorization code for tokens and opens a session.
 */
app.post("/api/auth/callback", async (req, res) => {
  const { code, state } = req.body || {};
  if (!code || !state) {
    return res.status(400).json({ error: "Missing authorization code or state." });
  }

  await reapPendingLogins();
  const rawPending = await pendingLoginsStore.get(state);
  const pending = stateIsFresh(rawPending) ? rawPending : null;
  console.log(`[auth] callback received: state=${String(state).slice(0, 8)} matched=${!!pending} native=${!!pending?.native}`);
  if (!pending) {
    return res.status(400).json({ error: "This sign-in link has expired. Please try again." });
  }
  // Single-use: consume the state whether or not the exchange succeeds, so a
  // code can't be replayed against it.
  await pendingLoginsStore.delete(state);

  const { tenant, redirectUri, native } = pending;

  try {
    const data = await requestGrant(tenant, {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    });

    const token = data.access_token;
    const identity = await buildIdentity(tenant, token);

    // Which authorities the browser token actually carries decides what the
    // app can read. ISC grants admin authorities only to strongly
    // authenticated sessions, so a token without ORG_ADMIN here explains 403s
    // on admin endpoints even for an admin user. Claims only — never the token.
    const claims = decodeJwtPayload(token);
    console.log(
      `[auth] token for ${identity.username}: authorities=${JSON.stringify(claims.authorities)} ` +
      `strong_auth=${claims.strong_auth} scope=${JSON.stringify(claims.scope)}`
    );

    const sessionId = crypto.randomUUID();
    await putSession({
      id: sessionId,
      tenant,
      username: identity.username,
      accessToken: token,
      refreshToken: data.refresh_token || null,
      expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
      identity,
      // Kept for diagnostics: what this token is actually allowed to do.
      authorities: claims.authorities || [],
      strongAuth: claims.strong_auth,
      // Decoded claims only — the access token itself is a bearer credential
      // and never leaves the server.
      claims,
    });

    console.log(`[auth] signed in: ${identity.username || identity.id || "unknown"} on ${tenant}`);

    // Best-effort: a failure to bump the login counter must never fail the
    // sign-in itself.
    try {
      await recordTenantLogin(tenant, identity);
    } catch (err) {
      console.error(`[auth] failed to record login for ${tenant}:`, err.message);
    }

    if (native) {
      // The app is polling for this; it can't be handed over via the browser.
      await completedNativeLoginsStore.put(state, { sessionId, createdAt: Date.now() }, { ttlEpochMs: Date.now() + LOGIN_STATE_TTL_MS });
      console.log(`[auth] native session ready for collection, state=${String(state).slice(0, 8)}`);
    }
    // strongAuth decides whether ISC will honour admin authorities on this
    // token, so the UI surfaces it rather than leaving 403s unexplained.
    res.json({
      ok: true, tenant, sessionId, identity,
      strongAuth: claims.strong_auth === true,
      // True when calls will run with the tenant's service credential
      // instead of this user's own permissions.
      elevated: claims.strong_auth !== true && (await hasServiceCredential(tenant)),
      // Tells the web callback page to hand this session off to the native
      // app rather than continuing in the browser.
      native: !!native,
      claims,
    });
  } catch (err) {
    console.error(
      `[auth] code exchange failed on ${tenant}:`,
      err.response?.status, err.response?.data?.error || err.message,
      err.response?.data?.error_description || ""
    );
    res.status(err.response?.status || 500).json({
      error: err.response?.data?.error_description || "Sign-in could not be completed.",
    });
  }
});

/**
 * POST /api/auth/renew
 * Header: x-sp-session
 * Forces a fresh access token via the refresh_token grant, regardless of
 * whether the current one is still valid — sessionToken() above only ever
 * refreshes once a token is within a minute of expiring, so a still-valid
 * token never picks up a config change made after it was issued (e.g. a
 * new OAuth scope granted to the client) until it naturally expires. This
 * gets a new one on demand instead of waiting, and re-decodes its claims
 * so the Profile screen can show the result immediately — same response
 * shape as GET /api/auth/session, since the client just needs to refresh
 * the same session state either way.
 */
app.post("/api/auth/renew", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  if (!session.refreshToken) {
    return res.status(400).json({ error: "This session has no refresh token to renew from — sign out and sign back in instead." });
  }

  try {
    const data = await requestGrant(session.tenant, {
      grant_type: "refresh_token",
      refresh_token: session.refreshToken,
    });
    session.accessToken = data.access_token;
    if (data.refresh_token) session.refreshToken = data.refresh_token;
    session.expiresAt = Date.now() + (data.expires_in || 3600) * 1000;

    const claims = decodeJwtPayload(data.access_token);
    session.claims = claims;
    session.authorities = claims.authorities || [];
    session.strongAuth = claims.strong_auth;
    await putSession(session);

    console.log(
      `[auth] token renewed for ${session.username} on ${session.tenant}: authorities=${JSON.stringify(claims.authorities)} ` +
      `strong_auth=${claims.strong_auth} scope=${JSON.stringify(claims.scope)}`
    );

    res.json({
      ok: true,
      tenant: session.tenant,
      identity: session.identity,
      strongAuth: session.strongAuth === true,
      elevated: session.strongAuth !== true && (await hasServiceCredential(session.tenant)),
      claims,
    });
  } catch (err) {
    console.error(`[auth] token renewal failed for ${session.username} on ${session.tenant}:`, err.response?.data || err.message);
    res.status(err.response?.status || 500).json({
      error: err.response?.data?.error_description || "Token renewal failed — try signing out and back in instead.",
    });
  }
});

/**
 * GET /api/auth/session
 * Header: x-sp-session
 * Lets a reloaded page (or a new tab) confirm its stored session id is still
 * live and recover the signed-in identity, without re-prompting for a password.
 */
app.get("/api/auth/session", async (req, res) => {
  const session = await getSession(req);
  if (!session) {
    console.warn(`[auth] session lookup failed for id=${String(req.headers["x-sp-session"] || "none").slice(0, 8)}`);
    return unauthorized(res);
  }
  console.log(`[auth] session validated for ${session.username} on ${session.tenant || "local-admin"}`);
  res.json({
    ok: true,
    tenant: session.tenant,
    // The name this tenant was registered under — what the nav shows when
    // the tenant has no instance badge.
    siteName: session.tenant ? (await clientFor(session.tenant))?.siteName || null : null,
    identity: session.identity,
    localAdmin: session.localAdmin === true,
    strongAuth: session.strongAuth === true,
    elevated: session.strongAuth !== true && !session.localAdmin && (await hasServiceCredential(session.tenant)),
    claims: session.claims || null,
  });
});

/**
 * Asks SailPoint to revoke a token so it can't be used after sign-out.
 * Verified token-specific: revoking one leaves other tokens for the same
 * client working. Takes ~30-60s to propagate, so it hardens sign-out rather
 * than cutting access instantly.
 */
async function revokeToken(tenant, token, hint) {
  const client = await clientFor(tenant);
  if (!client || !token) return false;
  try {
    await axios.post(
      `https://${tenantApiHost(tenant)}/oauth/revoke`,
      new URLSearchParams({
        token,
        ...(hint ? { token_type_hint: hint } : {}),
        client_id: client.clientId,
        client_secret: client.clientSecret,
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );
    return true;
  } catch (err) {
    console.error(`[auth] revoke (${hint || "token"}) failed for ${tenant}:`, err.response?.status, err.response?.data?.error || err.message);
    return false;
  }
}

/**
 * POST /api/auth/logout — drops the server-side session and asks SailPoint to
 * revoke its tokens, so signing out ends access at ISC too rather than leaving
 * a usable token until it expires.
 */
app.post("/api/auth/logout", async (req, res) => {
  const id = req.headers["x-sp-session"];
  const session = id ? await sessionsStore.get(id) : null;

  // Drop the session first: sign-out must succeed for the user even if
  // revocation fails or is slow.
  if (id) await sessionsStore.delete(id);
  res.json({ ok: true });

  if (session?.localAdmin) {
    console.log("[auth] local admin signed out");
  } else if (session) {
    const results = await Promise.all([
      revokeToken(session.tenant, session.accessToken, "access_token"),
      session.refreshToken
        ? revokeToken(session.tenant, session.refreshToken, "refresh_token")
        : Promise.resolve(null),
    ]);
    console.log(`[auth] signed out ${session.username} on ${session.tenant} — revoked access=${results[0]} refresh=${results[1]}`);
  }
});

// An identity's lifecycle states are the ones defined on ITS identity
// profile, and the profile is found through the identity's authoritative
// source. /identity-profiles doesn't accept filtering on
// authoritativeSource.id (rejected as semantically invalid) — the profile
// count per tenant is small, so list them all and match here.
// Returns { identity, profile, lifecycleStates } or { error } (a 422 message).
async function resolveIdentityLifecycle(tenant, token, identityId) {
  const identity = await iscGet(tenant, token, `/v2026/identities/${identityId}`);
  const sourceId = identity.attributes?.cloudAuthoritativeSource;
  if (!sourceId) return { error: "This identity has no authoritative source, so its lifecycle state can't be changed." };
  const profiles = await iscGet(tenant, token, "/v2026/identity-profiles", { limit: 250 });
  const profile = profiles.find((pr) => pr.authoritativeSource?.id === sourceId);
  if (!profile) return { error: "No identity profile is configured for this identity's authoritative source." };
  const lifecycleStates = await iscGet(tenant, token, `/v2026/identity-profiles/${profile.id}/lifecycle-states`, { limit: 250 });
  return { identity, profile, lifecycleStates: Array.isArray(lifecycleStates) ? lifecycleStates : [] };
}

/**
 * GET /api/identities/:id/lifecycle-states
 * Header: x-sp-session
 * The lifecycle states this identity can be moved to — its identity
 * profile's — with which one it's in now and what each does on entry:
 * { profile: { id, name }, current: <technicalName | null>,
 *   calculatedFrom: { sourceName, attributeName, transform } | null,
 *   states: [{ id, name, technicalName, description, enabled, identityState,
 *     accountActions: [{ action, sourceCount, allSources }], accessProfileCount,
 *     removesAllAccess, identityCount, emailsManager, emailsOthers }] }
 */
app.get("/api/identities/:id/lifecycle-states", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  try {
    const resolved = await resolveIdentityLifecycle(session.tenant, await sessionToken(session), req.params.id);
    if (resolved.error) return res.status(422).json({ error: resolved.error });
    const { identity, profile, lifecycleStates } = resolved;
    res.json({
      profile: { id: profile.id, name: profile.name },
      current: identity.attributes?.cloudLifecycleState || identity.lifecycleState?.stateName || null,
      // When the profile maps cloudLifecycleState through a transform, ISC
      // recalculates it on every identity refresh — a manual change holds
      // only until the next one, unless the source data agrees with it.
      calculatedFrom: (() => {
        const t = (profile.identityAttributeConfig?.attributeTransforms || []).find((x) => x.identityAttributeName === "cloudLifecycleState");
        if (!t) return null;
        const leaf = (d) => (d?.type === "accountAttribute" ? d.attributes : d?.attributes?.input ? leaf(d.attributes.input) : null);
        const src = leaf(t.transformDefinition);
        return { sourceName: src?.sourceName || null, attributeName: src?.attributeName || null, transform: t.transformDefinition?.type === "reference" ? t.transformDefinition.attributes?.id || null : null };
      })(),
      states: lifecycleStates
        .map((st) => ({
          id: st.id,
          name: st.name,
          technicalName: st.technicalName,
          description: st.description || "",
          enabled: st.enabled !== false,
          identityState: st.identityState || null,
          accountActions: (Array.isArray(st.accountActions) ? st.accountActions : []).map((a) => ({
            action: a.action,
            sourceCount: Array.isArray(a.sourceIds) ? a.sourceIds.length : 0,
            allSources: !!a.allSources,
          })),
          accessProfileCount: Array.isArray(st.accessProfileIds) ? st.accessProfileIds.length : 0,
          removesAllAccess: !!st.accessActionConfiguration?.removeAllAccessEnabled,
          identityCount: st.identityCount ?? null,
          emailsManager: !!st.emailNotificationOption?.notifyManagers,
          emailsOthers: !!(st.emailNotificationOption?.notifyAllAdmins || st.emailNotificationOption?.notifySpecificUsers),
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    });
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[identities] lifecycle-states failed:", err.response?.data || err.message);
    res.status(status).json({ error: err.response?.data?.messages?.[0]?.text || describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/**
 * POST /api/identities/:id/lifecycle-state
 * Header: x-sp-session
 * Body: { state: "enable" | "disable" }  — or —  { lifecycleStateId }
 *
 * Disabling/enabling an identity in ISC isn't a direct "disable identity"
 * call — it's done by moving the identity to whichever of its identity
 * profile's lifecycle states carries ACTIVE (enable) or an INACTIVE_*
 * identityState (disable), which is what actually cascades account
 * enable/disable actions to the sources configured on that state.
 * lifecycleStateId moves it to one specific state instead — it must be one of
 * the identity's own profile's states (an id from another profile is refused
 * here rather than passed to ISC), and an enabled one.
 */
app.post("/api/identities/:id/lifecycle-state", async (req, res) => {
  const session = await getSession(req);
  const { state, lifecycleStateId } = req.body || {};

  if (!session) return unauthorized(res);
  const { tenant } = session;
  if (!lifecycleStateId && state !== "enable" && state !== "disable") {
    return res.status(400).json({ error: 'state must be "enable" or "disable" (or pass lifecycleStateId).' });
  }

  try {
    const token = await sessionToken(session);
    const resolved = await resolveIdentityLifecycle(tenant, token, req.params.id);
    if (resolved.error) return res.status(422).json({ error: resolved.error });
    const { profile, lifecycleStates } = resolved;

    let target;
    if (lifecycleStateId) {
      target = lifecycleStates.find((s) => s.id === lifecycleStateId);
      if (!target) return res.status(422).json({ error: `That lifecycle state doesn't belong to this identity's profile ("${profile.name}").` });
      if (target.enabled === false) return res.status(422).json({ error: `"${target.name}" is disabled on the "${profile.name}" profile, so identities can't be moved to it.` });
    } else {
      target = state === "enable"
        ? lifecycleStates.find((s) => s.identityState === "ACTIVE")
        : lifecycleStates.find((s) => s.technicalName === "inactive") ||
          lifecycleStates.find((s) => (s.identityState || "").startsWith("INACTIVE"));
      if (!target) {
        return res.status(422).json({
          error: `This identity's profile ("${profile.name}") has no ${state === "enable" ? "active" : "inactive"} lifecycle state configured.`,
        });
      }
    }

    const resp = await axios.post(
      `https://${tenantApiHost(tenant)}/v2026/identities/${req.params.id}/set-lifecycle-state`,
      { lifecycleStateId: target.id },
      { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }
    );
    console.log(`[identities] ${tenant} moved ${req.params.id} to lifecycle state "${target.technicalName}" (by ${session.username})`);

    res.json({ accountActivityId: resp.data.accountActivityId, lifecycleState: target.technicalName, lifecycleStateName: target.name });
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[identities] set-lifecycle-state failed:", err.response?.data || err.message);
    res.status(status).json({ error: err.response?.data?.messages?.[0]?.text || err.response?.data?.detailCode || err.message });
  }
});

/**
 * GET /api/identities/:id/entitlements
 * Not routed through the generic /api/isc/* proxy: the underlying ISC
 * endpoint (/v2026/entitlements/identities/:id/entitlements) returns each
 * entitlement's raw attribute value as "name" for many sources — verified
 * live against this tenant's Active Directory and Salesforce entitlements
 * (an AD group's GUID, a Salesforce ProfileId) rather than the actual
 * human-readable name. This fetches the same list, then resolves the real
 * name and source for each id via resolveEntitlementDisplayInfo (same
 * lookup the role scan report uses) before returning it.
 */
app.get("/api/identities/:id/entitlements", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  const limit = Number(req.query.limit) || 50;

  try {
    const token = await sessionToken(session);
    const entitlements = await iscGet(tenant, token, `/v2026/entitlements/identities/${req.params.id}/entitlements`, { limit });
    const infoById = await resolveEntitlementDisplayInfo(tenant, token, entitlements.map((e) => e.id));
    res.json(entitlements.map((e) => {
      const info = infoById.get(e.id);
      return { ...e, name: info?.name || e.name, source: info?.source || null };
    }));
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[identities] entitlements fetch failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/**
 * PATCH /api/roles/:id/enabled
 * Body: { enabled: boolean }
 * Toggles a role's enabled status. Not routed through the generic
 * /api/isc/* proxy below: SailPoint requires the JSON Patch content type
 * (application/json-patch+json) for this PATCH — verified live that the
 * same call with a plain application/json body is rejected with 415
 * Unsupported Media Type, which is what the generic proxy always sends.
 */
app.patch("/api/roles/:id/enabled", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  const { enabled } = req.body || {};
  if (typeof enabled !== "boolean") {
    return res.status(400).json({ error: "enabled must be a boolean." });
  }

  try {
    const token = await sessionToken(session);
    const resp = await axios.patch(
      `https://${tenantApiHost(tenant)}/v2026/roles/${req.params.id}`,
      [{ op: "replace", path: "/enabled", value: enabled }],
      { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json-patch+json" } }
    );
    // Activating (not just creating) a Common Access role is also a
    // trigger point — a Skeleton scan's Common Access role, for one, is
    // always created disabled, so its analysis never ran at create time.
    // Tracked-role check is a cheap local lookup, not a live ISC call, so
    // this doesn't slow down every unrelated role's enable/disable.
    if (enabled && ((await flaggedCommonAccessRoles.get(tenant)) || []).includes(req.params.id)) {
      try {
        await triggerCommonAccessAnalysis(tenant, token);
      } catch (err) {
        console.error(`[roles] common-access analysis trigger failed after enabling role ${req.params.id}:`, err.response?.data || err.message);
      }
    }
    res.json(resp.data);
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[roles] enabled toggle failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/**
 * GET /api/roles/:id
 * Dedicated (not the generic /api/isc/* proxy) so a transient 429/5xx is
 * retried with backoff instead of failing outright — backs both Role
 * Detail's own page load and the Roles list's bulk "Detail Report" print
 * (which fetches every listed role's full detail back-to-back), the
 * latter being exactly the kind of burst that reliably trips ISC's rate
 * limiting on a tenant with more than a handful of roles. Verified live:
 * user-reported 429 printing Role Details traced to this exact
 * unretried generic-proxy call.
 */
app.get("/api/roles/:id", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  try {
    const token = await sessionToken(session);
    const role = await withApiRetry(
      () => iscGet(tenant, token, `/v2026/roles/${req.params.id}`),
      { label: `get role ${req.params.id}` }
    );
    res.json(role);
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error(`[roles] get ${req.params.id} failed:`, err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/**
 * GET /api/entitlements/by-ids?ids=id1,id2,...
 * Dedicated (not the generic /api/isc/* proxy) so a transient 429/5xx is
 * retried instead of failing outright — backs Role Detail's and Identity
 * Detail's own entitlement-name/source lookups, and the Roles list's bulk
 * Detail Report print (same 429 traced live for GET /api/roles/:id above
 * also hits this call, fetched right alongside it for the same report).
 */
app.get("/api/entitlements/by-ids", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  const ids = typeof req.query.ids === "string" ? req.query.ids.split(",").filter(Boolean) : [];
  if (ids.length === 0) return res.json([]);
  try {
    const token = await sessionToken(session);
    const filters = `id in (${ids.map((id) => `"${id}"`).join(",")})`;
    const results = await withApiRetry(
      () => iscGet(tenant, token, "/v2026/entitlements", { filters, limit: ids.length }),
      { label: "entitlements by-ids" }
    );
    res.json(results);
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[entitlements] by-ids failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/**
 * PATCH /api/entitlements/:id
 * Body: any of { name, description, owner: {id,name}, requestable } — same
 * JSON Patch approach as PATCH /api/roles/:id and PATCH
 * /api/access-profiles/:id (SailPoint requires the JSON Patch content type
 * for this — see the comment on PATCH /api/roles/:id/enabled — so this
 * isn't routed through the generic /api/isc/* proxy, which always sends
 * plain application/json). Backs the Entitlement Detail edit modal and the
 * Entitlements list's bulk Generate Descriptions (saves the accepted
 * suggestion), Change Owner, and Make Requestable/No Requests actions.
 * name/description/owner have been exercised live against a real tenant;
 * requestable follows the same op shape access profiles' own requestable
 * toggle uses but hasn't specifically been confirmed live yet. Renaming
 * makes sense for entitlements whose native `name` is really just a raw
 * synced attribute value from the source (an AD group's GUID, a Salesforce
 * ProfileId — see the comment on GET /api/identities/:id/entitlements) —
 * this gives an admin a human-readable override for those.
 */
/**
 * GET /api/entitlements/:id/account-members
 * Fallback "who holds this" for entitlements the search index doesn't show
 * yet — fresh delimited-source grants only reach @access() after
 * aggregation + identity refresh + search indexing all land. Reads the
 * source's own accounts and matches the entitlement's attribute/value
 * directly, so the Members tab reflects account data immediately.
 * Uncorrelated accounts (no identity) are counted but not listed — there's
 * no identity screen to open for them.
 */
app.get("/api/entitlements/:id/account-members", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  try {
    const token = await sessionToken(session);
    const ent = await iscGet(tenant, token, `/v2026/entitlements/${req.params.id}`);
    const sourceId = ent.source?.id;
    if (!sourceId || !ent.attribute) return res.json({ members: [], total: 0, uncorrelated: 0 });
    const value = String(ent.value ?? "");
    const members = new Map();
    let uncorrelated = 0;
    for (let offset = 0; offset < 2000; offset += 250) {
      const page = await withApiRetry(
        () => iscGet(tenant, token, "/v2025/accounts", { filters: `sourceId eq "${sourceId}"`, limit: 250, offset }),
        { label: "entitlements: account-members page" }
      );
      for (const acct of page) {
        const v = acct.attributes?.[ent.attribute];
        const has = Array.isArray(v)
          ? v.map(String).includes(value)
          : typeof v === "string"
          ? v === value || v.split(",").map((x) => x.trim()).includes(value)
          : v != null && String(v) === value;
        if (!has) continue;
        if (!acct.identityId) { uncorrelated += 1; continue; }
        if (!members.has(acct.identityId)) {
          members.set(acct.identityId, { id: acct.identityId, name: acct.name, displayName: acct.name, attributes: {} });
        }
      }
      if (page.length < 250) break;
    }
    const list = [...members.values()].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    res.json({ members: list, total: list.length, uncorrelated });
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[entitlements] account-members failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/**
 * POST /api/entitlements/:id/metadata
 * Body: { key, value, name? } — assigns one Access Model Metadata value to
 * this entitlement, registering the value on the attribute first when a
 * display `name` is supplied and the value doesn't exist yet (ad-hoc
 * values). Same per-item mechanism (v2026->beta root probe, already-tagged
 * counts as success) as the Segments by Metadata tagging.
 */
app.post("/api/entitlements/:id/metadata", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  const { key, value, name } = req.body || {};
  if (!key || !value) return res.status(400).json({ error: "key and value are required." });
  try {
    const token = await sessionToken(session);
    if (name) await ensureBoundaryMetadataValue(tenant, token, key, { value, name });
    await tagAccessWithBoundaryValue(tenant, token, { key, entitlementIds: [req.params.id], roleIds: [], value });
    res.json({ ok: true });
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[entitlements] add metadata failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/**
 * POST /api/entitlements/metadata/bulk
 * Body: { key, value, name?, entitlementIds: [] } — tags every listed
 * entitlement with one metadata value in a single pass (same per-item
 * mechanism + concurrency as the Segments by Metadata task; already-tagged
 * items count as success). Registers the value first when `name` is given.
 */
app.post("/api/entitlements/metadata/bulk", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  const { key, value, name, entitlementIds } = req.body || {};
  if (!key || !value) return res.status(400).json({ error: "key and value are required." });
  if (!Array.isArray(entitlementIds) || entitlementIds.length === 0) {
    return res.status(400).json({ error: "entitlementIds must be a non-empty array." });
  }
  try {
    const token = await sessionToken(session);
    if (name) await ensureBoundaryMetadataValue(tenant, token, key, { value, name });
    await tagAccessWithBoundaryValue(tenant, token, { key, entitlementIds, roleIds: [], value });
    res.json({ ok: true, tagged: entitlementIds.length });
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[entitlements] bulk metadata tag failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

// ── Metadata on roles and access profiles (their Metadata tab's + and ×) ─────
// Same per-item mechanism as entitlements: POST / DELETE
// /{kind}/{id}/access-model-metadata/{key}/values/{value}, probing /v2026
// then /beta because which root serves these routes varies by tenant (see
// tagAccessWithBoundaryValue). Roles have had the route since v2025; access
// profiles only gained it in v2026 and have no /beta equivalent — so on a
// tenant whose /v2026 doesn't serve it yet, access profiles can't be tagged
// at all, and the error says that rather than a bare 404.
const METADATA_TAGGABLE_KINDS = { roles: "role", "access-profiles": "access profile", entitlements: "entitlement" };
// Which API root answered for a tenant + kind, so a bulk run of hundreds of
// items probes once instead of paying a 404 round-trip per item.
const itemMetadataRoot = new Map();

// What this role / access profile / entitlement carries for `key` right now,
// read from the object itself: { has: <carries this exact value>, others:
// [display names of other values it holds], multiselect }. null when it can't
// be determined.
async function objectMetadataState(tenant, token, kind, id, key, value) {
  try {
    const obj = await iscGet(tenant, token, `/v2026/${kind}/${id}`);
    const attr = (obj?.accessModelMetadata?.attributes || []).find((a) => a.key === key);
    const values = attr?.values || [];
    return {
      has: values.some((v) => v.value === value),
      others: values.filter((v) => v.value !== value).map((v) => v.name || v.value),
      multiselect: attr?.multiselect !== false,
      attributeName: attr?.name || key,
    };
  } catch {
    return null;
  }
}

// Resolves "already" when an add found the value already in place.
async function callItemMetadata(tenant, token, method, kind, id, key, value) {
  const pair = `${encodeURIComponent(key)}/values/${encodeURIComponent(value)}`;
  const rootKey = `${tenant}:${kind}`;
  let lastErr;
  for (const root of itemMetadataRoot.has(rootKey) ? [itemMetadataRoot.get(rootKey)] : ["v2026", "beta"]) {
    try {
      await withApiRetry(
        () => axios({
          method,
          url: `https://${tenantApiHost(tenant)}/${root}/${kind}/${id}/access-model-metadata/${pair}`,
          ...(method === "post" ? { data: {} } : {}),
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        }),
        { label: `${method} ${kind} ${id} metadata ${key} (${root})` }
      );
      itemMetadataRoot.set(rootKey, root);
      return;
    } catch (err) {
      // Already carrying the value is the state an add exists to produce —
      // not a failure. ISC words that rejection differently per object type
      // ("should be unique" for entitlements; roles say something else), so
      // the wording isn't trusted: on any 400 the object itself is read, and
      // if it has the value the add is done. Reading the object (not Search)
      // also means a tag applied seconds ago counts, index lag or not.
      if (method === "post" && err.response?.status === 400) {
        const state = await objectMetadataState(tenant, token, kind, id, key, value);
        if (state?.has) {
          itemMetadataRoot.set(rootKey, root);
          return "already";
        }
        // The other common rejection: a SINGLE-valued attribute (e.g.
        // Environment) that already holds a different value. Not something to
        // paper over by replacing it — say what's there and let the user choose.
        if (state && !state.multiselect && state.others.length) {
          itemMetadataRoot.set(rootKey, root);
          const e = new Error(`"${state.attributeName}" holds one value and this ${METADATA_TAGGABLE_KINDS[kind]} already has "${state.others[0]}". Remove that value first, then add the new one.`);
          e.status = 409;
          throw e;
        }
      }
      lastErr = err;
      if (err.response?.status !== 404 && err.response?.status !== 405) break;
    }
  }
  // Once a root is known to serve the route, a 404 is about THIS item.
  if ([404, 405].includes(lastErr.response?.status) && !itemMetadataRoot.has(rootKey)) {
    const e = new Error(`ISC on this tenant doesn't serve the metadata route for ${METADATA_TAGGABLE_KINDS[kind]}s yet (tried /v2026 and /beta), so its metadata can't be changed from here.`);
    e.status = 501;
    throw e;
  }
  throw lastErr;
}

const METADATA_BULK_MAX = 2000;
const METADATA_KIND_INDEX = { roles: "roles", "access-profiles": "accessprofiles", entitlements: "entitlements" };

/**
 * POST /api/:kind(roles|access-profiles|entitlements)/metadata/bulk-tag
 * Body: { operation: "add" | "remove", key, value, name?, ids: [] }
 * Adds one metadata value to — or removes it from — every listed object.
 * Both operations first ask ISC Search which of the ids already carry the
 * value, and only act on the ones that need it — the rest are `skipped`,
 * never failed (a mixed selection is the normal case, and ISC rejects both
 * adding a value an object has and removing one it doesn't):
 *  - add: registers the value on the attribute first (ad-hoc values come with
 *    a display `name`), skips objects that already have it, and — for one
 *    Search hadn't indexed yet — confirms against the object itself.
 *  - remove: only untags the objects that carry it — and because Search's
 *    index lags a tagging by minutes, any object Search doesn't vouch for is
 *    checked against the object itself before being skipped.
 * A few at a time, and one failure doesn't stop the rest.
 * Returns { operation, done, skipped, failed: [{ id, error }] }.
 */
app.post("/api/:kind(roles|access-profiles|entitlements)/metadata/bulk-tag", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  const { kind } = req.params;
  const { operation, key, value, name } = req.body || {};
  const ids = [...new Set(Array.isArray(req.body?.ids) ? req.body.ids.filter((x) => typeof x === "string" && x) : [])];
  if (operation !== "add" && operation !== "remove") return res.status(400).json({ error: 'operation must be "add" or "remove".' });
  if (!key || !value) return res.status(400).json({ error: "key and value are required." });
  if (ids.length === 0) return res.status(400).json({ error: "ids must be a non-empty array." });
  if (ids.length > METADATA_BULK_MAX) return res.status(400).json({ error: `That's ${ids.length.toLocaleString()} objects — the limit is ${METADATA_BULK_MAX.toLocaleString()} at a time.` });
  try {
    const token = await sessionToken(session);
    if (!isSafeMetadataKey(key)) return res.status(400).json({ error: "That metadata key can't be searched." });
    if (operation === "add") await ensureBoundaryMetadataValue(tenant, token, key, { value, name: name || value });

    // Which of the selection already carries the value — asked up front for
    // BOTH operations, so nothing is sent that ISC would reject: an add skips
    // the ones that have it, a remove skips the ones that don't. Search can
    // lag a very recent change; callItemMetadata's read-the-object check
    // covers an add that slips through.
    const carrying = new Set();
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const { items } = await iscSearchPage(tenant, token, {
        indices: [METADATA_KIND_INDEX[kind]],
        query: { query: `${metadataValueQuery(key, value)} AND id:(${chunk.join(" OR ")})` },
        queryResultFilter: { includes: ["id"] },
      }, { limit: 250 });
      for (const d of items) carrying.add(d.id);
    }
    // Search is only believed when it says YES. Its index runs minutes
    // behind a tagging, so "not carrying" may just mean "not indexed yet" —
    // which for a remove would wrongly skip an object that does have the
    // value (tag 38 roles, remove straight away: Search knew none of them).
    // So for a remove, everything Search didn't vouch for is checked against
    // the object itself. (An add doesn't need this pass: a wrongly-attempted
    // add is caught by callItemMetadata reading the object on rejection.)
    if (operation === "remove") {
      const unsure = ids.filter((id) => !carrying.has(id));
      const checkQueue = [...unsure];
      await Promise.all(Array.from({ length: Math.min(6, checkQueue.length) }, async () => {
        while (checkQueue.length) {
          const id = checkQueue.shift();
          const state = await withApiRetry(() => objectMetadataState(tenant, token, kind, id, key, value), { label: `read ${kind} ${id} metadata` });
          // Couldn't be read → attempt the remove rather than silently skip it.
          if (!state || state.has) carrying.add(id);
        }
      }));
      if (unsure.length) console.log(`[metadata] remove ${key}=${value} on ${kind}: Search vouched for ${ids.length - unsure.length} of ${ids.length}; read ${unsure.length} object(s) directly → ${carrying.size} carry it`);
    }
    const targets = ids.filter((id) => (operation === "add" ? !carrying.has(id) : carrying.has(id)));
    let skipped = ids.length - targets.length;

    const failed = [];
    let done = 0;
    let routeMissing = null;
    const queue = [...targets];
    // The first one alone, so the API-root probe settles before fanning out.
    const runOne = async (id) => {
      try {
        const outcome = await callItemMetadata(tenant, token, operation === "add" ? "post" : "delete", kind, id, key, value);
        if (outcome === "already") skipped++;
        else done++;
      } catch (err) {
        if (err.status === 501) routeMissing = err.message;
        const error = err.status ? err.message : err.response?.data?.messages?.[0]?.text || describeError(err);
        // The reason, not just a count — a failure nobody can read can't be fixed.
        console.warn(`[metadata] ${operation} ${key}=${value} on ${kind} ${id} failed: ${err.response?.status || ""} ${JSON.stringify(err.response?.data || err.message).slice(0, 400)}`);
        failed.push({ id, error });
      }
    };
    if (queue.length) await runOne(queue.shift());
    // No point repeating a "this tenant doesn't serve the route" for every item.
    if (routeMissing) return res.status(501).json({ error: routeMissing });
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
      while (queue.length) await runOne(queue.shift());
    }));
    console.log(`[metadata] ${tenant} bulk ${operation} ${key}=${value} on ${kind}: ${done} done, ${skipped} skipped, ${failed.length} failed (by ${session.username})`);
    res.json({ operation, done, skipped, failed });
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error(`[${kind}] bulk metadata ${operation} failed:`, err.response?.data || err.message);
    res.status(status).json({ error: err.response?.data?.messages?.[0]?.text || describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/**
 * POST /api/:kind(roles|access-profiles)/:id/metadata
 * Body: { key, value, name? } — assigns one metadata value, registering it on
 * the attribute first when a display `name` is given (ad-hoc values).
 */
app.post("/api/:kind(roles|access-profiles)/:id/metadata", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  const { key, value, name } = req.body || {};
  if (!key || !value) return res.status(400).json({ error: "key and value are required." });
  try {
    const token = await sessionToken(session);
    // The value must exist on the attribute before anything is tagged with it.
    await ensureBoundaryMetadataValue(tenant, token, key, { value, name: name || value });
    const outcome = await callItemMetadata(tenant, token, "post", req.params.kind, req.params.id, key, value);
    res.json({ ok: true, already: outcome === "already" });
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.status || err.response?.status || 500;
    console.error(`[${req.params.kind}] add metadata failed:`, err.response?.data || err.message);
    res.status(status).json({ error: err.status ? err.message : describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/** DELETE /api/:kind(roles|access-profiles)/:id/metadata/:key/:value — removes one assigned value. */
app.delete("/api/:kind(roles|access-profiles)/:id/metadata/:key/:value", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  try {
    await callItemMetadata(session.tenant, await sessionToken(session), "delete", req.params.kind, req.params.id, req.params.key, req.params.value);
    res.json({ ok: true });
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.status || err.response?.status || 500;
    console.error(`[${req.params.kind}] remove metadata failed:`, err.response?.data || err.message);
    res.status(status).json({ error: err.status ? err.message : describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/**
 * DELETE /api/entitlements/:id/metadata/:key/:value — removes one assigned
 * metadata value from this entitlement. Same v2026->beta root probe as
 * assignment (the per-item metadata routes 404 at /v2026 on this tenant).
 */
app.delete("/api/entitlements/:id/metadata/:key/:value", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  const pair = `${encodeURIComponent(req.params.key)}/values/${encodeURIComponent(req.params.value)}`;
  try {
    const token = await sessionToken(session);
    let lastErr;
    for (const root of ["v2026", "beta"]) {
      try {
        await axios.delete(
          `https://${tenantApiHost(tenant)}/${root}/entitlements/${req.params.id}/access-model-metadata/${pair}`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        return res.json({ ok: true });
      } catch (err) {
        lastErr = err;
        if (err.response?.status !== 404 && err.response?.status !== 405) break;
      }
    }
    throw lastErr;
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[entitlements] remove metadata failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

app.patch("/api/entitlements/:id", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  const { name, description, owner, requestable, privilegeLevel } = req.body || {};

  const ops = [];
  if (name !== undefined) {
    if (!name || !name.trim()) return res.status(400).json({ error: "name can't be empty." });
    ops.push({ op: "replace", path: "/name", value: name });
  }
  if (description !== undefined) {
    ops.push({ op: "replace", path: "/description", value: description });
  }
  if (owner !== undefined) {
    if (!owner?.id) return res.status(400).json({ error: "owner must have an id." });
    ops.push({ op: "replace", path: "/owner", value: { type: "IDENTITY", id: owner.id, name: owner.name } });
  }
  if (requestable !== undefined) {
    ops.push({ op: "replace", path: "/requestable", value: !!requestable });
  }
  // Privilege level is set as an override (ISC's patchable
  // privilegeOverride/level) — it becomes privilegeLevel.direct with
  // setByType OVERRIDE, and the effective level follows it. NONE is a real
  // level ("no privilege"), not "clear the override". "add" rather than
  // "replace" so it works whether or not an override already exists.
  if (privilegeLevel !== undefined) {
    const level = String(privilegeLevel || "").toUpperCase();
    if (!["HIGH", "MEDIUM", "LOW", "NONE"].includes(level)) {
      return res.status(400).json({ error: "privilegeLevel must be HIGH, MEDIUM, LOW, or NONE." });
    }
    ops.push({ op: "add", path: "/privilegeOverride/level", value: level });
  }
  if (ops.length === 0) {
    return res.status(400).json({ error: "Provide at least one field to update." });
  }

  try {
    const token = await sessionToken(session);
    const url = `https://${tenantApiHost(tenant)}/v2026/entitlements/${req.params.id}`;
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json-patch+json" };
    console.log(`[entitlements] patch ${req.params.id}:`, JSON.stringify(ops));
    // ISC documents privilege as patchable at privilegeOverride/level but is
    // vague about the operation, so a rejected first form is retried with
    // the alternatives before giving up. Every other field goes as-is.
    const privilegeOp = ops.find((o) => o.path === "/privilegeOverride/level");
    const otherOps = ops.filter((o) => o !== privilegeOp);
    if (otherOps.length) await axios.patch(url, otherOps, { headers });
    if (privilegeOp) {
      const attempts = [
        [{ op: "replace", path: "/privilegeOverride/level", value: privilegeOp.value }],
        [{ op: "add", path: "/privilegeOverride/level", value: privilegeOp.value }],
        [{ op: "add", path: "/privilegeOverride", value: { level: privilegeOp.value } }],
        [{ op: "replace", path: "/privilegeLevel/direct", value: privilegeOp.value }],
      ];
      let lastErr = null;
      let applied = false;
      for (const attempt of attempts) {
        try {
          const accepted = (await axios.patch(url, attempt, { headers })).data;
          console.log(`[entitlements] privilege patch accepted: ${JSON.stringify(attempt)} -> privilegeLevel=${JSON.stringify(accepted?.privilegeLevel)}`);
          applied = true;
          break;
        } catch (err) {
          lastErr = err;
          const status = err.response?.status;
          console.warn(`[entitlements] privilege patch ${JSON.stringify(attempt)} -> ${status}: ${JSON.stringify(err.response?.data || err.message).slice(0, 300)}`);
          if (status !== 400 && status !== 404 && status !== 422) break;
        }
      }
      if (!applied) throw lastErr;
    }
    // Confirm what ISC now reports rather than trusting the patch response:
    // ISC answers 200 and then silently keeps the old values for an
    // entitlement whose source is read-only (verified live), and the
    // effective privilege level can lag its override. Every requested field
    // ISC didn't keep is named in `unapplied` so the client can say so.
    const fresh = await iscGet(tenant, await sessionToken(session), `/v2026/entitlements/${req.params.id}`);
    const unapplied = [];
    if (name !== undefined && (fresh?.name || "") !== name) unapplied.push("name");
    if (description !== undefined && (fresh?.description || "") !== (description || "")) unapplied.push("description");
    if (owner !== undefined && fresh?.owner?.id !== owner.id) unapplied.push("owner");
    if (requestable !== undefined && !!fresh?.requestable !== !!requestable) unapplied.push("requestable");
    if (privilegeOp) {
      const now = String(fresh?.privilegeLevel?.direct || fresh?.privilegeLevel?.effective || "").toUpperCase();
      console.log(`[entitlements] privilege after patch: ${JSON.stringify(fresh?.privilegeLevel)}`);
      if (now !== privilegeOp.value) unapplied.push("privilege level");
    }
    if (unapplied.length) console.warn(`[entitlements] patch ${req.params.id}: ISC accepted but did not keep: ${unapplied.join(", ")} (read-only source?)`);
    res.json({ ...fresh, unapplied });
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[entitlements] edit failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

// Shared by the single-entitlement generate-description route and its bulk
// generate-all counterpart — fetches one entitlement's data and asks
// Claude for a description grounded in it, without writing anything back.
// Same shape as generateRoleDescriptionText/generateAccessProfileDescriptionText
// above. Throws on failure; callers decide how to surface that.
async function generateEntitlementDescriptionText(tenant, token, entitlementId) {
  const entitlement = await withApiRetry(
    () => iscGet(tenant, token, `/v2026/entitlements/${entitlementId}`),
    { label: `generate-description: fetch entitlement ${entitlementId}` }
  );

  const facts = [
    `Entitlement name: ${entitlement.name || entitlement.value}`,
    `Source: ${entitlement.source?.name || "unknown"}`,
    `Source attribute: ${entitlement.attribute || "unknown"}`,
    `Raw value: ${entitlement.value || "unknown"}`,
    `Privilege level: ${entitlement.privilegeLevel?.effective || "unspecified"}`,
  ];
  return generateDescriptionFromFacts(facts, "This Entitlement");
}

/**
 * POST /api/entitlements/:id/generate-description
 * Header: x-sp-session
 * Same idea as POST /api/roles/:id/generate-description: asks Claude for a
 * description grounded in the entitlement's actual current data, never
 * writes anything itself — the client shows the suggestion and applies it
 * via PATCH /api/entitlements/:id above once confirmed.
 */
app.post("/api/entitlements/:id/generate-description", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;

  if (!aiConfigured()) {
    return res.status(503).json({ error: "AI description generation isn't configured on this server." });
  }

  try {
    const token = await sessionToken(session);
    const description = await generateEntitlementDescriptionText(tenant, token, req.params.id);
    res.json({ description });
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[entitlements] generate-description failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/**
 * POST /api/insights/entitlement-descriptions/generate-all
 * Header: x-sp-session
 * Body: { entitlementIds: string[] }
 * Same shape as POST /api/insights/role-descriptions/generate-all — bounded
 * concurrency, continues past individual failures, returns suggestions only
 * (each keyed `roleId` so the same BulkDescriptionReviewSheet used by Roles
 * and Access Profiles can render these unchanged). The Entitlements list
 * reviews every suggestion before saving any of them.
 */
app.post("/api/insights/entitlement-descriptions/generate-all", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  const entitlementIds = req.body?.entitlementIds;
  if (!Array.isArray(entitlementIds) || entitlementIds.length === 0) {
    return res.status(400).json({ error: "entitlementIds must be a non-empty array." });
  }
  if (!aiConfigured()) {
    return res.status(503).json({ error: "AI description generation isn't configured on this server." });
  }

  try {
    const token = await sessionToken(session);
    const results = await mapWithConcurrency(entitlementIds, 3, async (entitlementId) => {
      try {
        const description = await generateEntitlementDescriptionText(tenant, token, entitlementId);
        return { roleId: entitlementId, description };
      } catch (err) {
        console.error(`[insights] entitlement-descriptions generate-all: entitlement ${entitlementId} failed:`, err.response?.data || err.message);
        return { roleId: entitlementId, error: describeError(err) };
      }
    });
    res.json({ results });
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[insights] entitlement-descriptions generate-all failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/**
 * GET /api/entitlements/:id/applications — the Applications (source-apps)
 * reachable from this entitlement.
 *
 * Entitlements have no direct app link in ISC's model — an Application only
 * grants access through the Access Profiles assigned to it (see
 * GET /api/source-apps/:id/access-profiles) — so this joins: access
 * profiles that contain the entitlement (Search API, same entitlements.id
 * query listAccessProfilesByEntitlement uses client-side) against the
 * access profiles assigned to each Application on the entitlement's own
 * source. An app appears once per matching access profile it's tied to,
 * tagged with which one(s) — same "via" shape GET /api/segments/:id/access
 * uses for its own derived entitlements.
 */
app.get("/api/entitlements/:id/applications", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  const entitlementId = req.params.id;
  try {
    const token = await sessionToken(session);
    const entitlement = await withApiRetry(
      () => iscGet(tenant, token, `/v2026/entitlements/${entitlementId}`),
      { label: "entitlement applications: get entitlement" }
    );
    const sourceId = entitlement?.source?.id;
    if (!sourceId) return res.json([]);

    const [profileHits, apps] = await Promise.all([
      withApiRetry(
        () =>
          axios
            .post(
              `https://${tenantApiHost(tenant)}/v2026/search`,
              { indices: ["accessprofiles"], query: { query: `entitlements.id:"${entitlementId}"` }, sort: ["name"] },
              { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, params: { limit: 250 } }
            )
            .then((r) => r.data || []),
        { label: "entitlement applications: access profiles containing entitlement" }
      ),
      withApiRetry(
        () =>
          axios
            .get(`https://${tenantApiHost(tenant)}/${SOURCE_APPS_V1}/all`, {
              params: { filters: `accountSource.id eq "${sourceId}"` },
              headers: { Authorization: `Bearer ${token}`, ...SOURCE_APPS_HEADERS },
            })
            .then((r) => r.data || []),
        { label: "entitlement applications: apps for source" }
      ),
    ]);
    const profileIds = new Set(profileHits.map((p) => p.id));
    if (profileIds.size === 0 || apps.length === 0) return res.json([]);

    const appsWithMatches = await mapWithConcurrency(apps, 4, async (app) => {
      const profiles = await withApiRetry(
        () =>
          axios
            .get(`https://${tenantApiHost(tenant)}/${SOURCE_APPS_V1}/${app.id}/access-profiles`, {
              headers: { Authorization: `Bearer ${token}`, ...SOURCE_APPS_HEADERS },
            })
            .then((r) => r.data || []),
        { label: `entitlement applications: access profiles for app ${app.id}` }
      );
      return { app, matched: profiles.filter((p) => profileIds.has(p.id)) };
    });

    const result = appsWithMatches
      .filter(({ matched }) => matched.length > 0)
      .map(({ app, matched }) => ({
        id: app.id,
        name: app.name,
        description: app.description,
        via: matched.map((p) => p.name),
      }))
      .sort((a, b) => (a.name || "").localeCompare(b.name || ""));

    res.json(result);
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[entitlements] applications failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/**
 * GET /api/roles/by-ids?ids=id1,id2,...
 * Same pattern as GET /api/entitlements/by-ids — bulk fetch via an
 * `id in (...)` filter (verified live) rather than one request per role,
 * for Segment Detail's Roles tab (resolving a segment's ROLE scope
 * selection, which only carries bare ids, to real role records).
 */
app.get("/api/roles/by-ids", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  const ids = typeof req.query.ids === "string" ? req.query.ids.split(",").filter(Boolean) : [];
  if (ids.length === 0) return res.json([]);
  try {
    const token = await sessionToken(session);
    const filters = `id in (${ids.map((id) => `"${id}"`).join(",")})`;
    const results = await withApiRetry(
      () => iscGet(tenant, token, "/v2026/roles", { filters, limit: ids.length }),
      { label: "roles by-ids" }
    );
    res.json(results);
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[roles] by-ids failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/**
 * DELETE /api/roles/:id
 * Dedicated (not the generic /api/isc/* proxy, which this used to go
 * through) so a transient 429/5xx from ISC is retried with backoff
 * (honoring Retry-After) instead of failing outright — verified live:
 * deleting a role bulk-selected from RolesPage (and RoleDetailPage's own
 * single delete) treated any 429 as a hard per-role failure with no
 * retry, which real ISC rate limiting on a large selection reliably hit.
 * Same forgetFlaggedCommonAccessRole bookkeeping the generic proxy's own
 * DELETE handling did — a deleted role that was tracked as flagged Common
 * Access needs to drop out of that persisted list too.
 */
app.delete("/api/roles/:id", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;

  try {
    const token = await sessionToken(session);
    await withApiRetry(
      () => axios.delete(`https://${tenantApiHost(tenant)}/v2026/roles/${req.params.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
      { label: `delete role ${req.params.id}` }
    );
    await forgetFlaggedCommonAccessRole(tenant, req.params.id);
    res.status(204).end();
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[roles] delete failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

// additionalOwners on roles and access profiles: several IDENTITY entries,
// or exactly one GOVERNANCE_GROUP — never mixed. Returns an error message,
// or null when valid.
function additionalOwnersError(additionalOwners) {
  if (!Array.isArray(additionalOwners)) return "additionalOwners must be an array.";
  if (additionalOwners.some((o) => !o?.id || !["IDENTITY", "GOVERNANCE_GROUP"].includes(o.type))) {
    return "Each additional owner needs an id and a type of IDENTITY or GOVERNANCE_GROUP.";
  }
  const groups = additionalOwners.filter((o) => o.type === "GOVERNANCE_GROUP");
  if (groups.length > 0 && additionalOwners.length > 1) {
    return "additionalOwners can be several users, or a single governance group, not both.";
  }
  return null;
}

/**
 * PATCH /api/roles/:id
 * Body: any of { name, description, owner: {id,name}, additionalOwners:
 * [{type,id,name}], dimensional: boolean } — only the fields present are
 * changed, combined into one JSON Patch call. additionalOwners is either
 * every entry IDENTITY, or exactly one GOVERNANCE_GROUP — mirrors what's
 * actually seen on real roles in this tenant (a role's additional owners
 * are either a handful of people or a single approver group, never mixed),
 * enforced here since the UI enforces it as a radio choice but a raw API
 * caller wouldn't have that guardrail.
 */
app.patch("/api/roles/:id", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  const { name, description, owner, additionalOwners, dimensional, requestable } = req.body || {};

  const ops = [];
  if (name !== undefined) {
    if (!name || !name.trim()) return res.status(400).json({ error: "name can't be empty." });
    ops.push({ op: "replace", path: "/name", value: name });
  }
  if (description !== undefined) {
    ops.push({ op: "replace", path: "/description", value: description });
  }
  if (owner !== undefined) {
    if (!owner?.id) return res.status(400).json({ error: "owner must have an id." });
    ops.push({ op: "replace", path: "/owner", value: { type: "IDENTITY", id: owner.id, name: owner.name } });
  }
  if (additionalOwners !== undefined) {
    const err = additionalOwnersError(additionalOwners);
    if (err) return res.status(400).json({ error: err });
    ops.push({
      op: "replace",
      path: "/additionalOwners",
      value: additionalOwners.map((o) => ({ type: o.type, id: o.id, name: o.name })),
    });
  }
  if (dimensional !== undefined) {
    if (typeof dimensional !== "boolean") return res.status(400).json({ error: "dimensional must be a boolean." });
    ops.push({ op: "replace", path: "/dimensional", value: dimensional });
  }
  if (requestable !== undefined && typeof requestable !== "boolean") {
    return res.status(400).json({ error: "requestable must be a boolean." });
  }
  if (ops.length === 0 && requestable === undefined) {
    return res.status(400).json({ error: "Provide at least one field to update." });
  }

  try {
    const token = await sessionToken(session);
    // requestable only makes sense on a role nobody already gets
    // automatically — a dimensional (dynamic) role or one with a
    // membership rule is assigned by ISC itself, not requested, so this
    // checks the role's *current* state (before any dimensional change in
    // this same call) rather than trying to reason about a simultaneous
    // Standard<->Dynamic transition.
    if (requestable !== undefined) {
      const currentRole = await iscGet(tenant, token, `/v2026/roles/${req.params.id}`);
      if (currentRole.dimensional || currentRole.membership?.criteria) {
        return res.status(400).json({ error: "requestable can only be changed for a standard role with no membership rule." });
      }
      ops.push({ op: "replace", path: "/requestable", value: requestable });
    }
    const resp = await axios.patch(
      `https://${tenantApiHost(tenant)}/v2026/roles/${req.params.id}`,
      ops,
      { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json-patch+json" } }
    );
    res.json(resp.data);
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[roles] edit failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/*
 * AI description generation runs on one of two providers:
 *   - AI_PROVIDER=bedrock : Amazon Bedrock via the Mantle client, authenticated
 *     with the instance's IAM role — no API key exists anywhere. This is how
 *     AWS production runs.
 *   - ANTHROPIC_API_KEY set: the Anthropic API directly (test env / local).
 * Neither configured → the routes 503 with a clear message, same as before.
 */
const AI_PROVIDER = (process.env.AI_PROVIDER || "").toLowerCase();
const BEDROCK_MODEL_ID = process.env.BEDROCK_MODEL_ID || "anthropic.claude-haiku-4-5";

function aiConfigured() {
  return AI_PROVIDER === "bedrock" || !!process.env.ANTHROPIC_API_KEY;
}

let _bedrockClient = null;
function bedrockClient() {
  if (!_bedrockClient) {
    const { AnthropicBedrockMantle } = require("@anthropic-ai/bedrock-sdk");
    _bedrockClient = new AnthropicBedrockMantle({ awsRegion: process.env.AWS_REGION || "us-east-1" });
  }
  return _bedrockClient;
}

// Most AI features here are a paragraph of prose from a handful of facts —
// the small, fast default model does those well and cheaply. A few (drafting
// a whole workflow definition) are hard generation tasks where the model's
// capability decides whether the result is usable at all; those ask for
// `strong: true`. Both are overridable per deployment.
const AI_STRONG_MODEL = process.env.AI_STRONG_MODEL || "claude-opus-5";
const BEDROCK_STRONG_MODEL_ID = process.env.BEDROCK_STRONG_MODEL_ID || "anthropic.claude-opus-5";

/** One user-turn prompt in, generated text out — provider-agnostic. */
async function claudeGenerateText(prompt, { maxTokens = 300, strong = false } = {}) {
  if (AI_PROVIDER === "bedrock") {
    const resp = await bedrockClient().messages.create({
      model: strong ? BEDROCK_STRONG_MODEL_ID : BEDROCK_MODEL_ID,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    });
    return resp.content?.find((b) => b.type === "text")?.text?.trim();
  }
  const resp = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: strong ? AI_STRONG_MODEL : "claude-haiku-4-5-20251001",
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    },
    { headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" } }
  );
  // The text block, wherever it sits — a model that thinks by default
  // returns its (empty-text) thinking block first.
  return resp.data?.content?.find((b) => b.type === "text")?.text?.trim();
}

// Plain-English membership rule for the AI description prompt — best-effort,
// same EQUALS-leaf extraction the missing-dimension/duplicate-role checks
// use. Falls back to a generic note for shapes it can't confidently
// describe (OR-of-different-attributes, non-EQUALS operators, etc) rather
// than risk feeding the model a wrong summary.
function summarizeMembershipForPrompt(membership) {
  if (!membership) return "No membership rule — members are managed as an explicit list, or none yet.";
  if (membership.type === "IDENTITY_LIST") return "An explicit list of individually-assigned members, not a rule.";
  const leaves = extractAllIdentityEqualsLeaves(membership.criteria);
  if (leaves.length === 0) return "A custom membership rule too complex to summarize automatically.";
  return `Automatically assigned to active identities where ${leaves.map((l) => `${l.attrKey} = "${l.value}"`).join(" and ")}.`;
}

// Shared by every AI role-description path — an existing role
// (generateRoleDescriptionText below), and a not-yet-created role proposed
// from a peer-group scan (see the role-scans generate-descriptions route) —
// so the prompt wording can't drift between the two. Throws on failure;
// callers decide how to surface that.
// maxLength, when given, is a hard cap: the prompt asks for it, and the
// result is trimmed at a word boundary if the model runs over anyway.
async function generateDescriptionFromFacts(facts, roleTypeReference, { maxLength } = {}) {
  const lengthHint = maxLength ? ` Keep it under ${maxLength} characters in total — one or two sentences.` : "";
  const description = await claudeGenerateText(
    `Write a concise (2-4 sentence) description for this SailPoint role, based only on the facts below — don't invent anything not stated. Explain what access it grants and, if there's a membership rule, who gets it automatically. Don't repeat the role's name in the description — refer to it as "${roleTypeReference}" instead. Plain prose, no markdown, no preamble like "Here's a description" — just the description text itself.${lengthHint}\n\n${facts.join("\n")}`
  );
  if (!description) throw new Error("Empty response from Claude.");
  return maxLength ? truncateAtWord(description.trim(), maxLength) : description;
}

/** Cuts text to maxLength at the last word boundary, ending with an ellipsis only if something was dropped. */
function truncateAtWord(text, maxLength) {
  if (!text || text.length <= maxLength) return text;
  const cut = text.slice(0, maxLength - 1);
  const lastBreak = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf(" "));
  return (lastBreak > maxLength * 0.5 ? cut.slice(0, lastBreak) : cut).replace(/[\s,;:—-]+$/, "") + "…";
}

// Shared by the single-role route and the Role Descriptions screen's bulk
// generate — fetches one role's data and asks Claude for a description
// grounded in it, without writing anything back. Throws on failure; callers
// decide how to surface that (500 response for the single route, a
// per-role error entry for the bulk one).
async function generateRoleDescriptionText(tenant, token, roleId) {
  const role = await withApiRetry(() => iscGet(tenant, token, `/v2026/roles/${roleId}`), { label: `generate-description: fetch role ${roleId}` });
  const dimensions = role.dimensional
    ? await withApiRetry(() => iscGet(tenant, token, `/v2026/roles/${roleId}/dimensions`), { label: `generate-description: fetch role ${roleId} dimensions` })
    : [];

  const facts = [
    `Role name: ${role.name}`,
    `Type: ${role.dimensional ? "Dynamic (dimensional)" : "Standard"}`,
    `Membership: ${summarizeMembershipForPrompt(role.membership)}`,
    `Base entitlements (${(role.entitlements || []).length}): ${(role.entitlements || []).map((e) => e.name).join(", ") || "none"}`,
    `Access profiles (${(role.accessProfiles || []).length}): ${(role.accessProfiles || []).map((a) => a.name).join(", ") || "none"}`,
  ];
  if (dimensions.length > 0) {
    facts.push(`Dimensions (${dimensions.length}, each adds entitlements on top of the base for identities matching its own value):`);
    for (const d of dimensions) {
      facts.push(`  - ${d.name}: ${(d.entitlements || []).map((e) => e.name).join(", ") || "no additional entitlements"}`);
    }
  }
  const regulatory = (role.accessModelMetadata?.attributes || []).find((a) => a.key === "iscRegulatory");
  if (regulatory?.values?.length) facts.push(`Regulatory scope: ${regulatory.values.map((v) => v.name).join(", ")}`);

  return generateDescriptionFromFacts(facts, role.dimensional ? "This Dynamic Role" : "This Static Role");
}

/**
 * POST /api/roles/:id/generate-description
 * Header: x-sp-session
 * Asks Claude for a new description grounded in the role's actual current
 * data (membership rule, entitlements, access profiles, and — for a
 * dynamic role — each dimension's own added entitlements) rather than
 * letting the model invent anything. Returns the suggestion only; the
 * client shows it alongside the current description and applies it via the
 * existing PATCH .../roles/:id route, same as any manual edit — this route
 * never writes to the role itself.
 */
app.post("/api/roles/:id/generate-description", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;

  if (!aiConfigured()) {
    return res.status(503).json({ error: "AI description generation isn't configured on this server." });
  }

  try {
    const token = await sessionToken(session);
    const description = await generateRoleDescriptionText(tenant, token, req.params.id);
    res.json({ description });
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[roles] generate-description failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/**
 * POST /api/insights/role-descriptions/generate-all
 * Header: x-sp-session
 * Body: { roleIds: string[] }
 * Generates a suggested description for each given role (bounded
 * concurrency, same pattern as the peer-group scan's entitlement fetches),
 * continuing past individual failures rather than aborting the batch.
 * Returns suggestions only — nothing is written; the Role Descriptions
 * screen reviews every one before any save, same as the single-role route.
 */
app.post("/api/insights/role-descriptions/generate-all", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  const roleIds = req.body?.roleIds;
  if (!Array.isArray(roleIds) || roleIds.length === 0) {
    return res.status(400).json({ error: "roleIds must be a non-empty array." });
  }
  if (!aiConfigured()) {
    return res.status(503).json({ error: "AI description generation isn't configured on this server." });
  }

  try {
    const token = await sessionToken(session);
    const results = await mapWithConcurrency(roleIds, 3, async (roleId) => {
      try {
        const description = await generateRoleDescriptionText(tenant, token, roleId);
        return { roleId, description };
      } catch (err) {
        console.error(`[insights] role-descriptions generate-all: role ${roleId} failed:`, err.response?.data || err.message);
        return { roleId, error: describeError(err) };
      }
    });
    res.json({ results });
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[insights] role-descriptions generate-all failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

// GET /beta/common-access doesn't reliably include a role right after it's
// flagged — verified live: POST succeeds, a repeat POST immediately after
// correctly 409s ("already exists"), yet the role never appears in a
// subsequent GET (not even with count:true or an access.id filter). Common
// access here seems to only surface in the list once ISC's own background
// aggregation catches up, which this app has no way to trigger or wait for.
// Every role THIS app successfully flags is recorded here, so Role
// Evaluation's "exclude common-access entitlements" check (see
// fetchCommonAccessRoleSummaries below) doesn't depend on that list
// catching up — it's unioned with whatever the list does contain.
const flaggedCommonAccessRoles = createRecordStore(DATA_DIR, "flagged-common-access-roles.json");
// Explicit unflags — subtracted from every common-access id computation so
// neither ISC's CONFIRMED list nor this app's own scan bookkeeping can
// resurrect a role someone deliberately unflagged. Re-flagging clears it.
const deniedCommonAccessRoles = createRecordStore(DATA_DIR, "denied-common-access-roles.json");

async function rememberFlaggedCommonAccessRole(tenant, roleId) {
  const ids = new Set((await flaggedCommonAccessRoles.get(tenant)) || []);
  ids.add(roleId);
  await flaggedCommonAccessRoles.put(tenant, [...ids]);
}
// A deleted role can't grant anything, common access or not — dropped here
// so a stale id doesn't sit around forever pointlessly unioned into every
// future Role Evaluation's exclusion set. No-op (and no write) if the role
// was never tracked to begin with.
async function forgetFlaggedCommonAccessRole(tenant, roleId) {
  const ids = (await flaggedCommonAccessRoles.get(tenant)) || [];
  if (!ids.includes(roleId)) return;
  await flaggedCommonAccessRoles.put(tenant, ids.filter((id) => id !== roleId));
}

/**
 * SOD violation mitigations — this app's own record, not an ISC resource.
 * ISC's own mitigation concept lives at the identity level (a certification
 * reviewer granting a time-limited exception to an identity's actual
 * violation); this app's SOD check instead compares a role definition's own
 * granted entitlements against policy (see findSodViolations), which has no
 * ISC-side equivalent to attach a mitigation to. One entry = one (role,
 * policy, dimension) triple with an expiration; past expiresAt it's simply
 * ignored (never actively purged) and the violation goes back to being
 * flagged as active on the next evaluation.
 */
const sodMitigations = createRecordStore(DATA_DIR, "sod-mitigations.json");

async function getActiveSodMitigations(tenant, roleId) {
  const now = Date.now();
  return ((await sodMitigations.get(tenant)) || []).filter((m) => m.roleId === roleId && new Date(m.expiresAt).getTime() > now);
}
async function addSodMitigation(tenant, mitigation) {
  const list = (await sodMitigations.get(tenant)) || [];
  list.push(mitigation);
  await sodMitigations.put(tenant, list);
}
async function removeSodMitigation(tenant, mitigationId) {
  const list = (await sodMitigations.get(tenant)) || [];
  await sodMitigations.put(tenant, list.filter((m) => m.id !== mitigationId));
}
// Splits a raw findSodViolations() result into what's still actively
// flagged vs. what's currently covered by a live mitigation for this exact
// (policy, dimension) pair — dimensionId is null for the base-role check, or
// a dimension's own id for a per-dimension check, matching how mitigations
// are scoped when applied (see POST /api/roles/:id/sod-mitigations).
function splitMitigatedSodViolations(violations, mitigations, dimensionId = null) {
  const active = [];
  const mitigated = [];
  for (const v of violations) {
    const m = mitigations.find((mm) => mm.policyId === v.policyId && (mm.dimensionId || null) === dimensionId);
    if (m) mitigated.push({ policyId: v.policyId, policyName: v.policyName, expiresAt: m.expiresAt });
    else active.push(v);
  }
  return { active, mitigated };
}

/**
 * Flags a role as ISC common access — only works when no common-access
 * record exists for it yet (a fresh create, verified live: 201). There is
 * no working API to change an EXISTING record's status in either direction
 * — verified live that DELETE isn't even a registered method on this beta
 * resource, and PATCH/PUT against the record's own id all 404. Shared by
 * the standalone POST /api/roles/:id/common-access route and the Role Scan
 * Common Access proposal's create-role path.
 */
// Kicks off ISC's own common-access analysis job — flagging a role as
// common access (or enabling one that's already flagged) doesn't get
// picked up anywhere else in ISC until this analysis runs. Best-effort: a
// failure here doesn't mean the flag/enable itself failed, just that the
// analysis wasn't (re)triggered, so callers only log and move on rather
// than failing the whole request over it.
async function triggerCommonAccessAnalysis(tenant, token) {
  await axios.post(
    `https://${tenantApiHost(tenant)}/common-access/v1`,
    {},
    { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-SailPoint-Experimental": "true" } }
  );
}

async function flagRoleAsCommonAccess(tenant, token, roleId) {
  // /common-access/v1 (not /beta/common-access) — same "IAI Common Access"
  // feature, same createCommonAccessV1 operation and request/response
  // shape, same required scope (iai:access-modeling:manage) per SailPoint's
  // own API spec — verified live the beta alias and this path 401
  // identically for this tenant, so this doesn't fix that on its own, but
  // it's the documented non-beta path and already what
  // triggerCommonAccessAnalysis below uses.
  const resp = await axios.post(
    `https://${tenantApiHost(tenant)}/common-access/v1`,
    { access: { id: roleId, type: "ROLE" } },
    { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-SailPoint-Experimental": "true" } }
  );
  await rememberFlaggedCommonAccessRole(tenant, roleId);
  const deniedNow = (await deniedCommonAccessRoles.get(tenant)) || [];
  if (deniedNow.includes(roleId)) {
    await deniedCommonAccessRoles.put(tenant, deniedNow.filter((id) => id !== roleId));
  }
  try {
    await triggerCommonAccessAnalysis(tenant, token);
  } catch (err) {
    console.error(`[roles] common-access analysis trigger failed after flagging role ${roleId}:`, err.response?.data || err.message);
  }
  return resp.data;
}

/**
 * POST /api/roles/:id/common-access
 * A 409 here means a record already exists (in any status) and must be
 * changed in ISC's own UI (Admin > Access Model > Roles > Common Access)
 * instead — there's no API to update an existing one.
 */
app.post("/api/roles/:id/common-access", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;

  try {
    const token = await sessionToken(session);
    const data = await flagRoleAsCommonAccess(tenant, token, req.params.id);
    res.json(data);
  } catch (err) {
    if (err.response?.status === 409) {
      return res.status(409).json({ error: "This role already has a common-access record — change it in ISC's own UI (Admin > Access Model > Roles > Common Access), there's no API to update an existing one." });
    }
    // A bare 401 with no body here (verified live) isn't this app's own
    // session — sessionToken() above already succeeded, and this app's
    // OTHER API calls on the same session work fine. ISC's IAI Common
    // Access API itself is rejecting the token. Per SailPoint's own API
    // spec, POST /common-access/v1 requires the OAuth scope
    // iai:access-modeling:manage specifically — a scope tied to the AI
    // Access Modeling feature, not a general admin permission — so this
    // tenant's OAuth client/service credential almost certainly just
    // never had it granted, or the feature itself isn't licensed/enabled
    // for this tenant. describeError() falls back to axios's generic
    // "Request failed with status code 401" for an empty body, which
    // gives no indication of any of that — worth a specific, actionable
    // message instead of only that generic one.
    if (!err.sessionExpired && err.response?.status === 401) {
      console.error("[roles] common-access create failed with a bare 401 (not a local session issue):", err.response?.headers);
      return res.status(401).json({
        error: "ISC rejected this with 401 on its own Common Access API (/common-access/v1) — this isn't a sign-in problem (every other action still works). " +
          "This API specifically requires the OAuth scope \"iai:access-modeling:manage\" — check whether this tenant's OAuth client/service credential has been granted it, " +
          "and whether AI Access Modeling / Common Access is licensed and enabled for this tenant. " +
          "You can also flag it directly in ISC's own UI (Admin > Access Model > Roles > Common Access) as a workaround.",
      });
    }
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[roles] common-access create failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/**
 * DELETE /api/roles/:id/common-access — unflag Common Access for a role:
 * sets the role's CONFIRMED record to DENIED in ISC (via the bulk
 * update-status endpoint — the only one that exists; per-item routes 404,
 * verified live) and records a local denial so scan bookkeeping and a
 * stale/unreachable ISC list can't resurrect it. ISC being unreachable
 * (this API 401s on some tenants) doesn't block the local unflag.
 */
app.delete("/api/roles/:id/common-access", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  const roleId = req.params.id;
  try {
    const token = await sessionToken(session);
    let iscUpdated = false;
    try {
      const items = await withApiRetry(
        () => axios.get(`https://${tenantApiHost(tenant)}/common-access/v1`, {
          params: { limit: 250 },
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "X-SailPoint-Experimental": "true" },
        }),
        { label: `unflag common access: list for role ${roleId}` }
      );
      const record = (items.data || []).find((i) => i.access?.type === "ROLE" && i.access?.id === roleId && i.status === "CONFIRMED");
      if (record) {
        await axios.post(
          `https://${tenantApiHost(tenant)}/common-access/v1/update-status`,
          [{ id: record.id, status: "DENIED" }],
          { headers: { Authorization: `Bearer ${token}`, "X-SailPoint-Experimental": "true", "Content-Type": "application/json" } }
        );
        iscUpdated = true;
      }
    } catch (err) {
      console.error(`[roles] unflag: ISC common-access update skipped for ${roleId}:`, err.response?.status || err.message);
    }
    await forgetFlaggedCommonAccessRole(tenant, roleId);
    const denied = (await deniedCommonAccessRoles.get(tenant)) || [];
    if (!denied.includes(roleId)) await deniedCommonAccessRoles.put(tenant, [...denied, roleId]);
    res.json({ ok: true, iscUpdated });
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[roles] unflag common access failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

const CAMPAIGN_STAGE_POLL_INTERVAL_MS = 2000;
const CAMPAIGN_STAGE_POLL_TIMEOUT_MS = 60000;
// Only reachable, in normal operation, via an explicit activate call —
// legitimately "already running," nothing left to do. COMPLETED/ARCHIVED
// are deliberately NOT included here even though a campaign can reach them
// without ever being activated (verified live: a role with only trivial
// birthright entitlements jumped straight from PENDING to COMPLETED with
// no observable STAGED window) — a certification nobody actually got
// assigned to review is a failure to report, not a silent success, per
// explicit instruction.
const CAMPAIGN_ALREADY_ACTIVATED_STATUSES = new Set(["ACTIVATING", "ACTIVE", "COMPLETING"]);

/**
 * A freshly created campaign starts PENDING while ISC generates its actual
 * certifications in the background, and only becomes STAGED (activatable)
 * once that finishes — calling activate immediately after create races
 * this and 400s with ISC's generic "semantically invalid" (verified live:
 * a real campaign stayed PENDING for several seconds after creation).
 * Polls until the campaign is either STAGED (ready to activate) or has
 * already moved past that point on its own via a genuine activation.
 * Throws — rather than returning quietly — for COMPLETED/ARCHIVED/ERROR or
 * a timeout, since none of those mean the campaign is actually running.
 */
async function waitForCampaignStageable(tenant, token, campaignId) {
  const start = Date.now();
  while (Date.now() - start < CAMPAIGN_STAGE_POLL_TIMEOUT_MS) {
    const campaign = await withApiRetry(
      () => iscGet(tenant, token, `/v2026/campaigns/${campaignId}`),
      { label: `certify: poll campaign ${campaignId} status` }
    );
    if (campaign.status === "STAGED") return "STAGED";
    if (CAMPAIGN_ALREADY_ACTIVATED_STATUSES.has(campaign.status)) return campaign.status;
    if (campaign.status === "ERROR") {
      throw new Error(`Campaign ${campaignId} entered ERROR status before it could be activated.`);
    }
    if (campaign.status === "COMPLETED" || campaign.status === "ARCHIVED") {
      throw new Error(
        `Campaign ${campaignId} reached ${campaign.status} without ever being activated — ` +
        "it likely had nothing certifiable to review (e.g. only birthright/common-access entitlements), " +
        "so no one was actually assigned to review it. Check the role's own composition in ISC."
      );
    }
    await new Promise((resolve) => setTimeout(resolve, CAMPAIGN_STAGE_POLL_INTERVAL_MS));
  }
  throw new Error(
    `Campaign ${campaignId} did not finish staging within ${CAMPAIGN_STAGE_POLL_TIMEOUT_MS / 1000}s — ` +
    "it may still become activatable on its own; check it directly in ISC."
  );
}

// A generated PDF report is stored on disk (not inside the JSON/sqlite
// record store, which would mean base64-inflating it into one big blob
// that gets rewritten whole on every save — this store only ever holds
// small metadata) under a random unguessable token — GET is intentionally
// public (no session) since the recipient clicking a link in their email
// isn't signed into this app. mailto: links can't carry attachments, so
// this is how "email a report" actually works — explicit user choice
// over downloading the file and asking the sender to attach it manually.
const ROLE_REPORTS_DIR = path.join(DATA_DIR, "role-reports");
// token -> { filename, createdAt, tenant }
const roleReports = createRecordStore(DATA_DIR, "role-reports.json");

// PDF blobs: S3 on AWS, DATA_DIR files locally — same interface either way.
function fileBlobStore(dir) {
  return {
    async put(name, buffer) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, name), buffer);
    },
    async getStream(name) {
      const p = path.join(dir, name);
      return fs.existsSync(p) ? fs.createReadStream(p) : null;
    },
    async delete(name) {
      try { fs.unlinkSync(path.join(dir, name)); } catch { /* already gone */ }
    },
  };
}
const roleReportBlobs = storage.isAws()
  ? storage.createS3BlobStore(storage.AWS_BUCKET, "role-reports")
  : fileBlobStore(ROLE_REPORTS_DIR);

// Matches what the email body itself tells the recipient ("available for
// 2 weeks") — explicit user instruction. Pruned on every report created
// (see pruneRoleReports() call in the POST route below), so "whenever the
// email report process runs" is satisfied without a separate scheduler.
const ROLE_REPORT_RETENTION_MS = 14 * 24 * 60 * 60 * 1000; // 2 weeks
async function pruneRoleReports() {
  const cutoff = Date.now() - ROLE_REPORT_RETENTION_MS;
  for (const [token, meta] of Object.entries(await roleReports.all())) {
    if (new Date(meta.createdAt).getTime() < cutoff) {
      await roleReports.delete(token);
      await roleReportBlobs.delete(`${token}.pdf`);
    }
  }
}

/**
 * GET /api/identities/:id/email
 * Dedicated (not the generic /api/isc/* proxy) so a transient 429/5xx is
 * retried instead of failing outright — a role's own `owner` field only
 * ever carries {id, name}, never an email address, so the Roles list's
 * Email Report action needs one lookup per distinct owner in the
 * selection before it can build any mailto: link at all.
 */
app.get("/api/identities/:id/email", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  try {
    const token = await sessionToken(session);
    const identity = await withApiRetry(
      () => iscGet(tenant, token, `/v2026/identities/${req.params.id}`),
      { label: `get identity ${req.params.id} email` }
    );
    // The identity resource's real top-level field is emailAddress, not
    // email (verified live — a plain .email is always undefined). Falls
    // back to the attributes.email custom attribute some tenants also
    // carry, in case emailAddress itself is unset for a given identity.
    res.json({ id: identity.id, name: identity.name, email: identity.emailAddress || identity.attributes?.email || null });
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error(`[identities] get ${req.params.id} email failed:`, err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/**
 * POST /api/role-reports
 * Body: { filename, pdfBase64 }
 * Stores a PDF (built client-side via jsPDF, same as every other report in
 * this app — see lib/exportRolePdf.js) on disk and returns a link to it.
 * Requires a session to create (only a signed-in user can publish a
 * report); the GET below that actually serves it does not.
 */
app.post("/api/role-reports", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { filename, pdfBase64 } = req.body || {};
  if (typeof pdfBase64 !== "string" || !pdfBase64) {
    return res.status(400).json({ error: "pdfBase64 is required." });
  }
  try {
    const token = crypto.randomBytes(24).toString("hex");
    await roleReportBlobs.put(`${token}.pdf`, Buffer.from(pdfBase64, "base64"));
    await roleReports.put(token, {
      filename: typeof filename === "string" && filename ? filename : "role-report.pdf",
      createdAt: new Date().toISOString(),
      tenant: session.tenant,
    });
    await pruneRoleReports();
    res.json({ token, url: `${req.protocol}://${req.get("host")}/api/role-reports/${token}` });
  } catch (err) {
    console.error("[role-reports] create failed:", err.message);
    res.status(500).json({ error: "Failed to store the report." });
  }
});

/**
 * GET /api/role-reports/:token
 * Intentionally public (no session) — see POST above. Kept for
 * ROLE_REPORT_RETENTION_MS, then 404s like it never existed.
 */
app.get("/api/role-reports/:token", async (req, res) => {
  // Metadata gates the blob fetch: an expired/unknown token 404s before any
  // storage access, and the metadata's createdAt is re-checked so a link
  // whose blob outlived a failed prune still dies on schedule.
  const meta = await roleReports.get(req.params.token);
  const fresh = meta && new Date(meta.createdAt).getTime() >= Date.now() - ROLE_REPORT_RETENTION_MS;
  const stream = fresh ? await roleReportBlobs.getStream(`${req.params.token}.pdf`) : null;
  if (!stream) {
    return res.status(404).send("This report link has expired or doesn't exist.");
  }
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${meta.filename}"`);
  stream.pipe(res);
});

// "My Reports": private, per-user saved copies of generated PDFs (Email
// Report, etc.) — distinct from the public role-reports token links above,
// which exist for external email recipients rather than the generating
// user. Same on-disk-blob + small-JSON-metadata split, but both routes
// require a session, and GET verifies the record belongs to the caller.
const SAVED_REPORTS_DIR = path.join(DATA_DIR, "saved-reports");
// id -> { filename, title, generatedBy, tenant, createdAt }
const savedReports = createRecordStore(DATA_DIR, "saved-reports.json");
const savedReportBlobs = storage.isAws()
  ? storage.createS3BlobStore(storage.AWS_BUCKET, "saved-reports")
  : fileBlobStore(SAVED_REPORTS_DIR);

// Same 2-week window as the recipient's public role-reports link (see
// ROLE_REPORT_RETENTION_MS above) — the sender's own saved copy shouldn't
// outlive the link they emailed out. Pruned on every report created, same
// "no separate scheduler needed" convention as pruneRoleReports().
async function pruneSavedReports() {
  const cutoff = Date.now() - ROLE_REPORT_RETENTION_MS;
  for (const [id, meta] of Object.entries(await savedReports.all())) {
    if (new Date(meta.createdAt).getTime() < cutoff) {
      await savedReports.delete(id);
      await savedReportBlobs.delete(`${id}.pdf`);
    }
  }
}

/**
 * POST /api/reports
 * Body: { filename, title, pdfBase64 }
 * Saves a private, per-user copy of a generated PDF for the signed-in
 * user's own "My Reports" list.
 */
app.post("/api/reports", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { filename, title, pdfBase64 } = req.body || {};
  if (typeof pdfBase64 !== "string" || !pdfBase64) {
    return res.status(400).json({ error: "pdfBase64 is required." });
  }
  try {
    const id = crypto.randomBytes(16).toString("hex");
    await savedReportBlobs.put(`${id}.pdf`, Buffer.from(pdfBase64, "base64"));
    await savedReports.put(id, {
      filename: typeof filename === "string" && filename ? filename : "report.pdf",
      title: typeof title === "string" && title ? title : (typeof filename === "string" && filename ? filename : "Report"),
      generatedBy: session.identity?.id || null,
      tenant: session.tenant,
      createdAt: new Date().toISOString(),
    });
    await pruneSavedReports();
    res.json({ id });
  } catch (err) {
    console.error("[reports] create failed:", err.message);
    res.status(500).json({ error: "Failed to save the report." });
  }
});

/** GET /api/reports — the signed-in user's saved reports, newest first. */
app.get("/api/reports", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const list = Object.entries(await savedReports.all())
    .filter(([, r]) => r.tenant === session.tenant && r.generatedBy === session.identity?.id)
    .map(([id, r]) => ({ id, filename: r.filename, title: r.title, createdAt: r.createdAt }))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(list);
});

/**
 * GET /api/reports/:id
 * Streams the PDF. Unlike the public role-reports links, this requires a
 * session and only the user who generated the report can view it. Kept for
 * ROLE_REPORT_RETENTION_MS (2 weeks, pruned by pruneSavedReports() above),
 * then 404s like it never existed — same window as the recipient's link.
 */
app.get("/api/reports/:id", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const meta = await savedReports.get(req.params.id);
  const ownedByCaller = meta && meta.generatedBy === session.identity?.id && meta.tenant === session.tenant;
  const stream = ownedByCaller ? await savedReportBlobs.getStream(`${req.params.id}.pdf`) : null;
  if (!stream) {
    return res.status(404).json({ error: "Report not found." });
  }
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${meta.filename}"`);
  stream.pipe(res);
});

/**
 * POST /api/roles/certify
 * Body: { roleIds: string[] }
 * Creates and activates one ROLE_COMPOSITION certification campaign per
 * distinct role owner among the given roles, named "<owner> Role
 * Composition Review" — SailPoint's campaign API takes a single reviewer
 * per campaign (roleCompositionCampaignInfo.reviewer), not one per role, so
 * roles sharing an owner are bundled into that owner's one campaign rather
 * than creating a campaign per role. https://developer.sailpoint.com/docs/api/create-campaign-v-1
 */
app.post("/api/roles/certify", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  const roleIds = Array.isArray(req.body?.roleIds) ? req.body.roleIds.filter((id) => typeof id === "string" && id) : [];
  if (roleIds.length === 0) return res.status(400).json({ error: "roleIds must be a non-empty array." });

  try {
    const token = await sessionToken(session);

    // Fresh owner per role, not whatever the client's own (possibly
    // stale, possibly paginated-out) list data says — a recent Change
    // Owner action or a page the client never fetched would otherwise
    // group a role under the wrong owner's campaign.
    const roles = [];
    const fetchErrors = [];
    await mapWithConcurrency(roleIds, 5, async (id) => {
      try {
        roles.push(await withApiRetry(() => iscGet(tenant, token, `/v2026/roles/${id}`), { label: `certify: fetch role ${id}` }));
      } catch (err) {
        fetchErrors.push({ id, error: describeError(err) });
      }
    });

    const byOwner = new Map(); // ownerId -> { owner, roles: [] }
    const skippedNoOwner = [];
    const skippedDimensional = [];
    for (const role of roles) {
      // Verified live: a ROLE_COMPOSITION campaign scoped to a dimensional
      // (dynamic) role generates zero certifications (totalCertifications:
      // 0) and jumps straight from PENDING to COMPLETED with no one ever
      // assigned to review it — a standard (non-dimensional) role for the
      // same tenant/owner generates one normally. This looks like an ISC
      // platform limitation (role composition certs don't cover a
      // dimensional role's per-dimension entitlements), not something a
      // different request payload can work around, so these are skipped
      // up front rather than silently producing an empty, unreviewed
      // "completed" campaign.
      if (role.dimensional) {
        skippedDimensional.push({ id: role.id, name: role.name });
        continue;
      }
      if (!role.owner?.id) {
        skippedNoOwner.push({ id: role.id, name: role.name });
        continue;
      }
      if (!byOwner.has(role.owner.id)) byOwner.set(role.owner.id, { owner: role.owner, roles: [] });
      byOwner.get(role.owner.id).roles.push(role);
    }

    const deadline = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
    const results = [];
    for (const { owner, roles: ownerRoles } of byOwner.values()) {
      const campaignName = `${owner.name} Role Composition Review`;
      let campaignId = null;
      try {
        const createToken = await sessionToken(session);
        const created = await withApiRetry(
          () => axios.post(
            `https://${tenantApiHost(tenant)}/v2026/campaigns`,
            {
              name: campaignName,
              description: "This Role review will help us ensure these Roles are valid for our user base.",
              deadline,
              type: "ROLE_COMPOSITION",
              emailNotificationEnabled: true,
              roleCompositionCampaignInfo: {
                reviewer: { type: "IDENTITY", id: owner.id, name: owner.name },
                roleIds: ownerRoles.map((r) => r.id),
                // Who "revoke" decisions in this campaign get assigned to —
                // ISC requires this to be a Role Admin or Org Admin, which
                // the role owner isn't necessarily; the signed-in user
                // (who has permission to trigger this action at all) is
                // used instead, same convention this app's own skeleton/
                // create-role flows use for a new role's owner.
                remediatorRef: { type: "IDENTITY", id: session.identity?.id, name: session.identity?.username },
              },
            },
            { headers: { Authorization: `Bearer ${createToken}`, "Content-Type": "application/json" } }
          ),
          { label: `certify: create campaign for owner ${owner.id}` }
        );
        campaignId = created.data.id;

        const stageToken = await sessionToken(session);
        const readyStatus = await waitForCampaignStageable(tenant, stageToken, campaignId);
        if (readyStatus === "STAGED") {
          const activateToken = await sessionToken(session);
          await withApiRetry(
            () => axios.post(
              `https://${tenantApiHost(tenant)}/v2026/campaigns/${campaignId}/activate`,
              {},
              { headers: { Authorization: `Bearer ${activateToken}`, "Content-Type": "application/json" } }
            ),
            { label: `certify: activate campaign ${campaignId}` }
          );
        }
        // Any other returned status (ACTIVATING/ACTIVE/COMPLETING) means
        // it's already running via a genuine activation — nothing left to
        // do here. waitForCampaignStageable itself throws for
        // COMPLETED/ARCHIVED/ERROR/timeout, so reaching this line at all
        // means the campaign really is (or is about to be) active.

        results.push({ ownerId: owner.id, ownerName: owner.name, ok: true, campaignId, campaignName, roleCount: ownerRoles.length });
      } catch (err) {
        console.error(`[roles] certify: campaign failed for owner ${owner.id} (${owner.name}):`, err.response?.data || err.message);
        results.push({
          ownerId: owner.id,
          ownerName: owner.name,
          ok: false,
          // A campaignId here means creation succeeded but activation
          // never happened (either the activate call itself failed, or
          // waitForCampaignStageable threw because the campaign reached
          // COMPLETED/ARCHIVED/ERROR on its own first) — the campaign
          // object still exists in ISC, just not actually running, worth
          // saying explicitly rather than implying nothing happened at all.
          campaignId,
          error: campaignId
            ? `Campaign "${campaignName}" was created but failed to activate: ${describeError(err)}`
            : describeError(err),
          roleCount: ownerRoles.length,
        });
      }
    }

    res.json({ results, skippedNoOwner, skippedDimensional, fetchErrors });
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[roles] certify failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/**
 * Retries a transient (429/5xx/network) API failure a few times with
 * backoff, honoring Retry-After when SailPoint sends one — same pattern as
 * the role-scan entitlement fetch retry above, generalized for any single
 * axios call. A 4xx failure (bad request, not found, validation) isn't
 * transient and is rethrown immediately rather than wasting attempts on it.
 */
async function withApiRetry(fn, { attempts = 3, label } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = err.response?.status;
      const isTransient = status === 429 || status >= 500 || !status;
      if (!isTransient || attempt === attempts) throw err;
      const retryAfterSeconds = Number(err.response?.headers?.["retry-after"]);
      const waitMs = retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : attempt * 750;
      console.warn(
        `[insights] ${label || "API call"} failed (attempt ${attempt}/${attempts}), retrying in ${waitMs}ms:`,
        err.response?.data || err.message
      );
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

/**
 * Shared by PATCH /api/roles/:id/entitlements and the Role Evaluation
 * scan's per-role/accept-all actions, so the single-role UI action and the
 * bulk scan action can never drift. Adds/removes entitlements directly
 * granted by a (non-dimensional) role via one JSON Patch replace — verified
 * live with a no-op replace against a real role's /entitlements array; the
 * "add" path reuses the exact same replace mechanism, just with a longer array.
 */
async function patchRoleEntitlements(tenant, token, roleId, { add, remove }) {
  const hasRemove = Array.isArray(remove) && remove.length > 0;
  const hasAdd = Array.isArray(add) && add.length > 0;
  const role = await withApiRetry(() => iscGet(tenant, token, `/v2026/roles/${roleId}`), { label: `patch role ${roleId}: fetch role` });
  const removeSet = new Set(hasRemove ? remove : []);
  let nextEntitlements = (role.entitlements || []).filter((e) => !removeSet.has(e.id));
  if (hasAdd) {
    const existingIds = new Set(nextEntitlements.map((e) => e.id));
    const toAdd = add
      .filter((e) => !existingIds.has(e.id))
      .map((e) => ({ id: e.id, name: e.name, type: "ENTITLEMENT" }));
    nextEntitlements = [...nextEntitlements, ...toAdd];
  }
  const resp = await withApiRetry(
    () => axios.patch(
      `https://${tenantApiHost(tenant)}/v2026/roles/${roleId}`,
      [{ op: "replace", path: "/entitlements", value: nextEntitlements }],
      { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json-patch+json" } }
    ),
    { label: `patch role ${roleId} entitlements` }
  );
  return resp.data;
}

/** Same as patchRoleEntitlements, scoped to one dimension of a dynamic role. */
async function patchDimensionEntitlements(tenant, token, roleId, dimensionId, { add, remove }) {
  const hasRemove = Array.isArray(remove) && remove.length > 0;
  const hasAdd = Array.isArray(add) && add.length > 0;
  const dimension = await withApiRetry(() => iscGet(tenant, token, `/v2026/roles/${roleId}/dimensions/${dimensionId}`), { label: `patch role ${roleId} dimension ${dimensionId}: fetch dimension` });
  const removeSet = new Set(hasRemove ? remove : []);
  let nextEntitlements = (dimension.entitlements || []).filter((e) => !removeSet.has(e.id));
  if (hasAdd) {
    const existingIds = new Set(nextEntitlements.map((e) => e.id));
    const toAdd = add
      .filter((e) => !existingIds.has(e.id))
      .map((e) => ({ id: e.id, name: e.name, type: "ENTITLEMENT" }));
    nextEntitlements = [...nextEntitlements, ...toAdd];
  }
  const resp = await withApiRetry(
    () => axios.patch(
      `https://${tenantApiHost(tenant)}/v2026/roles/${roleId}/dimensions/${dimensionId}`,
      [{ op: "replace", path: "/entitlements", value: nextEntitlements }],
      { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json-patch+json" } }
    ),
    { label: `patch role ${roleId} dimension ${dimensionId} entitlements` }
  );
  return resp.data;
}

/**
 * Creates a new dimension on a dynamic role, scoped to identities where
 * attribute.<attrKey> equals value — same shape used by the existing
 * Role Mining dimension-creation flow. Verified live (create then delete
 * a test dimension against a real dimensional role) that this exact
 * payload shape and the DELETE counterpart both work.
 */
async function createRoleDimensionOnServer(tenant, token, roleId, { name, description, attrKey, value, entitlements }) {
  const resp = await withApiRetry(
    () => axios.post(
      `https://${tenantApiHost(tenant)}/v2026/roles/${roleId}/dimensions`,
      {
        name,
        description: description || `${attrKey.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase())}: ${value}`,
        entitlements: (entitlements || []).map((e) => ({ id: e.id, type: "ENTITLEMENT", name: e.name })),
        accessProfiles: [],
        membership: {
          type: "STANDARD",
          criteria: {
            operation: "AND",
            key: null,
            stringValue: "",
            children: [{
              operation: "EQUALS",
              key: { type: "IDENTITY", property: `attribute.${attrKey}`, sourceId: null },
              stringValue: value,
              children: null,
            }],
          },
        },
      },
      { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }
    ),
    { label: `create dimension "${name}" on role ${roleId}` }
  );
  return resp.data;
}

/**
 * This tenant's demo data regenerates in the background, so an entitlement
 * an evaluation suggested adding can be deleted from its source by the time
 * accept-all gets to it — sending that id in a PATCH/POST makes SailPoint's
 * API 500 with a generic "internal fault" instead of a clean error. Checked
 * with a few concurrent lookups (cheap relative to the write it's guarding)
 * right before applying, and only entitlements confirmed gone (404) are
 * dropped — any other lookup failure leaves the candidate in place so a
 * transient error there doesn't silently skip a real suggestion.
 */
/**
 * Which of these entitlement ids still exist in ISC, in batches of 50 rather
 * than one lookup each — the same `filters=id in (...)` batching the segment
 * access route uses. One call per entitlement was a measurable cost: 122 of
 * these were rate-limited in a single log, costing over seven minutes of
 * backoff on their own.
 *
 * Returns a Set of the ids ISC returned. A batch that FAILS (network,
 * permissions, throttling that outlived its retries) resolves as "all of
 * these exist", so a transient error can never make a live entitlement look
 * deleted — the same fail-open guarantee the per-item version had, and the
 * reason it's a Set of survivors rather than a list of missing ids.
 */
const ENTITLEMENT_ID_BATCH = 50;

async function existingEntitlementIds(tenant, token, ids) {
  const found = new Set();
  for (let i = 0; i < ids.length; i += ENTITLEMENT_ID_BATCH) {
    const chunk = ids.slice(i, i + ENTITLEMENT_ID_BATCH);
    try {
      const page = await withApiRetry(
        () => iscGet(tenant, token, "/v2026/entitlements", {
          filters: `id in (${chunk.map((id) => `"${id}"`).join(",")})`,
          limit: chunk.length,
        }),
        { label: `entitlement existence check (${chunk.length})` }
      );
      for (const e of page || []) if (e?.id) found.add(e.id);
    } catch (err) {
      console.warn(`[entitlements] existence check failed for ${chunk.length} ids (${err.response?.status || err.message}) — treating them as present`);
      for (const id of chunk) found.add(id);
    }
  }
  return found;
}

async function filterExistingEntitlements(tenant, token, ents) {
  if (!ents.length) return ents;
  const alive = await existingEntitlementIds(tenant, token, ents.map((e) => e.id));
  return ents.filter((e) => alive.has(e.id));
}

/**
 * Applies every actionable suggestion from one role's evaluation result:
 * removes stale/unavailable entitlements and adds commonly-held-but-missing
 * ones in a single combined call (avoids two racing replaces against the
 * same array), adds each existing dimension's own missing entitlements, and
 * creates every "new dimension may be needed" gap with its entitlements.
 * Shared by the per-role and accept-all actions on a Role Evaluation scan.
 */
async function applyRoleEvaluationSuggestions(tenant, token, roleId, evaluation) {
  const addedEntIds = new Set();
  const removeIds = (evaluation.removeCandidates || []).map((c) => c.entitlementId).filter(Boolean);
  const addEnts = await filterExistingEntitlements(
    tenant, token,
    (evaluation.addCandidates || []).map((c) => ({ id: c.entitlementId, name: c.entitlement }))
  );
  if (removeIds.length || addEnts.length) {
    await patchRoleEntitlements(tenant, token, roleId, { add: addEnts, remove: removeIds });
    addEnts.forEach((e) => addedEntIds.add(e.id));
  }
  for (const d of evaluation.dimensionEvaluations || []) {
    const dimAddEnts = await filterExistingEntitlements(
      tenant, token,
      (d.addCandidates || []).map((c) => ({ id: c.entitlementId, name: c.entitlement }))
    );
    const dimRemoveIds = (d.removeCandidates || []).map((c) => c.entitlementId).filter(Boolean);
    if (dimAddEnts.length > 0 || dimRemoveIds.length > 0) {
      await patchDimensionEntitlements(
        tenant, token, roleId, d.dimensionId,
        { add: dimAddEnts, remove: dimRemoveIds }
      );
      dimAddEnts.forEach((e) => addedEntIds.add(e.id));
    }
  }
  for (const md of evaluation.missingDimensions || []) {
    md.addCandidates = (md.addCandidates || []);
    const filteredEnts = await filterExistingEntitlements(
      tenant, token,
      md.addCandidates.map((c) => ({ id: c.entitlementId, name: c.entitlement }))
    );
    await createRoleDimensionOnServer(tenant, token, roleId, {
      name: md.value,
      attrKey: md.attrKey,
      value: md.value,
      entitlements: filteredEnts,
    });
    filteredEnts.forEach((e) => addedEntIds.add(e.id));
  }

  const tagged = await tagEntitlementsWithRoleBoundaryValues(tenant, token, roleId, [...addedEntIds]);
  return { tagged, addedEntIds: [...addedEntIds] };
}

/**
 * Accept-time cascade for Common Access roles: entitlements just ADDED to
 * a common role are removed from every other role "in the same context" —
 * any candidate role whose membership criteria are a superset of the
 * common role's (its population sits entirely inside the common scope, so
 * the common role now grants those entitlements to all of its members).
 * Covers base-role entitlements and dimensions. Best-effort per role — a
 * single role's failure is logged and skipped, never unwinding the accept
 * that triggered it. Returns [{ roleId, roleName, removed: [names] }].
 */
async function removeAcceptedCommonEntsFromContextRoles(tenant, token, commonRoleId, addedEntIds, candidateRoleIds) {
  const added = new Set(addedEntIds);
  if (added.size === 0 || candidateRoleIds.length === 0) return [];
  const commonRole = await iscGet(tenant, token, `/v2026/roles/${commonRoleId}`);
  const commonLeaves = extractAllCriteriaLeaves(commonRole.membership?.criteria);
  if (commonLeaves.length === 0) return [];

  const removedFrom = [];
  for (const rid of candidateRoleIds) {
    if (rid === commonRoleId) continue;
    try {
      const role = await withApiRetry(() => iscGet(tenant, token, `/v2026/roles/${rid}`), { label: `common-accept cascade: fetch role ${rid}` });
      const leaves = extractAllCriteriaLeaves(role.membership?.criteria);
      if (leaves.length === 0 || !criteriaLeavesSubsetOf(commonLeaves, leaves)) continue;

      const removedNames = [];
      const baseRemove = (role.entitlements || []).filter((e) => added.has(e.id));
      if (baseRemove.length > 0) {
        await patchRoleEntitlements(tenant, token, rid, { remove: baseRemove.map((e) => e.id) });
        removedNames.push(...baseRemove.map((e) => e.name));
      }
      if (role.dimensional) {
        const dims = await withApiRetry(() => iscGet(tenant, token, `/v2026/roles/${rid}/dimensions`), { label: `common-accept cascade: fetch role ${rid} dimensions` });
        for (const d of dims || []) {
          const dimRemove = (d.entitlements || []).filter((e) => added.has(e.id));
          if (dimRemove.length > 0) {
            await patchDimensionEntitlements(tenant, token, rid, d.id, { remove: dimRemove.map((e) => e.id) });
            removedNames.push(...dimRemove.map((e) => e.name));
          }
        }
      }
      if (removedNames.length > 0) {
        removedFrom.push({ roleId: rid, roleName: role.name, removed: removedNames });
      }
    } catch (err) {
      console.error(`[insights] common-accept cascade: role ${rid} failed:`, err.response?.data || err.message);
    }
  }
  return removedFrom;
}

/**
 * Segments-by-Metadata carry-through: entitlements newly added to a role
 * inherit every segment-boundary value the role itself is tagged with (the
 * configured attribute, default "Segments"), so metadata-driven data
 * segments whose FILTER criteria reference those values pick the new
 * entitlements up without a separate Assign Matching pass. Same per-item
 * tagging mechanism as the Segments by Metadata task
 * (tagAccessWithBoundaryValue — already-tagged counts as success).
 * Best-effort by design: callers invoke this AFTER the entitlements are
 * already on the role, so a tagging failure is reported (returned/logged),
 * never unwound. Returns null when the role carries no boundary values or
 * there's nothing to tag.
 */
async function tagEntitlementsWithRoleBoundaryValues(tenant, token, roleId, entitlementIds) {
  if (!entitlementIds || entitlementIds.length === 0) return null;
  try {
    const metadataKey =
      (await getTenantSettings(tenant)).segmentMetadataAttribute?.trim() || DEFAULT_SEGMENT_METADATA_ATTRIBUTE;
    const role = await withApiRetry(
      () => iscGet(tenant, token, `/v2026/roles/${roleId}`),
      { label: `tagEntitlementsWithRoleBoundaryValues: fetch role ${roleId}` }
    );
    const attr = (role.accessModelMetadata?.attributes || []).find((a) => a.key === metadataKey);
    const values = (attr?.values || []).filter((v) => v.value);
    if (values.length === 0) return null;
    for (const v of values) {
      await tagAccessWithBoundaryValue(tenant, token, {
        key: metadataKey,
        entitlementIds,
        roleIds: [],
        value: v.value,
        name: v.name || v.value,
      });
    }
    return { entitlements: entitlementIds.length, key: metadataKey, values: values.map((v) => v.value) };
  } catch (err) {
    console.warn(`[roles] tagging added entitlements for role ${roleId} failed:`, err.response?.data || err.message);
    return { error: describeError(err) };
  }
}

/**
 * Role Evaluation's segment-metadata check — and fix. A role's data-segment
 * value is derived exactly the way segment creation derives it: the role's
 * own criteria values for the configured boundary attributes, joined with
 * " - " (e.g. country = BE → "BE", slug "be"). Any value the role is already
 * tagged with on the attribute counts too. For each value this makes sure:
 *   - the metadata attribute exists (created if missing),
 *   - the value is registered on it (created if missing),
 *   - the role itself carries it,
 *   - every entitlement on the role, dimensions included, carries it.
 * Only additive — nothing is ever untagged. Returns null when the role has
 * no derivable or existing value (nothing to check), otherwise
 * { key, values: [{ value, name, valueCreated, roleTagged, entitlementsChecked,
 *   entitlementsTagged: [{ id, name }] }], error? }.
 */
async function ensureRoleSegmentMetadata(tenant, token, role, dimensions, boundaryAttributes) {
  const key = (await getTenantSettings(tenant)).segmentMetadataAttribute?.trim() || DEFAULT_SEGMENT_METADATA_ATTRIBUTE;
  const wanted = new Map(); // value -> display name

  if (boundaryAttributes.length > 0) {
    const leaves = extractAllIdentityEqualsLeaves(role.membership?.criteria);
    const parts = boundaryAttributes.map((k) => [...new Set(leaves.filter((l) => l.attrKey === k).map((l) => String(l.value)))]);
    // Exactly one value per boundary attribute — a role spanning several
    // (an OR across countries) has no single segment to belong to.
    if (parts.every((vals) => vals.length === 1)) {
      const name = parts.map((vals) => vals[0]).join(" - ");
      const value = boundaryValueSlug(name);
      if (value) wanted.set(value, name);
    }
  }
  const roleAttr = (role.accessModelMetadata?.attributes || []).find((a) => a.key === key);
  const roleValues = new Set((roleAttr?.values || []).map((v) => v.value).filter(Boolean));
  for (const v of roleAttr?.values || []) if (v.value && !wanted.has(v.value)) wanted.set(v.value, v.name || v.value);
  if (wanted.size === 0) return null;

  const entById = new Map();
  for (const e of role.entitlements || []) entById.set(e.id, e.name || e.id);
  for (const d of dimensions || []) for (const e of d.entitlements || []) if (!entById.has(e.id)) entById.set(e.id, e.name || e.id);
  const entIds = [...entById.keys()];

  const out = { key, values: [] };
  try {
    await ensureBoundaryMetadataAttribute(tenant, token, key);
    const existing = await iscGet(tenant, token, `/v2026/access-model-metadata/attributes/${encodeURIComponent(key)}/values`, { limit: 250 }).catch(() => null);
    const knownValues = existing ? new Set(existing.map((v) => v.value).filter(Boolean)) : null;

    for (const [value, name] of wanted) {
      const valueCreated = knownValues ? !knownValues.has(value) : false;
      await ensureBoundaryMetadataValue(tenant, token, key, { value, name, knownValues });

      const roleTagged = !roleValues.has(value);
      if (roleTagged) {
        await tagAccessWithBoundaryValue(tenant, token, { key, entitlementIds: [], roleIds: [role.id], value, name, skipEnsure: true });
      }

      // Which of the role's entitlements already carry the value, 50 ids
      // per search. The index lags a fresh tag by a little, so an item
      // tagged moments ago may be re-tagged — harmless, tagging is
      // idempotent.
      const tagged = new Set();
      const escaped = String(value).replace(/"/g, '\\"');
      for (let i = 0; i < entIds.length; i += 50) {
        const chunk = entIds.slice(i, i + 50);
        const resp = await withApiRetry(
          () => axios.post(
            `https://${tenantApiHost(tenant)}/v2026/search`,
            {
              indices: ["entitlements"],
              query: { query: `id:(${chunk.join(" OR ")}) AND @accessModelMetadata(key:${key} AND value:"${escaped}")` },
              queryResultFilter: { includes: ["id"] },
            },
            { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, params: { limit: 250 } }
          ),
          { label: `role ${role.id}: entitlements tagged ${key}:${value}` }
        );
        for (const d of resp.data || []) if (d.id) tagged.add(d.id);
      }
      const missing = entIds.filter((id) => !tagged.has(id));
      if (missing.length > 0) {
        await tagAccessWithBoundaryValue(tenant, token, { key, entitlementIds: missing, roleIds: [], value, name, skipEnsure: true });
      }
      out.values.push({
        value,
        name,
        valueCreated,
        roleTagged,
        entitlementsChecked: entIds.length,
        entitlementsTagged: missing.map((id) => ({ id, name: entById.get(id) })),
      });
    }
  } catch (err) {
    console.error(`[insights] role ${role.id}: segment metadata check failed:`, err.response?.data || err.message);
    out.error = describeError(err);
  }
  return out;
}

/**
 * PATCH /api/roles/:id/entitlements
 * Body: { remove?: [entitlementId, ...], add?: [{ id, name }, ...] }
 */
app.patch("/api/roles/:id/entitlements", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  const remove = req.body?.remove;
  const add = req.body?.add;
  const hasRemove = Array.isArray(remove) && remove.length > 0;
  const hasAdd = Array.isArray(add) && add.length > 0;
  if (!hasRemove && !hasAdd) {
    return res.status(400).json({ error: "Provide a non-empty remove and/or add array." });
  }
  if (hasAdd && add.some((e) => !e?.id || !e?.name)) {
    return res.status(400).json({ error: "Each item in add must have an id and a name." });
  }

  try {
    const token = await sessionToken(session);
    // Invariant: non-common roles never carry entitlements a common role
    // grants for the same users.
    //  - Adding to a NON-common role: entries an applicable common role
    //    already grants are dropped from the add (they're birthright).
    //  - Adding to a COMMON role: the added entitlements are removed from
    //    every role whose population the common role covers.
    let effectiveAdd = add;
    let isCommonTarget = false;
    if (hasAdd) {
      const commonIds = await getCommonAccessRoleIds(tenant, token).catch(() => new Set());
      isCommonTarget = commonIds.has(req.params.id);
      if (!isCommonTarget && commonIds.size > 0) {
        const targetRole = await iscGet(tenant, token, `/v2026/roles/${req.params.id}`);
        const summaries = await fetchCommonAccessRoleSummaries(tenant, token).catch(() => []);
        const birthright = filterApplicableCommonAccessEntIds(targetRole.membership, summaries, req.params.id);
        effectiveAdd = add.filter((e) => !birthright.has(e.id));
        if (effectiveAdd.length < add.length) {
          console.log(`[roles] add to ${req.params.id}: dropped ${add.length - effectiveAdd.length} entitlement(s) already granted by common access`);
        }
      }
    }
    const hasEffective = (effectiveAdd?.length || 0) > 0 || hasRemove;
    const result = hasEffective
      ? await patchRoleEntitlements(tenant, token, req.params.id, { add: effectiveAdd, remove })
      : await iscGet(tenant, token, `/v2026/roles/${req.params.id}`);
    if ((effectiveAdd?.length || 0) > 0) {
      await tagEntitlementsWithRoleBoundaryValues(tenant, token, req.params.id, effectiveAdd.map((e) => e.id));
    }
    if (isCommonTarget && (effectiveAdd?.length || 0) > 0) {
      const all = await fetchAllRolesWithCriteria(tenant, token).catch(() => []);
      const commonIds = await getCommonAccessRoleIds(tenant, token).catch(() => new Set());
      const candidates = all.map((r) => r.id).filter((id) => !commonIds.has(id));
      await removeAcceptedCommonEntsFromContextRoles(tenant, token, req.params.id, effectiveAdd.map((e) => e.id), candidates);
    }
    res.json(result);
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[roles] update entitlements failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/**
 * PATCH /api/access-profiles/:id
 * Body: any of { name, description, owner: {id,name}, additionalOwners:
 * [{type,id,name}], enabled, requestable } — additionalOwners follows the
 * same rule as roles: several IDENTITY entries, or one GOVERNANCE_GROUP.
 * — same JSON Patch approach as PATCH /api/roles/:id (SailPoint requires
 * the JSON Patch content type here too — verified live that a plain
 * application/json PATCH is rejected with 415, same as roles), not routed
 * through the generic /api/isc/* proxy for that reason.
 */
app.patch("/api/access-profiles/:id", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  const { name, description, owner, additionalOwners, enabled, requestable } = req.body || {};

  const ops = [];
  if (additionalOwners !== undefined) {
    const err = additionalOwnersError(additionalOwners);
    if (err) return res.status(400).json({ error: err });
    ops.push({ op: "replace", path: "/additionalOwners", value: additionalOwners.map((o) => ({ type: o.type, id: o.id, name: o.name })) });
  }
  if (name !== undefined) {
    if (!name || !name.trim()) return res.status(400).json({ error: "name can't be empty." });
    ops.push({ op: "replace", path: "/name", value: name });
  }
  if (description !== undefined) {
    ops.push({ op: "replace", path: "/description", value: description });
  }
  if (owner !== undefined) {
    if (!owner?.id) return res.status(400).json({ error: "owner must have an id." });
    ops.push({ op: "replace", path: "/owner", value: { type: "IDENTITY", id: owner.id, name: owner.name } });
  }
  if (enabled !== undefined) {
    ops.push({ op: "replace", path: "/enabled", value: !!enabled });
  }
  if (requestable !== undefined) {
    ops.push({ op: "replace", path: "/requestable", value: !!requestable });
  }
  if (ops.length === 0) {
    return res.status(400).json({ error: "Provide at least one field to update." });
  }

  try {
    const token = await sessionToken(session);
    const resp = await axios.patch(
      `https://${tenantApiHost(tenant)}/v2026/access-profiles/${req.params.id}`,
      ops,
      { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json-patch+json" } }
    );
    res.json(resp.data);
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[access-profiles] edit failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/**
 * POST /api/access-profiles
 * Body: { name, owner: {id}, sourceId, entitlementIds?: string[] }
 * Requestable and Enabled both default false — this app's create form
 * doesn't collect either, matching the request that new access profiles
 * start inactive/non-requestable until deliberately turned on.
 */
app.post("/api/access-profiles", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  const name = String(req.body?.name || "").trim();
  const ownerId = req.body?.owner?.id;
  const sourceId = req.body?.sourceId;
  const entitlementIds = Array.isArray(req.body?.entitlementIds) ? req.body.entitlementIds : [];
  if (!name) return res.status(400).json({ error: "name is required." });
  if (!ownerId) return res.status(400).json({ error: "owner is required." });
  if (!sourceId) return res.status(400).json({ error: "source is required." });

  try {
    const token = await sessionToken(session);
    const resp = await axios.post(
      `https://${tenantApiHost(tenant)}/v2026/access-profiles`,
      {
        name,
        owner: { type: "IDENTITY", id: ownerId },
        source: { type: "SOURCE", id: sourceId },
        entitlements: entitlementIds.map((id) => ({ type: "ENTITLEMENT", id })),
        enabled: false,
        requestable: false,
      },
      { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }
    );
    res.status(201).json(resp.data);
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[access-profiles] create failed:", err.response?.data || err.message);
    res.status(status).json({ error: err.response?.data?.messages?.[0]?.text || describeError(err) });
  }
});

// Shared by the single-access-profile route and its bulk generate-all
// counterpart — fetches one access profile's data and asks Claude for a
// description grounded in it, without writing anything back. Throws on
// failure; callers decide how to surface that (500 for the single route, a
// per-profile error entry for the bulk one).
async function generateAccessProfileDescriptionText(tenant, token, profileId) {
  const profile = await withApiRetry(() => iscGet(tenant, token, `/v2026/access-profiles/${profileId}`), { label: `generate-description: fetch access profile ${profileId}` });

  const facts = [
    `Access profile name: ${profile.name}`,
    `Source: ${profile.source?.name || "unknown"}`,
    `Requestable: ${profile.requestable ? "yes" : "no"}`,
    // A disabled access profile can't actually be requested regardless of
    // the requestable flag — worth stating explicitly rather than relying
    // on the model to infer it from "Enabled: no" alone.
    `Enabled: ${profile.enabled ? "yes" : "no"}${profile.enabled ? "" : " — disabled, so it currently cannot be requested even if marked requestable"}`,
    `Entitlements (${(profile.entitlements || []).length}): ${(profile.entitlements || []).map((e) => e.name).join(", ") || "none"}`,
  ];
  const regulatory = (profile.accessModelMetadata?.attributes || []).find((a) => a.key === "iscRegulatory");
  if (regulatory?.values?.length) facts.push(`Regulatory scope: ${regulatory.values.map((v) => v.name).join(", ")}`);

  return generateDescriptionFromFacts(facts, "This Access Profile");
}

/**
 * POST /api/access-profiles/:id/generate-description
 * Header: x-sp-session
 * Same idea as POST /api/roles/:id/generate-description: asks Claude for a
 * description grounded in the access profile's actual current data (source,
 * entitlements, requestable/enabled state), never writes anything itself —
 * the client shows the suggestion alongside the current description and
 * applies it via the existing PATCH .../access-profiles/:id route once the
 * user confirms.
 */
app.post("/api/access-profiles/:id/generate-description", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;

  if (!aiConfigured()) {
    return res.status(503).json({ error: "AI description generation isn't configured on this server." });
  }

  try {
    const token = await sessionToken(session);
    const description = await generateAccessProfileDescriptionText(tenant, token, req.params.id);
    res.json({ description });
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[access-profiles] generate-description failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/**
 * POST /api/insights/access-profile-descriptions/generate-all
 * Header: x-sp-session
 * Body: { accessProfileIds: string[] }
 * Same pattern as POST /api/insights/role-descriptions/generate-all —
 * bounded concurrency, continues past individual failures, returns
 * suggestions only (nothing written). Each result is keyed "roleId" (not
 * "profileId") so the client can reuse BulkDescriptionReviewSheet as-is.
 */
app.post("/api/insights/access-profile-descriptions/generate-all", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  const accessProfileIds = req.body?.accessProfileIds;
  if (!Array.isArray(accessProfileIds) || accessProfileIds.length === 0) {
    return res.status(400).json({ error: "accessProfileIds must be a non-empty array." });
  }
  if (!aiConfigured()) {
    return res.status(503).json({ error: "AI description generation isn't configured on this server." });
  }

  try {
    const token = await sessionToken(session);
    const results = await mapWithConcurrency(accessProfileIds, 3, async (profileId) => {
      try {
        const description = await generateAccessProfileDescriptionText(tenant, token, profileId);
        return { roleId: profileId, description };
      } catch (err) {
        console.error(`[insights] access-profile-descriptions generate-all: profile ${profileId} failed:`, err.response?.data || err.message);
        return { roleId: profileId, error: describeError(err) };
      }
    });
    res.json({ results });
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[insights] access-profile-descriptions generate-all failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/**
 * PATCH /api/access-profiles/:id/entitlements
 * Body: { remove?: [entitlementId, ...], add?: [{ id, name }, ...] }
 * An access profile can only hold entitlements from its own source —
 * verified live that adding one from a different source 400s with
 * "Illegal attempt to modify ENTITLEMENT field" — ISC enforces that
 * itself, so this route doesn't duplicate the check; the client-side
 * picker just scopes its search to the profile's own source so the
 * error path is rarely hit in practice.
 */
app.patch("/api/access-profiles/:id/entitlements", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  const remove = req.body?.remove;
  const add = req.body?.add;
  const hasRemove = Array.isArray(remove) && remove.length > 0;
  const hasAdd = Array.isArray(add) && add.length > 0;
  if (!hasRemove && !hasAdd) {
    return res.status(400).json({ error: "Provide a non-empty remove and/or add array." });
  }
  if (hasAdd && add.some((e) => !e?.id || !e?.name)) {
    return res.status(400).json({ error: "Each item in add must have an id and a name." });
  }

  try {
    const token = await sessionToken(session);
    const profile = await iscGet(tenant, token, `/v2026/access-profiles/${req.params.id}`);
    const removeSet = new Set(hasRemove ? remove : []);
    let nextEntitlements = (profile.entitlements || []).filter((e) => !removeSet.has(e.id));
    if (hasAdd) {
      const existingIds = new Set(nextEntitlements.map((e) => e.id));
      const toAdd = add.filter((e) => !existingIds.has(e.id)).map((e) => ({ id: e.id, name: e.name, type: "ENTITLEMENT" }));
      nextEntitlements = [...nextEntitlements, ...toAdd];
    }
    const resp = await axios.patch(
      `https://${tenantApiHost(tenant)}/v2026/access-profiles/${req.params.id}`,
      [{ op: "replace", path: "/entitlements", value: nextEntitlements }],
      { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json-patch+json" } }
    );
    res.json(resp.data);
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[access-profiles] update entitlements failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/**
 * PATCH /api/access-profiles/:id/enabled
 * Body: { enabled: boolean }
 * Same JSON Patch content-type requirement as roles' own /enabled route —
 * verified live (toggled true then back to false against a real access
 * profile).
 */
app.patch("/api/access-profiles/:id/enabled", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  const { enabled } = req.body || {};
  if (typeof enabled !== "boolean") {
    return res.status(400).json({ error: "enabled must be a boolean." });
  }

  try {
    const token = await sessionToken(session);
    const resp = await axios.patch(
      `https://${tenantApiHost(tenant)}/v2026/access-profiles/${req.params.id}`,
      [{ op: "replace", path: "/enabled", value: enabled }],
      { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json-patch+json" } }
    );
    res.json(resp.data);
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[access-profiles] enabled toggle failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/**
 * PATCH /api/roles/:id/members
 * Body: { add?: [{id,name}, ...], remove?: [identityId, ...] }
 *
 * Only works for a role with no membership rule (criteria) — SailPoint's
 * IDENTITY_LIST membership type, the explicit-list alternative to a
 * criteria-based STANDARD rule. A criteria-driven role's members are
 * computed automatically; PATCHing /membership on one of those would
 * replace the rule itself, not just add/remove people, so this refuses to
 * touch a role that has one.
 */
app.patch("/api/roles/:id/members", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  const add = req.body?.add;
  const remove = req.body?.remove;
  const hasAdd = Array.isArray(add) && add.length > 0;
  const hasRemove = Array.isArray(remove) && remove.length > 0;
  if (!hasAdd && !hasRemove) {
    return res.status(400).json({ error: "Provide a non-empty add and/or remove array." });
  }
  if (hasAdd && add.some((i) => !i?.id)) {
    return res.status(400).json({ error: "Each item in add must have an id." });
  }

  try {
    const token = await sessionToken(session);
    const role = await iscGet(tenant, token, `/v2026/roles/${req.params.id}`);
    if (role.membership?.criteria) {
      return res.status(400).json({ error: "This role has a membership rule — members are computed automatically and can't be edited directly." });
    }
    const removeSet = new Set(hasRemove ? remove : []);
    let nextIdentities = (role.membership?.identities || []).filter((i) => !removeSet.has(i.id));
    if (hasAdd) {
      const existingIds = new Set(nextIdentities.map((i) => i.id));
      const toAdd = add.filter((i) => !existingIds.has(i.id)).map((i) => ({ type: "IDENTITY", id: i.id, name: i.name || null }));
      nextIdentities = [...nextIdentities, ...toAdd];
    }
    // ISC rejects an IDENTITY_LIST membership with an empty identities array
    // ("Required field membership.identities was missing or empty") —
    // removing the last member has to drop membership back to null (no
    // rule at all) instead, verified live.
    const membershipValue = nextIdentities.length > 0
      ? { type: "IDENTITY_LIST", criteria: null, identities: nextIdentities }
      : null;
    const resp = await axios.patch(
      `https://${tenantApiHost(tenant)}/v2026/roles/${req.params.id}`,
      [{ op: "replace", path: "/membership", value: membershipValue }],
      { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json-patch+json" } }
    );
    res.json(resp.data);
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[roles] members patch failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/**
 * GET /api/roles/:id/rule-members
 * Query: limit, offset, query
 * Lists identities that actually MATCH the role's membership rule,
 * evaluated live against current identity attributes — not SailPoint's
 * search index of "who currently has this access" (the two can disagree:
 * search-index lag, or access simply not provisioned/deprovisioned yet).
 * The membership rule is the live, authoritative definition of who
 * belongs, so the Role Detail screen's Members tab uses this instead.
 * Falls back to the role's own IDENTITY_LIST (membership.identities) when
 * it has no criteria — same convention findRoleMembers uses for Role
 * Evaluation.
 */
app.get("/api/roles/:id/rule-members", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  // Each call re-evaluates the rule against every identity and then slices,
  // so paging through a big role costs a full scan per page. The printout
  // needs every member at once, hence the higher ceiling — one scan, one
  // response — while the screen keeps asking for its own page size.
  const limit = Math.min(Number(req.query.limit) || 50, 2500);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const query = typeof req.query.query === "string" ? req.query.query.trim() : "";

  try {
    const token = await sessionToken(session);
    const role = await iscGet(tenant, token, `/v2026/roles/${req.params.id}`);
    const result = await evaluateRoleMembershipMembers(tenant, token, role.membership, { query, limit, offset });
    res.json(result);
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[roles] rule-members failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/**
 * GET /api/roles/:id/dimensions/:dimensionId/rule-members
 * Query: limit, offset, query
 * Same live membership-rule evaluation as /rule-members above, scoped to
 * one dimension. A dimension's own membership criteria only ever encodes
 * the one attribute it varies by (e.g. jobTitle = "Payroll Analyst I") —
 * evaluating it alone would pull in identities outside the base role's
 * actual population entirely (verified live elsewhere in this app — see
 * evaluateDimensionEntitlements's own reasoning). Real dimension
 * membership is the base role's own membership AND this dimension's, so
 * both are intersected here when both are criteria-based.
 */
app.get("/api/roles/:id/dimensions/:dimensionId/rule-members", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  // Each call re-evaluates the rule against every identity and then slices,
  // so paging through a big role costs a full scan per page. The printout
  // needs every member at once, hence the higher ceiling — one scan, one
  // response — while the screen keeps asking for its own page size.
  const limit = Math.min(Number(req.query.limit) || 50, 2500);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const query = typeof req.query.query === "string" ? req.query.query.trim() : "";

  try {
    const token = await sessionToken(session);
    const [role, dimension] = await Promise.all([
      iscGet(tenant, token, `/v2026/roles/${req.params.id}`),
      iscGet(tenant, token, `/v2026/roles/${req.params.id}/dimensions/${req.params.dimensionId}`),
    ]);
    const combinedMembership = (role.membership?.criteria && dimension.membership?.criteria)
      ? {
          criteria: {
            operation: "AND", key: null, values: null, stringValue: null,
            children: [role.membership.criteria, dimension.membership.criteria],
          },
        }
      : dimension.membership;
    const result = await evaluateRoleMembershipMembers(tenant, token, combinedMembership, { query, limit, offset });
    res.json(result);
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[roles] dimension rule-members failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/**
 * PATCH /api/roles/:id/dimensions/:dimensionId/entitlements
 * PATCH /api/roles/:id/dimensions/:dimensionId
 * Body: { name?, attrKey?, value? } — attrKey/value must both be present
 * together (rebuilds the dimension's membership as a single STANDARD/
 * EQUALS rule, same shape createRoleDimensionOnServer builds) or both
 * omitted (rename only).
 */
app.patch("/api/roles/:id/dimensions/:dimensionId", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  const { name, attrKey, value } = req.body || {};
  if (name === undefined && attrKey === undefined && value === undefined) {
    return res.status(400).json({ error: "Provide name and/or attrKey+value." });
  }
  if ((attrKey === undefined) !== (value === undefined)) {
    return res.status(400).json({ error: "attrKey and value must be provided together." });
  }
  if (name !== undefined && !name.trim()) {
    return res.status(400).json({ error: "name can't be empty." });
  }

  const ops = [];
  if (name !== undefined) ops.push({ op: "replace", path: "/name", value: name });
  if (attrKey !== undefined) {
    ops.push({
      op: "replace",
      path: "/membership",
      value: {
        type: "STANDARD",
        criteria: {
          operation: "AND",
          key: null,
          stringValue: "",
          children: [{
            operation: "EQUALS",
            key: { type: "IDENTITY", property: `attribute.${attrKey}`, sourceId: null },
            stringValue: value,
            children: null,
          }],
        },
      },
    });
  }

  try {
    const token = await sessionToken(session);
    const resp = await axios.patch(
      `https://${tenantApiHost(tenant)}/v2026/roles/${req.params.id}/dimensions/${req.params.dimensionId}`,
      ops,
      { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json-patch+json" } }
    );
    res.json(resp.data);
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[roles] edit dimension failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/**
 * PATCH /api/roles/:id/dimensions/:dimensionId/entitlements
 * Body: { remove?: [entitlementId, ...], add?: [{ id, name }, ...] }
 */
app.patch("/api/roles/:id/dimensions/:dimensionId/entitlements", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  const remove = req.body?.remove;
  const add = req.body?.add;
  const hasRemove = Array.isArray(remove) && remove.length > 0;
  const hasAdd = Array.isArray(add) && add.length > 0;
  if (!hasRemove && !hasAdd) {
    return res.status(400).json({ error: "Provide a non-empty remove and/or add array." });
  }
  if (hasAdd && add.some((e) => !e?.id || !e?.name)) {
    return res.status(400).json({ error: "Each item in add must have an id and a name." });
  }

  try {
    const token = await sessionToken(session);
    const result = await patchDimensionEntitlements(tenant, token, req.params.id, req.params.dimensionId, { add, remove });
    if (hasAdd) {
      await tagEntitlementsWithRoleBoundaryValues(tenant, token, req.params.id, add.map((e) => e.id));
    }
    res.json(result);
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[roles] update dimension entitlements failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/**
 * POST /api/roles/:id/dimensions
 * Body: { name, description?, attrKey, value, entitlements: [{ id, name }, ...] }
 */
app.post("/api/roles/:id/dimensions", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  const { name, description, attrKey, value, entitlements } = req.body || {};
  if (!name || !attrKey || !value) {
    return res.status(400).json({ error: "name, attrKey, and value are required." });
  }
  if (entitlements && (!Array.isArray(entitlements) || entitlements.some((e) => !e?.id || !e?.name))) {
    return res.status(400).json({ error: "entitlements must be an array of { id, name }." });
  }

  try {
    const token = await sessionToken(session);
    const result = await createRoleDimensionOnServer(tenant, token, req.params.id, { name, description, attrKey, value, entitlements });
    if (Array.isArray(entitlements) && entitlements.length > 0) {
      await tagEntitlementsWithRoleBoundaryValues(tenant, token, req.params.id, entitlements.map((e) => e.id));
    }
    res.json(result);
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[roles] create dimension failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/**
 * DELETE /api/roles/:id/dimensions/:dimensionId
 * Verified live against a throwaway test dimension: ISC returns 204 and the
 * dimension is gone from the role's /dimensions list immediately.
 */
app.delete("/api/roles/:id/dimensions/:dimensionId", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;

  try {
    const token = await sessionToken(session);
    await axios.delete(
      `https://${tenantApiHost(tenant)}/v2026/roles/${req.params.id}/dimensions/${req.params.dimensionId}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    res.status(204).end();
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[roles] delete dimension failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

// ─── Apply role changes (Role Propagation) ───────────────────────────────────
// Creating, editing, enabling/disabling, or deleting a role takes effect
// immediately in the role's own definition, but a member's actual granted
// access only catches up once SailPoint's Role Propagation job runs — that's
// when role/dimension membership criteria get (re-)evaluated tenant-wide and
// access is provisioned or revoked accordingly.
//
// This is a separate host per tenant, not /v2026 on the usual API host, and
// requires the Experimental opt-in header. Verified live:
//   POST {tenant}.api.identitynow-demo.com/role-propagation/v1  (empty body)
//     -> 202 { rolePropagationId }
//     -> 400 "role propagation already in progress" if one is already running
//   GET  .../role-propagation/v1/{id}/status
//     -> { id, status: "RUNNING"|..., executionStage, launched, launchedBy }

const ROLE_PROPAGATION_HEADERS = (token) => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
  "X-SailPoint-Experimental": "true",
});

/**
 * POST /api/roles/apply-changes
 * Header: x-sp-session
 * Starts a tenant-wide role propagation run. Returns the propagation id to
 * poll via GET /api/roles/apply-changes/:id/status.
 */
app.post("/api/roles/apply-changes", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;

  try {
    const token = await sessionToken(session);
    const resp = await axios.post(
      `https://${tenantApiHost(tenant)}/role-propagation/v1`,
      {},
      { headers: ROLE_PROPAGATION_HEADERS(token) }
    );
    res.status(202).json(resp.data);
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[roles] apply-changes failed:", err.response?.data || err.message);
    res.status(status).json({ error: err.response?.data?.messages?.[0]?.text || describeError(err) });
  }
});

/** GET /api/roles/apply-changes/:id/status — progress of a propagation run started above. */
app.get("/api/roles/apply-changes/:id/status", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;

  try {
    const token = await sessionToken(session);
    const resp = await axios.get(
      `https://${tenantApiHost(tenant)}/role-propagation/v1/${req.params.id}/status`,
      { headers: ROLE_PROPAGATION_HEADERS(token) }
    );
    res.json(resp.data);
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[roles] apply-changes status failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/**
 * GET /api/roles/propagation-running
 * Header: x-sp-session
 * Whether a tenant-wide Role Propagation run is currently in progress —
 * regardless of whether it was started from this app or ISC's own UI. Used
 * to banner the Roles list, since a role's membership/enablement changes
 * aren't actually reflected in who holds it until propagation completes.
 */
app.get("/api/roles/propagation-running", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;

  try {
    const token = await sessionToken(session);
    const resp = await axios.get(
      `https://${tenantApiHost(tenant)}/role-propagation/v1/is-running`,
      { headers: ROLE_PROPAGATION_HEADERS(token) }
    );
    res.json(resp.data);
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[roles] propagation-running check failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/**
 * GET /api/identities/:id/access?type=ROLE|ACCESS_PROFILE
 * Header: x-sp-session
 * The transactional GET /identities/:id doesn't carry assigned access — only
 * the Search API's denormalized identity document does, as an `access`
 * array mixing roles/access profiles/entitlements together (each tagged
 * with a `type`). Filters that array to just the requested type, view-only
 * (name/description/source/owner) for the Identity Detail Roles/Access
 * Profiles tabs.
 */
app.get("/api/identities/:id/access", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  const type = String(req.query.type || "").toUpperCase();
  if (!["ROLE", "ACCESS_PROFILE"].includes(type)) {
    return res.status(400).json({ error: "type must be ROLE or ACCESS_PROFILE." });
  }
  try {
    const token = await sessionToken(session);
    const resp = await axios.post(
      `https://${tenantApiHost(tenant)}/v2026/search`,
      { indices: ["identities"], query: { query: `id:"${req.params.id}"` } },
      { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }
    );
    const access = (resp.data?.[0]?.access || []).filter((a) => a.type === type);
    access.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    res.json(access);
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[identities] access failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

function escapeLuceneText(s) {
  return String(s).replace(/["\\]/g, "\\$&");
}

// For a term dropped in UNQUOTED (e.g. wrapped in our own *wildcards*) —
// escapes every Lucene special character, including * and ? themselves, so
// typed wildcard/operator characters in the value are treated as literal
// text to search for rather than query syntax.
function escapeLuceneWildcardTerm(s) {
  return String(s).replace(/([+\-!(){}[\]^"~*?:\\&|/])/g, "\\$1");
}

// Only letters/digits/underscore/dot survive — this goes straight into an
// unquoted `attributes.<key>:` clause, so anything else could break the
// query (or, unescaped, inject additional clauses).
function sanitizeAttributeKey(key) {
  return String(key).replace(/[^a-zA-Z0-9_.]/g, "");
}

// /public-identities rejects identityProfile/attribute/lifecycle filters as
// "not queryable" (verified live) — the Search API's identities index
// carries the same data and supports filtering on all of it, so the
// Identities list's filter pills are built on this instead.
function buildIdentitySearchQuery({ query, identityProfileId, lifecycleState, attributeKey, attributeValue }) {
  const clauses = [];
  if (query) {
    const q = escapeLuceneText(query);
    clauses.push(`(name:${q}* OR displayName:${q}* OR email:${q}*)`);
  }
  if (identityProfileId) {
    clauses.push(`identityProfile.id:"${escapeLuceneText(identityProfileId)}"`);
  }
  if (lifecycleState) {
    const state = String(lifecycleState).toLowerCase() === "inactive" ? "inactive" : "active";
    clauses.push(`attributes.cloudLifecycleState:${state}`);
  }
  if (attributeKey && attributeValue) {
    const key = sanitizeAttributeKey(attributeKey);
    // Contains match (verified live: attributes.department:*Operations*
    // matches "Operations - Dept 2", "Operations - Dept 7", etc.) rather
    // than requiring the exact full value — e.g. "Eng" should match both
    // "Engineer" and "Engineering". Note this is case-sensitive (verified
    // live: a lowercase wildcard term matched nothing against mixed-case
    // values), same as the exact-match version this replaced.
    if (key) clauses.push(`attributes.${key}:*${escapeLuceneWildcardTerm(attributeValue)}*`);
  }
  return clauses.length > 0 ? clauses.join(" AND ") : "*";
}

// cloudLifecycleState missing/null (common for service/test accounts on
// this tenant) is treated as active, same default the old /public-identities-
// based isActive/inactive check effectively had — only an explicit
// "inactive" value flips it.
function normalizeSearchIdentity(doc) {
  const attrs = doc.attributes || {};
  return {
    id: doc.id,
    name: doc.displayName || doc.name,
    alias: doc.name,
    email: doc.email || null,
    active: (attrs.cloudLifecycleState || "").toLowerCase() !== "inactive",
    identityProfile: doc.identityProfile ? { id: doc.identityProfile.id, name: doc.identityProfile.name } : null,
    attributes: attrs,
  };
}

/**
 * GET /api/identities
 * Header: x-sp-session
 * Query: limit, query (name/displayName/email search), identityProfileId,
 *        lifecycleState (ACTIVE|INACTIVE), attributeKey + attributeValue
 * Single page only, no offset paging — this tenant can have tens of
 * thousands of identities, so (same as before) the list narrows via search/
 * filters rather than paging through everything.
 */
app.get("/api/identities", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 250);
  // Search's offset paging stops at 10,000 (offset + limit); beyond that a
  // reader would need the search box anyway.
  const offset = Math.min(Math.max(parseInt(req.query.offset, 10) || 0, 0), 10000 - limit);
  try {
    const token = await sessionToken(session);
    const luceneQuery = buildIdentitySearchQuery(req.query);
    const resp = await withApiRetry(
      () => axios.post(
        `https://${tenantApiHost(tenant)}/v2026/search`,
        {
          indices: ["identities"],
          query: { query: luceneQuery },
          // Alphabetical — every list in the app is shown sorted; "id" order
          // looked random to a reader.
          sort: ["name"],
          queryResultFilter: { includes: ["id", "name", "displayName", "email", "attributes", "identityProfile"] },
        },
        { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, params: { limit, offset, count: true } }
      ),
      { label: "identities: search" }
    );
    // The real total for THIS query (search + filters), for the pager. The
    // body stays a plain array — a dozen pickers read it that way.
    const total = resp.headers?.["x-total-count"];
    if (total != null) res.set("X-Total-Count", String(total));
    res.json((resp.data || []).map(normalizeSearchIdentity));
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[identities] search failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/**
 * GET /api/identity-profiles
 * Header: x-sp-session
 * Minimal id/name list, used to populate the Identities list's Identity
 * Profile filter pill — the option list comes straight from ISC's own
 * profile registry, not derived by scanning identities.
 */
app.get("/api/identity-profiles", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  try {
    const token = await sessionToken(session);
    const profiles = await withApiRetry(
      () => iscGet(tenant, token, "/v2026/identity-profiles", { limit: 250, sorters: "name" }),
      { label: "identity-profiles: list" }
    );
    res.json(profiles.map((p) => ({ id: p.id, name: p.name })).sort((a, b) => a.name.localeCompare(b.name)));
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[identity-profiles] list failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/**
 * DELETE /api/identity-profiles/:id
 * Header: x-sp-session
 * Used by the Source Detail delete flow to remove a source's Identity
 * Profile first — ISC won't delete a Source at all while an Identity
 * Profile still names it as authoritativeSource (verified live: "Unable to
 * delete Source ... because it is in use by [identityProfiles, ...]").
 */
app.delete("/api/identity-profiles/:id", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  try {
    const token = await sessionToken(session);
    await axios.delete(
      `https://${tenantApiHost(tenant)}/v2026/identity-profiles/${req.params.id}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    res.status(204).end();
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[identity-profiles] delete failed:", err.response?.data || err.message);
    res.status(status).json({ error: err.response?.data?.messages?.[0]?.text || describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/**
 * POST /api/identity-profiles/:id/process-identities
 * Header: x-sp-session
 * ISC's own "Apply Changes" for an Identity Profile — re-evaluates every
 * identity under the profile against its current attribute mappings and
 * lifecycle states (POST .../process-identities -> 202, verified live; the
 * same call the create/sync flows above make on their own). Asynchronous:
 * a 202 means ISC accepted the job, not that identities are updated yet.
 */
app.post("/api/identity-profiles/:id/process-identities", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  if (!/^[A-Za-z0-9-]+$/.test(req.params.id)) return res.status(400).json({ error: "Invalid identity profile id." });
  try {
    const token = await sessionToken(session);
    await axios.post(
      `https://${tenantApiHost(tenant)}/v2026/identity-profiles/${req.params.id}/process-identities`,
      {},
      { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }
    );
    console.log(`[identity-profiles] ${tenant} process-identities started for ${req.params.id} (by ${session.username || "unknown"})`);
    res.status(202).json({ accepted: true });
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[identity-profiles] process-identities failed:", err.response?.data || err.message);
    res.status(status).json({ error: err.response?.data?.messages?.[0]?.text || describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

// ─── Connector customizer scripts ────────────────────────────────────────────
// ISC keeps only a customizer's built image, never its source, so the script
// edited in the app lives here (per tenant + customizer) and every deploy
// rebuilds the ZIP from it — see customizerBundle.js for the build itself.
const { buildCustomizerZip, validateCustomizerScript, STARTER_CUSTOMIZER_SCRIPT, zipFiles } = require("./customizerBundle");
const customizerSources = createRecordStore(DATA_DIR, "connector-customizer-sources.json");
const customizerSourceKey = (tenant, id) => `${tenant}:${id}`;
const scriptHash = (script) => crypto.createHash("sha256").update(script).digest("hex");
const MAX_CUSTOMIZER_SCRIPT_CHARS = 500_000;

function customizerSourceResponse(record) {
  if (!record) return { script: STARTER_CUSTOMIZER_SCRIPT, stored: false, deployed: null, dirty: false };
  return {
    script: record.script,
    stored: true,
    updatedAt: record.updatedAt,
    updatedBy: record.updatedBy,
    deployed: record.deployed || null,
    // The saved draft differs from what was last built and uploaded.
    dirty: !record.deployed || record.deployed.hash !== scriptHash(record.script),
  };
}

/**
 * POST /api/connector-customizers/validate   { script }
 * Parse + static checks only; the script is never executed.
 */
app.post("/api/connector-customizers/validate", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  res.json(validateCustomizerScript(String(req.body?.script ?? "")));
});

/**
 * GET /api/connector-customizers/:id/source
 * The script stored for this customizer — or the starter template when the
 * app has none (":id" = "new", or a customizer built outside the app).
 */
app.get("/api/connector-customizers/:id/source", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const record = req.params.id === "new" ? null : await customizerSources.get(customizerSourceKey(session.tenant, req.params.id));
  res.json(customizerSourceResponse(record));
});

/**
 * PUT /api/connector-customizers/:id/source   { script }
 * Saves a draft without touching ISC.
 */
app.put("/api/connector-customizers/:id/source", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const script = String(req.body?.script ?? "");
  if (!script.trim()) return res.status(400).json({ error: "script is required" });
  if (script.length > MAX_CUSTOMIZER_SCRIPT_CHARS) return res.status(400).json({ error: "script is too large" });
  const key = customizerSourceKey(session.tenant, req.params.id);
  const record = { ...((await customizerSources.get(key)) || {}), script, updatedAt: new Date().toISOString(), updatedBy: session.username || null };
  await customizerSources.put(key, record);
  res.json(customizerSourceResponse(record));
});

/**
 * DELETE /api/connector-customizers/:id/source
 * Drops the stored script — called once the customizer itself is deleted.
 */
app.delete("/api/connector-customizers/:id/source", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  await customizerSources.delete(customizerSourceKey(session.tenant, req.params.id));
  res.status(204).end();
});

/**
 * POST /api/connector-customizers/:id/deploy   { script }
 * Validates the script, builds its ZIP and uploads it to ISC as the
 * customizer's next version (application/zip to …/versions — the same call
 * `sail conn customizers upload` makes), then records it as deployed.
 * Returns { version: <ISC's version object>, source: <as GET …/source> }.
 */
app.post("/api/connector-customizers/:id/deploy", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  const script = String(req.body?.script ?? "");
  if (script.length > MAX_CUSTOMIZER_SCRIPT_CHARS) return res.status(400).json({ error: "script is too large" });
  const validation = validateCustomizerScript(script);
  if (validation.state !== "OK") return res.status(422).json({ error: "The script did not pass validation.", validation });
  try {
    const token = await sessionToken(session);
    const zip = buildCustomizerZip(script);
    const iscResp = await axios.post(
      `https://${tenantApiHost(tenant)}/v2026/connector-customizers/${encodeURIComponent(req.params.id)}/versions`,
      zip,
      { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/zip", Accept: "application/json" }, maxBodyLength: Infinity }
    );
    const version = iscResp.data || {};
    console.log(`[connector-customizers] ${tenant} deployed ${req.params.id} as version ${version.version ?? "?"} (${zip.length} bytes) by ${session.username}`);
    const now = new Date().toISOString();
    const record = {
      script,
      updatedAt: now,
      updatedBy: session.username || null,
      deployed: { version: version.version ?? null, imageID: version.imageID ?? null, at: now, by: session.username || null, hash: scriptHash(script) },
    };
    await customizerSources.put(customizerSourceKey(tenant, req.params.id), record);
    res.json({ version, source: customizerSourceResponse(record) });
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[connector-customizers] deploy failed:", err.response?.data || err.message);
    res.status(status).json({ error: err.response?.data?.messages?.[0]?.text || describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

// ─── Generic SailPoint API proxy ─────────────────────────────────────────────

// Proxied endpoints ISC still marks experimental — it rejects them with
// "Experimental Header 'X-SailPoint-Experimental' is missing or invalid"
// unless the opt-in header is sent. (SaaS connector logs: Source > Logs;
// identity processing and attribute sync: the Activity tabs' Retry.)
const EXPERIMENTAL_PROXY_PATHS = /^\/v\d+\/(platform-logs\/|identities\/process$|identities\/[^/]+\/synchronize-attributes$|org-config$)/;

/**
 * ALL /api/isc/*
 * Header: x-sp-session
 * Proxies to: https://[tenant].api.identitynow-demo.com/v2026/*
 */
app.all("/api/isc/*", async (req, res) => {
  const session = await getSession(req);

  if (!session) return unauthorized(res);
  const { tenant } = session;

  try {
    const token = await sessionToken(session);

    // Strip /api/isc prefix to get the ISC path
    const iscPath = req.path.replace(/^\/api\/isc/, "");
    const url = `https://${tenantApiHost(tenant)}${iscPath}`;

    console.log(`[proxy request] ${req.method} ${url}`, req.query);

    const iscResp = await axios({
      method: req.method,
      url,
      params: req.query,
      data: ["POST", "PUT", "PATCH"].includes(req.method) ? req.body : undefined,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(EXPERIMENTAL_PROXY_PATHS.test(iscPath) ? { "X-SailPoint-Experimental": "true" } : {}),
      },
      validateStatus: () => true, // let us forward the real status
    });

    if (iscResp.status >= 400) {
      // Report the caller's authorities next to the failure — a 403 usually
      // means the token lacks ORG_ADMIN, which is invisible from the response
      // body alone. Full dumps are kept off: they flooded the log buffer and
      // pushed out the lines that actually explain failures.
      const detail = iscResp.data?.messages?.[0]?.text || iscResp.data?.detailCode || "";
      console.warn(
        `[proxy ${iscResp.status}] ${tenant} ${req.method} ${iscPath} — ${detail} ` +
        `| authorities=${JSON.stringify(session.authorities)} strong_auth=${session.strongAuth}` +
        ` service_credential=${await hasServiceCredential(tenant)}`
      );
    } else if (req.method === "POST" && /\/search$/.test(iscPath)) {
      const q = req.body?.query?.query;
      const n = Array.isArray(iscResp.data) ? iscResp.data.length : "?";
      console.log(`[proxy response] POST ${url} -> ${iscResp.status} (${n} docs) indices=${JSON.stringify(req.body?.indices)} query=${JSON.stringify(q)}`);
    } else {
      console.log(`[proxy response] ${req.method} ${url} -> ${iscResp.status}`);
    }

    // Role deletion now has its own dedicated route (DELETE /api/roles/:id,
    // for retry-on-429 — see there) instead of going through this generic
    // proxy, so the forgetFlaggedCommonAccessRole bookkeeping that used to
    // live here moved there with it.

    // Forward response headers that matter
    const forwardHeaders = ["content-type", "x-total-count", "link"];
    forwardHeaders.forEach((h) => {
      if (iscResp.headers[h]) res.set(h, iscResp.headers[h]);
    });

    res.status(iscResp.status).json(iscResp.data);
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    const msg = err.response?.data || err.message;
    console.error(`[proxy error] ${req.method} ${req.path}:`, msg);
    res.status(status).json({
      error: typeof msg === "string" ? msg : JSON.stringify(msg),
      ...(err.sessionExpired ? { sessionExpired: true } : {}),
    });
  }
});

// ─── Shared Insights helpers ──────────────────────────────────────────────────

async function iscGet(tenant, token, iscPath, params, extraHeaders) {
  const resp = await axios.get(`https://${tenantApiHost(tenant)}${iscPath}`, {
    params,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...extraHeaders },
  });
  return resp.data;
}

// /public-identities returns "status"/"identityState" as null for
// disabled/service/test accounts and "active"/"ACTIVE" for real active
// identities — cheaper to check here than fetching entitlements first.
function isActiveIdentity(idn) {
  return idn.status === "active" || idn.identityState === "ACTIVE";
}

/**
 * Pages through every identity matching `query` (default "*" = every
 * identity) via SailPoint's searchAfter cursor pagination against the
 * Search API's identities index — the only way to page an
 * Elasticsearch-backed index past its 10,000-record offset+limit window.
 * /v2026/public-identities' own offset pagination (used by Role Scan,
 * Skeleton Roles, and Schema Analysis) fails outright once a tenant has
 * 10,000+ identities: verified live, "Illegal value \"10250\" for field
 * \"offset + limit\"".
 *
 * Normalizes each Search identity document into the exact shape
 * /v2026/public-identities already returns, so every existing caller
 * (isActiveIdentity, and the attrs.find(a => a.key === X)?.value ||
 * "Unknown" pattern used throughout) works completely unchanged. Verified
 * live, field by field, against real identities that had every field
 * populated:
 *  - Search's own top-level `name` is the USERNAME (public-identities
 *    calls this `alias`) — `displayName` is the real display name
 *    (public-identities' own `name`). Using Search's `name` directly
 *    would silently show usernames everywhere a person's name displays.
 *  - Search's top-level `status` is ACCOUNT REGISTRATION status
 *    (UNREGISTERED/etc), unrelated to identity lifecycle — public-
 *    identities' `status`/`identityState` (active/ACTIVE) instead line up
 *    with Search's `attributes.cloudLifecycleState`/`attributes.identityState`.
 *  - `manager` (top-level) has the same {id, name} shape either way.
 *  - Search's `attributes` is a map that omits null-valued keys entirely,
 *    where public-identities always includes its 5 fixed keys (manager,
 *    jobTitle, department, country, location) with value:null when unset
 *    — restricted to that same 5-key set here (Search's raw map can carry
 *    many more tenant-specific attributes, but exposing those wasn't
 *    asked for and would change what Schema Analysis/Role Scan see today).
 *    A key missing from Search's map and a key present-but-null both
 *    resolve to "Unknown" downstream either way, so the two are
 *    equivalent as far as every existing caller is concerned.
 */
const PUBLIC_IDENTITY_ATTRIBUTE_KEYS = ["manager", "jobTitle", "department", "country", "location"];
// getToken is called fresh before every page (not resolved once up front)
// — a full scan of a large tenant can run long enough for a token to
// expire mid-scan, same reasoning as the per-page sessionToken() calls
// this replaces in runSkeletonScan/runRoleScan. Pass `async () => token`
// for a short-lived caller where that doesn't matter.
//
// onPage(normalizedPage, totalSoFar), if given, runs after each page is
// normalized (before it's appended) — return `false` from it to stop
// paging early (cancellation), same as the token functions/withApiRetry
// pattern used elsewhere for long-running scans. Used by callers that need
// per-page progress updates or a cancellation check mid-scan.
// includeAccess: true also requests each identity's full `access` array (the
// same field the Segments scan's fetchAssignedEntitlementsForCriteria reads)
// and narrows the response via queryResultFilter to just what's needed —
// letting a caller like Role Scan read every member's held entitlements
// straight off the page it already fetched, instead of a separate
// per-identity REST call for each one.
async function searchAllIdentities(tenant, getToken, { query = "*", pageSize = 250, onPage, includeAccess = false, accessTypes = null } = {}) {
  const identities = [];
  let searchAfter = null;
  while (true) {
    const token = await getToken();
    const body = { indices: ["identities"], query: { query }, sort: ["id"] };
    if (searchAfter) body.searchAfter = searchAfter;
    if (includeAccess || accessTypes) {
      body.queryResultFilter = { includes: ["id", "name", "displayName", "email", "manager", "attributes", "access"] };
    }
    const resp = await withApiRetry(
      () => axios.post(
        `https://${tenantApiHost(tenant)}/v2026/search`,
        body,
        { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, params: { limit: pageSize } }
      ),
      { label: "searchAllIdentities: search page" }
    );
    const page = resp.data || [];
    if (page.length === 0) break;
    const normalizedPage = page.map((doc) => {
      const attrsMap = doc.attributes || {};
      const normalized = {
        id: doc.id,
        name: doc.displayName || doc.name,
        email: doc.email || null,
        status: attrsMap.cloudLifecycleState || null,
        identityState: attrsMap.identityState || null,
        manager: doc.manager ? { id: doc.manager.id, name: doc.manager.name } : null,
        attributes: PUBLIC_IDENTITY_ATTRIBUTE_KEYS.map((key) => ({ key, value: attrsMap[key] ?? null })),
      };
      if (accessTypes) {
        // Broader than includeAccess: every listed access type, keeping the
        // type and granting source so a caller can group/label the items
        // (User Certifications lists roles, access profiles and
        // entitlements per identity).
        const wanted = new Set(accessTypes);
        normalized.access = (doc.access || [])
          .filter((a) => wanted.has(a.type))
          .map((a) => ({ id: a.id, type: a.type, name: a.displayName || a.name, source: a.source?.name || null, sourceId: a.source?.id || null }));
      } else if (includeAccess) {
        normalized.access = (doc.access || [])
          .filter((a) => a.type === "ENTITLEMENT")
          .map((e) => ({ id: e.id, name: e.name }));
      }
      return normalized;
    });
    identities.push(...normalizedPage);
    if (onPage) {
      const keepGoing = await onPage(normalizedPage, identities.length);
      if (keepGoing === false) break;
    }
    if (page.length < pageSize) break;
    searchAfter = [page[page.length - 1].id];
  }
  return identities;
}

/** Runs `fn` over `items` with at most `concurrency` in flight at once. */
async function mapWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

// ─── Role Insight: peer-group discovery ──────────────────────────────────────
// Groups identities that hold near-identical entitlement sets, names each
// group from its members' most common department + location, and can
// provision a real requestable Role from the access every member shares —
// so a new hire who matches the peer group gets the common items in one grant.

const ROLE_SCAN_IDENTITY_PAGE_SIZE = 250; // SailPoint's documented max page size

const roleScans = createRecordStore(DATA_DIR, "role-scans.json");

async function updateRoleScan(scanId, patch) {
  await roleScans.put(scanId, { ...(await roleScans.get(scanId)), ...patch });
}

// Identity attributes used to define peer groups, when no Schema Analysis
// has been run for the tenant yet (see getRoleScanAttributeKeys below). Any
// attribute keys present on the identity's `attributes` array can go here —
// these are also what gets written into the created role's membership
// criteria. Status/lifecycle-type attributes are excluded here on purpose:
// active/disabled is handled separately as the always-on lifecycleState-ACTIVE
// criterion (see create-role below), not as a peer-grouping dimension.
const PEER_GROUP_STATUS_ATTRIBUTE_KEYS = new Set([
  "status", "cloudStatus", "internalCloudStatus", "identityState",
  "cloudLifecycleState", "lifecycleState",
]);
const DEFAULT_PEER_GROUP_ATTRIBUTE_KEYS = ["department", "location"]
  .filter((k) => !PEER_GROUP_STATUS_ATTRIBUTE_KEYS.has(k));

// The attribute keys a role scan should bucket by: Schema Analysis's chosen
// top attributes for this tenant if it's been run (see the Configuration
// section further down), otherwise the department/location/jobTitle default.
// Computed once per scan and persisted on the scan record (see
// POST /role-scans) so a later create-role call uses the exact same keys the
// scan actually grouped by, even if Schema Analysis is re-run or re-ordered
// in between.
async function getRoleScanAttributeKeys(tenant) {
  const configured = ((await schemaAnalyses.get(tenant))?.topAttributes || [])
    .filter((k) => !PEER_GROUP_STATUS_ATTRIBUTE_KEYS.has(k));
  return configured.length > 0 ? configured : DEFAULT_PEER_GROUP_ATTRIBUTE_KEYS;
}

// Entitlements now come bundled on each identity's own Search API document
// (see searchAllIdentities's includeAccess option) instead of a separate
// per-identity REST call (/v2026/entitlements/identities/:id/entitlements) —
// same rework as the Segments scan's fetchAssignedEntitlementsForCriteria.
// That per-identity endpoint used to need its own retry loop because a scan
// of hundreds of identities running several concurrent calls at once would
// routinely 429 (verified live, with a real Retry-After
// header); reading access straight off the identity page it already fetched
// removes that failure mode entirely — a page that fails is retried as a
// whole by searchAllIdentities's own withApiRetry, same as it always was for
// the base identity listing.
function buildIdentityRoleProfileFromAccess(idn, attributeKeys) {
  const attrs = {};
  for (const key of attributeKeys) {
    attrs[key] = idn.attributes?.find((a) => a.key === key)?.value || "Unknown";
  }
  return {
    id: idn.id,
    name: idn.name,
    email: idn.email || null,
    managerName: idn.manager?.name || null,
    attrs,
    entitlements: idn.access || [],
    entitlementsFailed: false,
  };
}

const PEER_GROUP_MIN_SIZE = 3;

// Same "commonly held" bar Role Evaluation uses (see its own
// commonalityThreshold checks further down) — peer-group scanning used to
// require a strict 100% intersection across every member, which is a much
// higher bar and meant a freshly-created role's base entitlements
// routinely looked "wrong" the moment it was evaluated (evaluation would
// immediately flag real, widely-held access the scan never captured
// because one member out of many didn't happen to have it). Matching the
// threshold means a scan-created role and its first evaluation agree on
// what "shared" means. Default only — the tenant's own
// entitlementCommonalityThreshold setting (Mining Config) overrides this
// everywhere it's actually used; this constant is just the fallback for
// tenants that haven't set one yet.
const ROLE_SCAN_COMMON_THRESHOLD = 0.8;

/** Entitlement ids held by at least `threshold` of `members` (by count, not a strict intersection). */
function commonlyHeldEntitlementIds(members, threshold = ROLE_SCAN_COMMON_THRESHOLD) {
  const counts = new Map();
  for (const m of members) {
    for (const e of m.entitlements) counts.set(e.id, (counts.get(e.id) || 0) + 1);
  }
  const minCount = Math.ceil(members.length * threshold);
  const ids = new Set();
  for (const [id, count] of counts) {
    if (count >= minCount) ids.add(id);
  }
  return ids;
}

// Mining Config's Scope field is a raw ISC Search query (arbitrary Lucene),
// used as-is against the Search API to narrow which identities a scan
// considers (see fetchScopeIds). A role's own membership criteria can't
// express arbitrary Lucene, though — only a structured tree of IDENTITY
// attribute EQUALS leaves. Only the common case (a single attribute=value
// equality, however it's punctuated — "attributes.key:value" or
// "key=value.") can be translated; anything else (boolean combinations,
// no scope at all) isn't supported and the Common Access proposal is
// skipped rather than guessed at.
// Identity attribute keys are case-sensitive in ISC's own criteria schema
// (attribute.cloudLifecycleState, not attribute.CloudLifecycleState) — but
// a scope typed by hand into Mining Config isn't guaranteed to match that
// casing (verified live: this tenant's own stored scope is literally
// "CloudLifecycleState=active."). Only worth normalizing the one key this
// app actually defaults Scope to; any other attribute is used as typed.
const KNOWN_IDENTITY_ATTRIBUTE_KEYS = ["cloudLifecycleState"];
function normalizeScopeAttrKey(attrKey) {
  const known = KNOWN_IDENTITY_ATTRIBUTE_KEYS.find((k) => k.toLowerCase() === attrKey.toLowerCase());
  return known || attrKey;
}

function parseSimpleScopeCriteria(scopeQuery) {
  if (!scopeQuery || !scopeQuery.trim()) return null;
  const match = scopeQuery.trim().match(/^(?:attributes\.)?([\w.]+)\s*[:=]\s*"?([^".]+?)"?\.?$/i);
  if (!match) return null;
  return { attrKey: normalizeScopeAttrKey(match[1]), value: match[2] };
}

/**
 * Buckets profiles by the exact-match combination of every boundaryKey's
 * value (all keys together, like buildPeerGroups' most-specific combo — a
 * Multi-Company/Division Boundary of [company, division] partitions by the
 * (company, division) pair, not by company independent of division).
 * Profiles missing any boundary key's value are left out of every partition.
 */
function partitionProfilesByBoundary(profiles, boundaryKeys) {
  const buckets = new Map();
  for (const p of profiles) {
    const values = boundaryKeys.map((k) => p.attrs[k]);
    if (values.some((v) => !v || v === "Unknown")) continue;
    const key = values.join("||");
    if (!buckets.has(key)) buckets.set(key, { values, profiles: [] });
    buckets.get(key).profiles.push(p);
  }
  return [...buckets.values()];
}

/** All non-empty subsets of `keys`, e.g. [a,b] -> [[a],[b],[a,b]]. */
function nonEmptySubsets(keys) {
  const subsets = [];
  for (let mask = 1; mask < 1 << keys.length; mask++) {
    const subset = keys.filter((_, i) => mask & (1 << i));
    subsets.push(subset);
  }
  return subsets;
}

// Within a tier of equal-size combinations, department+location is tried
// before any other pair (e.g. department+jobTitle) — so when the broader
// single-attribute match doesn't hold (see buildPeerGroups below) and a
// 2-attribute combo has to be tried instead, department+location wins ties.
const PREFERRED_2ATTR_PAIR = ["department", "location"];
function comboPreferenceScore(combo) {
  return combo.length === 2 && PREFERRED_2ATTR_PAIR.every((k) => combo.includes(k)) ? 1 : 0;
}

/**
 * Buckets identities into peer groups by exact match on some combination of
 * `attributeKeys`, then — within each bucket — narrows to the entitlements
 * every member shares. EVERY bucket becomes a group: no minimum size, and
 * no requirement that its members share any access at all. A combination
 * that exists in the data is a real peer group whether or not anyone in it
 * happens to hold common entitlements, and it still needs a role (and,
 * where attributes vary, a dimension per value) so the role model covers
 * the whole population rather than only its well-provisioned parts —
 * explicit user instruction. A group with empty commonAccess simply
 * produces a membership-only role, which is a perfectly good placeholder to
 * attach access to later.
 *
 * With createDynamicRoles on, tries the BROADEST combination first (a single
 * shared attribute, e.g. just department) up to the most specific (all
 * attributes matching), so that members who share one attribute but vary on
 * the others are combined into one group — becoming a Dynamic role with a
 * dimension per varying attribute — instead of being fragmented into several
 * narrower groups. A more specific combination is only tried for members
 * left over once a broader one didn't claim them at all (in practice: their
 * value for the broader attribute is missing, so no bucket could form).
 * Within a tier, department+location is tried first (see
 * comboPreferenceScore).
 *
 * With createDynamicRoles off, only the single most-specific combination
 * (every attribute together) is tried — one group per unique combination of
 * values across all selected attributes, each with nothing left to vary by,
 * so every group becomes a plain (Standard) role.
 */
function buildPeerGroups(profiles, attributeKeys, createDynamicRoles = true, commonRoleEntIds = new Set(), commonalityThreshold = ROLE_SCAN_COMMON_THRESHOLD) {
  const combos = createDynamicRoles
    ? nonEmptySubsets(attributeKeys).sort((a, b) => {
        if (a.length !== b.length) return a.length - b.length;
        return comboPreferenceScore(b) - comboPreferenceScore(a);
      })
    : [attributeKeys];

  const assigned = new Set();
  const groups = [];
  let groupCounter = 0;

  for (const comboKeys of combos) {
    const buckets = new Map();
    for (const p of profiles) {
      if (assigned.has(p.id)) continue;
      const values = comboKeys.map((k) => p.attrs[k]);
      if (values.some((v) => v === "Unknown")) continue;
      const key = values.join("||");
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(p);
    }

    for (const members of buckets.values()) {
      // No minimum group size gate — every bucket with at least 1 member
      // becomes a group (same explicit instruction already applied to
      // Skeleton Roles: a peer group of 1 still gets a role). A solo
      // member has no peers to compute "commonly held" from, so their own
      // actual entitlements are used directly instead — same convention
      // Skeleton Roles' own sole-member case uses (see runSkeletonScan).

      // Membership (this check, group size, dimension member counts) uses
      // every member — a department or title is real regardless of how
      // sparse its access is. The entitlement-commonality math below,
      // though, excludes both members holding EXACTLY one entitlement (a
      // test/service account's single trivial shared entitlement
      // otherwise gets treated as "commonly held" and proposed for the
      // whole group) AND members holding ZERO — a brand-new identity
      // that hasn't been provisioned yet is not evidence that access
      // ISN'T commonly held, it just hasn't happened yet, and counting
      // them in the denominator would only understate real commonality
      // until every last new hire catches up (explicit user instruction).
      // Doesn't apply to a solo member — there's no group percentage to
      // dilute, and excluding their only real entitlement would leave a
      // genuinely access-holding person with an empty proposed role.
      let commonSig;
      if (members.length === 1) {
        commonSig = new Set(members[0].entitlements.map((e) => e.id));
      } else {
        const eligibleForProposal = members.filter((m) => m.entitlements.length > 1);
        commonSig = commonlyHeldEntitlementIds(eligibleForProposal, commonalityThreshold);
      }
      // Entitlements every member shares only because a common-access role
      // already grants them to everyone don't belong on a purpose-built
      // peer-group role — they're birthright access, not what makes this
      // group distinct. Stripped before the empty-check below so a group
      // whose only "shared access" was common access doesn't get created at
      // all.
      commonSig = new Set([...commonSig].filter((id) => !commonRoleEntIds.has(id)));
      // No "must share some access" gate. A combo that leaves attributes
      // unmatched forms a group regardless — the unmatched attributes become
      // dimensions, whose value-specific access is computed independently at
      // role-creation time. The fully-specific combo (nothing left to
      // dimension by) used to be dropped here when it had no shared baseline,
      // which meant a combination that genuinely exists in the tenant's data
      // got no role at all just because its members happen to hold nothing in
      // common — most visible with Create Dynamic Roles off, where every
      // bucket is the fully-specific combo. Every existing combination now
      // gets its role (explicit user instruction); an empty commonAccess just
      // makes it a membership-only role.
      for (const m of members) assigned.add(m.id);
      const attributeCriteria = comboKeys.map((key) => ({ key, value: members[0].attrs[key] }));
      // commonSig is now a >=70% threshold, not a strict intersection, so a
      // held-by-most-but-not-all entitlement may be missing from any one
      // member (including members[0]) — resolve names from whichever member
      // actually has each one instead of assuming the first member does.
      const groupNameById = new Map();
      for (const m of members) for (const e of m.entitlements) groupNameById.set(e.id, e.name);

      /*
       * Work out now what each dimension would grant, so the UI can show it
       * before anyone commits to creating the role. Every member's
       * entitlements are already in memory here, so this costs nothing
       * extra — computing it at create-role time instead meant re-fetching
       * them all and only revealing the answer after the fact.
       *
       * A dimension's entitlements are those every member sharing that value
       * holds, minus what the base role already grants.
       */
      const varyingKeys = attributeKeys.filter((k) => !comboKeys.includes(k));
      // Every distinct value `key` takes among identities who actually share
      // THIS group's own comboKeys values (e.g. every location among
      // Asset Management identities specifically) — not among the whole
      // scanned population regardless of department. Scoping this globally
      // used to seed a dimension for every city seen ANYWHERE in the scan
      // on every peer group, most with zero real members even under the
      // loosest reading of "seen" (verified live: a 19-member Asset
      // Management role ended up with 31 location dimensions, most with no
      // Asset Management member in that city at all — Role Evaluation then
      // correctly, if confusingly, flagged nearly all of them stale).
      // Scanned from the full population (not just this bucket's own
      // `members`, which excludes anyone already claimed by an
      // earlier/more-specific combo) so a value doesn't disappear from the
      // domain just because its only holder happened to get assigned
      // elsewhere.
      const peersInScope = profiles.filter((p) =>
        attributeCriteria.every(({ key: ck, value: cv }) => p.attrs[ck] === cv)
      );
      const dimensionPreview = [];
      for (const key of varyingKeys) {
        const values = [...new Set(peersInScope.map((p) => p.attrs[key]).filter((v) => v && v !== "Unknown"))];
        for (const value of values) {
          const subs = members.filter((m) => m.attrs[key] === value);
          // Same split as the base role's commonSig above: memberCount below
          // reflects everyone sharing this dimension value, but only
          // members with more than one entitlement feed the proposal.
          let shared = commonlyHeldEntitlementIds(subs.filter((m) => m.entitlements.length > 1), commonalityThreshold);
          const nameById = new Map();
          for (const m of subs) for (const e of m.entitlements) nameById.set(e.id, e.name);
          dimensionPreview.push({
            attribute: key,
            value,
            memberCount: subs.length,
            entitlements: [...shared]
              .filter((id) => !commonSig.has(id) && !commonRoleEntIds.has(id))
              .map((id) => ({ id, name: nameById.get(id) })),
          });
        }
      }

      // No "must be unique to exactly one dimension" filter here (there
      // used to be one) — Role Evaluation's own per-dimension check has no
      // such rule, it just asks "does >= the commonality threshold of this
      // dimension's current members hold it, and is it not already granted
      // elsewhere". An entitlement genuinely shared by two dimensions was
      // being silently dropped from both at creation time, then flagged as
      // a gap by evaluation later — the same criteria has to apply at both
      // points for a scan-created role to agree with its own first
      // evaluation.
      // "Dynamic Peer Group" is only earned once a role — and its dimensions
      // — actually exist (see the default name in create-role below); at
      // scan time no role exists yet, so the group itself stays plain.
      groupCounter += 1;
      groups.push({
        id: `group_${groupCounter}`,
        name: `${attributeCriteria.map((c) => c.value).join(" ")} Peer Group`,
        attributeCriteria,
        members: members.map((m) => ({
          id: m.id,
          name: m.name,
          email: m.email,
          managerName: m.managerName,
          ...m.attrs,
          entitlementCount: m.entitlements.length,
        })),
        commonAccess: [...commonSig].map((id) => ({ id, name: groupNameById.get(id) })),
        dimensionPreview,
        roleCreated: null,
      });
    }
  }
  return groups;
}

// Peer-group entitlements come back from the per-identity fetch
// (/v2026/entitlements/identities/{id}/entitlements) as bare {id, name} —
// but for many sources (verified live against this tenant's Active
// Directory and Salesforce entitlements) that "name" is actually the raw
// attribute value (an AD group GUID like "{e4a3c048-...}", a Salesforce
// ProfileId like "00e15000001Hgm9AAC"), not the human-readable name. The
// real name — and source, which this endpoint doesn't return at all — only
// comes back from the single/bulk-by-id entitlement lookup. This resolves
// both in one pass per batch of ids, so the report can show the actual name
// (as "source:name" to disambiguate same-named entitlements across
// sources) instead of that raw value.
const ENTITLEMENT_SOURCE_LOOKUP_BATCH_SIZE = 50;
async function resolveEntitlementDisplayInfo(tenant, token, ids) {
  const uniqueIds = [...new Set(ids)];
  const infoById = new Map();
  for (let i = 0; i < uniqueIds.length; i += ENTITLEMENT_SOURCE_LOOKUP_BATCH_SIZE) {
    const batch = uniqueIds.slice(i, i + ENTITLEMENT_SOURCE_LOOKUP_BATCH_SIZE);
    const filters = `id in (${batch.map((id) => `"${id}"`).join(",")})`;
    try {
      const results = await withApiRetry(
        () => iscGet(tenant, token, "/v2026/entitlements", { filters, limit: batch.length }),
        { label: "resolveEntitlementDisplayInfo: entitlements batch lookup" }
      );
      for (const e of results) infoById.set(e.id, { name: e.name, source: e.source?.name || null });
    } catch (err) {
      console.error("[insights] entitlement display-info lookup batch failed:", err.response?.data || err.message);
    }
  }
  return infoById;
}

// scanId -> true once cancellation has been requested; runRoleScan polls
// this between pages, same pattern as cancelledScans for full scans.
const cancelledRoleScans = new Set();

async function runRoleScan(scanId, session) {
  const { tenant } = session;
  // Locked in when the scan was created (see POST /role-scans) so it stays
  // consistent even if Schema Analysis is re-run, re-ordered, or the
  // Create Dynamic Roles setting is changed mid-scan.
  const scanConfig = await roleScans.get(scanId);
  const attributeKeys = scanConfig.attributeKeys;
  const createDynamicRoles = scanConfig.createDynamicRoles;
  const entitlementCommonalityThreshold = scanConfig.entitlementCommonalityThreshold;
  // Locked in at scan creation (see POST /role-scans) so a later
  // Configuration change doesn't retroactively alter a scan already in
  // flight or already reported — same reasoning as attributeKeys above.
  const scopeQuery = scanConfig.scopeQuery;
  // Multi-Company/Division Boundary — also locked in at scan creation, same
  // reasoning. When on, the scan runs its full pipeline once per distinct
  // combination of these attributes' values (see the partition loop below)
  // instead of once across the whole scope.
  const roleBoundaryEnabled = scanConfig.roleBoundaryEnabled;
  const roleBoundaryAttributes = scanConfig.roleBoundaryAttributes || [];
  // Profiles need boundary attribute values too (to partition by), on top of
  // the peer-group attributeKeys — only when boundary is actually on, so a
  // tenant not using it pays no extra cost per identity.
  const profileAttributeKeys = roleBoundaryEnabled && roleBoundaryAttributes.length > 0
    ? [...new Set([...attributeKeys, ...roleBoundaryAttributes])]
    : attributeKeys;
  try {
    const scopeIds = await fetchScopeIds(tenant, await sessionToken(session), ["identities"], scopeQuery);

    const profiles = [];
    let entitlementFetchFailures = 0;

    // No built-in "active identities only" filter here — which identities
    // qualify is entirely up to the tenant's Role Scan Scope setting
    // (scopeIds below). A tenant that wants only active identities gets
    // that via the scope query (the setting's own default is
    // attributes.cloudLifecycleState:active), not a hardcoded assumption
    // baked into the scan itself. Paginated via searchAllIdentities
    // (searchAfter, not offset) — this tenant's identity count can exceed
    // 10,000, past which offset pagination against /v2026/public-identities
    // hard-fails (verified live).
    await searchAllIdentities(tenant, () => sessionToken(session), {
      pageSize: ROLE_SCAN_IDENTITY_PAGE_SIZE,
      includeAccess: true,
      onPage: async (identities, totalScanned) => {
        if (cancelledRoleScans.has(scanId)) return false;

        // scopeIds is null when no Role Scan Scope is configured — every
        // identity qualifies in that case. Entitlements already came back on
        // each identity's own Search document (includeAccess above), so this
        // is a plain synchronous map now — no more per-identity fetch/retry.
        const pageProfiles = identities
          .filter((idn) => !scopeIds || scopeIds.has(idn.id))
          .map((idn) => buildIdentityRoleProfileFromAccess(idn, profileAttributeKeys));
        entitlementFetchFailures += pageProfiles.filter((p) => p.entitlementsFailed).length;
        // Every active identity in scope counts toward Roles and Dimensions —
        // a brand-new department or title with no (or sparse) entitlements
        // yet must still be visible to the scan, not silently dropped until
        // someone in it happens to accumulate more access. Test/service
        // accounts whose one trivial shared entitlement used to dominate
        // bucketing are handled inside buildPeerGroups instead (excluded only
        // from the entitlement-commonality calculation, not from membership —
        // see its own comment), so that exclusion no longer has to mean
        // "invisible to the scan entirely." A failed entitlement fetch
        // (entitlementsFailed, 0-length) IS still excluded here — it isn't a
        // real "zero entitlements" identity, and treating it as one would
        // silently dilute every group it lands in with wrong data.
        profiles.push(...pageProfiles.filter((p) => !p.entitlementsFailed));

        await updateRoleScan(scanId, {
          scanned: totalScanned,
          totalIdentities: totalScanned,
          entitlementFetchFailures,
        });
      },
    });

    if (cancelledRoleScans.has(scanId)) {
      cancelledRoleScans.delete(scanId);
      await updateRoleScan(scanId, { status: "cancelled", completedAt: new Date().toISOString() });
      return;
    }

    // A transient failure here used to silently fall back to "nothing is
    // common access," which meant every peer group in the whole scan lost
    // this exclusion at once with no visible sign anything had gone wrong
    // (verified live: a scan-created role ended up with a confirmed
    // common-access role's own entitlements baked in). Retried like every
    // other write/read in this app now, and the scan itself is flagged
    // (commonAccessExclusionFailed) so the gap is visible instead of silent
    // if every attempt still fails.
    // Every confirmed common-access role's own criteria + entitlements,
    // same summaries Role Evaluation fetches (see
    // fetchCommonAccessRoleSummaries) — used below to find which existing
    // common-access roles' criteria actually applies to a given partition's
    // scope (a subset match, not an unconditional union of every
    // common-access role in the tenant regardless of relevance).
    let commonAccessSummaries = [];
    let commonAccessExclusionFailed = false;
    try {
      const commonAccessToken = await sessionToken(session);
      commonAccessSummaries = await withApiRetry(
        () => fetchCommonAccessRoleSummaries(tenant, commonAccessToken),
        { label: `role scan ${scanId}: fetch common-access role summaries` }
      );
    } catch (err) {
      // Common-access is a beta API — if it's unavailable on this tenant,
      // scanning should still work, just without this particular filter.
      console.error(`[insights] role scan ${scanId}: failed to fetch common-access entitlements after retries:`, err.response?.data || err.message);
      commonAccessExclusionFailed = true;
    }

    // Locked in at scan start (see POST /role-scans) so a later Configuration
    // change never retroactively changes an already-running or
    // already-reported scan. Read here (before buildPeerGroups) rather than
    // its original spot below, since the Common Access proposal below needs
    // it too.
    const allowDuplicateRoles = (await roleScans.get(scanId)).allowDuplicateRoles;

    const commonalityThreshold = (entitlementCommonalityThreshold ?? 80) / 100;
    const scopeCriteria = parseSimpleScopeCriteria(scopeQuery);
    const settingsForNaming = await getTenantSettings(tenant);

    // Every existing role's membership criteria, keyed for exact-set
    // comparison — built once, used twice: below, to make sure the Common
    // Access proposal for each partition never duplicates a role that
    // already has that exact scope+boundary criteria (common-access
    // flagged or not — a plain role scoped the same way counts too), and
    // after the partition loop, for peer groups' own existing-role check.
    // A failure here isn't fatal to the scan — it just means neither check
    // can flag anything this run (rolesByCriteriaKey stays empty).
    let rolesByCriteriaKey = new Map();
    try {
      // Paginated (a tenant easily clears 250 roles — this one already has
      // 120+ before counting anything this scan itself might create) and
      // retried, same as Role Evaluation's own roles-list fetch — a single
      // unpaginated call here used to silently miss every role past the
      // first page, so the duplicate-role check below could pass a group
      // through as "new" when an existing role already covered it.
      let offset = 0;
      while (true) {
        const rolesToken = await sessionToken(session);
        const page = await withApiRetry(
          () => iscGet(tenant, rolesToken, "/v2026/roles", { limit: 250, offset, sorters: "name" }),
          { label: `role scan ${scanId}: existing-roles page` }
        );
        if (page.length === 0) break;
        for (const r of page) {
          const leaves = extractAllIdentityEqualsLeaves(r.membership?.criteria);
          if (leaves.length === 0) continue;
          const key = criteriaSetKey(leaves);
          if (!rolesByCriteriaKey.has(key)) {
            rolesByCriteriaKey.set(key, { id: r.id, name: r.name, enabled: !!r.enabled });
          }
        }
        offset += page.length;
        if (page.length < 250) break;
      }
    } catch (err) {
      console.error(`[insights] role scan ${scanId}: existing-roles fetch failed:`, err.response?.data || err.message);
    }

    // With Multi-Company/Division Boundary off, this is exactly one
    // "partition" covering the whole scope, with no extra criteria —
    // identical to how this scan behaved before the Boundary setting
    // existed. With it on, one partition per distinct combination of the
    // boundary attributes' values (see partitionProfilesByBoundary), each
    // running the exact same pipeline below independently.
    const partitions = roleBoundaryEnabled && roleBoundaryAttributes.length > 0
      ? partitionProfilesByBoundary(profiles, roleBoundaryAttributes)
      : [{ values: [], profiles }];

    let groups = [];
    for (const partition of partitions) {
      // Gated on the same condition `partitions` itself used above — with
      // Boundary off (or no attributes configured), every partition is the
      // single fallback { values: [] }, so mapping roleBoundaryAttributes
      // unconditionally produced a leaf with value: undefined for each
      // stored-but-unused boundary attribute (verified live: SailPoint
      // rejects the resulting empty `values` array on role creation with
      // "roleCriteria.values was missing or empty" — this is what broke
      // every peer-group and Common Access role creation in a tenant that
      // had ever configured boundary attributes and later turned Boundary
      // back off without clearing them).
      const boundaryLeaves = roleBoundaryEnabled && roleBoundaryAttributes.length > 0
        ? roleBoundaryAttributes.map((key, i) => ({ key, value: partition.values[i], isBoundary: true }))
        : [];

      /*
       * First task of this partition: propose a "Common Access" role for
       * it — Standard, common-access flagged — whenever there's something
       * to build a membership rule from (the scope, the boundary
       * partition, or both). Its entitlements are whatever's held by at
       * least the tenant's own commonality threshold of the partition
       * (same bar peer groups use, and the same bar Role Evaluation checks
       * against later), which may end up empty — an empty-entitlement
       * Common Access role is still proposed, the same way a Skeleton scan
       * always creates one with no entitlements.
       *
       * Allow Duplicates governs this differently than it governs peer
       * groups:
       *   - ON: always propose a brand new Common Access role for this
       *     scope, regardless of what any existing common-access role
       *     already covers. Only ITS OWN entitlements are excluded from
       *     this partition's peer groups (base and every dimension) —
       *     never an existing common role's, matching or not.
       *   - OFF: find every ACTIVE common-access role whose own membership
       *     is a superset of this scope (same subset-of-criteria match
       *     Role Evaluation's filterApplicableCommonAccessEntIds uses, not
       *     an exact scope+boundary match) and exclude the union of THEIR
       *     entitlements instead — a common role scoped to an unrelated
       *     population is left out, same as Evaluation already does. If
       *     none match, a new one is proposed exactly as in the ON case.
       */
      let commonAccessGroup = null;
      let partitionCommonRoleEntIds = new Set();
      try {
        if (partition.profiles.length > 0) {
          const attributeCriteria = [
            ...(scopeCriteria ? [{ key: scopeCriteria.attrKey, value: scopeCriteria.value }] : []),
            ...boundaryLeaves,
          ];
          // Exactly ONE Common Access proposal always exists per partition:
          // boundary on -> one per boundary combination; boundary off ->
          // one for the whole mined population. Previously, boundary off
          // with no parseable Role Scan Scope produced NO proposal at all
          // (nothing to build a membership rule from) — now it falls back
          // to cloudLifecycleState = active, the scope setting's own
          // default, since a Standard role can't be created with no
          // criteria at all. This also means the population-wide common
          // entitlements get excluded from every peer group in that case,
          // same as they always were when a scope was configured.
          if (attributeCriteria.length === 0) {
            attributeCriteria.push({ key: "cloudLifecycleState", value: "active" });
          }
          if (attributeCriteria.length > 0) {
            // Computed from partition.profiles — the scan's own complete,
            // already-fetched population for this exact partition (same
            // data buildPeerGroups uses for every peer group's own
            // commonSig) — not a separate, independently re-sampled fetch.
            // This used to call the now-removed estimateCommonlyHeldEntitlements,
            // which sampled via a capped, name-sorted identity scan (max
            // ROLE_EVAL_MAX_SCANNED identities) instead — on a large tenant
            // that scan can run out before reaching more than a handful of
            // identities actually matching this scope. Verified live: a
            // Brussels boundary with several dozen real members came back
            // as just 11 (alphabetically early names), and those 11
            // happened not to hold two entitlements the full population
            // clearly does — so the Common Access proposal excluded only
            // the entitlements that small sample DID find common, leaving
            // the other two to show up as "commonly held" on every
            // Brussels peer group too, duplicating what the real Common
            // Access role already grants. Reusing partition.profiles
            // directly guarantees this can never disagree with the peer
            // groups it's meant to be excluded from, and costs no extra
            // API calls.
            const eligibleForCommonAccess = partition.profiles.filter((p) => p.entitlements.length > 1);
            const scopeCommonEntIds = commonlyHeldEntitlementIds(eligibleForCommonAccess, commonalityThreshold);
            const boundaryNamePart = boundaryLeaves.map((l) => l.value).join(" ");
            // This partition's own scope in the {attrKey, value} shape
            // criteriaLeavesSubsetOf expects — only used in the Allow
            // Duplicates off branch below.
            const scopeLeaves = attributeCriteria.map(({ key, value }) => ({ attrKey: key, value }));
            const newCommonAccessGroup = () => ({
              id: `common_access_scope_${groups.length}`,
              // "Common Access" sits right before the suffix (boundary
              // value(s), if any, come first — right after the prefix,
              // same positioning Skeleton Roles' own naming uses) rather
              // than always leading the name, so e.g. a role suffix like
              // " Peer Group" still reads naturally against the
              // designation it's actually describing.
              name: applyRoleNamingServer(
                [boundaryNamePart, "Common Access"].filter(Boolean).join(" - "),
                settingsForNaming.rolePrefix, settingsForNaming.roleSuffix
              ),
              attributeCriteria,
              members: partition.profiles.map((p) => ({
                id: p.id, name: p.name, email: p.email, managerName: p.managerName,
                ...p.attrs, entitlementCount: p.entitlements.length,
              })),
              commonAccess: [...scopeCommonEntIds].map((id) => ({ id, name: null })),
              dimensionPreview: [],
              roleCreated: null,
              existingRole: null,
              isCommonAccessScope: true,
            });

            // With a boundary set, a subset-of-scope match alone isn't
            // enough: a role scoped more broadly than this partition (e.g.
            // missing the boundary attribute entirely, or scoped to a
            // different one of its values) would have its entitlements
            // computed against a bigger, cross-boundary population — pulling
            // in access that's only common to OTHER boundary values while
            // potentially missing access that's common to this one alone.
            // Reuse is only valid when the candidate's own criteria pins
            // every boundary attribute to exactly this partition's values.
            const boundaryKeySet = new Set(roleBoundaryAttributes);
            const matchingSummaries = allowDuplicateRoles
              ? []
              : commonAccessSummaries.filter((s) => {
                  if (!criteriaLeavesSubsetOf(s.criteriaLeaves, scopeLeaves)) return false;
                  if (boundaryKeySet.size === 0) return true;
                  const existingBoundaryLeaves = s.criteriaLeaves.filter((l) => boundaryKeySet.has(l.attrKey));
                  if (existingBoundaryLeaves.length !== boundaryKeySet.size) return false;
                  return boundaryLeaves.every((bl) =>
                    existingBoundaryLeaves.some((el) => el.attrKey === bl.key && el.value === bl.value)
                  );
                });

            if (matchingSummaries.length > 0) {
              // Defer to what's already covering this scope — don't
              // propose a duplicate. Every matching role's entitlements
              // are excluded (not just the first), even though only one
              // can be shown as "the" existing role here.
              partitionCommonRoleEntIds = new Set(matchingSummaries.flatMap((s) => [...s.entIds]));
              commonAccessGroup = {
                id: `common_access_scope_${groups.length}`,
                name: matchingSummaries[0].name,
                attributeCriteria,
                members: [],
                commonAccess: [],
                dimensionPreview: [],
                roleCreated: null,
                existingRole: { id: matchingSummaries[0].id, name: matchingSummaries[0].name, enabled: true },
                isCommonAccessScope: true,
              };
            } else {
              commonAccessGroup = newCommonAccessGroup();
              if (scopeCommonEntIds.size > 0) {
                // Every peer group in this partition excludes this — it's
                // birthright access this new role will grant everyone in
                // the partition, not something that makes any one peer
                // group distinct. Scoped to this partition only, since a
                // different partition's population may not share it at all.
                partitionCommonRoleEntIds = scopeCommonEntIds;
              }
            }
          }
        }
      } catch (err) {
        console.error(`[insights] role scan ${scanId}: Common Access proposal failed for partition ${boundaryLeaves.map((l) => l.value).join("/")}:`, err.response?.data || err.message);
      }

      const partitionGroups = buildPeerGroups(
        partition.profiles, attributeKeys, createDynamicRoles, partitionCommonRoleEntIds, commonalityThreshold
      );
      // buildPeerGroups assigns ids ("group_1", "group_2", ...) starting
      // fresh on every call — fine within one partition, but every
      // partition's groups end up in this same flat `groups` array, so two
      // different partitions produced groups sharing the identical id.
      // scan.groups[].id is how the client and create-role look up a
      // specific group afterward, and Array.find returns the first match —
      // a collision there silently created the WRONG role entirely
      // (verified live: two different partitions' groups shared an id, and
      // creating one used the other's membership criteria and entitlements
      // while keeping the intended name, e.g. "Bogus - Austin - Doctors
      // Role" ending up with Sao Paulo/Inventory's actual membership and
      // access). Renumbered here to stay globally unique across the scan.
      partitionGroups.forEach((g, i) => { g.id = `group_${groups.length + i}`; });
      if (boundaryLeaves.length > 0) {
        for (const g of partitionGroups) {
          g.attributeCriteria = [...boundaryLeaves, ...(g.attributeCriteria || [])];
          g.name = `${g.attributeCriteria.map((c) => c.value).join(" ")} Peer Group`;
        }
      }
      if (commonAccessGroup) partitionGroups.unshift(commonAccessGroup);
      groups.push(...partitionGroups);
    }

    // Flag any group whose exact attribute combination already matches an
    // existing role's membership criteria (department=Engineering AND
    // jobTitle="Production Test Engineer I", etc.), using the same
    // rolesByCriteriaKey fetched before the partition loop. Matches on the
    // criteria set only (not the role's entitlements/name), same
    // combination create-role itself would build for this group. A matched
    // group is always kept in the results (never dropped, regardless of
    // allowDuplicateRoles) — with duplicates off, create-role itself refuses
    // it, but the report still needs to show it so its own
    // merge-into-existing-role action (see that route) is reachable.
    for (const g of groups) {
      // The Common Access scope proposal already resolved its own
      // existingRole (if any) against this same map, using its own
      // status-leaf-stripped matching key — this generic any-role matcher
      // uses g.attributeCriteria as-is instead, so it skips this one
      // entirely rather than risk overwriting a correct result with a
      // differently-keyed lookup.
      if (g.isCommonAccessScope) continue;
      if (!g.attributeCriteria?.length) continue;
      const key = criteriaSetKey(g.attributeCriteria.map((c) => ({ attrKey: c.key, value: c.value })));
      g.existingRole = rolesByCriteriaKey.get(key) || null;
    }

    // Replace each entitlement's name (which for many sources is actually a
    // raw attribute value, not a human name — see resolveEntitlementDisplayInfo)
    // with its real name, and attach its source, so the report can show
    // "source:name". Non-fatal if it fails: the report falls back to
    // whatever the per-identity fetch returned rather than failing the scan.
    try {
      const token = await sessionToken(session);
      const allIds = groups.flatMap((g) => [
        ...g.commonAccess.map((e) => e.id),
        ...g.dimensionPreview.flatMap((d) => d.entitlements.map((e) => e.id)),
      ]);
      const infoById = await resolveEntitlementDisplayInfo(tenant, token, allIds);
      const relabel = (e) => {
        const info = infoById.get(e.id);
        return { ...e, name: info?.name || e.name, source: info?.source || null };
      };
      for (const g of groups) {
        g.commonAccess = g.commonAccess.map(relabel);
        g.dimensionPreview = g.dimensionPreview.map((d) => ({
          ...d,
          entitlements: d.entitlements.map(relabel),
        }));
      }
    } catch (err) {
      console.error(`[insights] role scan ${scanId}: entitlement source resolution failed:`, err.response?.data || err.message);
    }

    await updateRoleScan(scanId, {
      status: "completed",
      completedAt: new Date().toISOString(),
      groups,
      commonAccessExclusionFailed,
    });
  } catch (err) {
    cancelledRoleScans.delete(scanId);
    console.error(`[insights] role scan ${scanId} failed:`, err.response?.data || err.message);
    await updateRoleScan(scanId, {
      status: "failed",
      completedAt: new Date().toISOString(),
      error: describeError(err),
    });
  }
}

/**
 * POST /api/insights/role-scans
 * Header: x-sp-session
 * Starts an asynchronous peer-group discovery scan across every identity in
 * the tenant. Returns immediately with a scan ID — poll
 * GET /api/insights/role-scans/:id for progress and the resulting groups.
 */
// ─── Mail Distribution Group mining ─────────────────────────────────────────
// Same peer-group discovery as role mining (identical building blocks:
// scope query, identity profiles, buildPeerGroups with the tenant's own
// Mining Config), but each peer group becomes a proposed mail distribution
// group instead of a role. ISC's public API has no way to create a group
// on an AD or Entra source (POST /entitlements 405s at every root, and
// CREATE_GROUP provisioning policies have no public trigger — verified
// live), so "create" emits a ready-to-run PowerShell provisioning script:
// Exchange New-DistributionGroup targeted at the chosen OU for AD, Exchange
// Online for Entra.
const dlScans = createRecordStore(DATA_DIR, "dl-scans.json");
async function updateDlScan(scanId, patch) {
  await dlScans.put(scanId, { ...(await dlScans.get(scanId)), ...patch });
}
function dlScanForSession(scan, session) {
  if (!scan || scan.tenant !== session.tenant) return null;
  return scan;
}

// The OU structure of an AD source, derived from data already aggregated
// into ISC — account distinguishedNames plus group entitlement value DNs.
// (There's no public "browse the directory tree" API.)
app.get("/api/sources/:id/ad-ous", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  const ouOf = (dn) => {
    if (typeof dn !== "string" || !/DC=/i.test(dn)) return null;
    const parts = dn.split(",").map((x) => x.trim());
    while (parts.length && /^CN=/i.test(parts[0])) parts.shift();
    if (!parts.length || !parts.some((x) => /^OU=/i.test(x))) return null;
    return parts.join(",");
  };
  try {
    const token = await sessionToken(session);
    const counts = new Map();
    for (let offset = 0; offset < 1000; offset += 250) {
      const page = await withApiRetry(
        () => iscGet(tenant, token, "/v2025/accounts", { filters: `sourceId eq "${req.params.id}"`, limit: 250, offset }),
        { label: "ad-ous: accounts page" }
      );
      for (const acct of page) {
        const ou = ouOf(acct.attributes?.distinguishedName || acct.attributes?.dn);
        if (ou) counts.set(ou, (counts.get(ou) || 0) + 1);
      }
      if (page.length < 250) break;
    }
    for (let offset = 0; offset < 1000; offset += 250) {
      const page = await withApiRetry(
        () => iscGet(tenant, token, "/v2026/entitlements", { filters: `source.id eq "${req.params.id}"`, limit: 250, offset }),
        { label: "ad-ous: entitlements page" }
      );
      for (const ent of page) {
        const ou = ouOf(ent.value) || ouOf(ent.attributes?.distinguishedName);
        if (ou) counts.set(ou, (counts.get(ou) || 0) + 1);
      }
      if (page.length < 250) break;
    }
    const ous = [...counts.entries()]
      .map(([dn, count]) => ({ dn, count }))
      .sort((a, b) => b.count - a.count || a.dn.localeCompare(b.dn));
    res.json({ ous });
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[sources] ad-ous failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

async function runDlScan(scanId, session) {
  const { tenant } = session;
  try {
    const settings = await getTenantSettings(tenant);
    // DLs group by the FIRST mining attribute only (the one Roles are
    // built from) — the remaining attributes are role DIMENSIONS and are
    // deliberately not parsed here, so the DL matches the base role's own
    // criteria exactly (one DL per base role, populated by that role).
    const attributeKeys = (await getRoleScanAttributeKeys(tenant)).slice(0, 1);
    const threshold = (settings.entitlementCommonalityThreshold ?? 80) / 100;
    const scopeIds = await fetchScopeIds(tenant, await sessionToken(session), ["identities"], settings.nameScope || null);

    const profiles = [];
    await searchAllIdentities(tenant, () => sessionToken(session), {
      pageSize: ROLE_SCAN_IDENTITY_PAGE_SIZE,
      includeAccess: true,
      onPage: async (identities, totalScanned) => {
        const pageProfiles = identities
          .filter((idn) => !scopeIds || scopeIds.has(idn.id))
          .map((idn) => buildIdentityRoleProfileFromAccess(idn, attributeKeys));
        profiles.push(...pageProfiles.filter((p) => !p.entitlementsFailed));
        await updateDlScan(scanId, { scanned: totalScanned });
      },
    });

    // createDynamicRoles=false: with a single attribute there are no combos
    // to explore — one group per distinct value of that attribute.
    const groups = buildPeerGroups(profiles, attributeKeys, false, new Set(), threshold);
    const slug = (t) => String(t).replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    const suggestions = groups.map((g) => ({
      id: g.id,
      name: `DL-${g.attributeCriteria.map((c) => slug(c.value)).join("-")}`,
      displayName: g.attributeCriteria.map((c) => c.value).join(" - "),
      attributeCriteria: g.attributeCriteria,
      memberCount: g.members.length,
      members: g.members.slice(0, 500).map((m) => ({ id: m.id, name: m.name, email: m.email })),
      created: null,
    }));
    await updateDlScan(scanId, { status: "complete", completedAt: new Date().toISOString(), suggestions });
  } catch (err) {
    console.error(`[insights] dl scan ${scanId} failed:`, err.response?.data || err.message);
    await updateDlScan(scanId, { status: "error", completedAt: new Date().toISOString(), error: describeError(err) });
  }
}

/**
 * POST /api/insights/dl-scans
 * Body: { targetType: "ad"|"entra", sourceId, sourceName, ou? }
 */
app.post("/api/insights/dl-scans", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { targetType, sourceId, sourceName, ou } = req.body || {};
  if (targetType !== "ad" && targetType !== "entra") {
    return res.status(400).json({ error: "targetType must be \"ad\" or \"entra\"." });
  }
  if (!sourceId) return res.status(400).json({ error: "sourceId is required." });
  if (targetType === "ad" && !ou) return res.status(400).json({ error: "ou is required for Active Directory." });
  const scanId = `dlscan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await updateDlScan(scanId, {
    id: scanId,
    tenant: session.tenant,
    status: "running",
    startedAt: new Date().toISOString(),
    completedAt: null,
    targetType,
    sourceId,
    sourceName: sourceName || null,
    ou: ou || null,
    scanned: 0,
    suggestions: [],
    error: null,
  });
  runDlScan(scanId, session);
  res.status(202).json({ scanId });
});

app.get("/api/insights/dl-scans/:id", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const scan = dlScanForSession(await dlScans.get(req.params.id), session);
  if (!scan) return res.status(404).json({ error: "Distribution group scan not found." });
  res.json(scan);
});

/**
 * POST /api/insights/dl-scans/:id/create
 * Body: { suggestionIds: [] } — emits one PowerShell provisioning script
 * covering every selected group and marks them created on the scan record.
 */
app.post("/api/insights/dl-scans/:id/create", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const scan = dlScanForSession(await dlScans.get(req.params.id), session);
  if (!scan) return res.status(404).json({ error: "Distribution group scan not found." });
  const { suggestionIds } = req.body || {};
  if (!Array.isArray(suggestionIds) || suggestionIds.length === 0) {
    return res.status(400).json({ error: "suggestionIds must be a non-empty array." });
  }
  const chosen = (scan.suggestions || []).filter((g) => suggestionIds.includes(g.id));
  if (chosen.length === 0) return res.status(400).json({ error: "No matching suggestions." });

  // EMPTY groups only, deliberately: membership is populated by ISC, not
  // this script — after aggregation, Add to Roles attaches each DL
  // entitlement to its matching mined role, and the role's own membership
  // criteria provisions the members through the connector (which also
  // keeps hybrid write-paths correct: writes land on-prem and sync).
  const lines = [];
  lines.push(`# Mail distribution groups mined by Admin Studio (${new Date().toISOString()})`);
  if (scan.targetType === "ad") {
    lines.push(`# Target: Active Directory source "${scan.sourceName}" — OU: ${scan.ou}`);
    lines.push(`# Run from an Exchange Management Shell with an account holding the Exchange RBAC role for DLs.`);
  } else {
    lines.push(`# Target: Entra / Exchange Online (source "${scan.sourceName}")`);
  }
  lines.push(`# Groups are created EMPTY on purpose — run entitlement aggregation in ISC afterward, then use`);
  lines.push(`# "Add to Roles" on the scan: each role's membership provisions the DL members via the connector.`);
  lines.push("");
  if (scan.targetType !== "ad") lines.push("Connect-ExchangeOnline", "");
  for (const g of chosen) {
    lines.push(
      scan.targetType === "ad"
        ? `New-DistributionGroup -Name "${g.name}" -DisplayName "${g.displayName}" -Type Distribution -OrganizationalUnit "${scan.ou}"`
        : `New-DistributionGroup -Name "${g.name}" -DisplayName "${g.displayName}" -Type Distribution`
    );
  }
  lines.push("");
  const script = lines.join("\n");
  const at = new Date().toISOString();
  const updated = (scan.suggestions || []).map((g) =>
    suggestionIds.includes(g.id) ? { ...g, created: { at } } : g
  );
  await updateDlScan(scan.id, { suggestions: updated });
  res.json({ script, count: chosen.length });
});

/**
 * POST /api/insights/dl-scans/:id/add-to-roles
 * Body: { suggestionIds: [] }
 * For each selected group: finds the aggregated DL entitlement on the
 * scan's source (by name — requires the group to exist and entitlement
 * aggregation to have run), finds the role whose membership criteria
 * exactly matches the suggestion's own peer-group criteria (the role
 * created by Scan for Roles for the same peer group), and adds the
 * entitlement to that role. The role's membership then provisions the DL
 * members through the connector — ISC-native population, no PowerShell.
 * Added entitlements inherit the role's segment-boundary tags, same as
 * every other role-entitlement add.
 */
app.post("/api/insights/dl-scans/:id/add-to-roles", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  const scan = dlScanForSession(await dlScans.get(req.params.id), session);
  if (!scan) return res.status(404).json({ error: "Distribution group scan not found." });
  const { suggestionIds } = req.body || {};
  if (!Array.isArray(suggestionIds) || suggestionIds.length === 0) {
    return res.status(400).json({ error: "suggestionIds must be a non-empty array." });
  }
  const chosen = (scan.suggestions || []).filter((g) => suggestionIds.includes(g.id));
  if (chosen.length === 0) return res.status(400).json({ error: "No matching suggestions." });

  try {
    const token = await sessionToken(session);

    // The scan's source's entitlements, fetched once — DLs land here after
    // group aggregation.
    const sourceEnts = [];
    for (let offset = 0; offset < 2000; offset += 250) {
      const page = await withApiRetry(
        () => iscGet(tenant, token, "/v2026/entitlements", { filters: `source.id eq "${scan.sourceId}"`, limit: 250, offset }),
        { label: "dl add-to-roles: entitlements page" }
      );
      sourceEnts.push(...page);
      if (page.length < 250) break;
    }

    // Every role keyed by its exact membership-criteria set — the mined
    // role for the same peer group has exactly the suggestion's criteria.
    const roles = await fetchAllRolesWithCriteria(tenant, token);
    const byCriteria = new Map();
    for (const r of roles) {
      const leaves = extractAllIdentityEqualsLeaves(r.membership?.criteria);
      if (leaves.length) byCriteria.set(criteriaSetKey(leaves), r);
    }

    const results = [];
    const at = new Date().toISOString();
    for (const g of chosen) {
      try {
        const ent = sourceEnts.find(
          (e) => e.name === g.name || e.value === g.name || (typeof e.value === "string" && e.value.startsWith(`CN=${g.name},`))
        );
        if (!ent) {
          results.push({ id: g.id, ok: false, error: `Entitlement "${g.name}" not found on ${scan.sourceName} — create the group and run entitlement aggregation first.` });
          continue;
        }
        const role = byCriteria.get(criteriaSetKey(g.attributeCriteria.map((c) => ({ attrKey: c.key, value: c.value }))));
        if (!role) {
          results.push({ id: g.id, ok: false, error: `No role with membership criteria matching ${g.attributeCriteria.map((c) => `${c.key}=${c.value}`).join(", ")} — create it with Scan for Roles first.` });
          continue;
        }
        await patchRoleEntitlements(tenant, token, role.id, { add: [{ id: ent.id, name: ent.name }] });
        await tagEntitlementsWithRoleBoundaryValues(tenant, token, role.id, [ent.id]);
        g.addedToRole = { roleId: role.id, roleName: role.name, entitlementId: ent.id, at };
        results.push({ id: g.id, ok: true, roleId: role.id, roleName: role.name });
      } catch (err) {
        console.error(`[insights] dl add-to-roles "${g.name}" failed:`, err.response?.data || err.message);
        results.push({ id: g.id, ok: false, error: describeError(err) });
      }
    }
    await updateDlScan(scan.id, { suggestions: scan.suggestions });
    res.json({ results });
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[insights] dl add-to-roles failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

app.post("/api/insights/role-scans", async (req, res) => {
  const session = await getSession(req);

  if (!session) return unauthorized(res);
  const { tenant } = session;

  const scanId = `rolescan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const startSettings = await getTenantSettings(tenant);
  const boundarySchema = await schemaAnalyses.get(tenant);
  await updateRoleScan(scanId, {
    id: scanId,
    tenant,
    status: "running",
    startedAt: new Date().toISOString(),
    completedAt: null,
    scopeQuery: startSettings.nameScope || null,
    scanned: 0,
    totalIdentities: 0,
    groups: [],
    error: null,
    attributeKeys: await getRoleScanAttributeKeys(tenant),
    createDynamicRoles: startSettings.createDynamicRoles,
    allowDuplicateRoles: startSettings.allowDuplicateRoles,
    entitlementCommonalityThreshold: startSettings.entitlementCommonalityThreshold,
    roleBoundaryEnabled: !!boundarySchema?.roleBoundaryEnabled,
    roleBoundaryAttributes: boundarySchema?.roleBoundaryAttributes || [],
    entitlementFetchFailures: 0,
  });

  runRoleScan(scanId, session);

  res.status(202).json({ scanId });
});

/** GET /api/insights/role-scans — list past/running role scans, newest first */
app.get("/api/insights/role-scans", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);

  const list = Object.values(await roleScans.all())
    .filter((s) => s.tenant === session.tenant)
    .map(({ groups, ...meta }) => ({ ...meta, groupCount: groups?.length || 0 }))
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
  res.json(list);
});

// Same not-found-not-forbidden treatment as scanForSession, for role scans.
function roleScanForSession(scan, session) {
  return scan && scan.tenant === session.tenant ? scan : null;
}

/** GET /api/insights/role-scans/:id — full record including peer groups */
app.get("/api/insights/role-scans/:id", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const scan = roleScanForSession(await roleScans.get(req.params.id), session);
  if (!scan) return res.status(404).json({ error: "Role scan not found." });
  res.json(scan);
});

/** POST /api/insights/role-scans/:id/cancel — stops a running peer-group scan. */
app.post("/api/insights/role-scans/:id/cancel", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const scan = roleScanForSession(await roleScans.get(req.params.id), session);
  if (!scan) return res.status(404).json({ error: "Role scan not found." });
  if (scan.status !== "running") {
    return res.status(400).json({ error: `Scan is already ${scan.status}.` });
  }

  cancelledRoleScans.add(req.params.id);
  await updateRoleScan(req.params.id, { status: "cancelled", completedAt: new Date().toISOString() });
  res.json(await roleScans.get(req.params.id));
});

/** DELETE /api/insights/role-scans/:id — purges a past scan record. */
app.delete("/api/insights/role-scans/:id", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const scan = roleScanForSession(await roleScans.get(req.params.id), session);
  if (!scan) return res.status(404).json({ error: "Role scan not found." });
  if (scan.status === "running") {
    return res.status(400).json({ error: "Cancel the scan before removing it." });
  }

  await roleScans.delete(req.params.id);
  res.status(204).end();
});

// ─── Attribute Sync scan ────────────────────────────────────────────────────
// Scans every source's CREATE provisioning policy for fields whose transform
// is `identityAttribute` (an explicit "this account field comes from this
// identity attribute" mapping already authored by whoever built the
// provisioning policy) and proposes enabling ISC's real Attribute Sync
// feature (GET/PUT /beta/sources/:id/attribute-sync-config) for each one —
// except the field(s) matching the source's own identityAttribute/
// displayAttribute, which is excluded by default: verified live against a
// real tenant that its own already-configured attribute-sync-config had
// exactly this pattern (every other identityAttribute-mapped CREATE field
// enabled, but the account's own native-identity/naming field disabled) —
// continuously re-syncing the field used to correlate or rename the account
// is a different, riskier operation than syncing an ordinary profile field.
const attributeSyncScans = createRecordStore(DATA_DIR, "attribute-sync-scans.json");

async function updateAttributeSyncScan(scanId, patch) {
  await attributeSyncScans.put(scanId, { ...(await attributeSyncScans.get(scanId)), ...patch });
}
function attributeSyncScanForSession(scan, session) {
  return scan && scan.tenant === session.tenant ? scan : null;
}

const ATTRIBUTE_SYNC_SOURCE_CONCURRENCY = 5;

/** Pages through every source in the tenant (server-side — no client helper for this exists yet). */
async function fetchAllSources(tenant, token) {
  const all = [];
  let offset = 0;
  const pageSize = 250;
  while (true) {
    const page = await iscGet(tenant, token, "/v2026/sources", { limit: pageSize, offset, sorters: "name" });
    if (!Array.isArray(page) || page.length === 0) break;
    all.push(...page);
    if (page.length < pageSize) break;
    offset += pageSize;
  }
  return all;
}

// Builds the proposed attribute-sync mapping list for one source. Returns
// null (not an error) for sources with no CREATE provisioning policy at all
// (nothing to propose) or whose connector doesn't support attribute sync
// (the config GET 404s/400s) — both are normal, not scan failures.
async function scanSourceForAttributeSync(tenant, token, source) {
  let policies, schemas, currentConfig;
  try {
    [policies, schemas] = await Promise.all([
      withApiRetry(() => iscGet(tenant, token, `/v2026/sources/${source.id}/provisioning-policies`), { label: `provisioning-policies ${source.name}` }),
      withApiRetry(() => iscGet(tenant, token, `/v2026/sources/${source.id}/schemas`), { label: `schemas ${source.name}` }),
    ]);
  } catch (err) {
    return { sourceId: source.id, sourceName: source.name, sourceType: source.type, skipped: true, reason: "Could not read schema or provisioning policies." };
  }

  const createPolicy = (Array.isArray(policies) ? policies : []).find((p) => p.usageType === "CREATE");
  const identityMappedFields = (createPolicy?.fields || []).filter((f) => f.transform?.type === "identityAttribute" && f.transform?.attributes?.name);
  if (identityMappedFields.length === 0) {
    return { sourceId: source.id, sourceName: source.name, sourceType: source.type, skipped: true, reason: "No CREATE provisioning policy with identity-attribute-mapped fields." };
  }

  const accountSchema = (Array.isArray(schemas) ? schemas : []).find((s) => s.name === "account") || schemas?.[0];
  const nativeFields = new Set([accountSchema?.identityAttribute, accountSchema?.displayAttribute].filter(Boolean));

  try {
    currentConfig = await withApiRetry(
      () => iscGet(tenant, token, `/beta/sources/${source.id}/attribute-sync-config`, undefined, { "X-SailPoint-Experimental": "true" }),
      { label: `attribute-sync-config ${source.name}` }
    );
  } catch (err) {
    return { sourceId: source.id, sourceName: source.name, sourceType: source.type, skipped: true, reason: "This connector doesn't support Attribute Sync." };
  }
  const currentByPair = new Map((currentConfig?.attributes || []).map((a) => [`${a.name} ${a.target}`, a]));

  const proposed = identityMappedFields.map((f) => {
    const name = f.transform.attributes.name; // identity attribute
    const target = f.name; // account attribute
    const key = `${name} ${target}`;
    const existing = currentByPair.get(key);
    const isNativeField = nativeFields.has(target);
    return {
      name,
      target,
      recommended: !isNativeField,
      reason: isNativeField ? "Native identity/naming attribute for this source — excluded from continuous sync by default." : null,
      existsInLiveConfig: !!existing,
      currentlyEnabled: existing ? existing.enabled : false,
    };
  });

  return {
    sourceId: source.id,
    sourceName: source.name,
    sourceType: source.type,
    skipped: false,
    proposed,
    // A source with no attribute sync configured yet returns an empty
    // attributes list (verified live) — existsInLiveConfig is purely
    // informational for display, NOT a deploy gate. Deploy adds a new
    // entry for a recommended pair ISC hasn't enumerated yet, same as
    // toggling one it already has.
    changeCount: proposed.filter((p) => p.recommended && !p.currentlyEnabled).length,
  };
}

async function runAttributeSyncScan(scanId, session) {
  const { tenant } = session;
  try {
    const token = await sessionToken(session);
    const sources = await fetchAllSources(tenant, token);
    await updateAttributeSyncScan(scanId, { totalSources: sources.length });

    let scanned = 0;
    const results = await mapWithConcurrency(sources, ATTRIBUTE_SYNC_SOURCE_CONCURRENCY, async (source) => {
      const result = await scanSourceForAttributeSync(tenant, token, source);
      scanned += 1;
      await updateAttributeSyncScan(scanId, { scanned });
      return result;
    });

    const usable = results.filter((r) => !r.skipped);
    await updateAttributeSyncScan(scanId, {
      status: "completed",
      completedAt: new Date().toISOString(),
      results,
      sourceCount: usable.length,
      skippedCount: results.length - usable.length,
      proposedChangeCount: usable.reduce((sum, r) => sum + (r.changeCount || 0), 0),
    });
  } catch (err) {
    console.error("[attribute-sync-scan] failed:", err.response?.data || err.message);
    await updateAttributeSyncScan(scanId, {
      status: "failed",
      completedAt: new Date().toISOString(),
      error: describeError(err),
    });
  }
}

/** POST /api/insights/attribute-sync-scans — starts a scan, returns immediately. */
app.post("/api/insights/attribute-sync-scans", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;

  const scanId = `attrsync_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await updateAttributeSyncScan(scanId, {
    id: scanId,
    tenant,
    status: "running",
    startedAt: new Date().toISOString(),
    completedAt: null,
    totalSources: 0,
    scanned: 0,
    results: [],
    error: null,
  });

  runAttributeSyncScan(scanId, session);

  res.status(202).json({ scanId });
});

/** GET /api/insights/attribute-sync-scans — list, newest first (results stripped for size). */
app.get("/api/insights/attribute-sync-scans", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const list = Object.values(await attributeSyncScans.all())
    .filter((s) => s.tenant === session.tenant)
    .map(({ results, ...meta }) => meta)
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
  res.json(list);
});

/** GET /api/insights/attribute-sync-scans/:id — full record, including per-source results. */
app.get("/api/insights/attribute-sync-scans/:id", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const scan = attributeSyncScanForSession(await attributeSyncScans.get(req.params.id), session);
  if (!scan) return res.status(404).json({ error: "Attribute sync scan not found." });
  res.json(scan);
});

/** DELETE /api/insights/attribute-sync-scans/:id */
app.delete("/api/insights/attribute-sync-scans/:id", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const scan = attributeSyncScanForSession(await attributeSyncScans.get(req.params.id), session);
  if (!scan) return res.status(404).json({ error: "Attribute sync scan not found." });
  if (scan.status === "running") {
    return res.status(400).json({ error: "Wait for the scan to finish before removing it." });
  }
  await attributeSyncScans.delete(req.params.id);
  res.status(204).end();
});

/**
 * POST /api/insights/attribute-sync-scans/:id/deploy
 * Body: { sourceId?: string }
 * "Deploy this Attribute Sync Model" — for every source in the scan with
 * recommended changes (or just the one named by `sourceId`, for deploying a
 * single source independently — same idea as the Role Scan page's per-group
 * Create Role alongside its bulk Create All Roles), re-fetches that source's
 * LIVE attribute-sync-config (not the scan's snapshot, in case it changed
 * since the scan ran), flips `enabled: true` on exactly the mappings this
 * scan recommended, and PUTs the merged list back. Only toggles mappings
 * that already exist in the live config — this app never attempts to invent
 * a brand-new sync pair ISC hasn't already enumerated as a candidate.
 */
app.post("/api/insights/attribute-sync-scans/:id/deploy", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const scan = attributeSyncScanForSession(await attributeSyncScans.get(req.params.id), session);
  if (!scan) return res.status(404).json({ error: "Attribute sync scan not found." });
  if (scan.status !== "completed") {
    return res.status(400).json({ error: "Only a completed scan can be deployed." });
  }

  const { sourceId } = req.body || {};
  if (sourceId && !(scan.results || []).some((r) => r.sourceId === sourceId)) {
    return res.status(404).json({ error: "That source isn't part of this scan." });
  }

  const { tenant } = session;
  try {
    const token = await sessionToken(session);
    const targets = (scan.results || []).filter(
      (r) => !r.skipped && r.changeCount > 0 && (!sourceId || r.sourceId === sourceId)
    );
    if (sourceId && targets.length === 0) {
      return res.status(400).json({ error: "This source has no recommended changes to deploy." });
    }

    // attribute-sync-config entries carry a human displayName for the
    // identity attribute (e.g. "email" -> "att_email", "phone" -> "Personal
    // Phone") — verified live these come straight from /v2026/identity-
    // attributes' own displayName, so a brand-new entry (a source with no
    // attribute sync configured yet starts with an empty attributes list)
    // needs this lookup rather than leaving displayName blank.
    let identityAttrDisplayNames = new Map();
    try {
      const attrs = await iscGet(tenant, token, "/v2026/identity-attributes", { limit: 250 });
      identityAttrDisplayNames = new Map((attrs || []).map((a) => [a.name, a.displayName]));
    } catch {
      // Non-fatal — new entries just fall back to using the attribute's
      // technical name as its displayName below.
    }

    const outcomes = await mapWithConcurrency(targets, ATTRIBUTE_SYNC_SOURCE_CONCURRENCY, async (r) => {
      try {
        const live = await iscGet(tenant, token, `/beta/sources/${r.sourceId}/attribute-sync-config`, undefined, { "X-SailPoint-Experimental": "true" });
        const recommended = r.proposed.filter((p) => p.recommended);
        const existingByPair = new Map((live.attributes || []).map((a) => [`${a.name} ${a.target}`, a]));

        const updatedExisting = (live.attributes || []).map((a) => {
          const isRecommended = recommended.some((p) => p.name === a.name && p.target === a.target);
          return isRecommended ? { ...a, enabled: true } : a;
        });
        const newEntries = recommended
          .filter((p) => !existingByPair.has(`${p.name} ${p.target}`))
          .map((p) => ({
            enabled: true,
            name: p.name,
            target: p.target,
            displayName: identityAttrDisplayNames.get(p.name) || p.name,
          }));

        const merged = { ...live, attributes: [...updatedExisting, ...newEntries] };
        await axios.put(
          `https://${tenantApiHost(tenant)}/beta/sources/${r.sourceId}/attribute-sync-config`,
          merged,
          { headers: { Authorization: `Bearer ${token}`, "X-SailPoint-Experimental": "true" } }
        );
        return { sourceId: r.sourceId, sourceName: r.sourceName, ok: true };
      } catch (err) {
        console.error(`[attribute-sync-scan] deploy failed for ${r.sourceName}:`, err.response?.data || err.message);
        return { sourceId: r.sourceId, sourceName: r.sourceName, ok: false, error: describeError(err) };
      }
    });

    // Merged by sourceId, not overwritten — deploying one source at a time
    // (or bulk, then a re-deploy of a single source afterward) shouldn't
    // erase the deploy record of sources handled in an earlier call.
    const priorResults = (await attributeSyncScans.get(req.params.id))?.deployResults || [];
    const bySourceId = new Map(priorResults.map((o) => [o.sourceId, o]));
    for (const o of outcomes) bySourceId.set(o.sourceId, o);

    const failed = outcomes.filter((o) => !o.ok);
    await updateAttributeSyncScan(req.params.id, {
      deployedAt: new Date().toISOString(),
      deployResults: [...bySourceId.values()],
    });
    res.json({ outcomes, failedCount: failed.length });
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[attribute-sync-scan] deploy failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

// ─── Backup & Restore ───────────────────────────────────────────────────────
// SailPoint's SP-Config export is an async job, not a plain download: POST
// starts it, GET polls its status, and once COMPLETE a separate GET streams
// the actual export JSON. This route runs all three steps server-side and
// hands the client the finished file in one response, so the "Backup" button
// is a single request from the client's point of view.
//
// NOT verified live against a real tenant (no SailPoint API access when this
// was written) — the job-id field name, status values, and download path
// are implemented per SailPoint's documented sp-config pattern and the
// user's own instruction to use POST .../sp-config/v1/export, but should be
// confirmed against a real run before relying on this for an actual backup.
const SP_CONFIG_POLL_INTERVAL_MS = 2000;
const SP_CONFIG_POLL_TIMEOUT_MS = 120000;

// Every object type sp-config's export supports, per SailPoint's own
// documented example for "export everything" — verified against the real
// OpenAPI spec (sailpoint-oss/api-specs, idn/apis/sp-config), since the
// first live attempt at this route 404'd and turned out to have two real
// bugs: the download path was wrong (must be nested under the export job,
// not a top-level /download/:id), and this include list was missing
// entirely (omitting it is not documented to mean "everything").
const SP_CONFIG_ALL_TYPES = [
  "ACCESS_PROFILE", "ACCESS_REQUEST_CONFIG", "ATTR_SYNC_SOURCE_CONFIG", "AUTH_ORG",
  "CAMPAIGN_FILTER", "CONNECTOR_RULE", "FORM_DEFINITION", "GOVERNANCE_GROUP",
  "IDENTITY_OBJECT_CONFIG", "IDENTITY_PROFILE", "LIFECYCLE_STATE", "NOTIFICATION_TEMPLATE",
  "PASSWORD_POLICY", "PASSWORD_SYNC_GROUP", "PUBLIC_IDENTITIES_CONFIG", "ROLE", "RULE",
  "SEGMENT", "SERVICE_DESK_INTEGRATION", "SOD_POLICY", "SOURCE", "TAG", "TRANSFORM",
  "TRIGGER_SUBSCRIPTION", "WORKFLOW",
];

app.post("/api/sp-config/backup", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;

  try {
    const token = await sessionToken(session);
    const auth = { Authorization: `Bearer ${token}` };
    const base = `https://${tenantApiHost(tenant)}/sp-config/v1`;

    const startResp = await axios.post(
      `${base}/export`,
      {
        description: `Admin Studio backup — ${new Date().toISOString()}`,
        excludeTypes: [],
        includeTypes: SP_CONFIG_ALL_TYPES,
        objectOptions: {},
      },
      { headers: auth }
    );
    const jobId = startResp.data?.jobId || startResp.data?.id;
    if (!jobId) {
      throw new Error("SailPoint didn't return a job id for the export.");
    }

    const deadline = Date.now() + SP_CONFIG_POLL_TIMEOUT_MS;
    let job;
    while (true) {
      const statusResp = await axios.get(`${base}/export/${jobId}`, { headers: auth });
      job = statusResp.data;
      if (job?.status === "COMPLETE") break;
      if (job?.status === "FAILED" || job?.status === "CANCELLED") {
        throw new Error(`Export job ${job.status.toLowerCase()}: ${job?.message || "no further detail from SailPoint."}`);
      }
      if (Date.now() > deadline) {
        throw new Error("Export job didn't complete within 2 minutes — check its status in ISC directly.");
      }
      await new Promise((resolve) => setTimeout(resolve, SP_CONFIG_POLL_INTERVAL_MS));
    }

    const downloadResp = await axios.get(`${base}/export/${jobId}/download`, { headers: auth });
    const filename = `${tenant}-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    res.json({ filename, data: downloadResp.data });
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[sp-config] backup failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/**
 * POST /api/sp-config/restore
 * Body: { data: <the selected subset of a previously exported sp-config JSON> }
 * sp-config's import endpoint takes multipart/form-data (a "data" file part
 * holding the JSON, plus an "options" part) — verified against SailPoint's
 * own OpenAPI spec, not the plain-JSON-body shape this route originally
 * (incorrectly) sent.
 */
app.post("/api/sp-config/restore", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  const { data } = req.body || {};
  if (!data || typeof data !== "object") {
    return res.status(400).json({ error: "data (the selected objects to restore) is required." });
  }

  try {
    const token = await sessionToken(session);
    const auth = { Authorization: `Bearer ${token}` };
    const base = `https://${tenantApiHost(tenant)}/sp-config/v1`;

    const form = new FormData();
    form.append("data", Buffer.from(JSON.stringify(data)), { filename: "restore.json", contentType: "application/json" });
    form.append("options", JSON.stringify({ excludeBackup: false }), { contentType: "application/json" });

    const startResp = await axios.post(`${base}/import`, form, { headers: { ...auth, ...form.getHeaders() } });
    const jobId = startResp.data?.jobId || startResp.data?.id;
    if (!jobId) {
      throw new Error("SailPoint didn't return a job id for the import.");
    }

    const deadline = Date.now() + SP_CONFIG_POLL_TIMEOUT_MS;
    let job;
    while (true) {
      const statusResp = await axios.get(`${base}/import/${jobId}`, { headers: auth });
      job = statusResp.data;
      if (job?.status === "COMPLETE") break;
      if (job?.status === "FAILED" || job?.status === "CANCELLED") {
        throw new Error(`Import job ${job.status.toLowerCase()}: ${job?.message || "no further detail from SailPoint."}`);
      }
      if (Date.now() > deadline) {
        throw new Error("Import job didn't complete within 2 minutes — check its status in ISC directly.");
      }
      await new Promise((resolve) => setTimeout(resolve, SP_CONFIG_POLL_INTERVAL_MS));
    }

    // Per-object results (what actually imported vs. failed) live in a
    // separate downloadable file, same as export's job-vs-download split.
    let details = null;
    try {
      const detailsResp = await axios.get(`${base}/import/${jobId}/download`, { headers: auth });
      details = detailsResp.data;
    } catch {
      // Non-fatal — the job status alone still tells the caller COMPLETE/FAILED.
    }

    res.json({ result: job, details });
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[sp-config] restore failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/**
 * POST /api/insights/role-scans/generate-descriptions
 * Header: x-sp-session
 * Body: { items: [{ key, name, dimensional, facts: string[] }, ...] }
 * Bulk-create's AI description step for peer groups that don't exist as
 * real roles yet, so generateRoleDescriptionText's "fetch the role from
 * ISC" approach doesn't apply — the client already has everything a
 * would-be role's facts need (its own scan data), and sends them directly.
 * Bounded concurrency, continues past individual failures, same pattern as
 * the Role Descriptions screen's bulk generate.
 */
app.post("/api/insights/role-scans/generate-descriptions", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const items = req.body?.items;
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "items must be a non-empty array." });
  }
  if (!aiConfigured()) {
    return res.status(503).json({ error: "AI description generation isn't configured on this server." });
  }

  try {
    const results = await mapWithConcurrency(items, 3, async (item) => {
      try {
        const description = await generateDescriptionFromFacts(
          item.facts || [],
          item.dimensional ? "This Dynamic Role" : "This Static Role"
        );
        return { key: item.key, description };
      } catch (err) {
        console.error(`[insights] role-scan description generation failed for ${item.key}:`, err.response?.data || err.message);
        return { key: item.key, error: describeError(err) };
      }
    });
    res.json({ results });
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[insights] role-scan generate-descriptions failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/**
 * POST /api/insights/role-scans/:id/groups/:groupId/create-role
 * Body: { name?, description?, ownerId, ownerName }
 * Creates a real requestable SailPoint role from a peer group's common
 * entitlements, so a new member of that peer group can request the role and
 * be provisioned the same shared access in one grant.
 */
app.post("/api/insights/role-scans/:id/groups/:groupId/create-role", async (req, res) => {
  const session = await getSession(req);
  const { name, description, ownerId, ownerName } = req.body || {};

  if (!session) return unauthorized(res);
  const { tenant } = session;
  if (!ownerId) {
    return res.status(400).json({ error: "ownerId is required to create a role." });
  }

  const scan = roleScanForSession(await roleScans.get(req.params.id), session);
  const group = scan?.groups?.find((g) => g.id === req.params.groupId);
  if (!group) return res.status(404).json({ error: "Peer group not found." });
  // Same "current setting, not scan time" reasoning as the client's
  // Create All Roles eligibility filter — with Allow Duplicate Roles on,
  // Mining Config has already said "create whatever's asked for", so a
  // group with no shared base entitlements (its access may be entirely
  // per-dimension) isn't blocked either.
  const allowDuplicateRoles = (await getTenantSettings(tenant)).allowDuplicateRoles;
  // Duplicate groups used to be dropped from the scan report entirely
  // whenever this setting was off, so a client could never reach this route
  // for one in practice. The report now keeps them visible (so its own
  // merge-into-existing-role action is reachable), which means this route
  // needs its own real guard instead of relying on that filter.
  if (!allowDuplicateRoles && group.existingRole) {
    return res.status(400).json({
      error: `A role with this exact attribute combination already exists ("${group.existingRole.name}") — Allow Duplicate Roles is off. Merge into the existing role instead.`,
    });
  }
  // No "has no common access to provision" refusal. A peer group whose
  // members share nothing is still a real combination that needs a role —
  // its access may live entirely in its dimensions, or the role may exist
  // purely as a membership-only placeholder to hang access on later
  // (explicit user instruction; same reasoning as buildPeerGroups no longer
  // dropping those groups from the scan in the first place).

  // Membership criteria so a new identity matching the peer group's chosen
  // attributes is automatically eligible for the role, not just identities
  // that happened to be in the scan. Shape (OR wrapping an AND of EQUALS
  // leaves, values as arrays) matches SailPoint's own criteria format.
  // lifecycleState-ACTIVE is always included so the role never matches a
  // disabled/inactive identity, regardless of which peer-group attributes
  // matched — unless the group's own criteria already covers it (the
  // Common Access proposal's criteria includes the scan's Scope itself,
  // which is commonly cloudLifecycleState=active already; adding the
  // hardcoded leaf on top of that would just duplicate the same condition).
  const hasCloudLifecycleStateCriteria = (group.attributeCriteria || [])
    .some((c) => c.key.toLowerCase() === "cloudlifecyclestate");
  const criteriaChildren = [
    ...(hasCloudLifecycleStateCriteria ? [] : [{
      operation: "EQUALS",
      key: { type: "IDENTITY", property: "attribute.cloudLifecycleState", sourceId: null },
      values: ["active"],
      stringValue: null,
      children: null,
    }]),
    ...(group.attributeCriteria || []).map(({ key, value }) => ({
      operation: "EQUALS",
      key: { type: "IDENTITY", property: `attribute.${key}`, sourceId: null },
      values: [value],
      stringValue: null,
      children: null,
    })),
  ];
  const membership = criteriaChildren.length
    ? {
        type: "STANDARD",
        criteria: {
          operation: "OR",
          key: null,
          values: null,
          stringValue: null,
          children: [
            {
              operation: "AND",
              key: null,
              values: null,
              stringValue: null,
              children: criteriaChildren,
            },
          ],
        },
      }
    : undefined;

  // Every candidate attribute the group did NOT match on varies across its
  // members by definition — build the role as a SailPoint Dynamic
  // (dimensional) role using all of them as dimensions, one Dimension per
  // distinct value per attribute (independent per attribute, not a
  // cross-product — mirrors the tenant's own "Retail Role", whose
  // dimensionAttributes is [location, title] but individual dimensions are
  // each scoped by just one of those two, e.g. "Wichita West" by location
  // alone and "Retail Managers" by title alone). A match on every one of the
  // scan's attribute keys has no varying attributes left, so it stays a
  // plain (simple) role instead.
  const matchedKeys = new Set((group.attributeCriteria || []).map((c) => c.key));
  const scanAttributeKeys = scan.attributeKeys || DEFAULT_PEER_GROUP_ATTRIBUTE_KEYS;
  // Uses the scan's own locked-in Create Dynamic Roles setting (see
  // POST /role-scans), not a fresh Configuration lookup — with it off, the
  // scan itself only ever grouped by the full attribute combination (see
  // buildPeerGroups), so varyingKeys is already empty for every group; this
  // just keeps that guarantee explicit rather than relying on it implicitly.
  const scanCreateDynamicRoles = scan.createDynamicRoles ?? DEFAULT_TENANT_SETTINGS.createDynamicRoles;
  // The Common Access scope proposal is always Standard, regardless of the
  // scan's Create Dynamic Roles setting — its one "attribute" is the scope
  // itself, not one of the scan's peer-group attributeKeys, so treating it
  // as having "varying" attributes the way a real peer group would makes no
  // sense here.
  const varyingKeys = group.isCommonAccessScope
    ? []
    : scanCreateDynamicRoles
    ? scanAttributeKeys.filter((k) => !matchedKeys.has(k))
    : [];
  const isDynamic = varyingKeys.length > 0;
  const labelize = (k) => k.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());

  // The group's own name stays plain ("... Peer Group") until a role with
  // dimensions actually exists — this is where "Dynamic Peer Group" is
  // earned, as the default name of the role actually being created here.
  const defaultRoleName = isDynamic ? group.name.replace(/ Peer Group$/, " Dynamic Peer Group") : group.name;

  try {
    const token = await sessionToken(session);
    const rolePayload = {
      name: name || defaultRoleName,
      description: description || `Auto-generated from peer group "${group.name}" — provisions the access common to its members.`,
      owner: { type: "IDENTITY", id: ownerId, name: ownerName },
      entitlements: group.commonAccess.map((e) => ({ id: e.id, type: "ENTITLEMENT", name: e.name })),
      // Created disabled so a Role Draft never actually grants access the
      // moment it's created — someone needs to review it in ISC and enable
      // it deliberately first.
      enabled: false,
      // Dimensional roles are auto-assigned via their membership criteria,
      // not individually requestable, in this tenant. Common Access is
      // birthright access every in-scope identity gets automatically too —
      // never individually requestable, regardless of dimensionality.
      requestable: group.isCommonAccessScope ? false : !isDynamic,
      ...(membership ? { membership } : {}),
      ...(isDynamic
        ? {
            dimensional: true,
            accessRequestConfig: {
              dimensionSchema: {
                dimensionAttributes: varyingKeys.map((k) => ({ name: k, displayName: labelize(k), derived: true })),
              },
            },
          }
        : {}),
    };

    const resp = await axios.post(
      `https://${tenantApiHost(tenant)}/v2026/roles`,
      rolePayload,
      { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }
    );

    // The role itself is already created at this point — a failure flagging
    // it as common access shouldn't be reported as the whole create having
    // failed, just noted so the caller knows to flag it manually in ISC's
    // own UI if this didn't succeed.
    let commonAccessFlagged = false;
    let commonAccessError = null;
    if (group.isCommonAccessScope) {
      try {
        await flagRoleAsCommonAccess(tenant, token, resp.data.id);
        commonAccessFlagged = true;
      } catch (caErr) {
        console.error(`[insights] create-role: common-access flag failed for role ${resp.data.id}:`, caErr.response?.data || caErr.message);
        commonAccessError = describeError(caErr);
      }

      // Reconcile with a live evaluation right after creation. The scan's
      // own commonAccess computation (above, at proposal time) pages
      // through this population's identities and entitlements once,
      // up-front, for the whole scan — Role Evaluation's own commonly-
      // held-but-not-granted check pages through them again independently,
      // at whatever moment evaluation actually runs, which can disagree
      // with the scan's snapshot (verified live: a broad tenant-wide
      // Common Access proposal created with 0 entitlements, whose own
      // first evaluation immediately found 4 commonly-held entitlements it
      // was missing). Evaluation's check is the one already trusted
      // everywhere else in this app, so it's used here as the final
      // authority on what a freshly-created Common Access role should
      // grant, applied immediately rather than left for someone to notice
      // and accept later.
      try {
        const evalToken = await sessionToken(session);
        const evaluation = await evaluateRoleAlgorithmic(tenant, evalToken, resp.data.id);
        const missing = evaluation.addCandidates || [];
        if (missing.length > 0) {
          const patchToken = await sessionToken(session);
          const updated = await patchRoleEntitlements(tenant, patchToken, resp.data.id, {
            add: missing.map((c) => ({ id: c.entitlementId, name: c.entitlement })),
          });
          resp.data.entitlements = updated.entitlements;
          // group.commonAccess is what the scan report itself shows for
          // this group, and what baseEntIds (right below) is built from —
          // both need to reflect what the role actually ended up with
          // after reconciling, or the report undercounts entitlements the
          // created role genuinely has (verified live: role created with
          // the reconciled entitlements applied, but the scan record still
          // showing only the pre-reconcile list).
          group.commonAccess = updated.entitlements.map((e) => ({ id: e.id, name: e.name }));

          // The reconciled additions are birthright access every identity
          // in this partition now gets automatically — every sibling peer
          // group's own base/dimension entitlements need to drop them too,
          // or a peer group created afterward (from the same scan, still
          // using its scan-time-computed entitlement list) ends up
          // carrying the same items redundantly, exactly what this
          // reconcile step was supposed to prevent (verified live: a
          // "Draft - Accounting Role" created from the same scan as this
          // Common Access role included entitlements the reconcile step
          // had just added to it). Only touches groups not yet turned into
          // an actual role — an already-created sibling role's own live
          // entitlements are left alone here; Role Evaluation already
          // surfaces and can Accept-clean those the normal way.
          const deltaIds = new Set(missing.map((c) => c.entitlementId));
          const boundaryKeyOf = (ac) =>
            JSON.stringify((ac || []).filter((c) => c.isBoundary).map((c) => `${c.key}=${c.value}`).sort());
          const thisBoundaryKey = boundaryKeyOf(group.attributeCriteria);
          for (const sibling of scan.groups) {
            if (sibling.id === group.id || sibling.isCommonAccessScope || sibling.roleCreated) continue;
            if (boundaryKeyOf(sibling.attributeCriteria) !== thisBoundaryKey) continue;
            if (Array.isArray(sibling.commonAccess)) {
              sibling.commonAccess = sibling.commonAccess.filter((e) => !deltaIds.has(e.id));
            }
            for (const d of sibling.dimensionPreview || []) {
              d.entitlements = (d.entitlements || []).filter((e) => !deltaIds.has(e.id));
            }
          }
        }
      } catch (reconcileErr) {
        console.error(`[insights] create-role: common-access reconcile-with-evaluation failed for role ${resp.data.id}:`, reconcileErr.response?.data || reconcileErr.message);
      }
    }

    const baseEntIds = new Set(group.commonAccess.map((e) => e.id));

    // One dimension-creation task per (attribute, distinct value) pair
    // across all varying attributes, flattened into a single sequential
    // queue — sequential because SailPoint's dimension-create endpoint
    // returns intermittent 500s when hit with parallel writes against the
    // same parent role.
    /*
     * Work out every dimension's entitlements before creating anything, so
     * they can be filtered against each other. The scan already computed
     * exactly this, so reuse it when present — that guarantees the role
     * created matches the breakdown that was reviewed and approved, and skips
     * re-fetching every member's entitlements. Scans predating the preview
     * fall back to computing it live.
     */
    const preview = group.dimensionPreview || [];
    const dimensionTasks = [];

    if (preview.length) {
      for (const d of preview) {
        dimensionTasks.push({
          attrKey: d.attribute,
          value: d.value,
          entitlements: d.entitlements.map((e) => ({ id: e.id, type: "ENTITLEMENT", name: e.name })),
        });
      }
    } else {
      for (const attrKey of varyingKeys) {
        const values = [...new Set(group.members.map((m) => m[attrKey]).filter((v) => v && v !== "Unknown"))];
        for (const value of values) dimensionTasks.push({ attrKey, value });
      }
      // Mirrors how SailPoint's own dimensional roles (e.g. "Retail Role")
      // are built: each dimension carries the access unique to that slice of
      // the group, not just a membership-scoping criterion.
      for (const task of dimensionTasks) {
        const subMemberIds = group.members
          .filter((m) => m[task.attrKey] === task.value)
          .map((m) => m.id);
        const subEntitlementLists = await mapWithConcurrency(subMemberIds, 4, async (memberId) => {
          try {
            return await withApiRetry(
              () => iscGet(tenant, token, `/v2026/entitlements/identities/${memberId}/entitlements`, { limit: 100 }),
              { label: `create-role dimension sub-member entitlements for ${memberId}` }
            );
          } catch {
            return [];
          }
        });
        const nameById = new Map();
        for (const list of subEntitlementLists) for (const e of list) nameById.set(e.id, e.name);
        let subCommonIds = new Set((subEntitlementLists[0] || []).map((e) => e.id));
        for (const list of subEntitlementLists.slice(1)) {
          const ids = new Set(list.map((e) => e.id));
          subCommonIds = new Set([...subCommonIds].filter((id) => ids.has(id)));
        }
        task.entitlements = [...subCommonIds]
          .filter((id) => !baseEntIds.has(id))
          .map((id) => ({ id, type: "ENTITLEMENT", name: nameById.get(id) }));
      }

      // Drop anything granted by more than one dimension — it doesn't
      // distinguish any of them. Same rule the scan preview applies.
      const counts = new Map();
      for (const t of dimensionTasks) {
        for (const e of t.entitlements) counts.set(e.id, (counts.get(e.id) || 0) + 1);
      }
      for (const t of dimensionTasks) {
        t.entitlements = t.entitlements.filter((e) => counts.get(e.id) === 1);
      }
    }

    const dimensionsCreated = await mapWithConcurrency(dimensionTasks, 1, async ({ attrKey, value, entitlements }) => {
      const uniqueEntitlements = entitlements || [];

      try {
        const dimResp = await axios.post(
          `https://${tenantApiHost(tenant)}/v2026/roles/${resp.data.id}/dimensions`,
          {
            name: value,
            description: `${labelize(attrKey)}: ${value}`,
            entitlements: uniqueEntitlements,
            accessProfiles: [],
            membership: {
              type: "STANDARD",
              criteria: {
                operation: "AND",
                key: null,
                stringValue: "",
                children: [{
                  operation: "EQUALS",
                  key: { type: "IDENTITY", property: `attribute.${attrKey}`, sourceId: null },
                  stringValue: value,
                  children: null,
                }],
              },
            },
          },
          { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }
        );
        return { attribute: attrKey, value, id: dimResp.data.id, ok: true, entitlements: uniqueEntitlements };
      } catch (dimErr) {
        console.error(`[insights] dimension create failed for ${attrKey}=${value}:`, dimErr.response?.data || dimErr.message);
        return { attribute: attrKey, value, ok: false, error: dimErr.response?.data?.detailCode || dimErr.message };
      }
    });

    // Tag the new role — and every entitlement on it, dimensions included —
    // with its data-segment metadata value, the same check Role Evaluation
    // runs (ensureRoleSegmentMetadata). Common Access roles already got it
    // from their reconcile evaluation above; every other role, dynamic ones
    // included, gets no evaluation at creation, so without this they were
    // left untagged until a segment create happened to tag them. Only when
    // this tenant manages data segments; best-effort, never fails the create.
    let segmentMetadata = null;
    try {
      const segSchema = await schemaAnalyses.get(tenant);
      if (segSchema?.roleBoundaryEnabled && segSchema.createDataSegments) {
        const segToken = await sessionToken(session);
        segmentMetadata = await ensureRoleSegmentMetadata(
          tenant, segToken,
          { ...resp.data, entitlements: resp.data.entitlements || group.commonAccess || [] },
          dimensionsCreated.filter((d) => d.ok).map((d) => ({ entitlements: d.entitlements || [] })),
          segSchema.roleBoundaryAttributes || []
        );
      }
    } catch (tagErr) {
      console.error(`[insights] create-role: segment metadata tagging failed for role ${resp.data.id}:`, tagErr.response?.data || tagErr.message);
      segmentMetadata = { error: describeError(tagErr), values: [] };
    }

    group.roleCreated = {
      id: resp.data.id,
      name: resp.data.name,
      createdAt: new Date().toISOString(),
      dimensional: isDynamic,
      dimensionAttributes: varyingKeys,
      dimensions: dimensionsCreated,
    };
    await updateRoleScan(req.params.id, { groups: scan.groups });

    res.json({ role: resp.data, dimensions: dimensionsCreated, commonAccessFlagged, commonAccessError, segmentMetadata });
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[insights] create-role failed:", err.response?.data || err.message);
    res.status(status).json({ error: err.response?.data?.detailCode || err.response?.data?.message || err.message });
  }
});

/**
 * POST /api/insights/role-scans/:id/groups/:groupId/merge-into-existing-role
 * When a peer group's exact attribute combination already matches an
 * existing role (group.existingRole — set above in runRoleScan), this adds
 * the group's own proposed common access (group.commonAccess) onto that
 * role instead of creating a duplicate. Meant for use when Allow Duplicate
 * Roles is off and the scan found access the existing role doesn't grant
 * yet; nothing stops it being used with duplicates allowed too. Only
 * regular peer groups carry commonAccess for this purpose — a Common
 * Access scope proposal that already matched an existing role reports []
 * (see runRoleScan), so there's nothing here to merge for it.
 */
app.post("/api/insights/role-scans/:id/groups/:groupId/merge-into-existing-role", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;

  const scan = roleScanForSession(await roleScans.get(req.params.id), session);
  const group = scan?.groups?.find((g) => g.id === req.params.groupId);
  if (!group) return res.status(404).json({ error: "Peer group not found." });
  if (!group.existingRole) {
    return res.status(400).json({ error: "This peer group has no matching existing role to merge into." });
  }
  if (!group.commonAccess?.length) {
    return res.status(400).json({ error: "This peer group has no proposed access to merge." });
  }

  try {
    const token = await sessionToken(session);
    // Diffed against the role's own current entitlements (not just handed
    // to patchRoleEntitlements' own internal add-if-missing dedup) so the
    // response can report how many were actually new — merging a group
    // that turns out to already be fully covered should say "0 added", not
    // silently succeed with no way to tell the two cases apart.
    const before = await withApiRetry(
      () => iscGet(tenant, token, `/v2026/roles/${group.existingRole.id}`),
      { label: `merge-into-existing-role: fetch role ${group.existingRole.id}` }
    );
    const beforeIds = new Set((before.entitlements || []).map((e) => e.id));
    const toAdd = group.commonAccess.filter((e) => !beforeIds.has(e.id));

    if (toAdd.length > 0) {
      const patchToken = await sessionToken(session);
      await patchRoleEntitlements(tenant, patchToken, group.existingRole.id, { add: toAdd });
    }

    group.mergedIntoExisting = {
      roleId: group.existingRole.id,
      roleName: group.existingRole.name,
      mergedAt: new Date().toISOString(),
      addedCount: toAdd.length,
    };
    await updateRoleScan(req.params.id, { groups: scan.groups });

    res.json({ roleId: group.existingRole.id, roleName: group.existingRole.name, addedCount: toAdd.length });
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error(`[insights] merge-into-existing-role failed for group ${req.params.groupId}:`, err.response?.data || err.message);
    res.status(status).json({ error: err.response?.data?.detailCode || err.response?.data?.message || err.message });
  }
});

// ─── Skeleton role generation ──────────────────────────────────────────────────
// A lighter-weight relative of the peer-group scan: no entitlement fetching
// at all (this is the whole point — skeleton roles carry membership and
// dimensions only, never entitlements), so it's cheap enough to run across
// every active identity in the tenant rather than needing a Scan Scope.
// Buckets purely by the top attribute (from Schema Analysis / Mining
// Config, same attributeKeys a real scan would use) — one role per distinct
// value — and, if Create Dynamic Roles is on and a second attribute key
// exists, one dimension per distinct value of that second attribute within
// each bucket. Ignores existing-role duplicate checking entirely (the user
// explicitly asked for that) and creates every role disabled, since a
// skeleton with no entitlements has nothing safe to grant yet.

// Server-side mirror of client/src/lib/roleNaming.js's applyRoleNaming —
// duplicated rather than shared since the client lib isn't reachable from
// here, same reasoning as every other small client/server pair in this app.
function applyRoleNamingServer(baseName, rolePrefix, roleSuffix) {
  const prefix = rolePrefix || "";
  const suffix = roleSuffix || "";
  let result = baseName;
  if (prefix && !result.startsWith(prefix)) result = prefix + result;
  if (suffix && !result.endsWith(suffix)) result = result + suffix;
  return result;
}

const skeletonScans = createRecordStore(DATA_DIR, "skeleton-scans.json");

async function updateSkeletonScan(scanId, patch) {
  await skeletonScans.put(scanId, { ...(await skeletonScans.get(scanId)), ...patch });
}
const cancelledSkeletonScans = new Set();

function skeletonScanForSession(scan, session) {
  return scan && scan.tenant === session.tenant ? scan : null;
}

/**
 * Plans a Skeleton Role Model draft: one proposed role per distinct value
 * of the primary attribute (per Boundary partition when on), plus a Common
 * Access role per partition when the Scan Scope is a simple attribute=value
 * query — exactly the roles the old one-shot run used to create outright,
 * but stored here as a DRAFT (name, description, membership, members,
 * dimensions) and created in ISC only on demand from the draft screen, one
 * at a time or all at once, so the model can be reviewed and printed first.
 */
async function runSkeletonScan(scanId, session, namingOverrides) {
  const { tenant } = session;
  const settings = await getTenantSettings(tenant);
  // rolePrefix/roleSuffix used to name every skeleton role — the caller's
  // own naming (typed on the Skeleton Roles screen, never persisted) wins
  // when provided, otherwise Mining Config's saved defaults.
  const rolePrefix = namingOverrides?.rolePrefix ?? settings.rolePrefix;
  const roleSuffix = namingOverrides?.roleSuffix ?? settings.roleSuffix;
  const attributeSeparator = namingOverrides?.attributeSeparator ?? settings.attributeSeparator ?? " - ";
  const attributeKeys = await getRoleScanAttributeKeys(tenant);
  const primaryKey = attributeKeys[0];
  const secondaryKey = settings.createDynamicRoles ? attributeKeys[1] : null;

  // Multi-Company/Division Boundary — same setting Role Scan partitions by.
  // useBoundary lets this one run opt in/out regardless of the persisted
  // setting; undefined falls back to Schema Analysis's roleBoundaryEnabled.
  const boundaryAnalysis = await schemaAnalyses.get(tenant);
  const roleBoundaryEnabled = namingOverrides?.useBoundary !== undefined
    ? !!namingOverrides.useBoundary
    : !!boundaryAnalysis?.roleBoundaryEnabled;
  const roleBoundaryAttributes = roleBoundaryEnabled ? (boundaryAnalysis?.roleBoundaryAttributes || []) : [];
  const profileAttributeKeys = roleBoundaryAttributes.length > 0
    ? [...new Set([...attributeKeys, ...roleBoundaryAttributes])]
    : attributeKeys;

  await updateSkeletonScan(scanId, {
    attributeKeys, primaryKey, secondaryKey, rolePrefix, roleSuffix, attributeSeparator,
    roleBoundaryEnabled: roleBoundaryAttributes.length > 0, roleBoundaryAttributes,
    scopeQuery: settings.nameScope || null, createDynamicRoles: !!settings.createDynamicRoles,
  });

  try {
    const scopeIds = await fetchScopeIds(tenant, await sessionToken(session), ["identities"], settings.nameScope);

    const profiles = [];
    await searchAllIdentities(tenant, () => sessionToken(session), {
      pageSize: 250,
      onPage: async (page, totalScanned) => {
        if (cancelledSkeletonScans.has(scanId)) return false;
        for (const idn of page) {
          if (scopeIds && !scopeIds.has(idn.id)) continue;
          const attrs = {};
          for (const key of profileAttributeKeys) attrs[key] = idn.attributes?.find((a) => a.key === key)?.value || "Unknown";
          profiles.push({ id: idn.id, name: idn.name, email: idn.email || null, manager: idn.manager?.name || null, attrs });
        }
        await updateSkeletonScan(scanId, { scanned: totalScanned });
      },
    });

    if (cancelledSkeletonScans.has(scanId)) {
      cancelledSkeletonScans.delete(scanId);
      await updateSkeletonScan(scanId, { status: "cancelled", completedAt: new Date().toISOString() });
      return;
    }

    const planned = [];
    // Only supported when the scope query is a simple single attribute=value
    // query (see parseSimpleScopeCriteria) — same across every partition.
    const scopeCriteria = parseSimpleScopeCriteria(settings.nameScope);
    const partitions = roleBoundaryAttributes.length > 0
      ? partitionProfilesByBoundary(profiles, roleBoundaryAttributes)
      : [{ values: [], profiles }];

    for (const partition of partitions) {
      if (cancelledSkeletonScans.has(scanId)) break;
      const boundaryLeaves = roleBoundaryAttributes.map((key, i) => ({ key, value: partition.values[i] }));
      const boundaryNamePart = boundaryLeaves.map((l) => l.value).join(attributeSeparator);
      const boundaryDescPart = boundaryLeaves.length
        ? ` and ${boundaryLeaves.map((l) => `${l.key} = "${l.value}"`).join(", ")}`
        : "";
      const boundaryCriteriaLeaves = boundaryLeaves.map((l) => ({
        operation: "EQUALS",
        key: { type: "IDENTITY", property: `attribute.${l.key}`, sourceId: null },
        values: [l.value], stringValue: null, children: null,
      }));
      const members = (list) => list.map((p) => ({ id: p.id, name: p.name, email: p.email || null, manager: p.manager || null })).sort((a, b) => String(a.name).localeCompare(String(b.name)));

      // Common Access role for this partition: membership is the scope plus
      // the partition's boundary values; never any entitlements.
      if (scopeCriteria) {
        const commonAccessName = applyRoleNamingServer(
          [boundaryNamePart, "Common Access"].filter(Boolean).join(" - "),
          rolePrefix, roleSuffix
        );
        const scopeLeaf = {
          operation: "EQUALS",
          key: { type: "IDENTITY", property: `attribute.${scopeCriteria.attrKey}`, sourceId: null },
          values: [scopeCriteria.value], stringValue: null, children: null,
        };
        planned.push({
          kind: "commonAccess", isCommonAccess: true,
          roleName: commonAccessName,
          description: `Skeleton Common Access role for scope ${scopeCriteria.attrKey} = "${scopeCriteria.value}"${boundaryDescPart} — membership only, no entitlements assigned yet.`,
          criteria: [{ key: scopeCriteria.attrKey, value: scopeCriteria.value }, ...boundaryLeaves],
          boundary: boundaryLeaves,
          membership: {
            type: "STANDARD",
            criteria: boundaryCriteriaLeaves.length > 0
              ? { operation: "AND", key: null, values: null, stringValue: null, children: [scopeLeaf, ...boundaryCriteriaLeaves] }
              : scopeLeaf,
          },
          memberCount: partition.profiles.length,
          members: members(partition.profiles),
          dimensional: false, dimensionAttribute: null, dimensionValues: [],
          entitlements: [],
        });
      }

      const buckets = new Map();
      for (const p of partition.profiles) {
        const value = p.attrs[primaryKey];
        if (!value || value === "Unknown") continue;
        if (!buckets.has(value)) buckets.set(value, []);
        buckets.get(value).push(p);
      }
      for (const [value, bucket] of [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        if (cancelledSkeletonScans.has(scanId)) break;
        // Skeleton roles never carry entitlements — membership and dimensions only.
        const roleName = applyRoleNamingServer([...boundaryLeaves.map((l) => l.value), value].join(attributeSeparator), rolePrefix, roleSuffix);
        const dimValues = secondaryKey
          ? [...new Set(bucket.map((m) => m.attrs[secondaryKey]).filter((v) => v && v !== "Unknown"))].sort()
          : [];
        const isDynamic = dimValues.length > 0;
        // Members per dimension value — for the draft screen and printout.
        const dimensionCounts = isDynamic
          ? dimValues.map((dv) => ({ value: dv, members: bucket.filter((m) => m.attrs[secondaryKey] === dv).length }))
          : [];
        const membership = {
          type: "STANDARD",
          criteria: {
            operation: "OR", key: null, values: null, stringValue: null,
            children: [{
              operation: "AND", key: null, values: null, stringValue: null,
              children: [
                { operation: "EQUALS", key: { type: "IDENTITY", property: "attribute.cloudLifecycleState", sourceId: null }, values: ["active"], stringValue: null, children: null },
                { operation: "EQUALS", key: { type: "IDENTITY", property: `attribute.${primaryKey}`, sourceId: null }, values: [value], stringValue: null, children: null },
                ...boundaryCriteriaLeaves,
              ],
            }],
          },
        };
        planned.push({
          kind: "role", isCommonAccess: false,
          roleName,
          description: `Skeleton role auto-generated for ${primaryKey} = "${value}"${boundaryDescPart} — membership and dimensions only, no entitlements assigned yet.`,
          criteria: [...boundaryLeaves, { key: primaryKey, value }],
          boundary: boundaryLeaves,
          membership,
          memberCount: bucket.length,
          members: members(bucket),
          dimensional: isDynamic, dimensionAttribute: isDynamic ? secondaryKey : null, dimensionValues: dimValues, dimensionCounts,
          entitlements: [],
        });
        await updateSkeletonScan(scanId, { planned: planned.length });
      }
    }

    if (cancelledSkeletonScans.has(scanId)) {
      cancelledSkeletonScans.delete(scanId);
      await updateSkeletonScan(scanId, { status: "cancelled", completedAt: new Date().toISOString() });
      return;
    }

    const results = planned.map((p, index) => ({ ...p, index, status: "planned", roleId: null, error: null }));
    await updateSkeletonScan(scanId, {
      status: "completed", completedAt: new Date().toISOString(),
      results, planned: results.length, created: 0, failed: 0,
    });
  } catch (err) {
    cancelledSkeletonScans.delete(scanId);
    console.error(`[insights] skeleton scan ${scanId} failed:`, err.response?.data || err.message);
    await updateSkeletonScan(scanId, { status: "failed", completedAt: new Date().toISOString(), error: describeError(err) });
  }
}

/** Creates one planned skeleton role in ISC (disabled, not requestable) with its dimensions and Common Access flag. */
async function createSkeletonRoleInIsc(tenant, session, item) {
  const labelize = (k) => (k || "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
  const token = await sessionToken(session);
  const resp = await axios.post(
    `https://${tenantApiHost(tenant)}/v2026/roles`,
    {
      name: item.roleName,
      description: item.description,
      owner: { type: "IDENTITY", id: session.identity?.id, name: session.identity?.username },
      entitlements: [],
      enabled: false,
      requestable: false,
      membership: item.membership,
      ...(item.dimensional
        ? {
            dimensional: true,
            accessRequestConfig: {
              dimensionSchema: { dimensionAttributes: [{ name: item.dimensionAttribute, displayName: labelize(item.dimensionAttribute), derived: true }] },
            },
          }
        : {}),
    },
    { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }
  );
  const role = resp.data;
  const out = { roleId: role.id, roleName: role.name || item.roleName, dimensions: [], commonAccessFlagged: null, commonAccessError: null };
  if (item.isCommonAccess) {
    try {
      await flagRoleAsCommonAccess(tenant, await sessionToken(session), role.id);
      out.commonAccessFlagged = true;
    } catch (caErr) {
      console.error(`[insights] skeleton: common-access flag failed for role ${role.id}:`, caErr.response?.data || caErr.message);
      out.commonAccessFlagged = false;
      out.commonAccessError = describeError(caErr);
    }
  }
  if (item.dimensional) {
    for (const dv of item.dimensionValues || []) {
      try {
        await createRoleDimensionOnServer(tenant, await sessionToken(session), role.id, { name: dv, attrKey: item.dimensionAttribute, value: dv, entitlements: [] });
        out.dimensions.push({ value: dv, ok: true });
      } catch (err) {
        out.dimensions.push({ value: dv, ok: false, error: describeError(err) });
      }
    }
  }
  return out;
}

/**
 * POST /api/insights/skeleton-scans
 * Body (optional): { rolePrefix, roleSuffix, attributeSeparator, useBoundary }
 * — one-off overrides for this draft only, never persisted. Starts
 * planning a Skeleton Role Model draft; nothing is created in ISC.
 */
app.post("/api/insights/skeleton-scans", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  const { rolePrefix, roleSuffix, attributeSeparator, useBoundary } = req.body || {};

  const scanId = `skeletonscan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await updateSkeletonScan(scanId, {
    id: scanId,
    tenant,
    status: "running",
    startedAt: new Date().toISOString(),
    completedAt: null,
    scanned: 0,
    planned: 0,
    created: 0,
    failed: 0,
    results: [],
    error: null,
  });

  runSkeletonScan(scanId, session, { rolePrefix, roleSuffix, attributeSeparator, useBoundary });

  res.status(202).json({ scanId });
});

/** GET /api/insights/skeleton-scans — drafts, newest first (results stripped for size). */
app.get("/api/insights/skeleton-scans", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const list = Object.values(await skeletonScans.all())
    .filter((s) => s.tenant === session.tenant)
    .map(({ results, ...meta }) => ({ ...meta, planned: meta.planned ?? (results || []).length, created: meta.created ?? (results || []).filter((r) => r.roleId || r.ok).length }))
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
  res.json(list);
});

/** GET /api/insights/skeleton-scans/:id — full draft with every proposed role and its members. */
app.get("/api/insights/skeleton-scans/:id", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const scan = skeletonScanForSession(await skeletonScans.get(req.params.id), session);
  if (!scan) return res.status(404).json({ error: "Skeleton scan not found." });
  res.json(scan);
});

/**
 * POST /api/insights/skeleton-scans/:id/results/:index/create — creates ONE
 * planned role from the draft in ISC. A failed row can be retried; an
 * already-created row is refused.
 */
app.post("/api/insights/skeleton-scans/:id/results/:index/create", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  const scan = skeletonScanForSession(await skeletonScans.get(req.params.id), session);
  if (!scan) return res.status(404).json({ error: "Skeleton scan not found." });
  if (scan.status === "running") return res.status(400).json({ error: "Wait for planning to finish first." });
  const index = Number(req.params.index);
  const item = Number.isInteger(index) ? (scan.results || [])[index] : null;
  if (!item) return res.status(404).json({ error: "Role not found in this draft." });
  if (item.roleId) return res.status(400).json({ error: "This role has already been created in ISC." });
  const wasFailed = item.status === "failed";
  try {
    const created = await createSkeletonRoleInIsc(tenant, session, item);
    const updated = { ...item, ...created, status: "created", ok: true, error: null, createdAt: new Date().toISOString() };
    const results = scan.results.map((r, i) => (i === index ? updated : r));
    await updateSkeletonScan(scan.id, { results, created: (scan.created || 0) + 1, failed: Math.max(0, (scan.failed || 0) - (wasFailed ? 1 : 0)) });
    const { members, membership, ...slim } = updated;
    res.json(slim);
  } catch (err) {
    console.error(`[insights] skeleton: role "${item.roleName}" failed:`, err.response?.data || err.message);
    const updated = { ...item, status: "failed", ok: false, error: describeError(err) };
    const results = scan.results.map((r, i) => (i === index ? updated : r));
    await updateSkeletonScan(scan.id, { results, failed: (scan.failed || 0) + (wasFailed ? 0 : 1) });
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/** POST /api/insights/skeleton-scans/:id/cancel */
app.post("/api/insights/skeleton-scans/:id/cancel", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const scan = skeletonScanForSession(await skeletonScans.get(req.params.id), session);
  if (!scan) return res.status(404).json({ error: "Skeleton scan not found." });
  if (scan.status === "running") cancelledSkeletonScans.add(req.params.id);
  res.status(202).json({ ok: true });
});

/** DELETE /api/insights/skeleton-scans/:id — removes the draft record only; roles already created stay in ISC. */
app.delete("/api/insights/skeleton-scans/:id", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const scan = skeletonScanForSession(await skeletonScans.get(req.params.id), session);
  if (!scan) return res.status(404).json({ error: "Skeleton scan not found." });
  if (scan.status === "running") return res.status(400).json({ error: "Wait for planning to finish (or cancel it) before removing it." });
  await skeletonScans.delete(req.params.id);
  res.status(204).end();
});

// ─── Configuration: tenant settings ───────────────────────────────────────────
// Small persisted per-tenant preferences that affect how Role Mining behaves.
// File-based like the other Insights stores here, keyed by tenant.

const DEFAULT_TENANT_SETTINGS = {
  createDynamicRoles: true, rolePrefix: "The ", roleSuffix: " Role", attributeSeparator: " - ",
  allowDuplicateRoles: true, nameScope: "attributes.cloudLifecycleState:active",
  considerCommonRoles: true, checkSodViolations: true, allowSodMitigations: true,
  // Global Metadata attribute Segments by Metadata tags and filters on.
  segmentMetadataAttribute: "Segments",
  // Which roles Role Evaluation tasks (Start, Role Statistics Refresh's
  // scheduled runs, and Run Now) actually evaluate — "ALL", "ENABLED_ONLY"
  // (default — matches Role Statistics Refresh's prior hardcoded behavior,
  // which drives the Home screen's pass/needs-update counts), or
  // "DISABLED_ONLY". Applied per role in runRoleEvalScan (ISC's
  // /v2026/roles isn't queryable on enabled).
  roleFilterMode: "ENABLED_ONLY",
  // How commonly an entitlement must be held (percentage of a group's/
  // role's members) to count as "shared" — used both when a Role Draft
  // scan decides which entitlements go on a group's base/dimensions, and
  // when Role Evaluation decides an existing role's held-but-not-granted
  // gaps. Keeping the two in sync is the whole point of this setting: a
  // scan-created role shouldn't immediately look wrong to its own
  // evaluation just because the two used different bars.
  entitlementCommonalityThreshold: 80,
  // How many past Role Evaluation scan records (results included) to keep
  // for a tenant — the oldest ones beyond this count are purged at the end
  // of every scan (see pruneRoleEvalScans), regardless of how that scan
  // itself finished. Bounds roleEvalScans' on-disk size, which otherwise
  // grows without limit (each scan's results array carries every role's
  // full evaluation).
  roleEvalRetention: 10,
};

/** Runs a raw ISC Search query and returns how many docs it matches, via x-total-count. */
async function countSearchMatches(tenant, token, indices, query) {
  const resp = await axios.post(
    `https://${tenantApiHost(tenant)}/v2026/search`,
    { indices, query: { query } },
    { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, params: { limit: 1, count: true } }
  );
  return Number(resp.headers["x-total-count"] || 0);
}

const tenantSettings = createRecordStore(DATA_DIR, "tenant-settings.json");

async function getTenantSettings(tenant) {
  return { ...DEFAULT_TENANT_SETTINGS, ...((await tenantSettings.get(tenant)) || {}) };
}

/** GET /api/insights/settings — this tenant's settings, defaulted if none saved yet. */
app.get("/api/insights/settings", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  res.json(await getTenantSettings(session.tenant));
});

/**
 * PUT /api/insights/settings
 * Body: any subset of { createDynamicRoles: boolean, rolePrefix: string,
 *   roleSuffix: string, attributeSeparator: string, allowDuplicateRoles: boolean,
 *   nameScope: string }
 * Only the fields present in the body are validated and updated — the rest
 * of the tenant's settings are left as they were. String fields are stored
 * exactly as sent (including leading/trailing spaces) — nothing here trims
 * them, since e.g. attributeSeparator " - " depends on its surrounding
 * spaces.
 *   - createDynamicRoles: when false, Scan for Roles' create-role always
 *     creates a plain (simple) role, even when the peer group has
 *     attributes that would otherwise vary into dimensions.
 *   - rolePrefix / roleSuffix: wrapped around a peer group's criteria (e.g.
 *     "Engineering - Production Test Engineer I") to form the proposed Role
 *     name shown at create-role time.
 *   - attributeSeparator: joins a peer group's matched attribute values into
 *     that criteria text in the first place (default " - ").
 *   - allowDuplicateRoles: when false, Scan for Roles drops any peer group
 *     whose attribute combination already matches an existing role's
 *     membership criteria before the scan even finishes, instead of just
 *     flagging it. Locked into each scan record at start time (see
 *     POST /role-scans) so a later Configuration change doesn't retroactively
 *     alter a scan already in flight or already reported.
 *   - nameScope ("Scan Scope"): a raw ISC Search query string (identities
 *     index) that limits Role Scan to mining roles only within that
 *     population, for targeted Role Mining. Defaults to
 *     "attributes.cloudLifecycleState:active" (verified live: 374 matches
 *     on this tenant). Validated against the real Search API before
 *     saving — both client-side (Role Scanning Configuration's "Check"
 *     button) and here, server-side: a non-empty nameScope that resolves
 *     to 0 matches is rejected outright, since a scope nobody matches
 *     would silently make every future Role Scan mine nothing.
 *   - considerCommonRoles (default true): when false, Role Evaluation stops
 *     excluding common-access role entitlements from its "commonly held"
 *     and "redundant" suggestions — evaluateRoleAlgorithmic just leaves
 *     commonRoleEntIds empty in that case, which is enough on its own to
 *     turn the feature off everywhere it's consulted.
 *   - checkSodViolations (default true): when false, Role Evaluation skips
 *     the SOD policy check entirely (sodPolicies left empty, same
 *     "empty is enough" mechanism as above).
 *   entitlementCommonalityThreshold (default 80): the percentage of a
 *     group's/role's members that must hold an entitlement for it to count
 *     as "shared" — used both by Role Draft scans (buildPeerGroups, which
 *     entitlements a group's base/dimensions actually get) and by Role
 *     Evaluation (its own >= threshold checks for held-but-not-granted
 *     gaps), so a scan-created role and its first evaluation agree on what
 *     "commonly held" means.
 */
app.put("/api/insights/settings", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const {
    createDynamicRoles, rolePrefix, roleSuffix, attributeSeparator, allowDuplicateRoles, nameScope,
    considerCommonRoles, checkSodViolations, allowSodMitigations, entitlementCommonalityThreshold, roleEvalRetention,
    roleFilterMode, segmentMetadataAttribute,
  } = req.body || {};
  const next = { ...(await getTenantSettings(session.tenant)) };

  if (createDynamicRoles !== undefined) {
    if (typeof createDynamicRoles !== "boolean") {
      return res.status(400).json({ error: "createDynamicRoles must be a boolean." });
    }
    next.createDynamicRoles = createDynamicRoles;
  }
  if (rolePrefix !== undefined) {
    if (typeof rolePrefix !== "string") {
      return res.status(400).json({ error: "rolePrefix must be a string." });
    }
    next.rolePrefix = rolePrefix;
  }
  if (roleSuffix !== undefined) {
    if (typeof roleSuffix !== "string") {
      return res.status(400).json({ error: "roleSuffix must be a string." });
    }
    next.roleSuffix = roleSuffix;
  }
  if (attributeSeparator !== undefined) {
    if (typeof attributeSeparator !== "string") {
      return res.status(400).json({ error: "attributeSeparator must be a string." });
    }
    next.attributeSeparator = attributeSeparator;
  }
  if (allowDuplicateRoles !== undefined) {
    if (typeof allowDuplicateRoles !== "boolean") {
      return res.status(400).json({ error: "allowDuplicateRoles must be a boolean." });
    }
    next.allowDuplicateRoles = allowDuplicateRoles;
  }
  if (nameScope !== undefined) {
    if (typeof nameScope !== "string") {
      return res.status(400).json({ error: "nameScope must be a string." });
    }
    if (nameScope.trim()) {
      try {
        const token = await sessionToken(session);
        const count = await countSearchMatches(session.tenant, token, ["identities"], nameScope);
        if (count === 0) {
          return res.status(400).json({ error: "This scope matches 0 users — not saved." });
        }
      } catch (err) {
        const status = err.sessionExpired ? 401 : err.response?.status || 500;
        return res.status(status).json({ error: err.response?.data?.messages?.[0]?.text || describeError(err) });
      }
    }
    next.nameScope = nameScope;
  }
  if (considerCommonRoles !== undefined) {
    if (typeof considerCommonRoles !== "boolean") {
      return res.status(400).json({ error: "considerCommonRoles must be a boolean." });
    }
    next.considerCommonRoles = considerCommonRoles;
  }
  if (roleFilterMode !== undefined) {
    if (!["ALL", "ENABLED_ONLY", "DISABLED_ONLY"].includes(roleFilterMode)) {
      return res.status(400).json({ error: "roleFilterMode must be one of ALL, ENABLED_ONLY, DISABLED_ONLY." });
    }
    next.roleFilterMode = roleFilterMode;
  }
  if (checkSodViolations !== undefined) {
    if (typeof checkSodViolations !== "boolean") {
      return res.status(400).json({ error: "checkSodViolations must be a boolean." });
    }
    next.checkSodViolations = checkSodViolations;
  }
  if (allowSodMitigations !== undefined) {
    if (typeof allowSodMitigations !== "boolean") {
      return res.status(400).json({ error: "allowSodMitigations must be a boolean." });
    }
    next.allowSodMitigations = allowSodMitigations;
  }
  if (entitlementCommonalityThreshold !== undefined) {
    if (typeof entitlementCommonalityThreshold !== "number" || entitlementCommonalityThreshold < 1 || entitlementCommonalityThreshold > 100) {
      return res.status(400).json({ error: "entitlementCommonalityThreshold must be a number between 1 and 100." });
    }
    next.entitlementCommonalityThreshold = entitlementCommonalityThreshold;
  }
  if (roleEvalRetention !== undefined) {
    if (typeof roleEvalRetention !== "number" || !Number.isInteger(roleEvalRetention) || roleEvalRetention < 1 || roleEvalRetention > 20) {
      return res.status(400).json({ error: "roleEvalRetention must be a whole number between 1 and 20." });
    }
    next.roleEvalRetention = roleEvalRetention;
  }
  if (segmentMetadataAttribute !== undefined) {
    // Non-empty required: an empty name would make Segments by Metadata tag
    // and filter on a nameless attribute — nonsense ISC would reject anyway.
    if (typeof segmentMetadataAttribute !== "string" || !segmentMetadataAttribute.trim()) {
      return res.status(400).json({ error: "segmentMetadataAttribute must be a non-empty string." });
    }
    next.segmentMetadataAttribute = segmentMetadataAttribute.trim();
  }

  await tenantSettings.put(session.tenant, next);
  res.json(next);
});

// ─── Studio Settings: Preferences ─────────────────────────────────────────────
// A tenant's app-level preferences, distinct from the Role Mining/Evaluation
// settings above — currently just the Role Statistics Refresh schedule (see
// the scheduler further down). This is TENANT data: every user signed into
// this tenant shares one copy, same as Role Scans/Skeleton Scans/Role Eval
// Scans/tenant settings/SOD mitigations above. Anything that should differ
// per signed-in user (e.g. dark mode) belongs in User Preferences instead —
// see that section below, not here.

const DEFAULT_STUDIO_PREFERENCES = {
  roleStatsRefreshEnabled: false,
  roleStatsRefreshFrequency: "DAILY", // "HOURLY" | "DAILY" | "WEEKLY"
  roleStatsRefreshTimeOfDay: "06:00", // HH:mm, 24h — the anchor time for DAILY/WEEKLY; for HOURLY, only its minute component is used
  roleStatsRefreshStartDate: null, // "YYYY-MM-DD" — first eligible run; refresh stays off until this is set
  // Internal bookkeeping for the scheduler (see computeMostRecentDueSlot) —
  // not user-editable, just persisted so a server restart doesn't
  // re-trigger whichever slot most recently fired.
  roleStatsLastRunSlot: null,
  // User Certifications (Studio Settings > User Certifications) — defaults
  // applied to every campaign draft Mining > Certifications creates.
  certAttributeKeys: [], // Schema Analysis candidate keys to certify by; empty = fall back to the Role Creation Priority Order
  certNotificationsEnabled: true,
  certUndecidedAccess: "MAINTAIN", // "MAINTAIN" | "REVOKE" — what happens to undecided access at the deadline
  certCommentRequirement: "NO_DECISIONS", // "NO_DECISIONS" | "ALL_DECISIONS" | "REVOKE_ONLY_DECISIONS"
  certDurationDays: 30, // 7 | 14 | 30
  // Text put before / after every drafted campaign's root name (the
  // attribute value(s), e.g. "Engineering - Austin"). The prefix has no
  // default. The suffix defaults to the phrase that used to be hard-coded
  // into the name — spaces included, they're the separator — so an untouched
  // tenant still gets "Engineering user access review ", and a tenant that
  // wants different wording just changes the suffix. A tenant's SAVED value
  // (even "") always wins over this default.
  certCampaignPrefix: "",
  certCampaignSuffix: " user access review ",
  certSizeLimit: 10000, // max access items per campaign; a larger one is flagged, not created
  // Campaign item filters — which access items a campaign certifies.
  // Access Item Types: all three = no type filter. The two role options only
  // apply while ROLE is one of the types.
  certAccessItemTypes: ["ROLE", "ACCESS_PROFILE", "ENTITLEMENT"],
  certExcludeBirthrightRoles: false, // a birthright role = any role with a membership rule
  certIncludeCommonAccessRoles: false, // keep Common Access roles even when birthright roles are excluded
  certPrivilegeFilters: [], // [{ level: HIGH|MEDIUM|LOW|NOT_SET, mode: INCLUDE|EXCLUDE }] — Include levels OR-ed, Exclude levels OR-ed; NOT_SET = no privilege level on the item
  certPrivilegeLevel: "IGNORE", // legacy single-level form, honoured only while certPrivilegeFilters is empty
  certPrivilegeMode: "INCLUDE",
  certMetadataFilters: [], // [{ key, value, mode: INCLUDE|EXCLUDE, attributeName?, valueName? }] — Include pairs OR-ed, Exclude pairs OR-ed
  certMetadataMode: "INCLUDE", // legacy default for a pair saved without its own mode
  // Included Sources, stored as the sources the admin UNTICKED ([{ id, name }])
  // rather than the ticked ones — so the default really is "every source",
  // and a source added to the tenant later is included without anyone having
  // to come back and tick it. Only access profiles and entitlements have a
  // source; roles are never affected.
  certExcludedSources: [],
  certSearchFilter: "attributes.cloudLifecycleState:active", // ISC Search query over IDENTITIES — who each campaign covers
  certSearchMode: "INCLUDE", // INCLUDE: only matching identities; EXCLUDE: everyone but
};

const studioPreferences = createRecordStore(DATA_DIR, "studio-preferences.json");

const CERT_NAME_AFFIX_MAX = 50;
/**
 * prefix + name + suffix, joined EXACTLY as typed — leading and trailing
 * spaces in the prefix/suffix are the user's own separator ("Q3 - ", " (SOX)")
 * and are kept; nothing is inserted or trimmed here.
 */
function certificationCampaignName(baseName, settings) {
  const part = (v) => (typeof v === "string" ? v : "");
  return `${part(settings?.certCampaignPrefix)}${baseName}${part(settings?.certCampaignSuffix)}`;
}

async function getStudioPreferences(tenant) {
  return { ...DEFAULT_STUDIO_PREFERENCES, ...((await studioPreferences.get(tenant)) || {}) };
}
async function updateStudioPreferences(tenant, patch) {
  const next = { ...(await getStudioPreferences(tenant)), ...patch };
  await studioPreferences.put(tenant, next);
  return next;
}

/** GET /api/insights/studio-preferences — this tenant's preferences, defaulted if none saved yet. */
app.get("/api/insights/studio-preferences", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  res.json(await getStudioPreferences(session.tenant));
});

/**
 * PUT /api/insights/studio-preferences
 * Body: { roleStatsRefreshEnabled?, roleStatsRefreshFrequency?,
 *         roleStatsRefreshTimeOfDay?, roleStatsRefreshStartDate? }
 * roleStatsLastRunSlot is never accepted here — it's the scheduler's own
 * bookkeeping, not a user-facing setting.
 */
app.put("/api/insights/studio-preferences", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const {
    roleStatsRefreshEnabled, roleStatsRefreshFrequency, roleStatsRefreshTimeOfDay, roleStatsRefreshStartDate,
    certAttributeKeys, certNotificationsEnabled, certUndecidedAccess, certCommentRequirement, certDurationDays, certSizeLimit,
    certPrivilegeLevel, certPrivilegeMode, certPrivilegeFilters, certMetadataFilters, certMetadataMode, certSearchFilter, certSearchMode,
    certCampaignPrefix, certCampaignSuffix,
    certAccessItemTypes, certExcludeBirthrightRoles, certIncludeCommonAccessRoles, certExcludedSources,
  } = req.body || {};
  const next = { ...(await getStudioPreferences(session.tenant)) };

  if (roleStatsRefreshEnabled !== undefined) {
    if (typeof roleStatsRefreshEnabled !== "boolean") {
      return res.status(400).json({ error: "roleStatsRefreshEnabled must be a boolean." });
    }
    next.roleStatsRefreshEnabled = roleStatsRefreshEnabled;
  }
  if (roleStatsRefreshFrequency !== undefined) {
    if (!["HOURLY", "DAILY", "WEEKLY"].includes(roleStatsRefreshFrequency)) {
      return res.status(400).json({ error: "roleStatsRefreshFrequency must be HOURLY, DAILY, or WEEKLY." });
    }
    next.roleStatsRefreshFrequency = roleStatsRefreshFrequency;
  }
  if (roleStatsRefreshTimeOfDay !== undefined) {
    if (!/^\d{2}:\d{2}$/.test(roleStatsRefreshTimeOfDay)) {
      return res.status(400).json({ error: "roleStatsRefreshTimeOfDay must be in HH:mm form." });
    }
    next.roleStatsRefreshTimeOfDay = roleStatsRefreshTimeOfDay;
  }
  if (roleStatsRefreshStartDate !== undefined) {
    if (roleStatsRefreshStartDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(roleStatsRefreshStartDate)) {
      return res.status(400).json({ error: "roleStatsRefreshStartDate must be in YYYY-MM-DD form." });
    }
    next.roleStatsRefreshStartDate = roleStatsRefreshStartDate;
  }
  // User Certifications (Studio Settings > User Certifications) — the
  // campaign attribute defaults Mining > Certifications applies.
  if (certAttributeKeys !== undefined) {
    if (!Array.isArray(certAttributeKeys) || certAttributeKeys.some((k) => typeof k !== "string" || !k.trim())) {
      return res.status(400).json({ error: "certAttributeKeys must be an array of attribute keys." });
    }
    if (new Set(certAttributeKeys).size !== certAttributeKeys.length) {
      return res.status(400).json({ error: "certAttributeKeys must not repeat an attribute." });
    }
    // Only keys Schema Analysis actually found on this tenant's identities
    // — the same candidate list the settings page offers — so a run can
    // never search on an attribute no identity carries.
    const analysis = await schemaAnalyses.get(session.tenant);
    if (analysis) {
      const validKeys = new Set(analysis.candidates.map((c) => c.key));
      if (certAttributeKeys.some((k) => !validKeys.has(k))) {
        return res.status(400).json({ error: "certAttributeKeys must be keys from this tenant's Schema Analysis candidates." });
      }
    } else if (certAttributeKeys.length > 0) {
      return res.status(400).json({ error: "Run Schema Analysis first." });
    }
    next.certAttributeKeys = certAttributeKeys;
  }
  if (certNotificationsEnabled !== undefined) {
    if (typeof certNotificationsEnabled !== "boolean") {
      return res.status(400).json({ error: "certNotificationsEnabled must be a boolean." });
    }
    next.certNotificationsEnabled = certNotificationsEnabled;
  }
  if (certUndecidedAccess !== undefined) {
    if (!CERT_UNDECIDED_ACCESS.has(certUndecidedAccess)) {
      return res.status(400).json({ error: "certUndecidedAccess must be MAINTAIN or REVOKE." });
    }
    next.certUndecidedAccess = certUndecidedAccess;
  }
  if (certCommentRequirement !== undefined) {
    if (!CERT_COMMENT_REQUIREMENTS.has(certCommentRequirement)) {
      return res.status(400).json({ error: "certCommentRequirement must be NO_DECISIONS, ALL_DECISIONS, or REVOKE_ONLY_DECISIONS." });
    }
    next.certCommentRequirement = certCommentRequirement;
  }
  // Campaign Prefix / Suffix: free text stored exactly as typed — leading
  // and trailing spaces included, they're the separator; "" clears it.
  for (const [field, value] of [["certCampaignPrefix", certCampaignPrefix], ["certCampaignSuffix", certCampaignSuffix]]) {
    if (value === undefined) continue;
    if (typeof value !== "string" || value.length > CERT_NAME_AFFIX_MAX || /[\x00-\x1f\x7f]/.test(value)) {
      return res.status(400).json({ error: `${field} must be text of at most ${CERT_NAME_AFFIX_MAX} characters, with no line breaks.` });
    }
    next[field] = value;
  }
  if (certDurationDays !== undefined) {
    if (!CERT_DURATION_DAYS.has(certDurationDays)) {
      return res.status(400).json({ error: "certDurationDays must be 7, 14, or 30." });
    }
    next.certDurationDays = certDurationDays;
  }
  if (certSizeLimit !== undefined) {
    if (!Number.isInteger(certSizeLimit) || certSizeLimit < 1 || certSizeLimit > 1000000) {
      return res.status(400).json({ error: "certSizeLimit must be a whole number from 1 to 1,000,000." });
    }
    next.certSizeLimit = certSizeLimit;
  }
  if (certAccessItemTypes !== undefined) {
    const ok = Array.isArray(certAccessItemTypes) && certAccessItemTypes.length >= 1 &&
      certAccessItemTypes.every((t) => CERT_ACCESS_ITEM_TYPES.includes(t)) &&
      new Set(certAccessItemTypes).size === certAccessItemTypes.length;
    if (!ok) return res.status(400).json({ error: "certAccessItemTypes must be one or more of ROLE, ACCESS_PROFILE, ENTITLEMENT, without repeats — a campaign has to certify something." });
    // Stored in a fixed order so two saves of the same choice are identical.
    next.certAccessItemTypes = CERT_ACCESS_ITEM_TYPES.filter((t) => certAccessItemTypes.includes(t));
  }
  for (const [field, value] of [["certExcludeBirthrightRoles", certExcludeBirthrightRoles], ["certIncludeCommonAccessRoles", certIncludeCommonAccessRoles]]) {
    if (value === undefined) continue;
    if (typeof value !== "boolean") return res.status(400).json({ error: `${field} must be a boolean.` });
    next[field] = value;
  }
  if (certExcludedSources !== undefined) {
    const ok = Array.isArray(certExcludedSources) && certExcludedSources.length <= 1000 && certExcludedSources.every(
      (x) => x && typeof x.id === "string" && /^[A-Za-z0-9-]{8,64}$/.test(x.id) && (x.name === undefined || x.name === null || typeof x.name === "string")
    );
    if (!ok) return res.status(400).json({ error: "certExcludedSources must be an array of { id, name } sources (max 1000)." });
    const seen = new Set();
    next.certExcludedSources = certExcludedSources
      .filter((x) => (seen.has(x.id) ? false : seen.add(x.id)))
      .map((x) => ({ id: x.id, name: x.name ? String(x.name).slice(0, 200) : null }));
  }
  if (certPrivilegeFilters !== undefined) {
    const ok = Array.isArray(certPrivilegeFilters) && certPrivilegeFilters.length <= 4 && certPrivilegeFilters.every(
      (p) => p && ["HIGH", "MEDIUM", "LOW", "NOT_SET"].includes(p.level) && (p.mode === undefined || CERT_FILTER_MODES.has(p.mode))
    );
    if (!ok) return res.status(400).json({ error: "certPrivilegeFilters must be up to 4 { level: HIGH|MEDIUM|LOW|NOT_SET, mode: INCLUDE|EXCLUDE } entries." });
    if (new Set(certPrivilegeFilters.map((p) => p.level)).size !== certPrivilegeFilters.length) {
      return res.status(400).json({ error: "Each privilege level may appear only once." });
    }
    next.certPrivilegeFilters = certPrivilegeFilters.map((p) => ({ level: p.level, mode: p.mode === "EXCLUDE" ? "EXCLUDE" : "INCLUDE" }));
    // The list supersedes the legacy single-level setting.
    next.certPrivilegeLevel = "IGNORE";
  }
  if (certPrivilegeLevel !== undefined) {
    if (!CERT_PRIVILEGE_LEVELS.has(certPrivilegeLevel)) {
      return res.status(400).json({ error: "certPrivilegeLevel must be IGNORE, HIGH, MEDIUM, or LOW." });
    }
    next.certPrivilegeLevel = certPrivilegeLevel;
  }
  for (const [name, val] of [["certPrivilegeMode", certPrivilegeMode], ["certMetadataMode", certMetadataMode], ["certSearchMode", certSearchMode]]) {
    if (val !== undefined) {
      if (!CERT_FILTER_MODES.has(val)) return res.status(400).json({ error: `${name} must be INCLUDE or EXCLUDE.` });
      next[name] = val;
    }
  }
  if (certMetadataFilters !== undefined) {
    const ok = Array.isArray(certMetadataFilters) && certMetadataFilters.length <= 50 && certMetadataFilters.every(
      (p) => p && typeof p.key === "string" && p.key.trim() && typeof p.value === "string" && p.value.trim()
    );
    if (!ok) return res.status(400).json({ error: "certMetadataFilters must be an array of { key, value } pairs (max 50)." });
    const seen = new Set();
    if (certMetadataFilters.some((p) => p.mode !== undefined && !CERT_FILTER_MODES.has(p.mode))) {
      return res.status(400).json({ error: "Each metadata filter's mode must be INCLUDE or EXCLUDE." });
    }
    next.certMetadataFilters = certMetadataFilters
      .map((p) => ({ key: p.key.trim(), value: p.value.trim(), mode: p.mode === "EXCLUDE" ? "EXCLUDE" : "INCLUDE", attributeName: p.attributeName || null, valueName: p.valueName || null }))
      .filter((p) => { const k = `${p.key}::${p.value}`; if (seen.has(k)) return false; seen.add(k); return true; });
  }
  if (certSearchFilter !== undefined) {
    if (typeof certSearchFilter !== "string" || certSearchFilter.length > 2000) {
      return res.status(400).json({ error: "certSearchFilter must be a string of at most 2000 characters." });
    }
    next.certSearchFilter = certSearchFilter.trim();
  }
  if (next.roleStatsRefreshEnabled && (!next.roleStatsRefreshStartDate || !next.roleStatsRefreshTimeOfDay)) {
    return res.status(400).json({ error: "A start date and time of day are required to enable Role Statistics Refresh." });
  }

  await studioPreferences.put(session.tenant, next);
  res.json(next);
});

// ─── User Certifications (Mining > Certifications) ───────────────────────────
// Plans one certification campaign per distinct combination of the chosen
// Certification Attributes' values — e.g. one "Engineering user access
// review" per department — covering every active in-scope identity with
// those values, reviewed by each identity's own manager. Planning stores the
// campaign (name, description, query, members, counts) in this app; each is
// created in ISC as a STAGED draft only on demand from the drafts screen,
// and never activated from here.
//
// Shape: campaign type SEARCH with searchCampaignInfo.type IDENTITY, which
// certifies ALL access of the identities the query returns. The optional
// searchCampaignInfo.reviewer is deliberately omitted — ISC's API only sets
// it when one identity/governance group should review everything; left
// unset, each identity's manager reviews their own direct reports, which is
// exactly the "reviewed by their manager" requirement. A MANAGER-type
// campaign can't be narrowed to one department without a separate
// campaign-filter object, so SEARCH is the simpler, self-contained choice.
// The campaign attribute defaults come from Studio Settings > User
// Certifications (see DEFAULT_STUDIO_PREFERENCES cert* keys).
// ── Campaign item filters (Studio Settings > User Certifications) ──────────
// Access Privilege and Access Model Metadata narrow WHICH access items a
// campaign certifies (not which users). Each resolves, at planning time, to
// the set of access-item ids it matches via ISC Search over the three access
// indices; the surviving ids are then sent as the campaign's
// accessConstraints (operator SELECTED) when it's created. Include filters
// intersect (an item must satisfy each one); an exclude filter removes its
// matches. The pairs inside the metadata filter are OR-ed — an item carrying
// any of the chosen values matches.
// The Search Filter is different: it's an IDENTITY query (default
// attributes.cloudLifecycleState:active) that narrows who each campaign
// covers — applied to the identity scan and AND-ed into every campaign's
// own search query (see certificationIdentityFilterClause).
const CERT_ACCESS_INDICES = [
  { index: "entitlements", type: "ENTITLEMENT" },
  { index: "roles", type: "ROLE" },
  { index: "accessprofiles", type: "ACCESS_PROFILE" },
];
const CERT_ACCESS_ITEM_TYPES = ["ROLE", "ACCESS_PROFILE", "ENTITLEMENT"];
const CERT_ACCESS_ITEM_TYPE_LABELS = { ROLE: "Roles", ACCESS_PROFILE: "Access Profiles", ENTITLEMENT: "Entitlements" };
const CERT_PRIVILEGE_LEVELS = new Set(["IGNORE", "HIGH", "MEDIUM", "LOW"]);

/** A birthright role: any role whose membership is decided by a rule (STANDARD criteria), not an explicit identity list. */
function isBirthrightRole(role) {
  const m = role?.membership;
  return !!m && String(m.type || "").toUpperCase() !== "IDENTITY_LIST" && m.criteria != null;
}
const CERT_FILTER_MODES = new Set(["INCLUDE", "EXCLUDE"]);
const CERT_FILTER_ID_CAP = 20000;

/** Every id one search query matches on one index (searchAfter-paginated, capped). */
async function searchAccessIdsAll(tenant, getToken, index, query) {
  const ids = new Set();
  let searchAfter = null;
  while (ids.size < CERT_FILTER_ID_CAP) {
    const token = await getToken();
    const body = { indices: [index], query: { query }, sort: ["id"], queryResultFilter: { includes: ["id"] } };
    if (searchAfter) body.searchAfter = searchAfter;
    const resp = await withApiRetry(
      () => axios.post(
        `https://${tenantApiHost(tenant)}/v2026/search`,
        body,
        { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, params: { limit: 250 } }
      ),
      { label: `certifications: filter search ${index}` }
    );
    const page = resp.data || [];
    if (page.length === 0) break;
    for (const d of page) if (d.id) ids.add(d.id);
    if (page.length < 250) break;
    searchAfter = [page[page.length - 1].id];
  }
  return ids;
}

/** Union of one query's matches across all three access indices; a failing index is skipped with a warning. */
async function searchAccessIdsAcrossIndices(tenant, getToken, queryFor, warnings, label) {
  const all = new Set();
  for (const { index } of CERT_ACCESS_INDICES) {
    const query = queryFor(index);
    if (!query) continue;
    try {
      for (const id of await searchAccessIdsAll(tenant, getToken, index, query)) all.add(id);
    } catch (err) {
      warnings.push(`${label}: search on ${index} failed (${describeError(err)}) — no ${index} matched this filter.`);
    }
  }
  return all;
}

/**
 * The Search Filter as an identity-query clause: the query itself for
 * INCLUDE, its negation for EXCLUDE, or null when blank. Used both to scan
 * identities and inside every campaign's search query, so the users this
 * app plans for and the users ISC certifies are the same set.
 */
function certificationIdentityFilterClause(settings) {
  const q = String(settings.certSearchFilter || "").trim();
  if (!q) return null;
  return settings.certSearchMode === "EXCLUDE" ? `NOT (${q})` : `(${q})`;
}
function certificationIdentityFilterSummary(settings) {
  const q = String(settings.certSearchFilter || "").trim();
  if (!q) return null;
  return `${settings.certSearchMode === "EXCLUDE" ? "Identities excluding" : "Identities matching"} "${q}"`;
}

/**
 * Resolves the configured filters to { active, allowed: Set<id>|null, summary, warnings }.
 * heldIds is every access-item id any scanned identity holds — the universe
 * an exclude filter subtracts from and an include filter is intersected with.
 */
async function resolveCertificationItemFilters(tenant, getToken, settings, heldIds, heldTypes = new Map(), heldSources = new Map()) {
  const warnings = [];
  const summary = [];
  const includes = [];
  const excludes = [];

  // Access Item Types — first, since it's the coarsest cut. All three chosen
  // (or the setting absent) means no type filter at all.
  const chosenTypes = Array.isArray(settings.certAccessItemTypes) && settings.certAccessItemTypes.length
    ? CERT_ACCESS_ITEM_TYPES.filter((t) => settings.certAccessItemTypes.includes(t))
    : CERT_ACCESS_ITEM_TYPES;
  if (chosenTypes.length < CERT_ACCESS_ITEM_TYPES.length) {
    const wrongType = new Set();
    for (const id of heldIds) if (!chosenTypes.includes(heldTypes.get(id))) wrongType.add(id);
    excludes.push(wrongType);
    summary.push(`Only ${chosenTypes.map((t) => CERT_ACCESS_ITEM_TYPE_LABELS[t]).join(" and ")}`);
  }

  // Birthright roles — only meaningful while Roles are being certified. A
  // birthright role is any role with a membership rule. Common Access roles
  // usually have one too, so they'd be swept out with the rest; the Include
  // Common Access Roles option pulls them back in.
  if (chosenTypes.includes("ROLE") && settings.certExcludeBirthrightRoles === true) {
    try {
      const token = await getToken();
      const roles = await fetchAllRolesWithCriteria(tenant, token);
      const birthright = new Set(roles.filter(isBirthrightRole).map((r) => r.id));
      let keptCommon = 0;
      if (settings.certIncludeCommonAccessRoles === true) {
        const common = await getCommonAccessRoleIds(tenant, token);
        for (const id of common) if (birthright.delete(id) && heldIds.has(id)) keptCommon += 1;
      }
      const heldBirthright = new Set([...birthright].filter((id) => heldIds.has(id)));
      excludes.push(heldBirthright);
      summary.push(
        settings.certIncludeCommonAccessRoles === true
          ? `Exclude birthright roles (roles with a membership rule), but keep Common Access roles — ${heldBirthright.size} excluded, ${keptCommon} Common Access kept`
          : `Exclude birthright roles (roles with a membership rule) — ${heldBirthright.size} excluded`
      );
    } catch (err) {
      // Failing open would silently certify roles the admin asked to leave
      // out; failing closed would silently drop every role. Neither is
      // acceptable unannounced, so the filter is skipped AND flagged.
      warnings.push(`Birthright roles: couldn't read the tenant's roles (${describeError(err)}) — birthright roles were NOT excluded from this run.`);
    }
  }

  // Included Sources — drops access profiles and entitlements that come from
  // a source the admin unticked. Roles have no source, so they never match;
  // an item whose source isn't known is kept rather than guessed at.
  const excludedSources = Array.isArray(settings.certExcludedSources) ? settings.certExcludedSources.filter((x) => x?.id) : [];
  if (excludedSources.length > 0) {
    const excludedIds = new Set(excludedSources.map((x) => x.id));
    const fromExcluded = new Set();
    for (const id of heldIds) {
      const type = heldTypes.get(id);
      if ((type === "ACCESS_PROFILE" || type === "ENTITLEMENT") && excludedIds.has(heldSources.get(id))) fromExcluded.add(id);
    }
    excludes.push(fromExcluded);
    const names = excludedSources.map((x) => x.name || x.id);
    summary.push(
      `Exclude access profiles and entitlements from ${excludedSources.length} source${excludedSources.length === 1 ? "" : "s"} ` +
      `(${names.slice(0, 5).join(", ")}${names.length > 5 ? `, +${names.length - 5} more` : ""}) — ${fromExcluded.size} item${fromExcluded.size === 1 ? "" : "s"} excluded`
    );
  }

  // One privilege filter per level, each with its own mode; the legacy
  // single level/mode pair still counts while the list is empty.
  const privFilters = Array.isArray(settings.certPrivilegeFilters) && settings.certPrivilegeFilters.length
    ? settings.certPrivilegeFilters
    : (settings.certPrivilegeLevel && settings.certPrivilegeLevel !== "IGNORE"
      ? [{ level: settings.certPrivilegeLevel, mode: settings.certPrivilegeMode }] : []);
  if (privFilters.length > 0) {
    const pooled = { INCLUDE: new Set(), EXCLUDE: new Set() };
    const titleCase = (l) => l.charAt(0) + l.slice(1).toLowerCase();
    // "High or Medium privilege items", "items with no value set for privilege (null)", or both.
    const privilegePhrase = (entries) => {
      const levels = entries.filter((p) => String(p.level).toUpperCase() !== "NOT_SET").map((p) => titleCase(String(p.level)));
      const parts = [];
      if (levels.length) parts.push(`${levels.join(" or ")} privilege items`);
      if (entries.some((p) => String(p.level).toUpperCase() === "NOT_SET")) parts.push("items with no value set for privilege (null)");
      return parts.join(" or ");
    };
    const warnedIndices = new Set();
    // Ids at one real level across the three indices (memoised — NOT_SET
    // needs all three levels even when only it is configured). Entitlements
    // carry privilegeLevel.effective in the search index; roles and access
    // profiles carry a flat privilegeLevel — try the nested form first
    // everywhere and fall back to the flat one.
    const levelCache = new Map();
    const idsAtLevel = async (level) => {
      if (levelCache.has(level)) return levelCache.get(level);
      const ids = new Set();
      for (const { index } of CERT_ACCESS_INDICES) {
        let matched = null;
        for (const q of [`privilegeLevel.effective:${level}`, `privilegeLevel:${level}`]) {
          try { matched = await searchAccessIdsAll(tenant, getToken, index, q); break; } catch { matched = null; }
        }
        if (!matched) {
          if (!warnedIndices.has(index)) { warnedIndices.add(index); warnings.push(`Access Privilege: ${index} don't expose a privilege level to search on this tenant — none matched.`); }
        } else for (const id of matched) ids.add(id);
      }
      levelCache.set(level, ids);
      return ids;
    };
    for (const p of privFilters) {
      const level = String(p.level || "").toUpperCase();
      const mode = p.mode === "EXCLUDE" ? "EXCLUDE" : "INCLUDE";
      if (level === "NOT_SET") {
        // "No Value Set for Privilege (null)" is the complement: every held item that is not High,
        // Medium or Low — which covers both an explicit NONE and a missing
        // privilegeLevel field, since ISC reports the null case either way.
        const classified = new Set();
        for (const l of ["HIGH", "MEDIUM", "LOW"]) for (const id of await idsAtLevel(l)) classified.add(id);
        for (const id of heldIds) if (!classified.has(id)) pooled[mode].add(id);
      } else {
        for (const id of await idsAtLevel(level)) pooled[mode].add(id);
      }
    }
    const inc = privFilters.filter((p) => p.mode !== "EXCLUDE");
    const exc = privFilters.filter((p) => p.mode === "EXCLUDE");
    if (inc.length) { includes.push(pooled.INCLUDE); summary.push(`Only ${privilegePhrase(inc)}`); }
    if (exc.length) { excludes.push(pooled.EXCLUDE); summary.push(`Exclude ${privilegePhrase(exc)}`); }
  }

  // Each metadata pair carries its own mode. Include pairs pool into one
  // set (an item needs any one of them); Exclude pairs pool into another
  // and are subtracted afterwards, so Exclude wins where both apply.
  const pairs = Array.isArray(settings.certMetadataFilters) ? settings.certMetadataFilters.filter((p) => p?.key && p?.value != null) : [];
  if (pairs.length > 0) {
    const legacyMode = settings.certMetadataMode === "EXCLUDE" ? "EXCLUDE" : "INCLUDE";
    const modeOf = (p) => (p.mode ? (p.mode === "EXCLUDE" ? "EXCLUDE" : "INCLUDE") : legacyMode);
    const pairText = (p) => `${p.attributeName || p.key} = ${p.valueName || p.value}`;
    const pooled = { INCLUDE: new Set(), EXCLUDE: new Set() };
    for (const p of pairs) {
      const matched = await searchAccessIdsAcrossIndices(
        tenant, getToken,
        () => `@accessModelMetadata(key:${p.key} AND value:"${String(p.value).replace(/"/g, '\\"')}")`,
        warnings, `Metadata ${p.key}=${p.value}`
      );
      for (const id of matched) pooled[modeOf(p)].add(id);
    }
    const incPairs = pairs.filter((p) => modeOf(p) === "INCLUDE");
    const excPairs = pairs.filter((p) => modeOf(p) === "EXCLUDE");
    if (incPairs.length) { includes.push(pooled.INCLUDE); summary.push(`Only items tagged ${incPairs.map(pairText).join(" or ")}`); }
    if (excPairs.length) { excludes.push(pooled.EXCLUDE); summary.push(`Exclude items tagged ${excPairs.map(pairText).join(" or ")}`); }
  }

  if (includes.length === 0 && excludes.length === 0) return { active: false, allowed: null, summary, warnings };
  let allowed = new Set(heldIds);
  for (const inc of includes) allowed = new Set([...allowed].filter((id) => inc.has(id)));
  for (const exc of excludes) for (const id of exc) allowed.delete(id);
  return { active: true, allowed, summary, warnings };
}

const certificationRuns = createRecordStore(DATA_DIR, "certification-runs.json");

// Root name for the single campaign planned when no Certification
// Attributes are chosen — there is no attribute value to name it after.
const ALL_USERS_BASE_NAME = "All users";

const CERT_DURATION_DAYS = new Set([7, 14, 30]);
const CERT_UNDECIDED_ACCESS = new Set(["MAINTAIN", "REVOKE"]);
const CERT_COMMENT_REQUIREMENTS = new Set(["NO_DECISIONS", "ALL_DECISIONS", "REVOKE_ONLY_DECISIONS"]);

async function updateCertificationRun(runId, patch) {
  await certificationRuns.put(runId, { ...(await certificationRuns.get(runId)), ...patch });
}
function certificationRunForSession(run, session) {
  return run && run.tenant === session.tenant ? run : null;
}

/** "jobTitle" -> "job title", "cost_center" -> "cost center" — for prose. */
function humanizeAttributeKey(key) {
  return String(key || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase()
    .trim();
}

/** [{key, value}] -> 'department is "Engineering" and whose location is "Austin"' */
function certificationCriteriaProse(values) {
  return values
    .map((v) => (v.missing ? `has no ${humanizeAttributeKey(v.key)}` : `${humanizeAttributeKey(v.key)} is "${v.value}"`))
    .join(" and whose ");
}

function certificationCampaignDescription({ values, settings }) {
  const undecided = settings.certUndecidedAccess === "REVOKE"
    ? "Any access still undecided when the campaign closes will be revoked automatically, so please make an explicit decision on every item."
    : "Any access still undecided when the campaign closes will be kept in place, so an item you do not act on stays with the user.";
  const comments =
    settings.certCommentRequirement === "ALL_DECISIONS" ? "A comment is required on every decision."
    : settings.certCommentRequirement === "REVOKE_ONLY_DECISIONS" ? "A comment is required whenever access is revoked."
    : "Comments are optional.";
  const covers = values.length > 0
    ? `This user access review covers every user whose ${certificationCriteriaProse(values)}. `
    : "This user access review covers every user in scope. ";
  return (
    covers +
    "Each user's manager reviews all of the access their direct reports currently hold — roles, access " +
    "profiles and entitlements — confirming that each item is still needed for the person's job and " +
    `revoking anything that is not. ${undecided} ${comments} ` +
    "Please complete your reviews before the deadline."
  );
}

async function runCertificationDrafts(runId, session) {
  const { tenant } = session;
  const getToken = () => sessionToken(session);
  const isCancelled = async () => !!(await certificationRuns.get(runId))?.cancelRequested;

  try {
    const settings = await getStudioPreferences(tenant);
    // Certification Attributes chosen on Studio Settings > User
    // Certifications are what the population is split on — one campaign per
    // combination of their values. With none chosen there is nothing to
    // split on, so the run plans a SINGLE campaign covering every user the
    // rest of the criteria (scope, identity filters, item filters) selects,
    // rather than silently splitting on some other attribute.
    const attributeKeys = (settings.certAttributeKeys || []).filter((k) => !PEER_GROUP_STATUS_ATTRIBUTE_KEYS.has(k));
    const attributeSource = attributeKeys.length > 0 ? "certification-settings" : "all-users";
    const scopeQuery = (await getTenantSettings(tenant)).nameScope;
    const scopeIds = await fetchScopeIds(tenant, await getToken(), ["identities"], scopeQuery);
    // Every identity's effective access comes back on the same search page
    // (roles, access profiles and entitlements — the item types an identity
    // certification reviews), so each campaign can report how many access
    // items its reviewers will see and list them on its detail page without
    // a second pass against ISC.
    const CERT_ACCESS_TYPES = ["ROLE", "ACCESS_PROFILE", "ENTITLEMENT"];
    const identityClause = certificationIdentityFilterClause(settings);
    const all = await searchAllIdentities(tenant, getToken, { pageSize: 250, accessTypes: CERT_ACCESS_TYPES, query: identityClause || "*" });
    const identities = all.filter((idn) => isActiveIdentity(idn) && (!scopeIds || scopeIds.has(idn.id)));

    // One planned campaign per distinct COMBINATION of the certification
    // attributes' values (department × location when two are chosen), so
    // adding an attribute sub-divides the campaigns — the remedy offered
    // when one exceeds the Size Limit. An identity missing a value for an
    // attribute lands in a "(no <attribute>)" bucket rather than being
    // dropped, so every active in-scope user still gets reviewed. Buckets
    // are sorted by value so the results (and ISC's campaign list) read
    // alphabetically. Each carries its member list (with access) for the
    // campaign detail page and the detailed printout.
    const valueOf = (idn, key) => {
      const raw = idn.attributes.find((a) => a.key === key)?.value;
      return raw == null || String(raw).trim() === "" ? null : String(raw).trim();
    };
    // With no attributes every identity maps to the same empty tuple, so
    // this naturally yields exactly one bucket holding everyone.
    const byCombo = new Map(); // JSON tuple -> { values: [{key, value, missing}], group: [] }
    for (const idn of identities) {
      const values = attributeKeys.map((key) => {
        const v = valueOf(idn, key);
        return { key, value: v ?? `(no ${humanizeAttributeKey(key)})`, missing: v == null };
      });
      const tupleKey = JSON.stringify(values.map((v) => v.value));
      if (!byCombo.has(tupleKey)) byCombo.set(tupleKey, { values, group: [] });
      byCombo.get(tupleKey).group.push(idn);
    }
    const combos = [...byCombo.values()].sort((a, b) => {
      for (let i = 0; i < a.values.length; i += 1) {
        const c = a.values[i].value.localeCompare(b.values[i].value);
        if (c !== 0) return c;
      }
      return 0;
    });

    // Item filters resolve once per run against every access item any
    // scanned identity holds, then trim each member's list below.
    const heldIds = new Set();
    const heldTypes = new Map(); // id -> ROLE | ACCESS_PROFILE | ENTITLEMENT
    const heldSources = new Map(); // id -> granting source id (access profiles and entitlements only)
    for (const idn of identities) for (const a of idn.access || []) if (a.id) {
      heldIds.add(a.id);
      heldTypes.set(a.id, a.type);
      if (a.sourceId) heldSources.set(a.id, a.sourceId);
    }
    const filters = await resolveCertificationItemFilters(tenant, getToken, settings, heldIds, heldTypes, heldSources);
    const identitySummary = certificationIdentityFilterSummary(settings);
    await updateCertificationRun(runId, {
      filters: {
        active: filters.active,
        summary: [...(identitySummary ? [identitySummary] : []), ...filters.summary],
        warnings: filters.warnings,
        heldItems: heldIds.size,
        allowedItems: filters.allowed ? filters.allowed.size : heldIds.size,
        identityFilter: identityClause,
      },
    });

    const planned = [];
    for (const { values, group } of combos) {
      const members = group
        .map((idn) => {
          const held = idn.access || [];
          const kept = filters.allowed ? held.filter((a) => filters.allowed.has(a.id)) : held.slice();
          return {
            id: idn.id,
            name: idn.name,
            email: idn.email,
            manager: idn.manager?.name || null,
            access: kept.sort((a, b) => a.type.localeCompare(b.type) || String(a.name).localeCompare(String(b.name))),
            excludedAccessCount: held.length - kept.length,
          };
        })
        .sort((a, b) => String(a.name).localeCompare(String(b.name)));
      const countType = (t) => members.reduce((n, m) => n + m.access.filter((a) => a.type === t).length, 0);
      const roleCount = countType("ROLE");
      const accessProfileCount = countType("ACCESS_PROFILE");
      const entitlementCount = countType("ENTITLEMENT");
      planned.push({
        // attributeKey/value stay for the row label ("department > location"
        // / "Engineering - Austin"); `values` is the structured criteria.
        attributeKey: attributeKeys.join(" > "),
        value: values.map((v) => v.value).join(" - ") || ALL_USERS_BASE_NAME,
        values,
        identityCount: members.length,
        accessCount: roleCount + accessProfileCount + entitlementCount,
        excludedAccessCount: members.reduce((n, m) => n + (m.excludedAccessCount || 0), 0),
        roleCount, accessProfileCount, entitlementCount,
        members,
      });
    }

    // For the "too large" remedy: Schema Analysis candidates not already
    // in use, best-scoring first — the attribute(s) to add next.
    const analysis = await schemaAnalyses.get(tenant);
    const unusedCandidates = (analysis?.candidates || [])
      .map((c) => c.key)
      .filter((k) => !attributeKeys.includes(k) && !PEER_GROUP_STATUS_ATTRIBUTE_KEYS.has(k));
    const sizeLimit = Number(settings.certSizeLimit) || 10000;

    await updateCertificationRun(runId, {
      attributeKeys,
      attributeSource,
      scopeQuery: scopeIds ? scopeQuery : null,
      totalIdentities: identities.length,
      planned: planned.length,
      settings: {
        certNotificationsEnabled: settings.certNotificationsEnabled,
        certUndecidedAccess: settings.certUndecidedAccess,
        certCommentRequirement: settings.certCommentRequirement,
        certDurationDays: settings.certDurationDays,
        certCampaignPrefix: typeof settings.certCampaignPrefix === "string" ? settings.certCampaignPrefix : "",
        certCampaignSuffix: typeof settings.certCampaignSuffix === "string" ? settings.certCampaignSuffix : "",
        certSizeLimit: sizeLimit,
        certAccessItemTypes: settings.certAccessItemTypes,
        certExcludedSources: Array.isArray(settings.certExcludedSources) ? settings.certExcludedSources : [],
        certExcludeBirthrightRoles: settings.certExcludeBirthrightRoles === true,
        certIncludeCommonAccessRoles: settings.certIncludeCommonAccessRoles === true,
        certPrivilegeFilters: settings.certPrivilegeFilters,
        certPrivilegeLevel: settings.certPrivilegeLevel,
        certPrivilegeMode: settings.certPrivilegeMode,
        certMetadataFilters: settings.certMetadataFilters,
        certMetadataMode: settings.certMetadataMode,
        certSearchFilter: settings.certSearchFilter,
        certSearchMode: settings.certSearchMode,
      },
    });

    // Planning only — nothing is sent to ISC here. Each campaign is fully
    // prepared (name, description, query, members, counts) and then created
    // in ISC on demand from the drafts screen (see .../campaigns/:index/create),
    // one at a time or all at once, so a reviewer can vet the plan first.
    const results = [];
    let tooLarge = 0;
    for (const item of planned) {
      if (await isCancelled()) {
        await updateCertificationRun(runId, { status: "cancelled", completedAt: new Date().toISOString(), results, tooLarge });
        return;
      }
      // Root name is just the attribute value(s); "user access review" now
      // lives in the (editable) Campaign Suffix default.
      const name = certificationCampaignName(item.value || ALL_USERS_BASE_NAME, settings);
      const description = certificationCampaignDescription({ values: item.values, settings });
      // One exact-match clause per attribute; a "(no X)" bucket becomes a
      // NOT-exists clause so the campaign still selects exactly those users.
      const clauses = item.values.map(({ key, value, missing }) => {
        const k = sanitizeAttributeKey(key);
        return missing ? `NOT attributes.${k}:*` : `attributes.${k}:"${value.replace(/"/g, '\\"')}"`;
      });
      // No attributes means no value clause at all — the campaign selects on
      // scope and the identity filters alone.
      const valueClause = clauses.length === 0 ? null : clauses.length === 1 ? clauses[0] : `(${clauses.join(" AND ")})`;
      // The same Scan Scope Mining Config applies to role mining narrows the
      // campaign too, so a scoped tenant never certifies out-of-scope users.
      // With no attributes, no scope and no identity filter there is nothing
      // left to narrow on, so match everyone rather than send ISC an empty
      // query.
      const query = [
        scopeIds && scopeQuery ? `(${scopeQuery})` : null,
        identityClause,
        valueClause,
      ].filter(Boolean).join(" AND ") || "*";

      // Size Limit (Studio Settings > User Certifications): a campaign whose
      // total access items exceed it is flagged and can't be created, with
      // the remedy of adding another attribute to sub-divide it.
      if (item.accessCount > sizeLimit) {
        tooLarge += 1;
        const another = attributeKeys.length > 0 ? "another " : "a ";
        const suggestion = unusedCandidates.length > 0
          ? `Add ${another}Certification Attribute (e.g. ${unusedCandidates.slice(0, 2).join(" or ")}) in Studio Settings → User Certifications to sub-divide this campaign so each part fits within the limit.`
          : "No further Schema Analysis attribute is available to sub-divide by — narrow the Scan Scope in Mining Config, or raise the Size Limit.";
        results.push({
          ...item, name, description, query,
          status: "too-large", ok: false, tooLarge: true, campaignId: null,
          error: `Too large — ${item.accessCount.toLocaleString()} access items exceeds the Size Limit of ${sizeLimit.toLocaleString()}. ${suggestion}`,
        });
      } else if (filters.active && item.accessCount === 0) {
        results.push({
          ...item, name, description, query,
          status: "empty", ok: false, tooLarge: false, campaignId: null,
          error: `Nothing to certify — the campaign filters exclude every access item these ${item.identityCount} user${item.identityCount === 1 ? "" : "s"} hold.`,
        });
      } else {
        results.push({ ...item, name, description, query, status: "planned", ok: false, tooLarge: false, campaignId: null, error: null });
      }
    }

    await updateCertificationRun(runId, {
      status: "completed",
      completedAt: new Date().toISOString(),
      results, tooLarge, created: 0, failed: 0,
    });
  } catch (err) {
    console.error("[certifications] run failed:", err.response?.data || err.message);
    await updateCertificationRun(runId, {
      status: "failed",
      completedAt: new Date().toISOString(),
      error: describeError(err),
    });
  }
}

/** POST /api/insights/certification-runs — start creating campaign drafts; 202 { runId }. */
app.post("/api/insights/certification-runs", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;

  const runId = `cert_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await updateCertificationRun(runId, {
    id: runId,
    tenant,
    status: "running",
    startedAt: new Date().toISOString(),
    completedAt: null,
    cancelRequested: false,
    attributeKeys: [],
    planned: 0,
    created: 0,
    failed: 0,
    tooLarge: 0,
    results: [],
    error: null,
  });

  runCertificationDrafts(runId, session);

  res.status(202).json({ runId });
});

/** GET /api/insights/certification-runs — list, newest first (results stripped for size). */
app.get("/api/insights/certification-runs", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const list = Object.values(await certificationRuns.all())
    .filter((r) => r.tenant === session.tenant)
    .map(({ results, ...meta }) => meta)
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
  res.json(list);
});

/** GET /api/insights/certification-runs/:id — full record, including per-campaign results. */
app.get("/api/insights/certification-runs/:id", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const run = certificationRunForSession(await certificationRuns.get(req.params.id), session);
  if (!run) return res.status(404).json({ error: "Certification run not found." });
  // Member lists (every user's every access item) are the bulk of a run;
  // the drafts screen only needs the per-campaign counts, so they're
  // stripped unless ?full=1 asks for them (the detailed printout does).
  if (String(req.query.full || "") === "1") return res.json(run);
  res.json({
    ...run,
    results: (run.results || []).map(({ members, ...rest }) => rest),
  });
});

/**
 * GET /api/insights/certification-runs/:id/campaigns/:index
 * One campaign from the run, members and their access included, plus the
 * run's own settings/metadata (results stripped) for the detail header.
 */
app.get("/api/insights/certification-runs/:id/campaigns/:index", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const run = certificationRunForSession(await certificationRuns.get(req.params.id), session);
  if (!run) return res.status(404).json({ error: "Certification run not found." });
  const index = Number(req.params.index);
  const campaign = Number.isInteger(index) ? (run.results || [])[index] : null;
  if (!campaign) return res.status(404).json({ error: "Campaign not found in this run." });
  const { results, ...meta } = run;
  res.json({ run: meta, index, campaign });
});

/** The surviving access-item ids of a planned campaign, one SELECTED constraint per type present. */
function certificationAccessConstraints(item) {
  const byType = new Map();
  for (const m of item.members || []) {
    for (const a of m.access || []) {
      if (!a.id || !a.type) continue;
      if (!byType.has(a.type)) byType.set(a.type, new Set());
      byType.get(a.type).add(a.id);
    }
  }
  return [...byType.entries()].map(([type, ids]) => ({ type, operator: "SELECTED", ids: [...ids] }));
}

/**
 * POST /api/insights/certification-runs/:id/campaigns/:index/create
 * Creates ONE planned campaign from the run in ISC, as a STAGED draft
 * (never activated from here), using the settings snapshot the run was
 * planned with; the deadline is Duration from now, since creation can
 * happen well after planning. "Create All" on the drafts screen calls this
 * once per eligible campaign, sequentially, so each has its own outcome and
 * a failed one can simply be retried. Refuses a too-large campaign and one
 * that already exists in ISC.
 */
app.post("/api/insights/certification-runs/:id/campaigns/:index/create", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  const run = certificationRunForSession(await certificationRuns.get(req.params.id), session);
  if (!run) return res.status(404).json({ error: "Certification run not found." });
  if (run.status === "running") return res.status(400).json({ error: "Wait for planning to finish first." });
  const index = Number(req.params.index);
  const item = Number.isInteger(index) ? (run.results || [])[index] : null;
  if (!item) return res.status(404).json({ error: "Campaign not found in this run." });
  if (item.tooLarge) return res.status(400).json({ error: "This campaign exceeds the Size Limit — sub-divide it first." });
  if (item.status === "empty") return res.status(400).json({ error: "Nothing to certify — the campaign filters exclude every access item here." });
  if (item.campaignId) return res.status(400).json({ error: "This campaign has already been created in ISC." });

  const settings = { ...DEFAULT_STUDIO_PREFERENCES, ...(run.settings || {}) };
  const deadline = new Date(Date.now() + (Number(settings.certDurationDays) || 30) * 24 * 60 * 60 * 1000).toISOString();
  const wasFailed = item.status === "failed";
  try {
    const token = await sessionToken(session);
    const resp = await withApiRetry(
      () => axios.post(
        `https://${tenantApiHost(tenant)}/v2026/campaigns`,
        {
          name: item.name,
          description: item.description,
          deadline,
          type: "SEARCH",
          emailNotificationEnabled: !!settings.certNotificationsEnabled,
          autoRevokeAllowed: settings.certUndecidedAccess === "REVOKE",
          recommendationsEnabled: false,
          mandatoryCommentRequirement: settings.certCommentRequirement,
          searchCampaignInfo: {
            type: "IDENTITY",
            description: item.description,
            query: item.query,
            // With item filters active, the campaign is limited to exactly
            // the access items that survived them (per type). Without
            // filters the constraints are omitted, i.e. all access.
            ...(run.filters?.active ? { accessConstraints: certificationAccessConstraints(item) } : {}),
          },
        },
        { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }
      ),
      { label: `certifications: create campaign "${item.name}"` }
    );
    const updated = {
      ...item,
      status: "created", ok: true, error: null,
      campaignId: resp.data?.id || null,
      campaignStatus: resp.data?.status || null,
      deadline,
      createdAt: new Date().toISOString(),
    };
    const results = run.results.map((r, i) => (i === index ? updated : r));
    await updateCertificationRun(run.id, {
      results,
      created: (run.created || 0) + 1,
      failed: Math.max(0, (run.failed || 0) - (wasFailed ? 1 : 0)),
    });
    const { members, ...slim } = updated;
    res.json(slim);
  } catch (err) {
    console.error(`[certifications] campaign "${item.name}" failed:`, err.response?.data || err.message);
    const updated = { ...item, status: "failed", ok: false, error: describeError(err) };
    const results = run.results.map((r, i) => (i === index ? updated : r));
    await updateCertificationRun(run.id, { results, failed: (run.failed || 0) + (wasFailed ? 0 : 1) });
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/**
 * POST /api/insights/certification-runs/:id/sync-status
 * Re-reads every created campaign from ISC and records its current status
 * (PENDING while ISC generates certifications → STAGED once it's a real
 * draft; ERROR/COMPLETED when nothing was certifiable), certification
 * counts and ISC's own alerts. A campaign that no longer exists in ISC is
 * marked deleted. Returns the run with members stripped, like GET :id.
 */
app.post("/api/insights/certification-runs/:id/sync-status", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  const run = certificationRunForSession(await certificationRuns.get(req.params.id), session);
  if (!run) return res.status(404).json({ error: "Certification run not found." });

  try {
    const token = await sessionToken(session);
    const checkedAt = new Date().toISOString();
    const results = await Promise.all((run.results || []).map(async (r) => {
      if (!r.campaignId) return r;
      try {
        const c = await withApiRetry(() => iscGet(tenant, token, `/v2026/campaigns/${r.campaignId}`), { label: `certifications: status ${r.campaignId}` });
        return {
          ...r,
          campaignStatus: c.status || r.campaignStatus || null,
          totalCertifications: c.totalCertifications ?? null,
          completedCertifications: c.completedCertifications ?? null,
          iscAlerts: Array.isArray(c.alerts) ? c.alerts.map((a) => a.localizations?.[0]?.text || a.text || a.level || JSON.stringify(a)) : [],
          iscDeadline: c.deadline || r.deadline || null,
          statusCheckedAt: checkedAt,
        };
      } catch (err) {
        if (err.response?.status === 404) {
          return { ...r, campaignStatus: "DELETED", iscAlerts: ["This campaign no longer exists in ISC."], statusCheckedAt: checkedAt };
        }
        return { ...r, iscAlerts: [`Status check failed: ${describeError(err)}`], statusCheckedAt: checkedAt };
      }
    }));
    await updateCertificationRun(run.id, { results });
    const fresh = await certificationRuns.get(run.id);
    res.json({ ...fresh, results: (fresh.results || []).map(({ members, ...rest }) => rest) });
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[certifications] sync-status failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/** POST /api/insights/certification-runs/:id/cancel — stop before the next campaign is created. */
app.post("/api/insights/certification-runs/:id/cancel", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const run = certificationRunForSession(await certificationRuns.get(req.params.id), session);
  if (!run) return res.status(404).json({ error: "Certification run not found." });
  if (run.status !== "running") return res.status(400).json({ error: "This run is no longer running." });
  await updateCertificationRun(run.id, { cancelRequested: true });
  res.json({ ok: true });
});

/** DELETE /api/insights/certification-runs/:id — removes this app's record only; campaigns stay in ISC. */
app.delete("/api/insights/certification-runs/:id", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const run = certificationRunForSession(await certificationRuns.get(req.params.id), session);
  if (!run) return res.status(404).json({ error: "Certification run not found." });
  if (run.status === "running") {
    return res.status(400).json({ error: "Wait for the run to finish (or cancel it) before removing it." });
  }
  await certificationRuns.delete(req.params.id);
  res.status(204).end();
});

// ─── Operations (Tools > Operations) — AI fix suggestions for failed events ──
// The client reads failed events straight from ISC's events search index via
// the generic proxy; this route only supplies the AI analysis. Suggestions
// are cached per tenant + event id so re-opening an event never re-spends
// an AI call — an event is immutable once logged.
const opsSuggestions = createRecordStore(DATA_DIR, "ops-suggestions.json");
const OPS_EVENT_FACT_KEYS = [
  "id", "created", "name", "type", "action", "operation", "status", "technicalName", "objects", "actor", "target",
  "stack", "trackingNumber", "ipAddress", "details", "attributes", "errors", "warnings", "message",
];

function summarizeEventForAi(event, factKeys = OPS_EVENT_FACT_KEYS) {
  const lines = [];
  for (const key of factKeys) {
    const v = event?.[key];
    if (v == null || v === "" || (Array.isArray(v) && v.length === 0)) continue;
    const text = typeof v === "string" ? v : JSON.stringify(v);
    lines.push(`${key}: ${text.length > 1500 ? `${text.slice(0, 1500)}…` : text}`);
  }
  return lines.join("\n");
}

// The same analysis is offered beyond Operations — on a source's Activity
// tab and an identity's Activity tab (audit events and account activities)
// and on a SaaS source's Logs tab (connector log lines). Each kind has its
// own facts and framing; all share this cache. An audit event is cached
// under its bare id whichever screen asked, so explaining it in one place
// shows it as explained in every other; the other kinds are prefixed.
const OPS_ACTIVITY_FACT_KEYS = [
  "id", "created", "modified", "action", "status", "stage", "sources", "requester", "recipient", "errors", "warnings",
  "accountRequests", "originalRequests", "expansionItems", "approvals", "trackingNumber",
];
const OPS_SUGGEST_KINDS = {
  event: {
    factKeys: OPS_EVENT_FACT_KEYS,
    intro: "Below is one failed event from the tenant's audit/event log, as ISC's search API returns it.",
  },
  accountActivity: {
    factKeys: OPS_ACTIVITY_FACT_KEYS,
    intro:
      "Below is one account activity (a provisioning transaction carried out for one identity) that did not complete " +
      "cleanly, as ISC's search API returns it. accountRequests are the per-account operations ISC attempted, each " +
      "with its own result; originalRequests are what was asked for before ISC expanded it.",
  },
  connectorLog: {
    intro:
      "Below are log lines from a SaaS (cloud-hosted, sp-connect) connector in the tenant, oldest first, all from the " +
      "same connector command where a request id is shown. The admin asked about the line marked >>>. Lines are " +
      "as the connector wrote them; secrets have been redacted.",
    summarize: (item) => summarizeLogLinesForAi(item),
  },
  workflowExecution: {
    intro:
      "Below is one failed run (execution) of an ISC workflow: the run itself, the workflow's steps as defined, and the " +
      "run's event history oldest first — events whose type ends in Failed carry the error. Secrets have been redacted. " +
      "In the fix, name the workflow step involved and what to change in it (its inputs, a JSONPath expression, the " +
      "trigger's filter, a missing loop/condition, credentials of an HTTP step, and so on).",
    summarize: (item) => summarizeWorkflowExecutionForAi(item),
  },
};

// Connector logs — DEBUG ones especially — can carry credentials. Nothing
// leaves for the AI provider without the obvious shapes scrubbed: bearer /
// basic auth values, JWTs, and any key=value or "key":"value" whose key
// names a secret.
const SECRET_KEY_PATTERN = "(?:pass(?:word|wd)?|secret|token|api[-_]?key|authorization|credential|private[-_]?key|client[-_]?secret|refresh[-_]?token|access[-_]?token|cookie|session[-_]?id)";
function redactSecrets(text) {
  return String(text)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, "[REDACTED_JWT]")
    .replace(new RegExp(`("?[\\w.-]*${SECRET_KEY_PATTERN}[\\w.-]*"?\\s*[:=]\\s*)("[^"]*"|'[^']*'|[^\\s,;}&]+)`, "gi"), "$1[REDACTED]");
}

const OPS_LOG_MAX_LINES = 60;
const OPS_LOG_MAX_LINE_CHARS = 1200;
function summarizeLogLinesForAi(item) {
  const head = [`source: ${item.sourceName || "unknown"}`, item.connector ? `connector: ${item.connector}` : null, item.requestID ? `request id: ${item.requestID}` : null].filter(Boolean);
  const lines = (Array.isArray(item.lines) ? item.lines : []).slice(-OPS_LOG_MAX_LINES).map((l) => {
    const raw = typeof l?.message === "string" ? l.message : JSON.stringify(l?.message ?? "");
    const text = redactSecrets(raw);
    return `${l?.focus ? ">>> " : "    "}${l?.timestamp || ""} ${l?.level || ""} ${l?.event || ""} ${text.length > OPS_LOG_MAX_LINE_CHARS ? `${text.slice(0, OPS_LOG_MAX_LINE_CHARS)}…` : text}`;
  });
  return [...head, "", ...lines].join("\n");
}

// A workflow run for the AI: the failure events in full, the rest of the
// history as one line each (the path the run took), and the step list so
// the model can name the step to change. Event attributes can echo step
// inputs and HTTP responses, so everything goes through redactSecrets.
const OPS_WF_MAX_EVENTS = 80;
const OPS_WF_MAX_FAILURE_CHARS = 3000;
function summarizeWorkflowExecutionForAi(item) {
  const clip = (text, n) => (text.length > n ? `${text.slice(0, n)}…` : text);
  const head = [
    `workflow: ${item.workflowName || "unknown"}`,
    item.trigger ? `trigger: ${clip(JSON.stringify(item.trigger), 600)}` : null,
    `execution: ${item.id} · status ${item.status || "?"} · started ${item.startTime || "?"} · ended ${item.closeTime || "?"}`,
  ].filter(Boolean);
  const steps = (Array.isArray(item.steps) ? item.steps : []).slice(0, 60).map((st) => `  ${st.name} — ${st.type || "?"}${st.actionId ? ` (${st.actionId})` : ""}`);
  const events = (Array.isArray(item.events) ? item.events : []).slice(-OPS_WF_MAX_EVENTS).map((e) => {
    const failed = /Failed$/.test(e?.type || "");
    const attrs = redactSecrets(JSON.stringify(e?.attributes ?? {}));
    return `${failed ? ">>> " : "    "}${e?.timestamp || ""} ${e?.type || ""} ${clip(attrs, failed ? OPS_WF_MAX_FAILURE_CHARS : 240)}`;
  });
  return [...head, "", "steps as defined:", ...steps, "", "event history:", ...events].join("\n");
}

/** GET /api/insights/ops/suggestions — event ids (this tenant) that already have a saved suggestion. */
app.get("/api/insights/ops/suggestions", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const all = Object.values(await opsSuggestions.all()).filter((r) => r.tenant === session.tenant);
  res.json(all.map((r) => ({ eventId: r.eventId, generatedAt: r.generatedAt })));
});

/** GET /api/insights/ops/suggest/:eventId — the saved suggestion for one event, or { suggestion: null }. */
app.get("/api/insights/ops/suggest/:eventId", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const cached = await opsSuggestions.get(`${session.tenant}:${req.params.eventId}`);
  if (!cached?.suggestion) return res.json({ suggestion: null });
  res.json({ suggestion: cached.suggestion, cached: true, generatedAt: cached.generatedAt });
});

/**
 * POST /api/insights/ops/suggest
 * Body: { event } — one ISC events-index document (as the search API returns it),
 *    or { kind, item } — kind "event" (the same), "accountActivity" (one
 *    accountactivities-index document), "connectorLog" ({ id, sourceName,
 *    connector, requestID, lines: [{ timestamp, level, event, message, focus }] })
 *    or "workflowExecution" ({ id, workflowName, trigger, status, startTime,
 *    closeTime, steps: [{ name, type, actionId }], events: [<history events>] }).
 * Returns { suggestion, cached } — a plain-prose diagnosis with concrete steps.
 */
app.post("/api/insights/ops/suggest", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const kind = req.body?.kind || "event";
  const kindConfig = OPS_SUGGEST_KINDS[kind];
  if (!kindConfig) return res.status(400).json({ error: `Unknown kind "${kind}".` });
  const event = req.body?.item || req.body?.event;
  if (!event || typeof event !== "object" || !event.id) {
    return res.status(400).json({ error: "An item with an id is required (event: an ISC event document)." });
  }
  if (kind === "connectorLog" && !(Array.isArray(event.lines) && event.lines.length)) {
    return res.status(400).json({ error: "connectorLog needs at least one log line." });
  }
  if (kind === "workflowExecution" && !(Array.isArray(event.events) && event.events.length)) {
    return res.status(400).json({ error: "workflowExecution needs the run's event history." });
  }
  if (!aiConfigured()) {
    return res.status(503).json({ error: "AI suggestions aren't configured on this server (set AI_PROVIDER=bedrock or ANTHROPIC_API_KEY)." });
  }
  const cacheId = kind === "event" ? String(event.id) : `${kind}:${event.id}`;
  const cacheKey = `${session.tenant}:${cacheId}`;
  const cached = await opsSuggestions.get(cacheKey);
  if (cached?.suggestion && !req.body?.refresh) return res.json({ suggestion: cached.suggestion, cached: true, generatedAt: cached.generatedAt });

  try {
    const suggestion = await claudeGenerateText(
      `You are a senior SailPoint Identity Security Cloud (ISC) administrator. ${kindConfig.intro} Explain, in plain ` +
      "prose for another ISC admin, " +
      "(1) what most likely went wrong, based only on the facts given, and (2) the concrete steps to correct it — " +
      "which ISC screen or API to use, what to check on the source/connector, identity, role or workflow involved, " +
      "and how to confirm the fix. If the facts alone can't determine the cause, say what to look at next. " +
      "Keep it under 220 words, no markdown, no headings, no preamble.\n\n" +
      (kindConfig.summarize ? kindConfig.summarize(event) : summarizeEventForAi(event, kindConfig.factKeys)),
      { maxTokens: 600 }
    );
    if (!suggestion) throw new Error("Empty response from the AI provider.");
    const record = { tenant: session.tenant, eventId: cacheId, suggestion, generatedAt: new Date().toISOString() };
    await opsSuggestions.put(cacheKey, record);
    res.json({ suggestion, cached: false, generatedAt: record.generatedAt });
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[ops] suggest failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

// ─── JSON editors — AI syntax repair ─────────────────────────────────────────
// Every JSON editor in the app live-validates and blocks Save while the text
// doesn't parse. This takes that unparseable text plus the parser's own
// complaint and returns a version that does parse, with a plain-language
// explanation of what was wrong — a teaching aid as much as a fix. The
// client never applies it silently: it shows the explanation and the changed
// lines, and the user chooses to apply.
//
// The model is asked for syntax repair ONLY (no renamed keys, no changed
// values, no reformatting), and the result is verified here: it must parse,
// or the model gets one more try with the new parser error. It is not
// possible to prove values are unchanged — the original can't be parsed to
// compare against — which is why the client shows the changed lines.
const JSON_FIX_MAX_CHARS = 60_000;
const JSON_FIX_MARKER = "===FIXED_JSON===";

function parseJsonFixReply(reply) {
  const at = String(reply || "").indexOf(JSON_FIX_MARKER);
  if (at < 0) return null;
  const explanation = reply.slice(0, at).replace(/^\s*EXPLANATION:\s*/i, "").trim();
  // Tolerate a code fence around the JSON despite being told not to add one.
  const fixed = reply.slice(at + JSON_FIX_MARKER.length).trim().replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/, "");
  return { explanation, fixed };
}

/**
 * POST /api/ai/fix-json
 * Body: { text, error } — the editor's text and JSON.parse's message for it
 * Returns { fixed, explanation } — `fixed` is guaranteed to parse.
 */
app.post("/api/ai/fix-json", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const text = String(req.body?.text ?? "");
  const parserError = String(req.body?.error ?? "").slice(0, 500);
  if (!text.trim()) return res.status(400).json({ error: "There's no JSON to fix." });
  try {
    JSON.parse(text);
    return res.status(400).json({ error: "This JSON is already valid." });
  } catch { /* expected — that's why we're here */ }
  if (text.length > JSON_FIX_MAX_CHARS) {
    return res.status(413).json({ error: `This document is too large for an AI fix (${text.length.toLocaleString()} characters; the limit is ${JSON_FIX_MAX_CHARS.toLocaleString()}). The parser's message gives the line and column to look at.` });
  }
  if (!aiConfigured()) {
    return res.status(503).json({ error: "AI isn't configured on this server (set AI_PROVIDER=bedrock or ANTHROPIC_API_KEY)." });
  }

  const instructions =
    "The text below is meant to be JSON but does not parse. Repair its SYNTAX only, so that it parses as the JSON its " +
    "author clearly intended. Do not rename keys, change or drop values, reorder anything, or reformat / re-indent " +
    "lines you are not fixing — every character that isn't part of a syntax error stays exactly as it is. If something " +
    "is genuinely ambiguous (e.g. a truncated value), make the smallest plausible repair and say so.\n\n" +
    "Reply in exactly this form and nothing else:\n" +
    "EXPLANATION:\n<For someone learning JSON: what was wrong, where (line numbers), why JSON doesn't allow it, and what " +
    "you changed. One short paragraph per problem if there are several. Plain prose, no markdown.>\n" +
    `${JSON_FIX_MARKER}\n<the complete corrected JSON document, with no code fence and nothing after it>`;
  // The reply repeats the whole document, so the budget scales with it.
  const maxTokens = Math.min(32_000, Math.ceil(text.length / 2.5) + 1_000);

  try {
    let prompt = `${instructions}\n\nThe JSON parser's message: ${parserError || "(none given)"}\n\nThe text:\n${text}`;
    let lastProblem = "The AI provider returned nothing usable.";
    for (let attempt = 0; attempt < 2; attempt++) {
      const parsed = parseJsonFixReply(await claudeGenerateText(prompt, { maxTokens }));
      if (parsed) {
        try {
          JSON.parse(parsed.fixed);
          return res.json({ fixed: parsed.fixed, explanation: parsed.explanation || "The syntax errors were corrected." });
        } catch (err) {
          lastProblem = `The AI's corrected version still didn't parse (${err.message}).`;
          prompt = `${instructions}\n\nYour previous attempt still did not parse — the parser said: ${err.message}\nFix the ORIGINAL text again, more carefully.\n\nThe original parser message: ${parserError || "(none given)"}\n\nThe text:\n${text}`;
        }
      }
    }
    res.status(502).json({ error: `${lastProblem} Nothing was changed — the parser's message gives the line and column to look at.` });
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[ai] fix-json failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

// ─── User Preferences ──────────────────────────────────────────────────────────
// USER data, not tenant data — nested tenant -> username so two different
// tenants can't collide on the same username, and so two users signed into
// the SAME tenant (who already share every Role Scan/Skeleton Scan/Role Eval
// Scan/tenant setting/SOD mitigation above) each get their own copy of
// whatever's stored here. Currently just dark mode. Never merge or read this
// across tenants — always scoped to session.tenant + the signed-in user's
// own username, never anything from the request body.
// themeMode, not a darkMode boolean: a boolean has no way to say "follow the
// environment", so its false default forced every user who had never touched
// the toggle into light mode on every load — overriding their device setting
// entirely. "system" is the default, and means the app follows the same
// appearance ISC does rather than pinning one.
const THEME_MODES = new Set(["system", "light", "dark"]);
// Which view every JSON editor opens in. Text by default: it's the one that
// shows the document exactly as ISC stores it, and the one that always works —
// Tree can't open JSON that doesn't parse.
const JSON_EDIT_MODES = new Set(["text", "tree"]);
const DEFAULT_USER_PREFERENCES = { themeMode: "system", jsonEditMode: "text" };

// Older records hold only the boolean. `true` was a deliberate choice, so it
// is preserved as "dark"; `false` was also the DEFAULT for anyone who never
// chose, so it maps to "system" rather than pinning light onto people who
// never asked for it.
function normalizeUserPreferences(stored) {
  const prefs = { ...DEFAULT_USER_PREFERENCES, ...(stored || {}) };
  // Test the STORED mode, not the merged one — the default would otherwise
  // always look valid and the legacy boolean would never be read, silently
  // dropping the dark preference of everyone who had set it.
  if (!THEME_MODES.has(stored?.themeMode)) {
    prefs.themeMode = stored?.darkMode === true ? "dark" : "system";
  }
  if (!JSON_EDIT_MODES.has(prefs.jsonEditMode)) prefs.jsonEditMode = "text";
  // Kept in the response so an older client still reads something sensible.
  prefs.darkMode = prefs.themeMode === "dark";
  return prefs;
}

const userPreferences = createRecordStore(DATA_DIR, "user-preferences.json");

async function getUserPreferences(tenant, username) {
  const forTenant = (await userPreferences.get(tenant)) || {};
  return normalizeUserPreferences(forTenant[username]);
}
async function updateUserPreferences(tenant, username, patch) {
  const forTenant = (await userPreferences.get(tenant)) || {};
  forTenant[username] = normalizeUserPreferences({ ...(forTenant[username] || {}), ...patch });
  await userPreferences.put(tenant, forTenant);
  return forTenant[username];
}

/** GET /api/preferences — the signed-in user's own preferences, defaulted if none saved yet. */
app.get("/api/preferences", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const username = session.identity?.username;
  if (!username) return res.status(400).json({ error: "No username on this session." });
  res.json(await getUserPreferences(session.tenant, username));
});

/**
 * PUT /api/preferences
 * Body: { themeMode?: "system" | "light" | "dark", darkMode?: boolean, jsonEditMode?: "text" | "tree" }
 * Only ever writes under session.tenant + the signed-in user's own
 * username — there's no way to target another user's preferences through
 * this route, by design.
 */
app.put("/api/preferences", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const username = session.identity?.username;
  if (!username) return res.status(400).json({ error: "No username on this session." });
  const { themeMode, darkMode, jsonEditMode } = req.body || {};
  const patch = {};
  if (jsonEditMode !== undefined) {
    if (!JSON_EDIT_MODES.has(jsonEditMode)) {
      return res.status(400).json({ error: 'jsonEditMode must be "text" or "tree".' });
    }
    patch.jsonEditMode = jsonEditMode;
  }
  if (themeMode !== undefined) {
    if (!THEME_MODES.has(themeMode)) {
      return res.status(400).json({ error: 'themeMode must be "system", "light" or "dark".' });
    }
    patch.themeMode = themeMode;
  } else if (darkMode !== undefined) {
    // Legacy clients still send the boolean.
    if (typeof darkMode !== "boolean") {
      return res.status(400).json({ error: "darkMode must be a boolean." });
    }
    patch.themeMode = darkMode ? "dark" : "light";
  }
  if (patch.themeMode !== undefined) patch.darkMode = patch.themeMode === "dark";
  res.json(await updateUserPreferences(session.tenant, username, patch));
});

// ─── Work items (pending manual tasks) ────────────────────────────────────────
// SailPoint's own manual work items — mostly ManualAction items for
// connector-less/manual-provisioning sources, owned by whoever needs to
// perform the change by hand. GET /v3/work-items only ever returns items in
// "Pending" state (verified live), so completed items simply stop appearing
// once completed — no local filtering needed here.
//
// Completion uses POST /v3/work-items/:id/complete (SailPoint's documented
// completeWorkItem operation — see developer.sailpoint.com/docs/api/v3/complete-work-item).
// Note: tested live against this specific demo/POC tenant and it 404s with
// an internal "work-items/work-items/:id/complete" routing error, which
// looks like a backend deployment gap on this tenant's cell rather than a
// wrong path — the endpoint is correctly implemented per SailPoint's own
// spec and should work on a fully-provisioned tenant.

/**
 * GET /api/work-items
 * Header: x-sp-session
 * Lists the signed-in identity's pending manual work items.
 */
app.get("/api/work-items", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;

  try {
    const token = await sessionToken(session);
    const items = await iscGet(tenant, token, "/v3/work-items", {
      "owner-id": session.identity?.id,
      limit: 100,
    });
    res.json(items);
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[work-items] list failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/** GET /api/work-items/pending-count — for the at-a-glance box. */
app.get("/api/work-items/pending-count", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;

  try {
    const token = await sessionToken(session);
    const items = await iscGet(tenant, token, "/v3/work-items", { "owner-id": session.identity?.id, limit: 100 });
    res.json({ count: items.length });
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[work-items] pending-count failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/** GET /api/work-items/:id — one work item's full detail. */
app.get("/api/work-items/:id", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;

  try {
    const token = await sessionToken(session);
    const item = await iscGet(tenant, token, `/v3/work-items/${req.params.id}`);
    res.json(item);
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[work-items] get failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/**
 * POST /api/work-items/:id/complete
 * Calls SailPoint's real completeWorkItem operation
 * (POST /v3/work-items/:id/complete). See note above about this specific
 * tenant currently 404ing on this call.
 */
app.post("/api/work-items/:id/complete", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;

  try {
    const token = await sessionToken(session);
    // Not /v3/work-items/:id/complete — that path 404s on this tenant with an
    // internal gateway routing bug (verified live: duplicated
    // "work-items/work-items/:id/complete" path, never reaches a handler,
    // regardless of body/content-type). The real working endpoint is the
    // legacy v1 API's own item URL, POST with no suffix and no body — verified
    // live end-to-end: 200 response with the item's state flipped to
    // "Finished", and it now correctly disappears from the v3 pending list.
    const resp = await axios.post(
      `https://${tenantApiHost(tenant)}/work-items/v1/${req.params.id}`,
      {},
      { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }
    );
    res.json(resp.data || { id: req.params.id, completed: true });
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[work-items] complete failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

// ─── Configuration: schema analysis ──────────────────────────────────────────
// Looks at every identity's attributes (not their entitlements — this is
// about the shape of the identity data itself) and picks the 2 attributes
// that best divide the tenant's users into peer groups, so Role Insight's
// hardcoded department/location assumption can eventually be replaced with
// whatever actually fits this tenant's data.

const SCHEMA_ANALYSIS_PAGE_SIZE = 250;

// Keyed by tenant, so each client connection keeps its own analysis.
const schemaAnalyses = createRecordStore(DATA_DIR, "schema-analysis.json");

/**
 * Scores each candidate identity attribute by how well it splits the
 * population into peer groups, then returns the candidates ranked best
 * first.
 *
 * An attribute is only a candidate if it clears PEER_GROUP_MIN_SIZE on
 * average — that's what excludes near-unique fields like email or employee
 * ID, which "divide" everyone into groups of one and aren't peer groups at
 * all. Status/lifecycle fields (active/disabled etc.) are excluded outright,
 * same as Role Insight's peer grouping — they describe state, not identity.
 *
 * Among the remaining candidates, score = normalizedEntropy * coverage:
 *   - normalizedEntropy (0-1) rewards attributes whose values are spread
 *     evenly across members (e.g. 4 departments of similar size) over ones
 *     dominated by a single value (e.g. 95% "Unknown" or 95% one location) —
 *     an evenly-split attribute produces peer groups that are actually
 *     comparable in size, a lopsided one produces one huge group and some
 *     tiny ones.
 *   - coverage (0-1) rewards attributes most identities actually have a
 *     value for, since an attribute only half-populated leaves half the
 *     tenant ungrouped by it.
 */
function scoreSchemaAttributes(identities) {
  const valuesByKey = new Map();
  for (const idn of identities) {
    for (const attr of idn.attributes || []) {
      if (PEER_GROUP_STATUS_ATTRIBUTE_KEYS.has(attr.key)) continue;
      if (!attr.value) continue;
      if (!valuesByKey.has(attr.key)) valuesByKey.set(attr.key, new Map());
      const counts = valuesByKey.get(attr.key);
      counts.set(attr.value, (counts.get(attr.value) || 0) + 1);
    }
  }

  const candidates = [];
  for (const [key, counts] of valuesByKey) {
    const distinctValues = counts.size;
    if (distinctValues < 2) continue;

    const coveredCount = [...counts.values()].reduce((a, b) => a + b, 0);
    const avgGroupSize = coveredCount / distinctValues;
    if (avgGroupSize < PEER_GROUP_MIN_SIZE) continue;

    let entropy = 0;
    for (const count of counts.values()) {
      const p = count / coveredCount;
      entropy -= p * Math.log2(p);
    }
    const normalizedEntropy = entropy / Math.log2(distinctValues);
    const coverage = coveredCount / identities.length;

    candidates.push({
      key,
      distinctValues,
      coverage: Math.round(coverage * 1000) / 1000,
      avgGroupSize: Math.round(avgGroupSize * 10) / 10,
      score: Math.round(normalizedEntropy * coverage * 1000) / 1000,
    });
  }

  return candidates.sort((a, b) => b.score - a.score);
}

/**
 * Every doc id matching a raw ISC Search query against the given index —
 * used to apply Scan Scope (identities) to Schema Analysis/Role Scan, and
 * Evaluation Scope (roles) to the Role Evaluation scan. Paginated via
 * searchAfter (not offset) — offset pagination against this
 * Elasticsearch-backed endpoint hard-fails once offset+limit passes
 * 10,000, which a scope query matching that many docs would hit; a stable
 * id sort keeps searchAfter's cursor well-defined page to page. Returns
 * null for an empty/whitespace query, meaning "no scope" — callers should
 * treat that as "don't filter" rather than "matches nothing."
 */
async function fetchScopeIds(tenant, token, indices, query) {
  if (!query || !query.trim()) return null;
  const ids = new Set();
  let searchAfter = null;
  const pageSize = 250;
  while (true) {
    const body = { indices, query: { query }, sort: ["id"] };
    if (searchAfter) body.searchAfter = searchAfter;
    const resp = await withApiRetry(
      () => axios.post(
        `https://${tenantApiHost(tenant)}/v2026/search`,
        body,
        { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, params: { limit: pageSize } }
      ),
      { label: "fetchScopeIds: search page" }
    );
    const page = resp.data || [];
    for (const doc of page) ids.add(doc.id);
    if (page.length < pageSize) break;
    searchAfter = [page[page.length - 1].id];
  }
  return ids;
}

/**
 * POST /api/insights/schema-analysis
 * Header: x-sp-session
 * Pages through every identity in the tenant (scoped to the tenant's Role
 * Scan Scope setting, if one is configured), scores each identity attribute
 * by how well it divides the population into peer groups, and persists the
 * top 2 for this tenant.
 */
app.post("/api/insights/schema-analysis", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;

  try {
    const scopeQuery = (await getTenantSettings(tenant)).nameScope;
    const scopeIds = await fetchScopeIds(tenant, await sessionToken(session), ["identities"], scopeQuery);

    // Paginated via searchAllIdentities (searchAfter, not offset) — this
    // tenant's identity count can exceed 10,000, past which offset
    // pagination against /v2026/public-identities hard-fails (verified
    // live).
    const allIdentities = await searchAllIdentities(tenant, () => sessionToken(session), {
      pageSize: SCHEMA_ANALYSIS_PAGE_SIZE,
    });
    const identities = allIdentities.filter((idn) => isActiveIdentity(idn) && (!scopeIds || scopeIds.has(idn.id)));

    const candidates = scoreSchemaAttributes(identities);
    // suggestedTopAttributes is the algorithm's pick, kept alongside
    // topAttributes so a manual selection (see PUT below) can always be
    // reset back to what the score actually recommended. A fresh run resets
    // any prior manual Priority Order selection, since the candidate set
    // (and therefore which keys are even valid to select) may have changed.
    const suggestedTopAttributes = candidates.slice(0, 2).map((c) => c.key);

    // The Multi-Company/Division Boundary is a deliberate, explicit setting
    // someone configured on the PUT route below — unlike Priority Order
    // above, it shouldn't be silently discarded just because Schema
    // Analysis was re-run (a normal, expected thing to do — e.g. after
    // adding a large batch of new identities, to pick up new department/
    // location values). Verified live: this used to reset unconditionally
    // on every run, reported as "boundary attributes not saving reliably."
    // Carried forward as long as every previously-selected boundary
    // attribute is still a valid candidate in this fresh analysis; reset
    // only when that's no longer true, since a key absent from candidates
    // would fail the PUT route's own validation anyway.
    const previous = await schemaAnalyses.get(tenant);
    const validKeys = new Set(candidates.map((c) => c.key));
    const previousBoundaryStillValid =
      !!previous?.roleBoundaryEnabled &&
      (previous.roleBoundaryAttributes || []).length > 0 &&
      previous.roleBoundaryAttributes.every((k) => validKeys.has(k));

    // A tenant's very first analysis defaults the boundary AND Create Data
    // Segments on, seeded with the suggested attributes — so a new tenant
    // starts with every Role Mining toggle checked. Only when the analysis
    // actually produced candidates, since a boundary with no attributes
    // partitions nothing and the PUT route below couldn't even save one.
    // Re-runs keep honoring the previously-saved choice (or lack of one).
    const firstRunBoundaryOn = !previous && suggestedTopAttributes.length > 0;

    const result = {
      tenant,
      computedAt: new Date().toISOString(),
      totalIdentities: identities.length,
      scopeQuery: scopeIds ? scopeQuery : null,
      candidates,
      suggestedTopAttributes,
      topAttributes: suggestedTopAttributes,
      roleBoundaryEnabled: previousBoundaryStillValid || firstRunBoundaryOn,
      roleBoundaryAttributes: previousBoundaryStillValid ? previous.roleBoundaryAttributes
        : firstRunBoundaryOn ? suggestedTopAttributes : [],
      createDataSegments: firstRunBoundaryOn || (previousBoundaryStillValid && !!previous.createDataSegments),
    };
    await schemaAnalyses.put(tenant, result);

    res.json(result);
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[insights] schema-analysis failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/** GET /api/insights/schema-analysis — the persisted analysis for this tenant, if one has been run. */
app.get("/api/insights/schema-analysis", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  res.json((await schemaAnalyses.get(session.tenant)) || null);
});

/**
 * PUT /api/insights/schema-analysis/top-attributes
 * Header: x-sp-session
 * Body: { topAttributes: string[] } — 1 to 2 candidate keys, in priority
 * order (first = highest priority). Lets a reviewer override the algorithm's
 * automatic pick and reorder it, without re-running the analysis.
 */
app.put("/api/insights/schema-analysis/top-attributes", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);

  const analysis = await schemaAnalyses.get(session.tenant);
  if (!analysis) return res.status(404).json({ error: "Run schema analysis first." });

  const topAttributes = req.body?.topAttributes;
  if (!Array.isArray(topAttributes) || topAttributes.length < 1 || topAttributes.length > 2) {
    return res.status(400).json({ error: "topAttributes must be an array of 1 to 2 attribute keys." });
  }
  const validKeys = new Set(analysis.candidates.map((c) => c.key));
  const unique = new Set(topAttributes);
  if (unique.size !== topAttributes.length || [...unique].some((k) => !validKeys.has(k))) {
    return res.status(400).json({ error: "topAttributes must be unique keys from this analysis's candidates." });
  }

  analysis.topAttributes = topAttributes;
  await schemaAnalyses.put(session.tenant, analysis);
  res.json(analysis);
});

/**
 * PUT /api/insights/schema-analysis/role-boundary
 * Header: x-sp-session
 * Body: { enabled: boolean, attributes: string[], createDataSegments?: boolean }
 * — 0 to 2 candidate keys.
 * A Multi-Company/Division Boundary: when enabled, Role Mining is meant to
 * produce a separate set of Role Drafts per distinct combination of these
 * attribute values (e.g. one pass per Company, or per Company+Division),
 * rather than one pass across the whole tenant. createDataSegments is a
 * sibling toggle, only meaningful (and only ever persisted true) while
 * enabled is also true — the same boundary attributes double as the basis
 * for ISC Data Segments (see POST /api/insights/segment-scans), one per
 * distinct combination of values, same partitioning Role Scan itself uses.
 */
app.put("/api/insights/schema-analysis/role-boundary", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);

  const analysis = await schemaAnalyses.get(session.tenant);
  if (!analysis) return res.status(404).json({ error: "Run schema analysis first." });

  const { enabled, attributes, createDataSegments } = req.body || {};
  if (typeof enabled !== "boolean") {
    return res.status(400).json({ error: "enabled must be a boolean." });
  }
  if (!Array.isArray(attributes) || attributes.length > 2) {
    return res.status(400).json({ error: "attributes must be an array of at most 2 attribute keys." });
  }
  const validKeys = new Set(analysis.candidates.map((c) => c.key));
  const unique = new Set(attributes);
  if (unique.size !== attributes.length || [...unique].some((k) => !validKeys.has(k))) {
    return res.status(400).json({ error: "attributes must be unique keys from this analysis's candidates." });
  }
  if (createDataSegments !== undefined && typeof createDataSegments !== "boolean") {
    return res.status(400).json({ error: "createDataSegments must be a boolean." });
  }

  analysis.roleBoundaryEnabled = enabled;
  analysis.roleBoundaryAttributes = attributes;
  // Never left on without the boundary itself — off automatically whenever
  // enabled is false, regardless of what the client sent, since the
  // Segments menu's own visibility (see GET /api/insights/schema-analysis)
  // depends on this being a true reflection of "boundary + segments both on."
  analysis.createDataSegments = enabled && !!createDataSegments;
  await schemaAnalyses.put(session.tenant, analysis);
  res.json(analysis);
});

// ─── Data Segments ──────────────────────────────────────────────────────────
// ISC's actual Data Segmentation feature (v2026 /data-segments) — distinct
// from /v2026/segments, which is the older Access Request visibility
// Segments API. Data Segments scope what a delegated admin can see/manage
// across Access Model objects (entitlements, roles, etc.) and require the
// X-SailPoint-Experimental header on every call. Only surfaced in this app
// (Browse > Data Segments) when a tenant has both the Multi-Company/
// Division Boundary enabled AND its own "Create Data Segments" toggle on
// (see PUT .../role-boundary above) — the same boundary attributes double
// as the basis for segmentation, one segment per distinct combination of
// values, same partitioning Role Scan itself uses for peer groups.
const DATA_SEGMENTS_HEADERS = { "X-SailPoint-Experimental": "true" };

// ISC's list endpoint filters "enabled" and "published" to an exact value
// each — there's no single combination that means "all" (enabled=false
// doesn't mean "show both", it means "only disabled"), verified live. The
// only way to see every segment regardless of state is to fetch all 4
// true/false combinations and merge by id. count:true is also required —
// without it this experimental endpoint silently drops some matching
// segments (e.g. a pre-existing enabled+published one), verified live.
// This experimental endpoint's own max limit is 50, not the usual 250 (or
// even 100) — verified live: limit=50 succeeds, limit=51 and up 400
// "semantically invalid" with no other clue which param is the problem.
// Was 100 before, which 400'd every single call the moment a tenant had
// Data Segments enabled at all (verified live: even limit alone, with no
// other params, 400'd at 100 but not at 50).
const DATA_SEGMENTS_PAGE_SIZE = 50;

// A single combo's result used to be one unpaginated fetch — fine while a
// tenant had well under a page's worth of segments, but any combo with more
// than the default page size silently lost everything past it. Pages
// through with the same offset-until-short-page pattern the browse list
// screens now use client-side (see fetchAllPages in sailpoint.js).
async function fetchAllForCombo(tenant, token, params) {
  const all = [];
  let offset = 0;
  while (true) {
    const page = await withApiRetry(
      () => iscGet(
        tenant, token, "/v2026/data-segments",
        { ...params, count: true, limit: DATA_SEGMENTS_PAGE_SIZE, offset },
        DATA_SEGMENTS_HEADERS
      ),
      { label: "fetchAllForCombo: data-segments page" }
    );
    if (!Array.isArray(page) || page.length === 0) break;
    all.push(...page);
    if (page.length < DATA_SEGMENTS_PAGE_SIZE) break;
    offset += DATA_SEGMENTS_PAGE_SIZE;
  }
  return all;
}

async function fetchAllDataSegments(tenant, token) {
  const combos = [
    { enabled: true, published: true },
    { enabled: true, published: false },
    { enabled: false, published: true },
    { enabled: false, published: false },
  ];
  const pages = await Promise.all(combos.map((params) => fetchAllForCombo(tenant, token, params)));
  const byId = new Map();
  for (const page of pages) {
    for (const s of page) byId.set(s.id, s);
  }
  return [...byId.values()];
}

/** GET /api/segments — every Data Segment in the tenant (client sorts/searches from there). */
app.get("/api/segments", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  try {
    const token = await sessionToken(session);
    const segments = await fetchAllDataSegments(tenant, token);
    // Every listing is a free chance to learn a value GUID from a segment
    // someone has since edited in ISC (see harvestMetadataValueGuids). Never
    // allowed to fail the listing itself.
    await harvestMetadataValueGuids(tenant, segments).catch((err) => console.warn("[segments] GUID harvest failed:", err.message));
    res.json(segments);
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[segments] list failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/**
 * GET /api/segments/:id — one Data Segment's full detail. The single-id
 * GET endpoint has the same exact-match enabled/published filtering as the
 * list endpoint (verified live) and unpublished segments' ids can drift
 * between requests (ISC appears to periodically regenerate draft
 * representations), so a direct GET by a previously-seen id is unreliable.
 * Resolving through a fresh fetchAllDataSegments() call instead sidesteps
 * both problems — same list the UI just rendered, id looked up from it.
 *
 * A segment can have more than one draft alongside a published version
 * (each a distinct record with its own id) — the response's "drafts" field
 * lists every OTHER unpublished record sharing this segment's name, so the
 * detail page can surface them instead of silently hiding all but one.
 */
app.get("/api/segments/:id", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  try {
    const token = await sessionToken(session);
    const segments = await fetchAllDataSegments(tenant, token);
    const segment = segments.find((s) => s.id === req.params.id);
    if (!segment) return res.status(404).json({ error: "Data segment not found." });
    const drafts = segments.filter((s) => s.id !== segment.id && s.name === segment.name && !s.published);
    res.json({ ...segment, drafts });
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[segments] get failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/**
 * GET /api/segments/:id/access — the roles directly selected on a segment's
 * own Access Model, and the entitlements reachable through them.
 *
 * Roles are read from the segment's OWN `scopes` array (the ROLE-type
 * entry's `scopeSelection`, when its Access Model is set to "Select
 * Roles") — NOT from each role's own `segments` field. A role does carry a
 * `segments` array (per the Roles API spec), but verified live: nothing —
 * not this app, not (apparently) ISC's own segment-role assignment flow —
 * actually writes to it; every role assigned to a segment via its Access
 * Model still shows `segments: []`. Reading the segment's own scope
 * selection is the only mechanism confirmed to reflect what's actually
 * assigned (see Assign Matching Roles above, which writes there).
 *
 * Entitlements combine two sources: any directly selected on the segment's
 * own ENTITLEMENT-type scope (same SELECTION mechanism as roles — "Select
 * Entitlements"), plus everything reachable through the segment's roles
 * and their access profiles (a role's own entitlements, and any access
 * profile it references). The path recorded on each row says which.
 */
app.get("/api/segments/:id/access", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  const segmentId = req.params.id;
  try {
    const token = await sessionToken(session);
    const allSegments = await fetchAllDataSegments(tenant, token);
    const segment = allSegments.find((s) => s.id === segmentId);
    if (!segment) return res.status(404).json({ error: "Data segment not found." });

    const roleScope = (segment.scopes || []).find((s) => s.scope === "ROLE");
    const entScope = (segment.scopes || []).find((s) => s.scope === "ENTITLEMENT");
    const selectedRoleIds = (roleScope?.scopeSelection || []).map((r) => r.id).filter(Boolean);
    const directEntitlementIds =
      entScope?.visibility === "SELECTION" ? (entScope.scopeSelection || []).map((r) => r.id).filter(Boolean) : [];

    // A metadata-driven segment (Segments by Metadata) has FILTER scopes
    // instead of explicit selections — resolve those to the items actually
    // matching the metadata criteria via the same verified
    // @accessModelMetadata() nested search query the ISC UI supports.
    // Best-effort: metadata search is a phased tenant rollout, so an
    // unsupported tenant just shows the criteria with an empty list rather
    // than an error.
    const findEqualsLeaf = (expr) => {
      if (!expr) return null;
      if (expr.operator === "EQUALS") return expr;
      for (const child of expr.children || []) {
        const leaf = findEqualsLeaf(child);
        if (leaf) return leaf;
      }
      return null;
    };
    const searchIdsByMetadata = async (index, key, value) => {
      if (!key || value == null) return [];
      try {
        const resp = await withApiRetry(
          () => axios.post(
            `https://${tenantApiHost(tenant)}/v2026/search`,
            { indices: [index], query: { query: `@accessModelMetadata(key:${key} AND value:"${value}")` }, sort: ["name"] },
            { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, params: { limit: 250 } }
          ),
          { label: `segment-access: metadata search ${index}` }
        );
        return (resp.data || []).map((d) => d.id).filter(Boolean);
      } catch (err) {
        console.warn(`[segments] metadata search (${index}) failed:`, err.response?.data || err.message);
        return [];
      }
    };
    // The ROLE scope's leaf value may be the value's internal GUID (see
    // boundaryFilterScope) — the search index only matches technical
    // names, so the ENTITLEMENT leaf's value (always the technical name,
    // and always the same value in this app's creates) covers both.
    const entLeaf = entScope?.visibility === "FILTER" ? findEqualsLeaf(entScope.scopeFilter?.expression) : null;
    const roleLeaf = roleScope?.visibility === "FILTER" ? findEqualsLeaf(roleScope.scopeFilter?.expression) : null;
    const roleSearchValue = entLeaf?.attribute === roleLeaf?.attribute ? entLeaf?.value?.value : roleLeaf?.value?.value;
    const [roleFilterIds, entFilterIds] = await Promise.all([
      roleLeaf ? searchIdsByMetadata("roles", roleLeaf.attribute, roleSearchValue ?? roleLeaf.value?.value) : [],
      entLeaf ? searchIdsByMetadata("entitlements", entLeaf.attribute, entLeaf.value?.value) : [],
    ]);
    const roleIds = [...new Set([...selectedRoleIds, ...roleFilterIds])];
    const entIds = [...new Set([...directEntitlementIds, ...entFilterIds])];
    const entFilterIdSet = new Set(entFilterIds);

    // Chunked id-in fetch — a metadata filter can match far more than a
    // SELECTION's 50-item cap, and a single `id in (...)` filter with 250
    // ids overruns sane URL lengths.
    const fetchByIds = async (resource, ids, label) => {
      const out = [];
      for (let i = 0; i < ids.length; i += 50) {
        const chunk = ids.slice(i, i + 50);
        const page = await withApiRetry(
          () => iscGet(tenant, token, `/v2026/${resource}`, { filters: `id in (${chunk.map((x) => `"${x}"`).join(",")})`, limit: chunk.length }),
          { label }
        );
        out.push(...(page || []));
      }
      return out;
    };

    const [roles, profiles, directEntitlements] = await Promise.all([
      roleIds.length ? fetchByIds("roles", roleIds, "segment-access: roles by id") : [],
      fetchAllAccessProfiles(tenant, token),
      entIds.length ? fetchByIds("entitlements", entIds, "segment-access: entitlements by id") : [],
    ]);

    const profileById = new Map((profiles || []).map((p) => [p.id, p]));

    // id -> { id, name, via: [...] }. One entitlement can arrive by more
    // than one path, and which paths matter more than the count.
    const entitlements = new Map();
    const add = (ent, via) => {
      if (!ent?.id) return;
      const row = entitlements.get(ent.id) ?? { id: ent.id, name: ent.name, via: [] };
      if (!row.via.includes(via)) row.via.push(via);
      entitlements.set(ent.id, row);
    };

    for (const role of roles) {
      for (const ent of role.entitlements || []) add(ent, `Role: ${role.name}`);
      for (const ref of role.accessProfiles || []) {
        const profile = profileById.get(ref.id);
        for (const ent of profile?.entitlements || []) {
          add(ent, `Access profile: ${ref.name || profile?.name} (via role ${role.name})`);
        }
      }
    }
    for (const ent of directEntitlements) {
      add(ent, entFilterIdSet.has(ent.id) ? "Matches metadata filter" : "Directly selected on segment");
    }

    // Source name per entitlement, so the client can roll the list up by
    // source the way the Identity detail screen does. Only the directly
    // selected entitlements arrive as full objects carrying a source; the
    // ones reached through roles and access profiles are bare {id, name}
    // refs, so the rest are looked up in one chunked pass.
    const entInfo = new Map();
    for (const e of directEntitlements || []) {
      if (e?.id) entInfo.set(e.id, { name: e.name, source: e.source?.id ? { id: e.source.id, name: e.source.name || null } : null });
    }
    await fillMissingEntitlementInfo(tenant, token, [...entitlements.keys()], entInfo);

    // Access profiles reach a segment only through its roles — one row per
    // distinct profile, naming the role(s) that carry it.
    const accessProfiles = new Map();
    for (const role of roles) {
      for (const ref of role.accessProfiles || []) {
        if (!ref?.id) continue;
        const row = accessProfiles.get(ref.id) ?? { id: ref.id, name: ref.name || profileById.get(ref.id)?.name || ref.id, via: [] };
        const via = `Role: ${role.name}`;
        if (!row.via.includes(via)) row.via.push(via);
        accessProfiles.set(ref.id, row);
      }
    }

    res.json({
      roles: roles.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        enabled: r.enabled,
        requestable: r.requestable,
        entitlementCount: (r.entitlements || []).length,
      })),
      accessProfiles: [...accessProfiles.values()].sort((a, b) => (a.name || "").localeCompare(b.name || "")),
      entitlements: [...entitlements.values()]
        .map((e) => ({ ...e, sourceName: entInfo.get(e.id)?.source?.name || null }))
        .sort((a, b) => (a.name || "").localeCompare(b.name || "")),
      derived: true,
    });
    console.log(`[segments] access for ${segmentId}: ${roles.length} roles, ${accessProfiles.size} access profiles, ${entitlements.size} entitlements (scopes=${JSON.stringify((segment.scopes || []).map((sc) => ({ scope: sc.scope, visibility: sc.visibility, selected: (sc.scopeSelection || []).length })))})`);
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[segments] access failed:", err.response?.data || err.message);
    res.status(status).json({
      error: describeError(err),
      ...(err.sessionExpired ? { sessionExpired: true } : {}),
    });
  }
});

/**
 * GET /api/segments/:id/members?limit&offset&query — identities that
 * actually fall inside this segment's boundary.
 *
 * Segment membership is never denormalized anywhere in ISC (same gap
 * identityMatchesSegment and fetchAssignedEntitlementsForCriteria below
 * work around), so this runs the segment's own memberFilter attribute=
 * value pairs as a Search API query against the identities index — the
 * same attributes.<key>:"<value>" translation used to find a segment's
 * matching entitlements, just returning the identities themselves instead
 * of their access. A segment with no criteria matches nobody.
 */
app.get("/api/segments/:id/members", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  const { limit = 50, offset = 0, query: searchTerm } = req.query;
  try {
    const token = await sessionToken(session);
    const allSegments = await fetchAllDataSegments(tenant, token);
    const segment = allSegments.find((s) => s.id === req.params.id);
    if (!segment) return res.status(404).json({ error: "Data segment not found." });

    const criteria = extractSegmentEqualsLeaves(segment.memberFilter?.expression);
    if (criteria.length === 0) return res.json({ members: [], total: 0 });

    const term = String(searchTerm || "").replace(/[^\w\s'-]/g, "").trim();
    const query = criteria
      .map(({ attrKey, value }) => `attributes.${attrKey}:"${String(value).replace(/"/g, '\\"')}"`)
      .join(" AND ") + (term ? ` AND name:*${term}*` : "");

    const resp = await withApiRetry(
      () => axios.post(
        `https://${tenantApiHost(tenant)}/v2026/search`,
        { indices: ["identities"], query: { query }, sort: ["name"] },
        { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, params: { limit, offset, count: true } }
      ),
      { label: "segment members page" }
    );
    const total = resp.headers["x-total-count"];
    console.log(`[segments] members for ${req.params.id}: ${resp.data.length} on this page (total ${total ?? "?"})`);
    res.json({ members: resp.data, total: total != null ? Number(total) : resp.data.length });
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[segments] members failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

// Reverse direction of GET /api/segments/:id/access above — given a role or
// entitlement, which segments select it. Two mechanisms:
//   1. SELECTION scopes: the segment's own scopeSelection lists the id (a
//      role/entitlement's own `segments` field is never actually populated).
//   2. FILTER scopes (Segments by Metadata): the segment matches items by
//      Access Model Metadata — so the object's own accessModelMetadata is
//      read and checked against each FILTER scope's criteria. ROLE-scope
//      leaves may reference the metadata value by its internal GUID (see
//      metadataValueIds); those translate via the stored mapping, or via
//      the same segment's ENTITLEMENT leaf, which carries the technical
//      name for the same value.
async function computeSegmentsContainingScope(tenant, token, scopeType, objectId) {
  const allSegments = await fetchAllDataSegments(tenant, token);

  const selectionMatches = allSegments.filter((seg) => {
    const scope = (seg.scopes || []).find((s) => s.scope === scopeType);
    return scope?.visibility === "SELECTION" && (scope.scopeSelection || []).some((r) => r.id === objectId);
  });

  // The object's own metadata assignments, as "key:value" pairs — both the
  // technical value name and the display name, since hand-authored segment
  // filters have been seen referencing either (verified live on BE Test).
  const ammPairs = new Set();
  try {
    const resource = scopeType === "ROLE" ? "roles" : "entitlements";
    const obj = await withApiRetry(
      () => iscGet(tenant, token, `/v2026/${resource}/${objectId}`),
      { label: `segments-for-object: get ${resource} ${objectId}` }
    );
    for (const attr of obj?.accessModelMetadata?.attributes || []) {
      for (const v of attr.values || []) {
        if (v.value != null) ammPairs.add(`${attr.key}:${v.value}`);
        if (v.name != null) ammPairs.add(`${attr.key}:${v.name}`);
      }
    }
  } catch (err) {
    console.warn(`[segments] metadata read for ${scopeType} ${objectId} failed:`, err.response?.data || err.message);
  }

  const stored = (await metadataValueIds.get(tenant)) || {};
  const guidToPair = new Map(Object.entries(stored).map(([pair, guid]) => [guid, pair]));
  const looksLikeGuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
  const findLeaf = (expr) => {
    if (!expr) return null;
    if (expr.operator === "EQUALS") return expr;
    for (const child of expr.children || []) {
      const leaf = findLeaf(child);
      if (leaf) return leaf;
    }
    return null;
  };

  const filterMatches = ammPairs.size === 0 ? [] : allSegments.filter((seg) => {
    const scope = (seg.scopes || []).find((s) => s.scope === scopeType && s.visibility === "FILTER");
    const leaf = findLeaf(scope?.scopeFilter?.expression);
    if (!leaf?.attribute || leaf.value?.value == null) return false;
    let key = leaf.attribute;
    let value = String(leaf.value.value);
    if (looksLikeGuid(value)) {
      const mapped = guidToPair.get(value);
      if (mapped) {
        const idx = mapped.indexOf(":");
        key = mapped.slice(0, idx);
        value = mapped.slice(idx + 1);
      } else {
        // Fall back to the sibling scope's leaf — same segment, same
        // metadata value, expressed by technical name.
        const sibling = (seg.scopes || []).find((s) => s.scope !== scopeType && s.visibility === "FILTER");
        const sibLeaf = findLeaf(sibling?.scopeFilter?.expression);
        if (sibLeaf?.attribute === key && sibLeaf.value?.value && !looksLikeGuid(String(sibLeaf.value.value))) {
          value = String(sibLeaf.value.value);
        }
      }
    }
    return ammPairs.has(`${key}:${value}`);
  });

  const byId = new Map();
  for (const seg of [...selectionMatches, ...filterMatches]) byId.set(seg.id, seg);
  return [...byId.values()];
}

// Identity-side counterpart — segment membership for an identity is never
// denormalized anywhere, so this evaluates the segment's own memberFilter
// attribute=value pairs (same flat AND-of-EQUALS leaf extraction the
// segment scan / segment-role-match features already assume) against the
// identity's own attributes.
function identityMatchesSegment(segment, attrs) {
  const leaves = extractSegmentEqualsLeaves(segment.memberFilter?.expression);
  if (leaves.length === 0) return false;
  return leaves.every((l) => String((attrs || {})[l.attrKey] ?? "") === String(l.value ?? ""));
}

function summarizeSegmentForObject(seg) {
  return { id: seg.id, name: seg.name, active: seg.active !== false };
}

/** GET /api/roles/:id/segments — data segments whose Access Model selects this role. */
app.get("/api/roles/:id/segments", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  try {
    const token = await sessionToken(session);
    const segments = await computeSegmentsContainingScope(tenant, token, "ROLE", req.params.id);
    res.json(segments.map(summarizeSegmentForObject));
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[segments] role segments failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/** GET /api/entitlements/:id/segments — data segments whose Access Model selects this entitlement. */
app.get("/api/entitlements/:id/segments", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  try {
    const token = await sessionToken(session);
    const segments = await computeSegmentsContainingScope(tenant, token, "ENTITLEMENT", req.params.id);
    res.json(segments.map(summarizeSegmentForObject));
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[segments] entitlement segments failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/** GET /api/identities/:id/segments — data segments this identity's attributes match. */
app.get("/api/identities/:id/segments", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  try {
    const token = await sessionToken(session);
    const identity = await withApiRetry(
      () => iscGet(tenant, token, `/v2026/identities/${req.params.id}`),
      { label: "identity segments: get identity" }
    );
    const allSegments = await fetchAllDataSegments(tenant, token);
    const matches = allSegments.filter((seg) => identityMatchesSegment(seg, identity?.attributes));
    res.json(matches.map(summarizeSegmentForObject));
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[segments] identity segments failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/** DELETE /api/segments/:id */
app.delete("/api/segments/:id", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  try {
    const token = await sessionToken(session);
    const headers = { Authorization: `Bearer ${token}`, ...DATA_SEGMENTS_HEADERS };

    // NOTE: deleting a segment deliberately does NOT delete its value from
    // the Global Metadata attribute.
    //
    // It used to, to stop the attribute accumulating orphans. That was
    // wrong on three counts: the roles and entitlements tagged with the
    // value KEEP their tags, so removing it strands them against a value
    // the attribute no longer lists; re-creating the segment then hits a
    // uniqueness error that reads as success, so the value silently never
    // comes back; and a value re-created later gets a NEW GUID, which
    // invalidates the cached ROLE-filter GUID without anything noticing.
    // An unused value costs nothing and is reusable — values are removed
    // deliberately from Studio Settings > Metadata, not as a side effect.

    // A segment can have a draft AND a separately-published version at
    // once ("hasCounterpart"), and ISC's delete endpoint's own "published"
    // query param picks which one to remove — the default (false) only
    // deletes the draft, silently leaving a published version live. Try
    // both so Delete actually removes the segment regardless of which
    // version(s) exist; only 404 if neither existed.
    const attempts = await Promise.allSettled([
      axios.delete(`https://${tenantApiHost(tenant)}/v2026/data-segments/${req.params.id}`, {
        headers,
        params: { published: false },
      }),
      axios.delete(`https://${tenantApiHost(tenant)}/v2026/data-segments/${req.params.id}`, {
        headers,
        params: { published: true },
      }),
    ]);
    const anyOk = attempts.some((a) => a.status === "fulfilled");
    if (!anyOk) throw attempts[0].reason;

    res.status(204).end();
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[segments] delete failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

// If a published Data Segment already has an unpublished draft counterpart
// (matched by name, same convention GET /api/segments/:id's own "drafts"
// field uses), PATCHing that draft is the more useful target — publishing
// it later is what actually takes the change live.
//
// With no existing draft, PATCHing the published record directly doesn't
// work either — verified live: ISC 404s ("The server did not find a
// current representation for the target resource") on the exact same id a
// GET against moments earlier succeeded on. A published Data Segment with
// no draft is apparently not a valid PATCH target at all in this
// experimental API. So a fresh draft is created instead, copied from the
// published record's own current name/description/membership/scopes
// (enabled left matching the published record's own state) — the caller's
// PATCH then lands on that new draft, and publishing it later is what
// takes the change live, same as the existing-draft path above.
//
// This IS the same "create a draft with the published record's own name"
// move already verified live to 409 ("Unable to create segment because the
// name ... is already being used") when a same-named draft already
// exists — but that was tested with an existing draft in the way; with none
// present (the only case reaching this branch), the name collision is only
// against the published record itself, which may not be the same
// constraint. Left to genuinely fail and surface ISC's real error rather
// than assumed broken, since this app hasn't verified that specific case
// live.
async function getSegmentPatchTargetId(tenant, token, segmentId) {
  const all = await fetchAllDataSegments(tenant, token);
  const target = all.find((s) => s.id === segmentId);
  if (!target) {
    const err = new Error("Data segment not found.");
    err.statusCode = 404;
    throw err;
  }
  if (!target.published) return target.id;

  const existingDraft = all.find((s) => s.id !== target.id && s.name === target.name && !s.published);
  if (existingDraft) return existingDraft.id;

  // ISC's own UI does this by POSTing the published record's own full
  // current representation back to /beta/data-segments (not /v2026,
  // and with no X-SailPoint-Experimental header) — WITH its existing id
  // included in the body. Verified live via a captured request/response
  // pair: the response comes back with that exact same id, just
  // transitioned to published:false (ISC stamps fresh created/modified
  // timestamps regardless of what's sent). This is an in-place
  // published -> draft transition on the SAME record, not a second linked
  // one — explains why creating an independent new record via /v2026
  // always 409'd on the name (a real second record with the same name is
  // never what this needed). No separate draft id to track afterward:
  // target.id itself is the now-editable record.
  try {
    const updated = await withApiRetry(
      () => axios.post(
        `https://${tenantApiHost(tenant)}/beta/data-segments`,
        {
          id: target.id,
          name: target.name,
          description: target.description,
          membership: target.membership,
          memberFilter: target.memberFilter,
          memberSelection: target.memberSelection || [],
          scopes: Array.isArray(target.scopes) ? target.scopes : [],
          enabled: !!target.enabled,
          published: false,
          created: target.created,
          modified: target.modified,
          hasCounterpart: target.hasCounterpart ?? false,
        },
        { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }
      ),
      { label: `getSegmentPatchTargetId: revert "${target.name}" to draft` }
    );
    return updated.data.id;
  } catch (err) {
    console.error(`[segments] getSegmentPatchTargetId: revert-to-draft failed for "${target.name}":`, err.response?.data || err.message);
    const wrapped = new Error(
      `"${target.name}" is published with no draft, and ISC refused to revert it to draft: ${describeError(err)}`
    );
    wrapped.statusCode = err.response?.status || 500;
    throw wrapped;
  }
}

/**
 * PATCH /api/segments/:id/active
 * Body: { active: boolean } — maps to the Data Segment's own "enabled"
 * field. Same JSON Patch requirement as PATCH /api/roles/:id/enabled —
 * verified live against this tenant's own /v2026/data-segments/:id.
 */
app.patch("/api/segments/:id/active", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  const { active } = req.body || {};
  if (typeof active !== "boolean") {
    return res.status(400).json({ error: "active must be a boolean." });
  }
  try {
    const token = await sessionToken(session);
    const draftId = await getSegmentPatchTargetId(tenant, token, req.params.id);
    const patchToken = await sessionToken(session);
    const resp = await axios.patch(
      `https://${tenantApiHost(tenant)}/v2026/data-segments/${draftId}`,
      [{ op: "replace", path: "/enabled", value: active }],
      { headers: { Authorization: `Bearer ${patchToken}`, "Content-Type": "application/json-patch+json", ...DATA_SEGMENTS_HEADERS } }
    );
    res.json(resp.data);
  } catch (err) {
    const status = err.statusCode || (err.sessionExpired ? 401 : err.response?.status || 500);
    console.error("[segments] set active failed:", err.response?.data || err.message);
    res.status(status).json({ error: err.statusCode ? err.message : describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/**
 * POST /api/segments/:id/create-draft
 * Explicitly runs the same ensure-a-draft-exists logic every other segment
 * PATCH route (Enable/Disable, Assign Matching Roles, the Segments scan's
 * add-to-existing merge) already triggers as a side effect via
 * getSegmentPatchTargetId — exposed here as its own standalone action, for
 * a segment someone wants editable again before making any specific
 * change. A no-op (not an error) if the segment is already a draft or
 * already has one.
 */
app.post("/api/segments/:id/create-draft", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  try {
    const token = await sessionToken(session);
    const before = await fetchAllDataSegments(tenant, token);
    const target = before.find((s) => s.id === req.params.id);
    if (!target) return res.status(404).json({ error: "Data segment not found." });

    const wasAlreadyDraft = !target.published;
    const draftId = await getSegmentPatchTargetId(tenant, token, target.id);
    // Reverting a published record to draft (the common case — see
    // getSegmentPatchTargetId) reuses its own id, so "we just did this"
    // shows up as draftId === target.id on a record that WAS published —
    // not as some new id appearing, since there's no second record at all.
    // A pre-existing, separately-id'd draft (found by name, not created
    // here) is the other real outcome worth distinguishing from "created."
    const foundExistingDraft = target.published && draftId !== target.id;
    res.json({
      draftId,
      segmentName: target.name,
      created: target.published && !foundExistingDraft,
      wasAlreadyDraft,
    });
  } catch (err) {
    const status = err.statusCode || (err.sessionExpired ? 401 : err.response?.status || 500);
    console.error("[segments] create-draft failed:", err.response?.data || err.message);
    res.status(status).json({ error: err.statusCode ? err.message : describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/**
 * POST /api/segments/publish
 * Body: { ids: string[] }
 * A segment's memberFilter has no effect on real identities until it's
 * published — "enabled" alone isn't enough (verified live). This is a
 * distinct action from PATCH .../active, not folded into it, since ISC
 * itself treats publish as an irreversible-until-republished step separate
 * from the enabled toggle.
 */
app.post("/api/segments/publish", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => typeof id !== "string")) {
    return res.status(400).json({ error: "ids must be a non-empty array of data segment id strings." });
  }
  try {
    const token = await sessionToken(session);
    await axios.post(
      `https://${tenantApiHost(tenant)}/v2026/data-segments/publish`,
      ids,
      { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...DATA_SEGMENTS_HEADERS }, params: { publishAll: false } }
    );
    res.status(200).json({ published: ids.length });
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[segments] publish failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

// A single EQUALS leaf in ISC's Data Segment memberFilter DSL: flat
// `attribute` string, typed `value: {type, value}`. Verified live (create +
// round-trip GET) against this tenant's own /v2026/data-segments.
function segmentEqualsLeaf(attrKey, value) {
  return { operator: "EQUALS", attribute: attrKey, value: { type: "STRING", value }, children: [], metadata: null };
}

// ISC's own "Build Criteria" UI always wraps each condition in its own
// AND "row" node, even when that row has just one condition — confirmed
// by inspecting a segment actually created through the ISC UI. A flatter
// single-level AND (bare EQUALS leaves as direct children) round-trips
// fine through the API but isn't a shape the UI's own criteria builder
// ever produces, so it can't parse it back out for editing — this is why
// segments built by this app couldn't be opened/edited in ISC's UI.
// Matching the UI's own row-wrapping convention here fixes that.
function segmentRow(leaf) {
  return { operator: "AND", attribute: null, value: { type: "NULL", value: null }, children: [leaf], metadata: null };
}
function segmentAndExpression(leaves) {
  return { operator: "AND", attribute: null, value: { type: "NULL", value: null }, children: leaves.map(segmentRow), metadata: null };
}

// ─── Segment scans (Mining > Segments) ─────────────────────────────────────
// Same boundary-combination discovery the removed "Build Segments" button
// used to run (walks every active identity's boundary attribute value(s)
// from Schema Analysis's own roleBoundaryAttributes, the same ones Role
// Scan partitions by, and finds every distinct combination actually
// present) — but the combinations are persisted as a scan record's
// suggestions rather than created immediately, modeled on Role Mining's
// scan -> draft -> selectively-create flow (see role-scans above and its
// RoleScanDetailPage client). Only shown to the user when Schema Analysis's
// Manage Segments toggle (createDataSegments) is on.
const segmentScans = createRecordStore(DATA_DIR, "segment-scans.json");

// Live progress for a create run, so the UI can count segments off as they
// go. Deliberately its OWN tiny store rather than a field on the scan
// record: that record carries every suggestion's members, so ticking it once
// per created segment would mean a multi-megabyte read-modify-write per item
// (and on the aws backend an S3 round trip each time, since it overflows).
const segmentCreateProgress = createRecordStore(DATA_DIR, "segment-create-progress.json");

async function updateSegmentScan(scanId, patch) {
  await segmentScans.put(scanId, { ...(await segmentScans.get(scanId)), ...patch });
}
const cancelledSegmentScans = new Set();

class SegmentScanCancelledError extends Error {}

// Walks every active identity's boundary attribute value(s) and returns one
// suggestion per distinct combination actually present — the exact same
// discovery Build Segments does inline above, just returned instead of
// created, plus a member count per combination and each suggestion's own
// stable id so a later create call can target it precisely.
//
// includeRoles/includeEntitlements each add a proposal to every suggestion,
// grounded in the exact same data model the standalone Assign Matching
// Roles feature (below) and a segment's own Access Model use:
// - suggestedRoles: every role assigned to ANY identity matching the combo
//   (no commonality requirement — a single holder is enough, same as
//   entitlements below), plus every existing role whose own membership
//   criteria carries all of this combo's attrKey=value pairs — same
//   subset-match computeMatchingAccessForSegments uses, just run against a
//   combo that doesn't have a real segment (and therefore no memberFilter)
//   yet, so the criteria are built directly from the combo's own boundary
//   values. The criteria match keeps roles that fit the segment but have no
//   members yet.
// - suggestedEntitlements: every entitlement held by anyone matching the
//   combo's own attrKey=value pairs (deduplicated) — found by running the
//   SAME criteria the segment's membership rule would use as a Search API
//   query against the identities index, not by looking up a real segment's
//   membership (there isn't one yet for a brand-new suggestion, and even
//   for a combo that matches an existing segment by name, querying by
//   criteria directly is simpler than resolving that segment's own id
//   first). The identities index returns each matching identity's full
//   `access` array (verified live) — entitlement name AND source in one
//   response, no per-identity REST calls and no separate source lookup.
async function computeSegmentSuggestions(tenant, token0, { scanId, includeRoles = true, includeEntitlements = true } = {}) {
  const analysis = await schemaAnalyses.get(tenant);
  const boundaryKeys = analysis?.roleBoundaryEnabled ? (analysis.roleBoundaryAttributes || []) : [];
  if (boundaryKeys.length === 0) {
    const err = new Error("Enable the Multi-Company/Division Boundary with at least one attribute first.");
    err.statusCode = 400;
    throw err;
  }

  const combos = new Map(); // key -> { values, memberCount }
  let offset = 0;
  while (true) {
    if (scanId && cancelledSegmentScans.has(scanId)) throw new SegmentScanCancelledError();
    const page = await withApiRetry(
      () => iscGet(tenant, token0, "/v2026/public-identities", { limit: 250, offset }),
      { label: "segment scan: public-identities page" }
    );
    if (page.length === 0) break;
    for (const idn of page) {
      const values = boundaryKeys.map((k) => idn.attributes?.find((a) => a.key === k)?.value);
      if (values.some((v) => !v || v === "Unknown")) continue;
      const key = values.join("||");
      if (!combos.has(key)) combos.set(key, { values, memberCount: 0 });
      combos.get(key).memberCount += 1;
    }
    offset += page.length;
    if (scanId) updateSegmentScan(scanId, { scanned: offset });
    if (page.length < 250) break;
  }

  const existingSegments = await fetchAllDataSegments(tenant, token0);
  const existingNames = new Set(existingSegments.map((s) => (s.name || "").trim().toLowerCase()));

  const allRoles = includeRoles ? await fetchAllRolesWithCriteria(tenant, token0) : [];

  const suggestions = [...combos.entries()]
    .map(([, combo], i) => {
      const { values, memberCount } = combo;
      const name = `${values.join(" ")} Segment`;
      const description = `Grants segment access to active identities where ${boundaryKeys
        .map((k, idx) => `${k} = "${values[idx]}"`)
        .join(" and ")}.`;

      let suggestedRoles = null;
      if (includeRoles) {
        const criteria = boundaryKeys.map((k, idx) => ({ attrKey: k, value: values[idx] }));
        suggestedRoles = allRoles
          .filter((role) => {
            const roleLeaves = extractAllIdentityEqualsLeaves(role.membership?.criteria);
            if (roleLeaves.length === 0) return false;
            const roleSet = new Set(roleLeaves.map((l) => `${l.attrKey}=${l.value}`));
            return criteria.every((l) => roleSet.has(`${l.attrKey}=${l.value}`));
          })
          .map((role) => ({ id: role.id, name: role.name, enabled: role.enabled, dimensional: !!role.dimensional }));
      }

      return {
        id: `combo-${i}`,
        name,
        description,
        values,
        memberCount,
        existingSegmentName: existingNames.has(name.trim().toLowerCase()) ? name : null,
        segmentCreated: null,
        suggestedRoles,
        suggestedEntitlements: null, // filled in below, once, for every suggestion
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  if (includeEntitlements || includeRoles) {
    const results = await mapWithConcurrency(suggestions, 4, async (s) => {
      const criteria = boundaryKeys.map((k, idx) => ({ attrKey: k, value: s.values[idx] }));
      try {
        return await fetchAssignedAccessForCriteria(tenant, token0, criteria);
      } catch (err) {
        console.warn(`[insights] segment scan: access search failed for "${s.name}":`, err.response?.status || err.message);
        return { entitlements: [], roles: [], accessProfiles: [] };
      }
    });
    suggestions.forEach((s, idx) => {
      if (includeEntitlements) s.suggestedEntitlements = results[idx].entitlements;
      if (includeRoles) s.suggestedRoles = mergeSegmentRoles(s.suggestedRoles || [], results[idx].roles, allRoles);
    });
  }

  return { boundaryKeys, totalCombinations: combos.size, suggestions };
}

// Runs the given attrKey=value pairs as a Search API query against the
// identities index (translated to a Lucene AND of attributes.<key>:"<value>"
// terms — same attributes a segment's own memberFilter EQUALS leaves check)
// and collects the ENTITLEMENT-type entries from every matching identity's
// own `access` array, deduplicated by id. Paginated via searchAfter, same
// as searchAllIdentities above, since a combo can match more identities
// than one page.
async function fetchAssignedEntitlementsForCriteria(tenant, token, criteria) {
  return (await fetchAssignedAccessForCriteria(tenant, token, criteria)).entitlements;
}

// Same query, but also collects the ROLE-type entries — every role assigned
// to ANY matching identity, with no commonality/coverage requirement (one
// holder is enough), mirroring how entitlements have always been collected.
async function fetchAssignedAccessForCriteria(tenant, token, criteria) {
  if (criteria.length === 0) return { entitlements: [], roles: [], accessProfiles: [] };
  const query = criteria
    .map(({ attrKey, value }) => `attributes.${attrKey}:"${String(value).replace(/"/g, '\\"')}"`)
    .join(" AND ");

  const seen = new Map();
  const seenRoles = new Map();
  const seenProfiles = new Map();
  let searchAfter = null;
  const pageSize = 250;
  while (true) {
    const body = { indices: ["identities"], query: { query }, sort: ["id"], queryResultFilter: { includes: ["id", "access"] } };
    if (searchAfter) body.searchAfter = searchAfter;
    const resp = await withApiRetry(
      () => axios.post(
        `https://${tenantApiHost(tenant)}/v2026/search`,
        body,
        { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, params: { limit: pageSize } }
      ),
      { label: "segment scan: entitlement search page" }
    );
    const page = resp.data || [];
    if (page.length === 0) break;
    for (const doc of page) {
      for (const item of doc.access || []) {
        if (!item.id) continue;
        if (item.type === "ENTITLEMENT" && !seen.has(item.id)) {
          seen.set(item.id, { id: item.id, name: item.name, source: item.source?.name || null });
        } else if (item.type === "ROLE" && !seenRoles.has(item.id)) {
          seenRoles.set(item.id, { id: item.id, name: item.name });
        } else if (item.type === "ACCESS_PROFILE" && !seenProfiles.has(item.id)) {
          seenProfiles.set(item.id, { id: item.id, name: item.name, source: item.source?.name || null });
        }
      }
    }
    if (page.length < pageSize) break;
    searchAfter = [page[page.length - 1].id];
  }
  const byName = (a, b) => (a.name || "").localeCompare(b.name || "");
  return {
    entitlements: [...seen.values()].sort(byName),
    roles: [...seenRoles.values()].sort(byName),
    accessProfiles: [...seenProfiles.values()].sort(byName),
  };
}

// Criteria-matched roles plus every role actually assigned to a matching
// identity, deduplicated by id. enabled/dimensional come from the full role
// list when the role is in it; an assigned role missing from that list
// (deleted mid-scan) keeps just its id and name.
function mergeSegmentRoles(criteriaRoles, assignedRoles, allRoles) {
  const roleById = new Map(allRoles.map((r) => [r.id, r]));
  const merged = new Map(criteriaRoles.map((r) => [r.id, r]));
  for (const r of assignedRoles) {
    if (merged.has(r.id)) continue;
    const full = roleById.get(r.id);
    merged.set(r.id, { id: r.id, name: full?.name || r.name, enabled: full ? full.enabled : null, dimensional: !!full?.dimensional });
  }
  return [...merged.values()].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
}

async function runSegmentScan(scanId, session, { includeRoles, includeEntitlements } = {}) {
  const { tenant } = session;
  try {
    const token = await sessionToken(session);
    const { boundaryKeys, totalCombinations, suggestions } = await computeSegmentSuggestions(tenant, token, { scanId, includeRoles, includeEntitlements });
    cancelledSegmentScans.delete(scanId);
    await updateSegmentScan(scanId, {
      status: "completed",
      completedAt: new Date().toISOString(),
      boundaryKeys,
      totalCombinations,
      suggestions,
    });
  } catch (err) {
    if (err instanceof SegmentScanCancelledError) {
      cancelledSegmentScans.delete(scanId);
      await updateSegmentScan(scanId, { status: "cancelled", completedAt: new Date().toISOString() });
      return;
    }
    console.error(`[insights] segment scan ${scanId} failed:`, err.response?.data || err.message);
    await updateSegmentScan(scanId, {
      status: "failed",
      completedAt: new Date().toISOString(),
      error: err.statusCode ? err.message : describeError(err),
    });
  }
}

/**
 * POST /api/insights/segment-scans
 * Header: x-sp-session
 * Body: { includeRoles?: boolean, includeEntitlements?: boolean } — both
 * default true.
 * Starts an asynchronous scan for Multi-Company/Division Boundary attribute
 * combinations that don't yet have a Data Segment. Returns immediately with
 * a scan ID — poll GET /api/insights/segment-scans/:id for progress and the
 * resulting suggestions.
 */
app.post("/api/insights/segment-scans", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;

  const analysis = await schemaAnalyses.get(tenant);
  if (!analysis?.roleBoundaryEnabled || (analysis.roleBoundaryAttributes || []).length === 0) {
    return res.status(400).json({ error: "Enable the Multi-Company/Division Boundary with at least one attribute first." });
  }

  const includeRoles = req.body?.includeRoles !== false;
  const includeEntitlements = req.body?.includeEntitlements !== false;
  // "metadata" (default) tags each suggested role/entitlement with the
  // Boundary metadata attribute and creates the segment with a FILTER Access
  // Model on that attribute — see the :id/create route. "selection" (only
  // when asked for explicitly) instead writes an explicit SELECTION of the
  // suggested roles/entitlements, capped at 50 by ISC. The scan itself is
  // identical either way. Metadata is the default so a caller that omits
  // the mode — e.g. a browser tab still running a pre-update Auto Convert —
  // can never quietly fall back to the capped selection lists.
  const mode = req.body?.mode === "selection" ? "selection" : "metadata";

  const scanId = `segscan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await updateSegmentScan(scanId, {
    id: scanId,
    tenant,
    status: "running",
    startedAt: new Date().toISOString(),
    completedAt: null,
    scanned: 0,
    boundaryKeys: analysis.roleBoundaryAttributes || [],
    totalCombinations: 0,
    suggestions: [],
    error: null,
    includeRoles,
    includeEntitlements,
    mode,
  });

  runSegmentScan(scanId, session, { includeRoles, includeEntitlements });

  res.status(202).json({ scanId });
});

/** GET /api/insights/segment-scans — list past/running segment scans, newest first */
app.get("/api/insights/segment-scans", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const list = Object.values(await segmentScans.all())
    .filter((s) => s.tenant === session.tenant)
    .map(({ suggestions, ...meta }) => ({ ...meta, suggestionCount: suggestions?.length || 0 }))
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
  res.json(list);
});

function segmentScanForSession(scan, session) {
  return scan && scan.tenant === session.tenant ? scan : null;
}

/** GET /api/insights/segment-scans/:id — full record including suggestions */
app.get("/api/insights/segment-scans/:id", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const scan = segmentScanForSession(await segmentScans.get(req.params.id), session);
  if (!scan) return res.status(404).json({ error: "Data segment scan not found." });
  res.json(scan);
});

/** POST /api/insights/segment-scans/:id/cancel */
app.post("/api/insights/segment-scans/:id/cancel", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const scan = segmentScanForSession(await segmentScans.get(req.params.id), session);
  if (!scan) return res.status(404).json({ error: "Data segment scan not found." });
  if (scan.status !== "running") {
    return res.status(400).json({ error: `Scan is already ${scan.status}.` });
  }
  cancelledSegmentScans.add(req.params.id);
  res.json({ cancelling: true });
});

/** DELETE /api/insights/segment-scans/:id — purges a past scan record. */
app.delete("/api/insights/segment-scans/:id", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const scan = segmentScanForSession(await segmentScans.get(req.params.id), session);
  if (!scan) return res.status(404).json({ error: "Data segment scan not found." });
  if (scan.status === "running") {
    return res.status(400).json({ error: "Cancel the scan before removing it." });
  }
  await segmentScans.delete(req.params.id);
  res.status(204).end();
});

// ─── Segments (ISC access-request Segments, not Data Segments) ─────────────
// ISC Segments (/v2026/segments) are a separate object from Data Segments:
// a member definition (visibilityCriteria) plus a set of access items, each
// of which lists the segment in its own `segments` array. The Segments
// mining task proposes one Segment per Multi-Company/Division Boundary value
// combination: members = the boundary filter, access = every role, access
// profile and entitlement those members currently hold (identity search).
// The draft is reviewed before anything is created in ISC.

const accessSegmentScans = createRecordStore(DATA_DIR, "access-segment-scans.json");
const accessSegmentCreateProgress = createRecordStore(DATA_DIR, "access-segment-create-progress.json");
const cancelledAccessSegmentScans = new Set();

async function updateAccessSegmentScan(scanId, patch) {
  await accessSegmentScans.put(scanId, { ...(await accessSegmentScans.get(scanId)), ...patch });
}
function accessSegmentScanForSession(scan, session) {
  return scan && scan.tenant === session.tenant ? scan : null;
}

// The Segment's member definition: one EQUALS per boundary attribute, ANDed
// when there's more than one — ISC's Segment expression shape (operator /
// attribute / value{type,value} / children).
function accessSegmentVisibilityCriteria(boundaryKeys, values) {
  const leaves = boundaryKeys.map((k, i) => ({
    operator: "EQUALS",
    attribute: k,
    value: { type: "STRING", value: String(values[i]) },
    children: null,
  }));
  return { expression: leaves.length === 1 ? leaves[0] : { operator: "AND", attribute: null, value: null, children: leaves } };
}

async function fetchAllIscSegments(tenant, token) {
  const all = [];
  for (let offset = 0; ; offset += 250) {
    const page = await withApiRetry(
      () => iscGet(tenant, token, "/v2026/segments", { limit: 250, offset }),
      { label: "segments: list page" }
    );
    if (!Array.isArray(page) || page.length === 0) break;
    all.push(...page);
    if (page.length < 250) break;
  }
  return all;
}

// Every distinct combination of the boundary attributes' values across the
// tenant's identities, with a member count — the same discovery the Data
// Segments scan does. Identities missing a value (or "Unknown") are skipped.
async function collectBoundaryCombos(tenant, token, boundaryKeys, { onScanned, isCancelled } = {}) {
  const combos = new Map();
  let offset = 0;
  while (true) {
    if (isCancelled?.()) throw new SegmentScanCancelledError();
    const page = await withApiRetry(
      () => iscGet(tenant, token, "/v2026/public-identities", { limit: 250, offset }),
      { label: "segments scan: public-identities page" }
    );
    if (page.length === 0) break;
    for (const idn of page) {
      const values = boundaryKeys.map((k) => idn.attributes?.find((a) => a.key === k)?.value);
      if (values.some((v) => !v || v === "Unknown")) continue;
      const key = values.join("||");
      if (!combos.has(key)) combos.set(key, { values, memberCount: 0 });
      combos.get(key).memberCount += 1;
    }
    offset += page.length;
    if (onScanned) await onScanned(offset);
    if (page.length < 250) break;
  }
  return [...combos.values()];
}

async function runAccessSegmentScan(scanId, session) {
  const { tenant } = session;
  try {
    const token = await sessionToken(session);
    const analysis = await schemaAnalyses.get(tenant);
    const boundaryKeys = analysis?.roleBoundaryEnabled ? (analysis.roleBoundaryAttributes || []) : [];
    const combos = await collectBoundaryCombos(tenant, token, boundaryKeys, {
      onScanned: (n) => updateAccessSegmentScan(scanId, { scanned: n }),
      isCancelled: () => cancelledAccessSegmentScans.has(scanId),
    });
    const existing = await fetchAllIscSegments(tenant, token);
    const existingByName = new Map(existing.map((sg) => [String(sg.name || "").trim().toLowerCase(), sg]));

    const suggestions = combos
      .map(({ values, memberCount }, i) => {
        const name = `${values.join(" ")} Segment`;
        const match = existingByName.get(name.trim().toLowerCase());
        return {
          id: `seg-${i}`,
          name,
          description: `Access for identities where ${boundaryKeys.map((k, idx) => `${k} = "${values[idx]}"`).join(" and ")}.`,
          values,
          memberCount,
          visibilityCriteria: accessSegmentVisibilityCriteria(boundaryKeys, values),
          existingSegment: match ? { id: match.id, name: match.name } : null,
          roles: [],
          accessProfiles: [],
          entitlements: [],
          segmentCreated: null,
          addedToExisting: null,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    // What the members actually hold — one identity search per combination.
    let done = 0;
    await mapWithConcurrency(suggestions, 4, async (s) => {
      if (cancelledAccessSegmentScans.has(scanId)) throw new SegmentScanCancelledError();
      const criteria = boundaryKeys.map((k, idx) => ({ attrKey: k, value: s.values[idx] }));
      try {
        const held = await fetchAssignedAccessForCriteria(tenant, token, criteria);
        s.roles = held.roles;
        s.accessProfiles = held.accessProfiles;
        s.entitlements = held.entitlements;
      } catch (err) {
        console.warn(`[segments-isc] access search failed for "${s.name}":`, err.response?.status || err.message);
        s.searchError = describeError(err);
      }
      done += 1;
      await updateAccessSegmentScan(scanId, { searched: done });
    });

    cancelledAccessSegmentScans.delete(scanId);
    await updateAccessSegmentScan(scanId, {
      status: "completed",
      completedAt: new Date().toISOString(),
      boundaryKeys,
      totalCombinations: combos.length,
      suggestions,
    });
  } catch (err) {
    cancelledAccessSegmentScans.delete(scanId);
    if (err instanceof SegmentScanCancelledError) {
      await updateAccessSegmentScan(scanId, { status: "cancelled", completedAt: new Date().toISOString() });
      return;
    }
    console.error(`[segments-isc] scan ${scanId} failed:`, err.response?.data || err.message);
    await updateAccessSegmentScan(scanId, { status: "failed", completedAt: new Date().toISOString(), error: describeError(err) });
  }
}

// Adds `segmentId` to each item's own `segments` list. Current lists are
// read in batches (id in (…), 50 per call) so an item's other segments are
// kept and an item already carrying this one is skipped; each change is a
// JSON Patch replace of /segments.
const ACCESS_SEGMENT_ITEM_TYPES = {
  roles: { path: "/v2026/roles", label: "role" },
  accessProfiles: { path: "/v2026/access-profiles", label: "access profile" },
  entitlements: { path: "/v2026/entitlements", label: "entitlement" },
};
async function assignItemsToIscSegment(tenant, token, segmentId, itemsByType) {
  const result = {};
  for (const [type, { path, label }] of Object.entries(ACCESS_SEGMENT_ITEM_TYPES)) {
    const ids = [...new Set((itemsByType[type] || []).filter(Boolean))];
    const out = { requested: ids.length, assigned: 0, alreadyAssigned: 0, failed: [] };
    const current = new Map(); // id -> segments[]
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      const page = await withApiRetry(
        () => iscGet(tenant, token, path, { filters: `id in (${chunk.map((id) => `"${id}"`).join(",")})`, limit: 250 }),
        { label: `segments: read ${label} segments` }
      ).catch(() => []);
      for (const item of page || []) current.set(item.id, Array.isArray(item.segments) ? item.segments : []);
    }
    await mapWithConcurrency(ids, 4, async (id) => {
      const segs = current.get(id) || [];
      if (segs.includes(segmentId)) { out.alreadyAssigned += 1; return; }
      try {
        await withApiRetry(
          () => axios.patch(
            `https://${tenantApiHost(tenant)}${path}/${id}`,
            [{ op: "replace", path: "/segments", value: [...segs, segmentId] }],
            { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json-patch+json" } }
          ),
          { label: `segments: assign ${label} ${id}` }
        );
        out.assigned += 1;
      } catch (err) {
        out.failed.push({ id, error: describeError(err) });
      }
    });
    if (out.failed.length) {
      console.warn(`[segments-isc] ${out.failed.length} ${label}(s) not assigned to ${segmentId} — first:`, out.failed[0].error);
    }
    result[type] = out;
  }
  return result;
}

/** POST /api/insights/access-segment-scans — start a Segments scan. */
app.post("/api/insights/access-segment-scans", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  const analysis = await schemaAnalyses.get(tenant);
  if (!analysis?.roleBoundaryEnabled || (analysis.roleBoundaryAttributes || []).length === 0) {
    return res.status(400).json({ error: "Enable the Multi-Company/Division Boundary with at least one attribute first." });
  }
  const scanId = `accsegscan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await updateAccessSegmentScan(scanId, {
    id: scanId,
    tenant,
    status: "running",
    startedAt: new Date().toISOString(),
    completedAt: null,
    scanned: 0,
    searched: 0,
    boundaryKeys: analysis.roleBoundaryAttributes || [],
    totalCombinations: 0,
    suggestions: [],
    error: null,
  });
  runAccessSegmentScan(scanId, session);
  res.status(202).json({ scanId });
});

/** GET /api/insights/access-segment-scans — this tenant's drafts, newest first. */
app.get("/api/insights/access-segment-scans", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const list = Object.values(await accessSegmentScans.all())
    .filter((s) => s.tenant === session.tenant)
    .map(({ suggestions, ...meta }) => ({ ...meta, suggestionCount: suggestions?.length || 0 }))
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
  res.json(list);
});

app.get("/api/insights/access-segment-scans/:id", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const scan = accessSegmentScanForSession(await accessSegmentScans.get(req.params.id), session);
  if (!scan) return res.status(404).json({ error: "Segments draft not found." });
  res.json(scan);
});

app.post("/api/insights/access-segment-scans/:id/cancel", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const scan = accessSegmentScanForSession(await accessSegmentScans.get(req.params.id), session);
  if (!scan) return res.status(404).json({ error: "Segments draft not found." });
  if (scan.status !== "running") return res.status(400).json({ error: `Scan is already ${scan.status}.` });
  cancelledAccessSegmentScans.add(req.params.id);
  res.json({ cancelling: true });
});

app.delete("/api/insights/access-segment-scans/:id", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const scan = accessSegmentScanForSession(await accessSegmentScans.get(req.params.id), session);
  if (!scan) return res.status(404).json({ error: "Segments draft not found." });
  if (scan.status === "running") return res.status(400).json({ error: "Cancel the scan before removing it." });
  await accessSegmentScans.delete(req.params.id);
  res.status(204).end();
});

app.get("/api/insights/access-segment-scans/:id/create-progress", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const scan = accessSegmentScanForSession(await accessSegmentScans.get(req.params.id), session);
  if (!scan) return res.status(404).json({ error: "Segments draft not found." });
  const p = await accessSegmentCreateProgress.get(req.params.id);
  res.json({ done: p?.done ?? 0, total: p?.total ?? 0 });
});

/**
 * POST /api/insights/access-segment-scans/:id/create
 * Body: { suggestionIds: [...], activate?: boolean }
 * For each suggestion: creates the ISC Segment (member definition = the
 * boundary filter) — or, when one with that name already exists, uses it —
 * then assigns the suggestion's roles, access profiles and entitlements.
 */
app.post("/api/insights/access-segment-scans/:id/create", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const scan = accessSegmentScanForSession(await accessSegmentScans.get(req.params.id), session);
  if (!scan) return res.status(404).json({ error: "Segments draft not found." });
  const { suggestionIds, activate = true } = req.body || {};
  if (!Array.isArray(suggestionIds) || suggestionIds.length === 0) {
    return res.status(400).json({ error: "suggestionIds must be a non-empty array." });
  }
  const { tenant } = session;
  const chosen = (scan.suggestions || []).filter((s) => suggestionIds.includes(s.id) && !s.segmentCreated && !s.addedToExisting);
  if (chosen.length === 0) return res.status(400).json({ error: "Nothing to do — the selected segments were already created." });

  await accessSegmentCreateProgress.put(req.params.id, { done: 0, total: chosen.length, startedAt: Date.now() });
  const results = [];
  let done = 0;
  await mapWithConcurrency(chosen, 2, async (s) => {
    try {
      const token = await sessionToken(session);
      let segmentId = s.existingSegment?.id || null;
      let segmentName = s.existingSegment?.name || s.name;
      const merged = !!segmentId;
      if (!segmentId) {
        const resp = await withApiRetry(
          () => axios.post(
            `https://${tenantApiHost(tenant)}/v2026/segments`,
            {
              name: s.name,
              description: s.description,
              owner: session.identity?.id ? { type: "IDENTITY", id: session.identity.id, name: session.identity.username } : null,
              visibilityCriteria: s.visibilityCriteria,
              active: !!activate,
            },
            { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }
          ),
          { label: `segments: create "${s.name}"` }
        );
        segmentId = resp.data.id;
        segmentName = resp.data.name || s.name;
      }
      const assigned = await assignItemsToIscSegment(tenant, token, segmentId, {
        roles: (s.roles || []).map((x) => x.id),
        accessProfiles: (s.accessProfiles || []).map((x) => x.id),
        entitlements: (s.entitlements || []).map((x) => x.id),
      });
      const record = { segmentId, segmentName, at: new Date().toISOString(), assigned };
      if (merged) s.addedToExisting = record;
      else s.segmentCreated = record;
      results.push({ id: s.id, ok: true, merged, segmentId, segmentName, assigned });
    } catch (err) {
      console.error(`[segments-isc] "${s.name}" failed:`, err.response?.data || err.message);
      results.push({ id: s.id, ok: false, error: describeError(err) });
    } finally {
      done += 1;
      await accessSegmentCreateProgress.put(req.params.id, { done, total: chosen.length, startedAt: Date.now() });
    }
  });
  await updateAccessSegmentScan(req.params.id, { suggestions: scan.suggestions });
  await accessSegmentCreateProgress.put(req.params.id, { done: 0, total: 0 });
  res.json({ results });
});

// ─── Boundary metadata (Segments by Metadata mode) ──────────────────────────
// A "metadata"-mode scan creates segments whose Access Model is a FILTER on
// the Access Model Metadata attribute "Boundary" rather than an explicit
// SELECTION list — sidestepping ISC's 50-item scopeSelection cap entirely,
// since membership is then just "any role/entitlement whose Boundary
// metadata contains this segment's boundary value" (the attribute is
// multi-valued, so one entitlement can belong to many segments).

// Which Global Metadata attribute drives segment membership is tenant
// configuration (Mining Config > Create Data Segments), not a hardcoded
// name — this is only the default when nothing's been saved.
const DEFAULT_SEGMENT_METADATA_ATTRIBUTE = "Segments";

// tenant -> { "<attrKey>:<value>": "<internal value GUID>" }. A segment's
// ROLE scope filter must reference the metadata value by its INTERNAL GUID
// — verified live: with the technical name ("be") ISC's UI shows the role
// filter as "Segments equals " (unresolvable value) and no roles populate;
// swapping in the GUID fixed both. No public read endpoint exposes these
// GUIDs (values list, single-value GET, and search docs all omit them), so
// they're captured opportunistically at value-create time and remembered
// here. ENTITLEMENT scope filters resolve fine by technical name.
const metadataValueIds = createRecordStore(DATA_DIR, "metadata-value-ids.json");

// Values here are ROLE-index GUIDs: the same metadata value has a different
// GUID in the entitlements index, and the ROLE scope filter is the only
// consumer, so only role-derived ids are ever stored.
//
// The one place a value's GUID can actually be READ: a segment whose ROLE
// filter was picked by hand in ISC's own segment editor. ISC writes the GUID
// into that ROLE leaf, while the same segment's ENTITLEMENT leaf names the
// same value by its technical name — so the pair is sitting there, side by
// side. (Everything else was checked live and carries no id: the values
// list, single-value GET, the attribute GET with its embedded values, a
// tagged role's own accessModelMetadata, and search documents.) Harvesting
// means a value has to be picked in ISC's editor only ONCE, on any one
// segment: after that every create / conversion that uses the value gets
// its ROLE filter resolved automatically. Returns how many pairs were new.
async function harvestMetadataValueGuids(tenant, segments) {
  const isGuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v));
  const stored = (await metadataValueIds.get(tenant)) || {};
  const found = {};
  for (const seg of Array.isArray(segments) ? segments : []) {
    const leafOf = (scopeType) => {
      const scope = (seg.scopes || []).find((sc) => sc.scope === scopeType && sc.visibility === "FILTER");
      return findSegmentEqualsLeaf(scope?.scopeFilter?.expression);
    };
    const role = leafOf("ROLE");
    const ent = leafOf("ENTITLEMENT");
    // Only a pair that is unambiguous: same attribute on both scopes, a GUID
    // on the ROLE side and a plain technical name on the ENTITLEMENT side.
    if (!role?.attribute || role.attribute !== ent?.attribute) continue;
    const guid = role.value?.value;
    const technical = ent.value?.value;
    if (!isGuid(guid) || technical == null || isGuid(technical)) continue;
    const mapKey = `${role.attribute}:${technical}`;
    if (stored[mapKey] !== guid) found[mapKey] = String(guid);
  }
  const count = Object.keys(found).length;
  if (count) {
    await metadataValueIds.put(tenant, { ...stored, ...found });
    console.log(`[segments] harvested ${count} metadata value GUID(s) from segments edited in ISC: ${Object.keys(found).join(", ")}`);
  }
  return count;
}

/**
 * GET /api/metadata-value-guids
 *
 * The stored value->GUID map, reversed, so the UI can show a segment's ROLE
 * filter in readable terms. ISC writes the AMM value's internal GUID into
 * that leaf (the ENTITLEMENT leaf beside it names the same value by its
 * technical name), so a criteria view that prints the raw leaf shows an
 * opaque GUID for one scope and a readable name for the other.
 *
 * Entries accumulate from both directions this app can learn a GUID:
 * harvesting a segment edited in ISC's own editor, and reading one back out
 * of search-lite after tagging. Display names are filled in from the
 * attribute's own values list — one call per distinct attribute, not per
 * value — and a name that can't be fetched simply falls back to the
 * technical value.
 */
app.get("/api/metadata-value-guids", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  try {
    const stored = (await metadataValueIds.get(session.tenant)) || {};
    const entries = Object.entries(stored).filter(([, guid]) => typeof guid === "string" && guid);
    const byGuid = {};
    // "key:technicalValue" -> guid. The key itself can't contain ":" (ISC
    // attribute keys are identifier-shaped), so the first colon splits it.
    const parsed = entries.map(([mapKey, guid]) => {
      const i = mapKey.indexOf(":");
      return { guid, key: i === -1 ? mapKey : mapKey.slice(0, i), value: i === -1 ? "" : mapKey.slice(i + 1) };
    });

    const names = {};
    const token = await sessionToken(session);
    for (const key of [...new Set(parsed.map((p) => p.key))]) {
      const values = await iscGet(
        session.tenant, token,
        `/v2026/access-model-metadata/attributes/${encodeURIComponent(key)}/values`,
        { limit: 250 }
      ).catch(() => []);
      for (const v of values || []) if (v?.value) names[`${key}:${v.value}`] = v.name || v.value;
    }

    for (const { guid, key, value } of parsed) {
      byGuid[guid] = { key, value, name: names[`${key}:${value}`] || value };
    }
    res.json({ byGuid, count: Object.keys(byGuid).length });
  } catch (err) {
    if (err.sessionExpired) return res.status(401).json({ error: describeError(err), sessionExpired: true });
    console.warn("[segments] metadata-value-guids failed:", err.response?.status || err.message);
    res.json({ byGuid: {}, count: 0 });
  }
});

// Get-or-create the Boundary attribute in the tenant's global Access Model
// Metadata list, matching the shape of a hand-created attribute (the
// tenant's own "xTest" example, dissected live in a separate session):
// multi-valued (multiselect: true), objectTypes ["general"] (the live API
// rejects the spec's documented "all"; "general" is what both hand-created
// and ISC's own built-in attributes carry), and the UNDOCUMENTED isAdhoc
// flag set true — that field, absent from the public AttributeDTO, is what
// ISC's "Allow Ad Hoc Values" toggle actually writes.
async function ensureBoundaryMetadataAttribute(tenant, token, key) {
  // Looked up via the list endpoint's filter rather than GET-by-key — a
  // missing key there isn't a clean 404, it's a 400 "Referenced object not
  // found" (detailCode 400.1.404, verified live), indistinguishable by
  // status from a genuinely malformed request. The filtered list just
  // returns an empty array instead.
  const existing = await iscGet(tenant, token, "/v2026/access-model-metadata/attributes", {
    filters: `key eq "${key}"`,
  });
  if (Array.isArray(existing) && existing.length > 0) return existing[0];

  const base = {
    key,
    name: key,
    multiselect: true,
    status: "active",
    type: "custom",
    objectTypes: ["general"],
    description: "This attribute is used to determine data segment assignments.",
  };
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  try {
    // Ideal single call — isAdhoc up front, no placeholder values.
    const resp = await axios.post(
      `https://${tenantApiHost(tenant)}/v2026/access-model-metadata/attributes`,
      { ...base, isAdhoc: true, values: [] },
      { headers }
    );
    console.log(`[segments] created Access Model Metadata attribute "${key}"`);
    return resp.data;
  } catch (err) {
    console.warn(
      `[segments] direct create of "${key}" attribute failed (${err.response?.status}) — using the verified placeholder+patch sequence:`,
      err.response?.data || err.message
    );
  }
  // Verified-live fallback (same tenant, separate session): a create with an
  // empty values list 500s, but one with a placeholder value succeeds, and
  // PATCHing isAdhoc to true afterward both enables ad-hoc AND clears the
  // placeholder automatically.
  await axios.post(
    `https://${tenantApiHost(tenant)}/v2026/access-model-metadata/attributes`,
    { ...base, values: [{ value: "placeholder", name: "Placeholder", status: "active" }] },
    { headers }
  );
  const patched = await axios.patch(
    `https://${tenantApiHost(tenant)}/v2026/access-model-metadata/attributes/${key}`,
    [{ op: "replace", path: "/isAdhoc", value: true }],
    { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json-patch+json" } }
  );
  // Belt and braces — if the PATCH didn't clear the placeholder on this
  // tenant, remove it via the dedicated value-delete endpoint (the only
  // way; PATCH ops against /values are rejected, verified live).
  if ((patched.data?.values || []).some((v) => v.value === "placeholder")) {
    await axios
      .delete(
        `https://${tenantApiHost(tenant)}/v2026/access-model-metadata/attributes/${key}/values/placeholder`,
        { headers }
      )
      .catch((err) => console.warn("[segments] placeholder value cleanup failed:", err.response?.data || err.message));
  }
  console.log(`[segments] created Access Model Metadata attribute "${key}" (placeholder+patch sequence)`);
  return patched.data;
}

// A metadata value's technical name is a slug, not free text — ISC's own
// values pair a lowercase technical name with a human display name
// ("insider"/"Insider", "value1"/"Value1"), and registering one with a
// space in the technical name 400s "semantically invalid" (verified live
// with "BE Brussels"). The display name keeps the human form.
function boundaryValueSlug(display) {
  return String(display).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// Registers one boundary value (technical slug + display name, e.g.
// "be-brussels"/"BE - Brussels") on the attribute, immediately before its
// segment gets created. Required, not best-effort: the segment's FILTER
// criteria and every tag reference this value, so if it can't exist the
// create shouldn't proceed. Idempotent — an already-registered value is
// simply reused.
//
// Returns the value's internal GUID when one is known (needed for the ROLE
// scope filter — see metadataValueIds above), else null: from the stored
// mapping for a pre-existing value, or captured from the create response
// for a new one. The create response's shape is logged verbatim the first
// time since the public spec doesn't document an id field on it — if ISC
// returns one under any name, the log tells us and the extraction below
// already looks for the likely spellings.
// ISC stores an Access Model Metadata value on a role/entitlement as its
// internal GUID in the search-lite index, while Search and the entitlement
// GET keep showing the key and value. A Data Segment's ROLE filter needs
// that GUID — the technical name alone is something ISC's own segment editor
// can't resolve — and the value-create response only carries an id
// sometimes, never for a value that already existed.
//
// So after an item is tagged, its GUID can be read back out of search-lite.
// The endpoint is undocumented (absent from SailPoint's published specs, but
// live: /v2025/complete-nonsense 404s while /v2025/search-lite 401s), so the
// response shape is logged once per process and read defensively.
let loggedSearchLiteShape = false;

const GUID_RE = /^[0-9a-f]{32}$|^[0-9a-f-]{36}$/i;

/** Every AMM value recorded against `key` on one object, as search-lite has it. */
function ammValuesFromSearchLiteRow(row, key) {
  const attrs = row?.accessModelMetadata?.attributes || row?.accessModelMetadata || [];
  const list = Array.isArray(attrs) ? attrs : [];
  const attr = list.find((a) => a?.key === key || a?.name === key);
  const values = attr?.values || attr?.value || [];
  return (Array.isArray(values) ? values : [values])
    .map((v) => (typeof v === "string" ? v : v?.id || v?.valueId || v?.guid || v?.value))
    .filter((v) => typeof v === "string" && v);
}

/**
 * The GUID ISC uses for one AMM value, read back from search-lite via an
 * object that carries it.
 *
 * `index` MATTERS: the same metadata value has a different GUID in the roles
 * index than in the entitlements index (verified on a live tenant). So the
 * index must match the scope the GUID is destined for — a segment's ROLE
 * filter needs the one from ["roles"], read off a tagged role. Passing the
 * wrong index yields a valid-looking GUID that silently scopes to nothing.
 *
 * Returns null rather than guessing when the object holds several values for
 * the key and none can be told apart.
 */
async function resolveAmmValueGuidViaSearchLite(tenant, token, { index, objectId, key }) {
  try {
    const resp = await axios.post(
      `https://${tenantApiHost(tenant)}/v2025/search-lite`,
      {
        queryType: "ATLAS",
        atlasQuery: { filter: { property: "id", operation: "IN", value: [objectId] } },
        indices: [index],
        includeNested: true,
        sort: ["name"],
      },
      { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }
    );
    const rows = Array.isArray(resp.data) ? resp.data : resp.data?.items || resp.data?.results || [];
    if (!loggedSearchLiteShape) {
      loggedSearchLiteShape = true;
      console.log(`[segments] search-lite raw row shape: ${JSON.stringify(rows[0] || resp.data)?.slice(0, 600)}`);
    }
    const values = ammValuesFromSearchLiteRow(rows[0], key);
    const guids = values.filter((v) => GUID_RE.test(v));
    // One GUID against this key is unambiguous — it is the value just
    // tagged. Several means the item carries more than one boundary value
    // and search-lite shows GUIDs only, with nothing to match them back to
    // a technical name; guessing there would silently scope the segment to
    // the wrong value, so this reports nothing instead.
    if (guids.length === 1) return guids[0];
    if (guids.length > 1) {
      console.warn(`[segments] search-lite returned ${guids.length} GUIDs for "${key}" on ${index}/${objectId} — can't tell which is which, leaving the ROLE filter unresolved`);
    }
    return null;
  } catch (err) {
    console.warn(`[segments] search-lite GUID lookup failed for ${index}/${objectId}:`, err.response?.status || err.message);
    return null;
  }
}

async function ensureBoundaryMetadataValue(tenant, token, key, { value, name, knownValues }) {
  const mapKey = `${key}:${value}`;
  const stored = (await metadataValueIds.get(tenant)) || {};

  // A batch creating many segments passes knownValues — the attribute's value
  // list read ONCE for the run and updated as values are added — instead of
  // re-reading the same list for every suggestion. It's an exact substitute,
  // not a cache: nothing else writes to that list during the run.
  if (knownValues) {
    if (knownValues.has(value)) return stored[mapKey] || null;
  } else {
    const existing = await iscGet(tenant, token, `/v2026/access-model-metadata/attributes/${encodeURIComponent(key)}/values`, {
      limit: 250,
    }).catch(() => []);
    if ((existing || []).some((v) => v.value === value)) return stored[mapKey] || null;
  }

  let resp;
  try {
    resp = await axios.post(
      `https://${tenantApiHost(tenant)}/v2026/access-model-metadata/attributes/${encodeURIComponent(key)}/values`,
      { value, name, status: "active" },
      { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }
    );
  } catch (err) {
    // A concurrent register (or a value the list lookup missed) shows up
    // here as a uniqueness 400 — usually that IS the state this function
    // exists to produce. But the same error also comes back when items still
    // carry a value the attribute itself no longer lists, and treating that
    // as success would leave the attribute permanently without a value the
    // segment filters depend on. So confirm it rather than assume it.
    const msg = JSON.stringify(err.response?.data || {});
    if (err.response?.status === 400 && /unique|already exist/i.test(msg)) {
      const after = await iscGet(
        tenant, token,
        `/v2026/access-model-metadata/attributes/${encodeURIComponent(key)}/values`,
        { limit: 250 }
      ).catch(() => null);
      if (after && !after.some((v) => v.value === value)) {
        console.error(`[segments] "${value}" on "${key}" was refused as a duplicate but is NOT in the attribute's value list — filters referencing it will not resolve`);
        throw err;
      }
      if (knownValues) knownValues.add(value);
      console.log(`[segments] metadata value "${value}" on "${key}" already registered (concurrent create)`);
      return stored[mapKey] || null;
    }
    throw err;
  }
  if (knownValues) knownValues.add(value);
  console.log(`[segments] registered metadata value "${value}" ("${name}") on "${key}" — create response: ${JSON.stringify(resp.data)}`);
  // The public spec's AttributeValueDTO carries no id, so probe the likely
  // layouts: an id at the top level, or the response echoing the whole
  // attribute with its values list (each possibly carrying one).
  const body = resp.data || {};
  const echoedValue = Array.isArray(body.values) ? body.values.find((v) => v.value === value) : null;
  const guid = body.id || body.valueId || body.guid || echoedValue?.id || echoedValue?.valueId || echoedValue?.guid || null;
  if (guid) {
    await metadataValueIds.put(tenant, { ...stored, [mapKey]: guid });
    console.log(`[segments] captured value GUID ${guid} for "${key}:${value}"`);
  } else {
    console.warn(`[segments] value create response carried no id — ROLE scope filter for "${value}" will fall back to the technical name (ISC's UI won't resolve it; see metadataValueIds)`);
  }
  return guid;
}

// ADDs (never replaces — the attribute is multi-valued and an item may
// already carry other segments' values) one boundary value onto every
// suggested entitlement and role. The documented ENTITLEMENT bulk endpoint
// (/access-model-metadata/bulk-update/ids) is deprecated and actually 404s
// on this tenant (verified live), so entitlements go through the per-item
// assignment endpoint instead, with modest concurrency (withApiRetry
// absorbs the 429s that produces). Roles keep the bulk endpoint — theirs
// isn't deprecated — with the same per-item fallback if a tenant lacks it.
/**
 * Bulk-tag entitlements with one AMM value.
 *
 * POST /entitlements/v1/access-model-metadata/bulk-update/ids takes up to
 * 3000 ids per call, against one call PER ENTITLEMENT otherwise — a segment
 * with a few hundred entitlements was generating hundreds of POSTs and
 * hundreds of rate-limit retries (969 in one observed run), which is also
 * what provoked an ISC 500.
 *
 * It is NOT trusted on its word. The roles bulk endpoint on this tenant
 * returns a cheerful "job created" and then silently does nothing (see the
 * note in tagAccessWithBoundaryValue), and this one is asynchronous too — it
 * returns a task id, not a result. So after submitting, one entitlement is
 * re-read to confirm the value actually landed; if it hasn't, this reports
 * failure and the caller falls back to per-item tagging. A silent no-op is
 * far worse than being slow.
 *
 * The outcome is remembered per process: once bulk is known to work (or not)
 * on a tenant, later batches skip the verification round trip.
 */
/**
 * Any one role already tagged with this metadata value. Search matches on the
 * technical NAME (the index doesn't hold the GUID), which is exactly what is
 * available before the GUID is known — so this gives search-lite a role to
 * read the GUID off even when the segment being created suggests no roles of
 * its own.
 */
async function findRoleTaggedWithValue(tenant, token, key, value) {
  try {
    const resp = await withApiRetry(
      () => axios.post(
        `https://${tenantApiHost(tenant)}/v2026/search`,
        {
          indices: ["roles"],
          query: { query: `@accessModelMetadata(key:${key} AND value:"${String(value).replace(/"/g, '\\"')}")` },
          sort: ["name"],
        },
        { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, params: { limit: 1 } }
      ),
      { label: `find role tagged with ${key}:${value}` }
    );
    return (resp.data || [])[0]?.id || null;
  } catch (err) {
    console.warn(`[segments] role search for ${key}:${value} failed:`, err.response?.status || err.message);
    return null;
  }
}

/**
 * The value's ROLE-index GUID, waiting for search-lite to catch up.
 *
 * Roles are tagged moments before this runs and search-lite indexes
 * asynchronously, so the first look frequently misses. Giving up there is
 * what previously forced a fallback — and every fallback is wrong: the
 * technical name produces a filter ISC can't resolve, and an explicit role
 * SELECTION is capped at 50 (SCOPE_SELECTION_MAX) so a coarse boundary would
 * silently drop the rest. The ROLE scope has to be a metadata filter
 * carrying the GUID, so this waits for it rather than settling for less.
 */
async function resolveRoleValueGuid(tenant, token, { key, value, roleIds }) {
  const waits = [0, 1500, 3000, 5000, 8000, 12000];
  // Which attempt wins decides whether this retry is free insurance or a real
  // cost. Attempt 1 has no delay at all, so resolving there costs nothing;
  // anything later means search-lite hadn't indexed the just-tagged role yet,
  // and the fix would be to resolve BEFORE the bulk tagging rather than
  // after, so the entitlement work overlaps the indexing instead of
  // preceding it. Logged so that's a measurement rather than a guess.
  const startedAt = Date.now();
  for (let i = 0; i < waits.length; i += 1) {
    if (waits[i]) await new Promise((r) => setTimeout(r, waits[i]));
    const probeRoleId = roleIds?.[0] || await findRoleTaggedWithValue(tenant, token, key, value);
    if (!probeRoleId) continue;
    const guid = await resolveAmmValueGuidViaSearchLite(tenant, token, { index: "roles", objectId: probeRoleId, key });
    if (guid) {
      const mapKey = `${key}:${value}`;
      const stored = (await metadataValueIds.get(tenant)) || {};
      await metadataValueIds.put(tenant, { ...stored, [mapKey]: guid });
      console.log(
        `[segments][guid-timing] resolved "${mapKey}" on attempt ${i + 1}/${waits.length} ` +
        `after ${((Date.now() - startedAt) / 1000).toFixed(1)}s — GUID ${guid} (role ${probeRoleId})`
      );
      return guid;
    }
  }
  console.warn(
    `[segments][guid-timing] NO ROLE GUID for "${key}:${value}" after ${waits.length} attempts ` +
    `/ ${((Date.now() - startedAt) / 1000).toFixed(1)}s — the ROLE filter can't be written`
  );
  return null;
}

const BULK_TAG_MAX = 3000;
const bulkTagUsable = new Map(); // tenant -> true | false

async function entitlementHasMetadataValue(tenant, token, id, key, value) {
  try {
    const ent = await iscGet(tenant, token, `/v2026/entitlements/${id}`);
    const attr = (ent?.accessModelMetadata?.attributes || []).find((a) => a.key === key);
    return (attr?.values || []).some((v) => (typeof v === "string" ? v : v?.value) === value);
  } catch {
    return false;
  }
}

async function bulkTagEntitlements(tenant, token, { key, value, entitlementIds }) {
  if (bulkTagUsable.get(tenant) === false) return false;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  try {
    for (let i = 0; i < entitlementIds.length; i += BULK_TAG_MAX) {
      const chunk = entitlementIds.slice(i, i + BULK_TAG_MAX);
      await withApiRetry(
        () => axios.post(
          `https://${tenantApiHost(tenant)}/entitlements/v1/access-model-metadata/bulk-update/ids`,
          {
            entitlements: chunk,
            operation: "ADD",
            replaceScope: "ATTRIBUTE",
            values: [{ attribute: key, values: [value] }],
          },
          { headers }
        ),
        { label: `bulk-tag ${chunk.length} entitlements with ${key}` }
      );
    }
  } catch (err) {
    // 403 is the documented "custom metadata needs a suite license" case;
    // anything else here is equally a reason to fall back rather than fail.
    console.warn(`[segments] bulk entitlement tagging unavailable (${err.response?.status || err.message}) — falling back to per-item`);
    bulkTagUsable.set(tenant, false);
    return false;
  }

  if (bulkTagUsable.get(tenant) === true) return true;

  // First use on this tenant: prove it actually applied. The update is
  // asynchronous, so allow a few seconds before concluding it didn't.
  const probe = entitlementIds[0];
  for (const waitMs of [1200, 2500, 4000, 6000]) {
    await new Promise((r) => setTimeout(r, waitMs));
    if (await entitlementHasMetadataValue(tenant, token, probe, key, value)) {
      console.log(`[segments] bulk entitlement tagging verified on ${tenant} — using it from here`);
      bulkTagUsable.set(tenant, true);
      return true;
    }
  }
  console.warn(`[segments] bulk entitlement tagging accepted the request but the value never appeared on ${probe} — falling back to per-item and not retrying bulk on this tenant`);
  bulkTagUsable.set(tenant, false);
  return false;
}

async function tagAccessWithBoundaryValue(tenant, token, { key, entitlementIds, roleIds, value, name, skipEnsure = false }) {
  // MANDATORY first step: the value must exist on the attribute before any
  // item is tagged with it. ensureBoundaryMetadataValue is idempotent, so
  // callers that already registered (to capture the GUID) cost one extra
  // list read; callers that didn't — Assign Matching on an existing
  // metadata segment, the eval carry-through, ad-hoc tagging — no longer
  // tag values the attribute doesn't carry (e.g. one removed by an earlier
  // segment delete's cleanup).
  if (!skipEnsure && (entitlementIds?.length || 0) + (roleIds?.length || 0) > 0) {
    await ensureBoundaryMetadataValue(tenant, token, key, { value, name: name || value });
  }
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const encodedPair = `${encodeURIComponent(key)}/values/${encodeURIComponent(value)}`;

  // Which API root actually serves the per-item metadata-assignment routes
  // varies: /v2026 documents them but 404s on this tenant, while /beta is
  // where this API family verifiably works (attribute create was proven
  // there live). Probe v2026 then beta on first use and remember the
  // winner so a batch doesn't re-probe per item. A 404 AFTER the root is
  // settled is a real one (bad id) and propagates.
  let assignRoot = null;
  // "Value of attribute-value should be unique" (400.1.3) means the item
  // ALREADY carries this value — which is exactly the state tagging exists
  // to produce, so it's success, not failure. Comes up whenever a segment
  // is re-created after a delete (items keep their tags even though the
  // delete removed the value from the attribute's own list), verified live.
  const isAlreadyTagged = (err) =>
    err.response?.status === 400 &&
    JSON.stringify(err.response?.data || {}).includes("should be unique");
  const postAssign = async (kind, id) => {
    const candidates = assignRoot ? [assignRoot] : ["v2026", "beta"];
    let lastErr;
    for (const root of candidates) {
      try {
        await withApiRetry(
          () => axios.post(
            `https://${tenantApiHost(tenant)}/${root}/${kind}/${id}/access-model-metadata/${encodedPair}`,
            {},
            { headers }
          ),
          { label: `tag ${kind} ${id} with ${key} (${root})` }
        );
        if (assignRoot !== root) console.log(`[segments] metadata assignment served from /${root}`);
        assignRoot = root;
        return;
      } catch (err) {
        if (isAlreadyTagged(err)) {
          if (assignRoot !== root) console.log(`[segments] metadata assignment served from /${root}`);
          assignRoot = root;
          return;
        }
        lastErr = err;
        if (assignRoot || err.response?.status !== 404) throw err;
      }
    }
    throw lastErr;
  };

  // Entitlements are the bulk of the work — hundreds per segment — so try
  // the bulk endpoint first and only fan out per item if it isn't usable or
  // didn't actually apply (see bulkTagEntitlements).
  if (entitlementIds.length > 0) {
    const bulked = entitlementIds.length > 1
      && await bulkTagEntitlements(tenant, token, { key, value, entitlementIds });
    if (!bulked) {
      // First item runs alone to settle the root probe before fanning out —
      // concurrent probes racing on assignRoot could misread a v2026 404 as
      // a real failure once another worker had already settled on /beta.
      await postAssign("entitlements", entitlementIds[0]);
      await mapWithConcurrency(entitlementIds.slice(1), 4, (id) => postAssign("entitlements", id));
    }
  }

  // Roles use the same per-item endpoint as entitlements. The documented
  // roles BULK endpoint (/roles/access-model-metadata/bulk-update/ids) is a
  // trap: it 202s "job created" and then silently does nothing on this
  // tenant (verified live — entitlements tagged per-item showed their
  // values in ISC while roles "tagged" via the bulk 202 showed none), so
  // it's not used at all.
  if (roleIds.length > 0) {
    await postAssign("roles", roleIds[0]);
    await mapWithConcurrency(roleIds.slice(1), 4, (id) => postAssign("roles", id));
  }
}

// FILTER-visibility scope matching items whose Boundary metadata contains
// the given value, in the exact shape ISC's own UI persists and its
// engine/pickers resolve (verified live by making "BE Segment" match the
// hand-authored "BE Test" piece by piece): the EQUALS leaf nested in a
// double AND wrapper, carrying metadata.isAMM (the undocumented marker
// flagging it as an Access Model Metadata expression). EQUALS against the
// multi-valued attribute matches when ANY of its values equals — the
// "contains the segment filter" semantics wanted here.
//
// `value` is the technical name for ENTITLEMENT scopes, but must be the
// value's internal GUID for ROLE scopes — the role picker/engine only
// dereferences GUIDs (technical names leave the filter reading
// "Segments equals " with no roles populating, verified live).
function boundaryFilterScope(scopeType, key, value) {
  return {
    scope: scopeType,
    visibility: "FILTER",
    scopeFilter: {
      expression: {
        operator: "AND", attribute: null, value: { type: "NULL", value: null }, metadata: null,
        children: [{
          operator: "AND", attribute: null, value: { type: "NULL", value: null }, metadata: null,
          children: [{
            operator: "EQUALS",
            attribute: key,
            value: { type: "STRING", value },
            children: [],
            metadata: { sourceId: null, schemaId: null, schemaName: null, extraExpression: null, isAMM: true },
          }],
        }],
      },
    },
    scopeSelection: [],
  };
}

// ── Metadata-only segment assignment ──────────────────────────────────────
// Everything below is shared by the Assign Matching flow and the segment
// scan's add-to-existing action: roles/entitlements are NEVER written into
// a segment's scopeSelection any more — assignment always goes through the
// Segments by Metadata tagging method.

// Finds the metadata FILTER target on a segment's scopes: a FILTER scope
// whose EQUALS leaf names a metadata attribute. The leaf's value is the
// technical name on the ENTITLEMENT scope; the ROLE scope's may be the
// internal GUID, so ENTITLEMENT is preferred.
function findSegmentEqualsLeaf(expr) {
  if (!expr) return null;
  if (expr.operator === "EQUALS") return expr;
  for (const child of expr.children || []) {
    const leaf = findSegmentEqualsLeaf(child);
    if (leaf) return leaf;
  }
  return null;
}
const isGuidishValue = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s));
function segmentMetadataTarget(segment) {
  const filterScopes = (segment.scopes || []).filter((s) => s.visibility === "FILTER");
  const ordered = [...filterScopes].sort((a, b) => (a.scope === "ENTITLEMENT" ? -1 : 0) - (b.scope === "ENTITLEMENT" ? -1 : 0));
  for (const s of ordered) {
    const leaf = findSegmentEqualsLeaf(s.scopeFilter?.expression);
    if (leaf?.attribute && leaf.value?.value != null && !isGuidishValue(leaf.value.value)) {
      return { key: leaf.attribute, value: String(leaf.value.value) };
    }
  }
  return null;
}

/**
 * Assigns roles/entitlements to a segment purely via the Segments by
 * Metadata method — no scopeSelection writes, ever:
 *
 * - Segment already metadata-driven (FILTER criteria on a metadata
 *   attribute): the items are tagged with the segment's own value and the
 *   live filter picks them up. No draft is created — tagging neither needs
 *   nor wants the revert-to-draft side effect.
 * - Any other segment (SELECTION/ALL/empty Access Model): it is CONVERTED
 *   to the metadata pattern first — the boundary value is derived from the
 *   segment's name (minus the scan's " Segment" suffix), registered on the
 *   configured attribute (created if missing), the chosen items AND every
 *   ref already in the segment's scopeSelection are tagged with it (so
 *   nothing already assigned falls out), and the scopes are replaced with
 *   the standard isAMM FILTER pair (ENTITLEMENT by technical name, ROLE by
 *   the value's GUID when known). The conversion patches the segment's
 *   draft (reverting a published one to draft, same as every other segment
 *   edit) — publishing stays a deliberate separate step.
 *
 * `segment` must be the ORIGINAL record (pre-draft). Returns
 * { value, converted, roleFilterUnresolved }.
 */
async function assignItemsToSegmentViaMetadata(tenant, token, segment, { roleIds = [], entIds = [] }) {
  const existingTarget = segmentMetadataTarget(segment);
  if (existingTarget) {
    await tagAccessWithBoundaryValue(tenant, token, {
      key: existingTarget.key,
      entitlementIds: entIds,
      roleIds,
      value: existingTarget.value,
      // Best display name available if the value has to be (re)registered
      // — e.g. removed by an earlier segment delete's cleanup.
      name: String(segment.name || "").replace(/\s+segment$/i, "").trim() || existingTarget.value,
    });
    return { value: existingTarget.value, converted: false, roleFilterUnresolved: false };
  }

  const metadataKey =
    (await getTenantSettings(tenant)).segmentMetadataAttribute?.trim() || DEFAULT_SEGMENT_METADATA_ATTRIBUTE;
  const boundaryName = String(segment.name || "").replace(/\s+segment$/i, "").trim() || String(segment.name || "");
  const boundaryValue = boundaryValueSlug(boundaryName);
  if (!boundaryValue) throw new Error(`Can't derive a metadata value from segment name "${segment.name}".`);
  await ensureBoundaryMetadataAttribute(tenant, token, metadataKey);
  const valueGuid = await ensureBoundaryMetadataValue(tenant, token, metadataKey, { value: boundaryValue, name: boundaryName });

  // Current SELECTION refs keep their membership by being tagged too.
  const selectedIds = (type) =>
    (segment.scopes || [])
      .filter((s) => s.scope === type && s.visibility === "SELECTION")
      .flatMap((s) => (s.scopeSelection || []).map((r) => r.id))
      .filter(Boolean);
  const allEntIds = [...new Set([...entIds, ...selectedIds("ENTITLEMENT")])];
  const allRoleIds = [...new Set([...roleIds, ...selectedIds("ROLE")])];
  await tagAccessWithBoundaryValue(tenant, token, {
    key: metadataKey,
    entitlementIds: allEntIds,
    roleIds: allRoleIds,
    value: boundaryValue,
    name: boundaryName,
  });

  // Same rule as the create path: the ROLE scope must be a metadata filter
  // carrying the value's GUID. A technical name gives a filter ISC can't
  // resolve, and an explicit SELECTION is capped at 50, so neither is an
  // acceptable substitute — wait for the GUID instead.
  const roleGuid = valueGuid || await resolveRoleValueGuid(tenant, token, {
    key: metadataKey, value: boundaryValue, roleIds: allRoleIds,
  });

  const draftId = await getSegmentPatchTargetId(tenant, token, segment.id);
  const scopes = [boundaryFilterScope("ENTITLEMENT", metadataKey, boundaryValue)];
  if (roleGuid) {
    scopes.push(boundaryFilterScope("ROLE", metadataKey, roleGuid));
  } else {
    console.warn(`[segments] no ROLE GUID for "${metadataKey}:${boundaryValue}" — no ROLE scope written on the converted segment`);
  }
  await withApiRetry(
    () => axios.patch(
      `https://${tenantApiHost(tenant)}/v2026/data-segments/${draftId}`,
      [{ op: "replace", path: "/scopes", value: scopes }],
      { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json-patch+json", ...DATA_SEGMENTS_HEADERS } }
    ),
    { label: `assignItemsToSegmentViaMetadata: convert "${segment.name}"` }
  );
  return { value: boundaryValue, converted: true, roleFilterUnresolved: !roleGuid };
}

/**
 * POST /api/insights/segment-scans/:id/create
 * Body: { suggestionIds: string[] }
 * Creates a real (draft, disabled) Data Segment for each selected
 * suggestion on this scan that hasn't already been created, using the same
 * memberFilter shape computeSegmentSuggestions above discovers combinations
 * with. Marks each created suggestion on the scan record so reopening the
 * draft shows what's already been turned into a segment.
 *
 * A "metadata"-mode scan (see the scan-start route) creates the segment
 * differently: the suggested roles/entitlements are first TAGGED with the
 * Boundary metadata value for this suggestion (its boundary attribute
 * values joined, e.g. "BE Brussels"), and the segment's Access Model is a
 * FILTER on that metadata rather than an explicit selection — no 50-item
 * cap, and membership stays metadata-driven afterward (tag or untag an
 * item and it joins or leaves the segment with no segment edit needed).
 */
/**
 * GET /api/insights/segment-scans/:id/create-progress
 * -> { done, total } while a create run is in flight, zeroes otherwise.
 * Polled by the drafts screen for "(X of Y created)".
 */
app.get("/api/insights/segment-scans/:id/create-progress", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const scan = segmentScanForSession(await segmentScans.get(req.params.id), session);
  if (!scan) return res.status(404).json({ error: "Data segment scan not found." });
  const p = await segmentCreateProgress.get(req.params.id);
  res.json({ done: p?.done ?? 0, total: p?.total ?? 0 });
});

app.post("/api/insights/segment-scans/:id/create", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const scan = segmentScanForSession(await segmentScans.get(req.params.id), session);
  if (!scan) return res.status(404).json({ error: "Data segment scan not found." });
  const { suggestionIds } = req.body || {};
  if (!Array.isArray(suggestionIds) || suggestionIds.length === 0) {
    return res.status(400).json({ error: "suggestionIds must be a non-empty array." });
  }
  const { tenant } = session;
  const chosen = (scan.suggestions || []).filter(
    (s) => suggestionIds.includes(s.id) && !s.segmentCreated && !s.existingSegmentName
  );
  if (chosen.length === 0) {
    return res.status(400).json({ error: "Nothing to create — the selected suggestions were already created." });
  }

  const metadataMode = scan.mode === "metadata";
  // Which Global Metadata attribute to tag and filter on — configured on
  // Mining Config's Create Data Segments box, "Segments" by default.
  const metadataKey =
    (await getTenantSettings(tenant)).segmentMetadataAttribute?.trim() || DEFAULT_SEGMENT_METADATA_ATTRIBUTE;
  if (metadataMode) {
    // One-time per request, not per suggestion — creating the attribute is
    // the only step whose failure should stop everything (nothing can be
    // tagged or filtered without it).
    try {
      const token = await sessionToken(session);
      await ensureBoundaryMetadataAttribute(tenant, token, metadataKey);
    } catch (err) {
      console.error(`[segments] ensure "${metadataKey}" metadata attribute failed:`, err.response?.data || err.message);
      return res.status(err.response?.status || 500).json({
        error: `Couldn't create the "${metadataKey}" Access Model Metadata attribute: ${describeError(err)}`,
      });
    }
  }

  const results = [];
  await segmentCreateProgress.put(req.params.id, { done: 0, total: chosen.length, startedAt: Date.now() });

  // The attribute's value list, read ONCE for the whole run instead of
  // re-read per suggestion, and updated as values are registered.
  let knownValues = null;
  if (metadataMode) {
    const token = await sessionToken(session);
    const existing = await iscGet(
      tenant, token,
      `/v2026/access-model-metadata/attributes/${encodeURIComponent(metadataKey)}/values`,
      { limit: 250 }
    ).catch(() => null);
    if (existing) knownValues = new Set(existing.map((v) => v.value).filter(Boolean));
  }

  // Suggestions are independent of each other, so they run a few at a
  // time rather than strictly one after another. Kept deliberately low:
  // the per-item call volume is largely gone, but ISC rate-limits per
  // TENANT, so piling on concurrency here just converts wall time into
  // 429 backoff. Failures stay per-suggestion, as before.
  await mapWithConcurrency(chosen, 3, async (suggestion) => {
    try {
      const token = await sessionToken(session);
      const leaves = scan.boundaryKeys.map((k, i) => segmentEqualsLeaf(k, suggestion.values[i]));
      const suggestedEnts = suggestion.suggestedEntitlements || [];
      const suggestedRoles = suggestion.suggestedRoles || [];

      let scopes;
      let entDropped = 0;
      let roleDropped = 0;
      let tagged = null;

      if (metadataMode) {
        // The boundary value's display name is the combination's raw
        // attribute values joined with " - " (e.g. "BE - Brussels"), not
        // the segment's display name with its " Segment" suffix — this
        // value is what admins keep tagging access items with going
        // forward. The technical name is its slug (see boundaryValueSlug),
        // registered on the attribute immediately before the segment is
        // created; tagging and the FILTER criteria both reference the
        // technical name.
        const boundaryName = (suggestion.values || []).join(" - ");
        const boundaryValue = boundaryValueSlug(boundaryName);
        let valueGuid = await ensureBoundaryMetadataValue(tenant, token, metadataKey, { value: boundaryValue, name: boundaryName, knownValues });

        // The ROLE filter's GUID can only be read off a role that already
        // carries the value, and search-lite indexes asynchronously — so
        // waiting for it AFTER all the tagging is dead time bolted onto the
        // end. Instead: tag ONE role, start the lookup without awaiting it,
        // then tag everything else. The indexing then happens DURING the
        // bulk work rather than after it, so by the time the result is
        // collected below it has usually already resolved.
        const allRoleIds = suggestedRoles.map((r) => r.id);
        let guidPending = null;
        if (!valueGuid && allRoleIds.length) {
          await tagAccessWithBoundaryValue(tenant, token, {
            key: metadataKey,
            entitlementIds: [],
            roleIds: [allRoleIds[0]],
            value: boundaryValue,
            name: boundaryName,
            skipEnsure: true,
          });
          guidPending = resolveRoleValueGuid(tenant, token, {
            key: metadataKey,
            value: boundaryValue,
            roleIds: [allRoleIds[0]],
          }).catch(() => null);
        }

        await tagAccessWithBoundaryValue(tenant, token, {
          key: metadataKey,
          entitlementIds: suggestedEnts.map((e) => e.id),
          // The pilot role already carries the value; re-tagging it would
          // just be an "already has this" round trip.
          roleIds: guidPending ? allRoleIds.slice(1) : allRoleIds,
          value: boundaryValue,
          name: boundaryName,
          skipEnsure: true,
        });
        tagged = { entitlements: suggestedEnts.length, roles: suggestedRoles.length, value: boundaryName };

        // ENTITLEMENT filters resolve by technical name; ROLE filters only by
        // the value's internal GUID (see boundaryFilterScope). The create
        // response only carries that id sometimes and never for a value that
        // already existed — but an item just tagged with it now HAS the GUID
        // in search-lite, so read it back from there. Cached per tenant, so
        // this costs one extra call the first time a boundary value is used
        // and nothing afterwards.
        if (!valueGuid) {
          // ROLES index only. The same metadata value has DIFFERENT GUIDs in
          // the roles and entitlements indices, so an entitlement-derived id
          // would be a wrong value for the ROLE filter that still looks like
          // a valid GUID — worse than leaving it unresolved, because nothing
          // downstream could tell it was wrong. With no tagged role to read
          // it from, the filter stays unresolved and says so.
          // Already in flight since before the bulk tagging — this collects
          // it rather than starting a fresh wait.
          valueGuid = guidPending
            ? await guidPending
            : await resolveRoleValueGuid(tenant, token, {
                key: metadataKey,
                value: boundaryValue,
                roleIds: allRoleIds,
              });
        }

        // The ROLE scope MUST be a metadata filter carrying the value's GUID.
        // The two alternatives are both broken: the technical name gives a
        // filter ISC can't resolve, and an explicit SELECTION is capped at 50
        // (SCOPE_SELECTION_MAX), which silently drops roles on any boundary
        // coarse enough to matter. So with no GUID no ROLE scope is written
        // at all, and the result says so — visibly incomplete beats quietly
        // wrong or quietly truncated.
        scopes = [boundaryFilterScope("ENTITLEMENT", metadataKey, boundaryValue)];
        if (valueGuid) {
          scopes.push(boundaryFilterScope("ROLE", metadataKey, valueGuid));
        } else {
          tagged.roleFilterUnresolved = true;
          console.warn(`[segments] no ROLE GUID for "${metadataKey}:${boundaryValue}" — no ROLE scope written; re-pick the value in ISC's segment editor to harvest it`);
        }
      } else {
        // Entitlements: SELECTION of the suggested set if there is one,
        // otherwise the same UNSEGMENTED default this route always used.
        // Roles: SELECTION of the suggested set if there is one, otherwise no
        // ROLE scope at all — same as a segment nobody's ever set an Access
        // Model role selection on. Both capped at ISC's SCOPE_SELECTION_MAX
        // — a coarse boundary like one
        // country can easily suggest more than 50 entitlements, and ISC
        // rejects the whole create rather than accepting the first 50 itself.
        entDropped = Math.max(0, suggestedEnts.length - SCOPE_SELECTION_MAX);
        roleDropped = Math.max(0, suggestedRoles.length - SCOPE_SELECTION_MAX);

        scopes = [
          suggestedEnts.length
            ? {
                scope: "ENTITLEMENT",
                visibility: "SELECTION",
                scopeFilter: null,
                scopeSelection: suggestedEnts.slice(0, SCOPE_SELECTION_MAX).map((e) => ({ type: "ENTITLEMENT", id: e.id })),
              }
            : { scope: "ENTITLEMENT", visibility: "UNSEGMENTED" },
        ];
        if (suggestedRoles.length) {
          scopes.push({
            scope: "ROLE",
            visibility: "SELECTION",
            scopeFilter: null,
            scopeSelection: suggestedRoles.slice(0, SCOPE_SELECTION_MAX).map((r) => ({ type: "ROLE", id: r.id })),
          });
        }
      }

      // The build criteria decide who is IN the segment (memberFilter). The
      // same criteria also go on the Access Model as an IDENTITY scope, so
      // the segment's members see the identities that match it — e.g. the
      // Germany segment's people see Germany's identities, not everyone —
      // alongside the entitlements and roles scoped above. One expression
      // builder for both, so they can never drift apart.
      const identityScope = {
        scope: "IDENTITY",
        visibility: "FILTER",
        scopeFilter: { expression: segmentAndExpression(leaves) },
        scopeSelection: [],
      };
      const createSegment = (withScopes) =>
        axios.post(
          `https://${tenantApiHost(tenant)}/v2026/data-segments`,
          {
            name: suggestion.name,
            description: suggestion.description,
            membership: "FILTER",
            memberFilter: { expression: segmentAndExpression(leaves) },
            enabled: false,
            published: false,
            scopes: withScopes,
          },
          { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...DATA_SEGMENTS_HEADERS } }
        );
      // IDENTITY is in ISC's scope enum, but data segmentation is still
      // experimental and what a tenant accepts has shifted before. If ISC
      // refuses the identity scope specifically (a 400), the segment is
      // still created without it — entitlements and roles fully scoped —
      // and the result says so, rather than the whole create failing.
      let resp;
      let identityScopeRejected = null;
      try {
        resp = await createSegment([...scopes, identityScope]);
      } catch (err) {
        if (err.response?.status !== 400) throw err;
        identityScopeRejected = err.response?.data?.messages?.[0]?.text || err.response?.data?.detailCode || "rejected by ISC";
        console.warn(`[segments] "${suggestion.name}": ISC refused the IDENTITY scope (${identityScopeRejected}) — creating without it`);
        resp = await createSegment(scopes);
      }
      results.push({
        id: suggestion.id, ok: true, segmentId: resp.data?.id, segmentName: resp.data?.name || suggestion.name,
        identityScope: identityScopeRejected ? { applied: false, reason: identityScopeRejected } : { applied: true },
        ...(entDropped || roleDropped ? { dropped: { entitlements: entDropped, roles: roleDropped } } : {}),
        ...(tagged ? { tagged } : {}),
      });
    } catch (err) {
      console.error(
        `[segments] scan create "${suggestion.name}" failed:`,
        err.config?.method?.toUpperCase(), err.config?.url, "->", err.response?.status,
        JSON.stringify(err.response?.data) || err.message
      );
      results.push({ id: suggestion.id, ok: false, error: describeError(err) });
    }
    // Counts attempts, not successes: the point is how far through the run
    // it is. results.length is the completed count regardless of the order
    // concurrent suggestions finish in. Failures are reported in full when
    // the run ends.
    await segmentCreateProgress.put(req.params.id, { done: results.length, total: chosen.length, startedAt: Date.now() });
  });
  await segmentCreateProgress.delete(req.params.id);

  const updatedSuggestions = (scan.suggestions || []).map((s) => {
    const result = results.find((r) => r.id === s.id);
    if (!result || !result.ok) return s;
    return { ...s, segmentCreated: { segmentId: result.segmentId, segmentName: result.segmentName, createdAt: new Date().toISOString() } };
  });
  await updateSegmentScan(scan.id, { suggestions: updatedSuggestions });

  res.json({ results });
});

// Best-effort match of a suggestion's existingSegmentName back to a real
// segment record — prefers the published one if there is one (whatever
// draft PATCHing should actually target is then resolved from THAT by
// getSegmentPatchTargetId below, same as everywhere else), otherwise any
// record with the name (necessarily a draft-only segment).
function findSegmentIdByName(allSegments, name) {
  const norm = (name || "").trim().toLowerCase();
  if (!norm) return null;
  const published = allSegments.find((s) => (s.name || "").trim().toLowerCase() === norm && s.published);
  if (published) return published.id;
  const any = allSegments.find((s) => (s.name || "").trim().toLowerCase() === norm);
  return any ? any.id : null;
}

// ISC hard-caps a data segment's scopes[].scopeSelection at 50 entries —
// verified live: PATCHing/POSTing past that 400s with detailCode
// "400.1.413 Field too large" and creates/changes nothing at all, which is
// exactly what was silently sinking every segment-scan "Create" for a
// coarse boundary (e.g. one country) with more than 50 matching
// entitlements. Every write path below caps to this instead of letting ISC
// reject the whole request, and reports how many were left out so the
// caller can tell the user rather than silently under-scoping the segment.
const SCOPE_SELECTION_MAX = 50;

/**
 * POST /api/insights/segment-scans/:id/add-to-existing
 * Body: { suggestionIds: string[] }
 * For a suggestion whose name already matches a real segment (nothing was
 * created for it — see existingSegmentName above), assigns that
 * suggestion's suggestedRoles/suggestedEntitlements to the EXISTING
 * segment via the Segments by Metadata tagging method ONLY (see
 * assignItemsToSegmentViaMetadata) — never a scopeSelection merge; a
 * non-metadata segment gets converted to the metadata FILTER pattern.
 * Continues past individual failures; each success is marked on the
 * persisted scan record.
 */
app.post("/api/insights/segment-scans/:id/add-to-existing", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const scan = segmentScanForSession(await segmentScans.get(req.params.id), session);
  if (!scan) return res.status(404).json({ error: "Data segment scan not found." });
  const { suggestionIds } = req.body || {};
  if (!Array.isArray(suggestionIds) || suggestionIds.length === 0) {
    return res.status(400).json({ error: "suggestionIds must be a non-empty array." });
  }
  const { tenant } = session;
  const chosen = (scan.suggestions || []).filter(
    (s) => suggestionIds.includes(s.id) && s.existingSegmentName && !s.addedToExisting &&
      ((s.suggestedRoles?.length || 0) > 0 || (s.suggestedEntitlements?.length || 0) > 0)
  );
  if (chosen.length === 0) {
    return res.status(400).json({ error: "Nothing to add — the selected suggestions have no existing data segment match, nothing suggested, or were already added." });
  }

  const results = [];
  for (const suggestion of chosen) {
    try {
      const token = await sessionToken(session);
      const allSegments = await fetchAllDataSegments(tenant, token);
      const matchId = findSegmentIdByName(allSegments, suggestion.existingSegmentName);
      if (!matchId) throw new Error(`Data segment "${suggestion.existingSegmentName}" not found.`);
      const original = allSegments.find((s) => s.id === matchId);

      const outcome = await assignItemsToSegmentViaMetadata(tenant, token, original, {
        roleIds: (suggestion.suggestedRoles || []).map((r) => r.id).filter(Boolean),
        entIds: (suggestion.suggestedEntitlements || []).map((e) => e.id).filter(Boolean),
      });
      results.push({
        id: suggestion.id, ok: true, segmentId: matchId, segmentName: suggestion.existingSegmentName,
        tagged: true, ...(outcome.converted ? { converted: true } : {}),
      });
    } catch (err) {
      console.error(`[segments] scan add-to-existing "${suggestion.existingSegmentName}" failed:`, err.response?.data || err.message);
      results.push({ id: suggestion.id, ok: false, error: describeError(err) });
    }
  }

  const updatedSuggestions = (scan.suggestions || []).map((s) => {
    const result = results.find((r) => r.id === s.id);
    if (!result || !result.ok) return s;
    return { ...s, addedToExisting: { segmentId: result.segmentId, segmentName: result.segmentName, addedAt: new Date().toISOString() } };
  });
  await updateSegmentScan(scan.id, { suggestions: updatedSuggestions });

  res.json({ results });
});

// ─── Assign Matching Roles to a Segment ────────────────────────────────────
// The association lives on the SEGMENT side: a segment's own `scopes` array
// carries one entry per object type (ENTITLEMENT, ROLE, ...) with a
// `visibility` (ALL/FILTER/SELECTION/UNSEGMENTED) and, when SELECTION, a
// `scopeSelection` list of the specific object refs chosen — this is what
// ISC's own UI calls setting a segment's Access Model to "Select Roles" /
// "Select Entitlements" (per direct product confirmation; the public API
// spec's scopetype.yaml only documents ENTITLEMENT/CERTIFICATION/IDENTITY/
// ENTITLEMENTREQUEST as of this writing — ROLE is real and used here
// despite that, since the spec for this experimental API is evidently
// incomplete). An earlier version of this feature instead PATCHed each
// role's own (undocumented, never-verified) `segments` field — replaced
// once the actual mechanism was confirmed.
//
// This feature proposes which existing roles look like they belong to a
// given segment (by comparing the segment's own memberFilter attribute=
// value pairs against each role's membership criteria, same leaf-
// extraction/exact-value-match approach runRoleScan already uses to detect
// a role that already covers a peer group) and lets the admin accept some
// or all before anything is written.

// Segment memberFilter counterpart to extractAllIdentityEqualsLeaves below —
// same {attrKey, value} output shape so the two can be compared directly.
// Walks past the "row" AND-wrapper nodes segmentRow() creates (see Build
// Segments / Segment scans above) to reach each EQUALS leaf.
function extractSegmentEqualsLeaves(expr, out = []) {
  if (!expr) return out;
  if (expr.operator === "EQUALS" && expr.attribute) {
    out.push({ attrKey: expr.attribute, value: expr.value?.value });
    return out;
  }
  for (const child of expr.children || []) extractSegmentEqualsLeaves(child, out);
  return out;
}

// Every role in the tenant, fully — /v2026/roles already returns each
// role's own membership.criteria inline (verified live: this is the same
// bulk fetch findRoleGapProposals' allRoleStubs uses), so no per-role
// detail fetch is needed.
/** Every access profile, paginated. Needed because a role references profiles
 *  by id only, and their entitlements live on the profile. */
async function fetchAllAccessProfiles(tenant, token) {
  const all = [];
  let offset = 0;
  const pageSize = 250;
  while (true) {
    const page = await withApiRetry(
      () => iscGet(tenant, token, "/v3/access-profiles", { limit: pageSize, offset }),
      { label: "segment-access: access-profiles page" }
    );
    if (!Array.isArray(page) || page.length === 0) break;
    all.push(...page);
    if (page.length < pageSize) break;
    offset += pageSize;
  }
  return all;
}

async function fetchAllRolesWithCriteria(tenant, token) {
  const all = [];
  let offset = 0;
  const pageSize = 250;
  while (true) {
    const page = await withApiRetry(
      () => iscGet(tenant, token, "/v2026/roles", { limit: pageSize, offset }),
      { label: "segment-role-match: roles page" }
    );
    if (!Array.isArray(page) || page.length === 0) break;
    all.push(...page);
    if (page.length < pageSize) break;
    offset += pageSize;
  }
  return all;
}

// A role "matches" a segment when EVERY one of the segment's own
// attribute=value pairs is also present among the role's own criteria
// leaves (subset match, not exact-set) — a role scoped to company=Acme AND
// division=Sales AND department=Finance still belongs under a segment for
// just company=Acme AND division=Sales, since the segment's boundary is
// coarser than the role's. On top of that, every role actually assigned to
// ANY identity matching the segment's criteria is included too, with no
// commonality requirement. A role already present in the segment's own
// ROLE-scope selection is excluded — nothing to suggest, it's already
// assigned. Entitlements are found the same way the Segments scan finds
// them (fetchAssignedEntitlementsForCriteria — a Search API query built
// directly from the segment's own criteria, since the segment's real
// members may not be individually enumerable any other way), with
// anything already in the segment's own ENTITLEMENT-scope selection
// excluded the same way roles are.
async function computeMatchingAccessForSegments(tenant, token, segments) {
  const allRoles = await fetchAllRolesWithCriteria(tenant, token);
  return mapWithConcurrency(segments, 4, async (segment) => {
    const criteria = extractSegmentEqualsLeaves(segment.memberFilter?.expression);
    const roleScope = (segment.scopes || []).find((s) => s.scope === "ROLE");
    const alreadySelectedRoles = new Set((roleScope?.scopeSelection || []).map((r) => r.id));
    const criteriaRoles = criteria.length === 0 ? [] : allRoles
      .filter((role) => {
        const roleLeaves = extractAllIdentityEqualsLeaves(role.membership?.criteria);
        if (roleLeaves.length === 0) return false;
        const roleSet = new Set(roleLeaves.map((l) => `${l.attrKey}=${l.value}`));
        return criteria.every((l) => roleSet.has(`${l.attrKey}=${l.value}`));
      })
      .map((role) => ({ id: role.id, name: role.name, enabled: role.enabled, dimensional: !!role.dimensional }));

    const entScope = (segment.scopes || []).find((s) => s.scope === "ENTITLEMENT");
    const alreadySelectedEnts = new Set((entScope?.scopeSelection || []).map((e) => e.id));
    let entitlementMatches = [];
    let assignedRoles = [];
    if (criteria.length > 0) {
      try {
        const found = await fetchAssignedAccessForCriteria(tenant, token, criteria);
        entitlementMatches = found.entitlements.filter((e) => !alreadySelectedEnts.has(e.id)).map((e) => ({ ...e, assigned: false }));
        assignedRoles = found.roles;
      } catch (err) {
        console.warn(`[insights] segment-role-match: access search failed for segment "${segment.name}":`, err.response?.status || err.message);
      }
    }
    // Criteria-matched roles plus every role any matching identity holds —
    // no commonality requirement, same as the Segments scan.
    const matches = mergeSegmentRoles(criteriaRoles, assignedRoles, allRoles)
      .filter((role) => !alreadySelectedRoles.has(role.id))
      .map((role) => ({ ...role, assigned: false }));

    return { segmentId: segment.id, segmentName: segment.name, criteria, matches, entitlementMatches };
  });
}

const segmentRoleMatches = createRecordStore(DATA_DIR, "segment-role-matches.json");

async function updateSegmentRoleMatch(matchId, patch) {
  await segmentRoleMatches.put(matchId, { ...(await segmentRoleMatches.get(matchId)), ...patch });
}

async function runSegmentRoleMatch(matchId, session) {
  const { tenant } = session;
  try {
    const token = await sessionToken(session);
    const record = await segmentRoleMatches.get(matchId);
    const allSegments = await fetchAllDataSegments(tenant, token);
    const targetSegments = allSegments.filter((s) => record.segmentIds.includes(s.id));
    const results = await computeMatchingAccessForSegments(tenant, token, targetSegments);
    await updateSegmentRoleMatch(matchId, { status: "completed", completedAt: new Date().toISOString(), results });
  } catch (err) {
    console.error(`[insights] segment-role-match ${matchId} failed:`, err.response?.data || err.message);
    await updateSegmentRoleMatch(matchId, { status: "failed", completedAt: new Date().toISOString(), error: describeError(err) });
  }
}

/**
 * POST /api/insights/segment-role-matches
 * Header: x-sp-session
 * Body: { segmentIds: string[] }
 * Starts an asynchronous scan proposing which existing roles AND
 * entitlements look like they belong to each of the given segments.
 * Returns immediately with a match ID — poll
 * GET /api/insights/segment-role-matches/:id for progress and the
 * resulting per-segment suggestions (matches for roles, entitlementMatches
 * for entitlements). Nothing is written until the admin accepts specific
 * suggestions via POST .../assign below.
 */
app.post("/api/insights/segment-role-matches", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  const { segmentIds } = req.body || {};
  if (!Array.isArray(segmentIds) || segmentIds.length === 0) {
    return res.status(400).json({ error: "segmentIds must be a non-empty array." });
  }

  const matchId = `segrolematch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await updateSegmentRoleMatch(matchId, {
    id: matchId,
    tenant,
    status: "running",
    startedAt: new Date().toISOString(),
    completedAt: null,
    segmentIds,
    results: [],
    error: null,
  });

  runSegmentRoleMatch(matchId, session);

  res.status(202).json({ matchId });
});

function segmentRoleMatchForSession(record, session) {
  return record && record.tenant === session.tenant ? record : null;
}

/** GET /api/insights/segment-role-matches/:id — full record including per-segment suggestions */
app.get("/api/insights/segment-role-matches/:id", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const record = segmentRoleMatchForSession(await segmentRoleMatches.get(req.params.id), session);
  if (!record) return res.status(404).json({ error: "Data segment/role match run not found." });
  res.json(record);
});

/**
 * POST /api/insights/segment-role-matches/:id/assign
 * Body: { items: [{ segmentId, roleId }, ...] }
 * Assigns each selected role/entitlement to its matched segment via the
 * Segments by Metadata tagging method ONLY (see
 * assignItemsToSegmentViaMetadata) — items are never written into the
 * segment's scopeSelection; a non-metadata segment gets converted to the
 * metadata FILTER pattern first. Batched per segment; continues past
 * individual segment failures; each successful item is marked on the
 * persisted match record so reopening it shows what's already assigned.
 */
app.post("/api/insights/segment-role-matches/:id/assign", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const record = segmentRoleMatchForSession(await segmentRoleMatches.get(req.params.id), session);
  if (!record) return res.status(404).json({ error: "Data segment/role match run not found." });
  const { items } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "items must be a non-empty array." });
  }
  const { tenant } = session;

  // type defaults to ROLE — items shaped { segmentId, roleId } (pre-
  // entitlements client) still work unchanged.
  const bySegment = new Map();
  for (const item of items) {
    const segmentId = item.segmentId;
    const type = item.type === "ENTITLEMENT" ? "ENTITLEMENT" : "ROLE";
    const itemId = item.id ?? item.roleId;
    if (!bySegment.has(segmentId)) bySegment.set(segmentId, { roleIds: [], entIds: [] });
    const bucket = bySegment.get(segmentId);
    (type === "ENTITLEMENT" ? bucket.entIds : bucket.roleIds).push(itemId);
  }

  const results = [];
  for (const [segmentId, { roleIds, entIds }] of bySegment) {
    try {
      const token = await sessionToken(session);

      // The segment is inspected on the ORIGINAL record, before any draft
      // dance — assignItemsToSegmentViaMetadata only creates a draft when
      // it has to convert a non-metadata segment.
      const preAll = await fetchAllDataSegments(tenant, token);
      const original = preAll.find((s) => s.id === segmentId);
      if (!original) throw new Error("Data segment not found.");
      const outcome = await assignItemsToSegmentViaMetadata(tenant, token, original, { roleIds, entIds });
      for (const roleId of roleIds) results.push({ segmentId, type: "ROLE", id: roleId, ok: true, tagged: true, ...(outcome.converted ? { converted: true } : {}) });
      for (const entId of entIds) results.push({ segmentId, type: "ENTITLEMENT", id: entId, ok: true, tagged: true, ...(outcome.converted ? { converted: true } : {}) });
    } catch (err) {
      console.error(`[insights] segment-role-match assign segment ${segmentId} failed:`, err.response?.data || err.message);
      const message = describeError(err);
      for (const roleId of roleIds) results.push({ segmentId, type: "ROLE", id: roleId, ok: false, error: message });
      for (const entId of entIds) results.push({ segmentId, type: "ENTITLEMENT", id: entId, ok: false, error: message });
    }
  }

  const updatedResults = (record.results || []).map((seg) => ({
    ...seg,
    matches: seg.matches.map((m) => {
      const result = results.find((r) => r.segmentId === seg.segmentId && r.type === "ROLE" && r.id === m.id);
      return result?.ok ? { ...m, assigned: true } : m;
    }),
    entitlementMatches: (seg.entitlementMatches || []).map((m) => {
      const result = results.find((r) => r.segmentId === seg.segmentId && r.type === "ENTITLEMENT" && r.id === m.id);
      return result?.ok ? { ...m, assigned: true } : m;
    }),
  }));
  await updateSegmentRoleMatch(record.id, { results: updatedResults });

  res.json({ results });
});

// ─── Evaluate this Role (AI) ──────────────────────────────────────────────────
// Compares a role's granted entitlements against what its actual current
// members hold today, then asks Claude to assess which of the role's
// entitlements look stale (few/no current members still have them) and
// which commonly-held entitlements look like they should be added.
//
// /v2026/public-identities doesn't accept filters on custom attributes
// (verified live: "attributes.department eq ..." and "attribute.department
// eq ..." are both rejected as non-queryable) — the same constraint that's
// why runRoleScan/scoreSchemaAttributes already page through every active
// identity and filter in memory rather than server-side. This does the
// same: evaluates the role's own membership criteria tree against each
// active identity in memory, since there's no other way to ask ISC "who
// matches this role" directly.

const ROLE_EVAL_OPERATION_TEST = {
  EQUALS: (attrValue, leafValue) => attrValue === leafValue,
  NOT_EQUALS: (attrValue, leafValue) => attrValue !== leafValue,
  CONTAINS: (attrValue, leafValue) => typeof attrValue === "string" && attrValue.includes(leafValue),
  DOES_NOT_CONTAIN: (attrValue, leafValue) => !(typeof attrValue === "string" && attrValue.includes(leafValue)),
};

/**
 * Evaluates a membership criteria node against one identity's attributes.
 * Returns a boolean, or null if the tree uses something this can't evaluate
 * (an ACCOUNT-scoped condition, or an operation not in the map above) — the
 * caller treats null as "give up on membership evaluation for this role"
 * rather than silently guessing.
 */
function identityMatchesCriteria(node, attrs) {
  if (!node) return true;
  const children = (node.children || []).filter(Boolean);
  if (node.operation === "AND") {
    if (children.length === 0) return true;
    const results = children.map((c) => identityMatchesCriteria(c, attrs));
    if (results.some((r) => r === null)) return null;
    return results.every(Boolean);
  }
  if (node.operation === "OR") {
    if (children.length === 0) return true;
    const results = children.map((c) => identityMatchesCriteria(c, attrs));
    if (results.every((r) => r === false)) return false;
    if (results.some((r) => r === true)) return true;
    return null; // mixed false/null with no true — can't be sure
  }
  if (node.key?.type !== "IDENTITY" || !node.key.property?.startsWith("attribute.")) return null;
  const test = ROLE_EVAL_OPERATION_TEST[node.operation];
  if (!test) return null;
  const attrKey = node.key.property.slice("attribute.".length);
  const attrValue = attrs[attrKey];
  const leafValues = Array.isArray(node.values) && node.values.length ? node.values : [node.stringValue];
  return leafValues.some((v) => test(attrValue, v));
}

const ROLE_EVAL_IDENTITY_PAGE_SIZE = 250;
const ROLE_EVAL_MAX_MATCHES = 150; // bound cost/time on a large tenant
const ROLE_EVAL_MAX_SCANNED = 3000; // give up looking for matches past this many identities
const ROLE_EVAL_ENTITLEMENT_CONCURRENCY = 8;
// Below this many members, "held by X% of members" is noise rather than a
// real signal — verified live: a role with exactly 1 member ("SOD Test")
// had every single one of that member's OWN unrelated entitlements flagged
// as "commonly held but not granted" (100% of 1 = always >= threshold),
// and the set flip-flopped every run as that one person's unrelated access
// happened to change in this tenant's own background data churn. Below
// this threshold, commonly-held/rarely-held comparisons are skipped
// entirely rather than computed from a sample too small to mean anything.
const ROLE_EVAL_MIN_MEMBERS_FOR_COMMONALITY = 3;

// Unlike findRoleMembers below (bounded to ROLE_EVAL_MAX_MATCHES — a
// sample, good enough for evaluation's own purposes), the Members tab needs
// the actual full list, paginated and searchable, so it scans a much
// higher ceiling before giving up on a huge tenant.
const ROLE_MEMBERS_MAX_SCANNED = 20000;

/**
 * Evaluates a role's membership rule against every active identity, live —
 * this is the "who actually belongs to this role" ISC's own criteria
 * defines, independent of whatever its search index currently has recorded
 * (see the /rule-members route this backs). Falls back to the role's own
 * IDENTITY_LIST (membership.identities) when it has no criteria at all,
 * same convention findRoleMembers uses. `query` is a case-insensitive
 * name-contains filter applied after evaluating (there's no way to push it
 * into the criteria scan itself), and total/members are the query-filtered,
 * pre-pagination count and the requested page respectively.
 */
async function evaluateRoleMembershipMembers(tenant, token, membership, { query, limit = 50, offset = 0 } = {}) {
  const matchesQuery = (name) => !query || (name || "").toLowerCase().includes(query.toLowerCase());

  if (!membership?.criteria) {
    const list = (membership?.identities || []).filter((i) => matchesQuery(i.name));
    list.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    return { total: list.length, members: list.slice(offset, offset + limit) };
  }

  // Paginated via searchAfter against the Search API (not offset against
  // /v2026/identities) — offset pagination hard-fails once offset+limit
  // passes 10,000 (verified live elsewhere in this app), which scanning up
  // to ROLE_MEMBERS_MAX_SCANNED identities on a large tenant would hit.
  // Search's identity documents carry `attributes` as the same plain
  // key-value map /v2026/identities does, so identityMatchesCriteria works
  // unchanged; only the id/name/email field NAMES differ (see
  // searchAllIdentities's own notes on that) — displayName/jobTitle/
  // department/email are all read straight off `attributes` here too.
  const matches = [];
  let scanned = 0;
  let searchAfter = null;
  while (scanned < ROLE_MEMBERS_MAX_SCANNED) {
    const body = { indices: ["identities"], query: { query: "*" }, sort: ["id"] };
    if (searchAfter) body.searchAfter = searchAfter;
    // Retried like every other multi-page ISC scan in this app — a scan
    // this size is 40+ sequential calls, and with no retry a single
    // transient 429/5xx anywhere in that chain used to fail the whole
    // Members tab outright (verified live: real 429s do occur on this
    // tenant under load) instead of just slowing down that one page.
    const resp = await withApiRetry(
      () => axios.post(
        `https://${tenantApiHost(tenant)}/v2026/search`,
        body,
        { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, params: { limit: ROLE_EVAL_IDENTITY_PAGE_SIZE } }
      ),
      { label: "role/dimension members scan" }
    );
    const page = resp.data || [];
    if (page.length === 0) break;
    for (const idn of page) {
      const attrs = idn.attributes || {};
      if (attrs.identityState !== "ACTIVE") continue;
      if (identityMatchesCriteria(membership.criteria, attrs)) {
        matches.push({
          id: idn.id,
          name: idn.name,
          displayName: attrs.displayName || idn.displayName || idn.name,
          email: idn.email || attrs.email || null,
          attributes: { jobTitle: attrs.jobTitle || null, department: attrs.department || null },
        });
      }
    }
    scanned += page.length;
    if (page.length < ROLE_EVAL_IDENTITY_PAGE_SIZE) break;
    searchAfter = [page[page.length - 1].id];
  }

  // matchesQuery/sort use displayName, not Search's own top-level `name`
  // (that's the USERNAME — see searchAllIdentities's own notes on this
  // exact mixup) — searching/sorting by username instead of a person's
  // actual name would silently misbehave (wrong sort order, "search by
  // name" not matching a typed display name) even though it wouldn't
  // throw.
  const filtered = matches
    .filter((m) => matchesQuery(m.displayName))
    .sort((a, b) => (a.displayName || "").localeCompare(b.displayName || ""));
  return { total: filtered.length, members: filtered.slice(offset, offset + limit) };
}

/**
 * Pages through /v2026/identities up to ROLE_EVAL_MAX_SCANNED once, kept
 * on `cache` (a plain {} the caller owns) so many findRoleMembers calls
 * against the SAME underlying population — every role and dimension in one
 * batch Role Evaluation scan all draw from the same active-identity set —
 * share this one paged fetch instead of each re-paging from scratch.
 * cache.promise memoizes the in-flight/completed fetch so concurrent
 * callers (the batch scan's bounded-concurrency role loop) await the same
 * result rather than firing duplicate page requests.
 */
async function fetchActiveIdentityPopulation(tenant, token, cache) {
  if (cache.promise) return cache.promise;
  cache.promise = (async () => {
    const identities = [];
    let offset = 0;
    let totalScanned = 0;
    while (totalScanned < ROLE_EVAL_MAX_SCANNED) {
      const page = await withApiRetry(
        () => iscGet(tenant, token, "/v2026/identities", {
          limit: ROLE_EVAL_IDENTITY_PAGE_SIZE,
          offset,
          sorters: "name",
        }),
        { label: "fetchActiveIdentityPopulation: identities page" }
      );
      if (page.length === 0) break;
      for (const idn of page) {
        if (idn.attributes?.identityState === "ACTIVE") identities.push(idn);
      }
      totalScanned += page.length;
      offset += page.length;
      if (page.length < ROLE_EVAL_IDENTITY_PAGE_SIZE) break;
    }
    return { identities, totalScanned };
  })();
  return cache.promise;
}

/**
 * Finds up to ROLE_EVAL_MAX_MATCHES active identities matching a role's
 * membership criteria. When captureAttrKey is given, each match also
 * carries that attribute's value (attrValue) — used to group a dynamic
 * role's base-eligible population by its dimension-splitting attribute
 * without a second identity scan.
 *
 * populationCache (optional): when given, the active-identity population
 * is fetched once (see fetchActiveIdentityPopulation) and shared across
 * every call sharing the same cache object, instead of each call paging
 * the API independently — only worth the upfront cost of scanning the
 * WHOLE population when it'll actually be reused many times (a batch
 * scan's many roles/dimensions), not for a single one-off evaluation,
 * where an early exit once ROLE_EVAL_MAX_MATCHES is reached is often
 * cheaper. Omitted by every caller except runRoleEvalScan for that reason.
 */
async function findRoleMembers(tenant, token, membership, captureAttrKeys, populationCache) {
  const captureKeys = Array.isArray(captureAttrKeys) ? captureAttrKeys : captureAttrKeys ? [captureAttrKeys] : [];
  // Prefer the membership rule (criteria) when the role has one — it's the
  // live, authoritative definition of who belongs. Only fall back to the
  // explicitly-assigned identities list (IDENTITY_LIST membership) when no
  // rule exists at all.
  if (!membership?.criteria) {
    if (membership?.identities?.length) {
      return { supported: true, matches: membership.identities.slice(0, ROLE_EVAL_MAX_MATCHES), totalScanned: membership.identities.length };
    }
    return { supported: false };
  }

  if (populationCache) {
    const { identities, totalScanned } = await fetchActiveIdentityPopulation(tenant, token, populationCache);
    const matches = [];
    let sawUnsupported = false;
    for (const idn of identities) {
      const attrs = idn.attributes || {};
      const result = identityMatchesCriteria(membership.criteria, attrs);
      if (result === null) sawUnsupported = true;
      else if (result) {
        matches.push({
          id: idn.id,
          name: idn.name,
          ...(captureKeys.length ? { attrValues: Object.fromEntries(captureKeys.map((k) => [k, attrs[k]])) } : {}),
        });
      }
      if (matches.length >= ROLE_EVAL_MAX_MATCHES) break;
    }
    if (sawUnsupported && matches.length === 0) return { supported: false };
    return { supported: true, matches, totalScanned, partial: sawUnsupported };
  }

  const matches = [];
  let offset = 0;
  let totalScanned = 0;
  let sawUnsupported = false;
  while (totalScanned < ROLE_EVAL_MAX_SCANNED && matches.length < ROLE_EVAL_MAX_MATCHES) {
    // Uses /v2026/identities, not /v2026/public-identities — verified live
    // that public-identities only ever carries 5 fixed attributes (manager,
    // jobTitle, department, country, location) and NEVER cloudLifecycleState,
    // so any membership criteria referencing an attribute outside that set
    // (very common — most roles in this tenant key off cloudLifecycleState)
    // would silently evaluate to "no matches" instead of the real population.
    // /v2026/identities carries the identity's full attributes map.
    // sorters is required here, not cosmetic — without it, pagination order
    // isn't guaranteed stable between calls. For a role whose population
    // exceeds ROLE_EVAL_MAX_MATCHES, this scan stops as soon as it fills
    // that cap, so an unstable order means a DIFFERENT partial sample of
    // members gets used to compute "commonly held" each run — a second,
    // separate source of flip-flopping beyond small-sample noise (see
    // ROLE_EVAL_MIN_MEMBERS_FOR_COMMONALITY above).
    const page = await withApiRetry(
      () => iscGet(tenant, token, "/v2026/identities", {
        limit: ROLE_EVAL_IDENTITY_PAGE_SIZE,
        offset,
        // "id" isn't a sortable field on this endpoint (verified live: 400
        // "semantically invalid") — "name" is.
        sorters: "name",
      }),
      { label: "findRoleMembers: identities page" }
    );
    if (page.length === 0) break;
    for (const idn of page.filter((i) => i.attributes?.identityState === "ACTIVE")) {
      const attrs = idn.attributes || {};
      const result = identityMatchesCriteria(membership.criteria, attrs);
      if (result === null) sawUnsupported = true;
      else if (result) {
        matches.push({
          id: idn.id,
          name: idn.name,
          ...(captureKeys.length ? { attrValues: Object.fromEntries(captureKeys.map((k) => [k, attrs[k]])) } : {}),
        });
      }
      if (matches.length >= ROLE_EVAL_MAX_MATCHES) break;
    }
    totalScanned += page.length;
    offset += page.length;
    if (page.length < ROLE_EVAL_IDENTITY_PAGE_SIZE) break;
  }
  // Only bail entirely if evaluation never once resolved cleanly — a mix of
  // matches and unsupported reads is still a useful (if partial) sample.
  if (sawUnsupported && matches.length === 0) return { supported: false };
  return { supported: true, matches, totalScanned, partial: sawUnsupported };
}

/**
 * Unwraps a dimension's membership.criteria down to its one distinguishing
 * leaf — verified live (Corporate Users' dimensions) that each dimension's
 * criteria is a chain of single-child AND wrappers around one
 * EQUALS(attribute.X, value) leaf. Returns { attrKey, value } or null if
 * the shape doesn't match (multiple leaves, non-EQUALS, non-IDENTITY, etc),
 * in which case this dimension is excluded from missing-dimension detection
 * rather than guessed at.
 */
function extractSingleAttributeCriterion(node) {
  if (!node) return null;
  if (node.operation === "AND") {
    const children = (node.children || []).filter(Boolean);
    if (children.length !== 1) return null;
    return extractSingleAttributeCriterion(children[0]);
  }
  if (node.operation !== "EQUALS") return null;
  if (node.key?.type !== "IDENTITY" || !node.key.property?.startsWith("attribute.")) return null;
  const value = Array.isArray(node.values) && node.values.length ? node.values[0] : node.stringValue;
  if (!value) return null;
  return { attrKey: node.key.property.slice("attribute.".length), value };
}

/**
 * Walks a full membership criteria tree (any mix of AND/OR/nesting) and
 * collects every EQUALS(attribute.X, value) leaf, ignoring the tree's
 * boolean structure — used to detect "does an existing role already cover
 * this exact attribute combination", not to actually evaluate the rule.
 * Status/lifecycle leaves (cloudLifecycleState etc.) are excluded since
 * every generated role's criteria always includes one and it doesn't
 * distinguish anything. Verified live against real auto-generated peer-group
 * roles in this tenant — their criteria is exactly OR->AND->[cloudLifecycleState,
 * department] EQUALS leaves, values as arrays.
 */
function extractAllIdentityEqualsLeaves(node, out = []) {
  if (!node) return out;
  if (node.children?.length) {
    for (const child of node.children) extractAllIdentityEqualsLeaves(child, out);
    return out;
  }
  if (node.operation !== "EQUALS") return out;
  if (node.key?.type !== "IDENTITY" || !node.key.property?.startsWith("attribute.")) return out;
  const attrKey = node.key.property.slice("attribute.".length);
  if (PEER_GROUP_STATUS_ATTRIBUTE_KEYS.has(attrKey)) return out;
  const value = Array.isArray(node.values) && node.values.length ? node.values[0] : node.stringValue;
  if (value) out.push({ attrKey, value });
  return out;
}

/** Canonical, order-independent key for a set of {attrKey, value} pairs, for exact-set comparison. */
function criteriaSetKey(leaves) {
  return leaves
    .map((l) => `${l.attrKey}=${l.value}`)
    .sort()
    .join("|");
}

/**
 * Checks each of a role's own entitlements still resolves in ISC — verified
 * live that fetching a deleted/bogus entitlement id 404s (GET /v2026/entitlements/:id
 * against a made-up id returns 404 "did not find a current representation"),
 * so a 404 here means the entitlement itself no longer exists in the source
 * and the role is holding a dangling reference to it.
 */
async function findUnavailableEntitlements(tenant, token, roleEntitlements) {
  if (!roleEntitlements?.length) return [];
  // Batched like filterExistingEntitlements, and fail-open in the same
  // direction: a batch that errors counts as present, so an inconclusive
  // lookup never flags a live entitlement as dangling.
  const alive = await existingEntitlementIds(tenant, token, roleEntitlements.map((e) => e.id));
  return roleEntitlements.filter((e) => !alive.has(e.id)).map((e) => ({ id: e.id, name: e.name }));
}

const ROLE_EVAL_DIMENSION_CONCURRENCY = 2; // bound cost — each dimension does its own identity scan

// A batch Role Evaluation scan used to evaluate roles strictly one at a
// time — kept modest here rather than matching ROLE_EVAL_ENTITLEMENT_
// CONCURRENCY (8) because each role already fans out its own internal
// concurrency (dimensions, per-member entitlement fetches), so a handful
// of roles in flight at once already multiplies real request concurrency
// well past this number. Tune down if this causes more 429s than it saves
// in wall-clock time on a given tenant's rate limit.
const ROLE_EVAL_SCAN_CONCURRENCY = 3;

/**
 * For one dimension of a dynamic role: finds the identities matching the
 * dimension's own membership rule, then flags entitlements most of those
 * members hold that the dimension does NOT grant — the same
 * commonly-held-but-missing check used for the base role, scoped to the
 * dimension's own membership and entitlement set. roleEntIds (the base
 * role's own granted entitlements) are excluded from candidates too — a
 * dimensional role's members already get everything the base role grants
 * regardless of dimension, so suggesting those again is redundant.
 */
async function evaluateDimensionEntitlements(
  tenant, token, dimension, roleEntIds, commonRoleEntIds = new Set(), commonalityThreshold = ROLE_SCAN_COMMON_THRESHOLD,
  baseMemberIds = null, baseAddCandidateIds = new Set(), precomputed = null, populationCache = null
) {
  const dimEntitlements = dimension.entitlements || [];

  // A dimension that grants something the base role already grants is pure
  // redundancy — every member of the role gets the base role's entitlements
  // regardless of dimension, so re-granting one on a dimension does nothing
  // but add noise. This is a static comparison of the two entitlement lists,
  // independent of membership data, so it's computed up front and included
  // even when the membership scan below can't run.
  const removeCandidates = [
    ...dimEntitlements
      .filter((e) => roleEntIds.has(e.id))
      .map((e) => ({
        entitlementId: e.id,
        entitlement: e.name,
        reason: "Already granted by the base role — redundant on this dimension.",
      })),
    // Same redundancy idea, against common-access entitlements instead of
    // the base role — every relevant member already gets these regardless
    // of dimension.
    ...dimEntitlements
      .filter((e) => !roleEntIds.has(e.id) && commonRoleEntIds.has(e.id))
      .map((e) => ({
        entitlementId: e.id,
        entitlement: e.name,
        reason: "Already granted automatically by a common-access role — redundant here.",
      })),
  ];

  let dimensionMatches, entitlementLists, totalScanned, partial;

  if (precomputed) {
    // The caller (evaluateRoleAlgorithmic) already scanned this exact
    // population — every one of these members is a base-role member who
    // also matches this dimension's own attrKey=value, with entitlements
    // already fetched during that same base scan. Reusing it instead of
    // repeating an independent findRoleMembers scan + per-member
    // entitlement fetch cuts a role with N dimensions from N+1 full
    // membership scans down to 1 (see the caller for when this is safe to
    // use — only when the base sample wasn't itself capped).
    ({ matches: dimensionMatches, entitlementLists, totalScanned, partial } = precomputed);
    if (dimensionMatches.length === 0) {
      return { dimensionId: dimension.id, dimensionName: dimension.name, memberProfile: null, addCandidates: [], removeCandidates };
    }
  } else {
    const membershipResult = await findRoleMembers(tenant, token, dimension.membership, null, populationCache);

    if (!membershipResult.supported || membershipResult.matches.length === 0) {
      return { dimensionId: dimension.id, dimensionName: dimension.name, memberProfile: null, addCandidates: [], removeCandidates };
    }

    // A dimension's own membership criteria only ever encodes the one
    // attribute it varies by (e.g. jobTitle = "Payroll Analyst I") — it says
    // nothing about the base role's own criteria (e.g. department =
    // "Accounting"), because create-role only ever writes a single-attribute
    // rule per dimension. Matching against the dimension's criteria alone
    // therefore pulls in every identity tenant-wide with that job title,
    // not just the ones who actually have this role in the first place —
    // verified live (an "Payroll Analyst I" dimension scoped under an
    // Accounting-only role otherwise matched Payroll Analysts in every
    // department). Real dimension access only applies to identities who
    // qualify for the base role AND match the dimension, so intersect with
    // the base role's own membership when it's known.
    dimensionMatches = baseMemberIds
      ? membershipResult.matches.filter((m) => baseMemberIds.has(m.id))
      : membershipResult.matches;
    if (dimensionMatches.length === 0) {
      return { dimensionId: dimension.id, dimensionName: dimension.name, memberProfile: null, addCandidates: [], removeCandidates };
    }

    // A member whose entitlement fetch fails this call is silently treated as
    // holding nothing at all — one flaky fetch out of many can flip an
    // entitlement sitting right at the commonality threshold (e.g. 4 of 5
    // members = 80%, one dropped fetch = 3 of 5 = 60%) in or out of the
    // results, with nothing distinguishing that from a real change in who
    // holds it. Retried before giving up, to make that flip-flopping rarer —
    // not eliminated, since a member can still genuinely have zero access.
    entitlementLists = await mapWithConcurrency(
      dimensionMatches, ROLE_EVAL_ENTITLEMENT_CONCURRENCY,
      async (m) => {
        try {
          return await withApiRetry(
            () => iscGet(tenant, token, `/v2026/entitlements/identities/${m.id}/entitlements`, { limit: 100 }),
            { label: `dimension ${dimension.id}: fetch entitlements for identity ${m.id}` }
          );
        } catch {
          return [];
        }
      }
    );
    totalScanned = membershipResult.totalScanned;
    partial = !!membershipResult.partial;
  }
  const memberCount = dimensionMatches.length;
  const dimEntIds = new Set(dimEntitlements.map((e) => e.id));

  // Same algorithm Draft creation uses for a dimension's own entitlements
  // (buildPeerGroups' dimensionPreview, see commonlyHeldEntitlementIds) —
  // a percentage of members (the tenant's entitlementCommonalityThreshold,
  // same bar the base role uses), computed only from members holding more
  // than one entitlement: exactly one is excluded (a test/service
  // account's one trivial entitlement doesn't get to look "commonly held"
  // just because a small dimension makes the percentage math forgiving),
  // and zero is excluded too (an unprovisioned new hire isn't evidence
  // against commonality, just not there yet — explicit user instruction).
  // Deliberately shared with Draft creation instead of the previous
  // raw-occurrence-count approach, so a role's dimensions agree with what
  // created them in the first place — explicit user request, aware this
  // trades away the raw count's small-sample protection (a 1-member
  // dimension's own entitlement now reads as "100% commonly held," same
  // as the base role does).
  const memberEntitlementObjs = dimensionMatches.map((m, i) => ({ entitlements: entitlementLists[i] || [] }));
  const eligibleForProposal = memberEntitlementObjs.filter((m) => m.entitlements.length > 1);
  const commonEntIds = commonlyHeldEntitlementIds(eligibleForProposal, commonalityThreshold);
  const nameAndCountById = new Map();
  for (const list of entitlementLists) {
    for (const e of list) {
      const entry = nameAndCountById.get(e.id) || { name: e.name, count: 0 };
      entry.count += 1;
      nameAndCountById.set(e.id, entry);
    }
  }
  const commonlyHeldNotGranted = [...commonEntIds]
    .filter((entId) =>
      !dimEntIds.has(entId) && !roleEntIds.has(entId) && !commonRoleEntIds.has(entId) &&
      !baseAddCandidateIds.has(entId)
    )
    .map((entId) => ({ id: entId, ...nameAndCountById.get(entId) }));

  return {
    dimensionId: dimension.id,
    dimensionName: dimension.name,
    memberProfile: {
      memberCount,
      totalScanned,
      partial,
    },
    addCandidates: commonlyHeldNotGranted.map((e) => ({
      entitlementId: e.id,
      entitlement: e.name,
      reason: `Held by ${e.count} of ${memberCount} current members of this dimension (>=${Math.round(commonalityThreshold * 100)}%) but not granted by it.`,
    })),
    removeCandidates,
  };
}

/**
 * Runs the full algorithmic role evaluation (member-comparison,
 * entitlement-availability, dimension gap/missing-dimension detection) for
 * one role. Shared by the single-role POST /api/roles/:id/evaluate route
 * and the bulk Role Evaluation scan below, so the two can never drift.
 */
/**
 * Fetches every CONFLICTING_ACCESS_BASED SOD policy (list-A-vs-list-B
 * entitlement conflicts) — the only policy type checkable against a role's
 * static entitlement set. GENERAL policies use an arbitrary search query
 * evaluated per-identity (account state, lifecycle, etc.) and can't be
 * meaningfully tested against a role definition alone, so they're excluded.
 * 250 is comfortably above any tenant's real policy count seen so far
 * (verified live: 16 policies, 5 of them CONFLICTING_ACCESS_BASED).
 */
async function fetchConflictingAccessSodPolicies(tenant, token) {
  const policies = await withApiRetry(() => iscGet(tenant, token, "/v2026/sod-policies", { limit: 250 }), { label: "fetchConflictingAccessSodPolicies: sod-policies" });
  return (policies || []).filter((p) => p.type === "CONFLICTING_ACCESS_BASED" && p.conflictingAccessCriteria);
}

/**
 * Every entitlement granted by a confirmed common-access role (base role
 * entitlements, plus every dimension's own if it's a dynamic role) —
 * "common access" here is ISC's own designation (Admin > Access Model >
 * Roles > "Common Access" checkbox), not something this app infers. These
 * are birthright entitlements every relevant member already gets regardless
 * of which peer group or role-specific access they're being evaluated for,
 * so surfacing them again as a "commonly held but not granted" suggestion
 * is just noise. Uses the beta common-access API (requires the
 * X-SailPoint-Experimental header — iscGet doesn't support custom headers,
 * hence the separate axios call here) — verified live that GET returns
 * {access:{id,type},status,...} rows and this tenant only ever has a
 * handful, so one page (limit 250) is always enough.
 */
// Every role this tenant's own Role Scan / Skeleton scan records already
// know was CREATED as a Common Access proposal (isCommonAccessScope /
// isCommonAccess groups/results with a real roleCreated/roleId) — a third,
// fully local source alongside the CONFIRMED list and flaggedCommonAccessRoles
// below. Covers the case flaggedCommonAccessRoles can't: if the
// flagRoleAsCommonAccess POST itself failed (network blip, tenant doesn't
// support the beta API, etc.) after the role was already created, the role
// exists as a real birthright-access role but was never recorded as
// "successfully flagged." The scan/skeleton record still shows it was
// intended and created as Common Access, so it counts here regardless of
// whether the ISC-side flag ever succeeded.
async function getPersistedCommonAccessRoleIds(tenant) {
  const ids = new Set();
  for (const scan of Object.values(await roleScans.all())) {
    if (scan.tenant !== tenant) continue;
    for (const g of scan.groups || []) {
      if (g.isCommonAccessScope && g.roleCreated?.id) ids.add(g.roleCreated.id);
    }
  }
  for (const scan of Object.values(await skeletonScans.all())) {
    if (scan.tenant !== tenant) continue;
    for (const r of scan.results || []) {
      if (r.isCommonAccess && r.ok && r.roleId) ids.add(r.roleId);
    }
  }
  return ids;
}

// Same leaf-extraction extractAllIdentityEqualsLeaves does, but WITHOUT
// dropping cloudLifecycleState-type leaves — that filter makes sense there
// (detecting duplicate peer-group roles, where lifecycleState is assumed
// universal and non-distinguishing) but would be wrong here: a role like
// "All Active Users" whose only real constraint IS cloudLifecycleState=active
// needs that leaf represented, or every applicability check against it would
// see an empty criteria set instead of "matches every active identity."
function extractAllCriteriaLeaves(node, out = []) {
  if (!node) return out;
  if (node.children?.length) {
    for (const child of node.children) extractAllCriteriaLeaves(child, out);
    return out;
  }
  if (node.operation !== "EQUALS") return out;
  if (node.key?.type !== "IDENTITY" || !node.key.property?.startsWith("attribute.")) return out;
  const attrKey = node.key.property.slice("attribute.".length);
  const value = Array.isArray(node.values) && node.values.length ? node.values[0] : node.stringValue;
  if (value) out.push({ attrKey, value });
  return out;
}

/**
 * True when every constraint `subLeaves` imposes also appears in
 * `superLeaves` (same attrKey AND value) — meaning anyone matching
 * `superLeaves` necessarily also matches `subLeaves` — i.e. `superLeaves`
 * describes a population that's a SUBSET of (or equal to) `subLeaves`'s
 * population. An empty `subLeaves` can't be confirmed to apply to anything
 * (no way to tell "matches everyone" from "criteria this app can't parse"
 * apart), so it's treated as not applicable rather than guessed at.
 */
function criteriaLeavesSubsetOf(subLeaves, superLeaves) {
  if (subLeaves.length === 0) return false;
  const superSet = new Set(superLeaves.map((l) => `${l.attrKey}=${l.value}`));
  return subLeaves.every((l) => superSet.has(`${l.attrKey}=${l.value}`));
}

/**
 * Fetches every common-access role's own membership criteria (as leaves)
 * and granted entitlements (base + every dimension's own) — the raw
 * material criteriaLeavesSubsetOf-based matching is built from. Both Role
 * Scan (per-partition, against that partition's own scope) and Role
 * Evaluation's filterApplicableCommonAccessEntIds (per-role, against that
 * role's own population) filter these down to only the ones actually
 * applicable, rather than unioning every common-access role in the tenant
 * unconditionally. Fetched once per scan/evaluation so every call site
 * shares one live lookup instead of duplicating it.
 */
// Every role id this app considers a Common Access role for `tenant` —
// ISC's own CONFIRMED common-access list, unioned with every role this app
// has itself successfully flagged (see rememberFlaggedCommonAccessRole) and
// every role this tenant's own scan/skeleton records show was created as
// Common Access. The CONFIRMED list alone doesn't reliably include a role
// right after it's flagged, so relying on it alone would mean a
// freshly-created Common Access role's entitlements keep showing up as
// "commonly held but not granted" suggestions on every other role until
// ISC's own background aggregation eventually catches up (or, if flagging
// itself failed, forever). Shared by fetchCommonAccessRoleSummaries below
// and the Roles list's "Common Access" filter / Role Evaluation's
// common-access-in-selection endpoint, so all three agree on what counts.
// Split out of getCommonAccessRoleIds below so a caller that needs to tell
// "ISC's own CONFIRMED list" apart from "roles this app only THINKS are
// Common Access" (Role Evaluation's flag-exception check) can — the merged
// Set getCommonAccessRoleIds returns deliberately erases that distinction
// for every other caller, which is correct for exclusion purposes but
// hides exactly the gap Role Evaluation now needs to surface.
async function getCommonAccessRoleStatus(tenant, token) {
  // flaggedCommonAccessRoles/getPersistedCommonAccessRoleIds are both
  // entirely local (no API call) and exist specifically to cover ISC's own
  // CONFIRMED list being unreliable or unavailable — but letting a failure
  // here propagate up threw away BOTH of those perfectly good fallback
  // sources along with it, not just the CONFIRMED one. Verified live: this
  // tenant's beta/common-access GET 401s outright (a beta-API auth/scope
  // issue, not something this app controls), which meant every caller
  // (Role Scan and Role Evaluation's common-access exclusion, the Roles
  // list's Common Access filter) silently treated the WHOLE tenant as
  // having zero Common Access roles — not just the ones ISC's own
  // CONFIRMED list would have covered. Caught here so a role this app
  // itself flagged or created as Common Access is still recognized
  // regardless of whether ISC's own list can be reached.
  let confirmedRoleIds = [];
  let betaUnavailable = false;
  try {
    const resp = await withApiRetry(
      () => axios.get(`https://${tenantApiHost(tenant)}/common-access/v1`, {
        params: { limit: 250 },
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "X-SailPoint-Experimental": "true" },
      }),
      { label: "getCommonAccessRoleStatus: common-access/v1" }
    );
    confirmedRoleIds = (resp.data || [])
      .filter((item) => item.status === "CONFIRMED" && item.access?.type === "ROLE" && item.access?.id)
      .map((item) => item.access.id);
  } catch (err) {
    console.error(`[roles] common-access CONFIRMED list unavailable for ${tenant}, falling back to locally-known common-access roles only:`, err.response?.status || err.message);
    betaUnavailable = true;
  }
  const locallyTracked = new Set([
    ...((await flaggedCommonAccessRoles.get(tenant)) || []),
    ...(await getPersistedCommonAccessRoleIds(tenant)),
  ]);
  return { confirmed: new Set(confirmedRoleIds), locallyTracked, betaUnavailable };
}

async function getCommonAccessRoleIds(tenant, token) {
  const { confirmed, locallyTracked } = await getCommonAccessRoleStatus(tenant, token);
  const denied = new Set((await deniedCommonAccessRoles.get(tenant)) || []);
  return new Set([...confirmed, ...locallyTracked].filter((id) => !denied.has(id)));
}

async function fetchCommonAccessRoleSummaries(tenant, token) {
  const roleIds = [...(await getCommonAccessRoleIds(tenant, token))];

  const summaries = [];
  await mapWithConcurrency(roleIds, ROLE_EVAL_DIMENSION_CONCURRENCY, async (roleId) => {
    try {
      const role = await withApiRetry(() => iscGet(tenant, token, `/v2026/roles/${roleId}`), { label: `fetchCommonAccessRoleSummaries: fetch role ${roleId}` });
      const entIds = new Set((role.entitlements || []).map((e) => e.id));
      if (role.dimensional) {
        const dimensions = await withApiRetry(() => iscGet(tenant, token, `/v2026/roles/${roleId}/dimensions`), { label: `fetchCommonAccessRoleSummaries: fetch role ${roleId} dimensions` });
        for (const d of dimensions || []) {
          for (const e of d.entitlements || []) entIds.add(e.id);
        }
      }
      // Dynamic (dimensional) roles are never common access — explicit
      // rule. A dimensional role confirmed in ISC's common-access list
      // (bulk-confirm pollution) is ignored rather than trusted.
      if (role.dimensional) return;
      summaries.push({
        id: role.id,
        name: role.name,
        enabled: !!role.enabled,
        criteriaLeaves: extractAllCriteriaLeaves(role.membership?.criteria),
        entIds,
      });
    } catch {
      // A common-access role that 404s or errors just contributes nothing —
      // not worth failing the whole scan/evaluation over.
    }
  });
  return summaries;
}

/**
 * Only the entitlements from common-access roles whose own membership is
 * a superset of (or equal to) the given role's membership — i.e. every
 * identity eligible for this role is also necessarily eligible for that
 * common-access role, so its entitlements really are birthright access
 * for this role's population specifically. A common-access role scoped to
 * a different population (verified live: an evaluated role only picking up
 * a same-city Common Access role's entitlements, not an unrelated country's)
 * is left out rather than unioned in regardless — Role Scan's own
 * per-partition matching (see runRoleScan) uses the same
 * criteriaLeavesSubsetOf logic against that partition's own scope instead
 * of this role-membership shape, but the same "only what's actually
 * applicable" principle.
 *
 * excludeRoleId skips a summary for the role currently being evaluated —
 * a common-access role's own criteria is trivially a subset of itself, so
 * without this it would flag its own entitlements as "redundant with a
 * common-access role" and a scheduled scan's auto-accept would strip them
 * to empty (verified live: exactly this happened to "Common Access - Austin
 * Role", which then had nothing left to exclude anywhere else, so those
 * same entitlements started showing up as add-suggestions tenant-wide).
 */
function filterApplicableCommonAccessEntIds(roleMembership, summaries, excludeRoleId = null, boundaryAttributes = []) {
  const roleLeaves = extractAllCriteriaLeaves(roleMembership?.criteria);
  if (roleLeaves.length === 0) return new Set();
  // Same boundary rule the role scan's Common Access reuse applies: when
  // Multi-Company/Division Boundary is on and THIS role's own criteria pin
  // a boundary attribute, a common-access role must pin that attribute too
  // (to the same value — the subset check handles equality) to count. A
  // common role that skips the boundary attribute was computed against a
  // broader, cross-boundary population, so its entitlements aren't valid
  // birthright for this boundary's roles. A role that isn't
  // boundary-scoped itself keeps the plain subset match.
  const pinnedBoundary = roleLeaves.filter((l) => boundaryAttributes.includes(l.attrKey));
  const entIds = new Set();
  for (const s of summaries) {
    if (excludeRoleId && s.id === excludeRoleId) continue;
    if (!criteriaLeavesSubsetOf(s.criteriaLeaves, roleLeaves)) continue;
    if (!pinnedBoundary.every((bl) => s.criteriaLeaves.some((sl) => sl.attrKey === bl.attrKey && sl.value === bl.value))) continue;
    for (const id of s.entIds) entIds.add(id);
  }
  return entIds;
}

/**
 * Checks one entitlement-id set against every conflicting-access SOD policy:
 * a violation exists when the set contains at least one entitlement from
 * each side of the policy's list A / list B (the same semantics ISC itself
 * uses for this policy type — verified against real policy data). Only
 * ENTITLEMENT-type criteria are checkable this way; ACCESS_PROFILE/ROLE
 * criteria items are skipped rather than guessed at.
 *
 * `resolveOrigin(id)` tells the caller where a matched entitlement actually
 * lives (base role vs. a specific dimension) — needed so the Repair Role
 * flow knows which PATCH target (role entitlements vs. dimension
 * entitlements) to hit when removing it. Defaults to "base" for the
 * base-role-only check, where that's always correct.
 */
function findSodViolations(entIds, policies, resolveOrigin = () => ({ type: "base" })) {
  const violations = [];
  for (const p of policies) {
    const left = p.conflictingAccessCriteria.leftCriteria?.criteriaList || [];
    const right = p.conflictingAccessCriteria.rightCriteria?.criteriaList || [];
    const toMatch = (c) => ({ id: c.id, name: c.name, origin: resolveOrigin(c.id) });
    const leftMatch = left.filter((c) => c.type === "ENTITLEMENT" && entIds.has(c.id)).map(toMatch);
    const rightMatch = right.filter((c) => c.type === "ENTITLEMENT" && entIds.has(c.id)).map(toMatch);
    if (leftMatch.length > 0 && rightMatch.length > 0) {
      violations.push({
        policyId: p.id,
        policyName: p.name,
        level: p.level,
        state: p.state,
        leftEntitlements: leftMatch,
        rightEntitlements: rightMatch,
      });
    }
  }
  return violations;
}

async function evaluateRoleAlgorithmic(tenant, token, roleId, options = {}) {
    // considerCommonAccessRoleIds: explicit opt-in list from the "Evaluate"
    // picker on Role Detail — when provided (even as an empty array), it's
    // the FINAL say on which common-access roles' entitlements are
    // excluded, replacing the automatic subset-of-criteria matching
    // entirely (including enabled/disabled ones the user deliberately
    // checked). undefined (every other caller — batch Role Evaluation
    // scans, the create-role reconcile step) keeps the existing automatic
    // behavior unchanged.
    // sharedSodPolicies/sharedCommonAccessSummaries: an optional pre-fetch
    // a batch caller (runRoleEvalScan) hands down so this tenant-wide,
    // largely static data is fetched once per scan run instead of once per
    // role evaluated — real savings across e.g. 100+ roles. undefined (the
    // single-role evaluate route, and any other caller) falls back to
    // fetching fresh per call, same as before.
    // populationCache: an optional shared {} (see fetchActiveIdentityPopulation)
    // a batch caller hands down so every role's (and, when a dimension can't
    // reuse the base scan directly, every dimension's) findRoleMembers call
    // draws from one paged fetch of the tenant's active identities instead
    // of each independently re-paging the same population. undefined for
    // every caller except runRoleEvalScan.
    const { considerCommonAccessRoleIds, sharedSodPolicies, sharedCommonAccessSummaries, populationCache } = options;
    const role = await withApiRetry(() => iscGet(tenant, token, `/v2026/roles/${roleId}`), { label: `evaluateRoleAlgorithmic: fetch role ${roleId}` });
    const roleEntitlements = role.entitlements || [];

    const roleEntIds = new Set(roleEntitlements.map((e) => e.id));

    // Fetched up front (not just inside the dimensionEvaluations branch
    // below) so the dimension-splitting attribute(s) can be resolved before
    // the base membership scan runs — that lets the scan capture each
    // match's value of every such attribute in the same pass, instead of a
    // second full identity scan just for missing/stale-dimension detection.
    const dimensions = role.dimensional
      ? await withApiRetry(() => iscGet(tenant, token, `/v2026/roles/${roleId}/dimensions`), { label: `evaluateRoleAlgorithmic: fetch role ${roleId} dimensions` })
      : [];
    // The role's own declared dimension-splitting attribute(s) —
    // accessRequestConfig.dimensionSchema.dimensionAttributes, the same
    // field this app's own dynamic-role creation writes — is authoritative
    // and checked even when the role currently has zero dimensions (a
    // freshly-flagged dynamic role needs this just as much as one with
    // existing dimensions). Falls back to inferring from existing
    // dimensions' own criteria only when that field isn't populated (older
    // roles) and every existing dimension agrees on one attribute —
    // guessing at a canonical attribute for anything more varied would be
    // unreliable, so detection is skipped for that role rather than risked.
    const existingDimensionInfo = dimensions
      .map((d) => ({ id: d.id, name: d.name, criterion: extractSingleAttributeCriterion(d.membership?.criteria) }))
      .filter((d) => d.criterion);
    const declaredDimensionAttrKeys = (role.accessRequestConfig?.dimensionSchema?.dimensionAttributes || [])
      .map((a) => a.name)
      .filter(Boolean);
    const dimensionAttrKeys = declaredDimensionAttrKeys.length > 0
      ? [...new Set(declaredDimensionAttrKeys)]
      : dimensions.length > 0 &&
        existingDimensionInfo.length === dimensions.length &&
        new Set(existingDimensionInfo.map((d) => d.criterion.attrKey)).size === 1
      ? [existingDimensionInfo[0].criterion.attrKey]
      : [];
    // Existing dimension values, grouped per attribute — a role's
    // dimensionAttributes can list more than one (e.g. this tenant's own
    // "Retail Role": [location, title]), where each individual dimension is
    // scoped by just one of them, not a cross-product of both.
    const existingDimensionValuesByAttr = new Map(); // attrKey -> Set(value)
    for (const d of existingDimensionInfo) {
      if (!existingDimensionValuesByAttr.has(d.criterion.attrKey)) existingDimensionValuesByAttr.set(d.criterion.attrKey, new Set());
      existingDimensionValuesByAttr.get(d.criterion.attrKey).add(d.criterion.value);
    }

    // Both togglable on the Evaluation Config screen (default on for each).
    // Leaving sodPolicies/commonRoleEntIds empty when their toggle is off is
    // enough to disable each feature everywhere downstream — every
    // consumer of them (commonlyHeldNotGrantedRaw's filter, the
    // "redundant with common access" removeCandidate, findSodViolations at
    // both base-role and per-dimension level) already treats an empty
    // set/list as "nothing to flag," so nothing else needs to change.
    const evalSettings = await getTenantSettings(tenant);
    const commonalityThreshold = (evalSettings.entitlementCommonalityThreshold ?? 80) / 100;
    // Boundary config lives on the Schema Analysis record, same place the
    // role scan reads it from at scan start.
    const evalBoundarySchema = await schemaAnalyses.get(tenant);
    const evalBoundaryAttributes = evalBoundarySchema?.roleBoundaryEnabled
      ? evalBoundarySchema.roleBoundaryAttributes || []
      : [];
    // Read fresh for every role evaluated — a bulk Role Evaluation scan
    // calls this once per role rather than precomputing it once for the
    // whole scan, so a common-access role created or changed mid-scan is
    // picked up by every evaluation still to come, not just ones that
    // happen to run after the next scan starts. Retried (transient
    // failures shouldn't silently drop this role's own exclusion). Only
    // common-access roles whose own membership is a superset of (or equal
    // to) THIS role's membership are actually applicable — see
    // filterApplicableCommonAccessEntIds — so a same-city Common Access
    // role's entitlements are considered but an unrelated country's aren't.
    const [membershipResult, unavailableEntitlements, sodPolicies, commonAccessSummaries] = await Promise.all([
      findRoleMembers(tenant, token, role.membership, dimensionAttrKeys, populationCache),
      findUnavailableEntitlements(tenant, token, roleEntitlements),
      sharedSodPolicies !== undefined
        ? Promise.resolve(sharedSodPolicies)
        : evalSettings.checkSodViolations ? fetchConflictingAccessSodPolicies(tenant, token) : Promise.resolve([]),
      sharedCommonAccessSummaries !== undefined
        ? Promise.resolve(sharedCommonAccessSummaries)
        : evalSettings.considerCommonRoles
        ? withApiRetry(() => fetchCommonAccessRoleSummaries(tenant, token), { label: `role ${roleId}: fetch common-access role summaries` }).catch((err) => {
            console.error(`[insights] role ${roleId}: failed to fetch common-access role summaries after retries:`, err.response?.data || err.message);
            return [];
          })
        : Promise.resolve([]),
    ]);
    // A common-access role itself is evaluated against its OWN full
    // population with no exclusion at all — not just excluded from
    // matching against itself (excludeRoleId, above), but never filtered
    // by any OTHER common-access role's entitlements either. The
    // redundant-with-common-access / commonly-held-but-excluded reasoning
    // exists for ordinary roles riding on top of birthright access;
    // applying it to a common-access role itself would hide genuinely
    // commonly-held entitlements from its own evaluation just because some
    // other common role happens to also grant them, which isn't relevant
    // to whether THIS role's own membership commonly holds them.
    // A role that is itself common access gets NO common-access exclusion,
    // INCLUDING when it is one of the picker's considered roles. The
    // picker branch used to take precedence and union the OTHER considered
    // roles' entitlements — so after an accept added the population-wide
    // birthright to every boundary Common Access role, the next scan
    // flagged each one's grants as "redundant with common access" (granted
    // by its siblings) and recommended removing them, and the run after
    // that recommended adding them back: a permanent accept-flip-flop
    // (verified from three consecutive scan records).
    const isThisRoleCommonAccess =
      commonAccessSummaries.some((s) => s.id === roleId) ||
      (Array.isArray(considerCommonAccessRoleIds) && considerCommonAccessRoleIds.includes(roleId));
    const commonRoleEntIds = isThisRoleCommonAccess
      ? new Set()
      : considerCommonAccessRoleIds
      ? new Set(
          commonAccessSummaries
            .filter((s) => s.id !== roleId && considerCommonAccessRoleIds.includes(s.id))
            .flatMap((s) => [...s.entIds])
        )
      : filterApplicableCommonAccessEntIds(role.membership, commonAccessSummaries, roleId, evalBoundaryAttributes);

    // Only for a common-access role evaluating itself: every OTHER active
    // common-access role whose own criteria nests with this one's — either
    // is a subset of the other — has an overlapping population (for an AND
    // of EQUALS leaves, two leaf sets that aren't nested and differ on any
    // attribute describe disjoint populations, e.g. location=Austin vs
    // location=Brussels; nested ones don't, e.g. cloudLifecycleState=active
    // alone vs that plus location=Austin). Purely informational — doesn't
    // affect commonRoleEntIds/addCandidates/removeCandidates above, just
    // surfaced as a possible duplicate to review.
    let overlappingCommonAccessRoles = [];
    if (isThisRoleCommonAccess) {
      const roleLeaves = extractAllCriteriaLeaves(role.membership?.criteria);
      if (roleLeaves.length > 0) {
        overlappingCommonAccessRoles = commonAccessSummaries
          .filter((s) => s.id !== roleId)
          .filter((s) => criteriaLeavesSubsetOf(s.criteriaLeaves, roleLeaves) || criteriaLeavesSubsetOf(roleLeaves, s.criteriaLeaves))
          .map((s) => ({ id: s.id, name: s.name }));
      }
    }

    // Base role's own entitlements against each other — catches a role that
    // is itself internally in conflict, before any dimension is even
    // considered. Anything currently mitigated (see splitMitigatedSodViolations)
    // is pulled out of the active list — it's still surfaced, just not as an
    // actionable violation until the mitigation expires.
    // Turning "Allow SOD Mitigations" off doesn't just hide the button — an
    // existing mitigation stops being honored too, so a violation someone
    // previously accepted the risk on goes right back to being flagged as
    // active, same "empty is enough" mechanism considerCommonRoles/
    // checkSodViolations use.
    const activeSodMitigations = evalSettings.allowSodMitigations === false ? [] : await getActiveSodMitigations(tenant, roleId);
    const { active: sodViolations, mitigated: mitigatedSodViolations } =
      splitMitigatedSodViolations(findSodViolations(roleEntIds, sodPolicies), activeSodMitigations, null);

    let memberProfile = null;
    let missingDimensions = [];
    let staleDimensions = [];
    // Hoisted out of the block below (which only runs when membership
    // resolved) so evaluateDimensionEntitlements can reuse it per dimension
    // instead of each dimension re-fetching this exact same population's
    // entitlements all over again — see baseEntitlementLists usage further
    // down, near dimensionEvaluations.
    let baseEntitlementLists = [];
    if (membershipResult.supported && membershipResult.matches.length > 0) {
      // Same reasoning as evaluateDimensionEntitlements's own fetch below —
      // a member whose entitlement fetch fails this call is silently
      // treated as holding nothing, which can flip an entitlement sitting
      // right at the commonality threshold in or out of the results
      // between runs with no real change in who actually holds it.
      const entitlementLists = baseEntitlementLists = await mapWithConcurrency(
        membershipResult.matches, ROLE_EVAL_ENTITLEMENT_CONCURRENCY,
        async (m) => {
          try {
            return await withApiRetry(
              () => iscGet(tenant, token, `/v2026/entitlements/identities/${m.id}/entitlements`, { limit: 100 }),
              { label: `role ${roleId}: fetch entitlements for identity ${m.id}` }
            );
          } catch {
            return [];
          }
        }
      );
      const counts = new Map(); // entitlement id -> { name, count }
      for (const list of entitlementLists) {
        for (const e of list) {
          const entry = counts.get(e.id) || { name: e.name, count: 0 };
          entry.count += 1;
          counts.set(e.id, entry);
        }
      }
      const memberCount = membershipResult.matches.length;
      const sampleTooSmall = memberCount < ROLE_EVAL_MIN_MEMBERS_FOR_COMMONALITY;

      const rarelyHeldRaw = sampleTooSmall ? [] : roleEntitlements
        .map((e) => ({ id: e.id, name: e.name, count: counts.get(e.id)?.count || 0 }))
        .filter((e) => e.count / memberCount < 0.1);

      const commonlyHeldNotGrantedRaw = sampleTooSmall ? [] : [...counts.entries()]
        .filter(([id, entry]) => !roleEntIds.has(id) && !commonRoleEntIds.has(id) && entry.count / memberCount >= commonalityThreshold)
        .map(([id, entry]) => ({ id, ...entry }));

      // Currently-granted entitlements that DON'T meet the commonality bar
      // against this role's own population — used only when a Role
      // Evaluation batch scan's entire selection is Common Access roles
      // (see runRoleEvalScan's per-role resync), where a Common Access
      // role's grants are meant to track its population's actual
      // commonality exactly, not just flag rare (<10%) outliers the way
      // rarelyHeldRaw does for ordinary roles.
      const nonCommonGrantedRaw = sampleTooSmall ? [] : roleEntitlements
        .map((e) => ({ id: e.id, name: e.name, count: counts.get(e.id)?.count || 0 }))
        .filter((e) => e.count / memberCount < commonalityThreshold);

      memberProfile = {
        memberCount,
        totalScanned: membershipResult.totalScanned,
        partial: !!membershipResult.partial,
        sampleTooSmall,
        rarelyHeld: rarelyHeldRaw.map((e) => `${e.name} (held by ${e.count} of ${memberCount} current members)`),
        commonlyHeldNotGranted: commonlyHeldNotGrantedRaw.map((e) => `${e.name} (held by ${e.count} of ${memberCount} current members)`),
        rarelyHeldRaw,
        commonlyHeldNotGrantedRaw,
        nonCommonGrantedRaw,
      };

      // Missing-dimension detection: runs for every one of the role's
      // declared dimension-splitting attributes (see dimensionAttrKeys
      // above), always — including a dynamic role with zero dimensions yet
      // — using the entitlement data already fetched above (no extra API
      // calls). Safe to run regardless of sample completeness (worst case
      // with a partial sample is failing to notice a gap, not a false one).
      for (const attrKey of dimensionAttrKeys) {
        const existingValuesForAttr = existingDimensionValuesByAttr.get(attrKey) || new Set();

        // Missing: a value with real members that isn't covered by an
        // existing dimension for this attribute — flagged with the
        // entitlements most of those members hold that the base role
        // doesn't already grant. Same commonlyHeldEntitlementIds
        // percentage-threshold algorithm Draft creation uses for a peer
        // group's own dimensionPreview, deliberately shared (see
        // evaluateDimensionEntitlements above) so a role's proposed new
        // dimension and an already-created one agree on what "commonly
        // held" means — including excluding zero-entitlement (not yet
        // provisioned) members from the percentage, not just exactly-one.
        const groups = new Map(); // value -> [entitlement list]
        membershipResult.matches.forEach((m, i) => {
          const value = m.attrValues?.[attrKey];
          if (!value || value === "Unknown" || existingValuesForAttr.has(value)) return;
          if (!groups.has(value)) groups.set(value, []);
          groups.get(value).push(entitlementLists[i] || []);
        });
        for (const [value, lists] of groups.entries()) {
          const eligibleForProposal = lists.filter((list) => list.length > 1).map((entitlements) => ({ entitlements }));
          const groupCommonEntIds = commonlyHeldEntitlementIds(eligibleForProposal, commonalityThreshold);
          const groupCounts = new Map();
          for (const list of lists) {
            for (const e of list) {
              const entry = groupCounts.get(e.id) || { name: e.name, count: 0 };
              entry.count += 1;
              groupCounts.set(e.id, entry);
            }
          }
          const groupAddCandidates = [...groupCommonEntIds]
            .filter((entId) => !roleEntIds.has(entId) && !commonRoleEntIds.has(entId))
            .map((entId) => ({
              entitlementId: entId,
              entitlement: groupCounts.get(entId)?.name,
              reason: `Held by ${groupCounts.get(entId)?.count} of ${lists.length} members with ${attrKey}="${value}" (>=${Math.round(commonalityThreshold * 100)}%).`,
            }));
          missingDimensions.push({
            attrKey,
            value,
            memberCount: lists.length,
            addCandidates: groupAddCandidates,
          });
        }

        // Deliberately NOT flagging a dimension as stale just because no
        // CURRENT role member happens to have its value right now (this
        // used to check membershipResult.matches for that and propose
        // removal when it came up empty). An empty dimension whose
        // attrKey=value combination is still a real, valid identity
        // attribute is a placeholder waiting to be populated — its base
        // role's population can grow into it later (verified live: "1000
        // Asset Management Role" got 31 such dimensions flagged for
        // removal purely because none of its current members happened to
        // be in those cities yet, even though the cities themselves are
        // real values other identities have). Explicit user instruction,
        // stated twice: don't propose removing dimensions the identity
        // attributes indicate are valid; keep empty ones as placeholders
        // for entitlements to be assigned later. staleDimensions is left
        // wired through (report/UI already handle an always-empty array)
        // in case a real signal for it is reintroduced later.
      }
    }

    // Algorithmic findings — computed unconditionally, independent of AI.
    // "No longer available" candidates come from findUnavailableEntitlements
    // (the entitlement itself was deleted from its source) and apply
    // regardless of whether membership could be evaluated. "Rarely held" /
    // "commonly held but missing" candidates need memberProfile.
    // A role that explicitly grants something a common-access role already
    // grants everyone is carrying redundant baggage — same idea as the
    // dimension-vs-base-role redundancy check, just against common access
    // instead of the base role. Pulled out to its own variable (not just
    // inlined into algorithmicRemoveCandidates below) so summarizeAlgorithmic
    // can count it too — it used to only check unavailableEntitlements and
    // memberProfile, so a role whose ONLY remove-candidate was one of these
    // said "No clear staleness or gaps found" right above a "Possibly stale
    // entitlements" section that visibly contradicted it.
    const redundantWithCommonAccess = roleEntitlements
      .filter((e) => commonRoleEntIds.has(e.id))
      .map((e) => ({
        entitlementId: e.id,
        entitlement: e.name,
        reason: "Already granted automatically by a common-access role — redundant here.",
      }));
    // A Common Access role's own grants are meant to track its population's
    // actual commonality exactly (that's the whole point of the role) — an
    // entitlement it holds that's held by FEWER than the commonality
    // threshold of its own current members isn't common anymore and should
    // come off, not just be flagged as "rare" the way an ordinary role's
    // <10% outliers are. Only applies to a role this scan/tenant already
    // considers Common Access; an ordinary role legitimately granting
    // something to everyone regardless of commonality isn't a problem.
    const nonCommonOnCommonAccessRole = isThisRoleCommonAccess && memberProfile
      // >= 10% excluded here — those already show up via rarelyHeldRaw
      // below with their own "may be stale" reason; no need to flag the
      // same entitlement twice with two different explanations.
      ? memberProfile.nonCommonGrantedRaw
          .filter((e) => e.count / memberProfile.memberCount >= 0.1)
          .map((e) => ({
            entitlementId: e.id,
            entitlement: e.name,
            reason: `Held by only ${e.count} of ${memberProfile.memberCount} current members (<${Math.round(commonalityThreshold * 100)}%) — no longer common enough for this Common Access role.`,
          }))
      : [];
    const algorithmicRemoveCandidates = [
      ...unavailableEntitlements.map((e) => ({
        entitlementId: e.id,
        entitlement: e.name,
        reason: "This entitlement no longer exists in its source system — the role is holding a dangling reference to it.",
      })),
      ...redundantWithCommonAccess,
      ...nonCommonOnCommonAccessRole,
      ...(memberProfile
        ? memberProfile.rarelyHeldRaw.map((e) => ({
            entitlementId: e.id,
            entitlement: e.name,
            reason: `Held by only ${e.count} of ${memberProfile.memberCount} current members (<10%) — may be stale.`,
          }))
        : []),
    ];
    const algorithmicAddCandidates = memberProfile
      ? memberProfile.commonlyHeldNotGrantedRaw.map((e) => ({
          entitlementId: e.id,
          entitlement: e.name,
          reason: `Held by ${e.count} of ${memberProfile.memberCount} current members (>=${Math.round(commonalityThreshold * 100)}%) but not granted by this role.`,
        }))
      : [];

    function summarizeAlgorithmic() {
      const parts = [];
      if (unavailableEntitlements.length > 0) {
        parts.push(`${unavailableEntitlements.length} entitlement(s) no longer exist in their source and should be removed`);
      }
      if (redundantWithCommonAccess.length > 0) {
        parts.push(`${redundantWithCommonAccess.length} entitlement(s) are redundant with a common-access role`);
      }
      if (memberProfile?.sampleTooSmall) {
        parts.push(
          `only ${memberProfile.memberCount} current member(s) — too few to reliably tell what's ` +
          `commonly held, so member-based comparisons were skipped`
        );
      } else if (memberProfile) {
        if (memberProfile.rarelyHeldRaw.length > 0) {
          parts.push(`${memberProfile.rarelyHeldRaw.length} entitlement(s) are rarely held by current members`);
        }
        if (memberProfile.commonlyHeldNotGrantedRaw.length > 0) {
          parts.push(`${memberProfile.commonlyHeldNotGrantedRaw.length} commonly-held entitlement(s) aren't granted by this role`);
        }
      } else {
        parts.push("current membership couldn't be reliably determined, so member-based comparisons were skipped");
      }
      // Member count isn't restated here — the client already shows it once
      // alongside these results (result.memberProfile.memberCount).
      return parts.length ? `${parts.join("; ")}.` : "No clear staleness or gaps found.";
    }

    // Dynamic (dimensional) roles: check each existing dimension's own
    // membership for commonly-held entitlements it doesn't grant, same idea
    // as the base role check above but scoped per-dimension. Intersected
    // with the base role's own matched members (see
    // evaluateDimensionEntitlements) since a dimension's criteria alone
    // usually only encodes one attribute and would otherwise pull in
    // identities outside the base role's actual population entirely.
    const baseMemberIds = membershipResult.supported ? new Set(membershipResult.matches.map((m) => m.id)) : null;
    const baseAddCandidateIds = new Set((memberProfile?.commonlyHeldNotGrantedRaw || []).map((e) => e.id));
    // Only reused when the base scan captured the WHOLE matching population
    // (not truncated by ROLE_EVAL_MAX_MATCHES) — otherwise a dimension whose
    // own narrower criteria could reach further into the tenant before
    // hitting the cap would silently lose real members it should see, just
    // because they didn't make it into the base role's own capped sample.
    const baseSampleComplete = membershipResult.supported && membershipResult.matches.length < ROLE_EVAL_MAX_MATCHES;
    const dimensionCriterionById = new Map(
      dimensions.map((d) => [d.id, extractSingleAttributeCriterion(d.membership?.criteria)])
    );
    const dimensionEvaluations = role.dimensional
      ? await mapWithConcurrency(
          dimensions, ROLE_EVAL_DIMENSION_CONCURRENCY,
          async (d) => {
            // Reuse the base role's own already-fetched membership +
            // entitlements for this dimension instead of a second,
            // independent full-tenant scan for what's provably the same
            // population — see evaluateDimensionEntitlements's precomputed
            // param. Falls back to that independent scan (precomputed:
            // null) whenever reuse isn't safe: the base sample was capped,
            // or this dimension's criterion isn't one of the attributes the
            // base scan itself captured (dimensionAttrKeys).
            let precomputed = null;
            if (baseSampleComplete) {
              const criterion = dimensionCriterionById.get(d.id);
              if (criterion && dimensionAttrKeys.includes(criterion.attrKey)) {
                const matches = [];
                const entitlementLists = [];
                membershipResult.matches.forEach((m, i) => {
                  if (m.attrValues?.[criterion.attrKey] === criterion.value) {
                    matches.push(m);
                    entitlementLists.push(baseEntitlementLists[i] || []);
                  }
                });
                precomputed = { matches, entitlementLists, totalScanned: membershipResult.totalScanned, partial: !!membershipResult.partial };
              }
            }
            const evaluation = await evaluateDimensionEntitlements(tenant, token, d, roleEntIds, commonRoleEntIds, commonalityThreshold, baseMemberIds, baseAddCandidateIds, precomputed, populationCache);
            // A dimension's members get the base role's entitlements plus
            // this dimension's own — so the SOD check runs against that
            // combined set, not the dimension's entitlements alone.
            const dimEntIds = new Set((d.entitlements || []).map((e) => e.id));
            const combined = new Set([...roleEntIds, ...dimEntIds]);
            const rawDimSodViolations = findSodViolations(combined, sodPolicies, (entId) =>
              roleEntIds.has(entId) ? { type: "base" } : { type: "dimension", dimensionId: d.id, dimensionName: d.name }
            );
            const dimSplit = splitMitigatedSodViolations(rawDimSodViolations, activeSodMitigations, d.id);
            evaluation.sodViolations = dimSplit.active;
            evaluation.mitigatedSodViolations = dimSplit.mitigated;
            return evaluation;
          }
        )
      : [];
    const dimensionGapCount = dimensionEvaluations.filter((d) => d.addCandidates.length > 0).length;
    const dimensionRedundantCount = dimensionEvaluations.filter((d) => (d.removeCandidates || []).length > 0).length;
    const dimensionSodCount = dimensionEvaluations.filter((d) => (d.sodViolations || []).length > 0).length;
    const mitigatedSodCount = mitigatedSodViolations.length +
      dimensionEvaluations.reduce((n, d) => n + (d.mitigatedSodViolations?.length || 0), 0);

    function summarizeAlgorithmicWithDimensions() {
      const parts = [];
      if (sodViolations.length > 0) {
        parts.push(`${sodViolations.length} SOD policy violation(s) found on the base role`);
      }
      if (dimensionSodCount > 0) {
        parts.push(`${dimensionSodCount} dimension(s) combine with the base role to violate an SOD policy`);
      }
      if (mitigatedSodCount > 0) {
        parts.push(`${mitigatedSodCount} SOD policy violation(s) currently mitigated`);
      }
      if (dimensionGapCount > 0) {
        parts.push(`${dimensionGapCount} dimension(s) have commonly-held entitlements they don't grant`);
      }
      if (dimensionRedundantCount > 0) {
        parts.push(`${dimensionRedundantCount} dimension(s) redundantly grant entitlements already on the base role`);
      }
      if (missingDimensions.length > 0) {
        parts.push(`${missingDimensions.length} new dimension(s) may need to be created`);
      }
      if (staleDimensions.length > 0) {
        parts.push(`${staleDimensions.length} existing dimension(s) may no longer be valid`);
      }
      if (overlappingCommonAccessRoles.length > 0) {
        parts.push(`${overlappingCommonAccessRoles.length} other common-access role(s) have an overlapping membership rule — possible duplicates`);
      }
      const base = summarizeAlgorithmic();
      // A fully clean result (no findings of any kind, including no SOD
      // violations) is worth stating explicitly rather than just staying
      // silent on the SOD check — silence could otherwise read as "the SOD
      // check didn't run" rather than "it ran and found nothing."
      if (parts.length === 0) {
        return base === "No clear staleness or gaps found." && evalSettings.checkSodViolations
          ? "No clear staleness or gaps found. No SOD policy violations detected."
          : base;
      }
      const note = `${parts.join("; ")}.`;
      return base === "No clear staleness or gaps found." ? note : `${base} ${note}`;
    }

    // "Add" candidates (base role, each dimension, each missing-dimension
    // suggestion) all come from the per-identity member scan above
    // (entitlementLists), whose "name" is the same raw attribute value bug
    // fixed for the role scan report — verified live, same underlying ISC
    // endpoint. "Remove" candidates already carry the real name (they're
    // sourced from the role/dimension's own entitlements, roleEntitlements /
    // dimEntitlements), but neither carries "source" — this resolves both
    // categories in one pass, at the end, rather than at each candidate's
    // construction site, so every category (and the UI's group-by-source
    // display) goes through the exact same fix.
    const candidateIds = [
      ...algorithmicAddCandidates.map((c) => c.entitlementId),
      ...algorithmicRemoveCandidates.map((c) => c.entitlementId),
      ...dimensionEvaluations.flatMap((d) => [
        ...d.addCandidates.map((c) => c.entitlementId),
        ...(d.removeCandidates || []).map((c) => c.entitlementId),
      ]),
      ...missingDimensions.flatMap((md) => md.addCandidates.map((c) => c.entitlementId)),
    ];
    if (candidateIds.length > 0) {
      try {
        const infoById = await resolveEntitlementDisplayInfo(tenant, token, candidateIds);
        const relabel = (c) => {
          const info = infoById.get(c.entitlementId);
          if (!info) return c;
          return { ...c, entitlement: info.name || c.entitlement, source: info.source || null };
        };
        algorithmicAddCandidates.forEach((c, i) => { algorithmicAddCandidates[i] = relabel(c); });
        algorithmicRemoveCandidates.forEach((c, i) => { algorithmicRemoveCandidates[i] = relabel(c); });
        dimensionEvaluations.forEach((d) => {
          d.addCandidates = d.addCandidates.map(relabel);
          d.removeCandidates = (d.removeCandidates || []).map(relabel);
        });
        missingDimensions.forEach((md) => { md.addCandidates = md.addCandidates.map(relabel); });
      } catch (err) {
        console.error(`[insights] role evaluation ${roleId}: candidate name/source resolution failed:`, err.response?.data || err.message);
      }
    }

    // Only derive a value from boundary criteria when this tenant actually
    // manages data segments; a role already tagged is checked regardless.
    const segmentMetadata = await ensureRoleSegmentMetadata(
      tenant, token, role, dimensions,
      evalBoundarySchema?.createDataSegments ? evalBoundaryAttributes : []
    );

    // AI-assisted analysis is disabled for this endpoint (repeatedly hit
    // Anthropic billing errors) — always return the algorithmic result.
    return {
      role: { id: role.id, name: role.name },
      segmentMetadata,
      // The role's own base entitlements (not the missing/redundant
      // candidates above) — used by runRoleEvalScan to find entitlements
      // common to every role in a batch scan's scope, for the "add common
      // entitlements to the designated Common Access Role" feature.
      roleEntitlements,
      memberProfile,
      unavailableEntitlements,
      dimensionEvaluations,
      missingDimensions,
      staleDimensions,
      sodViolations,
      mitigatedSodViolations,
      overlappingCommonAccessRoles,
      aiUsed: false,
      summary: summarizeAlgorithmicWithDimensions(),
      removeCandidates: algorithmicRemoveCandidates,
      addCandidates: algorithmicAddCandidates,
      // Whether the role's membership rule (or its IDENTITY_LIST) could
      // actually be tested as valid search criteria against real identity
      // data — false means findRoleMembers couldn't evaluate it at all
      // (an unsupported criteria shape, or every read came back
      // unsupported), so every member-based comparison above was skipped.
      membershipRuleEvaluated: membershipResult.supported,
    };
}

/**
 * POST /api/roles/:id/evaluate
 * Header: x-sp-session
 * Compares the role's entitlements against what its current members
 * actually hold.
 */
app.post("/api/roles/:id/evaluate", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  // Optional — the Role Detail "Evaluate" picker's explicit selection of
  // which common-access roles to consider (see GET .../overlapping-common-
  // access below). Omitted entirely by every other caller of this route,
  // which keeps the automatic subset-of-criteria matching.
  const { considerCommonAccessRoleIds } = req.body || {};

  try {
    const token = await sessionToken(session);
    const result = await evaluateRoleAlgorithmic(tenant, token, req.params.id, {
      considerCommonAccessRoleIds: Array.isArray(considerCommonAccessRoleIds) ? considerCommonAccessRoleIds : undefined,
    });
    res.json(result);
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[roles] evaluate failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

// ─── Role Composition (Role > Composition tab) ──────────────────────────────
// One picture of a role against the people it actually covers: who matches
// the membership rule, which Common Access roles are in scope, and — for the
// base role and each dimension — how common every entitlement is among that
// population, split into what the role already grants ("included") and what
// its people hold that it doesn't ("excluded").
//
// Everything comes from ONE scan of the identities index (each document
// carries its `attributes` for rule matching and its `access` array for what
// it holds), so base and dimension populations are all cut from the same
// snapshot and their percentages are comparable. Roles in this app are built
// from entitlements (no role in the tenant uses access profiles), so
// "access items" here are entitlements — the only thing the role/dimension
// edit routes change.

/**
 * Pure commonality maths for one level (base role or a dimension).
 *   members:      [{ entIds: Set<string> }]  (the level's population)
 *   includedIds:  ids the level currently grants
 *   info:         Map<id, { name, source: { id, name } | null }>
 *   flagsFor(id): extra per-item flags (inCommonAccess, inBase, inDimensions)
 * -> { memberCount, included: [...], excluded: [...] } — each item
 *    { id, name, source, holders, percent, holderIdx, ...flags }, where
 *    holderIdx indexes into `members`. percent is of THIS level's members.
 */
function summarizeCompositionLevel(members, includedIds, info, flagsFor = () => ({})) {
  const holdersOf = new Map(); // entId -> [member index]
  members.forEach((m, i) => {
    for (const id of m.entIds) {
      if (!holdersOf.has(id)) holdersOf.set(id, []);
      holdersOf.get(id).push(i);
    }
  });
  const n = members.length;
  const item = (id) => {
    const holderIdx = holdersOf.get(id) || [];
    const meta = info.get(id) || {};
    return {
      id,
      name: meta.name || id,
      source: meta.source || null,
      holders: holderIdx.length,
      percent: n > 0 ? Math.round((holderIdx.length / n) * 1000) / 10 : 0,
      holderIdx,
      ...flagsFor(id),
    };
  };
  const includedSet = new Set(includedIds);
  const byCommonality = (a, b) => b.percent - a.percent || String(a.name).localeCompare(String(b.name));
  const included = [...includedSet].map(item).sort(byCommonality);
  const excluded = [...holdersOf.keys()].filter((id) => !includedSet.has(id)).map(item).sort(byCommonality);
  return { memberCount: n, included, excluded };
}

/** The Common Access roles whose scope covers this role — same subset + boundary rule as filterApplicableCommonAccessEntIds, but returning the roles. */
function applicableCommonAccessRoles(roleMembership, summaries, excludeRoleId = null, boundaryAttributes = []) {
  const roleLeaves = extractAllCriteriaLeaves(roleMembership?.criteria);
  if (roleLeaves.length === 0) return [];
  const pinnedBoundary = roleLeaves.filter((l) => boundaryAttributes.includes(l.attrKey));
  return summaries.filter((s) =>
    !(excludeRoleId && s.id === excludeRoleId) &&
    criteriaLeavesSubsetOf(s.criteriaLeaves, roleLeaves) &&
    pinnedBoundary.every((bl) => s.criteriaLeaves.some((sl) => sl.attrKey === bl.attrKey && sl.value === bl.value))
  );
}

/** Everyone the role's membership covers, each with attributes (for dimension rules) and the entitlements they hold. */
async function scanRolePopulationWithAccess(tenant, token, membership) {
  const members = [];
  const info = new Map(); // entId -> { name, source }
  const take = (doc) => {
    const attrs = doc.attributes || {};
    const entIds = new Set();
    for (const a of doc.access || []) {
      if (a.type !== "ENTITLEMENT" || !a.id) continue;
      entIds.add(a.id);
      if (!info.has(a.id)) info.set(a.id, { name: a.displayName || a.name || a.id, source: a.source?.id ? { id: a.source.id, name: a.source.name || null } : null });
    }
    members.push({
      id: doc.id,
      displayName: attrs.displayName || doc.displayName || doc.name,
      email: doc.email || attrs.email || null,
      jobTitle: attrs.jobTitle || null,
      department: attrs.department || null,
      manager: doc.manager?.name || null,
      lifecycleState: attrs.cloudLifecycleState || null,
      attrs,
      entIds,
    });
  };
  const includes = ["id", "name", "displayName", "email", "manager", "attributes", "access"];
  const search = (body) => withApiRetry(
    () => axios.post(`https://${tenantApiHost(tenant)}/v2026/search`, body, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      params: { limit: ROLE_EVAL_IDENTITY_PAGE_SIZE },
    }),
    { label: "role composition: identity scan" }
  );

  let scanned = 0;
  let truncated = false;
  if (membership?.criteria) {
    let searchAfter = null;
    while (true) {
      if (scanned >= ROLE_MEMBERS_MAX_SCANNED) { truncated = true; break; }
      const body = { indices: ["identities"], query: { query: "*" }, sort: ["id"], queryResultFilter: { includes } };
      if (searchAfter) body.searchAfter = searchAfter;
      const page = (await search(body)).data || [];
      if (page.length === 0) break;
      for (const doc of page) {
        const attrs = doc.attributes || {};
        if (attrs.identityState !== "ACTIVE") continue;
        if (identityMatchesCriteria(membership.criteria, attrs)) take(doc);
      }
      scanned += page.length;
      if (page.length < ROLE_EVAL_IDENTITY_PAGE_SIZE) break;
      searchAfter = [page[page.length - 1].id];
    }
  } else {
    // An explicit identity list: look those people up directly.
    const ids = (membership?.identities || []).map((i) => i.id).filter((id) => /^[A-Za-z0-9-]+$/.test(String(id)));
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const body = { indices: ["identities"], query: { query: `id:(${chunk.map((id) => `"${id}"`).join(" OR ")})` }, sort: ["id"], queryResultFilter: { includes } };
      for (const doc of (await search(body)).data || []) take(doc);
      scanned += chunk.length;
    }
  }
  members.sort((a, b) => String(a.displayName || "").localeCompare(String(b.displayName || "")));
  return { members, info, scanned, truncated };
}

/**
 * Names and sources for entitlement ids the scan never saw (nobody in the
 * population holds them). "Missing" means no SOURCE yet: a role's own
 * entitlement refs give a name but never a source, and the screen groups by
 * source, so a name-only placeholder is looked up and overwritten too.
 */
async function fillMissingEntitlementInfo(tenant, token, ids, info) {
  const missing = ids.filter((id) => !info.get(id)?.source && /^[A-Za-z0-9-]+$/.test(String(id)));
  for (let i = 0; i < missing.length; i += 100) {
    const chunk = missing.slice(i, i + 100);
    try {
      const resp = await withApiRetry(
        () => axios.post(
          `https://${tenantApiHost(tenant)}/v2026/search`,
          { indices: ["entitlements"], query: { query: `id:(${chunk.map((id) => `"${id}"`).join(" OR ")})` }, queryResultFilter: { includes: ["id", "name", "displayName", "source.id", "source.name"] } },
          { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, params: { limit: 250 } }
        ),
        { label: "role composition: entitlement lookup" }
      );
      for (const e of resp.data || []) info.set(e.id, { name: e.displayName || e.name || e.id, source: e.source?.id ? { id: e.source.id, name: e.source.name || null } : null });
    } catch (err) {
      console.warn("[roles] composition: entitlement lookup failed:", err.response?.status || err.message);
    }
  }
}

async function buildRoleComposition(tenant, token, roleId) {
  const role = await iscGet(tenant, token, `/v2026/roles/${roleId}`);
  const dimensions = role.dimensional
    ? ((await withApiRetry(() => iscGet(tenant, token, `/v2026/roles/${roleId}/dimensions`, { limit: 250 }), { label: "role composition: dimensions" })) || [])
    : [];
  const settings = await getTenantSettings(tenant);
  const thresholdPercent = Number(settings.entitlementCommonalityThreshold) || 80;
  const analysis = await schemaAnalyses.get(tenant);
  const boundaryAttributes = analysis?.roleBoundaryEnabled ? (analysis.roleBoundaryAttributes || []) : [];

  // Common Access roles in scope — and which of them grants each entitlement.
  let commonAccessWarning = null;
  let commonRoles = [];
  try {
    const summaries = await fetchCommonAccessRoleSummaries(tenant, token);
    commonRoles = applicableCommonAccessRoles(role.membership, summaries, roleId, boundaryAttributes);
  } catch (err) {
    commonAccessWarning = `Common Access roles couldn't be read (${describeError(err)}), so none are shown and no item is flagged as already granted by one.`;
  }
  const commonByEnt = new Map(); // entId -> [role name]
  for (const c of commonRoles) for (const id of c.entIds) {
    if (!commonByEnt.has(id)) commonByEnt.set(id, []);
    commonByEnt.get(id).push(c.name);
  }

  const { members, info, scanned, truncated } = await scanRolePopulationWithAccess(tenant, token, role.membership);
  const baseIncluded = (role.entitlements || []).map((e) => e.id);
  for (const e of role.entitlements || []) if (!info.has(e.id) && e.name) info.set(e.id, { name: e.name, source: null });
  const dimIncluded = new Map(dimensions.map((d) => [d.id, (d.entitlements || []).map((e) => e.id)]));
  for (const d of dimensions) for (const e of d.entitlements || []) if (!info.has(e.id) && e.name) info.set(e.id, { name: e.name, source: null });
  await fillMissingEntitlementInfo(tenant, token, [...new Set([...baseIncluded, ...[...dimIncluded.values()].flat()])], info);

  const baseSet = new Set(baseIncluded);
  const dimsHolding = new Map(); // entId -> [dimension name]
  for (const d of dimensions) for (const id of dimIncluded.get(d.id)) {
    if (!dimsHolding.has(id)) dimsHolding.set(id, []);
    dimsHolding.get(id).push(d.name);
  }

  const base = summarizeCompositionLevel(members, baseIncluded, info, (id) => ({
    inCommonAccess: commonByEnt.get(id) || [],
    inDimensions: dimsHolding.get(id) || [],
  }));

  const memberIndex = new Map(members.map((m, i) => [m.id, i]));
  const dimensionViews = dimensions.map((d) => {
    const dimMembers = d.membership?.criteria
      ? members.filter((m) => identityMatchesCriteria(d.membership.criteria, m.attrs))
      : members.filter((m) => (d.membership?.identities || []).some((i) => i.id === m.id));
    const level = summarizeCompositionLevel(dimMembers, dimIncluded.get(d.id), info, (id) => ({
      inCommonAccess: commonByEnt.get(id) || [],
      inBase: baseSet.has(id),
    }));
    // holderIdx is relative to the level's own members; re-point it at the
    // role-wide member list so the client needs only one roster.
    const toRoleIdx = dimMembers.map((m) => memberIndex.get(m.id));
    for (const list of [level.included, level.excluded]) for (const it of list) it.holderIdx = it.holderIdx.map((i) => toRoleIdx[i]);
    return { id: d.id, name: d.name, description: d.description || null, membership: d.membership || null, memberIdx: toRoleIdx, ...level };
  }).sort((a, b) => String(a.name).localeCompare(String(b.name)));

  return {
    role: { id: role.id, name: role.name, enabled: !!role.enabled, dimensional: !!role.dimensional, membership: role.membership || null },
    thresholdPercent,
    scanned,
    truncated,
    commonAccessWarning,
    commonAccessRoles: commonRoles.map((c) => ({ id: c.id, name: c.name, enabled: c.enabled, entitlementCount: c.entIds.size })).sort((a, b) => String(a.name).localeCompare(String(b.name))),
    // Every entitlement an in-scope Common Access role grants -> the role
    // names. The per-item flags only cover items someone holds or a level
    // grants; an item added by SEARCH may be neither, and still has to be
    // checked against Common Access.
    commonAccessByEntitlement: Object.fromEntries(commonByEnt),
    members: members.map(({ attrs, entIds, ...m }) => ({ ...m, entitlementCount: entIds.size })),
    base,
    dimensions: dimensionViews,
  };
}

/**
 * Pure: what the commonality threshold says this role should look like.
 *  - Base role: every entitlement held by >= threshold% of the role's people,
 *    except what an in-scope Common Access role already grants.
 *  - Each dimension: every entitlement held by >= threshold% of THAT
 *    dimension's people, except Common Access items and anything the
 *    (proposed) base role grants — access belongs at the highest level that
 *    justifies it, never at two.
 * Returns only the DIFFERENCE from today, each change with a plain reason:
 * { base: { add, remove }, dimensions: [{ id, name, add, remove }] }.
 */
function proposeRoleComposition(comp, thresholdPercent) {
  const T = thresholdPercent;
  const change = (it, reason, extra = {}) => ({ id: it.id, name: it.name, source: it.source, percent: it.percent, holders: it.holders, reason, ...extra });
  const isCommon = (it) => (it.inCommonAccess || []).length > 0;
  const commonNames = (it) => it.inCommonAccess.join(", ");

  const baseAll = [...comp.base.included, ...comp.base.excluded];
  const baseTarget = new Set(baseAll.filter((it) => it.percent >= T && !isCommon(it)).map((it) => it.id));
  const N = comp.base.memberCount;
  const base = {
    add: comp.base.excluded.filter((it) => baseTarget.has(it.id))
      .map((it) => change(it, `Held by ${it.holders} of ${N} members (${it.percent}%), at or above the ${T}% threshold.`)),
    remove: comp.base.included.filter((it) => !baseTarget.has(it.id))
      .map((it) => isCommon(it)
        ? change(it, `Already granted by Common Access role ${commonNames(it)} — a role shouldn't repeat it.`, { becauseCommonAccess: true })
        : change(it, `Held by only ${it.holders} of ${N} members (${it.percent}%), below the ${T}% threshold.`)),
  };

  const dimensions = comp.dimensions.map((d) => {
    const all = [...d.included, ...d.excluded];
    const target = new Set(all.filter((it) => it.percent >= T && !isCommon(it) && !baseTarget.has(it.id)).map((it) => it.id));
    const n = d.memberCount;
    return {
      id: d.id,
      name: d.name,
      memberCount: n,
      add: d.excluded.filter((it) => target.has(it.id))
        .map((it) => change(it, `Held by ${it.holders} of ${n} members of this dimension (${it.percent}%), at or above ${T}%, and not granted by the base role.`)),
      remove: d.included.filter((it) => !target.has(it.id))
        .map((it) => isCommon(it)
          ? change(it, `Already granted by Common Access role ${commonNames(it)}.`, { becauseCommonAccess: true })
          : baseTarget.has(it.id)
          ? change(it, "Granted by the base role (as proposed), so it doesn't belong on a dimension too.", { becauseBase: true })
          : change(it, `Held by only ${it.holders} of ${n} members of this dimension (${it.percent}%), below the ${T}% threshold.`)),
    };
  });
  return { base, dimensions };
}

/**
 * POST /api/roles/:id/composition/suggest
 * { thresholdPercent, proposal, smallPopulations, ai: { used, summary, cautions, error? } }
 *
 * The CHANGES come from proposeRoleComposition — arithmetic against the
 * tenant's Entitlement Commonality setting, so they're reproducible and every
 * id is real. AI's job is the part arithmetic can't do: read the proposal as
 * an access reviewer would, explain it, and flag individual changes that
 * look risky. It never adds or removes items itself; any id it mentions that
 * isn't in the proposal is discarded. Nothing is saved here.
 */
app.post("/api/roles/:id/composition/suggest", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  if (!/^[A-Za-z0-9-]+$/.test(req.params.id)) return res.status(400).json({ error: "Invalid role id." });
  try {
    const comp = await buildRoleComposition(session.tenant, await sessionToken(session), req.params.id);
    const T = comp.thresholdPercent;
    const proposal = proposeRoleComposition(comp, T);
    const changeCount = proposal.base.add.length + proposal.base.remove.length +
      proposal.dimensions.reduce((n, d) => n + d.add.length + d.remove.length, 0);
    // A percentage over a handful of people isn't evidence of anything.
    const smallPopulations = [
      ...(comp.base.memberCount < ROLE_EVAL_MIN_MEMBERS_FOR_COMMONALITY ? [{ level: "Base role", memberCount: comp.base.memberCount }] : []),
      ...comp.dimensions.filter((d) => d.memberCount < ROLE_EVAL_MIN_MEMBERS_FOR_COMMONALITY).map((d) => ({ level: d.name, memberCount: d.memberCount })),
    ];

    const ai = { used: false, summary: null, cautions: [] };
    if (changeCount > 0 && aiConfigured()) {
      const line = (c) => `    - [${c.id}] ${c.name}${c.source?.name ? ` (${c.source.name})` : ""}: ${c.holders} holders, ${c.percent}%`;
      const levelText = (title, n, lvl) => [
        `${title} — ${n} member${n === 1 ? "" : "s"}`,
        lvl.add.length ? `  ADD:\n${lvl.add.map(line).join("\n")}` : "  ADD: none",
        lvl.remove.length ? `  REMOVE:\n${lvl.remove.map((c) => `${line(c)}${c.becauseCommonAccess ? "  [already granted by Common Access]" : c.becauseBase ? "  [moves to the base role]" : ""}`).join("\n")}` : "  REMOVE: none",
      ].join("\n");
      const prompt = [
        "You are reviewing a proposed change to an identity-governance role, as an experienced access reviewer would.",
        `The role "${comp.role.name}" grants entitlements automatically to everyone matching its membership rule. The proposal below was computed from how many of the role's actual members hold each entitlement, against a commonality threshold of ${T}%: items at or above it are added, items below it are removed, and nothing already granted by an in-scope Common Access role is kept.`,
        comp.commonAccessRoles.length ? `Common Access roles in scope: ${comp.commonAccessRoles.map((c) => c.name).join(", ")}.` : "No Common Access roles are in scope.",
        smallPopulations.length ? `Small populations (percentages here are weak evidence): ${smallPopulations.map((p) => `${p.level} (${p.memberCount})`).join(", ")}.` : "",
        "",
        levelText("BASE ROLE", comp.base.memberCount, proposal.base),
        ...proposal.dimensions.filter((d) => d.add.length || d.remove.length).map((d) => levelText(`DIMENSION "${d.name}"`, d.memberCount, d)),
        "",
        "Respond with ONLY a JSON object, no prose around it:",
        '{ "summary": "<=120 words, plain English: what this change does to the role and whether it looks sound>", "cautions": [ { "id": "<an entitlement id from the list above, copied exactly>", "note": "<=30 words: why a human should look at this one before applying>" } ] }',
        "Use cautions sparingly — only for a change that is genuinely questionable: removing something nearly everyone holds, adding something that sounds privileged or administrative, a change resting on a very small population, or same-named entitlements from different sources being treated differently. Do not invent ids. If nothing is questionable, return an empty cautions array.",
      ].filter((l) => l !== "").join("\n");
      try {
        const text = await claudeGenerateText(prompt, { maxTokens: 1200, strong: true });
        const match = String(text || "").match(/\{[\s\S]*\}/);
        const parsed = match ? JSON.parse(match[0]) : null;
        if (parsed && typeof parsed.summary === "string") {
          const known = new Set([...proposal.base.add, ...proposal.base.remove, ...proposal.dimensions.flatMap((d) => [...d.add, ...d.remove])].map((c) => c.id));
          ai.used = true;
          ai.summary = parsed.summary.slice(0, 1500);
          ai.cautions = (Array.isArray(parsed.cautions) ? parsed.cautions : [])
            .filter((c) => c && known.has(c.id) && typeof c.note === "string")
            .slice(0, 25)
            .map((c) => ({ id: c.id, note: c.note.slice(0, 300) }));
        } else {
          ai.error = "The AI review came back in an unexpected form, so only the computed proposal is shown.";
        }
      } catch (err) {
        console.warn("[roles] composition suggest: AI review failed:", err.response?.status || err.message);
        ai.error = `The AI review couldn't be completed (${describeError(err)}), so only the computed proposal is shown.`;
      }
    } else if (changeCount > 0) {
      ai.error = "AI isn't configured on this server, so the proposal below is the computed one without an AI review.";
    }

    res.json({
      thresholdPercent: T,
      changeCount,
      proposal,
      smallPopulations,
      commonAccessWarning: comp.commonAccessWarning,
      ai,
    });
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[roles] composition suggest failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/**
 * GET /api/roles/:id/composition
 * The whole Composition picture — see buildRoleComposition above.
 */
app.get("/api/roles/:id/composition", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  if (!/^[A-Za-z0-9-]+$/.test(req.params.id)) return res.status(400).json({ error: "Invalid role id." });
  try {
    res.json(await buildRoleComposition(session.tenant, await sessionToken(session), req.params.id));
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[roles] composition failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/**
 * GET /api/roles/:id/overlapping-common-access
 * Every common-access role (enabled or disabled) whose own criteria nests
 * with this role's — either is a subset of the other — for the "Evaluate"
 * picker on Role Detail. Same nesting definition as evaluateRoleAlgorithmic's
 * own overlappingCommonAccessRoles (a common-access role evaluating
 * itself), just surfaced ahead of time so the user can pick which ones
 * actually apply before running the evaluation, rather than trusting
 * automatic matching.
 */
app.get("/api/roles/:id/overlapping-common-access", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;

  try {
    const token = await sessionToken(session);
    const role = await iscGet(tenant, token, `/v2026/roles/${req.params.id}`);
    const roleLeaves = extractAllCriteriaLeaves(role.membership?.criteria);
    if (roleLeaves.length === 0) return res.json([]);
    // Same Enabled Roles Only preference the evaluation itself honors.
    const pickerFilterMode = (await getTenantSettings(tenant)).roleFilterMode || "ALL";
    const summaries = await fetchCommonAccessRoleSummaries(tenant, token);
    const overlapping = summaries
      .filter((s) => s.id !== req.params.id)
      .filter((s) => pickerFilterMode !== "ENABLED_ONLY" || s.enabled !== false)
      .filter((s) => criteriaLeavesSubsetOf(s.criteriaLeaves, roleLeaves) || criteriaLeavesSubsetOf(roleLeaves, s.criteriaLeaves))
      .map((s) => ({ id: s.id, name: s.name, enabled: s.enabled }));
    res.json(overlapping);
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[roles] overlapping-common-access failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/**
 * GET /api/roles/common-access-ids
 * Every role id this app considers a Common Access role for the signed-in
 * tenant (see getCommonAccessRoleIds) — just the ids, for the Roles list's
 * "Common Access" filter toggle to cross-reference against the roles it
 * already has loaded, without re-fetching each role's own details.
 */
app.get("/api/roles/common-access-ids", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;

  try {
    const token = await sessionToken(session);
    const ids = await getCommonAccessRoleIds(tenant, token);
    res.json([...ids]);
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[roles] common-access-ids failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/**
 * The Home screen's Roles Needing Updates / SOD Violation counts (see GET
 * /api/insights/role-stats-summary) come from a snapshot stored on the most
 * recent scheduled scan — hasSodViolations there was computed once, at scan
 * time. Applying, editing, or deleting a mitigation doesn't re-run that
 * scan, so without this the box would keep counting a violation as active
 * until the next scheduled run, even though the role's own evaluation
 * sheet already shows it as mitigated. Patches just this one role's row in
 * place (evaluation/hasSuggestions/hasSodViolations/mitigatedViolationPresent)
 * so Home reflects the change immediately. Best-effort: no scheduled scan
 * yet, or the role not being in the latest one's results, is a normal
 * no-op, not an error.
 */
async function syncRoleIntoLatestStatsScan(tenant, token, roleId) {
  const scans = Object.values(await roleEvalScans.all())
    .filter((s) => s.tenant === tenant && s.triggeredBy === "scheduled" && s.status === "completed")
    .sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt));
  const latest = scans[0];
  if (!latest) return;
  const results = latest.results || [];
  const idx = results.findIndex((r) => r.roleId === roleId);
  if (idx === -1) return;
  try {
    const evaluation = await evaluateRoleAlgorithmic(tenant, token, roleId);
    results[idx] = {
      ...results[idx],
      evaluation,
      hasSuggestions: roleEvalResultHasSuggestions(evaluation),
      hasSodViolations: roleEvalResultHasSodViolations(evaluation),
      mitigatedViolationPresent: roleEvalResultHasMitigatedSodViolations(evaluation),
      error: null,
    };
    await updateRoleEvalScan(latest.id, { results });
  } catch (err) {
    console.error(`[insights] sync role ${roleId} into latest stats scan failed:`, err.response?.data || err.message);
  }
}

/**
 * POST /api/roles/:id/sod-mitigations
 * Header: x-sp-session
 * Body: { items: [{ policyId, policyName, dimensionId?, dimensionName? }], expiresAt }
 * Records a time-limited mitigation for each listed (policy, dimension)
 * violation occurrence — no ISC resource backs this (see the comment above
 * SOD_MITIGATIONS_FILE), it's purely this app's own record. Re-evaluates the
 * role afterward so the response immediately reflects the violation moving
 * from "active" to "mitigated."
 */
app.post("/api/roles/:id/sod-mitigations", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  if ((await getTenantSettings(tenant)).allowSodMitigations === false) {
    return res.status(400).json({ error: "SOD mitigations are disabled for this tenant (Evaluation Config)." });
  }
  const { items, expiresAt, roleName } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "items is required — at least one policy violation to mitigate." });
  }
  if (!expiresAt || Number.isNaN(Date.parse(expiresAt))) {
    return res.status(400).json({ error: "A valid expiresAt date is required." });
  }
  const appliedAt = new Date().toISOString();
  for (const it of items) {
    if (!it.policyId) continue;
    await addSodMitigation(tenant, {
      id: `sodmit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      roleId: req.params.id,
      roleName: roleName || null,
      policyId: it.policyId,
      policyName: it.policyName || null,
      dimensionId: it.dimensionId || null,
      dimensionName: it.dimensionName || null,
      appliedAt,
      expiresAt: new Date(expiresAt).toISOString(),
      appliedBy: session.identity?.username || null,
    });
  }
  try {
    const token = await sessionToken(session);
    const result = await evaluateRoleAlgorithmic(tenant, token, req.params.id);
    res.json(result);
    syncRoleIntoLatestStatsScan(tenant, token, req.params.id);
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[roles] sod-mitigations create: re-evaluate failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/**
 * GET /api/roles/:id/sod-mitigations
 * Every mitigation on record for this role, active or expired — the Repair
 * Role screen only needs the active ones (it re-derives that from
 * expiresAt), but nothing here filters it out for callers that want the
 * full history.
 */
app.get("/api/roles/:id/sod-mitigations", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const list = ((await sodMitigations.get(session.tenant)) || []).filter((m) => m.roleId === req.params.id);
  res.json(list);
});

/**
 * DELETE /api/roles/:id/sod-mitigations/:mitigationId
 * Revokes a mitigation early — the violation goes back to being flagged as
 * active on the next evaluation, same as if it had simply expired.
 */
app.delete("/api/roles/:id/sod-mitigations/:mitigationId", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  await removeSodMitigation(tenant, req.params.mitigationId);
  try {
    const token = await sessionToken(session);
    const result = await evaluateRoleAlgorithmic(tenant, token, req.params.id);
    res.json(result);
    syncRoleIntoLatestStatsScan(tenant, token, req.params.id);
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[roles] sod-mitigations delete: re-evaluate failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/**
 * GET /api/insights/sod-mitigations
 * Every mitigation on record for this tenant, across every role — backs the
 * "Manage Mitigations" list on Evaluation Config. Not filtered to active-only
 * here; the client shows expiresAt for every row so an already-expired one
 * is still visible (and still deletable) rather than silently vanishing.
 */
app.get("/api/insights/sod-mitigations", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const list = [...((await sodMitigations.get(session.tenant)) || [])].sort(
    (a, b) => new Date(a.expiresAt) - new Date(b.expiresAt)
  );
  res.json(list);
});

/**
 * PATCH /api/insights/sod-mitigations/:mitigationId
 * Body: { expiresAt }
 * Changes a mitigation's expiration date — used by "Manage Mitigations" to
 * extend or shorten one without having to delete and recreate it (which
 * would lose appliedAt/appliedBy).
 */
app.patch("/api/insights/sod-mitigations/:mitigationId", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  const { expiresAt } = req.body || {};
  if (!expiresAt || Number.isNaN(Date.parse(expiresAt))) {
    return res.status(400).json({ error: "A valid expiresAt date is required." });
  }
  const list = (await sodMitigations.get(tenant)) || [];
  const mitigation = list.find((m) => m.id === req.params.mitigationId);
  if (!mitigation) return res.status(404).json({ error: "Mitigation not found." });
  mitigation.expiresAt = new Date(expiresAt).toISOString();
  await sodMitigations.put(tenant, list);
  res.json(mitigation);
  try {
    const token = await sessionToken(session);
    syncRoleIntoLatestStatsScan(tenant, token, mitigation.roleId);
  } catch (err) {
    console.error("[insights] sod-mitigations patch: stats sync failed:", err.response?.data || err.message);
  }
});

/**
 * DELETE /api/insights/sod-mitigations/:mitigationId
 * Tenant-scoped revoke, used by "Manage Mitigations" — unlike the
 * role-scoped DELETE above, this doesn't re-evaluate any role afterward
 * (the management list isn't tied to one role's open evaluation sheet).
 */
app.delete("/api/insights/sod-mitigations/:mitigationId", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  const mitigation = ((await sodMitigations.get(tenant)) || []).find((m) => m.id === req.params.mitigationId);
  await removeSodMitigation(tenant, req.params.mitigationId);
  res.json({ ok: true });
  if (mitigation) {
    try {
      const token = await sessionToken(session);
      syncRoleIntoLatestStatsScan(tenant, token, mitigation.roleId);
    } catch (err) {
      console.error("[insights] sod-mitigations delete: stats sync failed:", err.response?.data || err.message);
    }
  }
});

/**
 * GET /api/roles/:id/common-access
 * Whether this role currently carries ISC's own "Common Access" designation
 * (Admin > Access Model > Roles > Common Access checkbox) — same beta API
 * fetchCommonAccessRoleSummaries reads from, just checking one specific
 * role instead of unioning entitlements across all of them. Filtered server-side
 * (access.id eq / access.type eq) rather than fetching everything and
 * matching client-side, since a tenant's common-access list can grow.
 */
app.get("/api/roles/:id/common-access", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;

  try {
    const token = await sessionToken(session);
    const resp = await axios.get(`https://${tenantApiHost(tenant)}/common-access/v1`, {
      params: { limit: 1, filters: `access.id eq "${req.params.id}" and access.type eq "ROLE"` },
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "X-SailPoint-Experimental": "true" },
    });
    const item = (resp.data || [])[0] || null;
    res.json({ commonAccess: item?.status === "CONFIRMED", status: item?.status || null });
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[roles] common-access lookup failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

// ─── Role Evaluation scan ──────────────────────────────────────────────────────
// Same idea as the Role Mining peer-group scan (persisted JSON file, poll-able
// status, cancellable) but loops through every existing role and runs
// evaluateRoleAlgorithmic on each instead of discovering new ones.

const roleEvalScans = createRecordStore(DATA_DIR, "role-eval-scans.json");

async function updateRoleEvalScan(scanId, patch) {
  await roleEvalScans.put(scanId, { ...(await roleEvalScans.get(scanId)), ...patch });
}

/**
 * Keeps at most the tenant's Role Evaluation Retention setting worth of
 * scan records (oldest by startedAt purged first) — called at the end of
 * every scan, regardless of how it finished, so roleEvalScans.json doesn't
 * grow without bound (each record's results array carries every scanned
 * role's full evaluation). A scan still actively running is never purged
 * even if it's old, so a long-running scan can't have its own record
 * deleted out from under it.
 *
 * Pruned as two SEPARATE pools — scheduled (Role Statistics Refresh's own
 * runs + Run Now) and manual (everything else) — each kept to the same
 * retention count independently, rather than one shared pool ranked purely
 * by recency. Otherwise a burst of manual scans (e.g. evaluating several
 * roles/searches back to back) crowds every scheduled scan out of a small
 * retention window, and the Home screen's stats — which only ever read the
 * latest scheduled scan — silently go back to "unavailable" even though
 * the schedule itself is running fine (verified live: roleStatsLastRunSlot
 * showed a real recent run, but zero scheduled scan records remained).
 */
async function pruneRoleEvalScans(tenant) {
  const retention = (await getTenantSettings(tenant)).roleEvalRetention ?? DEFAULT_TENANT_SETTINGS.roleEvalRetention;
  const tenantScans = Object.values(await roleEvalScans.all()).filter((s) => s.tenant === tenant && s.status !== "running");
  const scheduled = tenantScans
    .filter((s) => s.triggeredBy === "scheduled")
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
  const manual = tenantScans
    .filter((s) => s.triggeredBy !== "scheduled")
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
  const toRemove = [...scheduled.slice(retention), ...manual.slice(retention)];
  if (toRemove.length === 0) return;
  for (const s of toRemove) await roleEvalScans.delete(s.id);
}

const cancelledRoleEvalScans = new Set();

function roleEvalResultHasSuggestions(evaluation) {
  return (
    (evaluation.removeCandidates?.length || 0) > 0 ||
    (evaluation.addCandidates?.length || 0) > 0 ||
    (evaluation.dimensionEvaluations || []).some((d) => d.addCandidates.length > 0 || (d.removeCandidates || []).length > 0) ||
    (evaluation.missingDimensions?.length || 0) > 0 ||
    (evaluation.staleDimensions?.length || 0) > 0
  );
}

// SOD violations are surfaced separately from "suggestions" — there's no
// automated fix for a policy conflict (accept-all can't safely decide which
// side of the conflict to remove), so this must never make a role eligible
// for the bulk Accept All action. It only controls whether the role is
// reportable at all.
function roleEvalResultHasSodViolations(evaluation) {
  return (
    (evaluation.sodViolations?.length || 0) > 0 ||
    (evaluation.dimensionEvaluations || []).some((d) => (d.sodViolations || []).length > 0)
  );
}

// A mitigated violation is deliberately NOT persisted into the scan
// result's own evaluation detail (that already only holds sodViolations —
// the still-active ones) — the stored file just notes a mitigated
// violation is present via this flag, rather than carrying the full
// mitigated-violation detail into every scan snapshot going forward.
function roleEvalResultHasMitigatedSodViolations(evaluation) {
  return (
    (evaluation.mitigatedSodViolations?.length || 0) > 0 ||
    (evaluation.dimensionEvaluations || []).some((d) => (d.mitigatedSodViolations || []).length > 0)
  );
}

/**
 * Last step of a Role Evaluation scan: for each Common Access role
 * considered in this scan, uses ITS OWN membership rule to scope the
 * active population, then checks whether that population contains a
 * combination of the tenant's role-scan attribute keys (see
 * getRoleScanAttributeKeys — Schema Analysis's chosen attributes, or the
 * department/location default) that no EXISTING role or dimension's own
 * membership criteria already covers. A combination with no covering role
 * is a peer group riding on Common Access alone with nothing of its own —
 * proposed here, never created. Mirrors Role Scan's own
 * rolesByCriteriaKey/extractAllIdentityEqualsLeaves/criteriaSetKey
 * exact-set-match duplicate check (see runRoleScan), extended to also
 * check each dimensional role's own dimensions (a dimension's criteria
 * alone only ever encodes the ONE attribute it varies by, so it's unioned
 * with its base role's own leaves first — same reasoning already applied
 * to dimension membership/entitlement evaluation elsewhere in this file).
 */
async function findRoleGapProposals(tenant, token, commonRoleStubs, allRoleStubs, populationCache, commonalityThreshold, attributeSeparator) {
  const coveredKeys = new Set();
  for (const role of allRoleStubs) {
    const roleLeaves = extractAllIdentityEqualsLeaves(role.membership?.criteria);
    if (roleLeaves.length > 0) coveredKeys.add(criteriaSetKey(roleLeaves));
    if (!role.dimensional) continue;
    try {
      const dimensions = await withApiRetry(
        () => iscGet(tenant, token, `/v2026/roles/${role.id}/dimensions`),
        { label: `role gap check: fetch role ${role.id} dimensions` }
      );
      for (const d of dimensions || []) {
        const dimLeaves = extractAllIdentityEqualsLeaves(d.membership?.criteria);
        if (dimLeaves.length === 0) continue;
        coveredKeys.add(criteriaSetKey([...roleLeaves, ...dimLeaves]));
      }
    } catch (err) {
      console.error(`[insights] role gap check: dimensions fetch failed for role ${role.id}:`, err.response?.data || err.message);
    }
  }

  const proposals = [];
  for (const commonRole of commonRoleStubs) {
    // Nothing to scope by — without at least one leaf of its own, every
    // identity in the tenant would "match" this common-access role, which
    // would make every existing combination anywhere look uncovered
    // relative to it. Skipped rather than guessed at (same reasoning
    // filterApplicableCommonAccessEntIds/overlappingCommonAccessRoles
    // already apply to an empty leaf set).
    const commonLeaves = extractAllIdentityEqualsLeaves(commonRole.membership?.criteria);
    if (commonLeaves.length === 0) continue;

    // Bucketing by an attribute the common-access role's own criteria
    // already pins to one value would just reproduce that same value in
    // every combo — only its still-variable attributes are useful here.
    const combineKeys = (await getRoleScanAttributeKeys(tenant)).filter(
      (k) => !commonLeaves.some((l) => l.attrKey === k)
    );
    if (combineKeys.length === 0) continue;

    const membershipResult = await findRoleMembers(tenant, token, commonRole.membership, combineKeys, populationCache);
    if (!membershipResult.supported || membershipResult.matches.length === 0) continue;

    const buckets = new Map(); // exact-set key -> { leaves, members }
    for (const m of membershipResult.matches) {
      const values = combineKeys.map((k) => m.attrValues?.[k]);
      if (values.some((v) => !v || v === "Unknown")) continue;
      const leaves = combineKeys.map((k, i) => ({ attrKey: k, value: values[i] }));
      const key = criteriaSetKey([...commonLeaves, ...leaves]);
      if (!buckets.has(key)) buckets.set(key, { leaves, members: [] });
      buckets.get(key).members.push(m);
    }

    for (const [key, { leaves, members }] of buckets) {
      if (coveredKeys.has(key)) continue;

      // Every combination with real members is proposed, even a lone one —
      // no minimum group size gate (same explicit instruction already
      // applied to Skeleton Roles: a 1-member group still gets flagged,
      // just without a commonality-based entitlement suggestion since
      // there's no peer group to compute it from).
      const memberCount = members.length;
      const sampleTooSmall = memberCount < ROLE_EVAL_MIN_MEMBERS_FOR_COMMONALITY;
      let suggestedEntitlements = [];
      if (!sampleTooSmall) {
        const entitlementLists = await mapWithConcurrency(members, ROLE_EVAL_ENTITLEMENT_CONCURRENCY, async (m) => {
          try {
            return await withApiRetry(
              () => iscGet(tenant, token, `/v2026/entitlements/identities/${m.id}/entitlements`, { limit: 100 }),
              { label: `role gap check: fetch entitlements for identity ${m.id}` }
            );
          } catch {
            return [];
          }
        });
        const counts = new Map();
        for (const list of entitlementLists) {
          for (const e of list) {
            const entry = counts.get(e.id) || { name: e.name, count: 0 };
            entry.count += 1;
            counts.set(e.id, entry);
          }
        }
        const minCount = Math.ceil(memberCount * commonalityThreshold);
        suggestedEntitlements = [...counts.entries()]
          .filter(([, entry]) => entry.count >= minCount)
          .map(([id, entry]) => ({
            entitlementId: id,
            entitlement: entry.name,
            reason: `Held by ${entry.count} of ${memberCount} members with this combination (>=${Math.round(commonalityThreshold * 100)}%).`,
          }));
      }

      proposals.push({
        commonAccessRoleId: commonRole.id,
        commonAccessRoleName: commonRole.name,
        attributes: leaves,
        suggestedName: [...leaves.map((l) => l.value)].join(attributeSeparator || " - "),
        memberCount,
        sampleTooSmall,
        suggestedEntitlements,
      });
    }
  }
  return proposals;
}

async function runRoleEvalScan(scanId, session) {
  const { tenant } = session;
  // Locked in at scan creation (see POST /role-eval-scans) — an ad-hoc
  // search typed in for this one run, not a persisted setting. A plain
  // name-contains filter on the roles list itself (same "co" search
  // listRoles/Role Descriptions/Role Rename already use), not a raw ISC
  // Search query — this is meant to be simple search criteria, not
  // something you have to learn Search syntax for.
  const evalScanConfig = await roleEvalScans.get(scanId);
  const searchQuery = evalScanConfig.scopeQuery;
  const rolesFilter = searchQuery ? `name co "${searchQuery}"` : undefined;
  // Explicit scope (see POST /role-eval-scans) — exactly these roles,
  // nothing else. When set, roleFilterMode/rolesFilter below are skipped
  // entirely: whatever's already been filtered/selected client-side (e.g.
  // RolesPage's Evaluate icon) IS the scope, full stop — evaluating
  // anything outside it would defeat the point of filtering/selecting in
  // the first place.
  const scopeRoleIds = evalScanConfig.scopeRoleIds;
  const triggeredBy = evalScanConfig.triggeredBy;
  // Evaluation Config's Role Filtering setting — applied to a manual Start
  // scan, read fresh at scan time rather than locked in at creation like
  // scopeQuery/considerCommonAccessRoleIds below. Role Statistics Refresh
  // (scheduled runs and Run Now — see triggeredBy) always forces
  // ENABLED_ONLY regardless of this setting: it drives the Home screen's
  // pass/needs-update counts, which only make sense for roles someone could
  // actually be assigned right now. "enabled" isn't a queryable filter on
  // ISC's own /v2026/roles (verified live: 400 "not queryable"), so this is
  // applied while building the role list below rather than as a
  // rolesFilter clause.
  const roleFilterMode =
    triggeredBy === "scheduled" ? "ENABLED_ONLY" : (await getTenantSettings(tenant)).roleFilterMode || "ALL";
  // Locked in at scan creation (see POST /role-eval-scans) — applied
  // uniformly to every role this scan evaluates. null (every scan except
  // one started from the Roles list picker) keeps each role's own
  // automatic subset-of-criteria matching.
  const considerCommonAccessRoleIds = evalScanConfig.considerCommonAccessRoleIds || null;

  try {
    // Common Access roles within this scan's scope — exactly what the
    // client resolved and sent (see POST /role-eval-scans: its own
    // detection+picker flow already ran before the scan started), never
    // re-detected here. Listed first below purely for report ordering.
    // Empty for Role Statistics Refresh (scheduled/Run Now never designate
    // one) and for any scan that never went through a picker with a real
    // choice made.
    // Which roles in this scan ARE Common Access. That decides report
    // ordering and — more importantly — scan.commonAccessRolesUsed, which
    // drives the Accept cascade (accepting additions onto a Common Access
    // role removes them from the other roles in the scan it covers).
    //
    // With an explicit list, that list. Without one — the normal case now
    // that nothing prompts for it — the tenant's own flagged Common Access
    // roles, detected here rather than chosen by hand. This is deliberately
    // SEPARATE from how each role is evaluated: considerCommonAccessRoleIds
    // stays null, so every role still gets only the Common Access roles its
    // membership rule overlaps, never a uniform list.
    let commonAccessIds = new Set(considerCommonAccessRoleIds || []);
    if (!considerCommonAccessRoleIds) {
      try {
        commonAccessIds = await getCommonAccessRoleIds(tenant, await sessionToken(session));
      } catch (err) {
        console.warn(`[insights] role eval scan ${scanId}: couldn't detect Common Access roles for ordering/cascade:`, err.response?.data || err.message);
      }
    }

    // Every role matching this scan's scope, fetched fully up front (not
    // paged one page at a time and evaluated immediately, like before) —
    // so Common Access roles can be listed first below.
    const allRoleStubs = [];
    if (Array.isArray(scopeRoleIds) && scopeRoleIds.length > 0) {
      // Explicit scope — fetch exactly these roles, one at a time (this is
      // always a small, already-filtered/selected set, not a bulk query).
      // A role that fails to fetch (deleted since selection, etc.) is
      // silently skipped rather than failing the whole scan.
      for (const id of scopeRoleIds) {
        if (cancelledRoleEvalScans.has(scanId)) break;
        try {
          const token = await sessionToken(session);
          allRoleStubs.push(await withApiRetry(() => iscGet(tenant, token, `/v2026/roles/${id}`), { label: `role eval scan ${scanId}: fetch scoped role ${id}` }));
        } catch (err) {
          console.error(`[insights] role eval scan ${scanId}: fetching scoped role ${id} failed:`, err.response?.data || err.message);
        }
      }
    } else {
      let offset = 0;
      while (true) {
        if (cancelledRoleEvalScans.has(scanId)) break;
        const token = await sessionToken(session);
        const page = await withApiRetry(
          () => iscGet(tenant, token, "/v2026/roles", {
            limit: 250, offset, sorters: "name", ...(rolesFilter ? { filters: rolesFilter } : {}),
          }),
          { label: `role eval scan ${scanId}: roles page` }
        );
        if (page.length === 0) break;
        for (const role of page) {
          const excludedByFilter =
            (roleFilterMode === "ENABLED_ONLY" && !role.enabled) ||
            (roleFilterMode === "DISABLED_ONLY" && role.enabled);
          if (!excludedByFilter) allRoleStubs.push(role);
        }
        offset += page.length;
        if (page.length < 250) break;
      }
    }

    const commonRoleStubs = allRoleStubs.filter((r) => commonAccessIds.has(r.id));
    const otherRoleStubs = allRoleStubs.filter((r) => !commonAccessIds.has(r.id));
    const orderedStubs = [...commonRoleStubs, ...otherRoleStubs];

    await updateRoleEvalScan(scanId, {
      totalRoles: orderedStubs.length,
      commonAccessRolesUsed: commonRoleStubs.map((r) => ({ id: r.id, name: r.name })),
    });

    if (cancelledRoleEvalScans.has(scanId)) {
      cancelledRoleEvalScans.delete(scanId);
      await updateRoleEvalScan(scanId, { status: "cancelled", completedAt: new Date().toISOString() });
      return;
    }

    // SOD policies and common-access role summaries are tenant-wide,
    // largely static data — fetched ONCE here for the whole scan instead
    // of once per role (as evaluateRoleAlgorithmic does by default for its
    // other callers, e.g. the single-role evaluate route). For a scan over
    // 100+ roles that's 100+ redundant fetches of the same handful of SOD
    // policies and common-access roles collapsed into 2. Trades a small
    // amount of freshness for it — a common-access role edited mid-scan
    // won't be picked up until the next run, same tradeoff already
    // accepted for scopeQuery/considerCommonAccessRoleIds being locked in
    // at scan creation.
    const scanEvalSettings = await getTenantSettings(tenant);
    const scanCommonalityThreshold = (scanEvalSettings.entitlementCommonalityThreshold ?? 80) / 100;
    const scanPrefetchToken = await sessionToken(session);
    // A failure here used to just fall back to "no common-access roles
    // exist" with nothing to show for it — every role in the scan would
    // then get flagged as missing entitlements a Common Access role
    // already grants tenant-wide, with no indication anything had gone
    // wrong (verified live: a beta/common-access 401 on this tenant made
    // ~24 freshly-created Skeleton Roles all report the same 5 birthright
    // entitlements as "commonly held but not granted", none of which were
    // real gaps — every one was already covered by its own boundary's
    // Common Access role). Same commonAccessExclusionFailed flag Role Scan
    // already surfaces for the identical failure mode.
    let commonAccessExclusionFailed = false;
    const [sharedSodPolicies, sharedCommonAccessSummaries] = await Promise.all([
      scanEvalSettings.checkSodViolations
        ? fetchConflictingAccessSodPolicies(tenant, scanPrefetchToken)
        : Promise.resolve([]),
      scanEvalSettings.considerCommonRoles
        ? withApiRetry(() => fetchCommonAccessRoleSummaries(tenant, scanPrefetchToken), { label: `role eval scan ${scanId}: fetch common-access role summaries` }).catch((err) => {
            console.error(`[insights] role eval scan ${scanId}: failed to fetch common-access role summaries after retries:`, err.response?.data || err.message);
            commonAccessExclusionFailed = true;
            return [];
          })
        : Promise.resolve([]),
    ]);

    // Shared across every role (and, when a dimension can't reuse its own
    // base role's scan — see evaluateRoleAlgorithmic's dimensionEvaluations
    // — every such dimension too) evaluated by this scan: the tenant's
    // active-identity population is paged from the API once and reused via
    // in-memory criteria matching everywhere else, instead of each role's
    // (and dimension's) own findRoleMembers call independently re-paging
    // the same underlying data. See fetchActiveIdentityPopulation.
    const populationCache = {};

    // considerCommonAccessRoleIds is passed straight through, exactly as
    // the client sent it (null → automatic criteria-subset matching, []
    // → explicit none, [...ids] → exactly those) — same semantics
    // evaluateRoleAlgorithmic has always used for this field. This scan's
    // own commonAccessIds (above) is only used for report ordering/display;
    // it does NOT override what gets passed here, so a Common Access role
    // not chosen by the picker is never treated as one during evaluation.
    //
    // Evaluated with bounded concurrency (see ROLE_EVAL_SCAN_CONCURRENCY)
    // instead of strictly one role at a time — results[i] is written at
    // role i's own index regardless of which order roles actually finish
    // in, so the final persisted order still matches orderedStubs (Common
    // Access roles first) exactly once the scan completes. Progress
    // updates mid-scan use whatever's completed so far, which may not yet
    // be in that same order — cosmetic only, corrected the moment the scan
    // finishes.
    const results = new Array(orderedStubs.length);
    let completedCount = 0;
    let nextIndex = 0;
    let endIndex = orderedStubs.length;
    // Set between phases: entitlement ids the considered Common Access
    // roles' own evaluations propose ADDING. Ordinary roles evaluated
    // afterward have those suppressed from their own add-candidates, so a
    // single scan never suggests the same birthright gap in two places —
    // it shows up once, on the Common Access role it belongs to.
    // Deliberately ADD-only: provisional (not-yet-accepted) grants are
    // never used to mark an ordinary role's existing entitlements
    // "redundant" — that would recommend stripping real access on the
    // strength of a suggestion nobody has accepted.
    let provisionalCommonAdds = null;
    const stripProvisionalAdds = (evaluation) => {
      if (!provisionalCommonAdds || provisionalCommonAdds.size === 0) return;
      const keep = (c) => !provisionalCommonAdds.has(c.entitlementId);
      evaluation.addCandidates = (evaluation.addCandidates || []).filter(keep);
      for (const d of evaluation.dimensionEvaluations || []) {
        d.addCandidates = (d.addCandidates || []).filter(keep);
      }
      for (const md of evaluation.missingDimensions || []) {
        md.addCandidates = (md.addCandidates || []).filter(keep);
      }
    };
    async function evalWorker() {
      while (nextIndex < endIndex) {
        if (cancelledRoleEvalScans.has(scanId)) return;
        const i = nextIndex++;
        const role = orderedStubs[i];
        const token = await sessionToken(session);
        try {
          const evaluation = await evaluateRoleAlgorithmic(tenant, token, role.id, {
            considerCommonAccessRoleIds: considerCommonAccessRoleIds || undefined,
            sharedSodPolicies,
            sharedCommonAccessSummaries,
            populationCache,
          });
          const { roleEntitlements, ...persistedEvaluation } = evaluation;
          stripProvisionalAdds(persistedEvaluation);
          results[i] = {
            roleId: role.id,
            roleName: role.name,
            dimensional: !!role.dimensional,
            enabled: !!role.enabled,
            evaluation: persistedEvaluation,
            hasSuggestions: roleEvalResultHasSuggestions(persistedEvaluation),
            hasSodViolations: roleEvalResultHasSodViolations(persistedEvaluation),
            mitigatedViolationPresent: roleEvalResultHasMitigatedSodViolations(persistedEvaluation),
            error: null,
            accepted: false,
            acceptedAt: null,
          };
        } catch (err) {
          console.error(`[insights] role eval scan ${scanId}: role ${role.id} (${role.name}) failed:`, err.response?.data || err.message);
          results[i] = {
            roleId: role.id,
            roleName: role.name,
            dimensional: !!role.dimensional,
            enabled: !!role.enabled,
            evaluation: null,
            hasSuggestions: false,
            hasSodViolations: false,
            mitigatedViolationPresent: false,
            error: describeError(err),
            accepted: false,
            acceptedAt: null,
          };
        }
        completedCount++;
        await updateRoleEvalScan(scanId, { scanned: completedCount, results: results.filter(Boolean) });
      }
    }
    // Phase 1: the considered Common Access roles alone (they sit at the
    // front of orderedStubs), so their add-candidates are known before any
    // ordinary role is evaluated.
    endIndex = commonRoleStubs.length;
    await Promise.all(
      Array.from({ length: Math.min(ROLE_EVAL_SCAN_CONCURRENCY, commonRoleStubs.length) }, evalWorker)
    );
    provisionalCommonAdds = new Set();
    for (let i = 0; i < commonRoleStubs.length; i++) {
      for (const c of results[i]?.evaluation?.addCandidates || []) {
        if (c.entitlementId) provisionalCommonAdds.add(c.entitlementId);
      }
    }
    // Phase 2: every remaining role, with the same-scan provisional
    // birthright suppressed from their add suggestions.
    endIndex = orderedStubs.length;
    await Promise.all(
      Array.from({ length: Math.min(ROLE_EVAL_SCAN_CONCURRENCY, orderedStubs.length - commonRoleStubs.length) }, evalWorker)
    );

    if (cancelledRoleEvalScans.has(scanId)) {
      cancelledRoleEvalScans.delete(scanId);
      await updateRoleEvalScan(scanId, { status: "cancelled", completedAt: new Date().toISOString() });
      return;
    }

    // Last step: use each Common Access role's own membership rule to look
    // for a combination of attributes with real members that no existing
    // role or dimension covers yet — see findRoleGapProposals. Purely
    // additive to the report; a failure here doesn't fail the scan since
    // every per-role result above is already complete and valid on its own.
    let newRoleProposals = [];
    let roleGapCheckError = null;
    if (commonRoleStubs.length > 0) {
      try {
        const roleGapToken = await sessionToken(session);
        newRoleProposals = await findRoleGapProposals(
          tenant, roleGapToken, commonRoleStubs, allRoleStubs, populationCache,
          scanCommonalityThreshold, scanEvalSettings.attributeSeparator
        );
      } catch (err) {
        console.error(`[insights] role eval scan ${scanId}: role-gap check failed:`, err.response?.data || err.message);
        roleGapCheckError = describeError(err);
      }
    }

    // Also last step: a role this app itself created/flagged as Common
    // Access (locally tracked — see getCommonAccessRoleStatus) but that
    // ISC's own CONFIRMED list doesn't actually show as Common Access is
    // an exception worth surfacing on its own, independent of this scan's
    // own scope/search — the gap is tenant-wide bookkeeping, not something
    // that should only be caught when a role happens to match this run's
    // filter. Explicit user request: check for this and offer to fix it
    // (re-attempt the flag — same POST /api/roles/:id/common-access the
    // create flow already tries once). A role fetch failure here (e.g. the
    // role was since deleted) just drops it from the list rather than
    // failing the whole scan over stale bookkeeping.
    let commonAccessFlagExceptions = [];
    let commonAccessFlagCheckBetaUnavailable = false;
    try {
      const flagCheckToken = await sessionToken(session);
      const { confirmed, locallyTracked, betaUnavailable } = await getCommonAccessRoleStatus(tenant, flagCheckToken);
      commonAccessFlagCheckBetaUnavailable = betaUnavailable;
      const unconfirmedIds = [...locallyTracked].filter((id) => !confirmed.has(id));
      const exceptionResults = await mapWithConcurrency(unconfirmedIds, 5, async (id) => {
        try {
          const role = await withApiRetry(() => iscGet(tenant, flagCheckToken, `/v2026/roles/${id}`), { label: `role eval scan ${scanId}: fetch common-access exception role ${id}` });
          return { id: role.id, name: role.name, enabled: !!role.enabled };
        } catch {
          return null; // most likely deleted since being flagged/created — nothing to fix
        }
      });
      commonAccessFlagExceptions = exceptionResults.filter(Boolean);
    } catch (err) {
      console.error(`[insights] role eval scan ${scanId}: common-access flag exception check failed:`, err.response?.data || err.message);
    }

    await updateRoleEvalScan(scanId, {
      status: "completed",
      completedAt: new Date().toISOString(),
      newRoleProposals,
      roleGapCheckError,
      commonAccessExclusionFailed,
      commonAccessFlagExceptions,
      commonAccessFlagCheckBetaUnavailable,
    });
  } catch (err) {
    cancelledRoleEvalScans.delete(scanId);
    console.error(`[insights] role eval scan ${scanId} failed:`, err.response?.data || err.message);
    await updateRoleEvalScan(scanId, {
      status: "failed",
      completedAt: new Date().toISOString(),
      error: describeError(err),
    });
  } finally {
    // Runs regardless of how the scan finished (completed/cancelled/failed)
    // — see pruneRoleEvalScans for what "at the end of every scan" means.
    try {
      await pruneRoleEvalScans(tenant);
    } catch (err) {
      console.error(`[insights] role eval scan ${scanId}: retention prune failed:`, err.message);
    }
  }
}

/**
 * POST /api/insights/role-eval-scans
 * Body: { query?: string } — an ad-hoc role-name search, not a persisted
 * setting. Passed in fresh with each scan (see RoleEvaluationPage) rather
 * than read from Configuration — locked into the scan record so a running
 * scan or its report isn't retroactively affected by anything.
 */
app.post("/api/insights/role-eval-scans", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  const query = typeof req.body?.query === "string" ? req.body.query.trim() : "";
  // Optional — the Roles list "Evaluate" picker's explicit selection of
  // which common-access roles to consider, same mechanism Role Detail's
  // own picker uses (see GET .../overlapping-common-access below).
  // Omitted (every other caller — Role Statistics Refresh's scheduled
  // runs/Run Now, Role Evaluation's own "Start" button) keeps the
  // automatic subset-of-criteria matching, applied per role as before.
  // Sent as {id, name} pairs (not just ids) so the scan report can name
  // them at the top without a separate lookup — the client already has
  // the names from its own overlap fetch.
  const considerCommonAccessRoles = Array.isArray(req.body?.considerCommonAccessRoles)
    ? req.body.considerCommonAccessRoles.filter((r) => r && r.id)
    : null;
  const considerCommonAccessRoleIds = considerCommonAccessRoles ? considerCommonAccessRoles.map((r) => r.id) : null;
  // Optional explicit scope — exactly these roles, nothing else. Set by
  // RolesPage's Evaluate icon, which applies Active/Disabled, Standard/
  // Dynamic, and Common Access Only filters client-side that a
  // name-contains query alone can't reproduce; without this, the scan
  // would fall back to `query` and evaluate every role matching the search
  // text regardless of those filters — a real bug reported live (a single
  // role selected via Active + Common Access Only still had every role in
  // the tenant evaluated). Role Evaluation's own Start button doesn't send
  // this — it has no such extra filters, so `query` alone is its full scope.
  const roleIds = Array.isArray(req.body?.roleIds) ? req.body.roleIds.filter((id) => typeof id === "string" && id) : null;

  const scanId = `roleevalscan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await updateRoleEvalScan(scanId, {
    id: scanId,
    tenant,
    status: "running",
    startedAt: new Date().toISOString(),
    completedAt: null,
    scopeQuery: query || null,
    scopeRoleIds: roleIds,
    considerCommonAccessRoleIds,
    considerCommonAccessRoles,
    scanned: 0,
    totalRoles: 0,
    results: [],
    error: null,
    newRoleProposals: [],
    roleGapCheckError: null,
    commonAccessExclusionFailed: false,
    commonAccessFlagExceptions: [],
    commonAccessFlagCheckBetaUnavailable: false,
    // Distinguishes this from the Role Statistics Refresh schedule's own
    // runs (see triggerRoleStatsRefresh below) — the home screen's
    // pass/needs-update counts are only ever based on the latter, so a
    // one-off scoped/manual scan here never skews them.
    triggeredBy: "manual",
  });

  runRoleEvalScan(scanId, session);

  res.status(202).json({ scanId });
});

/**
 * GET /api/insights/role-eval-scans/overlapping-common-access?query=...
 * Bulk version of GET /api/roles/:id/overlapping-common-access, for the
 * Roles list "Evaluate" picker — every common-access role (enabled or
 * disabled) whose own criteria nests with ANY role currently matching the
 * same name-contains search the eval scan itself would use, deduplicated.
 * Capped to the first 250 matching roles for cost, same as the other
 * unbounded-ish role-list fetches already in this file.
 */
app.get("/api/insights/role-eval-scans/overlapping-common-access", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  const query = typeof req.query?.query === "string" ? req.query.query.trim() : "";
  const rolesFilter = query ? `name co "${query}"` : undefined;

  try {
    const token = await sessionToken(session);
    const roles = await iscGet(tenant, token, "/v2026/roles", {
      limit: 250, ...(rolesFilter ? { filters: rolesFilter } : {}),
    });
    // The picker honors the same Evaluation Config preference the scan
    // itself applies — with Enabled Roles Only set, a disabled
    // common-access role isn't offered for consideration (it grants
    // nothing while disabled anyway).
    const pickerFilterMode = (await getTenantSettings(tenant)).roleFilterMode || "ALL";
    const summaries = (await fetchCommonAccessRoleSummaries(tenant, token)).filter(
      (s) => pickerFilterMode !== "ENABLED_ONLY" || s.enabled !== false
    );
    const matchedIds = new Set();
    const overlapping = [];
    for (const role of roles) {
      const roleLeaves = extractAllCriteriaLeaves(role.membership?.criteria);
      if (roleLeaves.length === 0) continue;
      for (const s of summaries) {
        if (matchedIds.has(s.id) || s.id === role.id) continue;
        if (!(criteriaLeavesSubsetOf(s.criteriaLeaves, roleLeaves) || criteriaLeavesSubsetOf(roleLeaves, s.criteriaLeaves))) continue;
        matchedIds.add(s.id);
        overlapping.push({ id: s.id, name: s.name, enabled: s.enabled });
      }
    }
    res.json(overlapping);
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[insights] role-eval-scans overlapping-common-access failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/**
 * GET /api/insights/role-eval-scans/common-access-in-selection?query=...
 * Role Evaluation's Start button uses this, not overlapping-common-access
 * above — a literal "is this confirmed Common Access role actually part of
 * what I'm about to evaluate" check, not a criteria-overlap heuristic:
 * pages through every role matching the same name-contains filter the scan
 * itself would use, keeping only the ones already flagged as Common Access
 * (see flaggedCommonAccessRoles). Capped at 2500 roles paged for cost, same
 * bound as the other unbounded-ish role-list fetches in this file — stops
 * early once every flagged role for this tenant has been accounted for.
 */
app.get("/api/insights/role-eval-scans/common-access-in-selection", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  const query = typeof req.query?.query === "string" ? req.query.query.trim() : "";
  const rolesFilter = query ? `name co "${query}"` : undefined;

  try {
    const token = await sessionToken(session);
    const commonAccessIds = await getCommonAccessRoleIds(tenant, token);
    if (commonAccessIds.size === 0) return res.json([]);

    // The picker honors the same Evaluation Config preference the scan
    // itself applies — with Enabled Roles Only set, disabled common-access
    // roles aren't offered for consideration.
    const pickerFilterMode = (await getTenantSettings(tenant)).roleFilterMode || "ALL";

    const matches = [];
    let offset = 0;
    while (matches.length < commonAccessIds.size && offset < 2500) {
      const page = await withApiRetry(
        () => iscGet(tenant, token, "/v2026/roles", {
          limit: 250, offset, sorters: "name", ...(rolesFilter ? { filters: rolesFilter } : {}),
        }),
        { label: "common-access-in-selection: roles page" }
      );
      if (page.length === 0) break;
      for (const role of page) {
        if (!commonAccessIds.has(role.id)) continue;
        if (role.dimensional) continue; // dynamic roles are never common access
        if (pickerFilterMode === "ENABLED_ONLY" && !role.enabled) continue;
        matches.push({ id: role.id, name: role.name, enabled: !!role.enabled });
      }
      offset += page.length;
      if (page.length < 250) break;
    }
    res.json(matches);
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[insights] role-eval-scans common-access-in-selection failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

// ─── Role Statistics Refresh (scheduled Role Evaluation) ──────────────────────
// A background job, configured on Studio Settings > Preferences, that
// periodically re-runs Role Evaluation across every role so the Home
// screen's pass/needs-update counts (see GET /api/insights/role-stats-summary)
// reflect a real recent scan rather than requiring someone to remember to
// run one by hand.

/**
 * Given the Preferences schedule and the current time, finds the most
 * recent "slot" (an exact instant) that should have already fired — e.g.
 * for DAILY at 06:00 starting 2026-01-01, the slot for "now" is whichever
 * midnight-anchored 06:00 is the latest one <= now. Returns null before
 * the start date, or if the schedule isn't fully configured yet.
 * HOURLY only uses the time-of-day's minute component (its hour resets
 * every run); DAILY/WEEKLY use the full time-of-day every 1 or 7 days.
 */
function computeMostRecentDueSlot(prefs, now) {
  if (!prefs?.roleStatsRefreshEnabled || !prefs.roleStatsRefreshStartDate || !prefs.roleStatsRefreshTimeOfDay) {
    return null;
  }
  const [hh, mm] = prefs.roleStatsRefreshTimeOfDay.split(":").map(Number);
  const anchor = new Date(`${prefs.roleStatsRefreshStartDate}T00:00:00`);
  if (Number.isNaN(anchor.getTime())) return null;
  anchor.setHours(prefs.roleStatsRefreshFrequency === "HOURLY" ? 0 : hh, mm, 0, 0);
  if (now < anchor) return null;

  const stepMs =
    prefs.roleStatsRefreshFrequency === "HOURLY" ? 3600_000 :
    prefs.roleStatsRefreshFrequency === "WEEKLY" ? 7 * 86400_000 :
    86400_000;
  const elapsed = now.getTime() - anchor.getTime();
  const slots = Math.floor(elapsed / stepMs);
  return new Date(anchor.getTime() + slots * stepMs);
}

/**
 * Runs a Role Evaluation scan across every role in the tenant, tagged
 * triggeredBy "scheduled" — shared by the scheduler tick below and the
 * Preferences screen's "Run Now" button, so both count toward the Home
 * screen's stats the same way. Uses the caller-supplied session when one's
 * available (Run Now, a real signed-in user); the scheduler itself has no
 * signed-in user to act as, so it passes a bare { tenant } object instead —
 * sessionToken() already falls back to the tenant's stored service
 * credential whenever strongAuth isn't true, which a bare tenant-only
 * object satisfies by simply having no strongAuth field at all.
 */
async function triggerRoleStatsRefresh(tenant, session) {
  const scanId = `roleevalscan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await updateRoleEvalScan(scanId, {
    id: scanId,
    tenant,
    status: "running",
    startedAt: new Date().toISOString(),
    completedAt: null,
    scopeQuery: null,
    scanned: 0,
    totalRoles: 0,
    results: [],
    error: null,
    newRoleProposals: [],
    roleGapCheckError: null,
    commonAccessExclusionFailed: false,
    commonAccessFlagExceptions: [],
    commonAccessFlagCheckBetaUnavailable: false,
    triggeredBy: "scheduled",
  });
  await runRoleEvalScan(scanId, session || { tenant });
  return scanId;
}

const ROLE_STATS_SCHEDULER_TICK_MS = 60_000;

// In-memory only (reset on restart, by design) — prevents a single scan
// that spans multiple 60s ticks from being triggered twice within one
// process's uptime. roleStatsLastRunSlot itself (the on-disk guard against
// re-triggering an already-*completed* slot) is intentionally NOT written
// here anymore — see below.
const roleStatsInFlight = new Set();

async function checkRoleStatsRefreshSchedules() {
  const now = new Date();
  for (const tenant of Object.keys(await studioPreferences.all())) {
    try {
      const prefs = await getStudioPreferences(tenant);
      const dueSlot = computeMostRecentDueSlot(prefs, now);
      if (!dueSlot) continue;
      if (prefs.roleStatsLastRunSlot && new Date(prefs.roleStatsLastRunSlot) >= dueSlot) continue;
      if (roleStatsInFlight.has(tenant)) continue;
      roleStatsInFlight.add(tenant);
      console.log(`[role-stats-refresh] ${tenant}: triggering scheduled scan for slot ${dueSlot.toISOString()}`);
      // roleStatsLastRunSlot is only persisted once the scan actually
      // completes — not before starting it. Previously this was marked
      // done up front so a slow scan spanning multiple ticks wouldn't
      // double-trigger; but triggerRoleStatsRefresh() below is
      // fire-and-forget, and this whole dev server gets restarted often —
      // if the process died between marking the slot done and the scan
      // actually creating its record, the slot was permanently skipped
      // with no scan ever having run (confirmed live: roleStatsLastRunSlot
      // advanced with zero matching "scheduled" scans on disk). Only
      // marking it done on success means an interrupted run correctly
      // retries on the next tick after restart instead of vanishing
      // forever — the roleStatsInFlight guard above still prevents
      // double-triggering while this same process is still running it.
      triggerRoleStatsRefresh(tenant)
        .then(() => updateStudioPreferences(tenant, { roleStatsLastRunSlot: dueSlot.toISOString() }))
        .catch((err) => {
          console.error(`[role-stats-refresh] ${tenant}: scheduled scan failed:`, err.response?.data || err.message);
        })
        .finally(() => roleStatsInFlight.delete(tenant));
    } catch (err) {
      console.error(`[role-stats-refresh] ${tenant}: schedule check failed:`, err.message);
    }
  }
}

setInterval(() => {
  checkRoleStatsRefreshSchedules().catch((err) => console.error("[role-stats-refresh] tick failed:", err.message));
}, ROLE_STATS_SCHEDULER_TICK_MS);

/**
 * POST /api/insights/role-stats-refresh/run-now
 * Runs the same scan the schedule would, immediately, as the signed-in
 * user — for testing a configured schedule or getting a fresh read without
 * waiting for the next slot. Counts toward the Home screen's stats exactly
 * like a real scheduled run, since it's the same underlying job.
 */
app.post("/api/insights/role-stats-refresh/run-now", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const scanId = `roleevalscan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await updateRoleEvalScan(scanId, {
    id: scanId,
    tenant: session.tenant,
    status: "running",
    startedAt: new Date().toISOString(),
    completedAt: null,
    scopeQuery: null,
    scanned: 0,
    totalRoles: 0,
    results: [],
    error: null,
    newRoleProposals: [],
    roleGapCheckError: null,
    commonAccessExclusionFailed: false,
    commonAccessFlagExceptions: [],
    commonAccessFlagCheckBetaUnavailable: false,
    triggeredBy: "scheduled",
  });
  runRoleEvalScan(scanId, session);
  res.status(202).json({ scanId });
});

/**
 * GET /api/insights/role-stats-summary
 * The Home screen's pass/needs-update counts, based on the most recently
 * COMPLETED scan tagged triggeredBy "scheduled" (the Role Statistics
 * Refresh schedule, or its Run Now button) — an ad-hoc/manual Role
 * Evaluation scan never counts, even if it covered every role too.
 */
app.get("/api/insights/role-stats-summary", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;

  // Counted straight from the live API — confirmed in ISC's own
  // common-access list, unioned with every role this app has itself
  // flagged or created as one (same three sources fetchCommonAccessRoleSummaries
  // draws from) — not tied to whether a Role Statistics Refresh scan has
  // ever run, so this number is available immediately and always reflects
  // the tenant's current state, not a snapshot from whenever the last scan
  // happened to run. Only counts roles that are actually enabled AND
  // currently grant at least one entitlement (base or, for a dynamic role,
  // any dimension's own) — a disabled role or an empty-entitlement one
  // (e.g. a Skeleton scan's Common Access role before anything's been
  // added to it) isn't actually providing common access to anyone yet, so
  // it shouldn't count as if it were. Non-fatal: a failure just leaves this
  // uncounted.
  let commonRoleCount = 0;
  try {
    const token = await sessionToken(session);
    const resp = await axios.get(`https://${tenantApiHost(tenant)}/common-access/v1`, {
      params: { limit: 250 },
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "X-SailPoint-Experimental": "true" },
    });
    const confirmedRoleIds = (resp.data || [])
      .filter((item) => item.status === "CONFIRMED" && item.access?.type === "ROLE" && item.access?.id)
      .map((item) => item.access.id);
    const commonRoleIds = [...new Set([
      ...confirmedRoleIds,
      ...((await flaggedCommonAccessRoles.get(tenant)) || []),
      ...(await getPersistedCommonAccessRoleIds(tenant)),
    ])];
    const activeAndGranting = await mapWithConcurrency(commonRoleIds, ROLE_EVAL_DIMENSION_CONCURRENCY, async (roleId) => {
      try {
        const role = await withApiRetry(() => iscGet(tenant, token, `/v2026/roles/${roleId}`), { label: `role-stats-summary: fetch role ${roleId}` });
        if (!role.enabled) return false;
        if ((role.entitlements || []).length > 0) return true;
        if (role.dimensional) {
          const dimensions = await withApiRetry(() => iscGet(tenant, token, `/v2026/roles/${roleId}/dimensions`), { label: `role-stats-summary: fetch role ${roleId} dimensions` });
          return (dimensions || []).some((d) => (d.entitlements || []).length > 0);
        }
        return false;
      } catch {
        return false; // deleted/inaccessible role doesn't count either
      }
    });
    commonRoleCount = activeAndGranting.filter(Boolean).length;
  } catch (err) {
    console.error(`[insights] role-stats-summary: common-access count failed:`, err.response?.data || err.message);
  }

  const scans = Object.values(await roleEvalScans.all())
    .filter((s) => s.tenant === tenant && s.triggeredBy === "scheduled" && s.status === "completed")
    .sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt));
  const latest = scans[0];
  if (!latest) return res.json({ available: false, commonRoleCount });

  // Gated on the CURRENT setting, not whatever it was when this scan ran —
  // if SOD checking has since been turned off, a role that was flagged for
  // an SOD violation back then shouldn't still count as "needing updates"
  // on the Home screen today just because that old scan captured it.
  const checkSodViolations = (await getTenantSettings(tenant)).checkSodViolations !== false;
  const results = latest.results || [];
  // hasSodViolations already only reflects still-ACTIVE violations as of
  // scan time (evaluateRoleAlgorithmic splits out anything mitigated before
  // setting it) — so a role whose only violation was mitigated never counts
  // here. mitigatedSodCount is purely informational (see Home's "Mitigated
  // SOD Present" note) and never factors into okCount/needsUpdateCount/
  // sodViolationCount, nor into which color the box renders.
  const hasSod = (r) => checkSodViolations && r.hasSodViolations;
  const okCount = results.filter((r) => !r.error && !r.hasSuggestions && !hasSod(r)).length;
  const needsUpdateCount = results.filter((r) => r.hasSuggestions || hasSod(r)).length;
  const sodViolationCount = results.filter((r) => hasSod(r)).length;
  const mitigatedSodCount = checkSodViolations ? results.filter((r) => r.mitigatedViolationPresent).length : 0;

  res.json({
    available: true,
    scanId: latest.id,
    asOf: latest.completedAt,
    okCount,
    needsUpdateCount,
    sodViolationCount,
    mitigatedSodCount,
    commonRoleCount,
    totalRoles: results.length,
  });
});

/** GET /api/insights/role-eval-scans — list past/running scans, newest first (no results payload). */
app.get("/api/insights/role-eval-scans", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const list = Object.values(await roleEvalScans.all())
    .filter((s) => s.tenant === session.tenant)
    .map(({ results, ...meta }) => ({
      ...meta,
      suggestionCount: (results || []).filter((r) => r.hasSuggestions && !r.accepted).length,
    }))
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
  res.json(list);
});

function roleEvalScanForSession(scan, session) {
  return scan && scan.tenant === session.tenant ? scan : null;
}

/** GET /api/insights/role-eval-scans/:id — full record including per-role results. */
app.get("/api/insights/role-eval-scans/:id", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const scan = roleEvalScanForSession(await roleEvalScans.get(req.params.id), session);
  if (!scan) return res.status(404).json({ error: "Role evaluation scan not found." });
  res.json(scan);
});

/** POST /api/insights/role-eval-scans/:id/cancel */
app.post("/api/insights/role-eval-scans/:id/cancel", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const scan = roleEvalScanForSession(await roleEvalScans.get(req.params.id), session);
  if (!scan) return res.status(404).json({ error: "Role evaluation scan not found." });
  if (scan.status !== "running") {
    return res.status(400).json({ error: `Scan is already ${scan.status}.` });
  }
  cancelledRoleEvalScans.add(req.params.id);
  await updateRoleEvalScan(req.params.id, { status: "cancelled", completedAt: new Date().toISOString() });
  res.json(await roleEvalScans.get(req.params.id));
});

/** DELETE /api/insights/role-eval-scans/:id */
app.delete("/api/insights/role-eval-scans/:id", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const scan = roleEvalScanForSession(await roleEvalScans.get(req.params.id), session);
  if (!scan) return res.status(404).json({ error: "Role evaluation scan not found." });
  if (scan.status === "running") {
    return res.status(400).json({ error: "Cancel the scan before removing it." });
  }
  await roleEvalScans.delete(req.params.id);
  res.status(204).end();
});

/**
 * POST /api/insights/role-eval-scans/:id/results/:roleId/accept
 * Applies one role's suggestions (from its already-persisted evaluation —
 * not re-evaluated) and marks that result accepted.
 */
app.post("/api/insights/role-eval-scans/:id/results/:roleId/accept", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  const scan = roleEvalScanForSession(await roleEvalScans.get(req.params.id), session);
  if (!scan) return res.status(404).json({ error: "Role evaluation scan not found." });
  const result = scan.results?.find((r) => r.roleId === req.params.roleId);
  if (!result) return res.status(404).json({ error: "Role result not found in this scan." });
  if (!result.evaluation) return res.status(400).json({ error: "This role's evaluation failed — nothing to accept." });

  try {
    const token = await sessionToken(session);
    const { tagged, addedEntIds } = await applyRoleEvaluationSuggestions(tenant, token, result.roleId, result.evaluation);
    result.accepted = true;
    result.acceptedAt = new Date().toISOString();
    if (tagged) result.tagged = tagged;
    // Invariant: non-common roles never keep entitlements a common role
    // grants for the same users. Accepting adds onto a COMMON role removes
    // those entitlements from every other role in this scan whose
    // population the common role covers.
    if ((addedEntIds || []).length > 0 && (scan.commonAccessRolesUsed || []).some((r) => r.id === result.roleId)) {
      const commonIds = new Set((scan.commonAccessRolesUsed || []).map((r) => r.id));
      const candidates = (scan.results || []).map((r) => r.roleId).filter((id) => !commonIds.has(id));
      const cascade = await removeAcceptedCommonEntsFromContextRoles(tenant, token, result.roleId, addedEntIds, candidates);
      if (cascade.length > 0) result.cascadeRemovals = cascade;
    }
    await updateRoleEvalScan(req.params.id, { results: scan.results });
    res.json(result);
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[insights] role eval accept failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/**
 * POST /api/insights/role-eval-scans/:id/accept-all
 * Applies every not-yet-accepted role's suggestions in the scan, one role
 * at a time (sequential — each role's own PATCH/POST calls already run
 * concurrently where safe; running whole roles in parallel risked hitting
 * SailPoint rate limits across dozens of roles at once). Continues past a
 * single role's failure rather than aborting the rest.
 */
app.post("/api/insights/role-eval-scans/:id/accept-all", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  const scan = roleEvalScanForSession(await roleEvalScans.get(req.params.id), session);
  if (!scan) return res.status(404).json({ error: "Role evaluation scan not found." });

  const toApply = (scan.results || []).filter((r) => !r.accepted && r.evaluation && r.hasSuggestions);
  let succeeded = 0;
  const failures = [];
  try {
    for (const result of toApply) {
      try {
        const token = await sessionToken(session);
        const { tagged, addedEntIds } = await applyRoleEvaluationSuggestions(tenant, token, result.roleId, result.evaluation);
        result.accepted = true;
        result.acceptedAt = new Date().toISOString();
        if (tagged) result.tagged = tagged;
        // Same cascade as the per-role accept — and since results are
        // ordered with Common Access roles first, their cascades run
        // before the ordinary roles' own accepts are applied.
        if ((addedEntIds || []).length > 0 && (scan.commonAccessRolesUsed || []).some((r) => r.id === result.roleId)) {
          const commonIds = new Set((scan.commonAccessRolesUsed || []).map((r) => r.id));
          const candidates = (scan.results || []).map((r) => r.roleId).filter((id) => !commonIds.has(id));
          const cascade = await removeAcceptedCommonEntsFromContextRoles(tenant, token, result.roleId, addedEntIds, candidates);
          if (cascade.length > 0) result.cascadeRemovals = cascade;
        }
        succeeded += 1;
      } catch (err) {
        console.error(`[insights] role eval accept-all: role ${result.roleId} failed:`, err.response?.data || err.message);
        failures.push({ roleId: result.roleId, roleName: result.roleName, error: describeError(err) });
      }
      await updateRoleEvalScan(req.params.id, { results: scan.results });
    }
    res.json({ attempted: toApply.length, succeeded, failed: failures.length, failures });
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[insights] role eval accept-all failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}), attempted: toApply.length, succeeded, failed: failures.length, failures });
  }
});

/**
 * POST /api/insights/role-eval-scans/:id/results/:roleId/mark-handled
 * Marks a result accepted WITHOUT re-applying its suggestions against ISC —
 * for when the client already applied them individually (the per-item
 * select-and-accept detail view uses the same single-role routes
 * RoleDetailPage does, which act on the real role directly), and just needs
 * to record that this role no longer needs attention in the persisted scan.
 */
app.post("/api/insights/role-eval-scans/:id/results/:roleId/mark-handled", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const scan = roleEvalScanForSession(await roleEvalScans.get(req.params.id), session);
  if (!scan) return res.status(404).json({ error: "Role evaluation scan not found." });
  const result = scan.results?.find((r) => r.roleId === req.params.roleId);
  if (!result) return res.status(404).json({ error: "Role result not found in this scan." });

  result.accepted = true;
  result.acceptedAt = new Date().toISOString();
  await updateRoleEvalScan(req.params.id, { results: scan.results });
  res.json(result);
});

// ─── Source aggregation ───────────────────────────────────────────────────────
// Verified live against the tenant:
//   POST /v2026/sources/:id/load-accounts        — real (405 on GET, confirms
//     the route exists; POST-only). Triggers account/user aggregation.
//     ?disableOptimization=true runs it unoptimized (full re-evaluation of
//     every account instead of delta), matching ISC's own "Account
//     Aggregation" vs "Unoptimized Aggregation" admin UI actions.
//   POST /v2026/entitlements/aggregate/sources/:id — real (405 on GET).
//     Triggers entitlement aggregation for the source.
//   GET  /v2026/task-status — real, returns recent tasks including
//     target.id/target.name for source-scoped ones (e.g. "Cloud Account
//     Aggregation") and completionStatus. No server-side filter by target.id
//     is accepted (confirmed: 500s) — filtered here instead.

/** POST /api/sources/:id/aggregate-accounts — body: { disableOptimization?: boolean } */
app.post("/api/sources/:id/aggregate-accounts", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  const disableOptimization = req.body?.disableOptimization === true;

  try {
    const token = await sessionToken(session);
    const resp = await axios.post(
      `https://${tenantApiHost(tenant)}/v2026/sources/${req.params.id}/load-accounts`,
      {},
      { params: { disableOptimization }, headers: { Authorization: `Bearer ${token}` } }
    );
    res.json(resp.data);
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[sources] aggregate-accounts failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/** POST /api/sources/:id/aggregate-entitlements */
app.post("/api/sources/:id/aggregate-entitlements", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;

  try {
    const token = await sessionToken(session);
    const resp = await axios.post(
      `https://${tenantApiHost(tenant)}/v2026/entitlements/aggregate/sources/${req.params.id}`,
      {},
      { headers: { Authorization: `Bearer ${token}` } }
    );
    res.json(resp.data);
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[sources] aggregate-entitlements failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/**
 * POST /api/sources/:id/test-configuration
 * Header: x-sp-session
 * Runs ISC's connector "test configuration" check against the source and
 * returns its StatusResponse verbatim — { id, name, status: SUCCESS|FAILURE,
 * elapsedMillis, details }. Read-only: nothing on the source changes. A
 * FAILURE comes back as a 200 with status "FAILURE", exactly as ISC reports
 * it, so the client can show the connector's own diagnostic details.
 */
app.post("/api/sources/:id/test-configuration", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;

  try {
    const token = await sessionToken(session);
    const resp = await axios.post(
      `https://${tenantApiHost(tenant)}/v2026/sources/${req.params.id}/connector/test-configuration`,
      {},
      { headers: { Authorization: `Bearer ${token}` } }
    );
    res.json(resp.data);
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[sources] test-configuration failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

// ─── Source reset ──────────────────────────────────────────────────────────────
// The endpoints this originally shipped against (/sources/:id/reset,
// /sources/:id/accounts/reset, /sources/:id/entitlements/reset) all 404'd
// live — verified against this tenant with a temporary debug probe (GET on
// each candidate path: 405 means the route exists POST-only, 404 means it
// doesn't). ISC has no single "reset everything" endpoint at all — its old
// non-public POST /api/source/reset/ was deprecated in Nov 2023 with no
// direct replacement (SailPoint's own dev community confirms this). The
// two real, verified (405-on-GET) routes are:
//   POST /v2026/entitlements/reset/sources/:id — removes every entitlement
//     aggregated for the source.
//   POST /v2026/sources/:id/remove-accounts — removes every account
//     aggregated for the source (a re-aggregation can recreate them).
// "Source Reset" (full) is composed here from those two calls in sequence
// rather than a single ISC endpoint, since none exists.

/** POST /api/sources/:id/reset-entitlements — deletes every aggregated entitlement for this source. */
async function resetSourceEntitlementsUpstream(tenant, token, sourceId) {
  const resp = await axios.post(
    `https://${tenantApiHost(tenant)}/v2026/entitlements/reset/sources/${sourceId}`,
    {},
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return resp.data;
}

/** POST /api/sources/:id/reset-accounts — deletes every aggregated account for this source. */
async function resetSourceAccountsUpstream(tenant, token, sourceId) {
  const resp = await axios.post(
    `https://${tenantApiHost(tenant)}/v2026/sources/${sourceId}/remove-accounts`,
    {},
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return resp.data;
}

app.post("/api/sources/:id/reset-entitlements", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;

  try {
    const token = await sessionToken(session);
    res.json(await resetSourceEntitlementsUpstream(tenant, token, req.params.id));
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[sources] reset-entitlements failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

app.post("/api/sources/:id/reset-accounts", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;

  try {
    const token = await sessionToken(session);
    res.json(await resetSourceAccountsUpstream(tenant, token, req.params.id));
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[sources] reset-accounts failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/**
 * POST /api/sources/:id/reset — deletes every aggregated account AND
 * entitlement for this source. Entitlements first: removing accounts first
 * can leave entitlement-to-account correlation in a stale state until the
 * next aggregation, whereas the reverse order (as ISC's own admin UI's
 * "reset" guidance orders it) doesn't have that issue. If entitlement reset
 * succeeds but account removal then fails, that's reported as a partial
 * failure rather than silently swallowed.
 */
app.post("/api/sources/:id/reset", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;

  try {
    const token = await sessionToken(session);
    const entitlements = await resetSourceEntitlementsUpstream(tenant, token, req.params.id);
    try {
      const accounts = await resetSourceAccountsUpstream(tenant, token, req.params.id);
      res.json({ entitlements, accounts });
    } catch (accountsErr) {
      console.error("[sources] reset: entitlements reset OK, account removal failed:", accountsErr.response?.data || accountsErr.message);
      res.status(207).json({
        entitlements,
        accountsError: describeError(accountsErr),
      });
    }
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[sources] reset failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/**
 * DELETE /api/sources/:id
 * Header: x-sp-session
 * Permanently deletes the source. ISC itself rejects this if the source is
 * still referenced (an Identity Profile's authoritative source, roles/access
 * profiles with entitlements from it, etc.) — that real error is surfaced
 * as-is rather than retried, since it means something else needs cleaning
 * up first, not that the request should be repeated.
 */
app.delete("/api/sources/:id", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  try {
    const token = await sessionToken(session);
    // Right after deleting a dependent Identity Profile, ISC can still
    // reject the source delete for a few seconds with "in use by
    // [identityProfiles]" while that removal finishes propagating
    // (verified live: the exact same delete succeeded on retry once the
    // reference actually cleared) — retried here rather than surfaced as a
    // hard failure, since it isn't one.
    let lastErr;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await axios.delete(
          `https://${tenantApiHost(tenant)}/v2026/sources/${req.params.id}`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        return res.status(204).end();
      } catch (err) {
        lastErr = err;
        const stillInUse = err.response?.status === 400 && /in use by/i.test(err.response?.data?.messages?.[0]?.text || "");
        if (!stillInUse || attempt === 4) throw err;
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
    throw lastErr;
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[sources] delete failed:", err.response?.data || err.message);
    res.status(status).json({ error: err.response?.data?.messages?.[0]?.text || describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

const SOURCE_AGGREGATION_HISTORY_LIMIT = 250;

/** GET /api/sources/:id/aggregation-history — recent aggregation-related tasks for this source. */
app.get("/api/sources/:id/aggregation-history", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;

  try {
    const token = await sessionToken(session);
    const tasks = await iscGet(tenant, token, "/v2026/task-status", {
      limit: SOURCE_AGGREGATION_HISTORY_LIMIT,
      sorters: "-created",
    });
    const history = tasks.filter((t) => t.target?.id === req.params.id);
    res.json(history);
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[sources] aggregation-history failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

// Renders a transform definition down to one short line — same shape as the
// provisioning-policy field transforms already shown elsewhere on this page
// (SourceDetailPage.jsx's own describeTransform), but this endpoint needs
// its own copy since it runs server-side.
function describeIdentityAttributeTransform(transform) {
  if (!transform) return "";
  const attrs = transform.attributes || {};
  if (transform.type === "accountAttribute") {
    return [attrs.sourceName, attrs.attributeName].filter(Boolean).join(" → ") || "Account Attribute";
  }
  if (transform.type === "reference" && attrs.id) return attrs.id;
  if (transform.type === "static" && attrs.value != null) return `Static: ${attrs.value}`;
  if (attrs.name) return `${transform.type}: ${attrs.name}`;
  return transform.type || "Mapped";
}

/**
 * GET /api/sources/:id/identity-profile
 * Header: x-sp-session
 * The Identity Profile whose authoritative source is this one (there's at
 * most one — /identity-profiles rejects filtering on authoritativeSource.id
 * as semantically invalid, same finding as the lifecycle-state route, so
 * this lists all profiles and matches client-side), plus a concise list of
 * ONLY the identity attributes this profile actually maps — an attribute
 * with no configured mapping simply has no entry in attributeTransforms at
 * all, so no separate "is it in use" filtering step is needed beyond
 * reading that list as-is.
 */
app.get("/api/sources/:id/identity-profile", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  try {
    const token = await sessionToken(session);
    const profiles = await withApiRetry(
      () => iscGet(tenant, token, "/v2026/identity-profiles", { limit: 250 }),
      { label: "sources: identity-profile lookup" }
    );
    const profile = profiles.find((p) => p.authoritativeSource?.id === req.params.id);
    if (!profile) return res.json({ hasProfile: false, profile: null, mappings: [] });

    const [detail, identityAttrs] = await Promise.all([
      withApiRetry(
        () => iscGet(tenant, token, `/v2026/identity-profiles/${profile.id}`),
        { label: `sources: identity-profile ${profile.id} detail` }
      ),
      withApiRetry(
        () => iscGet(tenant, token, "/v2026/identity-attributes", { limit: 250 }),
        { label: "sources: identity-attributes catalog" }
      ).catch(() => []),
    ]);

    const displayNames = new Map((identityAttrs || []).map((a) => [a.name, a.displayName]));
    const transforms = detail.identityAttributeConfig?.attributeTransforms || [];
    const mappings = transforms
      .filter((t) => t.transformDefinition)
      .map((t) => ({
        name: t.identityAttributeName,
        displayName: displayNames.get(t.identityAttributeName) || t.identityAttributeName,
        mapping: describeIdentityAttributeTransform(t.transformDefinition),
      }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));

    res.json({
      hasProfile: true,
      profile: { id: profile.id, name: profile.name, description: detail.description || null },
      mappings,
    });
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[sources] identity-profile failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/**
 * Fetches a source's accounts, working around a real ISC inconsistency:
 * which property actually filters /v2026/accounts by source ("source.id"
 * vs "sourceId") depends on the source's connector type, and which property
 * accepts the "co" (contains) operator for name search varies too — a
 * combination that worked for one source 400'd for another with either
 * "Invalid filter properties" or "Illegal value \"operation co\"".
 * Verified live against two different real sources in this tenant.
 *
 * Tries source.id/sourceId, each with and without the "co" search clause;
 * once a (field, no-co) combination succeeds, search is applied client-side
 * instead. Logs which combination actually worked so a source that needs a
 * new fallback shows up in the logs rather than silently misbehaving.
 */
/**
 * One page of a source's accounts plus the real total. limit/offset page
 * through ISC; total comes from ISC's X-Total-Count (count=true), so the
 * client can show "Page 2 of 7 (612 accounts)". When the name search has to
 * fall back to filtering client-side (see the attempts below), the total is
 * of the filtered PAGE only and `totalIsExact` says so.
 */
async function fetchSourceAccounts(tenant, token, sourceId, query, { limit = 100, offset = 0 } = {}) {
  const fields = ["source.id", "sourceId"];
  const attempts = [];
  for (const field of fields) {
    if (query) attempts.push({ field, filters: `${field} eq "${sourceId}" and name co "${query}"`, clientFilter: false });
  }
  for (const field of fields) {
    attempts.push({ field, filters: `${field} eq "${sourceId}"`, clientFilter: true });
  }

  let lastErr;
  for (const attempt of attempts) {
    try {
      const resp = await axios.get(`https://${tenantApiHost(tenant)}/v2026/accounts`, {
        params: { filters: attempt.filters, sorters: "name", limit, offset, count: true },
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
      const accounts = Array.isArray(resp.data) ? resp.data : [];
      const header = resp.headers?.["x-total-count"];
      const total = header != null ? Number(header) : null;
      if (attempt !== attempts[0]) {
        console.warn(`[sources] accounts fallback used for source ${sourceId}: ${attempt.filters}`);
      }
      if (attempt.clientFilter && query) {
        const q = query.toLowerCase();
        const filtered = accounts.filter((a) => (a.name || a.displayName || "").toLowerCase().includes(q));
        return { accounts: filtered, total: filtered.length, totalIsExact: false };
      }
      return { accounts, total, totalIsExact: total != null };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

/**
 * GET /api/sources/:id/accounts?query=&limit=&offset=
 * One page of this source's accounts: { accounts, total, totalIsExact }.
 * (Returned the bare array before paging was added; the client helper
 * accepts both shapes.)
 */
app.get("/api/sources/:id/accounts", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 250);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  try {
    const token = await sessionToken(session);
    res.json(await fetchSourceAccounts(tenant, token, req.params.id, req.query.query, { limit, offset }));
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[sources] accounts failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

// ─── Source account editing (Delimited File / Generic sources) ────────────────
// A Delimited File / Generic source's accounts come from a flat file, not a
// live directory — so unlike every other source type, its accounts can be
// edited by hand and re-loaded. This flow: fetch the account schema (field
// names/order) and every account, let the client build an edited CSV, upload
// it as a real file (multipart, matching how ISC's own admin UI does a
// manual account load) to /v2026/sources/:id/load-accounts, then delete the
// temporary file this server wrote to build that upload.
const FormData = require("form-data");

/** GET /api/sources/:id/account-schema — the account schema's attributes, in ISC's own defined order. */
app.get("/api/sources/:id/account-schema", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  try {
    const token = await sessionToken(session);
    const schemas = await iscGet(tenant, token, `/v2026/sources/${req.params.id}/schemas`);
    const accountSchema = (Array.isArray(schemas) ? schemas : []).find((s) => s.name === "account") || schemas?.[0];
    if (!accountSchema) return res.status(404).json({ error: "No account schema found for this source." });
    const attributes = (accountSchema.attributes || []).map((a) => ({
      name: a.name,
      type: a.type,
      isMulti: !!a.isMulti,
      isEntitlement: !!a.isEntitlement,
      description: a.description || null,
    }));
    res.json({ attributes, identityAttribute: accountSchema.identityAttribute, displayAttribute: accountSchema.displayAttribute });
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[sources] account-schema failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/**
 * GET /api/sources/:id/schemas
 * Header: x-sp-session
 * Every schema on the source, as ISC returns them — the account-schema route
 * above trims to a display shape, but the Entitlement Schema tab edits the
 * raw object, so nothing is dropped here. Sorted with "account" first, then
 * by name, so the order is stable across refetches.
 */
app.get("/api/sources/:id/schemas", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  try {
    const token = await sessionToken(session);
    const schemas = await iscGet(tenant, token, `/v2026/sources/${req.params.id}/schemas`);
    const list = (Array.isArray(schemas) ? schemas : []).slice().sort((a, b) => {
      if (a.name === "account") return -1;
      if (b.name === "account") return 1;
      return String(a.name || "").localeCompare(String(b.name || ""));
    });
    res.json(list);
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[sources] schemas list failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/**
 * PUT /api/sources/:id/schemas/:schemaId
 * Header: x-sp-session
 * Body: the full schema object, as edited.
 * Replaces one schema wholesale. PUT is the proven write for schemas on this
 * tenant — the uid route below already relies on "PUT requires the whole
 * object" (verified live) — and the editor holds the complete GET
 * representation, so it's sent back as-is. `id` is taken from the path, not
 * the body, so an edit can't retarget another schema.
 */
app.put("/api/sources/:id/schemas/:schemaId", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return res.status(400).json({ error: "The full schema object is required as the request body." });
  }
  try {
    const token = await sessionToken(session);
    const resp = await axios.put(
      `https://${tenantApiHost(tenant)}/v2026/sources/${req.params.id}/schemas/${req.params.schemaId}`,
      { ...body, id: req.params.schemaId },
      { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }
    );
    res.json(resp.data);
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[sources] schema update failed:", JSON.stringify(err.response?.data || err.message, null, 2));
    // messages[] is the generic text; causes[] (when present) the specific
    // reason — same shape the dataset routes learned to surface.
    const data = err.response?.data;
    const texts = [];
    for (const m of [...(data?.messages || []), ...(data?.causes || [])]) {
      if (m?.text && !texts.includes(m.text)) texts.push(m.text);
    }
    res.status(status).json({ error: texts.length ? texts.join(" — ") : describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/**
 * POST /api/sources/:id/sync-provisioning-policies
 * Body: { removedNames: string[], added: [{ name, isMulti }, ...] }
 *
 * Keeps every provisioning policy this source has (CREATE/UPDATE/ENABLE/
 * DISABLE, whichever exist) in step with a just-edited account schema:
 * drops any field whose name matches an attribute that was just removed
 * from the schema, and adds a plain, unconfigured field for each newly
 * added attribute it doesn't already have. Every other field — including
 * one not tied to any of THIS edit's changed names at all, like a
 * synthetic "password" field on a CREATE policy that was never a schema
 * attribute to begin with — is left completely untouched. Only PATCHes a
 * policy whose fields actually change.
 */
app.post("/api/sources/:id/sync-provisioning-policies", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  const sourceId = req.params.id;
  const removedNames = Array.isArray(req.body?.removedNames) ? req.body.removedNames : [];
  const added = Array.isArray(req.body?.added) ? req.body.added : [];
  if (removedNames.length === 0 && added.length === 0) {
    return res.json({ policiesUpdated: [] });
  }
  try {
    const token = await sessionToken(session);
    const policies = await withApiRetry(
      () => iscGet(tenant, token, `/v2026/sources/${sourceId}/provisioning-policies`),
      { label: "sync-provisioning-policies: list" }
    );
    const removedSet = new Set(removedNames);
    const updated = [];
    for (const policy of policies || []) {
      const existingNames = new Set((policy.fields || []).map((f) => f.name));
      const keptFields = (policy.fields || []).filter((f) => !removedSet.has(f.name));
      const newFields = added
        .filter((a) => !existingNames.has(a.name))
        .map((a) => ({ name: a.name, transform: null, attributes: {}, isRequired: false, type: "string", isMultiValued: !!a.isMulti }));
      if (keptFields.length === (policy.fields || []).length && newFields.length === 0) continue;

      // PATCH .../provisioning-policies/:usageType rejects a JSON-Patch op
      // at the bare "/fields" path (verified live: 400 "Invalid path" —
      // ISC only accepts indexed paths like /fields/0 there) — this
      // endpoint also takes a plain PUT of the whole object, same pattern
      // already used for the schema UID-confirm route above.
      await axios.put(
        `https://${tenantApiHost(tenant)}/v2026/sources/${sourceId}/provisioning-policies/${policy.usageType}`,
        { ...policy, fields: [...keptFields, ...newFields] },
        { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }
      );
      updated.push(policy.usageType);
    }
    res.json({ policiesUpdated: updated });
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[sources] sync-provisioning-policies failed:", err.response?.data || err.message);
    res.status(status).json({
      error: err.response?.data?.messages?.[0]?.text || describeError(err),
      ...(err.sessionExpired ? { sessionExpired: true } : {}),
    });
  }
});

// Same source.id/sourceId filter-field inconsistency fetchSourceAccounts
// works around above, but paginated to the full set (export needs every
// account, not just the first page) and without the "co" search complexity
// that fetchSourceAccounts needs — export never searches.
async function fetchAllSourceAccountsForExport(tenant, token, sourceId) {
  const fields = ["source.id", "sourceId"];
  const pageSize = 250;
  let lastErr;
  for (const field of fields) {
    try {
      const all = [];
      let offset = 0;
      while (true) {
        const page = await iscGet(tenant, token, "/v2026/accounts", {
          filters: `${field} eq "${sourceId}"`,
          sorters: "name",
          limit: pageSize,
          offset,
        });
        if (!Array.isArray(page) || page.length === 0) break;
        all.push(...page);
        if (page.length < pageSize) break;
        offset += pageSize;
      }
      return all;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

/** GET /api/sources/:id/accounts/export — every account on this source, for editing. */
app.get("/api/sources/:id/accounts/export", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  try {
    const token = await sessionToken(session);
    const accounts = await fetchAllSourceAccountsForExport(tenant, token, req.params.id);
    res.json(accounts);
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[sources] accounts export failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

const EDIT_ACCOUNTS_DIR = path.join(DATA_DIR, "edit-accounts-tmp");

/**
 * POST /api/sources/:id/load-accounts-file
 * Body: { filename, csvBase64, disableOptimization? }
 * Writes the edited CSV to a short-lived temp file, uploads it to ISC's real
 * load-accounts endpoint as multipart/form-data (the same mechanism as a
 * manual file upload in ISC's own admin UI), then always deletes the temp
 * file — on success because its job is done, and on failure too, since nothing
 * else in this app ever reads it back and leaving it around on error would
 * just accumulate orphaned files with no cleanup path.
 */
app.post("/api/sources/:id/load-accounts-file", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  const { filename, csvBase64, disableOptimization } = req.body || {};
  if (typeof csvBase64 !== "string" || !csvBase64) {
    return res.status(400).json({ error: "csvBase64 is required." });
  }
  const safeFilename = typeof filename === "string" && filename ? filename : "accounts.csv";
  fs.mkdirSync(EDIT_ACCOUNTS_DIR, { recursive: true });
  const tmpPath = path.join(EDIT_ACCOUNTS_DIR, `${crypto.randomBytes(16).toString("hex")}-${safeFilename}`);
  fs.writeFileSync(tmpPath, Buffer.from(csvBase64, "base64"));
  try {
    const token = await sessionToken(session);
    const form = new FormData();
    form.append("file", fs.createReadStream(tmpPath), safeFilename);
    const resp = await axios.post(
      `https://${tenantApiHost(tenant)}/v2026/sources/${req.params.id}/load-accounts`,
      form,
      {
        params: disableOptimization === true ? { disableOptimization: true } : undefined,
        headers: { Authorization: `Bearer ${token}`, ...form.getHeaders() },
      }
    );
    res.json(resp.data);
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[sources] load-accounts-file failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  } finally {
    try { fs.unlinkSync(tmpPath); } catch {
      // Already gone or never written — fine either way.
    }
  }
});

// ─── Disconnected Source creation wizard ───────────────────────────────────
// The whole flow (verified live against a disposable test source, then
// cleaned up): create a DelimitedFile source, POST a sample CSV to ISC's
// /sources/v1/:id/schemas/accounts to auto-detect its schema (this is a
// DIFFERENT API root than /v2026 or /beta — confirmed live, /v2026 equivalents
// all 404/405), let the reviewer confirm/adjust the UID + Account Name
// attributes ISC's own detection already suggested, PUT the schema back with
// those set, then reuse the existing load-accounts-file upload (below) to
// actually aggregate from the same file.

/**
 * POST /api/sources/disconnected
 * Header: x-sp-session
 * Body: { name }
 * Creates a bare DelimitedFile source with no schema yet — the wizard's
 * next step (detect-schema) is what gives it one.
 */
app.post("/api/sources/disconnected", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  const name = String(req.body?.name || "").trim();
  if (!name) return res.status(400).json({ error: "name is required." });
  try {
    const token = await sessionToken(session);
    const resp = await axios.post(
      `https://${tenantApiHost(tenant)}/v2026/sources`,
      {
        name,
        description: name,
        owner: { type: "IDENTITY", id: session.identity?.id, name: session.identity?.username },
        type: "DelimitedFile",
        connector: "delimited-file-angularsc",
        connectorClass: "sailpoint.connector.delimitedfile.DelimitedFileConnector",
        connectorAttributes: {
          connectionType: "file",
          filetransport: "local",
          host: "local",
          delimiter: ",",
          hasHeader: true,
          indexColumns: ["id"],
          indexColumn: "id",
          mergeRows: true,
          filterEmptyRecords: true,
          deleteThresholdPercentage: 10,
          templateApplication: "DelimitedFile Template",
        },
        deleteThreshold: 10,
      },
      { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }
    );
    res.status(201).json(resp.data);
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[sources] disconnected create failed:", err.response?.data || err.message);
    res.status(status).json({ error: err.response?.data?.messages?.[0]?.text || describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/**
 * POST /api/sources/:id/generate-data
 * Body: { prompt, csvBase64 }
 * Sends the source's current account CSV plus the user's (freely edited)
 * instructions to Claude and returns the complete modified CSV. Nothing is
 * saved here — the client shows the result for review, then uploads the
 * header line as the schema and runs a full (unoptimized) account load.
 */
app.post("/api/sources/:id/generate-data", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { prompt, csvBase64 } = req.body || {};
  if (typeof prompt !== "string" || !prompt.trim()) {
    return res.status(400).json({ error: "prompt is required." });
  }
  if (typeof csvBase64 !== "string" || !csvBase64) {
    return res.status(400).json({ error: "csvBase64 is required." });
  }
  try {
    const csv = Buffer.from(csvBase64, "base64").toString("utf8").trim();
    const raw = await claudeGenerateText(
      `${prompt.trim()}

Current CSV data (the first line is the header):
\`\`\`csv
${csv}
\`\`\`

Return ONLY the complete modified CSV — header line first, every row included, no explanation, no code fences.`,
      { maxTokens: 32000 }
    );
    let out = (raw || "").trim();
    const fence = out.match(/^\`\`\`(?:csv)?\s*\n([\s\S]*?)\n\`\`\`$/);
    if (fence) out = fence[1].trim();
    const lines = out.split(/\r?\n/).filter((l) => l.trim() !== "");
    if (lines.length < 1 || !lines[0].includes(",")) {
      return res.status(502).json({ error: "The model didn't return usable CSV — try rewording the prompt." });
    }
    res.json({ csv: lines.join("\n"), rows: lines.length - 1 });
  } catch (err) {
    console.error("[sources] generate-data failed:", err.response?.data || err.message);
    res.status(500).json({ error: describeError(err) });
  }
});

/**
 * POST /api/sources/:id/detect-schema
 * Header: x-sp-session
 * Body: { filename, csvBase64 }
 * Uploads the CSV to ISC's schema-detection endpoint, which both infers the
 * column list AND saves it as the source's live "account" schema in one
 * step, including its own best-guess UID/Account Name attributes (surfaced
 * here as identityAttribute/displayAttribute) — reviewed/overridden by the
 * caller in the next step rather than re-derived client-side.
 */
app.post("/api/sources/:id/detect-schema", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  const { filename, csvBase64 } = req.body || {};
  if (typeof csvBase64 !== "string" || !csvBase64) {
    return res.status(400).json({ error: "csvBase64 is required." });
  }
  const safeFilename = typeof filename === "string" && filename ? filename : "accounts.csv";
  fs.mkdirSync(EDIT_ACCOUNTS_DIR, { recursive: true });
  const tmpPath = path.join(EDIT_ACCOUNTS_DIR, `${crypto.randomBytes(16).toString("hex")}-${safeFilename}`);
  fs.writeFileSync(tmpPath, Buffer.from(csvBase64, "base64"));
  try {
    const token = await sessionToken(session);
    const form = new FormData();
    form.append("file", fs.createReadStream(tmpPath), safeFilename);
    const resp = await axios.post(
      `https://${tenantApiHost(tenant)}/sources/v1/${req.params.id}/schemas/accounts`,
      form,
      { headers: { Authorization: `Bearer ${token}`, ...form.getHeaders() } }
    );
    const schema = resp.data;
    res.json({
      schemaId: schema.id,
      identityAttribute: schema.identityAttribute,
      displayAttribute: schema.displayAttribute,
      attributes: (schema.attributes || []).map((a) => ({ name: a.name, type: a.type, description: a.description || null })),
      raw: schema,
    });
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[sources] detect-schema failed:", err.response?.data || err.message);
    res.status(status).json({ error: err.response?.data?.messages?.[0]?.text || describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  } finally {
    try { fs.unlinkSync(tmpPath); } catch {
      // Already gone or never written — fine either way.
    }
  }
});

/**
 * PUT /api/sources/:id/schemas/:schemaId/uid
 * Header: x-sp-session
 * Body: { identityAttribute, displayAttribute }
 * Applies the reviewer's confirmed UID + Account Name attributes on top of
 * the schema detect-schema already saved — refetches the full schema first
 * since PUT .../schemas/:schemaId requires the whole object, not a patch
 * (verified live).
 */
app.put("/api/sources/:id/schemas/:schemaId/uid", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  const { identityAttribute, displayAttribute, entitlementAttributes } = req.body || {};
  if (!identityAttribute || !displayAttribute) {
    return res.status(400).json({ error: "identityAttribute and displayAttribute are required." });
  }
  if (entitlementAttributes !== undefined && !Array.isArray(entitlementAttributes)) {
    return res.status(400).json({ error: "entitlementAttributes must be an array of attribute names." });
  }
  try {
    const token = await sessionToken(session);
    const current = await iscGet(tenant, token, `/v2026/sources/${req.params.id}/schemas/${req.params.schemaId}`);
    // When the caller sends the entitlement list, it is authoritative for
    // the whole schema: named attributes get isEntitlement (+ isManaged, so
    // they surface in the Access Model), all others are cleared. Entries
    // may be plain names or { name, isMulti } — the object form also sets
    // the attribute's single/multi-valued flag (Entitlement - Single Value
    // vs Entitlement - Multi-value in the editor). Omitting the field
    // leaves the schema's existing flags untouched.
    const entMap = entitlementAttributes === undefined
      ? null
      : new Map(entitlementAttributes.map((e) => (typeof e === "string" ? [e, undefined] : [e?.name, !!e?.isMulti])));
    const attributes = entMap === null
      ? current.attributes
      : (current.attributes || []).map((a) => {
          const on = entMap.has(a.name);
          const isMulti = on && entMap.get(a.name) !== undefined ? entMap.get(a.name) : a.isMulti;
          // isManaged is the real field name (verified live on this
          // tenant's own delimited schemas) — ISC forces it false here
          // regardless, so isEntitlement alone is what takes effect.
          return { ...a, isEntitlement: on, isManaged: on, isMulti };
        });
    const resp = await axios.put(
      `https://${tenantApiHost(tenant)}/v2026/sources/${req.params.id}/schemas/${req.params.schemaId}`,
      { ...current, attributes, identityAttribute, displayAttribute },
      { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }
    );
    res.json(resp.data);
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[sources] schema uid update failed:", err.response?.data || err.message);
    res.status(status).json({ error: err.response?.data?.messages?.[0]?.text || describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/**
 * POST /api/sources/:id/create-identity-profile
 * Header: x-sp-session
 * Body: {} — no input needed beyond the source, which already carries its
 * own confirmed UID/Account Name attributes on its account schema.
 * Asks Claude to match the source's OTHER schema attributes to the tenant's
 * Identity Attributes catalog (uid/displayName are wired directly from the
 * schema's own identityAttribute/displayAttribute, not left to the model),
 * then creates the Identity Profile named "<source name> Profile".
 */
app.post("/api/sources/:id/create-identity-profile", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  try {
    const token = await sessionToken(session);
    const source = await withApiRetry(() => iscGet(tenant, token, `/v2026/sources/${req.params.id}`), { label: "create-identity-profile: fetch source" });
    const schemas = await withApiRetry(() => iscGet(tenant, token, `/v2026/sources/${req.params.id}/schemas`), { label: "create-identity-profile: fetch schemas" });
    const accountSchema = (schemas || []).find((s) => s.name === "account");
    if (!accountSchema) return res.status(422).json({ error: "This source has no account schema yet — upload a CSV first." });
    if (!accountSchema.identityAttribute || !accountSchema.displayAttribute) {
      return res.status(422).json({ error: "This source's UID/Account Name attributes aren't set yet." });
    }

    const identityAttrs = await withApiRetry(
      () => iscGet(tenant, token, "/v2026/identity-attributes", { limit: 250 }),
      { label: "create-identity-profile: identity-attributes catalog" }
    ).catch(() => []);

    // priority must be unique tenant-wide (verified live: a hardcoded 100
    // collided with an existing profile and 400'd "Value of priority should
    // be unique") — one past the current highest keeps every new profile
    // out of the way of whatever's already there.
    const existingProfiles = await withApiRetry(
      () => iscGet(tenant, token, "/v2026/identity-profiles", { limit: 250 }),
      { label: "create-identity-profile: existing profiles for priority" }
    ).catch(() => []);
    const nextPriority = Math.max(0, ...existingProfiles.map((p) => (typeof p.priority === "number" ? p.priority : 0))) + 10;

    const mappedSchemaAttrNames = new Set([accountSchema.identityAttribute, accountSchema.displayAttribute]);
    const remainingSchemaAttrs = (accountSchema.attributes || []).filter((a) => !mappedSchemaAttrNames.has(a.name));
    const aiMapping = await mapSourceAttributesToIdentitySchema(remainingSchemaAttrs, identityAttrs);

    const attributeTransforms = [
      {
        identityAttributeName: "uid",
        transformDefinition: { type: "accountAttribute", attributes: { sourceName: source.name, attributeName: accountSchema.identityAttribute, sourceId: source.id } },
      },
      {
        identityAttributeName: "displayName",
        transformDefinition: { type: "accountAttribute", attributes: { sourceName: source.name, attributeName: accountSchema.displayAttribute, sourceId: source.id } },
      },
      ...aiMapping.map((m) => ({
        identityAttributeName: m.identityAttribute,
        transformDefinition: { type: "accountAttribute", attributes: { sourceName: source.name, attributeName: m.sourceAttribute, sourceId: source.id } },
      })),
    ];

    const profileResp = await axios.post(
      `https://${tenantApiHost(tenant)}/v2026/identity-profiles`,
      {
        name: `${source.name} Profile`,
        description: `Identity Profile for ${source.name}`,
        owner: { type: "IDENTITY", id: session.identity?.id, name: session.identity?.username },
        priority: nextPriority,
        authoritativeSource: { type: "SOURCE", id: source.id },
        identityAttributeConfig: { enabled: true, attributeTransforms },
      },
      { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }
    );

    // Creating the profile only saves its attribute mapping config — the
    // mapping isn't actually applied to any identity until Process
    // Identities runs (verified live: POST .../process-identities -> 202).
    // Without this, "<source name> Profile" would sit there fully
    // configured but every identity attribute it maps would stay empty
    // until ISC's own next scheduled refresh got around to it.
    let applied = true;
    try {
      await withApiRetry(
        () => axios.post(
          `https://${tenantApiHost(tenant)}/v2026/identity-profiles/${profileResp.data.id}/process-identities`,
          {},
          { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }
        ),
        { label: `create-identity-profile: process-identities ${profileResp.data.id}` }
      );
    } catch (applyErr) {
      applied = false;
      console.error("[sources] process-identities failed after profile create:", applyErr.response?.data || applyErr.message);
    }

    res.status(201).json({ profile: profileResp.data, mapping: aiMapping, applied });
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[sources] create-identity-profile failed:", err.response?.data || err.message);
    res.status(status).json({ error: err.response?.data?.messages?.[0]?.text || describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

// Asks Claude to match source schema attributes to the tenant's Identity
// Attributes catalog — the one AI call in this codebase that needs
// structured (not prose) output, so unlike generateDescriptionFromFacts this
// parses the response as JSON rather than taking content[0].text verbatim.
// Low-confidence/no-match attributes are simply left out by the model rather
// than guessed, since a wrong identity attribute mapping is worse than a
// missing one.
async function mapSourceAttributesToIdentitySchema(sourceAttrs, identityAttrs) {
  if (!aiConfigured() || sourceAttrs.length === 0 || identityAttrs.length === 0) return [];

  const sourceList = sourceAttrs.map((a) => `- ${a.name}${a.description ? ` (${a.description})` : ""}`).join("\n");
  const identityList = identityAttrs.map((a) => `- ${a.name}: ${a.displayName}`).join("\n");

  try {
    const raw = await claudeGenerateText(
      `Match each SOURCE ATTRIBUTE below to the single best IDENTITY ATTRIBUTE it should populate, based only on ` +
        `name/description similarity. Skip any source attribute with no confident match — do not guess.\n\n` +
        `SOURCE ATTRIBUTES:\n${sourceList}\n\nIDENTITY ATTRIBUTES:\n${identityList}\n\n` +
        `Respond with ONLY a JSON array, no other text, no markdown fences: ` +
        `[{"sourceAttribute": "...", "identityAttribute": "..."}]`,
      { maxTokens: 1000 }
    );
    const text = (raw || "").replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    const sourceNames = new Set(sourceAttrs.map((a) => a.name));
    const identityNames = new Set(identityAttrs.map((a) => a.name));
    return parsed.filter((m) => m?.sourceAttribute && m?.identityAttribute && sourceNames.has(m.sourceAttribute) && identityNames.has(m.identityAttribute));
  } catch (err) {
    console.error("[sources] AI schema mapping failed, continuing with no extra mappings:", err.response?.data || err.message);
    return [];
  }
}

/**
 * POST /api/sources/:id/sync-identity-profile
 * Header: x-sp-session
 * Reconciles this source's Identity Profile's attribute mappings against its
 * CURRENT account schema, rather than requiring a full recreate: any schema
 * attribute with no mapping yet gets one proposed by AI (same matching
 * create-identity-profile uses), and any existing mapping that points at an
 * account attribute the schema no longer has gets dropped. Everything else —
 * mappings still backed by a real schema attribute, and any mapping that
 * isn't an accountAttribute transform from this source at all (manager,
 * static values, rules, ...) — is left completely untouched.
 *
 * The uid/displayName mappings created at profile-creation time are treated
 * as fixed, not synced: schema editing already refuses to let those columns
 * be deleted (see PUT .../account-schema above), so they can't go stale this
 * way, and re-proposing them would just be redundant.
 *
 * Sent as a single JSON-Patch "replace" of the whole attributeTransforms
 * array rather than per-item add/remove ops — much simpler than juggling
 * shifting array indices for a mix of removals and additions in one request.
 *
 * A new schema attribute AI can't confidently match (including every one of
 * them when AI isn't configured at all — mapSourceAttributesToIdentitySchema
 * just returns [] rather than erroring) is reported back as unmatchedNames
 * rather than silently counted as "nothing to do" — it found something
 * real, it just couldn't act on it automatically.
 */
app.post("/api/sources/:id/sync-identity-profile", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  const sourceId = req.params.id;
  try {
    const token = await sessionToken(session);
    const source = await withApiRetry(() => iscGet(tenant, token, `/v2026/sources/${sourceId}`), { label: "sync-identity-profile: fetch source" });
    const profiles = await withApiRetry(
      () => iscGet(tenant, token, "/v2026/identity-profiles", { limit: 250 }),
      { label: "sync-identity-profile: lookup" }
    );
    const profileStub = profiles.find((p) => p.authoritativeSource?.id === sourceId);
    if (!profileStub) return res.status(404).json({ error: "This source has no Identity Profile." });

    const [detail, schemas, identityAttrs] = await Promise.all([
      withApiRetry(() => iscGet(tenant, token, `/v2026/identity-profiles/${profileStub.id}`), { label: "sync-identity-profile: profile detail" }),
      withApiRetry(() => iscGet(tenant, token, `/v2026/sources/${sourceId}/schemas`), { label: "sync-identity-profile: schemas" }),
      withApiRetry(
        () => iscGet(tenant, token, "/v2026/identity-attributes", { limit: 250 }),
        { label: "sync-identity-profile: identity-attributes catalog" }
      ).catch(() => []),
    ]);

    const accountSchema = (schemas || []).find((s) => s.name === "account");
    if (!accountSchema) return res.status(422).json({ error: "This source has no account schema." });

    const isThisSourceAccountAttr = (t) =>
      t.transformDefinition?.type === "accountAttribute" && t.transformDefinition.attributes?.sourceId === sourceId;

    const currentTransforms = detail.identityAttributeConfig?.attributeTransforms || [];
    const currentSchemaAttrNames = new Set((accountSchema.attributes || []).map((a) => a.name));

    // Stale: mapped from one of this source's account attributes, but that
    // attribute isn't on the schema anymore.
    const staleSet = new Set(
      currentTransforms.filter((t) => isThisSourceAccountAttr(t) && !currentSchemaAttrNames.has(t.transformDefinition.attributes.attributeName))
    );
    const kept = currentTransforms.filter((t) => !staleSet.has(t));

    // New: schema attributes with no existing mapping from this source yet,
    // excluding the identityAttribute/displayAttribute columns already wired
    // to uid/displayName at profile-creation time.
    const mappedSourceAttrNames = new Set(kept.filter(isThisSourceAccountAttr).map((t) => t.transformDefinition.attributes.attributeName));
    const mappedIdentityAttrNames = new Set(kept.map((t) => t.identityAttributeName));
    const skipNames = new Set([accountSchema.identityAttribute, accountSchema.displayAttribute].filter(Boolean));
    const newSchemaAttrs = (accountSchema.attributes || []).filter((a) => !skipNames.has(a.name) && !mappedSourceAttrNames.has(a.name));

    let added = [];
    if (newSchemaAttrs.length > 0) {
      const candidateIdentityAttrs = (identityAttrs || []).filter((a) => !mappedIdentityAttrNames.has(a.name));
      const aiMapping = await mapSourceAttributesToIdentitySchema(newSchemaAttrs, candidateIdentityAttrs);
      added = aiMapping.map((m) => ({
        identityAttributeName: m.identityAttribute,
        transformDefinition: { type: "accountAttribute", attributes: { sourceName: source.name, attributeName: m.sourceAttribute, sourceId } },
      }));
    }

    // A new schema attribute with no confident AI match (including every
    // one of them, when AI isn't configured at all — mapSourceAttributesTo-
    // IdentitySchema just returns [] rather than erroring) is real,
    // reportable state: it's not "up to date", it's "found but couldn't be
    // auto-mapped". Surfacing that distinctly is the whole point of this
    // response — silently folding it into "nothing changed" is exactly the
    // bug this endpoint existed to avoid on the removal side.
    const addedNames = new Set(added.map((t) => t.transformDefinition.attributes.attributeName));
    const unmatchedNames = newSchemaAttrs.filter((a) => !addedNames.has(a.name)).map((a) => a.name);

    if (staleSet.size === 0 && added.length === 0) {
      return res.json({ changed: false, added: 0, removed: 0, unmatchedNames });
    }

    const attributeTransforms = [...kept, ...added];
    await axios.patch(
      `https://${tenantApiHost(tenant)}/v2026/identity-profiles/${profileStub.id}`,
      [{ op: "replace", path: "/identityAttributeConfig/attributeTransforms", value: attributeTransforms }],
      { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json-patch+json" } }
    );

    // Same as profile creation — a newly-added mapping sits configured but
    // empty on every identity until Process Identities actually runs.
    let applied = true;
    try {
      await withApiRetry(
        () => axios.post(
          `https://${tenantApiHost(tenant)}/v2026/identity-profiles/${profileStub.id}/process-identities`,
          {},
          { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }
        ),
        { label: `sync-identity-profile: process-identities ${profileStub.id}` }
      );
    } catch (applyErr) {
      applied = false;
      console.error("[sources] process-identities failed after sync:", applyErr.response?.data || applyErr.message);
    }

    res.json({ changed: true, added: added.length, removed: staleSet.size, unmatchedNames, applied });
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[sources] sync-identity-profile failed:", err.response?.data || err.message);
    res.status(status).json({
      error: err.response?.data?.messages?.[0]?.text || describeError(err),
      ...(err.sessionExpired ? { sessionExpired: true } : {}),
    });
  }
});

// ─── Source description generation ─────────────────────────────────────────
// Same shape as generateAccessProfileDescriptionText/generateSourceAppDescriptionText
// above — fetches the source and asks Claude for a description grounded in
// its actual data, without writing anything back.
async function generateSourceDescriptionText(tenant, token, sourceId) {
  const source = await withApiRetry(() => iscGet(tenant, token, `/v2026/sources/${sourceId}`), { label: `generate-description: fetch source ${sourceId}` });

  const facts = [
    `Source name: ${source.name}`,
    `Connector type: ${source.connectorName || source.type || "unknown"}`,
    `Authoritative source: ${source.authoritative ? "yes" : "no"}`,
    `Currently healthy: ${source.healthy ? "yes" : "no"}`,
    `Owner: ${source.owner?.name || "none"}`,
  ];
  if (source.cluster?.name) facts.push(`Cluster: ${source.cluster.name}`);
  if (source.managementWorkgroup?.name) facts.push(`Management workgroup: ${source.managementWorkgroup.name}`);

  // ISC caps a source description at 255 characters (verified: longer
  // values are rejected on save), so generation is held to that too.
  return generateDescriptionFromFacts(facts, "This Source", { maxLength: SOURCE_DESCRIPTION_MAX_LENGTH });
}

/**
 * POST /api/sources/:id/generate-description
 * Header: x-sp-session
 * Same idea as POST /api/access-profiles/:id/generate-description: asks
 * Claude for a description grounded in the source's actual current data,
 * never writes anything itself — the client shows the suggestion alongside
 * the current description and applies it via PATCH .../sources/:id once the
 * user confirms.
 */
app.post("/api/sources/:id/generate-description", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;

  if (!aiConfigured()) {
    return res.status(503).json({ error: "AI description generation isn't configured on this server." });
  }

  try {
    const token = await sessionToken(session);
    const description = await generateSourceDescriptionText(tenant, token, req.params.id);
    res.json({ description });
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[sources] generate-description failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/**
 * POST /api/insights/source-descriptions/generate-all
 * Header: x-sp-session
 * Body: { sourceIds: string[] }
 * Same pattern as POST /api/insights/access-profile-descriptions/generate-all
 * — bounded concurrency, continues past individual failures, returns
 * suggestions only (nothing written). Each result is keyed "roleId" (not
 * "sourceId") so the client can reuse BulkDescriptionReviewSheet as-is.
 */
app.post("/api/insights/source-descriptions/generate-all", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  const sourceIds = req.body?.sourceIds;
  if (!Array.isArray(sourceIds) || sourceIds.length === 0) {
    return res.status(400).json({ error: "sourceIds must be a non-empty array." });
  }
  if (!aiConfigured()) {
    return res.status(503).json({ error: "AI description generation isn't configured on this server." });
  }

  try {
    const token = await sessionToken(session);
    const results = await mapWithConcurrency(sourceIds, 3, async (sourceId) => {
      try {
        const description = await generateSourceDescriptionText(tenant, token, sourceId);
        return { roleId: sourceId, description };
      } catch (err) {
        console.error(`[insights] source-descriptions generate-all: source ${sourceId} failed:`, err.response?.data || err.message);
        return { roleId: sourceId, error: describeError(err) };
      }
    });
    res.json({ results });
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[insights] source-descriptions generate-all failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/**
 * PATCH /api/sources/:id/description
 * Body: { description: string }
 * Same JSON Patch requirement as PATCH /api/access-profiles/:id (SailPoint
 * rejects a plain application/json PATCH here too), not routed through the
 * generic /api/isc/* proxy for that reason — scoped to just description
 * since that's the only field this app currently needs to write back to a
 * Source.
 */
const SOURCE_DESCRIPTION_MAX_LENGTH = 255;
app.patch("/api/sources/:id/description", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  const { description } = req.body || {};
  if (description === undefined) {
    return res.status(400).json({ error: "description is required." });
  }
  if (typeof description === "string" && description.length > SOURCE_DESCRIPTION_MAX_LENGTH) {
    return res.status(400).json({ error: `Source descriptions are limited to ${SOURCE_DESCRIPTION_MAX_LENGTH} characters (this one is ${description.length}).` });
  }

  try {
    const token = await sessionToken(session);
    const resp = await axios.patch(
      `https://${tenantApiHost(tenant)}/v2026/sources/${req.params.id}`,
      [{ op: "replace", path: "/description", value: description }],
      { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json-patch+json" } }
    );
    res.json(resp.data);
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[sources] update description failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/**
 * PATCH /api/sources/:id
 * Body: any of { name, description, owner: {id,name},
 * managementWorkgroup: {id,name} | null } — the Source edit dialog. ISC's
 * Source has no additionalOwners list; its one extra-owner slot is the
 * management workgroup (a governance group whose members administer the
 * source), so that's what the dialog's "Additional owners" edits. null
 * clears it.
 */
app.patch("/api/sources/:id", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  const { name, description, owner, managementWorkgroup } = req.body || {};

  const ops = [];
  if (name !== undefined) {
    if (!name || !String(name).trim()) return res.status(400).json({ error: "name can't be empty." });
    ops.push({ op: "replace", path: "/name", value: String(name).trim() });
  }
  if (description !== undefined) {
    if (typeof description === "string" && description.length > SOURCE_DESCRIPTION_MAX_LENGTH) {
      return res.status(400).json({ error: `Source descriptions are limited to ${SOURCE_DESCRIPTION_MAX_LENGTH} characters (this one is ${description.length}).` });
    }
    ops.push({ op: "replace", path: "/description", value: description });
  }
  if (owner !== undefined) {
    if (!owner?.id) return res.status(400).json({ error: "owner must have an id." });
    ops.push({ op: "replace", path: "/owner", value: { type: "IDENTITY", id: owner.id, name: owner.name } });
  }
  if (managementWorkgroup !== undefined) {
    if (managementWorkgroup === null) ops.push({ op: "remove", path: "/managementWorkgroup" });
    else if (!managementWorkgroup?.id) return res.status(400).json({ error: "managementWorkgroup must have an id." });
    // "add" sets the member whether or not the source already has one.
    else ops.push({ op: "add", path: "/managementWorkgroup", value: { type: "GOVERNANCE_GROUP", id: managementWorkgroup.id, name: managementWorkgroup.name } });
  }
  if (ops.length === 0) return res.status(400).json({ error: "Provide at least one field to update." });

  try {
    const token = await sessionToken(session);
    const resp = await axios.patch(
      `https://${tenantApiHost(tenant)}/v2026/sources/${encodeURIComponent(req.params.id)}`,
      ops,
      { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json-patch+json" } }
    );
    res.json(resp.data);
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[sources] edit failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

// ─── Source Applications ────────────────────────────────────────────────────
// ISC's "Applications" (Access Model > Applications in its own UI) — each
// belongs to exactly one source (accountSource). NOT /v2026/source-apps —
// that experimental v2026 surface returns an empty list/count for this
// tenant regardless of query params (verified live), while the legacy
// source-apps/v1/* endpoints (no /v2026 or /beta prefix, just the tenant
// host) return the real data — confirmed live against this tenant's
// Active Directory source, which has real Applications ("Accounting",
// "Corporate Network Access") only visible via v1.
const SOURCE_APPS_HEADERS = { "X-SailPoint-Experimental": "true" };
const SOURCE_APPS_V1 = "source-apps/v1";

/** GET /api/sources/:id/apps — every Application configured on this source, sorted by name. */
app.get("/api/sources/:id/apps", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  try {
    const token = await sessionToken(session);
    const resp = await axios.get(`https://${tenantApiHost(tenant)}/${SOURCE_APPS_V1}/all`, {
      params: { filters: `accountSource.id eq "${req.params.id}"` },
      headers: { Authorization: `Bearer ${token}`, ...SOURCE_APPS_HEADERS },
    });
    const apps = (resp.data || []).sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    res.json(apps);
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[source-apps] list failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/**
 * GET /api/sources/:id/datasets
 * Header: x-sp-session
 * A source's datasets — the sample data ISC keeps from account/group
 * aggregation. Same un-versioned tenant-host surface as source-apps above
 * (no /v2026 or /beta prefix): /sources/v1/{id}/datasets, which is also the
 * prefix this file already uses for schema detection (see detect-schema).
 * Returned as-is apart from sorting. Shape per the SailPoint Go SDK's
 * SourceDataset model: { id, name, description, aggregationEnabled,
 * resources: [{ id, name, type }] } — no paging params on the list call.
 */
app.get("/api/sources/:id/datasets", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  try {
    const token = await sessionToken(session);
    // This surface is gated behind the same experimental header source-apps
    // needs (see SOURCE_APPS_HEADERS above) — without it the API rejects the
    // call outright with 400 "Experimental Header 'X-SailPoint-Experimental'
    // is missing or invalid", even though the path and token are fine.
    const data = await iscGet(tenant, token, `/sources/v1/${req.params.id}/datasets`, undefined, {
      "X-SailPoint-Experimental": "true",
    });
    // Either a bare array or a paged {items:[...]}-style envelope, depending
    // on what this surface returns for the tenant — normalised to an array
    // so the client never has to guess.
    const list = Array.isArray(data) ? data : (data?.items || data?.data || []);
    const sorted = [...list].sort((a, b) =>
      String(a?.name || a?.id || "").localeCompare(String(b?.name || b?.id || ""))
    );
    res.json(sorted);
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[sources] datasets list failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/**
 * POST /api/sources/:id/datasets/:datasetId/aggregate
 * Header: x-sp-session
 * Runs aggregation for one dataset. Path and body per the SailPoint Go SDK's
 * ImportSourceDatasetV1: POST /sources/v1/{sourceId}/datasets/{datasetId}/aggregate
 * with a DatasetAggregationRequest whose only field, `config`, is an optional
 * connector-specific map — sent empty here, same as triggering it from ISC's
 * own UI with no overrides. Same experimental-header gate as the list call.
 */
app.post("/api/sources/:id/datasets/:datasetId/aggregate", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  try {
    const token = await sessionToken(session);
    const resp = await axios.post(
      `https://${tenantApiHost(tenant)}/sources/v1/${req.params.id}/datasets/${req.params.datasetId}/aggregate`,
      { config: {} },
      { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-SailPoint-Experimental": "true" } }
    );
    res.json(resp.data ?? {});
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[sources] dataset aggregate failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/**
 * PATCH /api/sources/:id/datasets/:datasetId
 * Header: x-sp-session
 * Body: RFC 6902 ops array (built client-side from a top-level diff, same as
 * RawJsonPanel's buildPatchOps). Per the SailPoint Go SDK's
 * UpdateSourceDatasetV1: PATCH /sources/v1/{sourceId}/datasets/{datasetId}
 * with jsonPatchOperation[]. PUT (PutSourceDatasetV1) exists too, but a
 * patch of only what changed is what every other raw-JSON editor here sends.
 */
app.patch("/api/sources/:id/datasets/:datasetId", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  const ops = req.body;
  if (!Array.isArray(ops) || ops.length === 0) {
    return res.status(400).json({ error: "A non-empty JSON Patch ops array is required." });
  }
  try {
    const token = await sessionToken(session);
    const resp = await axios.patch(
      `https://${tenantApiHost(tenant)}/sources/v1/${req.params.id}/datasets/${req.params.datasetId}`,
      ops,
      { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json-patch+json", "X-SailPoint-Experimental": "true" } }
    );
    res.json(resp.data ?? {});
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    // The ops are half the story for a 400 here (the endpoint whitelists
    // patchable fields — see the client's DATASET_PATCHABLE); ISC's `causes`
    // array is the other half, and console.error's default depth collapsed
    // it to "[Object]" (verified live), so stringify the whole reply.
    console.error("[sources] dataset update failed:", JSON.stringify({ ops, response: err.response?.data || err.message }, null, 2));
    // messages[] carries the generic 400.1 text (twice, once per locale);
    // causes[] carries the specific reason — surface both, deduped.
    const data = err.response?.data;
    const texts = [];
    for (const m of [...(data?.messages || []), ...(data?.causes || [])]) {
      if (m?.text && !texts.includes(m.text)) texts.push(m.text);
    }
    res.status(status).json({ error: texts.length ? texts.join(" — ") : describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/**
 * GET /api/sources/:id/resources
 * Header: x-sp-session
 * A source's resources — the objects a dataset is made of (per the SDK's
 * SourceDatasetResource model: { id, name, type, datasetId, features,
 * schema }). Same un-versioned /sources/v1 surface and experimental-header
 * gate as datasets; normalised to an array and sorted by name.
 */
app.get("/api/sources/:id/resources", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  try {
    const token = await sessionToken(session);
    const data = await iscGet(tenant, token, `/sources/v1/${req.params.id}/resources`, undefined, {
      "X-SailPoint-Experimental": "true",
    });
    const list = Array.isArray(data) ? data : (data?.items || data?.data || []);
    const sorted = [...list].sort((a, b) =>
      String(a?.name || a?.id || "").localeCompare(String(b?.name || b?.id || ""))
    );
    res.json(sorted);
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[sources] resources list failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/**
 * PATCH /api/sources/:id/resources/:resourceId
 * Header: x-sp-session
 * Body: RFC 6902 ops array (client-built top-level diff, same as datasets).
 * Per the SDK's UpdateSourceResourceV1: PATCH /sources/v1/{sourceId}/resources/{resourceId}.
 * Its rules are looser on paper than the dataset endpoint's — "connectors
 * with the supportDatasetCreation label can update additional resource
 * fields", with no field promised as always-writable, and schema edits are
 * directed to the schema APIs — so the client keeps the diff to name/type/
 * datasetId/features and this route surfaces ISC's own causes on a 400.
 */
app.patch("/api/sources/:id/resources/:resourceId", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  const ops = req.body;
  if (!Array.isArray(ops) || ops.length === 0) {
    return res.status(400).json({ error: "A non-empty JSON Patch ops array is required." });
  }
  try {
    const token = await sessionToken(session);
    const resp = await axios.patch(
      `https://${tenantApiHost(tenant)}/sources/v1/${req.params.id}/resources/${req.params.resourceId}`,
      ops,
      { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json-patch+json", "X-SailPoint-Experimental": "true" } }
    );
    res.json(resp.data ?? {});
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[sources] resource update failed:", JSON.stringify({ ops, response: err.response?.data || err.message }, null, 2));
    const data = err.response?.data;
    const texts = [];
    for (const m of [...(data?.messages || []), ...(data?.causes || [])]) {
      if (m?.text && !texts.includes(m.text)) texts.push(m.text);
    }
    res.status(status).json({ error: texts.length ? texts.join(" — ") : describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/** GET /api/apps — every Application tenant-wide (across all sources), sorted by name. */
app.get("/api/apps", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  try {
    const token = await sessionToken(session);
    const resp = await axios.get(`https://${tenantApiHost(tenant)}/${SOURCE_APPS_V1}/all`, {
      headers: { Authorization: `Bearer ${token}`, ...SOURCE_APPS_HEADERS },
    });
    const apps = (resp.data || []).sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    res.json(apps);
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[source-apps] list-all failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/**
 * POST /api/sources/:id/apps
 * Body: { name, description?, owner?: {id,name}, matchAllAccounts? }
 * matchAllAccounts defaults true (an Application with no narrower
 * account-matching criteria built here covers every account on the
 * source, same as ISC's own "quick create") — the client's Specific
 * Users/All Users dropdown can override it to false.
 */
app.post("/api/sources/:id/apps", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  const name = String(req.body?.name || "").trim();
  if (!name) return res.status(400).json({ error: "name is required." });
  try {
    const token = await sessionToken(session);
    const body = {
      name,
      // Defaults to the name itself — the create dialog doesn't collect a
      // description; Generate Descriptions replaces this with a real one
      // once the app has enough data (access profiles) to ground one in.
      description: req.body?.description || name,
      matchAllAccounts: req.body?.matchAllAccounts !== undefined ? !!req.body.matchAllAccounts : true,
      accountSource: { id: req.params.id },
    };
    if (req.body?.owner?.id) body.owner = { id: req.body.owner.id };
    const resp = await axios.post(
      `https://${tenantApiHost(tenant)}/${SOURCE_APPS_V1}`,
      body,
      { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...SOURCE_APPS_HEADERS } }
    );
    res.status(201).json(resp.data);
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[source-apps] create failed:", err.response?.data || err.message);
    res.status(status).json({ error: err.response?.data?.messages?.[0]?.text || describeError(err) });
  }
});

/** GET /api/source-apps/:id — single Application, for the detail page. */
app.get("/api/source-apps/:id", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  try {
    const token = await sessionToken(session);
    const resp = await axios.get(`https://${tenantApiHost(tenant)}/${SOURCE_APPS_V1}/${req.params.id}`, {
      headers: { Authorization: `Bearer ${token}`, ...SOURCE_APPS_HEADERS },
    });
    res.json(resp.data);
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[source-apps] get failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/** DELETE /api/source-apps/:id */
app.delete("/api/source-apps/:id", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  try {
    const token = await sessionToken(session);
    await axios.delete(`https://${tenantApiHost(tenant)}/${SOURCE_APPS_V1}/${req.params.id}`, {
      headers: { Authorization: `Bearer ${token}`, ...SOURCE_APPS_HEADERS },
    });
    res.status(204).end();
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[source-apps] delete failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/**
 * PATCH /api/source-apps/:id
 * Body: any of { name, description, owner: {id,name}, matchAllAccounts,
 * appCenterEnabled ("Visible"), provisionRequestEnabled ("Requestable") }
 * — same JSON Patch approach as roles/access-profiles. Builds one PATCH op
 * per field actually present in the body, so a single-field toggle (e.g.
 * clicking the Visible pill) doesn't have to resend the whole record.
 */
app.patch("/api/source-apps/:id", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  const body = req.body || {};

  const ops = [];
  if (body.name !== undefined) ops.push({ op: "replace", path: "/name", value: body.name });
  if (body.description !== undefined) ops.push({ op: "replace", path: "/description", value: body.description });
  if (body.owner?.id) ops.push({ op: "replace", path: "/owner", value: { id: body.owner.id } });
  if (body.matchAllAccounts !== undefined) ops.push({ op: "replace", path: "/matchAllAccounts", value: !!body.matchAllAccounts });
  if (body.enabled !== undefined) ops.push({ op: "replace", path: "/enabled", value: !!body.enabled });
  if (body.appCenterEnabled !== undefined) ops.push({ op: "replace", path: "/appCenterEnabled", value: !!body.appCenterEnabled });
  if (body.provisionRequestEnabled !== undefined) ops.push({ op: "replace", path: "/provisionRequestEnabled", value: !!body.provisionRequestEnabled });
  if (ops.length === 0) {
    return res.status(400).json({ error: "Provide at least one field to update." });
  }

  try {
    const token = await sessionToken(session);
    const resp = await axios.patch(
      `https://${tenantApiHost(tenant)}/${SOURCE_APPS_V1}/${req.params.id}`,
      ops,
      { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json-patch+json", ...SOURCE_APPS_HEADERS } }
    );
    res.json(resp.data);
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[source-apps] update failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/** GET /api/source-apps/:id/access-profiles — the Access Profiles assigned to this Application. */
app.get("/api/source-apps/:id/access-profiles", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  try {
    const token = await sessionToken(session);
    const resp = await axios.get(`https://${tenantApiHost(tenant)}/${SOURCE_APPS_V1}/${req.params.id}/access-profiles`, {
      headers: { Authorization: `Bearer ${token}`, ...SOURCE_APPS_HEADERS },
    });
    res.json(resp.data);
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[source-apps] access-profiles failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/**
 * POST /api/source-apps/:id/access-profiles
 * Body: { add?: string[], remove?: string[] } — access profile ids.
 * Add uses a plain POST of the id array to ISC's own .../access-profiles
 * collection endpoint; remove uses its documented bulk-remove sibling.
 * Both verified live against this tenant (attach/detach a real access
 * profile to/from a throwaway app, confirmed via a follow-up GET, then
 * confirmed the access profile itself was untouched after cleanup).
 */
app.post("/api/source-apps/:id/access-profiles", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  const add = Array.isArray(req.body?.add) ? req.body.add : [];
  const remove = Array.isArray(req.body?.remove) ? req.body.remove : [];
  if (add.length === 0 && remove.length === 0) {
    return res.status(400).json({ error: "Provide add and/or remove access profile ids." });
  }
  try {
    const token = await sessionToken(session);
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...SOURCE_APPS_HEADERS };
    if (add.length > 0) {
      // ISC's own POST .../access-profiles REPLACES the app's whole
      // assigned list rather than appending to it (verified live: adding
      // a second profile silently dropped the first) — so this reads the
      // currently-assigned ids first and posts the union, making "add"
      // actually additive from the caller's perspective.
      const current = await axios.get(`https://${tenantApiHost(tenant)}/${SOURCE_APPS_V1}/${req.params.id}/access-profiles`, { headers });
      const currentIds = (current.data || []).map((p) => p.id);
      const merged = [...new Set([...currentIds, ...add])];
      await axios.post(`https://${tenantApiHost(tenant)}/${SOURCE_APPS_V1}/${req.params.id}/access-profiles`, merged, { headers });
    }
    if (remove.length > 0) {
      await axios.post(`https://${tenantApiHost(tenant)}/${SOURCE_APPS_V1}/${req.params.id}/access-profiles/bulk-remove`, remove, { headers });
    }
    const resp = await axios.get(`https://${tenantApiHost(tenant)}/${SOURCE_APPS_V1}/${req.params.id}/access-profiles`, { headers });
    res.json(resp.data);
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[source-apps] update access-profiles failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

// Shared by the single-app route and its bulk generate-all counterpart.
async function generateSourceAppDescriptionText(tenant, token, appId) {
  const resp = await withApiRetry(
    () => axios.get(`https://${tenantApiHost(tenant)}/${SOURCE_APPS_V1}/${appId}`, {
      headers: { Authorization: `Bearer ${token}`, ...SOURCE_APPS_HEADERS },
    }),
    { label: `generate-description: fetch source app ${appId}` }
  );
  const app_ = resp.data;
  const facts = [
    `Application name: ${app_.name}`,
    `Source: ${app_.accountSource?.name || "unknown"}`,
    `Enabled: ${app_.enabled ? "yes" : "no"}`,
    `Matches all accounts on the source: ${app_.matchAllAccounts ? "yes" : "no"}`,
  ];
  return generateDescriptionFromFacts(facts, "This Application");
}

/**
 * POST /api/source-apps/:id/generate-description
 * Header: x-sp-session
 * Same idea as the role/access-profile generate-description routes — never
 * writes anything itself, client applies via PATCH .../source-apps/:id.
 */
app.post("/api/source-apps/:id/generate-description", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  if (!aiConfigured()) {
    return res.status(503).json({ error: "AI description generation isn't configured on this server." });
  }
  try {
    const token = await sessionToken(session);
    const description = await generateSourceAppDescriptionText(tenant, token, req.params.id);
    res.json({ description });
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[source-apps] generate-description failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/**
 * POST /api/insights/source-app-descriptions/generate-all
 * Body: { appIds: string[] }
 * Same pattern as the role/access-profile bulk generate-all routes — bounded
 * concurrency, per-app error isolation, results keyed "roleId" so the
 * client reuses BulkDescriptionReviewSheet unchanged.
 */
app.post("/api/insights/source-app-descriptions/generate-all", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  const appIds = req.body?.appIds;
  if (!Array.isArray(appIds) || appIds.length === 0) {
    return res.status(400).json({ error: "appIds must be a non-empty array." });
  }
  if (!aiConfigured()) {
    return res.status(503).json({ error: "AI description generation isn't configured on this server." });
  }
  try {
    const token = await sessionToken(session);
    const results = await mapWithConcurrency(appIds, 3, async (appId) => {
      try {
        const description = await generateSourceAppDescriptionText(tenant, token, appId);
        return { roleId: appId, description };
      } catch (err) {
        console.error(`[insights] source-app-descriptions generate-all: app ${appId} failed:`, err.response?.data || err.message);
        return { roleId: appId, error: describeError(err) };
      }
    });
    res.json({ results });
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[insights] source-app-descriptions generate-all failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

// ─── Workflows: AI flowchart ─────────────────────────────────────────────────

// ISC's workflow endpoints answer a rejected save / enable with
//   { message: "Please fix the following validation errors…", details: { "Error 1": "step '…' has errors: …" } }
// — the message alone says nothing; the reasons are in `details`. (Its other
// endpoints use messages[0].text.) One place that reads every shape.
function iscWorkflowErrorText(err) {
  const data = err.response?.data;
  const head = data?.messages?.[0]?.text || data?.message || data?.error || describeError(err);
  const details = data?.details;
  const lines =
    details && typeof details === "object"
      ? Object.values(details).flat().filter((d) => typeof d === "string" && d.trim())
      : typeof details === "string" && details.trim()
      ? [details]
      : [];
  return lines.length ? `${head}\n${lines.map((l) => `• ${l}`).join("\n")}` : head;
}

// ─── Metadata value detail (Metadata > attribute > value) ───────────────────
// What one Access Model Metadata value is attached to. Roles, access profiles
// and entitlements carry the tag themselves and are found with ISC Search's
// @accessModelMetadata() nested query (the form already verified for
// searchAccessIdsByMetadata). Identities are deliberately not covered — they
// are never tagged, only hold things that are.
const METADATA_ACCESS_INDICES = { roles: "roles", accessprofiles: "accessprofiles", entitlements: "entitlements" };
const metadataValueQuery = (key, value) => `@accessModelMetadata(key:${key} AND value:"${String(value).replace(/(["\\])/g, "\\$1")}")`;
// A metadata key goes into the query unquoted; keep it to what ISC allows in one.
const isSafeMetadataKey = (key) => /^[A-Za-z0-9_.-]+$/.test(String(key));

async function iscSearchPage(tenant, token, body, { limit, offset = 0, count = false } = {}) {
  const resp = await axios.post(`https://${tenantApiHost(tenant)}/v2026/search`, body, {
    params: { limit, offset, ...(count ? { count: true } : {}) },
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
  });
  const total = resp.headers?.["x-total-count"];
  return { items: Array.isArray(resp.data) ? resp.data : [], total: total != null ? Number(total) : null };
}

/**
 * GET /api/metadata/:key/values/:value/access?type=roles|accessprofiles|entitlements&offset&limit
 * The items of one type tagged with this value, by name: { items, total }.
 */
app.get("/api/metadata/:key/values/:value/access", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const index = METADATA_ACCESS_INDICES[req.query.type];
  if (!index) return res.status(400).json({ error: "type must be roles, accessprofiles or entitlements." });
  if (!isSafeMetadataKey(req.params.key)) return res.status(400).json({ error: "That metadata key can't be searched." });
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 250);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  try {
    const { items, total } = await iscSearchPage(
      session.tenant,
      await sessionToken(session),
      {
        indices: [index],
        query: { query: metadataValueQuery(req.params.key, req.params.value) },
        sort: ["name"],
        queryResultFilter: { includes: ["id", "name", "displayName", "description", "enabled", "requestable", "privileged", "source.id", "source.name", "attribute", "value", "owner.name"] },
      },
      { limit, offset, count: true }
    );
    res.json({ items, total: total ?? items.length });
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[metadata] value access failed:", err.response?.data || err.message);
    res.status(status).json({ error: err.response?.data?.messages?.[0]?.text || describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

// ─── Campaign reports (Browse > User Certifications) ────────────────────────
// ISC's four per-campaign reports. GET /campaigns/{id}/reports lists the last
// result of each ({ id, reportType, status, lastRunAt } — verified live), and
// GET /reports/{resultId}?fileFormat=csv|pdf downloads one. That download is
// content-negotiated: asking for JSON gets a 406 "No match for accept header"
// (verified live), which is why this isn't left to the generic JSON proxy.
const CAMPAIGN_REPORT_TYPES = {
  CAMPAIGN_COMPOSITION_REPORT: "Campaign Composition Report",
  CAMPAIGN_REMEDIATION_STATUS_REPORT: "Campaign Remediation Status Report",
  CAMPAIGN_STATUS_REPORT: "Campaign Status Report",
  CERTIFICATION_SIGNOFF_REPORT: "Certification Signoff Report",
};
const CAMPAIGN_REPORT_MAX_CAMPAIGNS = 25;
const CAMPAIGN_REPORT_POLL_MS = 3000;
const CAMPAIGN_REPORT_POLL_TRIES = 15; // ~45s per report that has to be (re)run
// ISC runs one operation per campaign at a time: asking for a report while a
// remediation scan (or another report) is still running gets 400
// "400.2.0 Operation in progress — A conflicting operation is already in
// progress" (seen live, right after a scan). That's "not yet", not "no".
const CAMPAIGN_CONFLICT_RETRY_MS = 8000;
const CAMPAIGN_CONFLICT_RETRIES = 12; // ~95s
const isCampaignConflict = (err) =>
  err.response?.status === 400 &&
  (String(err.response?.data?.detailCode || "").startsWith("400.2.0") ||
    /conflicting operation/i.test(JSON.stringify(err.response?.data?.messages || "")));

// Minimal RFC-4180 reader/writer for consolidating report CSVs: quoted fields,
// doubled quotes, commas and newlines inside quotes, \r\n or \n, optional BOM.
function parseCsvRows(text) {
  const src = String(text || "").replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => v !== ""));
}
const csvCell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;

// One CSV per report type across every campaign: a leading "Campaign" column
// says which campaign each row came from, and the header is the union of the
// campaigns' own headers in first-seen order (a Machine Account campaign's
// report doesn't have exactly the columns a Search campaign's does), so no
// column is dropped and a campaign that lacks one just leaves it empty.
function consolidateCampaignCsvs(files) {
  const header = [];
  const seen = new Set();
  const parsed = files.map((f) => {
    const rows = parseCsvRows(f.buffer.toString("utf8"));
    const cols = rows[0] || [];
    for (const c of cols) if (!seen.has(c)) { seen.add(c); header.push(c); }
    return { campaign: f.campaign, cols, body: rows.slice(1) };
  });
  const lines = [["Campaign", ...header].map(csvCell).join(",")];
  let rowCount = 0;
  for (const { campaign, cols, body } of parsed) {
    const at = new Map(cols.map((c, i) => [c, i]));
    for (const r of body) {
      lines.push([campaign, ...header.map((h) => (at.has(h) ? r[at.get(h)] ?? "" : ""))].map(csvCell).join(","));
      rowCount++;
    }
  }
  return { buffer: Buffer.from("\uFEFF" + lines.join("\r\n") + "\r\n", "utf8"), rowCount };
}

const safeFilePart = (s) => String(s || "").replace(/[\\/:*?"<>|\x00-\x1f]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 80) || "untitled";

async function fetchCampaignReportFile(tenant, token, campaignId, reportType, format) {
  const base = `https://${tenantApiHost(tenant)}/v2026`;
  const auth = { Authorization: `Bearer ${token}` };
  const listRefs = async () => {
    const resp = await axios.get(`${base}/campaigns/${campaignId}/reports`, { headers: auth });
    return (Array.isArray(resp.data) ? resp.data : []).find((r) => r.reportType === reportType) || null;
  };
  // Runs the report and waits for a NEW successful result (lastRunAt moves).
  const runAndWait = async (previousRunAt) => {
    for (let attempt = 0; ; attempt++) {
      try {
        await axios.post(`${base}/campaigns/${campaignId}/run-report/${reportType}`, {}, { headers: { ...auth, "Content-Type": "application/json" } });
        break;
      } catch (err) {
        if (!isCampaignConflict(err) || attempt >= CAMPAIGN_CONFLICT_RETRIES) {
          if (isCampaignConflict(err)) throw new Error("ISC is still running another operation on this campaign (a remediation scan or another report) — try again in a few minutes.");
          throw err;
        }
        await new Promise((r) => setTimeout(r, CAMPAIGN_CONFLICT_RETRY_MS));
      }
    }
    for (let i = 0; i < CAMPAIGN_REPORT_POLL_TRIES; i++) {
      await new Promise((r) => setTimeout(r, CAMPAIGN_REPORT_POLL_MS));
      const ref = await listRefs();
      const status = String(ref?.status || "").toUpperCase();
      if (ref && status === "SUCCESS" && ref.lastRunAt !== previousRunAt) return ref;
      if (ref && (status === "ERROR" || status === "TERMINATED") && ref.lastRunAt !== previousRunAt) {
        throw new Error(`ISC could not generate the report (status ${status}).`);
      }
    }
    throw new Error("The report was started but didn't finish in time — try again in a minute.");
  };
  const download = (resultId) =>
    axios.get(`${base}/reports/${resultId}`, {
      params: { fileFormat: format },
      headers: { ...auth, Accept: format === "pdf" ? "application/pdf, application/octet-stream, */*" : "application/csv, text/csv, application/octet-stream, */*" },
      responseType: "arraybuffer",
    });

  let ref = await listRefs();
  let reran = false;
  if (!ref || String(ref.status || "").toUpperCase() !== "SUCCESS") {
    ref = await runAndWait(ref?.lastRunAt);
    reran = true;
  }
  try {
    const resp = await download(ref.id);
    return { buffer: Buffer.from(resp.data), reran, lastRunAt: ref.lastRunAt };
  } catch (err) {
    // A listed result whose file has since been purged — run it fresh, once.
    const status = err.response?.status;
    if (reran || (status !== 404 && status !== 410 && status !== 400)) throw err;
    ref = await runAndWait(ref.lastRunAt);
    const resp = await download(ref.id);
    return { buffer: Buffer.from(resp.data), reran: true, lastRunAt: ref.lastRunAt };
  }
}

/**
 * POST /api/campaigns/reports/download
 *   { campaignIds: [...], reportTypes: [...], format: "csv" | "pdf", zip: true|false,
 *     consolidate: true|false }   // CSV only: one file per report type, all campaigns
 *
 * { files: [{ name, campaign, reportType, contentBase64 }] } — or, with zip,
 * { zip: { name, contentBase64 }, files: [{ name, campaign, reportType }] } —
 * plus failures: [{ campaign, reportType, error }]. One report failing never
 * sinks the rest; every failure is named. Reports that were never run (or
 * whose file has expired) are run first, which is why this can take a while.
 */
app.post("/api/campaigns/reports/download", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  const format = String(req.body?.format || "").toLowerCase();
  const campaignIds = [...new Set((Array.isArray(req.body?.campaignIds) ? req.body.campaignIds : []).filter((id) => typeof id === "string" && /^[A-Za-z0-9-]+$/.test(id)))];
  const reportTypes = [...new Set((Array.isArray(req.body?.reportTypes) ? req.body.reportTypes : []).filter((t) => CAMPAIGN_REPORT_TYPES[t]))];
  const wantZip = req.body?.zip !== false;
  const consolidate = req.body?.consolidate === true && format === "csv";
  if (format !== "csv" && format !== "pdf") return res.status(400).json({ error: "format must be csv or pdf." });
  if (campaignIds.length === 0) return res.status(400).json({ error: "Select at least one campaign." });
  if (campaignIds.length > CAMPAIGN_REPORT_MAX_CAMPAIGNS) return res.status(400).json({ error: `Get reports for at most ${CAMPAIGN_REPORT_MAX_CAMPAIGNS} campaigns at a time.` });
  if (reportTypes.length === 0) return res.status(400).json({ error: "Pick at least one report." });

  try {
    const token = await sessionToken(session);
    const files = [];
    const failures = [];
    const usedNames = new Set();
    for (const campaignId of campaignIds) {
      let campaignName = campaignId;
      try {
        const c = await iscGet(tenant, token, `/v2026/campaigns/${campaignId}`);
        campaignName = c?.name || campaignId;
      } catch (err) {
        if (err.sessionExpired) throw err;
        for (const reportType of reportTypes) failures.push({ campaign: campaignName, reportType, error: `Couldn't read the campaign: ${describeError(err)}` });
        continue;
      }
      for (const reportType of reportTypes) {
        try {
          const { buffer, reran } = await fetchCampaignReportFile(tenant, token, campaignId, reportType, format);
          let name = `${safeFilePart(campaignName)} - ${CAMPAIGN_REPORT_TYPES[reportType]}.${format}`;
          // Two campaigns can share a name — keep both files.
          for (let n = 2; usedNames.has(name.toLowerCase()); n++) name = `${safeFilePart(campaignName)} (${n}) - ${CAMPAIGN_REPORT_TYPES[reportType]}.${format}`;
          usedNames.add(name.toLowerCase());
          files.push({ name, campaign: campaignName, reportType, reran, buffer });
        } catch (err) {
          if (err.sessionExpired) throw err;
          const body = Buffer.isBuffer(err.response?.data) ? err.response.data.toString("utf8").slice(0, 300) : null;
          console.error(`[campaign-reports] ${campaignName} / ${reportType} failed:`, err.response?.status, body || err.response?.data || err.message);
          failures.push({ campaign: campaignName, reportType, error: err.response ? `ISC returned ${err.response.status}${body ? ` — ${body}` : ""}` : err.message });
        }
      }
    }
    console.log(`[campaign-reports] ${tenant}: ${files.length} ${format} file(s), ${failures.length} failure(s) across ${campaignIds.length} campaign(s) (by ${session.username || "unknown"})`);

    // CSV consolidation: collapse the per-campaign files into one per report
    // type. A report whose CSV can't be parsed is left as its own file rather
    // than being dropped, and says so.
    if (consolidate && files.length > 0) {
      const stamp = new Date().toISOString().slice(0, 10);
      const merged = [];
      for (const reportType of reportTypes) {
        const group = files.filter((f) => f.reportType === reportType);
        if (group.length === 0) continue;
        try {
          const { buffer, rowCount } = consolidateCampaignCsvs(group);
          merged.push({
            name: `${CAMPAIGN_REPORT_TYPES[reportType]} - ${group.length} campaign${group.length === 1 ? "" : "s"} - ${stamp}.csv`,
            campaign: `${group.length} campaign${group.length === 1 ? "" : "s"}`,
            reportType, reran: group.some((f) => f.reran), buffer, rowCount,
          });
        } catch (err) {
          console.error(`[campaign-reports] consolidate ${reportType} failed:`, err.message);
          failures.push({ campaign: "(consolidation)", reportType, error: `Couldn't merge these CSVs (${err.message}) — included them separately instead.` });
          merged.push(...group);
        }
      }
      files.length = 0;
      files.push(...merged);
    }

    const listing = files.map(({ name, campaign, reportType, reran, rowCount }) => ({ name, campaign, reportType, reran, ...(rowCount != null ? { rowCount } : {}) }));
    if (wantZip && files.length > 0) {
      const stamp = new Date().toISOString().slice(0, 10);
      const zip = zipFiles(files.map((f) => ({ name: f.name, content: f.buffer })));
      return res.json({ zip: { name: `campaign-reports-${format}-${stamp}.zip`, contentBase64: zip.toString("base64") }, files: listing, failures });
    }
    res.json({ files: files.map((f, i) => ({ ...listing[i], contentBase64: f.buffer.toString("base64") })), failures });
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[campaign-reports] download failed:", err.response?.status, err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/**
 * GET /api/transforms/last-updated
 *
 * { updated: { "<transformId>": { at: ISO, by: "actor" } }, scanned, truncated }
 *
 * ISC's transform records carry NO dates at all (no created/modified on
 * /v2026/transforms or /beta/transforms, and sorters=-modified is silently
 * ignored — verified live), so "last updated" can't come from the transforms
 * themselves. ISC's audit events do record every change though: type
 * TRANSFORM, technicalName TRANSFORM_CREATE_PASSED / TRANSFORM_UPDATE_PASSED,
 * attributes.transformId "Transform: <id>", with the time and the actor —
 * including changes made in the ISC UI or by the system, not just here.
 *
 * Newest-first, so the first event seen for an id IS its latest change. Only
 * reaches back as far as ISC retains audit events: a transform untouched for
 * longer than that simply has no entry (the list sorts those last, by name).
 */
const TRANSFORM_EVENT_PAGE = 250;
const TRANSFORM_EVENT_MAX = 5000;
/**
 * GET /api/dashboard/api-usage — total API requests over the last 30 days.
 *
 * ISC's own API Usage service (GET /api-usage/v1/count), which is
 * EXPERIMENTAL and refuses the call without X-SailPoint-Experimental: true.
 * Its default window is "first of this month to today", so the 30-day window
 * is passed explicitly via the standard `filters` syntax (startDate/endDate
 * support gt/eq and lt/eq respectively).
 *
 * The published spec — and SailPoint's own Go SDK — type the response as an
 * untyped map with no documented field names, so the count is read from
 * whichever of the plausible keys is actually present rather than assuming
 * one. The raw shape is logged once per process so it can be pinned down
 * from a real tenant instead of guessed at.
 */
let loggedApiUsageShape = false;

// Confirmed live against a real tenant: the response is {"NumberOfCalls":79183}
// — PascalCase, and not a name any of the docs or SDKs state. Since the field
// is undocumented and could be renamed, the known key is tried first, then
// other plausible spellings case-insensitively, and finally a lone numeric
// property whatever it's called.
const USAGE_COUNT_KEYS = ["NumberOfCalls", "count", "total", "totalCount", "value", "apiCallCount", "requests"];

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

/**
 * GET /api/tenant-ui-metadata — the tenant's instance badge, if it has one.
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
app.get("/api/tenant-ui-metadata", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  try {
    const token = await sessionToken(session);
    const data = await iscGet(
      session.tenant,
      token,
      "/ui-metadata/v1/tenant",
      undefined,
      { "X-SailPoint-Experimental": "true" }
    );
    const name = typeof data?.instanceBadgeDisplayName === "string" ? data.instanceBadgeDisplayName.trim() : "";
    // instanceBadgeVisible defaults to false, so a configured-but-hidden
    // badge must not be shown.
    if (!data?.instanceBadgeVisible || !name) return res.json({ badge: null });
    const color = typeof data.instanceBadgeColor === "string" ? data.instanceBadgeColor.trim().replace(/^#/, "") : "";
    res.json({
      badge: { name, color: /^[0-9a-f]{3}([0-9a-f]{3})?$/i.test(color) ? `#${color}` : null },
    });
  } catch (err) {
    if (err.sessionExpired) return res.status(401).json({ error: describeError(err), sessionExpired: true });
    console.warn("[tenant-ui-metadata] unavailable:", err.response?.status || err.message);
    res.json({ badge: null });
  }
});

app.get("/api/dashboard/api-usage", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
  const until = new Date();
  const since = new Date(until.getTime() - days * 24 * 60 * 60 * 1000);
  const iso = (d) => d.toISOString().slice(0, 10);

  try {
    const token = await sessionToken(session);
    const data = await iscGet(
      session.tenant,
      token,
      "/api-usage/v1/count",
      { filters: `startDate gt "${iso(since)}" and endDate lt "${iso(until)}"` },
      { "X-SailPoint-Experimental": "true" }
    );
    if (!loggedApiUsageShape) {
      loggedApiUsageShape = true;
      console.log("[dashboard] api-usage raw response shape:", JSON.stringify(data)?.slice(0, 400));
    }
    const count = readUsageCount(data);
    res.json({ count, days, since: since.toISOString(), until: until.toISOString(), ...(count == null ? { unrecognized: true } : {}) });
  } catch (err) {
    // Experimental and permission-gated: a tenant or token without access to
    // it shouldn't break the dashboard, so this reports unavailable rather
    // than erroring the whole page.
    const status = err.response?.status;
    console.warn(`[dashboard] api-usage unavailable (${status || err.message})`);
    if (err.sessionExpired) return res.status(401).json({ error: describeError(err), sessionExpired: true });
    res.json({ count: null, days, unavailable: true, reason: status === 403 ? "no-access" : status === 404 ? "not-enabled" : "error" });
  }
});

/**
 * GET /api/dashboard/branding — the tenant's branding name and logo.
 * Tries the paths ISC has used for this service across versions and takes
 * the first that answers, since which one a tenant serves varies.
 * `logoAvailable` tells the client whether to request the image below.
 */
// Probed live against the tenant: /v2026/brandings, /v3/brandings and
// /brandings/v1 all answer (401 unauthenticated); /beta/brandings 404s, so
// it isn't tried.
const BRANDING_PATHS = ["/v2026/brandings", "/v3/brandings", "/brandings/v1"];

async function fetchBrandingList(tenant, token) {
  let lastErr = null;
  for (const path of BRANDING_PATHS) {
    try {
      const data = await iscGet(tenant, token, path);
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
async function fetchSessionIdentityAttributes(tenant, token, identityId) {
  if (!identityId) return {};
  try {
    const rec = await iscGet(tenant, token, `/v2026/identities/${identityId}`);
    return rec?.attributes && typeof rec.attributes === "object" ? rec.attributes : {};
  } catch {
    // Without attributes the tenant default still renders — better than
    // failing the card outright.
    return {};
  }
}

async function fetchBrandingItem(tenant, token, identityId) {
  const list = await fetchBrandingList(tenant, token);
  if (!list.length) return null;
  const attributes = list.length > 1 ? await fetchSessionIdentityAttributes(tenant, token, identityId) : {};
  return resolveBrandForIdentity(list, attributes);
}

app.get("/api/dashboard/branding", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  try {
    const token = await sessionToken(session);
    const found = await fetchBrandingItem(session.tenant, token, session.identity?.id);
    if (!found) return res.json({ available: false });
    const { item, matchedAttribute, matchedValue } = found;
    // Hex values, normalised to "#rrggbb" — ISC stores them without the
    // leading "#" and a tenant may have left any of them unset.
    const hex = (v) => {
      const h = String(v || "").trim().replace(/^#/, "");
      return /^[0-9a-f]{3}([0-9a-f]{3})?$/i.test(h) ? `#${h}` : null;
    };
    res.json({
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
    });
  } catch (err) {
    if (err.sessionExpired) return res.status(401).json({ error: describeError(err), sessionExpired: true });
    console.warn("[dashboard] branding unavailable:", err.response?.status || err.message);
    res.json({ available: false });
  }
});

/**
 * GET /api/dashboard/branding/logo — the logo image itself, proxied.
 * The URL ISC returns sits behind the tenant's own auth, so the browser
 * can't load it directly from an <img src>; this streams it through with
 * the session's token attached.
 */
app.get("/api/dashboard/branding/logo", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  try {
    const token = await sessionToken(session);
    const found = await fetchBrandingItem(session.tenant, token, session.identity?.id);
    const raw = found?.item?.standardLogoURL || found?.item?.logoURL;
    if (!raw) return res.status(404).json({ error: "This tenant has no branding logo." });
    // The stored value may be absolute or tenant-relative.
    const url = /^https?:\/\//i.test(raw) ? raw : `https://${tenantApiHost(session.tenant)}${raw.startsWith("/") ? "" : "/"}${raw}`;
    const img = await axios.get(url, {
      responseType: "arraybuffer",
      headers: { Authorization: `Bearer ${token}` },
    });
    const type = img.headers["content-type"] || "image/png";
    if (!/^image\//i.test(type)) return res.status(415).json({ error: "Branding logo is not an image." });
    res.set("Content-Type", type);
    res.set("Cache-Control", "private, max-age=300");
    res.send(Buffer.from(img.data));
  } catch (err) {
    if (err.sessionExpired) return res.status(401).json({ error: describeError(err), sessionExpired: true });
    console.warn("[dashboard] branding logo unavailable:", err.response?.status || err.message);
    res.status(404).json({ error: "Branding logo could not be loaded." });
  }
});

app.get("/api/transforms/last-updated", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  try {
    const token = await sessionToken(session);
    const updated = {};
    let scanned = 0;
    let truncated = false;
    for (let offset = 0; ; offset += TRANSFORM_EVENT_PAGE) {
      if (offset >= TRANSFORM_EVENT_MAX) { truncated = true; break; }
      const { items } = await iscSearchPage(
        session.tenant,
        token,
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
    res.json({ updated, scanned, truncated });
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[transforms] last-updated failed:", err.response?.data || err.message);
    res.status(status).json({ error: err.response?.data?.messages?.[0]?.text || describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/**
 * POST /api/metadata/:key/values/delete   { values: ["usa", ...] }
 *
 * Batch-deletes values of a CUSTOM Access Model Metadata attribute. ISC
 * rejects a JSON-Patch that replaces /values with a shorter list (400.1
 * "semantically invalid", seen live on the Segments attribute), so each value
 * goes through ISC's own per-value delete instead. If the tenant doesn't
 * serve that route (404/405), it falls back to a JSON-Patch `remove` of the
 * value's current index — re-read before every removal, since indexes shift.
 *
 * Values are processed one at a time and the result says what happened to
 * each: { deleted: [...], failed: [{ value, error }] }. Not atomic — ISC
 * offers no batch delete — so a partial result is reported, never hidden.
 */
app.post("/api/metadata/:key/values/delete", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  const { key } = req.params;
  const wanted = [...new Set((Array.isArray(req.body?.values) ? req.body.values : []).filter((v) => typeof v === "string" && v))];
  if (!isSafeMetadataKey(key)) return res.status(400).json({ error: "That metadata key can't be edited." });
  if (wanted.length === 0) return res.status(400).json({ error: "values must be a non-empty array of value names." });
  if (wanted.length > 250) return res.status(400).json({ error: "Delete at most 250 values at a time." });

  try {
    const token = await sessionToken(session);
    const base = `https://${tenantApiHost(tenant)}/v2026/access-model-metadata/attributes/${encodeURIComponent(key)}`;
    const attribute = await iscGet(tenant, token, `/v2026/access-model-metadata/attributes/${encodeURIComponent(key)}`);
    if (String(attribute?.type || "").toLowerCase() !== "custom") {
      return res.status(403).json({ error: `"${attribute?.name || key}" is a built-in metadata attribute — its values can't be deleted.` });
    }

    const deleted = [];
    const failed = [];
    let perValueRouteMissing = false;
    for (const value of wanted) {
      try {
        if (!perValueRouteMissing) {
          try {
            await axios.delete(`${base}/values/${encodeURIComponent(value)}`, {
              headers: { Authorization: `Bearer ${token}`, "X-SailPoint-Experimental": "true" },
            });
            deleted.push(value);
            continue;
          } catch (err) {
            const status = err.response?.status;
            // 404 is ambiguous: no such route, or no such value. Only treat it
            // as "route missing" when the value really is still on the attribute.
            const current = await iscGet(tenant, token, `/v2026/access-model-metadata/attributes/${encodeURIComponent(key)}`);
            const stillThere = (current?.values || []).some((v) => v.value === value);
            if (!stillThere) { deleted.push(value); continue; }
            if (status !== 404 && status !== 405) throw err;
            perValueRouteMissing = true;
            console.warn(`[metadata] per-value delete not served (${status}) — falling back to JSON-Patch remove`);
          }
        }
        const current = await iscGet(tenant, token, `/v2026/access-model-metadata/attributes/${encodeURIComponent(key)}`);
        const index = (current?.values || []).findIndex((v) => v.value === value);
        if (index === -1) { deleted.push(value); continue; }
        await axios.patch(base, [{ op: "remove", path: `/values/${index}` }], {
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json-patch+json" },
        });
        deleted.push(value);
      } catch (err) {
        if (err.sessionExpired) throw err;
        console.error(`[metadata] delete value "${key}"/"${value}" failed:`, err.response?.status, JSON.stringify(err.response?.data || err.message));
        failed.push({ value, error: describeError(err) });
      }
    }
    res.json({ deleted, failed });
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[metadata] delete values failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

// ─── Workflows > Create with AI ─────────────────────────────────────────────
// Requirements → a reviewable outline (revisable) → on approval, a complete
// workflow, structurally validated, saved DISABLED. See workflowAi.js for the
// two-stage design, the prompts and the validation; this is the I/O around it.
const workflowAi = require("./workflowAi");
const WORKFLOW_AI_MAX_REQUIREMENTS = 6000;

// The tenant's workflow library barely changes; don't refetch ~1MB of it on
// every revision. Per tenant, 10 minutes. (In-memory and per-instance on
// purpose — it's a cache of ISC's data, not state.)
const workflowLibraryCache = new Map();
async function getWorkflowCatalog(tenant, token) {
  const cached = workflowLibraryCache.get(tenant);
  if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.catalog;
  const [triggers, actions, operators] = await Promise.all(
    ["triggers", "actions", "operators"].map((kind) => iscGet(tenant, token, `/v2026/workflow-library/${kind}`, { limit: 250 }))
  );
  const catalog = workflowAi.buildCatalog({ triggers, actions, operators });
  workflowLibraryCache.set(tenant, { at: Date.now(), catalog });
  return catalog;
}

// Ask, parse, validate; on a bad reply, tell the model what was wrong and ask
// once more. Returns { value } or { problems } (what was still wrong).
async function generateValidated({ makePrompt, validate, maxTokens }) {
  let problems = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const reply = await claudeGenerateText(makePrompt(problems), { maxTokens, strong: true });
    const value = workflowAi.extractJsonObject(reply);
    problems = value ? validate(value) : ["The reply was not a JSON object."];
    if (problems.length === 0) return { value };
  }
  return { problems };
}

function workflowAiPreflight(req, res) {
  const requirements = String(req.body?.requirements ?? "").trim();
  if (!requirements) { res.status(400).json({ error: "Describe what the workflow should do." }); return null; }
  if (requirements.length > WORKFLOW_AI_MAX_REQUIREMENTS) { res.status(400).json({ error: `The requirements are too long (${requirements.length.toLocaleString()} characters; the limit is ${WORKFLOW_AI_MAX_REQUIREMENTS.toLocaleString()}).` }); return null; }
  if (!aiConfigured()) { res.status(503).json({ error: "AI isn't configured on this server (set AI_PROVIDER=bedrock or ANTHROPIC_API_KEY)." }); return null; }
  return requirements;
}

/**
 * POST /api/workflows/ai/outline
 * Body: { requirements, outline?, feedback? } — outline + feedback revise a
 * previous outline instead of starting over.
 * Returns { outline } — see OUTLINE_SHAPE in workflowAi.js. Every trigger and
 * step id in it is a real id from this tenant's workflow library.
 */
app.post("/api/workflows/ai/outline", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const requirements = workflowAiPreflight(req, res);
  if (!requirements) return;
  const previousOutline = req.body?.outline && typeof req.body.outline === "object" ? req.body.outline : null;
  const feedback = String(req.body?.feedback ?? "").trim().slice(0, 3000);
  if (previousOutline && !feedback) return res.status(400).json({ error: "Say what to change in the outline." });
  try {
    const catalog = await getWorkflowCatalog(session.tenant, await sessionToken(session));
    const { value, problems } = await generateValidated({
      maxTokens: 6000,
      validate: (o) => workflowAi.validateOutline(o, catalog),
      makePrompt: (prev) =>
        workflowAi.outlinePrompt({ requirements, catalog, previousOutline, feedback }) +
        (prev ? `\n\nYour previous reply was rejected:\n${prev.map((p) => `- ${p}`).join("\n")}\nReturn a corrected outline.` : ""),
    });
    if (!value) return res.status(502).json({ error: `The AI couldn't produce a usable outline (${problems[0]}). Try rephrasing the requirements.` });
    res.json({ outline: value });
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[workflows/ai] outline failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/**
 * POST /api/workflows/ai/create
 * Body: { requirements, outline } — the outline the user approved
 * Builds the full workflow from the outline, validates its structure (one
 * retry with the problems fed back), and creates it in ISC — DISABLED, owned
 * by the signed-in user. It is never enabled here: a generated workflow gets
 * reviewed (and its placeholders filled) before it runs.
 * Returns { workflow, placeholders } — placeholders are the REPLACE_WITH_…
 * values still to fill in. 422 { problems } if it couldn't be made valid.
 */
app.post("/api/workflows/ai/create", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const requirements = workflowAiPreflight(req, res);
  if (!requirements) return;
  const outline = req.body?.outline;
  const { tenant } = session;
  try {
    const token = await sessionToken(session);
    const catalog = await getWorkflowCatalog(tenant, token);
    const outlineProblems = workflowAi.validateOutline(outline, catalog);
    if (outlineProblems.length) return res.status(400).json({ error: `That outline can't be built: ${outlineProblems[0]}` });

    const existing = await iscGet(tenant, token, "/v2026/workflows", { limit: 250 }).catch(() => []);
    const examples = workflowAi.pickExampleWorkflows(existing, (wf) => workflowAi.validateWorkflow(wf, catalog).length === 0);
    const usage = workflowAi.actionUsageExamples(existing, (outline.steps || []).map((st) => st.id));

    const { value: built, problems } = await generateValidated({
      maxTokens: 16000,
      validate: (wf) => workflowAi.validateWorkflow(wf, catalog),
      makePrompt: (prev) => workflowAi.buildPrompt({ requirements, outline, catalog, examples, usage, problems: prev }),
    });
    if (!built) {
      return res.status(422).json({ error: "The AI's workflow didn't pass validation, so nothing was saved. Try again, or simplify the outline.", problems });
    }

    const body = {
      name: String(built.name || outline.name).slice(0, 250),
      description: built.description || outline.description || "",
      owner: { type: "IDENTITY", id: session.identity?.id, name: session.identity?.name || session.username },
      definition: built.definition,
      trigger: built.trigger,
      enabled: false,
    };
    const created = (
      await axios.post(`https://${tenantApiHost(tenant)}/v2026/workflows`, body, {
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
      })
    ).data;
    console.log(`[workflows/ai] ${tenant} created "${created.name}" (${created.id}) from AI outline, disabled (by ${session.username})`);
    const placeholders = [...new Set(JSON.stringify(built).match(/REPLACE_WITH_[A-Za-z0-9_]+/g) || [])];
    res.json({ workflow: created, placeholders });
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[workflows/ai] create failed:", err.response?.data || err.message);
    res.status(status).json({
      error: iscWorkflowErrorText(err),
      ...(err.sessionExpired ? { sessionExpired: true } : {}),
    });
  }
});

/**
 * POST /api/workflows/validate
 * Body: { workflow } — { name, trigger, definition } as it would be saved,
 *    or { outline } — an AI-create outline (e.g. after a hand reorder).
 * The app's own structural check against this tenant's workflow library —
 * instant, touches nothing in ISC. It exists because ISC has no validate
 * call: a SAVE accepts almost anything, and the real validation only runs
 * when the workflow is ENABLED, which is a bad moment to learn a ".$" key
 * holds text. This catches the structural mistakes (unknown trigger / action
 * ids, a start or link that points nowhere, a choice with no default, steps
 * nothing reaches, a path that never ends, ".$" values that aren't a
 * JSONPath, loop bodies likewise) — not everything ISC checks, and the
 * response says so.
 * Returns { state: "OK" | "ERROR", problems: [], checked: "workflow" | "outline" }.
 */
app.post("/api/workflows/validate", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { workflow, outline } = req.body || {};
  if (!workflow && !outline) return res.status(400).json({ error: "workflow or outline is required." });
  try {
    const catalog = await getWorkflowCatalog(session.tenant, await sessionToken(session));
    const problems = workflow ? workflowAi.validateWorkflow(workflow, catalog) : workflowAi.validateOutline(outline, catalog);
    res.json({ state: problems.length ? "ERROR" : "OK", problems, checked: workflow ? "workflow" : "outline" });
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[workflows] validate failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/**
 * POST /api/workflows/:id/ai/modify
 * Body: { instructions, proposal?, feedback?, base? } — proposal + feedback
 * revise a previous proposal instead of starting from the live workflow's
 * text alone; base ({ name, description, trigger, definition }) stands in
 * for the saved workflow, so a fix can be proposed for UNSAVED edits in an
 * editor (the diff is then against base, i.e. against what the user sees).
 * Proposes a modified version of the workflow — it changes NOTHING in ISC;
 * the client saves through PUT /api/workflows/:id/save once the user approves.
 * Returns { workflow: { name, description, trigger, definition }, summary,
 * notes, diff, placeholders } — diff is computed here (see diffWorkflows), so
 * the review doesn't rest on the model's own account of what it changed.
 * 422 { problems } when the result couldn't be made structurally valid.
 */
app.post("/api/workflows/:id/ai/modify", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  const instructions = String(req.body?.instructions ?? "").trim();
  if (!instructions) return res.status(400).json({ error: "Describe the change you want." });
  if (instructions.length > WORKFLOW_AI_MAX_REQUIREMENTS) return res.status(400).json({ error: "That description is too long." });
  if (!aiConfigured()) return res.status(503).json({ error: "AI isn't configured on this server (set AI_PROVIDER=bedrock or ANTHROPIC_API_KEY)." });
  const previous = req.body?.proposal && typeof req.body.proposal === "object" ? req.body.proposal : null;
  const feedback = String(req.body?.feedback ?? "").trim().slice(0, 3000);
  if (previous && !feedback) return res.status(400).json({ error: "Say what to change in the proposal." });
  try {
    const token = await sessionToken(session);
    const base = req.body?.base && typeof req.body.base === "object" && req.body.base.definition ? req.body.base : null;
    const [catalog, saved, existing] = await Promise.all([
      getWorkflowCatalog(tenant, token),
      iscGet(tenant, token, `/v2026/workflows/${encodeURIComponent(req.params.id)}`),
      iscGet(tenant, token, "/v2026/workflows", { limit: 250 }).catch(() => []),
    ]);
    const workflow = base ? { ...saved, name: base.name ?? saved.name, description: base.description ?? saved.description, trigger: base.trigger, definition: base.definition } : saved;
    const usage = workflowAi.actionUsageExamples(existing, [...catalog.actions, ...catalog.operators].map((x) => x.id), 1);

    const { value, problems } = await generateValidated({
      maxTokens: 24000,
      // The envelope must hold a workflow, and the workflow must be sound.
      validate: (reply) => (reply?.workflow ? workflowAi.validateWorkflow({ name: workflow.name, ...reply.workflow }, catalog) : ['The reply has no "workflow".']),
      makePrompt: (prev) => workflowAi.modifyPrompt({ workflow, instructions, catalog, usage, previous, feedback, problems: prev }),
    });
    if (!value) return res.status(422).json({ error: "The AI's modified workflow didn't pass validation, so there is nothing to review. Try again, or describe the change differently.", problems });

    const proposed = {
      name: String(value.workflow.name || workflow.name).slice(0, 250),
      description: value.workflow.description ?? workflow.description ?? "",
      trigger: value.workflow.trigger,
      definition: value.workflow.definition,
    };
    const strings = (list) => (Array.isArray(list) ? list.filter((x) => typeof x === "string" && x.trim()) : []);
    res.json({
      workflow: proposed,
      summary: strings(value.summary),
      notes: strings(value.notes),
      diff: workflowAi.diffWorkflows(workflow, proposed),
      placeholders: [...new Set(JSON.stringify(proposed).match(/REPLACE_WITH_[A-Za-z0-9_]+/g) || [])],
    });
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[workflows/ai] modify failed:", err.response?.data || err.message);
    res.status(status).json({ error: iscWorkflowErrorText(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/**
 * DELETE /api/workflows/:id
 * Header: x-sp-session
 * Deletes a workflow. ISC refuses to delete an enabled one, so an enabled
 * workflow is disabled first (the client's confirm says so) — and if the
 * delete then fails, it is re-enabled rather than left switched off.
 */
app.delete("/api/workflows/:id", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  const url = `https://${tenantApiHost(tenant)}/v2026/workflows/${encodeURIComponent(req.params.id)}`;
  try {
    const token = await sessionToken(session);
    const auth = { Authorization: `Bearer ${token}`, Accept: "application/json" };
    const current = (await axios.get(url, { headers: auth })).data;
    const setEnabled = (enabled) =>
      axios.patch(url, [{ op: "replace", path: "/enabled", value: enabled }], { headers: { ...auth, "Content-Type": "application/json-patch+json" } });
    if (current.enabled) await setEnabled(false);
    try {
      await axios.delete(url, { headers: auth });
    } catch (err) {
      if (current.enabled) await setEnabled(true).catch((e) => console.error(`[workflows] ${tenant} FAILED to re-enable ${req.params.id} after a failed delete:`, e.response?.data || e.message));
      throw err;
    }
    console.log(`[workflows] ${tenant} deleted "${current.name}" (${req.params.id})${current.enabled ? " — was enabled, disabled first" : ""} (by ${session.username})`);
    res.status(204).end();
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[workflows] delete failed:", err.response?.data || err.message);
    res.status(status).json({ error: iscWorkflowErrorText(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/**
 * PUT /api/workflows/:id/save
 * Header: x-sp-session
 * Body: { workflow: <the PUT body>, allowDisable?: boolean }
 *
 * ISC refuses to update a workflow while it is enabled ("failed to update
 * workflow because it is enabled: not allowed") — its own UI makes you
 * disable it first. This does that dance in one place, server-side so the
 * restore doesn't depend on the browser staying open:
 *   disable → PUT (as disabled) → re-enable
 * and re-enables even when the PUT fails, so a rejected edit never leaves a
 * live workflow switched off. If the edit itself sets enabled: false, it is
 * left disabled. Without allowDisable an enabled workflow gets a 409
 * { code: "WORKFLOW_ENABLED" } — the client confirms first, since triggers
 * that fire while it's briefly disabled are missed.
 * Returns { workflow, wasDisabledToSave, reenabled }.
 */
app.put("/api/workflows/:id/save", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  const body = req.body?.workflow;
  if (!body || typeof body !== "object") return res.status(400).json({ error: "workflow (the fields to save) is required." });
  const url = `https://${tenantApiHost(tenant)}/v2026/workflows/${encodeURIComponent(req.params.id)}`;
  const iscText = iscWorkflowErrorText;
  try {
    const token = await sessionToken(session);
    const json = { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" };
    const setEnabled = (enabled) =>
      axios.patch(url, [{ op: "replace", path: "/enabled", value: enabled }], { headers: { ...json, "Content-Type": "application/json-patch+json" } });

    const current = (await axios.get(url, { headers: json })).data;
    if (!current.enabled) {
      const saved = (await axios.put(url, body, { headers: json })).data;
      return res.json({ workflow: saved, wasDisabledToSave: false, reenabled: false });
    }
    if (!req.body?.allowDisable) {
      return res.status(409).json({ code: "WORKFLOW_ENABLED", error: "This workflow is enabled — ISC only accepts changes to a disabled workflow." });
    }

    const wantEnabled = body.enabled !== false;
    await setEnabled(false);
    console.log(`[workflows] ${tenant} disabled ${req.params.id} to save it (by ${session.username})`);
    let saved;
    let saveError = null;
    try {
      saved = (await axios.put(url, { ...body, enabled: false }, { headers: json })).data;
    } catch (err) {
      saveError = err;
    }
    // Back on whether or not the save took — unless the edit was to disable it.
    let reenabled = false;
    let reenableError = null;
    if (wantEnabled || saveError) {
      try {
        await setEnabled(true);
        reenabled = true;
      } catch (err) {
        reenableError = iscText(err);
        console.error(`[workflows] ${tenant} FAILED to re-enable ${req.params.id}:`, err.response?.data || err.message);
      }
    }
    if (saveError) {
      const status = saveError.response?.status || 500;
      return res.status(status).json({
        error: `${iscText(saveError)}${reenableError ? ` — and the workflow could NOT be re-enabled (${reenableError}); it is currently DISABLED.` : " — nothing was changed; the workflow is enabled again."}`,
      });
    }
    res.json({ workflow: { ...saved, enabled: reenabled }, wasDisabledToSave: true, reenabled, ...(reenableError ? { reenableError } : {}) });
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[workflows] save failed:", err.response?.data || err.message);
    res.status(status).json({ error: iscText(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/**
 * PUT /api/workflows/:id/enabled
 * Header: x-sp-session
 * Body: { enabled: boolean }
 * Turns a workflow on or off — ISC's PATCH /workflows/{id} on /enabled, which
 * needs the json-patch content type the generic proxy doesn't send. ISC
 * validates on enable (e.g. a workflow with no trigger or an incomplete step
 * is refused); its message is passed through. Returns the updated workflow.
 */
app.put("/api/workflows/:id/enabled", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  if (typeof req.body?.enabled !== "boolean") return res.status(400).json({ error: "enabled (true or false) is required." });
  try {
    const token = await sessionToken(session);
    const resp = await axios.patch(
      `https://${tenantApiHost(tenant)}/v2026/workflows/${encodeURIComponent(req.params.id)}`,
      [{ op: "replace", path: "/enabled", value: req.body.enabled }],
      { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json-patch+json", Accept: "application/json" } }
    );
    console.log(`[workflows] ${tenant} ${req.body.enabled ? "enabled" : "disabled"} ${req.params.id} (by ${session.username})`);
    res.json(resp.data);
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[workflows] set enabled failed:", err.response?.data || err.message);
    res.status(status).json({ error: iscWorkflowErrorText(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

/**
 * POST /api/workflows/:id/flowchart
 * Header: x-sp-session
 * Fetches the workflow's full definition from ISC and asks Claude to render
 * its logic as a self-contained SVG flowchart. Read-only against ISC; the
 * SVG is sanitized (scripts/event handlers/foreignObject stripped) before
 * being returned, since it gets injected into the client's DOM.
 */
app.post("/api/workflows/:id/flowchart", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  if (!aiConfigured()) {
    return res.status(503).json({ error: "AI flowchart generation isn't configured on this server." });
  }
  try {
    const token = await sessionToken(session);
    const workflow = await withApiRetry(
      () => iscGet(tenant, token, `/v2026/workflows/${req.params.id}`),
      { label: `workflow flowchart: fetch ${req.params.id}` }
    );

    const raw = await claudeGenerateText(
      `Render this SailPoint ISC workflow's logic as a flowchart in a single self-contained SVG.\n\n` +
        `Requirements:\n` +
        `- Respond with ONLY the SVG markup — no prose, no markdown fences.\n` +
        `- <svg> root with viewBox="0 0 640 H" (pick H to fit; width scales to its container), no fixed width/height attributes.\n` +
        `- Start with the trigger, then follow the step graph from the definition's "start" through nextStep/choiceList links, including every branch and end state.\n` +
        `- Rounded rectangles for steps (short title plus a one-line detail), a distinct color for choice/decision steps, gray for start/end. Label decision branches (e.g. Yes/No).\n` +
        `- CRITICAL: wrap each step's shapes and text in a <g data-step="STEP_KEY"> element, where STEP_KEY is that step's EXACT key in definition.steps (copy it verbatim, including spaces and casing). Wrap the trigger node in <g data-step="__trigger__">. Every drawn node must have its data-step group; don't invent keys that aren't in definition.steps.\n` +
        `- Use only inline fills/strokes with good contrast on white; sans-serif text, 13-14px titles, 11-12px details; arrows via a marker def.\n` +
        `- Keep every element inside the viewBox; no <script>, no <foreignObject>, no external references.\n\n` +
        `Workflow JSON:\n${JSON.stringify(workflow, null, 2)}`,
      { maxTokens: 4000 }
    );

    // Best-effort extraction + sanitation: keep only the <svg>...</svg> block
    // and strip anything executable.
    const match = (raw || "").match(/<svg[\s\S]*<\/svg>/i);
    if (!match) {
      console.error("[workflows] flowchart generation returned no SVG:", (raw || "").slice(0, 300));
      return res.status(502).json({ error: "The AI response didn't contain an SVG — try again." });
    }
    const svg = match[0]
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, "")
      .replace(/\son\w+="[^"]*"/gi, "")
      .replace(/\son\w+='[^']*'/gi, "")
      .replace(/(href|xlink:href)="(?!#)[^"]*"/gi, "");
    res.json({ svg });
  } catch (err) {
    const status = err.sessionExpired ? 401 : err.response?.status || 500;
    console.error("[workflows] flowchart failed:", err.response?.data || err.message);
    res.status(status).json({ error: describeError(err), ...(err.sessionExpired ? { sessionExpired: true } : {}) });
  }
});

// ─── Raw JSON editing (detail screens' JSON tab) ─────────────────────────────

/**
 * PATCH /api/json-edit/:resource/:id
 * Body: { ops: [...] } — RFC 6902 JSON-Patch operations, computed client-
 * side as a top-level diff of the edited document.
 *
 * Exists because JSON-Patch endpoints REQUIRE Content-Type
 * application/json-patch+json (plain application/json gets a 415, verified
 * live long ago) and the generic /api/isc/* proxy always sends plain JSON.
 * Data segments additionally can't be PATCHed while published — they go
 * through the same revert-to-draft-in-place flow as every other segment
 * edit, with the experimental header.
 */
// Values may only be deleted from a CUSTOM Access Model Metadata attribute
// (type exactly "custom" — an allowlist, so a missing or unrecognised type
// counts as built-in). Enforced here, not just in the Values tab, because
// every metadata write — the Values tab's batch delete, the value JSON
// editor, the attribute's Raw JSON tab — goes through this one route.
// Editing a built-in attribute's values in place (same technical names)
// stays allowed; only an op that would drop one is refused.
async function assertNoBuiltInMetadataValueRemoval(tenant, token, key, ops) {
  const touchesValues = ops.some((op) => typeof op?.path === "string" && (op.path === "/values" || op.path.startsWith("/values/")));
  if (!touchesValues) return;
  const attribute = await iscGet(tenant, token, `/v2026/access-model-metadata/attributes/${encodeURIComponent(key)}`);
  if (String(attribute?.type || "").toLowerCase() === "custom") return;

  const refuse = () => {
    const err = new Error(`"${attribute?.name || key}" is a built-in metadata attribute — its values can't be deleted.`);
    err.statusCode = 403;
    throw err;
  };
  const existing = new Set((attribute?.values || []).map((v) => v.value));
  for (const op of ops) {
    if (typeof op?.path !== "string") continue;
    const onValues = op.path === "/values";
    const underValues = op.path.startsWith("/values/");
    if (!onValues && !underValues) continue;
    if (op.op === "remove" || op.op === "move") refuse();
    if (onValues && (op.op === "replace" || op.op === "add")) {
      const kept = new Set((Array.isArray(op.value) ? op.value : []).map((v) => v?.value));
      for (const v of existing) if (!kept.has(v)) refuse();
    }
    // Replacing one entry's technical name drops the old value just the same.
    if (underValues && op.op === "replace" && /^\/values\/\d+(\/value)?$/.test(op.path)) {
      const idx = Number(op.path.split("/")[2]);
      const before = attribute?.values?.[idx]?.value;
      const after = op.path.endsWith("/value") ? op.value : op.value?.value;
      if (before !== undefined && after !== before) refuse();
    }
  }
}

const JSON_EDIT_RESOURCES = new Set(["roles", "entitlements", "access-profiles", "source-apps", "sources", "data-segments", "segments", "form-definitions", "metadata-attributes"]);
// Resources whose ISC path differs from the client-facing resource segment.
const JSON_EDIT_PATHS = { "metadata-attributes": "access-model-metadata/attributes" };
app.patch("/api/json-edit/:resource/:id", async (req, res) => {
  const session = await getSession(req);
  if (!session) return unauthorized(res);
  const { tenant } = session;
  const { resource, id } = req.params;
  const ops = req.body?.ops;
  if (!JSON_EDIT_RESOURCES.has(resource)) {
    return res.status(400).json({ error: `Editing "${resource}" isn't supported.` });
  }
  if (!Array.isArray(ops) || ops.length === 0) {
    return res.status(400).json({ error: "ops must be a non-empty JSON-Patch array." });
  }
  try {
    const token = await sessionToken(session);
    let targetId = id;
    const extraHeaders = resource === "data-segments" ? DATA_SEGMENTS_HEADERS : {};
    if (resource === "data-segments") {
      targetId = await getSegmentPatchTargetId(tenant, token, id);
    }
    if (resource === "metadata-attributes") {
      await assertNoBuiltInMetadataValueRemoval(tenant, token, id, ops);
    }
    const resp = await axios.patch(
      `https://${tenantApiHost(tenant)}/v2026/${JSON_EDIT_PATHS[resource] || resource}/${targetId}`,
      ops,
      { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json-patch+json", ...extraHeaders } }
    );
    res.json(resp.data);
  } catch (err) {
    const status = err.statusCode || (err.sessionExpired ? 401 : err.response?.status || 500);
    console.error(`[json-edit] ${resource}/${id} failed:`, err.response?.data || err.message);
    res.status(status).json({
      error: err.statusCode ? err.message : err.response?.data?.messages?.[0]?.text || describeError(err),
      ...(err.sessionExpired ? { sessionExpired: true } : {}),
    });
  }
});

// ─── Health check ─────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => res.json({ ok: true, version: "v2026" }));

// Async bootstrap: surface a broken credential store (bad key, unreachable
// S3, malformed registry) at startup, where it's loud and obvious, instead of
// as a confusing sign-in failure on the first request.
(async () => {
  try {
    await initCredentialStore();
  } catch (err) {
    console.error("[startup] credential store init failed:", err.message);
  }
  app.listen(PORT, () => {
    console.log(`\n✅ SailPoint proxy running → http://localhost:${PORT}`);
    console.log(`   Proxying → [tenant].api.identitynow-demo.com/v2026/*\n`);
  });
})();
