jest.mock("./isc", () => {
  const badRequest = (message, status = 400) => {
    const out = new Error(message);
    out.isRouteError = true;
    out.response = { status, data: { error: message }, headers: {} };
    return out;
  };
  return { iscGet: jest.fn(), iscPost: jest.fn(), badRequest, routeError: (e) => e };
});

const { iscGet, iscPost } = require("./isc");
const { runAiWorkflow, resetAiWorkflowCache } = require("./aiWorkflow");
const run = (request) => runAiWorkflow(request, { pollMs: 1 });

const WORKFLOW = { id: "wf1", name: "Admin Studio AI Query", enabled: false };
const CONNECTION = { id: "p1", name: "Admin Studio AI Connection", publicFields: { url: "https://api.anthropic.com/v1/messages" } };

function tenant({ workflow = WORKFLOW, history }) {
  iscGet.mockImplementation(async (path) => {
    if (path === "/v2026/workflows") return [{ id: "x", name: "Other" }, workflow].filter(Boolean);
    if (path === "/v2026/parameter-storage/parameters") return [CONNECTION];
    if (path === "/v2026/workflow-executions/ex1") return { id: "ex1", status: "Completed" };
    if (path === "/v2026/workflow-executions/ex1/history") return history;
    throw new Error("unexpected " + path);
  });
  iscPost.mockResolvedValue({ workflowExecutionId: "ex1" });
}

beforeEach(() => {
  jest.resetAllMocks();
  resetAiWorkflowCache();
});

test("hands url + request to the workflow's test endpoint and returns the HTTP step's body", async () => {
  tenant({
    history: [
      { type: "WorkflowExecutionStarted", attributes: {} },
      { type: "ActivityTaskCompleted", attributes: { task: "sp:http", result: { statusCode: 200, body: { content: [{ type: "text", text: "hi" }] } } } },
    ],
  });
  const request = { model: "m", max_tokens: 5, messages: [{ role: "user", content: "Say hi" }] };
  const body = await run(request);
  expect(body.content[0].text).toBe("hi");
  expect(iscPost).toHaveBeenCalledWith("/v2026/workflows/wf1/test", { input: { url: CONNECTION.publicFields.url, request } });
});

test("a provider error status becomes a route error with the provider's message", async () => {
  tenant({
    history: [{ type: "ActivityTaskCompleted", attributes: { task: "sp:http", result: { statusCode: 401, body: { error: { message: "invalid x-api-key" } } } } }],
  });
  await expect(run({})).rejects.toMatchObject({ response: { status: 502, data: { error: expect.stringContaining("invalid x-api-key") } } });
});

test("a failed step surfaces the engine's error", async () => {
  tenant({ history: [{ type: "ActivityTaskFailed", attributes: { error: "failed to retrieve Parameters for authentication type 'header' (type: x)" } }] });
  await expect(run({})).rejects.toMatchObject({ response: { data: { error: "failed to retrieve Parameters for authentication type 'header'" } } });
});

test("refuses to run an enabled workflow and says why", async () => {
  tenant({ workflow: { ...WORKFLOW, enabled: true }, history: [] });
  await expect(run({})).rejects.toMatchObject({ response: { status: 503, data: { error: expect.stringContaining("must stay disabled") } } });
  expect(iscPost).not.toHaveBeenCalled();
});
