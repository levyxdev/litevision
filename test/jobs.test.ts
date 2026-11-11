import { afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { startHarness, type Harness, type HarnessOptions, type Route } from "./harness.ts";
import { pngOfSize, readHistory, recorded, textOf, tinyPng } from "./helpers.ts";

/** The wait limit and resumption as they apply to a synchronous Protocol, here `openai-images`. */

const generationsUrl = "POST https://api.openai.com/v1/images/generations";

/** An OpenAI generation that gives `answer` only once `release` is called. */
function held(answer: Route = recorded("openai/generations.json")) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const route: Route = async (request) => {
    await released;
    return answer(request);
  };
  return { route, release };
}

/** An OpenAI answer whose PNG differs on every call, so each Job's result has its own content. */
function distinctImages(): Route {
  let calls = 0;
  return async () => {
    calls += 1;
    const image = pngOfSize(100 + calls, 100 + calls).toString("base64");
    return Response.json({ created: 1761814800, data: [{ b64_json: image }] });
  };
}

/** Resolves once `ready` holds, checking every few milliseconds; fails the test after three seconds. */
async function until(ready: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function openaiSetup(route: Route): HarnessOptions {
  return {
    config: {
      providers: [{ id: "openai", baseUrl: "https://api.openai.com/v1" }],
      models: [{ alias: "gpt-image", provider: "openai", modelId: "gpt-image-1", protocol: "openai-images" }],
      defaultImageModel: "gpt-image",
    },
    credentials: { openai: { apiKey: "sk-test-0000secret0000" } },
    routes: { [generationsUrl]: route },
    waitLimitMs: 40,
  };
}

interface JobResult {
  job_id: string;
  status: "completed" | "running";
  files: string[];
}

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe("the wait limit", () => {
  test("applies to synchronous Protocols too: the Job keeps running in-process and get_job returns its files", async () => {
    const generation = held();
    harness = await startHarness(openaiSetup(generation.route));
    const result = await harness.client.callTool({ name: "generate_image", arguments: { prompt: "a red fox" } });
    const { job_id, status } = result.structuredContent as unknown as JobResult;
    expect(status).toBe("running");

    generation.release();
    const job = await harness.client.callTool({ name: "get_job", arguments: { job_id } });
    const done = job.structuredContent as unknown as JobResult;
    expect(done.status).toBe("completed");
    expect(await readFile(done.files[0]!)).toEqual(tinyPng);
  });

  test("a synchronous Job lost with its process is reported as failed", async () => {
    harness = await startHarness(openaiSetup(held().route));
    const result = await harness.client.callTool({ name: "generate_image", arguments: { prompt: "a red fox" } });
    const { job_id } = result.structuredContent as unknown as JobResult;

    await harness.restart();
    const job = await harness.client.callTool({ name: "get_job", arguments: { job_id } });

    expect(job.isError).toBe(true);
    expect(textOf(job)).toContain(`Job ${job_id} failed`);
    expect(textOf(job)).toContain("start it again");
    expect((await readHistory(harness))[0]).toMatchObject({ id: job_id, outcome: "failed", error: { kind: "other" } });
  });
});

describe("get_job", () => {
  test("is listed, and its description explains when to call it", async () => {
    harness = await startHarness();
    const { tools } = await harness.client.listTools();
    const getJob = tools.find((tool) => tool.name === "get_job");
    expect(getJob?.description).toContain("still running");
  });
});

describe("wait: false", () => {
  test("generate_image returns the Job running at once, and get_job returns its files once it finishes", async () => {
    const generation = held();
    // A wait limit no test would sit out: only not waiting at all returns in time.
    harness = await startHarness({ ...openaiSetup(generation.route), waitLimitMs: 60_000 });
    const result = await harness.client.callTool({ name: "generate_image", arguments: { prompt: "a red fox", wait: false } });
    expect(result.isError).toBeFalsy();
    const { job_id, status, files } = result.structuredContent as unknown as JobResult;
    expect(status).toBe("running");
    expect(files).toEqual([]);
    expect(textOf(result)).toContain("get_job");

    generation.release();
    const job = await harness.client.callTool({ name: "get_job", arguments: { job_id } });
    const done = job.structuredContent as unknown as JobResult;
    expect(done.status).toBe("completed");
    expect(await readFile(done.files[0]!)).toEqual(tinyPng);
  });
});

describe("several Jobs with wait: false", () => {
  test("run at the same time, and get_job returns each one's own files", async () => {
    const generation = held(distinctImages());
    harness = await startHarness({ ...openaiSetup(generation.route), waitLimitMs: 60_000 });
    const ids: string[] = [];
    for (const name of ["fox", "owl", "hare"]) {
      const result = await harness.client.callTool({ name: "generate_image", arguments: { prompt: `a ${name}`, name, wait: false } });
      ids.push((result.structuredContent as unknown as JobResult).job_id);
    }

    // Every Job has reached the Provider before any of them is answered.
    await until(() => harness!.requests.length === 3);
    generation.release();
    const done = await Promise.all(ids.map((job_id) => harness!.client.callTool({ name: "get_job", arguments: { job_id } })));
    const files = done.map((job) => (job.structuredContent as unknown as JobResult).files);
    expect(files.map((paths) => paths.map((path) => path.split("/").pop()))).toEqual([["fox.png"], ["owl.png"], ["hare.png"]]);
    const sizes = await Promise.all(files.map(async ([path]) => (await readFile(path!)).readUInt32BE(16)));
    expect(new Set(sizes).size).toBe(3);
  });

  test("a Job given one's result as a reference records it as a Source Job", async () => {
    const images = distinctImages();
    harness = await startHarness({
      ...openaiSetup(images),
      routes: { [generationsUrl]: images, "POST https://api.openai.com/v1/images/edits": images },
    });
    const first = await harness.client.callTool({ name: "generate_image", arguments: { prompt: "a fox", wait: false } });
    const firstId = (first.structuredContent as unknown as JobResult).job_id;
    const firstDone = (await harness.client.callTool({ name: "get_job", arguments: { job_id: firstId } })).structuredContent as unknown as JobResult;

    const second = await harness.client.callTool({
      name: "generate_image",
      arguments: { prompt: "the fox in snow", references: firstDone.files, wait: false },
    });
    const secondId = (second.structuredContent as unknown as JobResult).job_id;
    const secondDone = await harness.client.callTool({ name: "get_job", arguments: { job_id: secondId } });
    expect(secondDone.structuredContent).toMatchObject({ status: "completed", source_jobs: [{ job_id: firstId, result: 1 }] });
  });

  test("a Job that fails in the background is recorded as failed, and get_job says why", async () => {
    harness = await startHarness({
      ...openaiSetup(recorded("openai/invalid-value.json", 400)),
      waitLimitMs: 60_000,
    });
    const result = await harness.client.callTool({ name: "generate_image", arguments: { prompt: "a red fox", wait: false } });
    expect(result.isError).toBeFalsy();
    const { job_id } = result.structuredContent as unknown as JobResult;

    const job = await harness.client.callTool({ name: "get_job", arguments: { job_id } });
    expect(job.isError).toBe(true);
    expect(textOf(job)).toContain(`Job ${job_id} failed`);
    expect((await readHistory(harness))[0]).toMatchObject({ id: job_id, outcome: "failed" });
  });
});
