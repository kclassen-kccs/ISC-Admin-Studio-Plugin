jest.mock("../isc", () => ({ iscGet: jest.fn(), iscPut: jest.fn(), iscPatch: jest.fn(), iscDelete: jest.fn(), describeError: (e) => e?.message, badRequest: (m) => new Error(m) }));
jest.mock("../sailpoint", () => ({ getCredentials: () => ({ tenant: "t" }) }));

const { normalizeTrigger, validateWorkflow, isCronString } = require("./workflows");

const catalog = {
  triggers: [{ id: "idn:cron-schedule", type: "SCHEDULED" }, { id: "idn:identity-attributes-changed", type: "EVENT" }],
  actions: [{ id: "sp:http" }],
  operators: [{ id: "sp:operator-success" }],
};
const steps = { Done: { actionId: "sp:operator-success", type: "success" } };

test("a scheduled trigger without a frequency gets cronSchedule, a time zone and integrationId", () => {
  const out = normalizeTrigger({ type: "SCHEDULED", attributes: { id: "idn:cron-schedule", cronString: " 0 8 * * * " } });
  expect(out.attributes).toMatchObject({ id: "idn:cron-schedule", cronString: "0 8 * * *", frequency: "cronSchedule", integrationId: null });
  expect(typeof out.attributes.timeZone).toBe("string");
  expect(out.attributes.timeZone.length).toBeGreaterThan(0);
});

test("an unknown or companion-less frequency becomes cronSchedule; a complete daily one is kept", () => {
  expect(normalizeTrigger({ type: "SCHEDULED", attributes: { cronString: "0 8 * * *", frequency: "" } }).attributes.frequency).toBe("cronSchedule");
  expect(normalizeTrigger({ type: "SCHEDULED", attributes: { cronString: "0 8 * * *", frequency: "daily" } }).attributes.frequency).toBe("cronSchedule");
  const daily = normalizeTrigger({ type: "SCHEDULED", attributes: { cronString: "0 8 * * *", frequency: "daily", dailyTimes: ["1969-12-31T14:00:00.000Z"], timeZone: "America/Chicago" } });
  expect(daily.attributes).toMatchObject({ frequency: "daily", dailyTimes: ["1969-12-31T14:00:00.000Z"], timeZone: "America/Chicago" });
});

test("other trigger types pass through untouched", () => {
  const event = { type: "EVENT", attributes: { id: "idn:identity-attributes-changed", "filter.$": "$.changes[?(@.attribute == 'department')]" } };
  expect(normalizeTrigger(event)).toBe(event);
});

test("validateWorkflow reports a scheduled trigger with no cron string", () => {
  const missing = validateWorkflow({ name: "W", trigger: { type: "SCHEDULED", attributes: { id: "idn:cron-schedule" } }, definition: { start: "Done", steps } }, catalog);
  expect(missing.some((p) => p.includes("attributes.cronString") && p.includes("missing"))).toBe(true);
  const bad = validateWorkflow({ name: "W", trigger: { type: "SCHEDULED", attributes: { id: "idn:cron-schedule", cronString: "every day at 8" } }, definition: { start: "Done", steps } }, catalog);
  expect(bad.some((p) => p.includes("attributes.cronString"))).toBe(true);
  const ok = validateWorkflow({ name: "W", trigger: { type: "SCHEDULED", attributes: { id: "idn:cron-schedule", cronString: "0 8 * * *" } }, definition: { start: "Done", steps } }, catalog);
  expect(ok.filter((p) => p.includes("cronString"))).toEqual([]);
});

test("isCronString accepts the shapes ISC stores and rejects prose", () => {
  for (const c of ["0 8 * * *", "0 0 * * 0", "30 * * * *", "00 * * * * *", "0 14 * * 6"]) expect(isCronString(c)).toBe(true);
  for (const c of ["", "daily", "0 8 * *", "every morning", undefined, null]) expect(isCronString(c)).toBe(false);
});
