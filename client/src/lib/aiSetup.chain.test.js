// Runs provisionAiWorkflow through the REAL parameters.js (only the ISC
// transport and the enclave encryption are mocked) to check the whole chain.
import { provisionAiWorkflow } from "./aiSetup";
import { iscGet, iscRaw, iscPost, iscPut } from "./isc";
import { encryptPrivateFields } from "./ported/parameterCrypto";

jest.mock("./isc", () => {
  const actual = jest.requireActual("./isc");
  return { ...actual, iscGet: jest.fn(), iscRaw: jest.fn(), iscPost: jest.fn(), iscPut: jest.fn() };
});
jest.mock("./ported/parameterCrypto", () => ({ encryptPrivateFields: jest.fn() }));
jest.mock("./sailpoint", () => ({ getCredentials: () => ({ identityId: "me" }) }));
jest.mock("./aiProxy", () => ({ setTabAnthropicApiKey: jest.fn() }));

test("key replace on a tenant that has everything sends one PATCH with the encrypted key", async () => {
  // CRA resets mock implementations before each test, so set them here.
  encryptPrivateFields.mockImplementation(async (fields) => `JWE(${JSON.stringify(fields)})`);
  iscGet.mockImplementation(async (path) => {
    if (path.includes("parameter-storage/parameters")) {
      return [
        { id: "conn1", name: "Admin Studio AI Connection", type: "2.4", publicFields: { url: "https://api.anthropic.com/v1/messages" } },
        { id: "key1", name: "Admin Studio AI Key", type: "1.3", publicFields: { headerName: "x-api-key" } },
      ];
    }
    if (path.includes("workflows")) {
      return [{ id: "wf1", name: "Admin Studio AI Query", enabled: false, owner: { type: "IDENTITY", id: "me" }, definition: { steps: { "Query Claude": { attributes: { param_header: { paramID: "key1" } } } } } }];
    }
    throw new Error(`unexpected GET ${path}`);
  });
  iscRaw.mockResolvedValue({ data: { id: "key1" } });

  const result = await provisionAiWorkflow("sk-ant-test-0123456789abcdef");

  expect(iscRaw).toHaveBeenCalledTimes(1);
  expect(iscRaw).toHaveBeenCalledWith("patch", "/v2025/parameter-storage/parameters/key1", {
    data: { privateFields: 'JWE({"headerValue":"sk-ant-test-0123456789abcdef"})' },
    headers: { "Content-Type": "application/json", "X-SailPoint-Experimental": "true" },
  });
  expect(iscPost).not.toHaveBeenCalled();
  expect(iscPut).not.toHaveBeenCalled();
  expect(result.key).toEqual({ id: "key1", action: "updated" });
});
