import { afterEach, describe, expect, test } from "bun:test";
import { startHarness, type Harness } from "./harness.ts";
import { mp4Of, readHistory, recorded, textOf } from "./helpers.ts";

/** Standing Options (ADR 0010): request fields the User set once on a Model, merged under the Agent's `provider_options`. */

const root = "https://api.together.ai";
const imagesUrl = `POST ${root}/v1/images/generations`;
const videosUrl = `POST ${root}/v2/videos`;
const videoId = "01a1a5f7-aab2-741e-af5a-38d3d6b4e040";

const standing = { steps: 28, guidance: 3.5, output: { format: "png", quality: 90 }, seed: 7 };

async function start() {
  harness = await startHarness({
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

  test("a reserved field in the merged options is rejected with the field named", async () => {
    const h = await start();
    const result = await h.client.callTool({ name: "generate_image", arguments: { prompt: "a fox", provider_options: { model: "other" } } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("`model`");
    expect(textOf(result)).toContain("Standing Options");
    expect(h.requests).toHaveLength(0);
  });
});
