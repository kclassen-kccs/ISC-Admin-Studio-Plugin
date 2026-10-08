#!/usr/bin/env node
/**
 * Creates, on one ISC tenant, what the plugin's "ISC workflow" AI route needs:
 *
 *   - Parameter "Admin Studio AI Connection" (type 2.4 Web App): the Claude
 *     Messages API URL, https://api.anthropic.com/v1/messages.
 *   - Parameter "Admin Studio AI Key" (type 1.3 HTTP Custom Authorization):
 *     header name x-api-key, header value = a PLACEHOLDER. Replace it with the
 *     real key in ISC (Admin → Parameter Storage) or on the plugin's Browse →
 *     Parameters page. This script never takes the key.
 *   - Workflow "Admin Studio AI Query" (client/src/lib/aiWorkflow.template.json)
 *     bound to the key parameter, left DISABLED on purpose: the plugin runs
 *     it through the test endpoint with the signed-in user's session.
 *
 * Usage: SAIL_BASE_URL=https://<tenant>.api.identitynow.com SAIL_CLIENT_ID=… SAIL_CLIENT_SECRET=… node scripts/setup-ai-workflow.mjs
 * Re-running is safe: existing parameters and workflow are reused.
 * Private fields are encrypted end to end to SailPoint's enclave with the same
 * code the plugin uses (client/src/lib/ported/parameterCrypto.js).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const BASE = String(process.env.SAIL_BASE_URL || "").replace(/\/+$/, "");
const CLIENT_ID = process.env.SAIL_CLIENT_ID;
const CLIENT_SECRET = process.env.SAIL_CLIENT_SECRET;
if (!BASE || !CLIENT_ID || !CLIENT_SECRET) {
  console.error("Set SAIL_BASE_URL, SAIL_CLIENT_ID and SAIL_CLIENT_SECRET.");
  process.exit(2);
}

const CONNECTION_NAME = "Admin Studio AI Connection";
const KEY_NAME = "Admin Studio AI Key";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const PLACEHOLDER = "REPLACE-WITH-ANTHROPIC-API-KEY";

// The browser module has no imports, so it loads as a data: URL under Node.
const cryptoSource = readFileSync(join(here, "../client/src/lib/ported/parameterCrypto.js"), "utf8");
const { encryptPrivateFields } = await import(`data:text/javascript;base64,${Buffer.from(cryptoSource).toString("base64")}`);

let token;
async function api(method, path, body, headers = {}) {
  const resp = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await resp.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!resp.ok) throw new Error(`${method} ${path} → ${resp.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
  return data;
}
const experimental = { "X-SailPoint-Experimental": "true" };
const sameName = (a, b) => String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();

async function login() {
  const resp = await fetch(`${BASE}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: CLIENT_ID, client_secret: CLIENT_SECRET }),
  });
  if (!resp.ok) throw new Error(`oauth/token → ${resp.status}`);
  token = (await resp.json()).access_token;
  const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
  return claims.identity_id;
}

async function encrypt(privateFields) {
  return encryptPrivateFields(privateFields, async (keyParam) => {
    const doc = await api("GET", `/v2025/parameter-storage/attestation?key=${encodeURIComponent(keyParam)}`, undefined, experimental);
    if (!doc?.attestationDocument) throw new Error("ISC returned no attestation document");
    return doc.attestationDocument;
  });
}

async function ensureParameter(existing, spec, privateFields, ownerId) {
  const found = existing.find((p) => sameName(p.name, spec.name));
  if (found) {
    console.log(`parameter "${spec.name}" exists (${found.id})`);
    return found;
  }
  const created = await api("POST", "/v2025/parameter-storage/parameters", { ...spec, enabled: true, ownerId, privateFields: await encrypt(privateFields) }, experimental);
  console.log(`created parameter "${spec.name}" (${created.id})`);
  return created;
}

const ownerId = await login();
const parameters = await api("GET", "/v2026/parameter-storage/parameters?limit=250");
const connection = await ensureParameter(parameters, { name: CONNECTION_NAME, description: "Anthropic Messages API endpoint used by the Admin Studio AI Query workflow.", type: "2.4", publicFields: { url: ANTHROPIC_URL } }, {}, ownerId);
const key = await ensureParameter(parameters, { name: KEY_NAME, description: "Anthropic API key sent as the x-api-key header by the Admin Studio AI Query workflow. Replace the placeholder header value with the real key.", type: "1.3", publicFields: { headerName: "x-api-key" } }, { headerValue: PLACEHOLDER }, ownerId);

const template = JSON.parse(readFileSync(join(here, "../client/src/lib/aiWorkflow.template.json"), "utf8"));
template.definition.steps["Query Claude"].attributes.param_header.paramID = key.id;
template.enabled = false;
const workflows = await api("GET", "/v2026/workflows?limit=250");
let workflow = workflows.find((w) => sameName(w.name, template.name));
if (workflow) {
  console.log(`workflow "${template.name}" exists (${workflow.id})`);
} else {
  workflow = await api("POST", "/v2026/workflows", template);
  console.log(`created workflow "${template.name}" (${workflow.id})`);
}
// The parameter binding (paramID + the reference ISC creates for it) only
// sticks on a PUT; a POST drops it.
const bound = workflow.definition?.steps?.["Query Claude"]?.attributes?.param_header?.paramID === key.id;
if (!bound || workflow.enabled) {
  workflow = await api("PUT", `/v2026/workflows/${workflow.id}`, { ...template, owner: workflow.owner });
  console.log(`bound "${KEY_NAME}" to the workflow's HTTP step`);
}
console.log(`\nDone. Connection URL: ${connection.publicFields?.url}`);
console.log(`Now set the real key: Parameter Storage → "${KEY_NAME}" → Header Value (currently the placeholder).`);
console.log(`Leave the workflow disabled; the plugin runs it as a test execution.`);
