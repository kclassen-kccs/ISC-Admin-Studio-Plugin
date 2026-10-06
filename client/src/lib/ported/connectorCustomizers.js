/**
 * ported/connectorCustomizers.js
 * Browser-side port of /api/connector-customizers/* (script source store,
 * validate, deploy). ISC keeps only a customizer's built image, never its
 * source, so the script edited in the app is kept in the plugin's IndexedDB
 * record store (per tenant + customizer) and every deploy rebuilds the ZIP
 * from it.
 *
 * A version is a ZIP holding one index.js, uploaded as application/zip (what
 * `sail conn customizers upload` does). The SaaS runtime only duck-types what
 * index.js exports — it reads `connectorCustomizer` (an object, or a function
 * returning one) and uses its `handlers` map, `handlerKey()` and `_exec()` —
 * so a faithful stand-in for @sailpoint/connector-sdk is emitted into every
 * bundle. The script keeps the documented authoring shape, so it stays
 * portable to a real SDK project.
 */

import JSZip from "jszip";
import { iscRaw, badRequest } from "../isc";
import { recordStore } from "../store";
import { getCredentials } from "../sailpoint";
import { routeErrorMessages } from "./sourceErrors";

const MAX_CUSTOMIZER_SCRIPT_CHARS = 500_000;
const sources = () => recordStore("connector-customizer-sources");

// StandardCommand values the SDK's ConnectorCustomizer has before/after
// setters for (lib/connector-customizer.ts), keyed by the setter suffix.
const CUSTOMIZABLE_COMMANDS = {
  StdTestConnection: "std:test-connection",
  StdAccountCreate: "std:account:create",
  StdAccountRead: "std:account:read",
  StdAccountUpdate: "std:account:update",
  StdAccountDelete: "std:account:delete",
  StdAccountEnable: "std:account:enable",
  StdAccountDisable: "std:account:disable",
  StdAccountUnlock: "std:account:unlock",
  StdAccountList: "std:account:list",
  StdAuthenticate: "std:authenticate",
  StdConfigOptions: "std:config-options:read",
  StdApplicationDiscoveryList: "std:application-discovery:list",
  StdEntitlementRead: "std:entitlement:read",
  StdEntitlementList: "std:entitlement:list",
  StdChangePassword: "std:change-password",
  StdSourceDataDiscover: "std:source-data:discover",
  StdSourceDataRead: "std:source-data:read",
};

// Node built-in module names (the browser has no module.isBuiltin).
const NODE_BUILTINS = new Set([
  "assert", "assert/strict", "async_hooks", "buffer", "child_process", "cluster", "console", "constants", "crypto",
  "dgram", "diagnostics_channel", "dns", "dns/promises", "domain", "events", "fs", "fs/promises", "http", "http2",
  "https", "inspector", "module", "net", "os", "path", "path/posix", "path/win32", "perf_hooks", "process",
  "punycode", "querystring", "readline", "readline/promises", "repl", "stream", "stream/consumers", "stream/promises",
  "stream/web", "string_decoder", "sys", "timers", "timers/promises", "tls", "trace_events", "tty", "url", "util",
  "util/types", "v8", "vm", "wasi", "worker_threads", "zlib",
]);
const isBuiltin = (id) => NODE_BUILTINS.has(String(id).replace(/^node:/, ""));

// The slice of @sailpoint/connector-sdk a customizer uses, behavior-matched
// to the SDK source. Emitted verbatim into every bundle.
const SDK_SHIM = `
const __sdk = (() => {
  const COMMANDS = ${JSON.stringify(CUSTOMIZABLE_COMMANDS)};
  const CustomizerType = { Before: "before", After: "after" };
  class ConnectorCustomizer {
    constructor() {
      this._handlers = new Map();
      this._customizedOperationHandlers = new Map();
    }
    get handlers() { return this._handlers; }
    get customizedOperationHandlers() { return this._customizedOperationHandlers; }
    customizedOperation(operationIdentifier, handler) {
      this._customizedOperationHandlers.set(operationIdentifier, handler);
      return this;
    }
    handlerKey(customizerType, cmdType) { return customizerType + ":" + cmdType; }
    async _exec(type, context, input) {
      const handler = this._handlers.get(type);
      if (!handler) throw new Error("No handler found for type: " + type);
      return await handler(context, input);
    }
  }
  for (const [suffix, cmd] of Object.entries(COMMANDS)) {
    ConnectorCustomizer.prototype["before" + suffix] = function (handler) {
      this._handlers.set(this.handlerKey(CustomizerType.Before, cmd), handler);
      return this;
    };
    ConnectorCustomizer.prototype["after" + suffix] = function (handler) {
      this._handlers.set(this.handlerKey(CustomizerType.After, cmd), handler);
      return this;
    };
  }
  const ConnectorErrorType = { Generic: "generic", NotFound: "notFound" };
  class ConnectorError extends Error {
    constructor(message, type = ConnectorErrorType.Generic) { super(message); this.type = type; }
  }
  const readConfig = async () => {
    const config = process.env["CONNECTOR_CONFIG"];
    if (!config) throw new Error("unexpected runtime error: missing connector config");
    try { return JSON.parse(Buffer.from(config, "base64").toString()); }
    catch (ignored) { throw new Error("unexpected runtime error: failed to parse connector config"); }
  };
  const logger = {
    debug: (...a) => console.debug(...a), info: (...a) => console.info(...a),
    warn: (...a) => console.warn(...a), error: (...a) => console.error(...a),
    child() { return logger; },
  };
  return {
    ConnectorCustomizer, CustomizerType, ConnectorError, ConnectorErrorType, readConfig, logger,
    createConnectorCustomizer: () => new ConnectorCustomizer(),
  };
})();
const __require = (id) => (id === "@sailpoint/connector-sdk" ? __sdk : require(id));
`;

// index.js = shim + the script in its own function scope, with `require`
// swapped for one that serves the shim as @sailpoint/connector-sdk and
// passes everything else (Node built-ins) through.
function buildIndexJs(script) {
  return `"use strict";\n${SDK_SHIM}\n(function (require, module, exports) {\n${script}\n})(__require, module, exports);\n`;
}

// Lines the wrapper puts ahead of the script, so a syntax error's line
// number can be reported against the script rather than the bundle.
const SCRIPT_LINE_OFFSET = buildIndexJs(" ").split(" ")[0].split("\n").length - 1;

/**
 * Checks a script without ever running it — it is only PARSED (a Function
 * constructed from the source is compiled, never called). On top of the
 * syntax check, static checks catch what would otherwise only fail inside
 * ISC's runtime: no `connectorCustomizer` export, a misspelled handler
 * setter, no handlers at all, or a require() of a package a bundle built
 * here can't contain.
 * Returns { state: "OK" | "ERROR", details: [{ line, column, message }], handlers: [] }
 * — the same shape as ISC's connector-rule validation.
 */
export function validateCustomizerScript(script) {
  if (!script || !script.trim()) return { state: "ERROR", details: [{ message: "The script is empty." }], handlers: [] };
  try {
    // eslint-disable-next-line no-new-func
    new Function(buildIndexJs(script));
  } catch (err) {
    if (err instanceof SyntaxError) {
      // Chromium reports the position in the stack as "<anonymous>:LINE:COL";
      // the Function constructor adds 2 header lines ahead of the body.
      const m = /<anonymous>:(\d+):(\d+)/.exec(err.stack || "");
      const line = m ? Math.max(1, Number(m[1]) - 2 - SCRIPT_LINE_OFFSET) : undefined;
      return { state: "ERROR", details: [{ line, message: err.message }], handlers: [] };
    }
    // A CSP that forbids eval: the syntax check can't run, the static checks below still do.
  }

  // Comments out of the way first, so commented-out code doesn't count —
  // newlines are kept so line numbers still hold.
  const blank = (m) => m.replace(/[^\n]/g, " ");
  const bare = script.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, blank);
  const lineOf = (index) => bare.slice(0, index).split("\n").length;
  const details = [];
  const handlers = [];

  if (!/(?:module\.)?exports\.connectorCustomizer\s*=|exports\s*=\s*\{[^}]*\bconnectorCustomizer\b/.test(bare)) {
    details.push({ message: "The script must export `connectorCustomizer` — e.g. exports.connectorCustomizer = async () => createConnectorCustomizer()…" });
  }
  for (const m of bare.matchAll(/\.(before|after)(Std[A-Za-z]*)\s*\(/g)) {
    const cmd = CUSTOMIZABLE_COMMANDS[m[2]];
    if (cmd) handlers.push(`${m[1]}:${cmd}`);
    else details.push({ line: lineOf(m.index), message: `Unknown handler "${m[1]}${m[2]}" — the customizable commands are ${Object.keys(CUSTOMIZABLE_COMMANDS).join(", ")}.` });
  }
  for (const m of bare.matchAll(/\.customizedOperation\s*\(\s*(["'`])([^"'`]*)\1/g)) handlers.push(`operation:${m[2]}`);
  for (const m of bare.matchAll(/\brequire\s*\(\s*(["'`])([^"'`]+)\1\s*\)/g)) {
    if (m[2] !== "@sailpoint/connector-sdk" && !isBuiltin(m[2])) {
      details.push({ line: lineOf(m.index), message: `Cannot require "${m[2]}" — only @sailpoint/connector-sdk and Node built-in modules are available to a customizer built here.` });
    }
  }
  if (handlers.length === 0 && details.length === 0) {
    details.push({ message: "The customizer registers no handlers — add at least one before…/after… handler." });
  }
  return details.length ? { state: "ERROR", details, handlers: [] } : { state: "OK", details: [], handlers: [...new Set(handlers)] };
}

// The uploadable artifact: index.js (what runs) plus the untouched script
// alongside it, so the source travels with the image even though ISC's API
// won't return it. Fixed entry dates keep identical source -> identical zip.
async function buildCustomizerZip(script) {
  const zip = new JSZip();
  const date = new Date(Date.UTC(1980, 0, 1, 0, 0, 0));
  zip.file("index.js", buildIndexJs(script), { date });
  zip.file("customizer-source.js", script, { date });
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

const STARTER_CUSTOMIZER_SCRIPT = `const { createConnectorCustomizer, readConfig } = require("@sailpoint/connector-sdk");

// SaaS connectivity customizer. Register before…/after… handlers for the
// connector commands you want to change:
//   before<Command>(async (context, input)  => input)   — edit what the connector receives
//   after<Command>(async (context, output) => output)  — edit what the connector returns
// Commands: StdTestConnection, StdAccountList, StdAccountRead, StdAccountCreate,
// StdAccountUpdate, StdAccountDelete, StdAccountEnable, StdAccountDisable,
// StdAccountUnlock, StdEntitlementList, StdEntitlementRead, StdChangePassword,
// StdAuthenticate, StdConfigOptions, StdSourceDataDiscover, StdSourceDataRead,
// StdApplicationDiscoveryList.

exports.connectorCustomizer = async () => {
  return createConnectorCustomizer()
    // Runs once per account the connector returns during aggregation.
    .afterStdAccountList(async (context, output) => {
      // output.attributes.displayName = String(output.attributes.displayName || "").trim();
      return output;
    });
};
`;

async function scriptHash(script) {
  try {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(script));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    // No SubtleCrypto: a cheap non-cryptographic fingerprint still detects edits.
    let h = 5381;
    for (let i = 0; i < script.length; i++) h = ((h << 5) + h + script.charCodeAt(i)) | 0;
    return `djb2-${script.length}-${h >>> 0}`;
  }
}

async function sourceResponse(record) {
  if (!record) return { script: STARTER_CUSTOMIZER_SCRIPT, stored: false, deployed: null, dirty: false };
  return {
    script: record.script,
    stored: true,
    updatedAt: record.updatedAt,
    updatedBy: record.updatedBy,
    deployed: record.deployed || null,
    // The saved draft differs from what was last built and uploaded.
    dirty: !record.deployed || record.deployed.hash !== (await scriptHash(record.script)),
  };
}

const actor = () => getCredentials()?.identityId || null;

// Parse + static checks only; the script is never executed.
export async function validateConnectorCustomizerScript(script) {
  return validateCustomizerScript(String(script ?? ""));
}

// The script stored for this customizer — or the starter template when the
// app has none (id "new", or a customizer built outside the app).
export async function getConnectorCustomizerSource(id) {
  const record = id === "new" ? null : await sources().get(String(id));
  return sourceResponse(record);
}

// Saves a draft without touching ISC.
export async function saveConnectorCustomizerSource(id, script) {
  const text = String(script ?? "");
  if (!text.trim()) throw badRequest("script is required");
  if (text.length > MAX_CUSTOMIZER_SCRIPT_CHARS) throw badRequest("script is too large");
  const store = sources();
  const record = { ...((await store.get(String(id))) || {}), script: text, updatedAt: new Date().toISOString(), updatedBy: actor() };
  await store.put(String(id), record);
  return sourceResponse(record);
}

// Drops the stored script — called once the customizer itself is deleted.
export async function deleteConnectorCustomizerSource(id) {
  await sources().delete(String(id));
}

// Validates the script, builds its ZIP and uploads it to ISC as the
// customizer's next version (application/zip to …/versions — the same call
// `sail conn customizers upload` makes), then records it as deployed.
// Returns { version: <ISC's version object>, source: <as getSource> }. A
// failing script rejects with status 422 and { validation } on the error.
export async function deployConnectorCustomizer(id, script) {
  const text = String(script ?? "");
  if (text.length > MAX_CUSTOMIZER_SCRIPT_CHARS) throw badRequest("script is too large");
  const validation = validateCustomizerScript(text);
  if (validation.state !== "OK") {
    const err = badRequest("The script did not pass validation.", 422);
    err.response.data.validation = validation;
    throw err;
  }
  try {
    const zip = await buildCustomizerZip(text);
    const resp = await iscRaw("post", `/v2026/connector-customizers/${encodeURIComponent(id)}/versions`, {
      data: new Blob([zip], { type: "application/zip" }),
      headers: { "Content-Type": "application/zip", Accept: "application/json" },
    });
    const version = resp.data || {};
    const now = new Date().toISOString();
    const record = {
      script: text,
      updatedAt: now,
      updatedBy: actor(),
      deployed: { version: version.version ?? null, imageID: version.imageID ?? null, at: now, by: actor(), hash: await scriptHash(text) },
    };
    await sources().put(String(id), record);
    return { version, source: await sourceResponse(record) };
  } catch (err) {
    throw routeErrorMessages(err);
  }
}
