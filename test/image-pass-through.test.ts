import { afterEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startHarness, type Harness, type HarnessOptions, type Route } from "./harness.ts";
import { pngOfSize, readHistory, recorded, textOf, tinyPng } from "./helpers.ts";

/** ADR 0010: image Jobs send every non-fixed field the Agent sets, and nothing is checked or adjusted before the request. */

const openaiBase = "https://api.openai.com/v1";
const geminiBase = "https://generativelanguage.googleapis.com/v1beta";
const apimartBase = "https://api.apimart.ai/v1";
const veniceBase = "https://api.venice.ai/api/v1";
const togetherRoot = "https://api.together.ai";

const providers = [
  { id: "openai", baseUrl: openaiBase },
  { id: "google", baseUrl: geminiBase },
  { id: "apimart", baseUrl: apimartBase },
  { id: "venice", baseUrl: veniceBase },
  { id: "together-ai", baseUrl: `${togetherRoot}/v1` },
];

const credentials = Object.fromEntries(providers.map((provider) => [provider.id, { apiKey: `${provider.id}-test-0000secret` }]));

const models = [
  { alias: "flare", provider: "openai", modelId: "gpt-image-2.5-flare", protocol: "openai-images" },
  { alias: "banana", provider: "google", modelId: "gemini-3-pro-image", protocol: "gemini" },
  { alias: "mart", provider: "apimart", modelId: "gpt-image-2", protocol: "apimart" },
  { alias: "venice", provider: "venice", modelId: "nano-banana-pro", protocol: "venice" },
  { alias: "sd35", provider: "venice", modelId: "venice-sd35", protocol: "venice" },
  { alias: "flux2", provider: "together-ai", modelId: "black-forest-labs/FLUX.2-pro", protocol: "together" },
  { alias: "mystery", provider: "together-ai", modelId: "acme/brand-new-image-model", protocol: "together" },
];

/** An OpenAI-style answer whose images claim the given size. */
const openaiImages = (width: number, height: number, count = 1): Route => () =>
  Response.json({ data: Array.from({ length: count }, () => ({ b64_json: pngOfSize(width, height).toString("base64") })) });

const urls = {
  openai: `POST ${openaiBase}/images/generations`,
  openaiEdits: `POST ${openaiBase}/images/edits`,
  gemini: `POST ${geminiBase}/interactions`,
  apimart: `POST ${apimartBase}/images/generations`,
  venice: `POST ${veniceBase}/image/generate`,
  together: `POST ${togetherRoot}/v1/images/generations`,
};

function setup(routes: HarnessOptions["routes"] = {}): HarnessOptions {
  return {
    config: { providers, models },
    credentials,
    routes: {
      [urls.openai]: recorded("openai/generations.json"),
      [urls.gemini]: recorded("gemini/interaction.json"),
      [urls.apimart]: recorded("apimart/submitted.json"),
      "GET https://api.apimart.ai/v1/tasks/task_01KPQ7J7DWB7QZ3WCEK3YVPBRA?language=en": recorded("apimart/task-completed.json"),
      "GET https://upload.apimart.ai/f/image/9998236911693428-e8d7441f-image_task_01KPQ7J7DWB7QZ3WCEK3YVPBRA_0.png": () =>
        new Response(tinyPng, { headers: { "content-type": "image/png" } }),
      [urls.venice]: recorded("venice/generate.json"),
      [urls.together]: recorded("together/images.json"),
      ...routes,
    },
    pollIntervalMs: 1,
  };
}

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

const generate = (args: Record<string, unknown>) => harness!.client.callTool({ name: "generate_image", arguments: { prompt: "a red fox", ...args } });

async function bodiesTo(route: string): Promise<Array<Record<string, unknown>>> {
  const sent = harness!.requests.filter((request) => `${request.method} ${request.url}` === route);
  return Promise.all(sent.map(async (request) => (await request.json()) as Record<string, unknown>));
}

describe("image Jobs pass every non-fixed field through (ADR 0010)", () => {
  test("a size in provider_options reaches OpenAI unchanged, and the result is checked against it", async () => {
    harness = await startHarness(setup({ [urls.openai]: openaiImages(1024, 1024) }));
    const result = await generate({ model: "flare", provider_options: { size: "3840x2160" } });

    expect(result.isError).toBeFalsy();
    const [body] = await bodiesTo(urls.openai);
    expect(body!.size).toBe("3840x2160");
    const output = result.structuredContent as { requested_shape: string | null; mismatch?: string };
    expect(output.requested_shape).toBe("3840x2160");
    expect(output.mismatch).toContain("3840x2160");
    expect(textOf(result)).toContain("https://platform.openai.com/docs/api-reference/images/create");
  });

  test("a result that matches the size asked for is not a mismatch", async () => {
    harness = await startHarness(setup({ [urls.openai]: openaiImages(3840, 2160) }));
    const result = await generate({ model: "flare", provider_options: { size: "3840x2160" } });
    expect(result.structuredContent).not.toHaveProperty("mismatch");
    expect((result.structuredContent as { requested_shape: string }).requested_shape).toBe("3840x2160");
  });

  test("with no aspect_ratio and no size option, no image Protocol sends a size", async () => {
    harness = await startHarness(setup());
    for (const model of ["flare", "banana", "mart", "venice", "sd35", "flux2"]) {
      const result = await generate({ model });
      expect(result.isError).toBeFalsy();
    }
    const [openai] = await bodiesTo(urls.openai);
    expect(openai).not.toHaveProperty("size");
    const [gemini] = await bodiesTo(urls.gemini);
    expect(gemini!.response_format).toEqual({ type: "image" });
    const [apimart] = await bodiesTo(urls.apimart);
    expect(apimart).not.toHaveProperty("size");
    for (const venice of await bodiesTo(urls.venice)) {
      for (const field of ["width", "height", "aspect_ratio"]) expect(venice).not.toHaveProperty(field);
    }
    const [together] = await bodiesTo(urls.together);
    for (const field of ["width", "height", "aspect_ratio"]) expect(together).not.toHaveProperty(field);
  });

  test("a request with no readable size is unchecked, not a mismatch, and says so", async () => {
    harness = await startHarness(setup({ [urls.openai]: openaiImages(1024, 1536) }));
    const result = await generate({ model: "flare", provider_options: { size: "auto" } });
    const output = result.structuredContent as { requested_shape: string | null };
    expect(output.requested_shape).toBeNull();
    expect(result.structuredContent).not.toHaveProperty("mismatch");
    expect(textOf(result)).toContain("not checked");
  });

  test("a Job asking for more images than the old tables allowed is sent, and the Provider's rejection comes back with the Parameter Guide", async () => {
    harness = await startHarness(setup({ [urls.openai]: recorded("openai/invalid-value.json", 400) }));
    const result = await generate({ model: "flare", n: 12 });

    const [body] = await bodiesTo(urls.openai);
    expect(body!.n).toBe(12);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Parameter Guide for GPT Image 2.5");
  });

  test("more reference images than the old tables allowed are sent", async () => {
    harness = await startHarness(setup({ [urls.openaiEdits]: recorded("openai/edits.json") }));
    const references = Array.from({ length: 20 }, (_, index) => `ref-${index}.png`);
    for (const file of references) await writeFile(join(harness.cwd, file), tinyPng);
    const result = await generate({ model: "flare", references });
    expect(result.isError).toBeFalsy();
    const form = await harness.requests[0]!.formData();
    expect(form.getAll("image[]")).toHaveLength(20);
  });

  test("a Together model id litevision does not recognise is neither capped at 1024 a side nor refused reference images", async () => {
    harness = await startHarness(setup());
    await writeFile(join(harness.cwd, "fox.png"), tinyPng);
    const result = await generate({ model: "mystery", references: ["fox.png"], provider_options: { width: 2048, height: 1152 } });
    expect(result.isError).toBeFalsy();
    const [body] = await bodiesTo(urls.together);
    expect(body).toMatchObject({ width: 2048, height: 1152 });
    expect(body!.reference_images).toHaveLength(1);
  });

  test("provider_options may not set the fixed fields, and the error names the field; any other field passes", async () => {
    harness = await startHarness(setup());
    const rejected = await generate({ model: "flare", provider_options: { prompt: "another" } });
    expect(rejected.isError).toBe(true);
    expect(textOf(rejected)).toContain("`prompt`");

    const together = await generate({ model: "flux2", provider_options: { reference_images: [] } });
    expect(together.isError).toBe(true);
    expect(textOf(together)).toContain("`reference_images`");

    const passed = await generate({ model: "flux2", provider_options: { width: 1920, height: 1080, n: 2, steps: 30 } });
    expect(passed.isError).toBeFalsy();
    expect((await bodiesTo(urls.together))[0]).toMatchObject({ width: 1920, height: 1080, n: 2, steps: 30 });
  });

  test("`n` reaches the Provider's count field; on Gemini, which has none, `n` requests are sent", async () => {
    harness = await startHarness(setup({ [urls.openai]: openaiImages(1024, 1024, 3) }));
    await generate({ model: "flare", n: 3 });
    expect((await bodiesTo(urls.openai))[0]!.n).toBe(3);

    await generate({ model: "banana", n: 3 });
    expect(await bodiesTo(urls.gemini)).toHaveLength(3);
  });

  test("Gemini's response format takes the Agent's aspect ratio and size, and keeps the image type", async () => {
    harness = await startHarness(setup());
    await generate({ model: "banana", provider_options: { response_format: { aspect_ratio: "21:9", image_size: "4K", type: "text" } } });
    const [body] = await bodiesTo(urls.gemini);
    expect(body!.response_format).toEqual({ type: "image", aspect_ratio: "21:9", image_size: "4K" });
  });

  test("the Job history records what litevision read from the final request", async () => {
    harness = await startHarness(setup({ [urls.openai]: openaiImages(2048, 1152) }));
    await generate({ model: "flare", provider_options: { size: "2048x1152" } });
    const [job] = await readHistory(harness);
    expect((job!.parameters as Record<string, unknown>).requestedShape).toBe("2048x1152");

    const again = await harness.client.callTool({ name: "get_job", arguments: { job_id: job!.id } });
    expect(again.structuredContent).toMatchObject({ requested_shape: "2048x1152" });
  });

  test("each Comparison variant's provider_options reach only that variant's Job", async () => {
    harness = await startHarness(setup({ [urls.openai]: openaiImages(1024, 1024) }));
    const result = await harness.client.callTool({
      name: "generate_comparison",
      arguments: {
        variants: [
          { prompt: "a fox", model: "flare", provider_options: { quality: "high" } },
          { prompt: "a fox", model: "flux2", provider_options: { width: 1344, height: 768 } },
        ],
      },
    });
    expect(result.isError).toBeFalsy();
    const [openai] = await bodiesTo(urls.openai);
    const [together] = await bodiesTo(urls.together);
    expect(openai).toMatchObject({ quality: "high" });
    expect(openai).not.toHaveProperty("width");
    expect(together).toMatchObject({ width: 1344, height: 768 });
    expect(together).not.toHaveProperty("quality");
  });

  test("the resolution tier the request asks for is shown and recorded, unchecked", async () => {
    harness = await startHarness(setup());
    const result = await generate({ model: "banana", provider_options: { response_format: { aspect_ratio: "16:9", image_size: "4K" } } });
    const output = result.structuredContent as { requested_shape: string | null; requested_resolution: string | null };
    expect(output).toMatchObject({ requested_shape: "16:9", requested_resolution: "4K" });
    expect(textOf(result)).toContain("16:9 at 4K");

    const [job] = await readHistory(harness);
    expect((job!.parameters as Record<string, unknown>).requestedResolution).toBe("4K");
    const again = await harness.client.callTool({ name: "get_job", arguments: { job_id: job!.id } });
    expect(again.structuredContent).toMatchObject({ requested_resolution: "4K" });
  });

  test("each Protocol's tier field is read: APIMart and Venice `resolution`; OpenAI has none", async () => {
    harness = await startHarness(setup());
    const mart = await generate({ model: "mart", provider_options: { size: "16:9", resolution: "2k" } });
    expect(mart.structuredContent).toMatchObject({ requested_shape: "16:9", requested_resolution: "2k" });
    const venice = await generate({ model: "venice", provider_options: { aspect_ratio: "1:1", resolution: "2K" } });
    expect(venice.structuredContent).toMatchObject({ requested_resolution: "2K" });
    const unknown = await generate({ model: "mystery" });
    expect(unknown.structuredContent).toMatchObject({ requested_resolution: null });
  });

  test("a request that sets no tier has a null resolution, not a default", async () => {
    harness = await startHarness(setup({ [urls.openai]: openaiImages(1024, 1024) }));
    const result = await generate({ model: "flare", provider_options: { size: "1024x1024", quality: "high" } });
    expect(result.structuredContent).toMatchObject({ requested_resolution: null });
    const gemini = await generate({ model: "banana" });
    expect(gemini.structuredContent).toMatchObject({ requested_resolution: null });
  });

  test("the removed parameters are refused by name, not silently ignored (ADR 0010)", async () => {
    harness = await startHarness(setup());
    const image = await generate({ model: "flare", aspect_ratio: "16:9" });
    expect(image.isError).toBe(true);
    expect(textOf(image)).toContain("aspect_ratio");

    const video = await harness.client.callTool({ name: "generate_video", arguments: { prompt: "a fox runs", duration: 5, resolution: "720P" } });
    expect(video.isError).toBe(true);
    expect(textOf(video)).toContain("duration");

    const comparison = await harness.client.callTool({
      name: "generate_comparison",
      arguments: { variants: [{ prompt: "a fox", model: "flare" }, { prompt: "a fox", model: "flux2" }], aspect_ratio: "16:9" },
    });
    expect(comparison.isError).toBe(true);
    expect(harness.requests).toHaveLength(0);
  });
});
