const { TextDecoder: NodeTextDecoder } = require("util");
global.TextDecoder = global.TextDecoder || NodeTextDecoder;

jest.mock("../isc", () => ({
  iscGet: jest.fn(),
  withApiRetry: (fn) => fn(),
  routeError: (e) => Object.assign(new Error(e.message), { isRouteError: true, response: { status: 500, data: { error: e.message } } }),
  badRequest: (m, s = 400) => Object.assign(new Error(m), { isRouteError: true, response: { status: s, data: { error: m } } }),
}));
jest.mock("../aiProxy", () => ({ generateText: jest.fn() }));
jest.mock("./roleShared", () => ({
  mapWithConcurrency: (items, _n, fn) => Promise.all(items.map(fn)),
  extractAllIdentityEqualsLeaves: () => [],
}));

const { iscGet } = require("../isc");
const { generateText } = require("../aiProxy");
const ai = require("./aiDescriptions");

beforeEach(() => jest.resetAllMocks());

test("single description grounds the prompt in fetched data and returns { description }", async () => {
  iscGet.mockResolvedValue({ name: "Payroll", source: { name: "Workday" }, requestable: true, enabled: false, entitlements: [{ name: "Admin" }] });
  generateText.mockResolvedValue("It grants payroll access.");
  expect(await ai.generateAccessProfileDescription("ap1")).toEqual({ description: "It grants payroll access." });
  const prompt = generateText.mock.calls[0][0];
  expect(prompt).toContain("Access profile name: Payroll");
  expect(prompt).toContain("disabled, so it currently cannot be requested");
});

test("bulk keys results by roleId and isolates per-item failures", async () => {
  iscGet.mockImplementation(async (path) => {
    if (path.endsWith("/bad")) throw new Error("not found");
    return { name: path, entitlements: [] };
  });
  generateText.mockResolvedValue("ok");
  const out = await ai.generateAllAccessProfileDescriptions(["a", "bad"]);
  expect(out.results).toEqual([{ roleId: "a", description: "ok" }, { roleId: "bad", error: "not found" }]);
  await expect(ai.generateAllRoleDescriptions([])).rejects.toThrow("roleIds must be a non-empty array.");
});

test("source descriptions are cut to ISC's 255-character cap at a word boundary", async () => {
  iscGet.mockResolvedValue({ name: "HR" });
  generateText.mockResolvedValue("word ".repeat(100));
  const { description } = await ai.generateSourceDescription("s1");
  expect(description.length).toBeLessThanOrEqual(255);
  expect(description.endsWith("…")).toBe(true);
});

test("generateSourceData strips code fences and counts rows", async () => {
  generateText.mockResolvedValue("```csv\nid,name\n1,a\n2,b\n```");
  const out = await ai.generateSourceData("s", { prompt: "add rows", csvBase64: btoa("id,name\n1,a") });
  expect(out).toEqual({ csv: "id,name\n1,a\n2,b", rows: 2 });
  generateText.mockResolvedValue("sorry no");
  await expect(ai.generateSourceData("s", { prompt: "x", csvBase64: btoa("a b") })).rejects.toThrow("usable CSV");
});
