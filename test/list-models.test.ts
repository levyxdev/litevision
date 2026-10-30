import { afterEach, describe, expect, test } from "bun:test";
import { startHarness, type Harness } from "./harness.ts";
import { recorded, textOf } from "./helpers.ts";

const openai = { id: "openai", baseUrl: "https://api.openai.com/v1" };
const relay = { id: "relay", baseUrl: "https://relay.example/v1" };

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

const listModels = () => harness!.client.callTool({ name: "list_models", arguments: {} });

describe("list_models", () => {
  test("returns each Model's Alias, Provider, Protocol, capabilities and Model Notes, plus the default", async () => {
    harness = await startHarness({
      config: {
        providers: [openai, relay],
        models: [
          { alias: "gpt-image", provider: "openai", modelId: "gpt-image-1", protocol: "openai-images", notes: "photoreal, legible text" },
          { alias: "dalle", provider: "relay", modelId: "dall-e-3", protocol: "openai-images" },
        ],
        defaultImageModel: "gpt-image",
      },
    });
    const result = await listModels();

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      default_model: "gpt-image",
      models: [
        {
          alias: "gpt-image",
          provider: "openai",
          protocol: "openai-images",
          model_id: "gpt-image-1",
          default: true,
          notes: "photoreal, legible text",
          docs_url: "https://platform.openai.com/docs/api-reference/images/create",
          capabilities: {
            aspect_ratios: [
              { aspect_ratio: "1:1", size: "1024x1024" },
              { aspect_ratio: "3:2", size: "1536x1024" },
              { aspect_ratio: "2:3", size: "1024x1536" },
            ],
            reference_images: true,
            max_reference_images: 16,
            max_images_per_job: 10,
          },
        },
        {
          alias: "dalle",
          provider: "relay",
          protocol: "openai-images",
          model_id: "dall-e-3",
          default: false,
          notes: "",
          docs_url: "https://platform.openai.com/docs/api-reference/images/create",
          capabilities: {
            aspect_ratios: [
              { aspect_ratio: "1:1", size: "1024x1024" },
              { aspect_ratio: "16:9", size: "1792x1024" },
              { aspect_ratio: "9:16", size: "1024x1792" },
            ],
            reference_images: false,
            max_reference_images: 0,
            max_images_per_job: 1,
          },
        },
      ],
    });
    const text = textOf(result);
    expect(text).toContain("gpt-image (default)");
    expect(text).toContain("photoreal, legible text");
    expect(text).toContain("no reference images");
  });

  test("with no Model configured, tells the Agent to call open_settings", async () => {
    harness = await startHarness({ config: { providers: [openai] } });
    const result = await listModels();
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Call `open_settings`");
  });

  test("still lists a Model whose Protocol litevision does not support, saying so", async () => {
    harness = await startHarness({
      config: { providers: [openai], models: [{ alias: "odd", provider: "openai", modelId: "x", protocol: "carrier-pigeon" }] },
    });
    const result = await listModels();
    expect(result.isError).toBeFalsy();
    const [model] = (result.structuredContent as { models: Array<Record<string, unknown>> }).models;
    expect(model).toMatchObject({ alias: "odd", capabilities: null });
    expect(String(model!.problem)).toContain('Protocol "carrier-pigeon"');
  });

  test("the default image Model the User sets in the settings page is what generate_image uses when `model` is omitted", async () => {
    harness = await startHarness({
      config: {
        providers: [openai],
        models: [
          { alias: "gpt-image", provider: "openai", modelId: "gpt-image-1", protocol: "openai-images" },
          { alias: "dalle", provider: "openai", modelId: "dall-e-3", protocol: "openai-images" },
        ],
        defaultImageModel: "gpt-image",
      },
      credentials: { openai: { apiKey: "sk-test-0000secret0000" } },
      routes: { "POST https://api.openai.com/v1/images/generations": recorded("openai/generations.json") },
    });

    await harness.client.callTool({ name: "open_settings", arguments: {} });
    const page = new URL(harness.openedUrls[0]!);
    const response = await fetch(new URL("/api/default-image-model", page.origin), {
      method: "PUT",
      headers: {
        origin: page.origin,
        "x-litevision-token": page.searchParams.get("token")!,
        "content-type": "application/json",
      },
      body: JSON.stringify({ alias: "dalle" }),
    });
    expect(response.status).toBe(200);

    expect((await listModels()).structuredContent).toMatchObject({ default_model: "dalle" });
    const result = await harness.client.callTool({ name: "generate_image", arguments: { prompt: "a red fox" } });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ model: "dalle" });
    expect(JSON.parse(await harness.requests[0]!.text()).model).toBe("dall-e-3");
  });

  test("the server instructions tell the Agent to choose by Model Notes with list_models", async () => {
    harness = await startHarness();
    expect(harness.client.getInstructions()).toContain("list_models");
  });
});
