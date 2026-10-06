const test = require("node:test");
const assert = require("node:assert");
const { createApp, checkBaseUrl, config, _validated } = require("./index");

const BASE = "https://acme.api.identitynow.com";

async function withServer(opts, fn) {
  process.env.ANTHROPIC_API_KEY = "test-key";
  const server = createApp(opts).listen(0);
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
    _validated.clear();
  }
}

const post = (url, body, headers = {}) =>
  fetch(`${url}/v1/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer tok", "X-ISC-Base-Url": BASE, ...headers },
    body: JSON.stringify(body),
  });

test("checkBaseUrl allowlists ISC tenant hosts only", () => {
  const c = config();
  assert.strictEqual(checkBaseUrl(`${BASE}/`, c), BASE);
  assert.throws(() => checkBaseUrl("https://evil.example.com", c), { status: 403 });
  assert.throws(() => checkBaseUrl("https://acme.api.identitynow.com.evil.com", c), { status: 403 });
  assert.throws(() => checkBaseUrl("", c), { status: 400 });
});

test("rejects missing token, bad prompt and bad maxTokens", async () => {
  await withServer({}, async (url) => {
    assert.strictEqual((await post(url, { prompt: "hi" }, { Authorization: "" })).status, 401);
    assert.strictEqual((await post(url, { prompt: "  " })).status, 400);
    assert.strictEqual((await post(url, { prompt: "hi", maxTokens: 999999 })).status, 400);
    assert.strictEqual((await post(url, { prompt: "hi" }, { "X-ISC-Base-Url": "https://evil.example.com" })).status, 403);
  });
});

test("401 from the tenant means the token is rejected", async () => {
  const fetchImpl = async () => ({ status: 401, ok: false });
  await withServer({ fetchImpl, generateImpl: async () => "x" }, async (url) => {
    assert.strictEqual((await post(url, { prompt: "hi" })).status, 401);
  });
});

test("valid token returns generated text; 403 from tenant still counts as authenticated", async () => {
  const fetchImpl = async () => ({ status: 403, ok: false });
  const generateImpl = async (prompt, opts) => `echo:${prompt}:${opts.maxTokens}:${opts.strong}`;
  await withServer({ fetchImpl, generateImpl }, async (url) => {
    const resp = await post(url, { prompt: "hi", maxTokens: 50, strong: true });
    assert.strictEqual(resp.status, 200);
    assert.deepStrictEqual(await resp.json(), { text: "echo:hi:50:true" });
  });
});
