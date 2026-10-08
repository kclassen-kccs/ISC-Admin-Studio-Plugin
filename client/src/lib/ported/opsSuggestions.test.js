jest.mock("../aiProxy", () => ({ generateText: jest.fn() }));
jest.mock("./roleShared", () => ({ tenantKey: () => "tenant-a" }));
jest.mock("../store", () => {
  const data = new Map();
  return {
    recordStore: () => ({
      get: async (k) => data.get(k),
      put: async (k, v) => { data.set(k, v); },
      all: async () => Object.fromEntries(data),
    }),
  };
});

const { generateText } = require("../aiProxy");
const ops = require("./opsSuggestions");

beforeEach(() => jest.resetAllMocks());

test("explains a failed event once, then serves the saved suggestion", async () => {
  generateText.mockResolvedValue("The source's credentials expired. Update them under Admin > Connections > Sources.");
  const event = { id: "ev1", name: "Aggregation failed", status: "FAILED", errors: ["401 from the connector"] };
  const first = await ops.suggestFix("event", event);
  expect(first).toMatchObject({ cached: false });
  const prompt = generateText.mock.calls[0][0];
  expect(prompt).toContain("senior SailPoint Identity Security Cloud");
  expect(prompt).toContain("errors: [\"401 from the connector\"]");
  expect(generateText.mock.calls[0][1]).toEqual({ maxTokens: 600 });

  const again = await ops.suggestFix("event", event);
  expect(again).toMatchObject({ cached: true, suggestion: first.suggestion });
  expect(generateText).toHaveBeenCalledTimes(1);
  expect(await ops.getEventFixSuggestion("ev1")).toMatchObject({ suggestion: first.suggestion, cached: true });
  expect(await ops.listEventFixSuggestions()).toEqual([{ eventId: "ev1", generatedAt: first.generatedAt }]);
});

test("connector log lines are redacted before they leave", async () => {
  generateText.mockResolvedValue("ok");
  await ops.suggestFix("connectorLog", { id: "log1", sourceName: "Okta", lines: [{ message: "Authorization: Bearer abcdefghijklmnop password=hunter2", focus: true }] });
  const prompt = generateText.mock.calls[0][0];
  expect(prompt).not.toContain("abcdefghijklmnop");
  expect(prompt).not.toContain("hunter2");
  expect(prompt).toContain(">>>");
});

test("rejects unknown kinds and items without an id", async () => {
  await expect(ops.suggestFix("nope", { id: 1 })).rejects.toMatchObject({ response: { status: 400 } });
  await expect(ops.suggestFix("event", {})).rejects.toMatchObject({ response: { status: 400 } });
  expect(generateText).not.toHaveBeenCalled();
});
