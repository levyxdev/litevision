import { afterEach, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startHarness, type Harness, type HarnessOptions, type Route } from "./harness.ts";
import { readHistory, recorded, textOf, tinyPng } from "./helpers.ts";
import { fixture } from "./recorded-http.ts";
import { startSettingsHarness, type SettingsHarness } from "./settings-harness.ts";

const apiKey = "venice-test-0000secret0000";
const baseUrl = "https://api.venice.ai/api/v1";
const generateUrl = `POST ${baseUrl}/image/generate`;
const editUrl = `POST ${baseUrl}/image/edit`;
const multiEditUrl = `POST ${baseUrl}/image/multi-edit`;
const imageModelsUrl = `GET ${baseUrl}/models?type=image`;
const inpaintModelsUrl = `GET ${baseUrl}/models?type=inpaint`;

/** What litevision sends with every Venice request unless `provider_options` says otherwise. */
const generateDefaults = { safe_mode: false, hide_watermark: true, format: "png", enhance_prompt: false, return_binary: false };
const editDefaults = { safe_mode: false, output_format: "png", enhance_prompt: false };

const pngResponse: Route = () => new Response(tinyPng, { headers: { "content-type": "image/png" } });

/** One Venice Provider with a Model of each kind Venice offers; `qwen` is the default. */
function veniceSetup(routes: HarnessOptions["routes"] = {}): HarnessOptions {
  return {
    config: {
      providers: [{ id: "venice", baseUrl }],
      models: [
        { alias: "qwen", provider: "venice", modelId: "qwen-image-2", protocol: "venice" },
        { alias: "banana", provider: "venice", modelId: "nano-banana-pro", protocol: "venice" },
        { alias: "sd35", provider: "venice", modelId: "venice-sd35", protocol: "venice" },
        { alias: "banana-edit", provider: "venice", modelId: "nano-banana-pro-edit", protocol: "venice" },
        { alias: "firered", provider: "venice", modelId: "firered-image-edit", protocol: "venice" },
      ],
      defaultImageModel: "qwen",
    },
    credentials: { venice: { apiKey } },
    routes: {
      [imageModelsUrl]: recorded("venice/models-image.json"),
      [inpaintModelsUrl]: recorded("venice/models-inpaint.json"),
      [generateUrl]: recorded("venice/generate.json"),
      ...routes,
    },
    now: () => new Date(2026, 9, 30, 14, 5, 0),
  };
}

interface GenerateResult {
  job_id: string;
  files: string[];
  requested_shape: string | null;
  shortfall?: string;
}

let harness: Harness | undefined;
let settings: SettingsHarness | undefined;
afterEach(async () => {
  await harness?.close();
  await settings?.close();
  harness = undefined;
  settings = undefined;
});

const generate = (args: Record<string, unknown>) =>
  harness!.client.callTool({ name: "generate_image", arguments: { prompt: "a red fox", ...args } });

function outputOf(result: Awaited<ReturnType<typeof generate>>): GenerateResult {
  expect(result.isError, textOf(result)).toBeFalsy();
  return result.structuredContent as unknown as GenerateResult;
}

const sent = (url: string) => harness!.requests.filter((request) => `${request.method} ${request.url}` === url);

async function bodyOf(url: string, index = 0): Promise<Record<string, unknown>> {
  const request = sent(url)[index];
  expect(request, `no request to ${url}`).toBeDefined();
  return (await request!.clone().json()) as Record<string, unknown>;
}

async function writeReferences(...names: string[]): Promise<string[]> {
  for (const name of names) await writeFile(join(harness!.cwd, name), tinyPng);
  return names;
}

describe("text-to-image with a venice Model", () => {
  test("saves the image and returns its path, sending the prompt verbatim with litevision's defaults", async () => {
    harness = await startHarness(veniceSetup());
    const output = outputOf(await generate({}));

    expect(output.files).toHaveLength(1);
    expect(await readFile(output.files[0]!)).toEqual(tinyPng);
    const [request] = sent(generateUrl);
    expect(request!.headers.get("authorization")).toBe(`Bearer ${apiKey}`);
    expect(await bodyOf(generateUrl)).toEqual({
      model: "qwen-image-2",
      prompt: "a red fox",
      variants: 1,
      ...generateDefaults,
    });
  });

  test("a Model that sizes in pixels takes width and height in provider_options, and the result is checked against them", async () => {
    harness = await startHarness(veniceSetup());
    const output = outputOf(await generate({ model: "sd35", provider_options: { width: 1280, height: 720 } }));

    expect(output.requested_shape).toBe("1280x720");
    expect(await bodyOf(generateUrl)).toMatchObject({ model: "venice-sd35", width: 1280, height: 720 });
  });


  test("a Model with resolution tiers takes its aspect ratio and tier in provider_options", async () => {
    harness = await startHarness(veniceSetup());
    const output = outputOf(await generate({ model: "banana", provider_options: { aspect_ratio: "3:2", resolution: "2K" } }));

    const body = await bodyOf(generateUrl);
    expect(body).toMatchObject({ model: "nano-banana-pro", aspect_ratio: "3:2", resolution: "2K" });
    expect(body).not.toHaveProperty("width");
    expect(output.requested_shape).toBe("3:2");
  });


  test("prompt enhancement, safe mode, watermark and format are overridable through provider_options", async () => {
    harness = await startHarness(veniceSetup());
    outputOf(
      await generate({ provider_options: { enhance_prompt: true, safe_mode: true, hide_watermark: false, format: "webp", seed: 7 } }),
    );
    expect(await bodyOf(generateUrl)).toMatchObject({
      enhance_prompt: true,
      safe_mode: true,
      hide_watermark: false,
      format: "webp",
      seed: 7,
    });
  });

  test("provider_options may not set the fields litevision fills, but may set the size and count (ADR 0010)", async () => {
    harness = await startHarness(veniceSetup());
    const result = await generate({ provider_options: { model: "other", return_binary: true } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("`model`");
    expect(textOf(result)).toContain("`return_binary`");
    expect(sent(generateUrl)).toHaveLength(0);

    const passed = await generate({ provider_options: { variants: 1, aspect_ratio: "21:9", resolution: "2K" } });
    expect(passed.isError).toBeFalsy();
    expect(await bodyOf(generateUrl)).toMatchObject({ variants: 1, aspect_ratio: "21:9", resolution: "2K" });
  });

  test("n > 1 asks for that many variants in one request", async () => {
    harness = await startHarness(veniceSetup({ [generateUrl]: recorded("venice/generate-2.json") }));
    const output = outputOf(await generate({ n: 2 }));
    expect(output.files).toHaveLength(2);
    expect(sent(generateUrl)).toHaveLength(1);
    expect(await bodyOf(generateUrl)).toMatchObject({ variants: 2 });
  });

  test("reference images on a text-to-image Model are sent anyway, to the edit endpoint, for Venice to decide (ADR 0010)", async () => {
    harness = await startHarness(veniceSetup({ [editUrl]: pngResponse }));
    const result = await generate({ references: await writeReferences("fox.png") });
    expect(result.isError).toBeFalsy();
    expect(sent(editUrl)).toHaveLength(1);
  });
});

describe("partial results", () => {
  test("variants Venice omits under content policy leave a completed Job that says so", async () => {
    harness = await startHarness(veniceSetup({ [generateUrl]: recorded("venice/generate-partial.json") }));
    const result = await generate({ n: 3 });
    const output = outputOf(result);

    expect(output.files).toHaveLength(2);
    expect(output.shortfall).toContain('Got 2 of 3 images from Provider "venice"');
    expect(output.shortfall).toContain("content policy");
    const [record] = await readHistory(harness);
    expect(record).toMatchObject({ outcome: "completed", shortfall: output.shortfall });
  });

  test("a response with every variant omitted under content policy is a refusal", async () => {
    harness = await startHarness(veniceSetup({ [generateUrl]: recorded("venice/generate-all-omitted.json") }));
    const result = await generate({ n: 2 });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("refused the request on content grounds");
    const [record] = await readHistory(harness);
    expect(record).toMatchObject({ outcome: "failed", error: { kind: "refusal" } });
  });
});

describe("Venice errors map to the typed errors", () => {
  const cases: Array<[string, number, string, string]> = [
    ["venice/authentication-failed.json", 401, "auth", "Authentication failed"],
    ["venice/insufficient-balance.json", 402, "balance", "Insufficient USD or Diem balance"],
    ["venice/content-policy-violation.json", 422, "refusal", "A watercolor painting of a red fox"],
    ["venice/rate-limit-exceeded.json", 429, "rate_limit", "Rate limit exceeded"],
    ["venice/model-at-capacity.json", 503, "other", "The model is at capacity"],
  ];

  for (const [name, status, kind, said] of cases) {
    test(`HTTP ${status} is ${kind}, with what Venice said`, async () => {
      harness = await startHarness(veniceSetup({ [generateUrl]: recorded(name, status) }));
      const result = await generate({});
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('Provider "venice"');
      expect(textOf(result)).toContain(said);
      expect(JSON.stringify(result)).not.toContain(apiKey);
      const [record] = await readHistory(harness);
      expect(record).toMatchObject({ outcome: "failed", error: { kind } });
    });
  }
});

describe("a rejected option", () => {
  test("a 400 naming a provider_options key is a rejected option, with what Venice said and the docs link", async () => {
    harness = await startHarness(veniceSetup({ [generateUrl]: recorded("venice/invalid-request.json", 400) }));
    const result = await generate({ provider_options: { cfg_scale: 50 } });

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain('Provider "venice" rejected an option');
    expect(text).toContain("cfg_scale: Number must be less than or equal to 20");
    expect(text).toContain("https://docs.venice.ai");
    expect((await readHistory(harness))[0]).toMatchObject({ outcome: "failed", error: { kind: "rejected_option" } });
  });
});

describe("reference-image editing with a Venice edit Model", () => {
  test("one reference goes to /image/edit as base64, with litevision's defaults", async () => {
    harness = await startHarness(veniceSetup({ [editUrl]: pngResponse }));
    const output = outputOf(
      await generate({ model: "banana-edit", references: await writeReferences("fox.png"), provider_options: { aspect_ratio: "16:9" } }),
    );

    expect(output.files).toHaveLength(1);
    expect(await readFile(output.files[0]!)).toEqual(tinyPng);
    expect(sent(editUrl)[0]!.headers.get("authorization")).toBe(`Bearer ${apiKey}`);
    expect(await bodyOf(editUrl)).toEqual({
      model: "nano-banana-pro-edit",
      prompt: "a red fox",
      image: tinyPng.toString("base64"),
      aspect_ratio: "16:9",
      ...editDefaults,
    });
    expect(sent(generateUrl)).toHaveLength(0);
  });

  test("several references go to /image/multi-edit, and n > 1 sends that many requests at once", async () => {
    harness = await startHarness(veniceSetup({ [multiEditUrl]: pngResponse }));
    const references = await writeReferences("fox.png", "hat.png", "scarf.png");
    const output = outputOf(await generate({ model: "banana-edit", n: 2, references, provider_options: { enhance_prompt: true } }));

    expect(output.files).toHaveLength(2);
    expect(sent(multiEditUrl)).toHaveLength(2);
    expect(await bodyOf(multiEditUrl)).toEqual({
      modelId: "nano-banana-pro-edit",
      prompt: "a red fox",
      images: [tinyPng.toString("base64"), tinyPng.toString("base64"), tinyPng.toString("base64")],
      ...editDefaults,
      enhance_prompt: true,
    });
  });

  test("an edit that fails for some of the n requests still completes with the rest", async () => {
    let count = 0;
    const flaky: Route = (request) => {
      count += 1;
      return count === 1 ? recorded("venice/content-policy-violation.json", 422)(request) : pngResponse(request);
    };
    harness = await startHarness(veniceSetup({ [editUrl]: flaky }));
    const output = outputOf(await generate({ model: "banana-edit", n: 2, references: await writeReferences("fox.png") }));
    expect(output.files).toHaveLength(1);
    expect(output.shortfall).toContain("1 of 2 requests");
  });

  test("more references than Venice's model list allows are sent, for Venice to decide (ADR 0010)", async () => {
    harness = await startHarness(veniceSetup({ [multiEditUrl]: pngResponse }));
    const result = await generate({ model: "firered", references: await writeReferences("fox.png", "hat.png") });
    expect(result.isError).toBeFalsy();
    expect(sent(multiEditUrl)).toHaveLength(1);
  });

  test("an edit Model without reference images is sent to /image/generate, and Venice's answer comes back (ADR 0010)", async () => {
    harness = await startHarness(veniceSetup({ [generateUrl]: recorded("venice/invalid-request.json", 400) }));
    const result = await generate({ model: "banana-edit" });
    expect(result.isError).toBe(true);
    expect(sent(generateUrl)).toHaveLength(1);
    expect(textOf(result)).toContain("Invalid request");
    expect(textOf(result)).toContain("https://docs.venice.ai/api-reference/endpoint/image/edit");
  });
});

describe("Venice's own description of its Models", () => {
  const listModels = (args: Record<string, unknown> = {}) => harness!.client.callTool({ name: "list_models", arguments: args });
  type Listed = { models: Array<Record<string, any>> };

  test("list_models says Venice describes each Model it lists, with the docs link for its kind", async () => {
    harness = await startHarness(veniceSetup());
    const result = await listModels();
    expect(result.isError, textOf(result)).toBeFalsy();
    const byAlias = Object.fromEntries((result.structuredContent as Listed).models.map((model) => [model.alias, model]));

    expect(byAlias.qwen!.parameters).toContain('Provider "venice" describes this Model');
    expect(byAlias.qwen!).not.toHaveProperty("capabilities");
    expect(byAlias.qwen!.docs_url).toBe("https://docs.venice.ai/api-reference/endpoint/image/generate");
    expect(byAlias["banana-edit"]!.docs_url).toBe("https://docs.venice.ai/api-reference/endpoint/image/edit");
    expect(harness.requests.find((request) => request.url.includes("/models"))!.headers.get("authorization")).toBe(`Bearer ${apiKey}`);
  });

  test("with `model`, shows Venice's own constraints for the Model as its parameter schema", async () => {
    harness = await startHarness(veniceSetup());
    const result = await listModels({ model: "banana" });
    const [model] = (result.structuredContent as Listed).models;
    expect(model!.parameter_schema).toMatchObject({ resolutions: ["1K", "2K", "4K"], defaultResolution: "1K" });
  });

  test("a second generation within a day asks for no model list", async () => {
    harness = await startHarness(veniceSetup());
    const modelListRequests = () => harness!.requests.filter((request) => request.url.includes("/models"));

    outputOf(await generate({ model: "sd35" }));
    const afterFirst = modelListRequests().length;
    expect(afterFirst).toBeGreaterThan(0);

    outputOf(await generate({ model: "sd35" }));
    expect(modelListRequests()).toHaveLength(afterFirst);
  });


  test("with the model list unreachable, generate_image still works and list_models shows the built-in Parameter Guide", async () => {
    const unreachable: Route = () => {
      throw new Error("connect ECONNREFUSED");
    };
    harness = await startHarness(veniceSetup({ [imageModelsUrl]: unreachable, [inpaintModelsUrl]: unreachable }));

    outputOf(await generate({ model: "sd35", provider_options: { width: 1280, height: 720 } }));
    expect(await bodyOf(generateUrl)).toMatchObject({ width: 1280, height: 720 });
    const [model] = ((await listModels({ model: "sd35" })).structuredContent as Listed).models;
    expect(model!.parameter_guide.family).toContain("pixel-sized");
  });
});

describe("settings page with a Venice Provider", () => {
  const saved = {
    config: { providers: [{ id: "venice", baseUrl }] },
    credentials: { venice: { apiKey } },
  };

  test("test connection lists Venice's image models with the Credential", async () => {
    settings = await startSettingsHarness({ ...saved, routes: { [imageModelsUrl]: fixture("venice/models-image.json") } });
    const response = await settings.send("POST", "/api/providers/venice/test-connection", { body: { protocol: "venice" } });

    expect(response.json()).toEqual({ result: "success", message: expect.stringContaining('Provider "venice"') });
    expect(settings.requests).toHaveLength(1);
    expect(settings.requests[0]!.url).toBe(`${baseUrl}/models?type=image`);
    expect(settings.requests[0]!.headers.get("authorization")).toBe(`Bearer ${apiKey}`);
  });

  test("test connection reports Venice's error without the Credential", async () => {
    settings = await startSettingsHarness({ ...saved, routes: { [imageModelsUrl]: fixture("venice/authentication-failed.json", 401) } });
    const response = await settings.send("POST", "/api/providers/venice/test-connection", { body: { protocol: "venice" } });

    expect(response.json().result).toBe("failure");
    expect(response.json().message).toContain('Provider "venice"');
    expect(response.json().message).toContain("Authentication failed");
    expect(response.text).not.toContain(apiKey);
  });

  test("model listing offers Venice's image and edit models", async () => {
    settings = await startSettingsHarness({
      ...saved,
      routes: { [imageModelsUrl]: fixture("venice/models-image.json"), [inpaintModelsUrl]: fixture("venice/models-inpaint.json") },
    });
    const response = await settings.send("POST", "/api/providers/venice/model-ids", { body: { protocol: "venice" } });

    expect(response.json()).toEqual({
      result: "success",
      modelIds: ["firered-image-edit", "nano-banana-pro", "nano-banana-pro-edit", "qwen-image-2", "venice-sd35"],
    });
  });

  test("venice is a Protocol a Model can use", async () => {
    settings = await startSettingsHarness();
    expect((await settings.send("GET", "/api/protocols")).json().protocols).toContain("venice");
  });
});
