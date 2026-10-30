import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { registerProtocol } from "../src/protocols/index.ts";
import { openaiImages } from "../src/protocols/openai-images.ts";
import { inParallel } from "../src/protocols/parallel.ts";
import type { ProtocolAdapter, ProviderModelInfo } from "../src/protocols/protocol.ts";
import { startHarness, type Harness, type HarnessOptions, type Route } from "./harness.ts";
import { readHistory, recorded, textOf, tinyPng } from "./helpers.ts";
import { startSettingsHarness, type SettingsHarness } from "./settings-harness.ts";

/**
 * No real Protocol asks its Provider for capabilities or returns one image per request yet, so these tests drive the
 * shared machinery through a stand-in Protocol: OpenAI's images API, plus a made-up capabilities endpoint, sending one
 * request per image.
 */
const liveTest: ProtocolAdapter = {
  ...openaiImages,
  builtInCapabilities: () => ({ sizes: [{ aspectRatio: "1:1", width: 512, height: 512 }], maxReferences: 0, maxImages: 4 }),
  docsUrl: (modelId) => `https://docs.relay.example/models/${modelId}`,
  async fetchModelInfo(target, http) {
    const response = await http(`${target.baseUrl}/models/${target.modelId}/capabilities`, {
      headers: { authorization: `Bearer ${target.credential}` },
    });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()) as ProviderModelInfo;
  },
  async submit(request, target, http) {
    return {
      wait: () =>
        inParallel(request.n, target.providerId, async () => (await (await openaiImages.submit({ ...request, n: 1 }, target, http)).wait()).images),
    };
  },
};

let unregister: () => void;
beforeAll(() => {
  unregister = registerProtocol("live-test", liveTest);
});
afterAll(() => unregister());

const apiKey = "sk-relay-0000secret0000";
const relay = { id: "relay", baseUrl: "https://relay.example/v1" };
const capabilitiesUrl = "GET https://relay.example/v1/models/fox-1/capabilities";
const generationsUrl = "POST https://relay.example/v1/images/generations";

const reported = {
  capabilities: {
    sizes: [
      { aspectRatio: "1:1", width: 1024, height: 1024 },
      { aspectRatio: "16:9", width: 1344, height: 768 },
    ],
    maxReferences: 4,
    maxImages: 4,
  },
  parameterSchema: { type: "object", properties: { style: { type: "string" }, quality: { enum: ["low", "high"] } } },
};
const reportCapabilities: Route = () => Response.json(reported);

let clock = new Date(2026, 9, 30, 14, 5, 0).getTime();
const hours = (count: number) => count * 60 * 60 * 1000;

function relaySetup(routes: HarnessOptions["routes"] = {}): HarnessOptions {
  return {
    config: {
      providers: [relay],
      models: [{ alias: "fox", provider: "relay", modelId: "fox-1", protocol: "live-test" }],
      defaultImageModel: "fox",
    },
    credentials: { relay: { apiKey } },
    routes: { [generationsUrl]: recorded("openai/generations.json"), ...routes },
    now: () => new Date(clock),
  };
}

const capabilityRequests = (harness: { requests: Request[] }) =>
  harness.requests.filter((request) => request.url.endsWith("/capabilities")).length;

let harness: Harness | undefined;
let settings: SettingsHarness | undefined;
afterEach(async () => {
  await harness?.close();
  await settings?.close();
  harness = undefined;
  settings = undefined;
  clock = new Date(2026, 9, 30, 14, 5, 0).getTime();
});

const listModels = (args: Record<string, unknown> = {}) => harness!.client.callTool({ name: "list_models", arguments: args });
const generate = (args: Record<string, unknown>) =>
  harness!.client.callTool({ name: "generate_image", arguments: { prompt: "a red fox", ...args } });

describe("live Model capabilities", () => {
  test("list_models reports what the Provider says the Model can do, and asks again only after a day", async () => {
    harness = await startHarness(relaySetup({ [capabilitiesUrl]: reportCapabilities }));

    const result = await listModels();
    expect(result.isError).toBeFalsy();
    const [model] = (result.structuredContent as { models: Array<Record<string, unknown>> }).models;
    expect(model!.capabilities).toEqual({
      aspect_ratios: [
        { aspect_ratio: "1:1", size: "1024x1024" },
        { aspect_ratio: "16:9", size: "1344x768" },
      ],
      reference_images: true,
      max_reference_images: 4,
      max_images_per_job: 4,
    });
    expect(model!.docs_url).toBe("https://docs.relay.example/models/fox-1");
    expect(harness.requests[0]!.headers.get("authorization")).toBe(`Bearer ${apiKey}`);

    await listModels();
    clock += hours(23);
    await listModels();
    expect(capabilityRequests(harness)).toBe(1);

    clock += hours(2);
    await listModels();
    expect(capabilityRequests(harness)).toBe(2);
  });

  test("generate_image maps the aspect ratio onto the sizes the Provider reported", async () => {
    harness = await startHarness(relaySetup({ [capabilitiesUrl]: reportCapabilities }));
    const result = await generate({ aspect_ratio: "16:9" });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ size: "1344x768", aspect_ratio_adjusted: false });
    const generation = harness.requests.find((request) => request.url.endsWith("/images/generations"))!;
    expect(((await generation.json()) as { size: string }).size).toBe("1344x768");
  });

  test("with the Provider unreachable, falls back to the built-in capabilities and generate_image still works", async () => {
    harness = await startHarness(relaySetup());

    const [model] = ((await listModels()).structuredContent as { models: Array<Record<string, any>> }).models;
    expect(model!.capabilities.aspect_ratios).toEqual([{ aspect_ratio: "1:1", size: "512x512" }]);

    const result = await generate({ aspect_ratio: "16:9" });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ size: "512x512", aspect_ratio_adjusted: true });
  });

  test("when the Provider stops answering, keeps using its last answer", async () => {
    let up = true;
    harness = await startHarness(
      relaySetup({ [capabilitiesUrl]: (request) => (up ? reportCapabilities(request) : new Response("down", { status: 503 })) }),
    );
    await listModels();
    up = false;
    clock += hours(25);

    const [model] = ((await listModels()).structuredContent as { models: Array<Record<string, any>> }).models;
    expect(capabilityRequests(harness)).toBe(2);
    expect(model!.capabilities.max_reference_images).toBe(4);
  });

  test("without a saved Credential, never asks the Provider", async () => {
    harness = await startHarness({ ...relaySetup({ [capabilitiesUrl]: reportCapabilities }), credentials: {} });
    const [model] = ((await listModels()).structuredContent as { models: Array<Record<string, any>> }).models;
    expect(model!.capabilities.aspect_ratios).toEqual([{ aspect_ratio: "1:1", size: "512x512" }]);
    expect(harness.requests).toHaveLength(0);
  });

  test("an answer the Provider gives in a shape litevision cannot use leaves the built-in capabilities in place", async () => {
    harness = await startHarness(
      relaySetup({ [capabilitiesUrl]: () => Response.json({ capabilities: { sizes: [] }, parameterSchema: { type: "object" } }) }),
    );
    const [model] = ((await listModels({ model: "fox" })).structuredContent as { models: Array<Record<string, any>> }).models;
    expect(model!.capabilities.aspect_ratios).toEqual([{ aspect_ratio: "1:1", size: "512x512" }]);
    expect(model!.parameter_schema).toEqual({ type: "object" });
  });
});

describe("list_models with `model`", () => {
  test("describes one Model with its docs link, the Provider's parameter schema and the provider_options known to work", async () => {
    const generation: Route = async (request) => {
      const body = (await request.json()) as { seed?: number };
      if (body.seed !== undefined) return recorded("openai/server-error.json", 400)(request);
      return recorded("openai/generations.json")(request);
    };
    harness = await startHarness(relaySetup({ [capabilitiesUrl]: reportCapabilities, [generationsUrl]: generation }));

    expect((await generate({ provider_options: { style: "anime" } })).isError).toBeFalsy();
    expect((await generate({ provider_options: { style: "noir", quality: "high" } })).isError).toBeFalsy();
    expect((await generate({ provider_options: { seed: 7 } })).isError).toBe(true);

    const result = await listModels({ model: "fox" });
    expect(result.isError).toBeFalsy();
    const { models } = result.structuredContent as { models: Array<Record<string, unknown>> };
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      alias: "fox",
      docs_url: "https://docs.relay.example/models/fox-1",
      parameter_schema: reported.parameterSchema,
      known_good_options: { style: "noir", quality: "high" },
    });
    expect(textOf(result)).toContain('"quality":"high"');
    expect(textOf(result)).toContain("https://docs.relay.example/models/fox-1");
  });

  test("without `model`, leaves the schema and known-good options out", async () => {
    harness = await startHarness(relaySetup({ [capabilitiesUrl]: reportCapabilities }));
    const [model] = ((await listModels()).structuredContent as { models: Array<Record<string, unknown>> }).models;
    expect(model).not.toHaveProperty("parameter_schema");
    expect(model).not.toHaveProperty("known_good_options");
  });

  test("an unknown Alias errors and lists the known ones", async () => {
    harness = await startHarness(relaySetup());
    const result = await listModels({ model: "wolf" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Unknown Model Alias "wolf"');
    expect(textOf(result)).toContain("fox");
  });

  test("the server instructions point the Agent at list_models for provider_options", async () => {
    harness = await startHarness();
    expect(harness.client.getInstructions()).toContain("`list_models` with `model`");
  });
});

describe("partial results", () => {
  test("a Job that gets some but not all of its images completes and says how many and why", async () => {
    let count = 0;
    const flaky: Route = (request) => {
      count += 1;
      return count === 2 ? recorded("openai/rate-limit-exceeded.json", 429)(request) : recorded("openai/generations.json")(request);
    };
    harness = await startHarness(relaySetup({ [generationsUrl]: flaky }));

    const result = await generate({ n: 3 });
    expect(result.isError).toBeFalsy();
    const output = result.structuredContent as { files: string[]; shortfall: string; job_id: string };
    expect(output.files).toHaveLength(2);
    expect(output.shortfall).toContain('Got 2 of 3 images from Provider "relay"');
    expect(output.shortfall).toContain("1 of 3 requests");
    expect(textOf(result)).toContain("Got 2 of 3 images");
    expect(JSON.stringify(result)).not.toContain(apiKey);

    const [record] = await readHistory(harness);
    expect(record).toMatchObject({ id: output.job_id, outcome: "completed", files: output.files, shortfall: output.shortfall });
  });

  test("a Job that gets no image at all fails with the Provider's typed error", async () => {
    harness = await startHarness(relaySetup({ [generationsUrl]: recorded("openai/rate-limit-exceeded.json", 429) }));
    const result = await generate({ n: 2 });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("rate limiting");
    const [record] = await readHistory(harness);
    expect(record).toMatchObject({ outcome: "failed", error: { kind: "rate_limit" } });
  });

  test("a result link that cannot be downloaded costs only that image", async () => {
    const imageUrl = "https://oaidalleapiprodscus.blob.core.windows.net/private/img-fox.png?se=2026-10-30T15%3A05%3A00Z&sig=abc";
    let downloads = 0;
    harness = await startHarness(
      relaySetup({
        [generationsUrl]: recorded("openai/generations-url.json"),
        [`GET ${imageUrl}`]: () => {
          downloads += 1;
          return downloads === 1 ? new Response("gone", { status: 410 }) : new Response(tinyPng);
        },
      }),
    );
    const result = await generate({ n: 2 });
    expect(result.isError).toBeFalsy();
    const output = result.structuredContent as { files: string[]; shortfall: string };
    expect(output.files).toHaveLength(1);
    expect(output.shortfall).toContain("HTTP 410");
  });
});

describe("the settings page refreshes capabilities", () => {
  const cache = async (harness: SettingsHarness) => JSON.parse(await readFile(join(harness.dirs.data, "capabilities.json"), "utf8"));

  test("when the User adds a Model", async () => {
    settings = await startSettingsHarness({
      config: { providers: [relay] },
      credentials: { relay: { apiKey } },
      routes: { [capabilitiesUrl]: reportCapabilities },
    });
    const response = await settings.send("POST", "/api/models", {
      body: { alias: "fox", provider: "relay", modelId: "fox-1", protocol: "live-test" },
    });
    expect(response.status).toBe(201);
    expect(capabilityRequests(settings)).toBe(1);
    expect(Object.values(await cache(settings))).toMatchObject([{ capabilities: reported.capabilities }]);
  });

  test("after a successful test connection, for that Provider's Models using that Protocol", async () => {
    settings = await startSettingsHarness({
      config: relaySetup().config,
      credentials: { relay: { apiKey } },
      routes: { [capabilitiesUrl]: reportCapabilities, "GET https://relay.example/v1/models": recorded("openai/models.json") },
    });
    const response = await settings.send("POST", "/api/providers/relay/test-connection", { body: { protocol: "live-test" } });
    expect(response.json().result).toBe("success");
    expect(capabilityRequests(settings)).toBe(1);
  });

  test("a Provider that cannot be asked never stops the User adding a Model", async () => {
    settings = await startSettingsHarness({ config: { providers: [relay] }, credentials: { relay: { apiKey } } });
    const response = await settings.send("POST", "/api/models", {
      body: { alias: "fox", provider: "relay", modelId: "fox-1", protocol: "live-test" },
    });
    expect(response.status).toBe(201);
  });
});
