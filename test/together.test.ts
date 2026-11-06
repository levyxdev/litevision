import { afterEach, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startHarness, type Harness, type HarnessOptions, type Route } from "./harness.ts";
import { mp4Of, pngOfSize, readHistory, recorded, textOf, tinyPng } from "./helpers.ts";
import { fixture } from "./recorded-http.ts";
import { startSettingsHarness, type SettingsHarness } from "./settings-harness.ts";

const apiKey = "together-test-0000secret0000";
const root = "https://api.together.ai";
const imagesUrl = `POST ${root}/v1/images/generations`;
const videosUrl = `POST ${root}/v2/videos`;
const videoId = "01a1a5f7-aab2-741e-af5a-38d3d6b4e040";
const videoStatusUrl = `GET ${root}/v2/videos/${videoId}`;
const videoFileUrl = "GET https://api.together.ai/shrt/example0000";

const mp4Response = (width = 1920, height = 1080, seconds = 5): Route => () =>
  new Response(mp4Of(width, height, seconds), { headers: { "content-type": "video/mp4" } });

/** Answers `/v1/images/generations` with one image of the given size. */
const imageOfSize = (width: number, height: number): Route => () =>
  Response.json({ id: "x", model: "m", object: "list", data: [{ index: 0, b64_json: pngOfSize(width, height).toString("base64") }] });

/**
 * One Together Provider, configured as the User did, with `/v1` on the base URL; `sdxl` is the default image Model
 * and `wan` the default video Model.
 */
function togetherSetup(routes: HarnessOptions["routes"] = {}, baseUrl = `${root}/v1`): HarnessOptions {
  return {
    config: {
      providers: [{ id: "together-ai", baseUrl }],
      models: [
        { alias: "sdxl", provider: "together-ai", modelId: "stabilityai/stable-diffusion-xl-base-1.0", protocol: "together" },
        { alias: "kontext", provider: "together-ai", modelId: "black-forest-labs/FLUX.1-kontext-pro", protocol: "together" },
        { alias: "flux2", provider: "together-ai", modelId: "black-forest-labs/FLUX.2-pro", protocol: "together" },
        { alias: "wan", provider: "together-ai", modelId: "Wan-AI/wan2.7-t2v", protocol: "together", modality: "video" },
        { alias: "wan-i2v", provider: "together-ai", modelId: "Wan-AI/wan2.7-i2v", protocol: "together", modality: "video" },
        { alias: "seedance", provider: "together-ai", modelId: "ByteDance/Seedance-2.5", protocol: "together", modality: "video" },
        { alias: "veo", provider: "together-ai", modelId: "google/veo-3.1", protocol: "together", modality: "video" },
      ],
      defaultImageModel: "sdxl",
      defaultVideoModel: "wan",
    },
    credentials: { "together-ai": { apiKey } },
    routes: {
      [imagesUrl]: recorded("together/images.json"),
      [videosUrl]: recorded("together/video-submitted.json"),
      [videoStatusUrl]: recorded("together/video-completed.json"),
      [videoFileUrl]: mp4Response(),
      ...routes,
    },
    now: () => new Date(2026, 10, 4, 9, 0, 0),
    pollIntervalMs: 1,
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

const call = (name: string, args: Record<string, unknown>) => harness!.client.callTool({ name, arguments: args });
const generate = (args: Record<string, unknown> = {}) => call("generate_image", { prompt: "a red fox", ...args });
const video = (args: Record<string, unknown> = {}) => call("generate_video", { prompt: "a fox runs through snow", ...args });

function ok(result: Awaited<ReturnType<typeof call>>): Record<string, any> {
  expect(result.isError, textOf(result)).toBeFalsy();
  return result.structuredContent as Record<string, any>;
}

async function bodyOf(url: string, index = 0): Promise<Record<string, any>> {
  const request = harness!.requests.filter((candidate) => `${candidate.method} ${candidate.url}` === url)[index];
  expect(request, `no request to ${url}`).toBeDefined();
  return (await request!.clone().json()) as Record<string, any>;
}

async function referenceImage(name = "fox.png"): Promise<string> {
  const path = join(harness!.cwd, name);
  await writeFile(path, tinyPng);
  return path;
}

const tinyPngDataUrl = `data:image/png;base64,${tinyPng.toString("base64")}`;

describe("generate_image with the together Protocol", () => {
  test("asks for base64 and no size of its own, at the API root even when the base URL ends in /v1, and saves the image", async () => {
    harness = await startHarness(togetherSetup());
    const output = ok(await generate({ n: 2 }));

    expect(await bodyOf(imagesUrl)).toEqual({
      model: "stabilityai/stable-diffusion-xl-base-1.0",
      prompt: "a red fox",
      n: 2,
      response_format: "base64",
    });
    expect(harness.requests[0]!.headers.get("authorization")).toBe(`Bearer ${apiKey}`);
    expect(new Uint8Array(await readFile(output.files[0]))).toEqual(new Uint8Array(tinyPng));
    expect(output.observed).toEqual([{ width: 1, height: 1 }]);
    // One image of two: Together said nothing about the other.
    expect(output.shortfall).toContain("1 of 2");
  });

  test("works with the preset's base URL, without a version", async () => {
    harness = await startHarness(togetherSetup({}, root));
    ok(await generate());
    expect(harness.requests[0]!.url).toBe(`${root}/v1/images/generations`);
  });

  test("FLUX.1 Kontext gets its reference as a single data URL in image_url, and its aspect ratio from provider_options", async () => {
    harness = await startHarness(togetherSetup({ [imagesUrl]: imageOfSize(1344, 768) }));
    const reference = await referenceImage();
    ok(await generate({ model: "kontext", references: [reference], provider_options: { aspect_ratio: "16:9" } }));

    const body = await bodyOf(imagesUrl);
    expect(body).toMatchObject({ aspect_ratio: "16:9", image_url: tinyPngDataUrl });
    expect(body).not.toHaveProperty("width");
  });

  test("FLUX.2 gets its references as data URLs in reference_images, since Together rejects bare base64", async () => {
    harness = await startHarness(togetherSetup({ [imagesUrl]: imageOfSize(1344, 768) }));
    const reference = await referenceImage();
    ok(await generate({ model: "flux2", references: [reference, reference], provider_options: { width: 1344, height: 768 } }));
    expect(await bodyOf(imagesUrl)).toMatchObject({ width: 1344, height: 768, reference_images: [tinyPngDataUrl, tinyPngDataUrl] });
  });


  test("a model with no documented references is sent them anyway, for Together to decide (ADR 0010)", async () => {
    harness = await startHarness(togetherSetup());
    ok(await generate({ references: [await referenceImage()] }));
    expect(await bodyOf(imagesUrl)).toMatchObject({ reference_images: [tinyPngDataUrl] });
  });

  test("a rejected Credential is an auth error that sends the User to the settings page", async () => {
    harness = await startHarness(togetherSetup({ [imagesUrl]: recorded("together/invalid-api-key.json", 401) }));
    const result = await generate();
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("open_settings");
    expect(textOf(result)).toContain("Invalid API key provided");
    expect((await readHistory(harness))[0]).toMatchObject({ outcome: "failed", error: { kind: "auth" } });
  });

  test("a model the organization has not allowed through says where the User can allow it, not that the key is wrong", async () => {
    harness = await startHarness(togetherSetup({ [imagesUrl]: recorded("together/passthrough-blocked.json", 403) }));
    const result = await generate();
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain('"Passthrough models"');
    expect(text).toContain("https://api.together.ai/settings");
    expect(text).not.toContain("settings/privacy");
    expect(text).not.toContain("open_settings");
    expect((await readHistory(harness))[0]).toMatchObject({ error: { kind: "unsupported" } });
  });

  test("a request Together rejects carries the Model's docs link and Known-good Options", async () => {
    let reject = false;
    const images: Route = (request) =>
      reject ? recorded("together/invalid-reference-image.json", 400)(request) : recorded("together/images.json")(request);
    harness = await startHarness(togetherSetup({ [imagesUrl]: images }));
    ok(await generate({ provider_options: { steps: 30 } }));
    reject = true;

    const result = await generate({ provider_options: { steps: 99 } });
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("invalid reference image at index 0");
    expect(text).toContain("https://docs.together.ai/docs/inference/images/parameters");
    expect(text).toContain('Known-good Options: {"steps":30}');
  });

  test("Together naming the parameter it rejects is a rejected option with the docs link, even when the name says safety", async () => {
    const rejected = () =>
      Response.json(
        { error: { message: "safety_tolerance must be between 0 and 6", type: "invalid_request_error", param: "safety_tolerance", code: null } },
        { status: 400 },
      );
    harness = await startHarness(togetherSetup({ [imagesUrl]: rejected }));
    const text = textOf(await generate({ provider_options: { safety_tolerance: 9 } }));
    expect(text).toContain("rejected an option");
    expect(text).not.toContain("content grounds");
    expect((await readHistory(harness))[0]).toMatchObject({ error: { kind: "rejected_option" } });
    expect(text).toContain("https://docs.together.ai/docs/inference/images/parameters");
  });

  test("a prompt Together refuses on content grounds stays a refusal, though Together names the field", async () => {
    const refused = () =>
      Response.json(
        { error: { message: "prompt was flagged by the safety filter", type: "invalid_request_error", param: "prompt", code: null } },
        { status: 400 },
      );
    harness = await startHarness(togetherSetup({ [imagesUrl]: refused }));
    const text = textOf(await generate());
    expect(text).toContain("content grounds");
    expect(text).not.toContain("Docs for this Model's provider_options");
  });

  test("an image whose shape differs from the request is reported, and its options are not Known-good", async () => {
    harness = await startHarness(togetherSetup({ [imagesUrl]: imageOfSize(1024, 1024) }));
    const result = await generate({ provider_options: { width: 1024, height: 576 } });
    const output = ok(result);
    expect(output.mismatch).toBe("asked for 1024x576, got 1024x1024");
    expect(textOf(result)).toContain("does not match the request");
    expect(textOf(result)).toContain("https://docs.together.ai/docs/inference/images/parameters");

    const listed = ok(await call("list_models", { model: "sdxl" }));
    expect(listed.models[0].known_good_options).toEqual({});
  });

  test("a result is checked against the asked aspect ratio, within rounding to the Model's grid", async () => {
    // FLUX.1 Kontext answers 16:9 with 1392x752, which is 16:9 within 5%.
    harness = await startHarness(togetherSetup({ [imagesUrl]: imageOfSize(1392, 752) }));
    const output = ok(await generate({ model: "kontext", provider_options: { aspect_ratio: "16:9", steps: 30 } }));
    expect(output.mismatch).toBeUndefined();
    const listed = ok(await call("list_models", { model: "kontext" }));
    expect(listed.models[0].known_good_options).toEqual({ aspect_ratio: "16:9", steps: 30 });
  });
});

describe("Known-good Options and Ratings", () => {
  test("only a good Rating clears the User's bad Rating, whatever matching or mismatched Jobs send in between", async () => {
    let size = [1024, 576];
    harness = await startHarness(togetherSetup({ [imagesUrl]: (request) => imageOfSize(size[0]!, size[1]!)(request) }));
    const rated = ok(await generate({ provider_options: { width: 1024, height: 576, steps: 30, style: "a" } }));
    ok(await call("rate_job", { job_id: rated.job_id, verdict: "bad", reason: "muddy colours" }));
    size = [1024, 1024];
    ok(await generate({ provider_options: { width: 1024, height: 576, steps: 30 } }));
    size = [1024, 576];
    ok(await generate({ provider_options: { width: 1024, height: 576, steps: 30, style: "b" } }));
    ok(await generate({ provider_options: { width: 1024, height: 576, style: "a" } }));

    const sdxl = ok(await call("list_models", { model: "sdxl" })).models[0];
    expect(sdxl.known_good_options).toEqual({});
    const bad = { reason: "muddy colours", job_id: rated.job_id, cause: "rating" };
    expect(sdxl.suspect_options).toEqual({
      width: { value: 1024, ...bad },
      height: { value: 576, ...bad },
      steps: { value: 30, ...bad },
      style: { value: "a", ...bad },
    });
  });

  test("a result that does not match its request makes Known-good Options it sent suspect, until a matching result sends them again", async () => {
    let size = [1024, 576];
    harness = await startHarness(togetherSetup({ [imagesUrl]: (request) => imageOfSize(size[0]!, size[1]!)(request) }));
    ok(await generate({ provider_options: { width: 1024, height: 576, steps: 30 } }));
    size = [1024, 1024];
    const wrong = ok(await generate({ provider_options: { width: 1024, height: 576, steps: 30 } }));

    let listed = await call("list_models", { model: "sdxl" });
    let sdxl = ok(listed).models[0];
    expect(sdxl.known_good_options).toEqual({});
    expect(sdxl.suspect_options.steps).toMatchObject({ value: 30, job_id: wrong.job_id, cause: "mismatch" });
    expect(textOf(listed)).toContain("whose result did not match the request: asked for 1024x576, got 1024x1024");

    size = [1024, 576];
    ok(await generate({ provider_options: { width: 1024, height: 576, steps: 30 } }));
    sdxl = ok(await call("list_models", { model: "sdxl" })).models[0];
    expect(sdxl.known_good_options).toEqual({ width: 1024, height: 576, steps: 30 });
    expect(sdxl.suspect_options).toEqual({});
  });

  test("a bad Rating makes the options it used suspect, with the User's reason, until a good Rating sends them again", async () => {
    harness = await startHarness(togetherSetup());
    const first = ok(await generate({ provider_options: { steps: 4, seed: 1 } }));
    ok(await call("rate_job", { job_id: first.job_id, verdict: "bad", reason: "far too blurry" }));

    let listed = await call("list_models", {});
    let sdxl = ok(listed).models.find((model: { alias: string }) => model.alias === "sdxl");
    expect(sdxl.known_good_options).toEqual({});
    expect(sdxl.suspect_options).toEqual({
      steps: { value: 4, reason: "far too blurry", job_id: first.job_id, cause: "rating" },
      seed: { value: 1, reason: "far too blurry", job_id: first.job_id, cause: "rating" },
    });
    expect(textOf(listed)).toContain("Suspect options: steps, seed.");

    // Sending the same value again without a Rating does not clear it; a different value counts.
    ok(await generate({ provider_options: { steps: 4, seed: 2 } }));
    listed = await call("list_models", { model: "sdxl" });
    sdxl = ok(listed).models[0];
    expect(sdxl.known_good_options).toEqual({ seed: 2 });
    expect(Object.keys(sdxl.suspect_options)).toEqual(["steps"]);
    expect(textOf(listed)).toContain('which the User rated bad: "far too blurry"');

    const third = ok(await generate({ provider_options: { steps: 4 } }));
    ok(await call("rate_job", { job_id: third.job_id, verdict: "good", reason: "sharp now" }));
    sdxl = ok(await call("list_models", { model: "sdxl" })).models[0];
    expect(sdxl.known_good_options).toEqual({ seed: 2, steps: 4 });
    expect(sdxl.suspect_options).toEqual({});
  });
});

describe("generate_video with the together Protocol", () => {
  test("submits Wan 2.7 with no shape, tier or length of litevision's own, polls until it completes, and saves the MP4", async () => {
    let polls = 0;
    const status: Route = (request) => (++polls < 3 ? recorded("together/video-submitted.json")(request) : recorded("together/video-completed.json")(request));
    harness = await startHarness(togetherSetup({ [videoStatusUrl]: status }));
    const result = await video();
    const output = ok(result);

    expect(await bodyOf(videosUrl)).toEqual({
      model: "Wan-AI/wan2.7-t2v",
      prompt: "a fox runs through snow",
    });
    expect(polls).toBe(3);
    expect(output).toMatchObject({
      status: "completed",
      model: "wan",
      requested_shape: null,
      requested_duration: null,
      observed: [{ width: 1920, height: 1080, seconds: 5 }],
    });
    expect(output.files[0]).toEndWith(".mp4");
    expect(textOf(result)).toContain("Got 1920x1080, 5 s.");
    expect((await readHistory(harness))[0]).toMatchObject({
      modality: "video",
      outcome: "completed",
      parameters: { n: 1, requestedShape: null, requestedSeconds: null },
    });
  });

  test("sends the length and resolution tier as given, neither rounded nor checked (ADR 0010)", async () => {
    harness = await startHarness(togetherSetup({ [videoFileUrl]: mp4Response(1280, 720, 20) }));
    const output = ok(await video({ provider_options: { seconds: "20", resolution: "720p" } }));
    expect(await bodyOf(videosUrl)).toMatchObject({ seconds: "20", resolution: "720p" });
    expect(output).toMatchObject({ requested_duration: 20 });
    expect(output.mismatch).toBeUndefined();
  });


  test("a video model litevision has no guide for takes Together's generic fields in provider_options", async () => {
    harness = await startHarness(togetherSetup({ [videoFileUrl]: mp4Response(720, 1280, 6) }));
    const output = ok(await video({ model: "veo", provider_options: { width: 720, height: 1280, seconds: "6", generate_audio: true } }));
    expect(await bodyOf(videosUrl)).toEqual({
      model: "google/veo-3.1",
      prompt: "a fox runs through snow",
      seconds: "6",
      width: 720,
      height: 1280,
      generate_audio: true,
    });
    expect(output).toMatchObject({ requested_shape: "720x1280", requested_duration: 6 });
    expect(output.mismatch).toBeUndefined();
  });

  test("sends first and last frames as data URLs in media.frame_images", async () => {
    harness = await startHarness(togetherSetup());
    const frame = await referenceImage("start.png");
    ok(await video({ model: "wan-i2v", first_frame: frame, last_frame: frame }));
    expect((await bodyOf(videosUrl)).media).toEqual({
      frame_images: [
        { input_image: tinyPngDataUrl, frame: "first" },
        { input_image: tinyPngDataUrl, frame: "last" },
      ],
    });
  });

  test("a status check Together's gateway failed is retried without submitting the video again", async () => {
    let calls = 0;
    const flaky: Route = (request) =>
      calls++ === 0 ? new Response("upstream connect error", { status: 504 }) : recorded("together/video-completed.json")(request);
    harness = await startHarness(togetherSetup({ [videoStatusUrl]: flaky }));
    ok(await video());

    const sentTo = (url: string) => harness!.requests.filter((request) => `${request.method} ${request.url}` === url);
    expect(sentTo(videosUrl)).toHaveLength(1);
    expect(sentTo(videoStatusUrl)).toHaveLength(2);
  });

  test("a frame the old tables said the Model cannot take is sent anyway, for Together to decide (ADR 0010)", async () => {
    harness = await startHarness(togetherSetup());
    ok(await video({ first_frame: await referenceImage() }));
    expect((await bodyOf(videosUrl)).media).toEqual({ frame_images: [{ input_image: tinyPngDataUrl, frame: "first" }] });
  });

  test("a failed video says why, with the docs link", async () => {
    harness = await startHarness(togetherSetup({ [videoStatusUrl]: recorded("together/video-failed.json") }));
    const result = await video();
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("invalidDuration: seconds must be between 2 and 15");
    expect(text).toContain("https://docs.together.ai/docs/wan2.7-quickstart");
    expect((await readHistory(harness))[0]).toMatchObject({ outcome: "failed", error: { kind: "unsupported" } });

    // A video often outlasts generate_video's wait, so its failure may first reach the Agent through get_job.
    const jobId = /Job (\S+) failed/.exec(text)![1];
    const again = textOf(await call("get_job", { job_id: jobId }));
    expect(again).toContain("invalidDuration");
    expect(again).toContain("https://docs.together.ai/docs/wan2.7-quickstart");
    expect(again).toContain("Known-good Options:");
  });

  test("a Model that takes no shape is not checked for one", async () => {
    harness = await startHarness(togetherSetup({ [videoFileUrl]: mp4Response(1280, 720, 5) }));
    const frame = join(harness.cwd, "landscape.png");
    await writeFile(frame, pngOfSize(1280, 720));
    const output = ok(await video({ model: "seedance", first_frame: frame }));
    expect(output.requested_shape).toBeNull();
    expect(output.mismatch).toBeUndefined();
  });

  test("a video's shape is checked against width and height set in provider_options", async () => {
    harness = await startHarness(togetherSetup({ [videoFileUrl]: mp4Response(720, 1280, 5) }));
    const output = ok(await video({ model: "veo", provider_options: { width: 720, height: 1280 } }));
    expect((await bodyOf(videosUrl))).toMatchObject({ width: 720, height: 1280 });
    expect(output.mismatch).toBeUndefined();
  });

  test("without an aspect ratio, a video from a first frame is sent no shape and its shape is not checked", async () => {
    harness = await startHarness(togetherSetup({ [videoFileUrl]: mp4Response(720, 1280, 5) }));
    const frame = join(harness.cwd, "portrait.png");
    await writeFile(frame, pngOfSize(720, 1280));
    const output = ok(await video({ model: "wan-i2v", first_frame: frame }));
    expect(await bodyOf(videosUrl)).not.toHaveProperty("ratio");
    expect(output.requested_shape).toBeNull();
    expect(output.mismatch).toBeUndefined();
  });

  test("a rejected Credential on the video API, which answers in plain text, is an auth error", async () => {
    harness = await startHarness(togetherSetup({ [videosUrl]: () => new Response("invalid api key\n", { status: 401 }) }));
    const result = await video();
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("invalid api key");
    expect(textOf(result)).toContain("open_settings");
  });

  test("a video still running at the wait limit is picked up again after a restart", async () => {
    let done = false;
    const status: Route = (request) => recorded(done ? "together/video-completed.json" : "together/video-submitted.json")(request);
    harness = await startHarness({ ...togetherSetup({ [videoStatusUrl]: status }), waitLimitMs: 30 });
    const started = ok(await video());
    expect(started.status).toBe("running");
    expect((await readHistory(harness))[0]).toMatchObject({ outcome: "running", resume: { videoId } });

    await harness.restart();
    done = true;
    const finished = ok(await call("get_job", { job_id: started.job_id }));
    expect(finished).toMatchObject({ status: "completed", observed: [{ width: 1920, height: 1080, seconds: 5 }] });
    expect(finished.files[0]).toEndWith(".mp4");
  });

  test("a video shorter than requested is reported as a mismatch", async () => {
    harness = await startHarness(togetherSetup({ [videoFileUrl]: mp4Response(1920, 1080, 2) }));
    const output = ok(await video({ provider_options: { seconds: "5" } }));
    expect(output.mismatch).toBe("asked for 5 s, got 2 s");
  });
});

describe("Modality", () => {
  test("generate_image refuses a video Model and generate_video an image Model, each naming the other tool", async () => {
    harness = await startHarness(togetherSetup());
    const image = await generate({ model: "wan" });
    expect(image.isError).toBe(true);
    expect(textOf(image)).toContain("generate_video");
    const clip = await video({ model: "sdxl" });
    expect(clip.isError).toBe(true);
    expect(textOf(clip)).toContain("generate_image");
    expect(harness.requests).toHaveLength(0);
  });

  test("list_models gives each Model's Modality, Parameter Guide summary and both defaults", async () => {
    harness = await startHarness(togetherSetup());
    const result = await call("list_models", {});
    const listed = ok(result);
    expect(listed.default_model).toBe("sdxl");
    expect(listed.default_video_model).toBe("wan");
    const wan = listed.models.find((model: { alias: string }) => model.alias === "wan");
    expect(wan).toMatchObject({
      modality: "video",
      default: true,
      docs_url: "https://docs.together.ai/docs/wan2.7-quickstart",
    });
    expect(wan.parameters).toContain("resolution, ratio, seconds");
    expect(wan).not.toHaveProperty("video_capabilities");
    expect(textOf(result)).toContain("wan (default video): video Model Wan-AI/wan2.7-t2v");
  });

  test("a default video Model that makes images sends the User to the settings page", async () => {
    harness = await startHarness({
      ...togetherSetup(),
      config: {
        providers: [{ id: "together-ai", baseUrl: root }],
        models: [
          { alias: "sdxl", provider: "together-ai", modelId: "stabilityai/stable-diffusion-xl-base-1.0", protocol: "together" },
          { alias: "wan", provider: "together-ai", modelId: "Wan-AI/wan2.7-t2v", protocol: "together", modality: "video" },
        ],
        defaultVideoModel: "sdxl",
      },
    });
    const text = textOf(await video());
    expect(text).toContain("open_settings");
    expect(text).toContain("wan");
  });

  test("with no video Model configured, generate_video sends the User to the settings page", async () => {
    harness = await startHarness({
      ...togetherSetup(),
      config: {
        providers: [{ id: "together-ai", baseUrl: root }],
        models: [{ alias: "sdxl", provider: "together-ai", modelId: "stabilityai/stable-diffusion-xl-base-1.0", protocol: "together" }],
      },
    });
    const result = await video();
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("no video Model configured");
    expect(textOf(result)).toContain("open_settings");

    const named = await video({ model: "nope" });
    expect(textOf(named)).toContain("no video Model configured");
    expect(textOf(named)).not.toContain("sdxl");
  });
});

describe("the settings page with a Together Provider", () => {
  const saved = { config: { providers: [{ id: "together-ai", baseUrl: root }] }, credentials: { "together-ai": { apiKey } } };

  test("lists only image and video model ids, with the Modality of each", async () => {
    settings = await startSettingsHarness({ ...saved, routes: { [`GET ${root}/v1/models`]: fixture("together/models.json") } });
    const response = await settings.send("POST", "/api/providers/together-ai/model-ids", { body: { protocol: "together" } });
    expect(response.json()).toEqual({
      result: "success",
      modelIds: ["ByteDance/Seedance-2.5", "Wan-AI/wan2.7-t2v", "black-forest-labs/FLUX.2-pro", "stabilityai/stable-diffusion-xl-base-1.0"],
      modalities: {
        "black-forest-labs/FLUX.2-pro": "image",
        "stabilityai/stable-diffusion-xl-base-1.0": "image",
        "Wan-AI/wan2.7-t2v": "video",
        "ByteDance/Seedance-2.5": "video",
      },
    });
  });

  test("test connection counts image and video models and never shows the Credential", async () => {
    settings = await startSettingsHarness({ ...saved, routes: { [`GET ${root}/v1/models`]: fixture("together/models.json") } });
    const response = await settings.send("POST", "/api/providers/together-ai/test-connection", { body: { protocol: "together" } });
    expect(response.json()).toEqual({ result: "success", message: 'Connected to Provider "together-ai". It offers 2 image and 2 video model id(s).' });
    expect(settings.requests[0]!.headers.get("authorization")).toBe(`Bearer ${apiKey}`);
  });

  test("a video Model is added with its Modality and can be the default video Model, but not the default image Model", async () => {
    settings = await startSettingsHarness(saved);
    const wan = { alias: "wan", provider: "together-ai", modelId: "Wan-AI/wan2.7-t2v", protocol: "together", modality: "video" };
    expect((await settings.send("POST", "/api/models", { body: wan })).status).toBe(201);
    expect((await settings.send("PUT", "/api/default-image-model", { body: { alias: "wan" } })).status).toBe(400);
    expect((await settings.send("PUT", "/api/default-video-model", { body: { alias: "wan" } })).json()).toEqual({ defaultVideoModel: "wan" });
    expect((await settings.send("GET", "/api/models")).json()).toMatchObject({
      models: [{ ...wan, default: true }],
      defaultImageModel: null,
      defaultVideoModel: "wan",
    });
  });
});
