import { afterEach, describe, expect, test } from "bun:test";
import { startHarness, type Harness, type HarnessOptions, type Route } from "./harness.ts";
import { readHistory, readHistoryLines, recorded, textOf } from "./helpers.ts";

const generationsUrl = "POST https://api.openai.com/v1/images/generations";
const ratedAt = new Date("2026-10-30T12:00:00.000Z");

function openaiSetup(route: Route = recorded("openai/generations.json")): HarnessOptions {
  return {
    config: {
      providers: [{ id: "openai", baseUrl: "https://api.openai.com/v1" }],
      models: [{ alias: "gpt-image", provider: "openai", modelId: "gpt-image-1", protocol: "openai-images" }],
      defaultImageModel: "gpt-image",
    },
    credentials: { openai: { apiKey: "sk-test-0000secret0000" } },
    routes: { [generationsUrl]: route },
    now: () => ratedAt,
    waitLimitMs: 40,
  };
}

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function generate(args: Record<string, unknown> = {}): Promise<string> {
  const result = await harness!.client.callTool({ name: "generate_image", arguments: { prompt: "a red fox", ...args } });
  return (result.structuredContent as { job_id: string }).job_id;
}

const rate = (args: Record<string, unknown>) => harness!.client.callTool({ name: "rate_job", arguments: args });

describe("rate_job", () => {
  test("appends a structured Rating record to the Job history", async () => {
    harness = await startHarness(openaiSetup());
    const jobId = await generate();

    const result = await rate({ job_id: jobId, verdict: "good", reason: "the fur looks real" });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      job_id: jobId,
      verdict: "good",
      reason: "the fur looks real",
      rated_at: ratedAt.toISOString(),
    });
    expect(textOf(result)).toContain("good");
    expect((await readHistoryLines(harness)).at(-1)).toEqual({
      type: "rating",
      jobId,
      verdict: "good",
      reason: "the fur looks real",
      ratedAt: ratedAt.toISOString(),
    });
  });

  test("keeps the reason to one line", async () => {
    harness = await startHarness(openaiSetup());
    const jobId = await generate();

    const result = await rate({ job_id: jobId, verdict: "bad", reason: "  the text\n is   wrong  " });

    expect((result.structuredContent as { reason: string }).reason).toBe("the text is wrong");
    expect((await readHistoryLines(harness)).at(-1)).toMatchObject({ reason: "the text is wrong" });
  });

  test("rejects an empty reason", async () => {
    harness = await startHarness(openaiSetup());
    const jobId = await generate();

    const result = await rate({ job_id: jobId, verdict: "bad", reason: "  \n " });

    expect(result.isError).toBe(true);
    expect((await readHistoryLines(harness)).some((line) => line.type === "rating")).toBe(false);
  });

  test("a later Rating supersedes the earlier one when read back", async () => {
    harness = await startHarness(openaiSetup());
    const jobId = await generate();

    await rate({ job_id: jobId, verdict: "good", reason: "looks fine" });
    const second = await rate({ job_id: jobId, verdict: "bad", reason: "the tail is missing" });

    expect(second.structuredContent).toMatchObject({ verdict: "bad", reason: "the tail is missing" });
    // Both are kept in the append-only history; the settings page shows the latest (see settings-history.test.ts).
    const ratings = (await readHistoryLines(harness)).filter((line) => line.type === "rating");
    expect(ratings.map((rating) => rating.verdict)).toEqual(["good", "bad"]);
  });

  test("an unknown Job id errors and records nothing", async () => {
    harness = await startHarness(openaiSetup());
    await generate();

    const result = await rate({ job_id: "no-such-job", verdict: "good", reason: "nice" });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('"no-such-job"');
    expect((await readHistoryLines(harness)).some((line) => line.type === "rating")).toBe(false);
  });

  test("a failed Job cannot be rated, and the error says why", async () => {
    harness = await startHarness(openaiSetup(recorded("openai/invalid-api-key.json", 401)));
    const jobId = await failedJob();

    const result = await rate({ job_id: jobId, verdict: "bad", reason: "nothing came back" });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("failed");
    expect((await readHistoryLines(harness)).some((line) => line.type === "rating")).toBe(false);
  });

  test("a Job that is still running cannot be rated, and the error says why", async () => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    harness = await startHarness(
      openaiSetup(async (request) => {
        await released;
        return recorded("openai/generations.json")(request);
      }),
    );
    const jobId = await generate();

    const result = await rate({ job_id: jobId, verdict: "good", reason: "nice" });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("still running");
    expect((await readHistoryLines(harness)).some((line) => line.type === "rating")).toBe(false);
    release();
  });

  test("Rating lines leave Jobs and known-good provider_options as they were", async () => {
    harness = await startHarness(openaiSetup());
    const jobId = await generate({ provider_options: { quality: "high" } });
    await rate({ job_id: jobId, verdict: "good", reason: "sharp" });

    const job = await harness.client.callTool({ name: "get_job", arguments: { job_id: jobId } });
    expect(job.structuredContent).toMatchObject({ job_id: jobId, status: "completed" });

    const listed = await harness.client.callTool({ name: "list_models", arguments: { model: "gpt-image" } });
    const { models } = listed.structuredContent as { models: Array<{ known_good_options: unknown }> };
    expect(models[0]!.known_good_options).toEqual({ quality: "high" });
  });

  test("is listed, and the server instructions say to rate only on the User's own verdict", async () => {
    harness = await startHarness();
    const { tools } = await harness.client.listTools();
    expect(tools.map((tool) => tool.name)).toContain("rate_job");
    const instructions = harness.client.getInstructions() ?? "";
    expect(instructions).toContain("rate_job");
    expect(instructions).toMatch(/never invent/i);
  });
});

/** Runs a Job that the Provider rejects and returns its id. */
async function failedJob(): Promise<string> {
  const result = await harness!.client.callTool({ name: "generate_image", arguments: { prompt: "a red fox" } });
  expect(result.isError).toBe(true);
  const [record] = await readHistory(harness!);
  expect(record).toMatchObject({ outcome: "failed" });
  return record!.id as string;
}
