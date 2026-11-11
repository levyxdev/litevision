import { afterEach, describe, expect, test } from "bun:test";
import { startHarness, type Harness } from "./harness.ts";
import { recorded, textOf, type ToolResult } from "./helpers.ts";

const openai = { id: "openai", baseUrl: "https://api.openai.com/v1" };
const google = { id: "google", baseUrl: "https://generativelanguage.googleapis.com/v1beta" };
const credentials = { openai: { apiKey: "sk-test-0000secret0000" }, google: { apiKey: "AIza-test-0000secret" } };

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

interface GuideOutput {
  family: string;
  checked: string;
  sources: string[];
  parameters: Array<{ name: string; values: string; default: string; price: string }>;
}

type Listed = { parameters: string; parameter_guide?: GuideOutput | null; docs_url: string | null };

const modelsOf = (result: ToolResult) => (result.structuredContent as { models: Listed[] }).models;

async function describe1(models: unknown[], alias: string) {
  harness = await startHarness({ config: { providers: [openai, google], models }, credentials });
  const result = await harness.client.callTool({ name: "list_models", arguments: { model: alias } });
  expect(result.isError).toBeFalsy();
  return { result, model: modelsOf(result)[0]! };
}

describe("list_models: the Parameter Guide (ADR 0010)", () => {
  test("with `model`, an OpenAI gpt-image-2.5 Model shows `size` with its arbitrary-size rule, `quality`, and the entry's sources and check date", async () => {
    const { result, model } = await describe1(
      [{ alias: "flare", provider: "openai", modelId: "gpt-image-2.5-flare", protocol: "openai-images" }],
      "flare",
    );
    const guide = model.parameter_guide!;
    expect(guide.checked).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(guide.sources.length).toBeGreaterThan(0);
    const size = guide.parameters.find((parameter) => parameter.name === "size")!;
    expect(size.values).toContain("multiples of 16");
    expect(size.values).toContain("3840");
    expect(size.default).toBe("auto");
    const quality = guide.parameters.find((parameter) => parameter.name === "quality")!;
    expect(quality.values).toContain("high");
    expect(quality.price).not.toBe("");

    const text = textOf(result);
    expect(text).toContain("Parameter Guide for");
    expect(text).toContain("- size:");
    expect(text).toContain(guide.checked);
    expect(text).toContain(guide.sources[0]!);
  });

  test("with `model`, a Gemini image Model shows `response_format.image_size` with its tiers and `response_format.aspect_ratio` with its ratios", async () => {
    const { model } = await describe1(
      [{ alias: "banana", provider: "google", modelId: "gemini-3-pro-image", protocol: "gemini" }],
      "banana",
    );
    const parameters = model.parameter_guide!.parameters;
    const imageSize = parameters.find((parameter) => parameter.name === "response_format.image_size")!;
    expect(imageSize.values).toContain("1K");
    expect(imageSize.values).toContain("4K");
    const ratio = parameters.find((parameter) => parameter.name === "response_format.aspect_ratio")!;
    expect(ratio.values).toContain("21:9");
    expect(ratio.values).toContain("16:9");
  });

  test("without `model`, each Model gets a short summary, not the full guide", async () => {
    harness = await startHarness({
      config: { providers: [openai], models: [{ alias: "flare", provider: "openai", modelId: "gpt-image-2.5-flare", protocol: "openai-images" }] },
      credentials,
    });
    const result = await harness.client.callTool({ name: "list_models", arguments: {} });
    const [model] = modelsOf(result);
    expect(model).not.toHaveProperty("parameter_guide");
    expect(model!.parameters).toContain("size");
    expect(model!.parameters).toContain("quality");
    expect(textOf(result)).not.toContain("- size:");
    expect(textOf(result)).toContain("Parameter Guide for");
  });

  test("a model id that matches no family gets no guessed entry: litevision says it has none and gives the docs link", async () => {
    const { result, model } = await describe1(
      [{ alias: "mystery", provider: "openai", modelId: "acme-paint-7", protocol: "openai-images" }],
      "mystery",
    );
    expect(model.parameter_guide).toBeNull();
    expect(model.parameters).toContain("no Parameter Guide");
    expect(model.parameters).toContain(model.docs_url!);
    expect(textOf(result)).toContain("no Parameter Guide");
  });
});

describe("list_models: Parameter Guide entries for Venice, APIMart and Together (ADR 0010)", () => {
  const together = { id: "together-ai", baseUrl: "https://api.together.ai/v1" };
  const apimart = { id: "apimart", baseUrl: "https://api.apimart.ai/v1" };
  const venice = { id: "venice", baseUrl: "https://api.venice.ai/api/v1" };
  const keys = { "together-ai": { apiKey: "together-test-0000secret0000" }, apimart: { apiKey: "sk-apimart-0000secret" }, venice: { apiKey: "venice-0000secret" } };

  async function guideOf(model: Record<string, unknown>, routes: Record<string, () => Response> = {}) {
    harness = await startHarness({ config: { providers: [together, apimart, venice], models: [{ alias: "m", ...model }] }, credentials: keys, routes });
    const result = await harness.client.callTool({ name: "list_models", arguments: { model: "m" } });
    expect(result.isError).toBeFalsy();
    return { result, model: (result.structuredContent as { models: Array<Listed & { parameter_schema?: unknown }> }).models[0]! };
  }
  const parameter = (guide: GuideOutput, name: string) => guide.parameters.find((candidate) => candidate.name === name)!;

  test("a Together FLUX Model's guide gives width and height", async () => {
    const { model } = await guideOf({ provider: "together-ai", modelId: "black-forest-labs/FLUX.2-pro", protocol: "together" });
    const guide = model.parameter_guide!;
    expect(parameter(guide, "width").values).toContain("1920");
    expect(guide.checked).toBe("2026-11-05");
    expect(guide.sources.some((source) => source.startsWith("https://docs.together.ai/"))).toBe(true);
  });

  test("a Together Wan 2.7 video Model's guide gives resolution, ratio and seconds with their defaults", async () => {
    const { model } = await guideOf({ provider: "together-ai", modelId: "Wan-AI/wan2.7-t2v", protocol: "together", modality: "video" });
    const guide = model.parameter_guide!;
    expect(parameter(guide, "resolution")).toMatchObject({ default: "1080P" });
    expect(parameter(guide, "resolution").values).toContain("720P");
    expect(parameter(guide, "ratio")).toMatchObject({ default: "16:9" });
    expect(parameter(guide, "seconds").values).toContain("2–15");
    expect(parameter(guide, "seconds").default).toContain("5");
  });

  test("an APIMart GPT Image Model shows the built-in entry when the schema endpoint does not answer", async () => {
    const { model } = await guideOf(
      { provider: "apimart", modelId: "gpt-image-2.5-flare", protocol: "apimart" },
      { "GET https://api.apimart.ai/v1/models/gpt-image-2.5-flare/schema": () => new Response("unavailable", { status: 503 }) },
    );
    expect(model.parameter_schema).toBeUndefined();
    expect(parameter(model.parameter_guide!, "resolution").values).toContain("4k");
    expect(parameter(model.parameter_guide!, "size").default).toBe("auto");
  });

  test("a Venice Model shows the built-in entry when its model list does not answer", async () => {
    const down = () => new Response("unavailable", { status: 503 });
    const { model } = await guideOf(
      { provider: "venice", modelId: "nano-banana-pro", protocol: "venice" },
      { "GET https://api.venice.ai/api/v1/models?type=image": down, "GET https://api.venice.ai/api/v1/models?type=inpaint": down },
    );
    expect(model.parameter_schema).toBeUndefined();
    expect(parameter(model.parameter_guide!, "resolution").values).toContain("4K");
    expect(parameter(model.parameter_guide!, "resolution").price).toContain("nano-banana-pro $0.18");
  });

  test("a Venice Model shows Venice's own description when its model list answers", async () => {
    const { model } = await guideOf(
      { provider: "venice", modelId: "venice-sd35", protocol: "venice" },
      { "GET https://api.venice.ai/api/v1/models?type=image": recorded("venice/models-image.json") as () => Response },
    );
    expect(model.parameter_guide).toBeNull();
    expect(model.parameter_schema).toBeDefined();
  });
});

describe("list_models: a Model the Provider describes itself (ADR 0010)", () => {
  test("shows the Provider's description in place of a built-in entry", async () => {
    const base = "https://api.apimart.ai/v1";
    harness = await startHarness({
      config: {
        providers: [{ id: "apimart", baseUrl: base }],
        models: [{ alias: "gpt2", provider: "apimart", modelId: "gpt-image-2", protocol: "apimart" }],
      },
      credentials: { apimart: { apiKey: "sk-apimart-0000secret0000" } },
      routes: { [`GET ${base}/models/gpt-image-2/schema`]: recorded("apimart/schema-gpt-image-2.json") },
    });
    const result = await harness.client.callTool({ name: "list_models", arguments: { model: "gpt2" } });
    const model = (result.structuredContent as { models: Array<Listed & { parameter_schema?: unknown }> }).models[0]!;
    expect(model.parameter_guide).toBeNull();
    expect(model.parameter_schema).toBeDefined();
    expect(model.parameters).toContain('Provider "apimart" describes this Model\'s parameters itself');
    expect(textOf(result)).toContain('Parameter schema from Provider "apimart"');
    expect(textOf(result)).not.toContain("Parameter Guide for");
  });
});

describe("rejected options carry the Parameter Guide (ADR 0010)", () => {
  test("an option the Provider rejects comes back with the Model's Parameter Guide, its docs link and its Option Statuses", async () => {
    harness = await startHarness({
      config: { providers: [openai], models: [{ alias: "flare", provider: "openai", modelId: "gpt-image-2.5-flare", protocol: "openai-images" }] },
      credentials,
      routes: { "POST https://api.openai.com/v1/images/generations": recorded("openai/invalid-value.json", 400) },
    });
    const result = await harness.client.callTool({
      name: "generate_image",
      arguments: { prompt: "a red fox", model: "flare", provider_options: { quality: "ultra" } },
    });
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("rejected an option");
    expect(text).toContain("Parameter Guide for");
    expect(text).toContain("- quality:");
    expect(text).toContain("https://platform.openai.com/docs/api-reference/images/create");
    // OpenAI names the option in a field of its own, not in its message; the rejection is recorded all the same.
    expect(text).toMatch(/- Rejected: \{"quality":"ultra"\}, Job \S+ on \d{4}-\d{2}-\d{2}: HTTP 400: Invalid value: 'ultra'/);
  });
});
