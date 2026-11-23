import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { startHarness, type Harness } from "./harness.ts";
import { mp4Of, readHistory, recorded, textOf } from "./helpers.ts";

/** Standing Options (ADR 0010): request fields the User set once on a Model, merged under the Agent's `provider_options`. */

const root = "https://api.together.ai";
const imagesUrl = `POST ${root}/v1/images/generations`;
const videosUrl = `POST ${root}/v2/videos`;
const videoId = "01a1a5f7-aab2-741e-af5a-38d3d6b4e040";

const standing = { steps: 28, guidance: 3.5, output: { format: "png", quality: 90 }, seed: 7 };

const firstChange = new Date("2026-11-21T10:00:00.000Z");
const secondChange = new Date("2026-11-21T11:30:00.000Z");

async function start(now = () => firstChange, routes: Record<string, ReturnType<typeof recorded>> = {}) {
  harness = await startHarness({
    now,
    config: {
      providers: [{ id: "together-ai", baseUrl: `${root}/v1` }],
      models: [
        { alias: "flux2", provider: "together-ai", modelId: "black-forest-labs/FLUX.2-pro", protocol: "together", standingOptions: standing },
        { alias: "sdxl", provider: "together-ai", modelId: "stabilityai/stable-diffusion-xl-base-1.0", protocol: "together" },
        {
          alias: "wan",
          provider: "together-ai",
          modelId: "Wan-AI/wan2.7-t2v",
          protocol: "together",
          modality: "video",
          standingOptions: { generate_audio: true, negative_prompt: "blur" },
        },
      ],
      defaultImageModel: "flux2",
      defaultVideoModel: "wan",
    },
    credentials: { "together-ai": { apiKey: "together-test-0000secret0000" } },
    routes: {
      [imagesUrl]: recorded("together/images.json"),
      [videosUrl]: recorded("together/video-submitted.json"),
      [`GET ${root}/v2/videos/${videoId}`]: recorded("together/video-completed.json"),
      "GET https://api.together.ai/shrt/example0000": () => new Response(mp4Of(1920, 1080, 5), { headers: { "content-type": "video/mp4" } }),
      ...routes,
    },
    pollIntervalMs: 1,
  });
  return harness;
}

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

const sentBodies = async (h: Harness) =>
  Promise.all(h.requests.filter((request) => request.method === "POST").map(async (request) => JSON.parse(await request.text())));

describe("Standing Options (ADR 0010)", () => {
  test("a generate_image Job sends them merged under the Agent's provider_options: the Agent wins, objects merge key by key, null drops one", async () => {
    const h = await start();
    const result = await h.client.callTool({
      name: "generate_image",
      arguments: { prompt: "a red fox", provider_options: { steps: 40, output: { quality: 70 }, seed: null } },
    });
    expect(result.isError).toBeFalsy();

    const [body] = await sentBodies(h);
    expect(body.steps).toBe(40);
    expect(body.guidance).toBe(3.5);
    expect(body.output).toEqual({ format: "png", quality: 70 });
    expect(body).not.toHaveProperty("seed");
  });

  test("the Job history records the options as sent, so Option Statuses reflect them", async () => {
    const h = await start();
    await h.client.callTool({ name: "generate_image", arguments: { prompt: "a red fox", provider_options: { steps: 40, seed: null } } });

    const [job] = await readHistory(h);
    const sent = { steps: 40, guidance: 3.5, output: { format: "png", quality: 90 } };
    expect((job!.parameters as { providerOptions: unknown }).providerOptions).toEqual(sent);

    const listed = await h.client.callTool({ name: "list_models", arguments: { model: "flux2" } });
    const [model] = (listed.structuredContent as { models: Array<{ option_statuses: { accepted: Array<{ options: unknown }> } }> }).models;
    expect(model!.option_statuses.accepted.map((status) => status.options)).toEqual(Object.entries(sent).map(([key, value]) => ({ [key]: value })));
  });

  test("a generate_video Job merges them the same way", async () => {
    const h = await start();
    const result = await h.client.callTool({
      name: "generate_video",
      arguments: { prompt: "a fox runs", provider_options: { negative_prompt: null, seed: 3 } },
    });
    expect(result.isError).toBeFalsy();
    const [body] = await sentBodies(h);
    expect(body.generate_audio).toBe(true);
    expect(body.seed).toBe(3);
    expect(body).not.toHaveProperty("negative_prompt");
  });

  test("each generate_comparison variant's Job sends its own Model's Standing Options", async () => {
    const h = await start();
    const result = await h.client.callTool({
      name: "generate_comparison",
      arguments: { variants: [{ prompt: "a fox", model: "flux2" }, { prompt: "a fox", model: "sdxl" }] },
    });
    expect(result.isError).toBeFalsy();
    const bodies = await sentBodies(h);
    const flux = bodies.find((body) => body.model === "black-forest-labs/FLUX.2-pro");
    const sdxl = bodies.find((body) => body.model === "stabilityai/stable-diffusion-xl-base-1.0");
    expect(flux).toMatchObject({ steps: 28, guidance: 3.5, seed: 7 });
    expect(sdxl).not.toHaveProperty("steps");
  });

  test("list_models shows each Model's Standing Options", async () => {
    const h = await start();
    const result = await h.client.callTool({ name: "list_models", arguments: {} });
    const models = (result.structuredContent as { models: Array<{ alias: string; standing_options: unknown }> }).models;
    expect(models.find((model) => model.alias === "flux2")!.standing_options).toEqual(standing);
    expect(models.find((model) => model.alias === "sdxl")!.standing_options).toEqual({});
    expect(textOf(result)).toContain(`Standing Options: ${JSON.stringify(standing)}`);
  });

  test("a generate_image result shows which options came from the Standing Options and which from the Job, and each one the Job overrode", async () => {
    const h = await start();
    const result = await h.client.callTool({
      name: "generate_image",
      arguments: { prompt: "a red fox", provider_options: { steps: 40, output: { quality: 70 }, seed: null, negative_prompt: "blur" } },
    });

    expect(result.structuredContent).toMatchObject({
      options_sent: {
        standing: { guidance: 3.5, output: { format: "png" } },
        job: { steps: 40, output: { quality: 70 }, negative_prompt: "blur" },
      },
      overrides: [
        { option: "steps", standing: 28, job: 40 },
        { option: "output.quality", standing: 90, job: 70 },
        { option: "seed", standing: 7, job: null },
      ],
    });
    expect(textOf(result)).toContain("This Job overrode Standing Options: steps 28 → 40, output.quality 90 → 70, seed 7 → dropped.");
  });

  test("a Job that drops every key of a Standing object shows the empty object it sent", async () => {
    const h = await start();
    const result = await h.client.callTool({ name: "generate_image", arguments: { prompt: "a red fox", provider_options: { output: { format: null, quality: null } } } });

    const [body] = await sentBodies(h);
    expect(body.output).toEqual({});
    expect(result.structuredContent).toMatchObject({
      options_sent: { standing: { steps: 28, guidance: 3.5, seed: 7 }, job: { output: {} } },
      overrides: [
        { option: "output.format", standing: "png", job: null },
        { option: "output.quality", standing: 90, job: null },
      ],
    });
  });

  test("a failed Job's error says which options it sent and which Standing Options it overrode", async () => {
    const h = await start(undefined, { [imagesUrl]: recorded("together/invalid-reference-image.json", 400) });
    const result = await h.client.callTool({ name: "generate_image", arguments: { prompt: "a red fox", provider_options: { steps: 40 } } });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Sent {"guidance":3.5');
    expect(textOf(result)).toContain("This Job overrode Standing Options: steps 28 → 40.");
  });

  test("a failed Comparison variant shows its options and overrides too", async () => {
    const h = await start(undefined, { [imagesUrl]: recorded("together/invalid-reference-image.json", 400) });
    const result = await h.client.callTool({
      name: "generate_comparison",
      arguments: { variants: [{ prompt: "a fox", model: "flux2", provider_options: { steps: 40 } }, { prompt: "a fox", model: "sdxl" }] },
    });

    const [flux] = (result.structuredContent as { jobs: Array<{ error: string }> }).jobs;
    expect(flux).toMatchObject({ status: "failed", options_sent: { job: { steps: 40 } }, overrides: [{ option: "steps", standing: 28, job: 40 }] });
    expect(flux!.error).toContain("This Job overrode Standing Options: steps 28 → 40.");
  });

  test("a Job that fails after its wait ends says in get_job which options it sent", async () => {
    const h = await start(undefined, { [`GET ${root}/v2/videos/${videoId}`]: recorded("together/video-failed.json") });
    const started = await h.client.callTool({ name: "generate_video", arguments: { prompt: "a fox runs", provider_options: { negative_prompt: null }, wait: false } });
    const { job_id } = started.structuredContent as { job_id: string };

    const result = await h.client.callTool({ name: "get_job", arguments: { job_id } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Sent {"generate_audio":true} from Standing Options.');
    expect(textOf(result)).toContain('This Job overrode Standing Options: negative_prompt "blur" → dropped.');
  });

  test("an override names the value sent, as merged", async () => {
    const h = await start();
    const result = await h.client.callTool({ name: "generate_image", arguments: { prompt: "a red fox", provider_options: { seed: { a: null } } } });

    const [body] = await sentBodies(h);
    expect(body.seed).toEqual({});
    const { options_sent, overrides } = result.structuredContent as { options_sent: { job: unknown }; overrides: unknown };
    expect(options_sent.job).toEqual({ seed: {} });
    expect(overrides).toEqual([{ option: "seed", standing: 7, job: {} }]);
  });

  test("a Job that overrides nothing says nothing about overrides", async () => {
    const h = await start();
    const result = await h.client.callTool({ name: "generate_image", arguments: { prompt: "a red fox", provider_options: { negative_prompt: "blur", steps: 28 } } });

    expect(result.structuredContent).toMatchObject({
      options_sent: { standing: { guidance: 3.5, output: { format: "png", quality: 90 }, seed: 7 }, job: { negative_prompt: "blur", steps: 28 } },
    });
    expect(result.structuredContent).not.toHaveProperty("overrides");
    expect(textOf(result)).not.toContain("overrode");
  });

  test("get_job shows the same, from the Job history, even after the Standing Options change", async () => {
    const h = await start();
    const started = await h.client.callTool({ name: "generate_image", arguments: { prompt: "a red fox", provider_options: { steps: 40 }, wait: false } });
    const { job_id } = started.structuredContent as { job_id: string };
    expect(started.structuredContent).toMatchObject({ status: "running", overrides: [{ option: "steps", standing: 28, job: 40 }] });
    await h.client.callTool({ name: "update_standing_options", arguments: { model: "flux2", standing_options: { steps: 40 } } });

    const result = await h.client.callTool({ name: "get_job", arguments: { job_id } });
    expect(result.structuredContent).toMatchObject({
      status: "completed",
      options_sent: { standing: { guidance: 3.5, output: { format: "png", quality: 90 }, seed: 7 }, job: { steps: 40 } },
      overrides: [{ option: "steps", standing: 28, job: 40 }],
    });
    expect(textOf(result)).toContain("This Job overrode Standing Options: steps 28 → 40.");
  });

  test("a generate_video result and each generate_comparison variant show their options the same way", async () => {
    const h = await start();
    const video = await h.client.callTool({ name: "generate_video", arguments: { prompt: "a fox runs", provider_options: { negative_prompt: null } } });
    expect(video.structuredContent).toMatchObject({
      options_sent: { standing: { generate_audio: true }, job: {} },
      overrides: [{ option: "negative_prompt", standing: "blur", job: null }],
    });

    const comparison = await h.client.callTool({
      name: "generate_comparison",
      arguments: { variants: [{ prompt: "a fox", model: "flux2" }, { prompt: "a fox", model: "sdxl", provider_options: { steps: 30 } }] },
    });
    const [flux, sdxl] = (comparison.structuredContent as { jobs: unknown[] }).jobs;
    expect(flux).toMatchObject({ options_sent: { standing, job: {} } });
    expect(sdxl).toMatchObject({ options_sent: { standing: {}, job: { steps: 30 } } });
  });

  test("no tool description models a price option such as quality: high", async () => {
    const h = await start();
    const { tools } = await h.client.listTools();
    expect(JSON.stringify(tools)).not.toMatch(/\\"quality\\": \\"high\\"/);
  });

  test("the server instructions point the Agent at the Standing Options before it writes provider_options", async () => {
    const h = await start();
    expect(h.client.getInstructions()).toMatch(/Before writing `provider_options`, read the Model's Standing Options \(`list_models`\)/);
  });

  test("a reserved field in the merged options is rejected with the field named", async () => {
    const h = await start();
    const result = await h.client.callTool({ name: "generate_image", arguments: { prompt: "a fox", provider_options: { model: "other" } } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("`model`");
    expect(textOf(result)).toContain("Standing Options");
    expect(h.requests).toHaveLength(0);
  });
});

describe("update_standing_options", () => {
  const update = (args: Record<string, unknown>) => harness!.client.callTool({ name: "update_standing_options", arguments: args });
  const stored = async (alias: string) =>
    (JSON.parse(await readFile(join(harness!.dirs.home, "config.json"), "utf8")).models as Array<{ alias: string; standingOptions?: unknown }>).find(
      (model) => model.alias === alias,
    )!;

  test("replaces a Model's Standing Options whole, keeps the previous version and records the Agent and when; later Jobs send the new ones", async () => {
    const h = await start();
    const result = await update({ model: "flux2", standing_options: { steps: 40 } });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      model: "flux2",
      standing_options: { steps: 40 },
      previous_standing_options: standing,
      changed: true,
      changed_by: "Agent",
      changed_at: firstChange.toISOString(),
    });
    expect(textOf(result)).toContain(JSON.stringify(standing));
    expect(await stored("flux2")).toMatchObject({
      standingOptions: { steps: 40 },
      standingOptionsHistory: { changedBy: "Agent", changedAt: firstChange.toISOString(), previous: standing },
    });
    expect((await stored("sdxl")).standingOptions).toBeUndefined();

    await h.client.callTool({ name: "generate_image", arguments: { prompt: "a red fox" } });
    const [body] = await sentBodies(h);
    expect(body).toMatchObject({ steps: 40 });
    expect(body).not.toHaveProperty("guidance");
  });

  test("sets them on a Model that had none, and {} clears them", async () => {
    await start();
    const set = await update({ model: "sdxl", standing_options: { steps: 30 } });
    expect(set.structuredContent).toMatchObject({ previous_standing_options: {}, changed: true });
    expect((await stored("sdxl")).standingOptions).toEqual({ steps: 30 });

    const cleared = await update({ model: "sdxl", standing_options: {} });
    expect(cleared.isError).toBeFalsy();
    expect(await stored("sdxl")).not.toHaveProperty("standingOptions");
  });

  test("the same options again record no change", async () => {
    await start();
    const result = await update({ model: "flux2", standing_options: standing });
    expect(result.structuredContent).toMatchObject({ changed: false, changed_by: null });
    expect(await stored("flux2")).not.toHaveProperty("standingOptionsHistory");
  });

  test("a video Model's own reserved fields are refused", async () => {
    await start();
    const result = await update({ model: "wan", standing_options: { media: { frame_images: [] } } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("`media`");
  });

  test("with no Model configured, tells the Agent to call open_settings", async () => {
    harness = await startHarness();
    const result = await update({ model: "flux2", standing_options: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Call `open_settings`");
  });

  test("the User sees the Agent's change in the settings page and can undo it", async () => {
    let now = firstChange;
    const h = await start(() => now);
    await update({ model: "flux2", standing_options: { steps: 40 } });

    await h.client.callTool({ name: "open_settings", arguments: {} });
    const page = new URL(h.openedUrls[0]!);
    const headers = { origin: page.origin, "x-litevision-token": page.searchParams.get("token")! };
    const models = (await (await fetch(new URL("/api/models", page.origin), { headers })).json()) as { models: Array<{ standingOptionsHistory: unknown }> };
    expect(models.models[0]!.standingOptionsHistory).toMatchObject({ changedBy: "Agent", previous: standing });

    now = secondChange;
    const undone = await fetch(new URL("/api/models/flux2/standing-options/undo", page.origin), { method: "POST", headers });
    expect(undone.status).toBe(200);
    expect(await stored("flux2")).toMatchObject({
      standingOptions: standing,
      standingOptionsHistory: { changedBy: "User", changedAt: secondChange.toISOString(), previous: { steps: 40 } },
    });
  });

  test("rejects a field the Model's Protocol fills itself, naming it, and changes nothing", async () => {
    await start();
    const result = await update({ model: "flux2", standing_options: { prompt: "x", steps: 40 } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("prompt");
    expect((await stored("flux2")).standingOptions).toEqual(standing);
  });

  test("an unknown Alias is an error that lists the known ones", async () => {
    await start();
    const result = await update({ model: "missing", standing_options: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("flux2, sdxl, wan");
  });

  test("the server instructions require showing old and new Standing Options and getting the User's agreement first", async () => {
    const h = await start();
    expect(h.client.getInstructions()).toMatch(/update_standing_options.*old and new .*Standing Options.*agree/);
  });
});
