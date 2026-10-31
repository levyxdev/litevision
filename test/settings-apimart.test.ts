import { afterEach, describe, expect, test } from "bun:test";
import { fixture } from "./recorded-http.ts";
import { startSettingsHarness, type SettingsHarness, type SettingsHarnessOptions } from "./settings-harness.ts";

const apiKey = "sk-apimart-0000secret0000";
const modelsUrl = "GET https://api.apimart.ai/v1/models?expand=category&category=image";
const saved = {
  config: { providers: [{ id: "apimart", baseUrl: "https://api.apimart.ai/v1" }], models: [] },
  credentials: { apimart: { apiKey } },
};

let harness: SettingsHarness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function start(options: SettingsHarnessOptions): Promise<SettingsHarness> {
  harness = await startSettingsHarness(options);
  return harness;
}

describe("an APIMart Provider in the settings page", () => {
  test("test connection succeeds through the injected transport and counts the image models", async () => {
    const h = await start({ ...saved, routes: { [modelsUrl]: fixture("apimart/models.json") } });
    const response = await h.send("POST", "/api/providers/apimart/test-connection", { body: { protocol: "apimart" } });

    expect(response.json()).toEqual({ result: "success", message: expect.stringContaining('Provider "apimart"') });
    expect(response.json().message).toContain("3 image model id(s)");
    expect(h.requests[0]!.url).toBe("https://api.apimart.ai/v1/models?expand=category&category=image");
    expect(h.requests[0]!.headers.get("authorization")).toBe(`Bearer ${apiKey}`);
  });

  test("test connection reports a rejected Credential without revealing it", async () => {
    const h = await start({ ...saved, routes: { [modelsUrl]: fixture("apimart/invalid-api-key.json", 401) } });
    const response = await h.send("POST", "/api/providers/apimart/test-connection", { body: { protocol: "apimart" } });

    expect(response.json().result).toBe("failure");
    expect(response.json().message).toContain("HTTP 401");
    expect(response.json().message).toContain("check your API key");
    expect(response.text).not.toContain(apiKey);
  });

  test("lists only the image models APIMart offers", async () => {
    const h = await start({ ...saved, routes: { [modelsUrl]: fixture("apimart/models.json") } });
    const response = await h.send("POST", "/api/providers/apimart/model-ids", { body: { protocol: "apimart" } });

    expect(response.json()).toEqual({ result: "success", modelIds: ["gemini-3-pro-image-preview", "gpt-image-2", "seedream-4.5"] });
  });
});
