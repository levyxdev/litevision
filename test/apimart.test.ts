import { afterEach, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startHarness, type Harness, type HarnessOptions, type Route } from "./harness.ts";
import { readHistory, readHistoryLines, recorded, textOf, tinyPng } from "./helpers.ts";

const apiKey = "sk-apimart-0000secret0000";
const base = "https://api.apimart.ai/v1";
const submitUrl = `POST ${base}/images/generations`;
const taskId = "task_01KPQ7J7DWB7QZ3WCEK3YVPBRA";
const taskUrl = (id = taskId) => `GET ${base}/tasks/${id}?language=en`;
const imageUrl = "https://upload.apimart.ai/f/image/9998236911693428-e8d7441f-image_task_01KPQ7J7DWB7QZ3WCEK3YVPBRA_0.png";
const schemaUrl = (modelId: string) => `GET ${base}/models/${modelId}/schema`;

const png: Route = () => new Response(tinyPng, { headers: { "content-type": "image/png" } });

/** Answers with each fixture in turn, then keeps answering with the last one. */
function sequence(...names: string[]): Route {
  let next = 0;
  return (request) => recorded(names[Math.min(next++, names.length - 1)]!)(request);
}

/** A task-status route that says "processing" until `release` is called, then answers with `fixture`. */
function gate(fixture = "apimart/task-completed.json") {
  let open = false;
  const route: Route = (request) => recorded(open ? fixture : "apimart/task-processing.json")(request);
  return { route, release: () => (open = true) };
}

/** One APIMart Provider with one `apimart` Model, aliased `gpt2` and set as the default. */
function apimartSetup(routes: HarnessOptions["routes"] = {}, modelId = "gpt-image-2"): HarnessOptions {
  return {
    config: {
      providers: [{ id: "apimart", baseUrl: base }],
      models: [{ alias: "gpt2", provider: "apimart", modelId, protocol: "apimart" }],
      defaultImageModel: "gpt2",
    },
    credentials: { apimart: { apiKey } },
    routes: {
      [submitUrl]: recorded("apimart/submitted.json"),
      [taskUrl()]: sequence("apimart/task-pending.json", "apimart/task-processing.json", "apimart/task-completed.json"),
      [`GET ${imageUrl}`]: png,
      ...routes,
    },
    now: () => new Date(2026, 9, 30, 14, 5, 0),
    pollIntervalMs: 1,
  };
}

interface GenerateResult {
  job_id: string;
  status: "completed" | "running";
  model: string;
  files: string[];
  shortfall?: string;
}

const submits = (harness: Harness) => harness.requests.filter((request) => `${request.method} ${request.url}` === submitUrl);
const polls = (harness: Harness, id = taskId) => harness.requests.filter((request) => `${request.method} ${request.url}` === taskUrl(id));
const generate = (harness: Harness, args: Record<string, unknown> = {}) =>
  harness.client.callTool({ name: "generate_image", arguments: { prompt: "a red fox", ...args } });
const getJob = (harness: Harness, jobId: string) => harness.client.callTool({ name: "get_job", arguments: { job_id: jobId } });

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe("apimart Protocol", () => {
  test("submits a task, polls it until it completes, and saves the image straight away", async () => {
    harness = await startHarness(apimartSetup());
    const result = await generate(harness);

    expect(result.isError).toBeFalsy();
    const output = result.structuredContent as unknown as GenerateResult;
    expect(output.status).toBe("completed");
    expect(output.files).toHaveLength(1);
    expect(output.files[0]!.startsWith(join(harness.dirs.output, "2026-10-30"))).toBe(true);
    expect(await readFile(output.files[0]!)).toEqual(tinyPng);

    const [submit] = submits(harness);
    expect(submit!.headers.get("authorization")).toBe(`Bearer ${apiKey}`);
    expect(await submit!.json()).toEqual({ model: "gpt-image-2", prompt: "a red fox", size: "1:1", n: 1 });
    expect(polls(harness)).toHaveLength(3);
    expect(polls(harness)[0]!.headers.get("authorization")).toBe(`Bearer ${apiKey}`);
  });

  test("records the task id as soon as it is submitted, then the outcome and the cost", async () => {
    harness = await startHarness(apimartSetup());
    const output = (await generate(harness)).structuredContent as unknown as GenerateResult;

    const lines = await readHistoryLines(harness);
    expect(lines.map((line) => line.outcome)).toEqual(["running", "running", "completed"]);
    expect(lines[1]).toMatchObject({ id: output.job_id, outcome: "running", resume: { taskIds: [taskId] } });
    expect(lines[2]).toMatchObject({ id: output.job_id, outcome: "completed", files: output.files, cost: 0.15 });
    expect(JSON.stringify(lines)).not.toContain(apiKey);
  });

  test("sends reference images as data URIs", async () => {
    harness = await startHarness(apimartSetup());
    await writeFile(join(harness.cwd, "fox.png"), tinyPng);
    const result = await generate(harness, { references: ["fox.png"], aspect_ratio: "16:9" });

    expect(result.isError).toBeFalsy();
    expect(await submits(harness)[0]!.json()).toEqual({
      model: "gpt-image-2",
      prompt: "a red fox",
      size: "16:9",
      n: 1,
      image_urls: [`data:image/png;base64,${tinyPng.toString("base64")}`],
    });
  });

  test("passes provider_options through untouched", async () => {
    harness = await startHarness(apimartSetup());
    await generate(harness, { provider_options: { resolution: "2k", official_fallback: true } });
    expect(await submits(harness)[0]!.json()).toMatchObject({ resolution: "2k", official_fallback: true });
  });

  test("rejects provider_options that set a field litevision sets itself", async () => {
    harness = await startHarness(apimartSetup());
    const result = await generate(harness, { provider_options: { image_urls: ["https://example.com/fox.png"] } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("`image_urls`");
    expect(submits(harness)).toHaveLength(0);
  });

  test("submits one task per image for a Model that makes one image per task", async () => {
    let submitted = 0;
    const secondTask = "task_01KPQ7J7DWB7QZ3WCEK3YVPBRB";
    const secondImage = imageUrl.replace("_0.png", "_1.png");
    harness = await startHarness(
      apimartSetup({
        [submitUrl]: () =>
          Response.json({ code: 200, data: [{ status: "submitted", task_id: submitted++ === 0 ? taskId : secondTask }] }),
        [taskUrl(secondTask)]: async (request) => {
          const body: any = await (await recorded("apimart/task-completed.json")(request)).json();
          body.data.id = secondTask;
          body.data.result.images[0].url = [secondImage];
          return Response.json(body);
        },
        [`GET ${secondImage}`]: png,
      }),
    );
    const result = await generate(harness, { n: 2 });

    const output = result.structuredContent as unknown as GenerateResult;
    expect(output.files).toHaveLength(2);
    expect(new Set(output.files).size).toBe(2);
    const bodies = await Promise.all(submits(harness).map((request) => request.json()));
    expect(bodies).toEqual([expect.objectContaining({ n: 1 }), expect.objectContaining({ n: 1 })]);
    expect((await readHistoryLines(harness))[1]).toMatchObject({ resume: { taskIds: [taskId, secondTask] } });
  });

  test("asks for several images in one task on a Model that makes several", async () => {
    const urls = [1, 2, 3].map((index) => imageUrl.replace("_0.png", `_${index}.png`));
    harness = await startHarness(
      apimartSetup(
        {
          [taskUrl()]: async (request) => {
            const body: any = await (await recorded("apimart/task-completed.json")(request)).json();
            body.data.result.images = [{ url: urls.slice(0, 2) }, { url: urls.slice(2) }];
            return Response.json(body);
          },
          ...Object.fromEntries(urls.map((url) => [`GET ${url}`, png])),
        },
        "gpt-image-1.5",
      ),
    );
    const result = await generate(harness, { n: 3 });

    expect((result.structuredContent as unknown as GenerateResult).files).toHaveLength(3);
    expect(submits(harness)).toHaveLength(1);
    expect(await submits(harness)[0]!.json()).toMatchObject({ model: "gpt-image-1.5", n: 3 });
  });

  test("keeps the images that arrived when one of several tasks fails", async () => {
    let submitted = 0;
    const secondTask = "task_01KPQ7J7DWB7QZ3WCEK3YVPBRB";
    harness = await startHarness(
      apimartSetup({
        [submitUrl]: () =>
          Response.json({ code: 200, data: [{ status: "submitted", task_id: submitted++ === 0 ? taskId : secondTask }] }),
        [taskUrl(secondTask)]: recorded("apimart/task-failed-moderation.json"),
      }),
    );
    const result = await generate(harness, { n: 2 });

    expect(result.isError).toBeFalsy();
    const output = result.structuredContent as unknown as GenerateResult;
    expect(output.files).toHaveLength(1);
    expect(output.shortfall).toContain("Got 1 of 2 images");
    expect(output.shortfall).toContain("content moderation");
  });

  test.each([
    ["failed on content grounds", "apimart/task-failed-moderation.json", "refusal", "content moderation"],
    ["cancelled", "apimart/task-cancelled.json", "other", "cancelled"],
  ])("maps a task that %s to a typed error", async (_, fixture, kind, wording) => {
    harness = await startHarness(apimartSetup({ [taskUrl()]: sequence("apimart/task-processing.json", fixture) }));
    const result = await generate(harness);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Provider "apimart"');
    expect(textOf(result)).toContain(wording);
    expect((await readHistory(harness))[0]).toMatchObject({ outcome: "failed", files: [], error: { kind } });
  });

  test.each([
    ["auth", "apimart/invalid-api-key.json", 401],
    ["balance", "apimart/insufficient-balance.json", 402],
    ["rate_limit", "apimart/rate-limit.json", 429],
  ])("maps a submission rejected as %s to that typed error", async (kind, fixture, status) => {
    harness = await startHarness(apimartSetup({ [submitUrl]: recorded(fixture, status) }));
    const result = await generate(harness);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Provider "apimart"');
    expect((await readHistory(harness))[0]).toMatchObject({ outcome: "failed", error: { kind } });
    expect(polls(harness)).toHaveLength(0);
  });

  test("keeps polling through a brief outage of the task-status endpoint", async () => {
    let calls = 0;
    harness = await startHarness(
      apimartSetup({
        [taskUrl()]: (request) =>
          calls++ === 0
            ? Response.json({ error: { code: 502, message: "Bad gateway", type: "bad_gateway" } }, { status: 502 })
            : recorded("apimart/task-completed.json")(request),
      }),
    );
    const result = await generate(harness);
    expect(result.isError).toBeFalsy();
    expect(polls(harness)).toHaveLength(2);
  });
});

describe("apimart capabilities", () => {
  test("come live from the Model's schema, with its parameter schema for provider_options", async () => {
    harness = await startHarness(apimartSetup({ [schemaUrl("gpt-image-2")]: recorded("apimart/schema-gpt-image-2.json") }));
    const result = await harness.client.callTool({ name: "list_models", arguments: { model: "gpt2" } });

    const [model] = (result.structuredContent as { models: any[] }).models;
    expect(model.capabilities.aspect_ratios.map((ratio: { aspect_ratio: string }) => ratio.aspect_ratio).sort()).toEqual(
      ["16:9", "1:1", "2:3", "3:2", "3:4", "4:3", "9:16"].sort(),
    );
    expect(model.capabilities.max_reference_images).toBe(15);
    expect(model.capabilities.max_images_per_job).toBe(4);
    expect(model.parameter_schema.properties.resolution.enum).toEqual(["1k", "2k", "4k"]);
    expect(model.docs_url).toBe("https://docs.apimart.ai/en/api-reference/images/gpt-image-2/generation");
    const [schemaRequest] = harness.requests;
    expect(schemaRequest!.headers.get("authorization")).toBe(`Bearer ${apiKey}`);
  });

  test("fall back to the built-in table when the schema cannot be fetched", async () => {
    harness = await startHarness(
      apimartSetup({ [schemaUrl("seedream-4.5")]: recorded("apimart/invalid-api-key.json", 404) }, "seedream-4.5"),
    );
    const result = await harness.client.callTool({ name: "list_models", arguments: {} });

    const [model] = (result.structuredContent as { models: any[] }).models;
    expect(model.capabilities.aspect_ratios).toContainEqual({ aspect_ratio: "1:1", size: "2048x2048" });
    expect(model.capabilities.aspect_ratios).toContainEqual({ aspect_ratio: "16:9", size: "2560x1440" });
    expect(model.capabilities.max_reference_images).toBe(14);
    expect(model.docs_url).toBe("https://docs.apimart.ai/en/api-reference/images/seedream-4.5/generation");
  });
});

describe("asynchronous Jobs", () => {
  const slow = (task: ReturnType<typeof gate>, routes: HarnessOptions["routes"] = {}): HarnessOptions => ({
    ...apimartSetup({ [taskUrl()]: task.route, ...routes }),
    waitLimitMs: 40,
  });

  test("past the wait limit, generate_image returns the Job id and get_job later returns the files", async () => {
    const task = gate();
    harness = await startHarness(slow(task));
    const result = await generate(harness);

    expect(result.isError).toBeFalsy();
    const output = result.structuredContent as unknown as GenerateResult;
    expect(output).toMatchObject({ status: "running", model: "gpt2", files: [] });
    expect(textOf(result)).toContain("get_job");
    expect(textOf(result)).toContain(output.job_id);
    expect((await readHistory(harness))[0]).toMatchObject({ id: output.job_id, outcome: "running" });

    task.release();
    const job = await getJob(harness, output.job_id);
    expect(job.isError).toBeFalsy();
    const done = job.structuredContent as unknown as GenerateResult;
    expect(done).toMatchObject({ job_id: output.job_id, status: "completed", model: "gpt2" });
    expect(done.files).toHaveLength(1);
    expect(await readFile(done.files[0]!)).toEqual(tinyPng);
    expect(textOf(job)).toContain(done.files[0]!);

    // A completed Job is answered from the Job history.
    const again = await getJob(harness, output.job_id);
    expect(again.structuredContent).toMatchObject({ status: "completed", files: done.files });
  });

  test("get_job says a Job is still running when it is", async () => {
    harness = await startHarness(slow(gate()));
    const { job_id } = (await generate(harness)).structuredContent as unknown as GenerateResult;

    const job = await getJob(harness, job_id);
    expect(job.isError).toBeFalsy();
    expect(job.structuredContent).toMatchObject({ job_id, status: "running", files: [] });
  });

  test("get_job resumes polling from the Job history after the MCP server restarts", async () => {
    const task = gate();
    harness = await startHarness(slow(task));
    const { job_id } = (await generate(harness)).structuredContent as unknown as GenerateResult;

    await harness.restart();
    task.release();
    const job = await getJob(harness, job_id);

    expect(job.isError).toBeFalsy();
    const done = job.structuredContent as unknown as GenerateResult;
    expect(done.status).toBe("completed");
    expect(await readFile(done.files[0]!)).toEqual(tinyPng);
    expect(submits(harness)).toHaveLength(1);
    const lines = await readHistoryLines(harness);
    expect(lines.filter((line) => line.outcome === "completed")).toEqual([
      expect.objectContaining({ id: job_id, files: done.files, cost: 0.15, prompt: "a red fox" }),
    ]);
  });

  test("get_job reports a Job that failed after the wait limit", async () => {
    const task = gate("apimart/task-failed-moderation.json");
    harness = await startHarness(slow(task));
    const { job_id } = (await generate(harness)).structuredContent as unknown as GenerateResult;

    task.release();
    const job = await getJob(harness, job_id);
    expect(job.isError).toBe(true);
    expect(textOf(job)).toContain(`Job ${job_id} failed`);
    expect(textOf(job)).toContain("content moderation");
    expect((await readHistory(harness))[0]).toMatchObject({ outcome: "failed", error: { kind: "refusal" } });
  });

  test("get_job says when it knows no Job with that id", async () => {
    harness = await startHarness(apimartSetup());
    const job = await getJob(harness, "no-such-job");
    expect(job.isError).toBe(true);
    expect(textOf(job)).toContain('no Job "no-such-job"');
  });
});
