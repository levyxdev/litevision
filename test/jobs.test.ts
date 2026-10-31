import { afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { startHarness, type Harness, type HarnessOptions, type Route } from "./harness.ts";
import { readHistory, recorded, textOf, tinyPng } from "./helpers.ts";

/** The wait limit and resumption as they apply to a synchronous Protocol, here `openai-images`. */

const generationsUrl = "POST https://api.openai.com/v1/images/generations";

/** An OpenAI generation that answers only once `release` is called. */
function held() {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const route: Route = async (request) => {
    await released;
    return recorded("openai/generations.json")(request);
  };
  return { route, release };
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
    expect(textOf(job)).toContain("generate the images again");
    expect((await readHistory(harness))[0]).toMatchObject({ id: job_id, outcome: "failed", error: { kind: "other" } });
  });
});

describe("get_job", () => {
  test("is listed, and the server instructions explain when to call it", async () => {
    harness = await startHarness();
    const { tools } = await harness.client.listTools();
    expect(tools.map((tool) => tool.name)).toContain("get_job");
    expect(harness.client.getInstructions()).toContain("get_job");
  });
});
