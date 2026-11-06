import { afterEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startHarness, type Harness, type HarnessOptions, type Route } from "./harness.ts";
import { mp4Of, readHistory, recorded, textOf, tinyPng } from "./helpers.ts";

/** ADR 0010: video Jobs send every non-fixed field the Agent sets, and nothing is checked, defaulted or rounded. */

const root = "https://api.together.ai";
const videosUrl = `POST ${root}/v2/videos`;
const videoId = "01a1a5f7-aab2-741e-af5a-38d3d6b4e040";

const mp4 = (width: number, height: number, seconds: number): Route => () =>
  new Response(mp4Of(width, height, seconds), { headers: { "content-type": "video/mp4" } });

function setup(routes: HarnessOptions["routes"] = {}): HarnessOptions {
  return {
    config: {
      providers: [{ id: "together-ai", baseUrl: `${root}/v1` }],
      models: [
        { alias: "wan", provider: "together-ai", modelId: "Wan-AI/wan2.7-t2v", protocol: "together", modality: "video" },
        { alias: "veo", provider: "together-ai", modelId: "google/veo-3.1", protocol: "together", modality: "video" },
      ],
      defaultVideoModel: "wan",
    },
    credentials: { "together-ai": { apiKey: "together-test-0000secret0000" } },
    routes: {
      [videosUrl]: recorded("together/video-submitted.json"),
      [`GET ${root}/v2/videos/${videoId}`]: recorded("together/video-completed.json"),
      "GET https://api.together.ai/shrt/example0000": mp4(1920, 1080, 5),
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

const video = (args: Record<string, unknown> = {}) => harness!.client.callTool({ name: "generate_video", arguments: { prompt: "a fox runs", ...args } });

async function sentBody(): Promise<Record<string, unknown>> {
  const request = harness!.requests.find((candidate) => `${candidate.method} ${candidate.url}` === videosUrl)!;
  return (await request.json()) as Record<string, unknown>;
}

interface VideoOutput {
  requested_shape: string | null;
  requested_duration: number | null;
  mismatch?: string;
}

describe("video Jobs pass every non-fixed field through (ADR 0010)", () => {
  test("with no aspect_ratio, duration or resolution, no shape, tier or length is sent", async () => {
    harness = await startHarness(setup());
    for (const model of ["wan", "veo"]) {
      const result = await video({ model });
      expect(result.isError).toBeFalsy();
      const body = await sentBody();
      for (const field of ["ratio", "resolution", "seconds", "width", "height"]) expect(body).not.toHaveProperty(field);
      harness.requests.length = 0;
    }
  });

  test("an unreadable request is unchecked, and says so", async () => {
    harness = await startHarness(setup());
    const result = await video();
    const output = result.structuredContent as unknown as VideoOutput;
    expect(output.requested_shape).toBeNull();
    expect(output.requested_duration).toBeNull();
    expect(output.mismatch).toBeUndefined();
    expect(textOf(result)).toContain("not checked");
  });

  test("resolution, ratio and seconds in provider_options reach Together unchanged", async () => {
    harness = await startHarness(setup({ "GET https://api.together.ai/shrt/example0000": mp4(1080, 1920, 12) }));
    const result = await video({ provider_options: { resolution: "1080P", ratio: "9:16", seconds: "12" } });
    expect(result.isError).toBeFalsy();
    expect(await sentBody()).toMatchObject({ resolution: "1080P", ratio: "9:16", seconds: "12" });
    const output = result.structuredContent as unknown as VideoOutput;
    expect(output).toMatchObject({ requested_shape: "9:16", requested_duration: 12 });
    expect(output.mismatch).toBeUndefined();
  });

  test("a result whose length or shape differs from what the final request asked for is a mismatch", async () => {
    harness = await startHarness(setup());
    const output = (await video({ provider_options: { ratio: "9:16", seconds: "12" } })).structuredContent as unknown as VideoOutput;
    expect(output.mismatch).toContain("asked for 9:16, got 1920x1080");
    expect(output.mismatch).toContain("asked for 12 s, got 5 s");
  });

  test("a first frame on a Model the old tables said cannot take one is sent; Together's rejection comes back with the Parameter Guide", async () => {
    harness = await startHarness(setup({ [videosUrl]: recorded("together/invalid-reference-image.json", 400) }));
    await writeFile(join(harness.cwd, "start.png"), tinyPng);
    await writeFile(join(harness.cwd, "ref.png"), tinyPng);
    const result = await video({ first_frame: "start.png", last_frame: "start.png", references: ["ref.png"] });

    const body = await sentBody();
    expect(body.media).toMatchObject({ frame_images: [{ frame: "first" }, { frame: "last" }], reference_images: [expect.any(String)] });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Parameter Guide for Wan 2.7 text-to-video");
  });

  test("a duration or tier the old tables did not list is sent as given, not rounded", async () => {
    harness = await startHarness(setup());
    await video({ provider_options: { seconds: "17", resolution: "4K" } });
    expect(await sentBody()).toMatchObject({ seconds: "17", resolution: "4K" });
  });

  test("the Job history records what litevision read from the final request", async () => {
    harness = await startHarness(setup());
    await video({ provider_options: { ratio: "16:9", seconds: "5" } });
    const [job] = await readHistory(harness);
    expect(job!.parameters).toMatchObject({ requestedShape: "16:9", requestedSeconds: 5 });
    const again = await harness.client.callTool({ name: "get_job", arguments: { job_id: job!.id } });
    expect(again.structuredContent).toMatchObject({ requested_shape: "16:9", requested_duration: 5 });
  });
});
