import { afterEach, describe, expect, test } from "bun:test";
import { copyFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { startHarness, type Harness, type Route } from "./harness.ts";
import { mp4Of, pngOfSize, recorded, textOf } from "./helpers.ts";

/** Source Jobs (GLOSSARY.md): the earlier Jobs whose results are among a Job's reference images, found by content hash. */

const openaiBase = "https://api.openai.com/v1";

/** An OpenAI image answer whose PNG differs on every call, so each Job's result has its own content. */
function distinctImages(): Route {
  let calls = 0;
  return async () => {
    calls += 1;
    const image = pngOfSize(100 + calls, 100 + calls).toString("base64");
    return Response.json({ created: 1761814800, data: [{ b64_json: image }] });
  };
}

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function start() {
  const images = distinctImages();
  harness = await startHarness({
    config: {
      providers: [{ id: "openai", baseUrl: openaiBase }],
      models: [{ alias: "gpt-image", provider: "openai", modelId: "gpt-image-1", protocol: "openai-images" }],
      defaultImageModel: "gpt-image",
    },
    credentials: { openai: { apiKey: "sk-test-0000secret0000" } },
    routes: { [`POST ${openaiBase}/images/generations`]: images, [`POST ${openaiBase}/images/edits`]: images },
  });
  return harness;
}

interface SourceJobOutput {
  job_id: string;
  result: number;
  model: string;
  file: string;
  deleted: boolean;
  reference: string;
}

interface JobOutput {
  job_id: string;
  files: string[];
  source_jobs?: SourceJobOutput[];
}

async function generate(args: Record<string, unknown>): Promise<JobOutput> {
  const result = await harness!.client.callTool({ name: "generate_image", arguments: args });
  expect(result.isError).toBeFalsy();
  return result.structuredContent as unknown as JobOutput;
}

async function getJob(jobId: string) {
  const result = await harness!.client.callTool({ name: "get_job", arguments: { job_id: jobId } });
  expect(result.isError).toBeFalsy();
  return { output: result.structuredContent as unknown as JobOutput, text: textOf(result) };
}

describe("Source Jobs", () => {
  test("a Job whose reference is an earlier output, copied elsewhere, lists that Job as its Source Job", async () => {
    const { cwd } = await start();
    const first = await generate({ prompt: "a red fox" });
    const copy = join(cwd, "fox-copy.png");
    await copyFile(first.files[0]!, copy);

    const second = await generate({ prompt: "darken the fur", references: [copy], name: "darker" });
    const { output, text } = await getJob(second.job_id);

    expect(output.source_jobs).toEqual([
      { job_id: first.job_id, result: 1, model: "gpt-image", file: first.files[0]!, deleted: false, reference: copy },
    ]);
    expect(text).toContain(`Source Jobs: Job ${first.job_id}, result 1 on gpt-image (${first.files[0]!}).`);
  });

  test("an earlier output deleted by the User still makes a copy of it find its Job, and is reported as deleted", async () => {
    const { cwd } = await start();
    const first = await generate({ prompt: "a red fox" });
    const copy = join(cwd, "fox-copy.png");
    await copyFile(first.files[0]!, copy);
    await rm(first.files[0]!);

    const second = await generate({ prompt: "darken the fur", references: [copy], name: "darker" });
    const { output, text } = await getJob(second.job_id);

    expect(output.source_jobs).toMatchObject([{ job_id: first.job_id, file: first.files[0]!, deleted: true }]);
    expect(text).toContain(`(${first.files[0]!}, deleted)`);
    expect((await getJob(first.job_id)).output.files).toEqual(first.files);
  });

  test("a Job whose reference images were deleted after it started still shows its Source Jobs", async () => {
    const { cwd } = await start();
    const first = await generate({ prompt: "a red fox" });
    const copy = join(cwd, "fox-copy.png");
    await copyFile(first.files[0]!, copy);
    const second = await generate({ prompt: "darken the fur", references: [copy], name: "darker" });
    await rm(copy);
    await rm(first.files[0]!);

    expect((await getJob(second.job_id)).output.source_jobs).toMatchObject([{ job_id: first.job_id, deleted: true, reference: copy }]);
  });

  test("a reference no earlier Job saved, or that only resembles one, gives no Source Jobs", async () => {
    const { cwd } = await start();
    await generate({ prompt: "a red fox" });
    const unrelated = join(cwd, "photo.png");
    await Bun.write(unrelated, pngOfSize(101, 102));

    const second = await generate({ prompt: "darken the fur", references: [unrelated] });
    const { output, text } = await getJob(second.job_id);

    expect(output).not.toHaveProperty("source_jobs");
    expect(text).not.toContain("Source Job");
  });

  test("lists each Source Job once, in the order of the references, with several Source Jobs from several references", async () => {
    await start();
    const fox = await generate({ prompt: "a red fox" });
    const owl = await generate({ prompt: "an owl" });

    const both = await generate({ prompt: "the fox and the owl together", references: [owl.files[0]!, fox.files[0]!, owl.files[0]!] });

    expect((await getJob(both.job_id)).output.source_jobs).toMatchObject([
      { job_id: owl.job_id, reference: owl.files[0]! },
      { job_id: fox.job_id, reference: fox.files[0]! },
    ]);
  });
});

describe("list_models with `model`: Ratings show their Job's Source Jobs", () => {
  async function rate(args: Record<string, unknown>) {
    const result = await harness!.client.callTool({ name: "rate_job", arguments: args });
    expect(result.isError).toBeFalsy();
  }

  test("so a chain of edits can be read, even once the earlier outputs are deleted", async () => {
    await start();
    const fox = await generate({ prompt: "a red fox", name: "fox" });
    await rate({ job_id: fox.job_id, verdict: "bad", reason: "the hair looks unnatural" });
    const fixed = await generate({ prompt: "fix the hair", references: [fox.files[0]!], name: "fixed" });
    await rate({ job_id: fixed.job_id, verdict: "good", reason: "the hair is right now" });
    await rm(fox.files[0]!);

    const result = await harness!.client.callTool({ name: "list_models", arguments: { model: "gpt-image" } });

    expect(result.isError).toBeFalsy();
    const ratings = (result.structuredContent as { models: Array<{ recent_ratings: Array<Record<string, unknown>> }> }).models[0]!.recent_ratings;
    expect(ratings).toMatchObject([
      {
        job_id: fixed.job_id,
        verdict: "good",
        source_jobs: [{ job_id: fox.job_id, result: 1, model: "gpt-image", file: fox.files[0]!, deleted: true, reference: fox.files[0]! }],
      },
      { job_id: fox.job_id, verdict: "bad" },
    ]);
    expect(ratings[1]).not.toHaveProperty("source_jobs");
    expect(textOf(result)).toContain(`good on Job ${fixed.job_id} ("fix the hair") [Source Jobs: Job ${fox.job_id}, result 1 on gpt-image (${fox.files[0]!}, deleted)]: the hair is right now`);
  });
});

describe("a video Job's frames", () => {
  test("count as reference images: a video started from an earlier image lists that image's Job", async () => {
    const together = "https://api.together.ai";
    const videoId = "01a1a5f7-aab2-741e-af5a-38d3d6b4e040";
    const images = distinctImages();
    harness = await startHarness({
      config: {
        providers: [
          { id: "openai", baseUrl: openaiBase },
          { id: "together-ai", baseUrl: `${together}/v1` },
        ],
        models: [
          { alias: "gpt-image", provider: "openai", modelId: "gpt-image-1", protocol: "openai-images" },
          { alias: "wan", provider: "together-ai", modelId: "Wan-AI/wan2.7-i2v", protocol: "together", modality: "video" },
        ],
        defaultImageModel: "gpt-image",
        defaultVideoModel: "wan",
      },
      credentials: { openai: { apiKey: "sk-test-0000secret0000" }, "together-ai": { apiKey: "together-test-0000secret0000" } },
      routes: {
        [`POST ${openaiBase}/images/generations`]: images,
        [`POST ${together}/v2/videos`]: recorded("together/video-submitted.json"),
        [`GET ${together}/v2/videos/${videoId}`]: recorded("together/video-completed.json"),
        "GET https://api.together.ai/shrt/example0000": () => new Response(mp4Of(1920, 1080, 5), { headers: { "content-type": "video/mp4" } }),
      },
      pollIntervalMs: 1,
    });
    const still = await generate({ prompt: "a red fox", name: "fox" });

    const result = await harness.client.callTool({ name: "generate_video", arguments: { prompt: "the fox runs", first_frame: still.files[0]! } });
    expect(result.isError).toBeFalsy();
    const { job_id } = result.structuredContent as unknown as JobOutput;

    expect((await getJob(job_id)).output.source_jobs).toMatchObject([{ job_id: still.job_id, model: "gpt-image", reference: still.files[0]! }]);
  });
});
