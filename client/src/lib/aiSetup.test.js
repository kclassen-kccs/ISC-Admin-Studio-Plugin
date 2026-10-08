import { provisionAiWorkflow, describeAiSetup, ANTHROPIC_MESSAGES_URL } from "./aiSetup";
import { iscGet, iscPost, iscPut } from "./isc";
import { createParameter, updateParameter } from "./ported/parameters";

jest.mock("./isc", () => {
  const actual = jest.requireActual("./isc");
  return { ...actual, iscGet: jest.fn(), iscPost: jest.fn(), iscPut: jest.fn() };
});
jest.mock("./ported/parameters", () => ({ createParameter: jest.fn(), updateParameter: jest.fn() }));
jest.mock("./sailpoint", () => ({ getCredentials: () => ({ identityId: "me" }) }));

const KEY = "sk-ant-test-0123456789abcdef";

function tenant({ parameters = [], workflows = [] } = {}) {
  iscGet.mockImplementation(async (path) => {
    if (path.includes("parameter-storage")) return parameters;
    if (path.includes("workflows")) return workflows;
    throw new Error(`unexpected GET ${path}`);
  });
}

const bound = (paramID, enabled = false) => ({
  id: "wf1",
  name: "Admin Studio AI Query",
  enabled,
  owner: { type: "IDENTITY", id: "me" },
  definition: { steps: { "Query Claude": { attributes: { param_header: { paramID } } } } },
});

beforeEach(() => {
  jest.clearAllMocks();
});

test("creates both parameters and the bound, disabled workflow on an empty tenant", async () => {
  tenant();
  createParameter.mockImplementationOnce(async () => ({ id: "conn1" })).mockImplementationOnce(async () => ({ id: "key1" }));
  iscPost.mockResolvedValue({ ...bound(undefined), owner: { type: "IDENTITY", id: "me" } });
  iscPut.mockResolvedValue(bound("key1"));

  const result = await provisionAiWorkflow(KEY);

  expect(createParameter.mock.calls[0][0]).toMatchObject({ type: "2.4", name: "Admin Studio AI Connection", publicFields: { url: ANTHROPIC_MESSAGES_URL } });
  expect(createParameter.mock.calls[1][0]).toMatchObject({ type: "1.3", name: "Admin Studio AI Key", publicFields: { headerName: "x-api-key" }, privateFields: { headerValue: KEY } });
  const posted = iscPost.mock.calls[0][1];
  expect(posted.enabled).toBe(false);
  expect(posted.owner).toEqual({ type: "IDENTITY", id: "me" });
  expect(posted.definition.steps["Query Claude"].attributes.param_header.paramID).toBe("key1");
  // the POST drops the binding, so a PUT follows
  expect(iscPut).toHaveBeenCalledWith("/v2026/workflows/wf1", expect.objectContaining({ enabled: false, owner: { type: "IDENTITY", id: "me" } }));
  expect(result).toEqual({ connection: { id: "conn1", action: "created" }, key: { id: "key1", action: "created" }, workflow: { id: "wf1", action: "created" } });
  expect(describeAiSetup(result)).toBe("Created the AI connection, key parameter and workflow on this tenant.");
});

test("a key update replaces the secret and leaves a correct tenant alone", async () => {
  tenant({
    parameters: [
      { id: "conn1", name: "Admin Studio AI Connection", publicFields: { url: ANTHROPIC_MESSAGES_URL } },
      { id: "key1", name: "Admin Studio AI Key", publicFields: { headerName: "x-api-key" } },
    ],
    workflows: [bound("key1")],
  });
  updateParameter.mockResolvedValue({ id: "key1" });

  const result = await provisionAiWorkflow(KEY);

  expect(createParameter).not.toHaveBeenCalled();
  expect(updateParameter).toHaveBeenCalledTimes(1);
  expect(updateParameter).toHaveBeenCalledWith("key1", { privateFields: { headerValue: KEY } });
  expect(iscPost).not.toHaveBeenCalled();
  expect(iscPut).not.toHaveBeenCalled();
  expect(result.workflow).toEqual({ id: "wf1", action: "present" });
  expect(describeAiSetup(result)).toBe('Updated the "Admin Studio AI Key" parameter; the connection parameter and workflow are in place.');
});

test("re-binds and disables a drifted workflow and restores a blank connection URL", async () => {
  tenant({
    parameters: [
      { id: "conn1", name: "Admin Studio AI Connection", publicFields: {} },
      { id: "key1", name: "Admin Studio AI Key", publicFields: { headerName: "x-api-key" } },
    ],
    workflows: [bound("stale", true)],
  });
  updateParameter.mockResolvedValue({});
  iscPut.mockResolvedValue(bound("key1"));

  const result = await provisionAiWorkflow(KEY);

  expect(updateParameter).toHaveBeenCalledWith("conn1", { publicFields: { url: ANTHROPIC_MESSAGES_URL } });
  expect(iscPut).toHaveBeenCalledTimes(1);
  expect(result.connection.action).toBe("repaired");
  expect(result.workflow.action).toBe("disabled");
});

test("a refused secret is an error, not a silent placeholder", async () => {
  tenant({ parameters: [{ id: "conn1", name: "Admin Studio AI Connection", publicFields: { url: ANTHROPIC_MESSAGES_URL } }] });
  createParameter.mockResolvedValue({ id: "key1", _secretNotSaved: { fields: ["headerValue"], reason: 'ISC answered 400 "validation error"' } });

  await expect(provisionAiWorkflow(KEY)).rejects.toMatchObject({ response: { status: 502 } });
  expect(iscPost).not.toHaveBeenCalled();
});
