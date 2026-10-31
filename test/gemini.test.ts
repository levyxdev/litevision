import { afterEach, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startHarness, type Harness, type HarnessOptions, type Route } from "./harness.ts";
import { readHistory, recorded, textOf, tinyPng } from "./helpers.ts";
import { fixture } from "./recorded-http.ts";
import { startSettingsHarness, type SettingsHarness } from "./settings-harness.ts";

const baseUrl = "https://generativelanguage.googleapis.com/v1beta";
const interactionsUrl = `POST ${baseUrl}/interactions`;
const modelsUrl = `GET ${baseUrl}/models?pageSize=1000`;
const modelsPage2Url = `GET ${baseUrl}/models?pageSize=1000&pageToken=Chpnb29nbGUvZ2VtaW5pLTIuNS1mbGFzaC1pbWFnZQ`;
const apiKey = "AIza-test-0000secret0000";
const gemini = { id: "gemini", baseUrl };

interface GenerateResult {
  job_id: string;
  model: string;
  files: string[];
  aspect_ratio: string;
  size: string;
  aspect_ratio_adjusted: boolean;
  shortfall?: string;
}

interface InteractionBody {
  model: string;
  input: Array<{ type: string; text?: string; mime_type?: string; data?: string }>;
  response_format: Record<string, unknown>;
  [option: string]: unknown;
}

/** One Gemini Provider with two `gemini` Models; `nano-banana` is the default. */
function geminiSetup(routes: HarnessOptions["routes"] = { [interactionsUrl]: recorded("gemini/interaction.json") }): HarnessOptions {
  return {
    config: {
      providers: [gemini],
      models: [
        { alias: "nano-banana", provider: "gemini", modelId: "gemini-3.1-flash-image", protocol: "gemini" },
        { alias: "nano-banana-legacy", provider: "gemini", modelId: "gemini-2.5-flash-image", protocol: "gemini" },
      ],
      defaultImageModel: "nano-banana",
    },
    credentials: { gemini: { apiKey } },
    routes,
    now: () => new Date(2026, 9, 30, 14, 5, 0),
  };
}

let harness: Harness | undefined;
let settings: SettingsHarness | undefined;
afterEach(async () => {
  await harness?.close();
  await settings?.close();
  harness = undefined;
  settings = undefined;
});

const generate = (args: Record<string, unknown> = {}) =>
  harness!.client.callTool({ name: "generate_image", arguments: { prompt: "a red fox", ...args } });

function outputOf(result: Awaited<ReturnType<typeof generate>>): GenerateResult {
  expect(result.isError, textOf(result)).toBeFalsy();
  return result.structuredContent as unknown as GenerateResult;
}

const bodyOf = async (request: Request) => (await request.json()) as InteractionBody;

describe("generate_image with a gemini Model", () => {
  test("sends one Interaction and saves the final image, ignoring interim thought images", async () => {
    harness = await startHarness(geminiSetup());
    const result = await generate();
    const output = outputOf(result);

    expect(output.model).toBe("nano-banana");
    expect(output.files).toHaveLength(1);
    expect(output.files[0]!.startsWith(join(harness.dirs.output, "2026-10-30"))).toBe(true);
    expect(await readFile(output.files[0]!)).toEqual(tinyPng);
    expect(textOf(result)).not.toContain(tinyPng.toString("base64"));

    expect(harness.requests).toHaveLength(1);
    const [request] = harness.requests;
    expect(`${request!.method} ${request!.url}`).toBe(interactionsUrl);
    expect(request!.headers.get("x-goog-api-key")).toBe(apiKey);
    expect(request!.headers.get("authorization")).toBeNull();
    expect(await bodyOf(request!)).toEqual({
      model: "gemini-3.1-flash-image",
      input: [{ type: "text", text: "a red fox" }],
      response_format: { type: "image", aspect_ratio: "1:1", image_size: "1K" },
    });
  });

  test("n > 1 sends n Interactions at once and saves every image", async () => {
    harness = await startHarness(geminiSetup());
    const output = outputOf(await generate({ n: 3 }));

    expect(output.files).toHaveLength(3);
    expect(new Set(output.files).size).toBe(3);
    for (const file of output.files) expect(await readFile(file)).toEqual(tinyPng);
    expect(harness.requests).toHaveLength(3);
    for (const request of harness.requests) expect((await bodyOf(request)).model).toBe("gemini-3.1-flash-image");
  });

  test("n above 4 errors with what the Model supports, before any Provider request", async () => {
    harness = await startHarness(geminiSetup());
    const result = await generate({ n: 5 });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("up to 4 images per Job");
    expect(harness.requests).toHaveLength(0);
  });

  test("when some of the n Interactions fail, the Job completes with the rest and says why", async () => {
    let calls = 0;
    const flaky: Route = (request) => {
      calls += 1;
      return calls === 2 ? recorded("gemini/rate-limit-exceeded.json", 429)(request) : recorded("gemini/interaction.json")(request);
    };
    harness = await startHarness(geminiSetup({ [interactionsUrl]: flaky }));
    const output = outputOf(await generate({ n: 3 }));

    expect(output.files).toHaveLength(2);
    expect(output.shortfall).toContain('1 of 3 requests to Provider "gemini" failed');
    expect(output.shortfall).toContain("rate limiting");
  });

  test("sends reference images inline, after the prompt", async () => {
    harness = await startHarness(geminiSetup());
    const tinyJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);
    await writeFile(join(harness.cwd, "fox.png"), tinyPng);
    await writeFile(join(harness.cwd, "lamp.jpg"), tinyJpeg);
    outputOf(await generate({ prompt: "put the fox under the lamp", references: ["fox.png", "lamp.jpg"], aspect_ratio: "16:9" }));

    expect(await bodyOf(harness.requests[0]!)).toEqual({
      model: "gemini-3.1-flash-image",
      input: [
        { type: "text", text: "put the fox under the lamp" },
        { type: "image", mime_type: "image/png", data: tinyPng.toString("base64") },
        { type: "image", mime_type: "image/jpeg", data: tinyJpeg.toString("base64") },
      ],
      response_format: { type: "image", aspect_ratio: "16:9", image_size: "1K" },
    });
  });

  test("more reference images than the Model takes errors with its limit", async () => {
    harness = await startHarness(geminiSetup());
    await writeFile(join(harness.cwd, "fox.png"), tinyPng);
    const result = await generate({ model: "nano-banana-legacy", references: ["fox.png", "fox.png", "fox.png", "fox.png"] });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("cannot take 4 reference images");
    expect(textOf(result)).toContain("up to 3 reference images");
    expect(harness.requests).toHaveLength(0);
  });

  test("sends the aspect ratio as Gemini's own and reports the Model's 1K size for it", async () => {
    harness = await startHarness(geminiSetup());
    const output = outputOf(await generate({ aspect_ratio: "9:16" }));
    expect((await bodyOf(harness.requests[0]!)).response_format).toMatchObject({ aspect_ratio: "9:16" });
    expect(output).toMatchObject({ aspect_ratio: "9:16", size: "768x1376", aspect_ratio_adjusted: false });
  });

  test("the legacy Model has its own sizes and is sent no image_size", async () => {
    harness = await startHarness(geminiSetup());
    const output = outputOf(await generate({ model: "nano-banana-legacy", aspect_ratio: "3:2" }));
    expect((await bodyOf(harness.requests[0]!)).response_format).toEqual({ type: "image", aspect_ratio: "3:2" });
    expect(output).toMatchObject({ aspect_ratio: "3:2", size: "1248x832" });
  });

  test("provider_options reach the Interaction; response_format options are merged under litevision's own", async () => {
    harness = await startHarness(geminiSetup());
    const safety = [{ type: "hate_speech", threshold: "block_only_high" }];
    outputOf(
      await generate({
        aspect_ratio: "4:3",
        provider_options: {
          generation_config: { thinking_level: "high" },
          safety_settings: safety,
          response_format: { image_size: "2K", mime_type: "image/jpeg", aspect_ratio: "21:9", type: "text" },
        },
      }),
    );

    expect(await bodyOf(harness.requests[0]!)).toEqual({
      model: "gemini-3.1-flash-image",
      input: [{ type: "text", text: "a red fox" }],
      generation_config: { thinking_level: "high" },
      safety_settings: safety,
      response_format: { type: "image", aspect_ratio: "4:3", image_size: "2K", mime_type: "image/jpeg" },
    });
  });

  test("provider_options may not set the model or the input", async () => {
    harness = await startHarness(geminiSetup());
    const result = await generate({ provider_options: { input: "something else", model: "gemini-3-pro-image" } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("provider_options may not set `input`, `model`");
    expect(harness.requests).toHaveLength(0);
  });

  test("prompts are sent verbatim", async () => {
    const prompt = "  A sign that reads “Café 東京”\n\n--no blur, keep   spacing  ";
    harness = await startHarness(geminiSetup());
    outputOf(await generate({ prompt }));
    expect((await bodyOf(harness.requests[0]!)).input[0]).toEqual({ type: "text", text: prompt });
  });
});

describe("Gemini errors", () => {
  const cases = [
    { fixture: "authentication.json", status: 401, kind: "auth", says: "rejected the Credential", detail: "API key not valid" },
    { fixture: "api-key-invalid.json", status: 400, kind: "auth", says: "rejected the Credential", detail: "API key not valid" },
    { fixture: "permission-denied.json", status: 403, kind: "auth", says: "rejected the Credential", detail: "does not have permission" },
    { fixture: "payment-required.json", status: 402, kind: "balance", says: "insufficient balance or quota", detail: "credit balance is depleted" },
    { fixture: "quota-exceeded.json", status: 429, kind: "balance", says: "insufficient balance or quota", detail: "daily quota" },
    { fixture: "rate-limit-exceeded.json", status: 429, kind: "rate_limit", says: "rate limiting", detail: "per-minute request limit" },
    { fixture: "api-error.json", status: 500, kind: "other", says: "HTTP 500", detail: "internal error" },
    { fixture: "interaction-blocked.json", status: 200, kind: "refusal", says: "refused the request on content grounds", detail: "Prohibited Use policy" },
    { fixture: "interaction-text-only.json", status: 200, kind: "other", says: "with no image", detail: "unable to draw one" },
  ];

  test.each(cases)("$fixture (HTTP $status) is reported as $kind, naming the Provider", async ({ fixture, status, kind, says, detail }) => {
    harness = await startHarness(geminiSetup({ [interactionsUrl]: recorded(`gemini/${fixture}`, status) }));
    const result = await generate();

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain('Provider "gemini"');
    expect(text).toContain(says);
    expect(text).toContain(detail);
    expect(JSON.stringify(result)).not.toContain(apiKey);

    const [record] = await readHistory(harness);
    expect(record).toMatchObject({ outcome: "failed", files: [], error: { kind } });
  });

  test("a refusal on every one of n Interactions fails the Job as a refusal", async () => {
    harness = await startHarness(geminiSetup({ [interactionsUrl]: recorded("gemini/interaction-blocked.json") }));
    const result = await generate({ n: 2 });
    expect(result.isError).toBe(true);
    expect(harness.requests).toHaveLength(2);
    expect((await readHistory(harness))[0]).toMatchObject({ error: { kind: "refusal" } });
  });
});

describe("list_models with a gemini Model", () => {
  test("reports the built-in capabilities and the Interactions docs", async () => {
    harness = await startHarness(geminiSetup());
    const result = await harness.client.callTool({ name: "list_models", arguments: { model: "nano-banana" } });

    expect(result.isError).toBeFalsy();
    const { models } = result.structuredContent as { models: Array<Record<string, unknown>> };
    expect(models[0]).toMatchObject({
      alias: "nano-banana",
      protocol: "gemini",
      docs_url: "https://ai.google.dev/api/interactions-api",
      capabilities: {
        aspect_ratios: [
          { aspect_ratio: "1:1", size: "1024x1024" },
          { aspect_ratio: "16:9", size: "1376x768" },
          { aspect_ratio: "9:16", size: "768x1376" },
          { aspect_ratio: "4:3", size: "1200x896" },
          { aspect_ratio: "3:4", size: "896x1200" },
          { aspect_ratio: "3:2", size: "1264x848" },
          { aspect_ratio: "2:3", size: "848x1264" },
        ],
        reference_images: true,
        max_reference_images: 14,
        max_images_per_job: 4,
      },
    });
    // Gemini describes no image capabilities, so nothing is asked of the Provider.
    expect(harness.requests).toHaveLength(0);
  });
});

describe("settings page with a Gemini Provider", () => {
  const saved = { config: { providers: [gemini] }, credentials: { gemini: { apiKey } } };
  const pages = { [modelsUrl]: fixture("gemini/models.json"), [modelsPage2Url]: fixture("gemini/models-page-2.json") };

  test("test connection lists the Provider's models with the Credential in x-goog-api-key", async () => {
    settings = await startSettingsHarness({ ...saved, routes: pages });
    const response = await settings.send("POST", "/api/providers/gemini/test-connection", { body: { protocol: "gemini" } });

    expect(response.json()).toEqual({ result: "success", message: expect.stringContaining('Connected to Provider "gemini"') });
    expect(response.json().message).toContain("3 image model id(s)");
    expect(settings.requests[0]!.headers.get("x-goog-api-key")).toBe(apiKey);
    expect(settings.requests[0]!.url).not.toContain(apiKey);
  });

  test("test connection reports a rejected Credential without echoing it", async () => {
    settings = await startSettingsHarness({ ...saved, routes: { [modelsUrl]: fixture("gemini/api-key-invalid.json", 400) } });
    const response = await settings.send("POST", "/api/providers/gemini/test-connection", { body: { protocol: "gemini" } });

    expect(response.json().result).toBe("failure");
    expect(response.json().message).toContain('Provider "gemini"');
    expect(response.json().message).toContain("API key not valid");
    expect(response.text).not.toContain(apiKey);
  });

  test("the model list holds only image model ids, across every page, without the models/ prefix", async () => {
    settings = await startSettingsHarness({ ...saved, routes: pages });
    const response = await settings.send("POST", "/api/providers/gemini/model-ids", { body: { protocol: "gemini" } });

    expect(response.json()).toEqual({
      result: "success",
      modelIds: ["gemini-2.5-flash-image", "gemini-3.1-flash-image", "gemini-nano-banana-2.1"],
    });
    expect(settings.requests).toHaveLength(2);
  });

  test("a failed model list lets the User type the model id instead", async () => {
    settings = await startSettingsHarness({ ...saved, routes: { [modelsUrl]: fixture("gemini/permission-denied.json", 403) } });
    const response = await settings.send("POST", "/api/providers/gemini/model-ids", { body: { protocol: "gemini" } });

    expect(response.json()).toEqual({ result: "failure", message: expect.stringContaining('Provider "gemini"') });
    expect(response.json().message).toContain("type the model id");
  });

  test("gemini is a Protocol a Model can use", async () => {
    settings = await startSettingsHarness();
    expect((await settings.send("GET", "/api/protocols")).json().protocols).toContain("gemini");
  });
});
