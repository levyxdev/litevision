import { afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { startHarness, type Harness, type HarnessOptions, type Route } from "./harness.ts";
import { mp4Of, readHistory, recorded, textOf, tinyPng } from "./helpers.ts";

/** Comparisons (ADR 0009): several Jobs started together for one request, sharing one Modality. */

const root = "https://api.together.ai";
const imagesUrl = `POST ${root}/v1/images/generations`;
const videosUrl = `POST ${root}/v2/videos`;
const videoId = "01a1a5f7-aab2-741e-af5a-38d3d6b4e040";

/** One Together Provider with two image Models and two video Models; `sdxl` and `wan` are the defaults. */
function togetherSetup(routes: HarnessOptions["routes"] = {}): HarnessOptions {
  return {
    config: {
      providers: [{ id: "together-ai", baseUrl: `${root}/v1` }],
      models: [
        { alias: "sdxl", provider: "together-ai", modelId: "stabilityai/stable-diffusion-xl-base-1.0", protocol: "together" },
        { alias: "flux2", provider: "together-ai", modelId: "black-forest-labs/FLUX.2-pro", protocol: "together" },
        { alias: "wan", provider: "together-ai", modelId: "Wan-AI/wan2.7-t2v", protocol: "together", modality: "video" },
        { alias: "seedance", provider: "together-ai", modelId: "ByteDance/Seedance-2.5", protocol: "together", modality: "video" },
      ],
      defaultImageModel: "sdxl",
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
    now: () => new Date(2026, 10, 5, 9, 0, 0),
    pollIntervalMs: 1,
  };
}

/** Answers image requests per upstream model id; any model not listed gets the recorded image. */
function byModel(answers: Record<string, Route>): Route {
  return async (request) => {
    const { model } = (await request.clone().json()) as { model: string };
    return (answers[model] ?? recorded("together/images.json"))(request);
  };
}

/** A route that answers only once `release` is called. */
function held(answer: Route) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const route: Route = async (request) => {
    await released;
    return answer(request);
  };
  return { route, release };
}

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

const compare = (args: Record<string, unknown>) => harness!.client.callTool({ name: "generate_comparison", arguments: args });

function ok(result: Awaited<ReturnType<typeof compare>>): Record<string, any> {
  expect(result.isError, textOf(result)).toBeFalsy();
  return result.structuredContent as Record<string, any>;
}

async function imageBodies(): Promise<Array<Record<string, any>>> {
  const requests = harness!.requests.filter((request) => `${request.method} ${request.url}` === imagesUrl);
  return Promise.all(requests.map(async (request) => (await request.clone().json()) as Record<string, any>));
}

describe("generate_comparison", () => {
  test("runs each variant as a Job and returns them under one Comparison id", async () => {
    harness = await startHarness(togetherSetup());
    const output = ok(
      await compare({
        variants: [
          { prompt: "a red fox, watercolour", model: "sdxl", provider_options: { width: 1024, height: 576 } },
          { prompt: "a red fox, photograph", model: "flux2", n: 2, provider_options: { width: 1344, height: 768 } },
        ],
      }),
    );

    expect(output.comparison_id).toMatch(/\S+/);
    expect(output.modality).toBe("image");
    expect(output.jobs).toHaveLength(2);
    const [first, second] = output.jobs;
    expect(first).toMatchObject({ status: "completed", model: "sdxl", requested_shape: "1024x576" });
    expect(second).toMatchObject({ status: "completed", model: "flux2", requested_shape: "1344x768" });
    expect(first.job_id).not.toBe(second.job_id);
    expect(await readFile(first.files[0])).toEqual(tinyPng);

    const bodies = await imageBodies();
    expect(bodies.map((body) => [body.model, body.prompt, body.n]).sort()).toEqual([
      ["black-forest-labs/FLUX.2-pro", "a red fox, photograph", 2],
      ["stabilityai/stable-diffusion-xl-base-1.0", "a red fox, watercolour", 1],
    ]);
  });

  test("saves each variant's files under its own `name`, and records it on the variant's Job", async () => {
    harness = await startHarness(togetherSetup());
    const folder = join(harness.dirs.output, "2026-11-05");
    const named = ok(await compare({ variants: [{ prompt: "a red fox", name: "fox" }, { prompt: "a red fox", model: "flux2", name: "fox" }] }));
    expect(named.jobs.map((job: { files: string[] }) => job.files).flat().sort()).toEqual([join(folder, "fox-2.png"), join(folder, "fox.png")]);
    const history = (await readHistory(harness)) as Array<{ parameters: { name?: string } }>;
    expect(history.filter((job) => job.parameters.name === "fox")).toHaveLength(2);
  });

  test("saves unnamed variants finishing together under distinct names", async () => {
    harness = await startHarness(togetherSetup());
    const folder = join(harness.dirs.output, "2026-11-05");
    const unnamed = ok(await compare({ variants: [{ prompt: "a red fox" }, { prompt: "a red fox", model: "flux2" }, { prompt: "a fox" }] }));
    expect(unnamed.jobs.map((job: { files: string[] }) => job.files).flat().sort()).toEqual(
      ["090000-2.png", "090000-3.png", "090000.png"].map((file) => join(folder, file)),
    );
  });

  test("records the Comparison on each Job's history record", async () => {
    harness = await startHarness(togetherSetup());
    const output = ok(
      await compare({ variants: [{ prompt: "a red fox" }, { prompt: "a red fox", model: "flux2" }], output_path: "assets" }),
    );

    const history = await readHistory(harness);
    expect(history).toHaveLength(2);
    for (const record of history) {
      expect(record).toMatchObject({ comparison: output.comparison_id, outcome: "completed" });
      expect((record.parameters as Record<string, unknown>).outputPath).toBe(join(harness.cwd, "assets"));
    }
  });

  test("a variant without model uses the default Model of the Comparison's Modality", async () => {
    harness = await startHarness(togetherSetup());
    const images = ok(await compare({ variants: [{ prompt: "a red fox" }, { prompt: "a grey wolf" }] }));
    expect(images.jobs.map((job: { model: string }) => job.model)).toEqual(["sdxl", "sdxl"]);

    const videos = ok(
      await compare({ variants: [{ prompt: "a fox runs", model: "seedance", provider_options: { seconds: "5" } }, { prompt: "a fox runs" }] }),
    );
    expect(videos.modality).toBe("video");
    expect(videos.jobs.map((job: { model: string }) => job.model)).toEqual(["seedance", "wan"]);
    expect(videos.jobs[0]).toMatchObject({ status: "completed", requested_duration: 5 });
  });

  test("with no variant naming a Model, `modality` picks the default video Model", async () => {
    harness = await startHarness(togetherSetup());
    const output = ok(await compare({ modality: "video", variants: [{ prompt: "a fox runs" }, { prompt: "a fox leaps" }] }));
    expect(output.jobs.map((job: { model: string }) => job.model)).toEqual(["wan", "wan"]);
  });

  test("rejects mixed Modalities without starting a Job", async () => {
    harness = await startHarness(togetherSetup());
    const result = await compare({ variants: [{ prompt: "a red fox", model: "sdxl" }, { prompt: "a fox runs", model: "wan" }] });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("one Modality");
    expect(textOf(result)).toContain("wan");
    expect(harness.requests).toHaveLength(0);
  });

  test("rejects a Model of the other Modality than `modality` says", async () => {
    harness = await startHarness(togetherSetup());
    const result = await compare({ modality: "image", variants: [{ prompt: "a fox runs", model: "wan" }, { prompt: "a red fox" }] });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("one Modality");
    expect(harness.requests).toHaveLength(0);
  });

  test("rejects fewer than two or more than four variants without starting a Job", async () => {
    harness = await startHarness(togetherSetup());
    const one = await compare({ variants: [{ prompt: "a red fox" }] });
    expect(one.isError).toBe(true);
    expect(textOf(one)).toContain("variants");
    const five = await compare({ variants: Array.from({ length: 5 }, (_, index) => ({ prompt: `a red fox ${index}` })) });
    expect(five.isError).toBe(true);
    expect(textOf(five)).toContain("variants");
    expect(harness.requests).toHaveLength(0);
    expect(await Bun.file(join(harness.dirs.home, "jobs.jsonl")).exists()).toBe(false);
  });

  test("rejects a variant whose provider_options set a field litevision fills, without starting any Job", async () => {
    harness = await startHarness(togetherSetup());
    const result = await compare({ variants: [{ prompt: "a red fox" }, { prompt: "a red fox", model: "flux2", provider_options: { prompt: "a wolf" } }] });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("`prompt`");
    expect(harness.requests).toHaveLength(0);
  });

  test("rejects the removed `duration` parameter, and more than one video per variant", async () => {
    harness = await startHarness(togetherSetup());
    const duration = await compare({ variants: [{ prompt: "a red fox" }, { prompt: "a grey wolf" }], duration: 5 });
    expect(duration.isError).toBe(true);
    expect(textOf(duration)).toContain("duration");
    const n = await compare({ variants: [{ prompt: "a fox runs", model: "wan", n: 2 }, { prompt: "a fox leaps" }] });
    expect(n.isError).toBe(true);
    expect(textOf(n)).toContain("one video");
    expect(harness.requests).toHaveLength(0);
  });

  test("one failed Job does not fail the others; the result says which failed and why", async () => {
    harness = await startHarness(
      togetherSetup({
        [imagesUrl]: byModel({ "black-forest-labs/FLUX.2-pro": recorded("together/model-not-available.json", 404) }),
      }),
    );
    const result = await compare({ variants: [{ prompt: "a red fox" }, { prompt: "a red fox", model: "flux2" }] });
    const output = ok(result);

    const [good, bad] = output.jobs;
    expect(good).toMatchObject({ status: "completed", model: "sdxl" });
    expect(good.files).toHaveLength(1);
    expect(bad).toMatchObject({ status: "failed", model: "flux2", files: [] });
    expect(bad.job_id).toMatch(/\S+/);
    expect(bad.error).toContain("Unable to access model");
    expect(textOf(result)).toContain(`Job ${bad.job_id} on flux2 failed`);

    const history = await readHistory(harness);
    expect(history.find((record) => record.id === bad.job_id)).toMatchObject({ outcome: "failed", comparison: output.comparison_id });
  });

  test("starts its Jobs in parallel", async () => {
    const first = held(recorded("together/images.json"));
    const second = held(recorded("together/images.json"));
    harness = await startHarness(
      togetherSetup({
        [imagesUrl]: byModel({ "stabilityai/stable-diffusion-xl-base-1.0": first.route, "black-forest-labs/FLUX.2-pro": second.route }),
      }),
    );
    const pending = compare({ variants: [{ prompt: "a red fox" }, { prompt: "a red fox", model: "flux2" }] });

    // Neither Provider has answered, yet both have been asked.
    while (harness.requests.filter((request) => `${request.method} ${request.url}` === imagesUrl).length < 2) {
      await Bun.sleep(1);
    }
    first.release();
    second.release();
    const output = ok(await pending);
    expect(output.jobs.map((job: { status: string }) => job.status)).toEqual(["completed", "completed"]);
  });

  test("a slow Job is returned as running and get_job completes it", async () => {
    const slow = held(recorded("together/images.json"));
    harness = await startHarness({
      ...togetherSetup({ [imagesUrl]: byModel({ "black-forest-labs/FLUX.2-pro": slow.route }) }),
      waitLimitMs: 40,
    });
    const result = await compare({ variants: [{ prompt: "a red fox" }, { prompt: "a red fox", model: "flux2" }] });
    const output = ok(result);

    const [fast, running] = output.jobs;
    expect(fast).toMatchObject({ status: "completed", model: "sdxl" });
    expect(running).toMatchObject({ status: "running", model: "flux2", files: [] });
    expect(textOf(result)).toContain("get_job");

    slow.release();
    const job = await harness.client.callTool({ name: "get_job", arguments: { job_id: running.job_id } });
    expect(job.isError, textOf(job)).toBeFalsy();
    const done = job.structuredContent as Record<string, any>;
    expect(done.status).toBe("completed");
    expect(await readFile(done.files[0])).toEqual(tinyPng);
  });

  test("the server instructions say to start a Comparison only when the User asks for one or agrees to it", async () => {
    harness = await startHarness();
    expect(harness.client.getInstructions()).toContain("generate_comparison");
    expect(harness.client.getInstructions()).toMatch(/only when the User asks for one or agrees to it/);
  });
});
