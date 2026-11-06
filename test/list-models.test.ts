import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startHarness, type Harness } from "./harness.ts";
import { recorded, textOf, type ToolResult } from "./helpers.ts";

const openai = { id: "openai", baseUrl: "https://api.openai.com/v1" };
const relay = { id: "relay", baseUrl: "https://relay.example/v1" };

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

const listModels = () => harness!.client.callTool({ name: "list_models", arguments: {} });

describe("list_models", () => {
  test("returns each Model's Alias, Provider, Protocol, Parameter Guide summary, Model Notes and Standing Options, plus the default", async () => {
    harness = await startHarness({
      config: {
        providers: [openai, relay],
        models: [
          { alias: "gpt-image", provider: "openai", modelId: "gpt-image-1", protocol: "openai-images", notes: "photoreal, legible text" },
          { alias: "dalle", provider: "relay", modelId: "dall-e-3", protocol: "openai-images" },
        ],
        defaultImageModel: "gpt-image",
      },
    });
    const result = await listModels();

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      default_model: "gpt-image",
      default_video_model: null,
      models: [
        {
          alias: "gpt-image",
          provider: "openai",
          protocol: "openai-images",
          model_id: "gpt-image-1",
          modality: "image",
          default: true,
          notes: "photoreal, legible text",
          standing_options: {},
          docs_url: "https://platform.openai.com/docs/api-reference/images/create",
          parameters: expect.stringContaining("Parameter Guide for GPT Image 1.x"),
          known_good_options: {},
          suspect_options: {},
        },
        {
          alias: "dalle",
          provider: "relay",
          protocol: "openai-images",
          model_id: "dall-e-3",
          modality: "image",
          default: false,
          notes: "",
          standing_options: {},
          docs_url: "https://platform.openai.com/docs/api-reference/images/create",
          parameters: expect.stringContaining("litevision has no Parameter Guide for this model id"),
          known_good_options: {},
          suspect_options: {},
        },
      ],
    });
    const text = textOf(result);
    expect(text).toContain("gpt-image (default image)");
    expect(text).toContain("photoreal, legible text");
    expect(text).toContain("no Parameter Guide");
  });

  test("with no Model configured, tells the Agent to call open_settings", async () => {
    harness = await startHarness({ config: { providers: [openai] } });
    const result = await listModels();
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Call `open_settings`");
  });

  test("still lists a Model whose Protocol litevision does not support, saying so", async () => {
    harness = await startHarness({
      config: { providers: [openai], models: [{ alias: "odd", provider: "openai", modelId: "x", protocol: "carrier-pigeon" }] },
    });
    const result = await listModels();
    expect(result.isError).toBeFalsy();
    const [model] = (result.structuredContent as { models: Array<Record<string, unknown>> }).models;
    expect(model).toMatchObject({ alias: "odd", docs_url: null });
    expect(String(model!.problem)).toContain('Protocol "carrier-pigeon"');
  });

  test("the default image Model the User sets in the settings page is what generate_image uses when `model` is omitted", async () => {
    harness = await startHarness({
      config: {
        providers: [openai],
        models: [
          { alias: "gpt-image", provider: "openai", modelId: "gpt-image-1", protocol: "openai-images" },
          { alias: "dalle", provider: "openai", modelId: "dall-e-3", protocol: "openai-images" },
        ],
        defaultImageModel: "gpt-image",
      },
      credentials: { openai: { apiKey: "sk-test-0000secret0000" } },
      routes: { "POST https://api.openai.com/v1/images/generations": recorded("openai/generations.json") },
    });

    await harness.client.callTool({ name: "open_settings", arguments: {} });
    const page = new URL(harness.openedUrls[0]!);
    const response = await fetch(new URL("/api/default-image-model", page.origin), {
      method: "PUT",
      headers: {
        origin: page.origin,
        "x-litevision-token": page.searchParams.get("token")!,
        "content-type": "application/json",
      },
      body: JSON.stringify({ alias: "dalle" }),
    });
    expect(response.status).toBe(200);

    expect((await listModels()).structuredContent).toMatchObject({ default_model: "dalle" });
    const result = await harness.client.callTool({ name: "generate_image", arguments: { prompt: "a red fox" } });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ model: "dalle" });
    expect(JSON.parse(await harness.requests[0]!.text()).model).toBe("dall-e-3");
  });

  test("the server instructions tell the Agent to choose by Model Notes with list_models", async () => {
    harness = await startHarness();
    expect(harness.client.getInstructions()).toContain("list_models");
  });
});

describe("list_models with `model`: recent Ratings (ADR 0008)", () => {
  const gptImage = { alias: "gpt-image", provider: "openai", modelId: "gpt-image-1", protocol: "openai-images" };
  let clock = new Date("2026-11-01T12:00:00.000Z");

  /** A completed Job's record as the Job runner writes it. */
  function jobRecord(id: string, createdAt: string, overrides: Record<string, unknown> = {}) {
    return {
      type: "job",
      id,
      createdAt,
      model: "gpt-image",
      provider: "openai",
      protocol: "openai-images",
      modelId: "gpt-image-1",
      modality: "image",
      prompt: `prompt of ${id}`,
      parameters: { n: 2, aspectRatio: "1:1", size: { width: 1024, height: 1024, aspectRatio: "1:1" }, references: [], providerOptions: {} },
      durationMs: 1_000,
      files: [`/out/${id}-1.png`, `/out/${id}-2.png`],
      outcome: "completed",
      ...overrides,
    };
  }

  async function start(jobs: Array<Record<string, unknown>>, models: unknown[] = [gptImage]) {
    harness = await startHarness({
      config: { providers: [openai], models },
      credentials: { openai: { apiKey: "sk-test-0000secret0000" } },
      now: () => clock,
    });
    await mkdir(harness.dirs.data, { recursive: true });
    await writeFile(join(harness.dirs.data, "jobs.jsonl"), jobs.map((job) => JSON.stringify(job)).join("\n") + "\n");
  }

  async function rate(at: string, args: Record<string, unknown>) {
    clock = new Date(at);
    const result = await harness!.client.callTool({ name: "rate_job", arguments: args });
    expect(result.isError).toBeFalsy();
  }

  const describeModel = (model: string) => harness!.client.callTool({ name: "list_models", arguments: { model } });
  const ratingsOf = (result: ToolResult) =>
    (result.structuredContent as { models: Array<{ recent_ratings?: unknown[] }> }).models[0]!.recent_ratings;

  test("shows the Model's five most recent Ratings, newest first, with verdict, reason, result and the start of the prompt", async () => {
    await start(["a", "b", "c", "d", "e", "f"].map((id, i) => jobRecord(id, `2026-11-01T0${i}:00:00.000Z`)));
    await rate("2026-11-01T10:00:00.000Z", { job_id: "a", verdict: "good", reason: "oldest" });
    await rate("2026-11-01T10:01:00.000Z", { job_id: "b", verdict: "bad", reason: "second" });
    await rate("2026-11-01T10:02:00.000Z", { job_id: "f", verdict: "good", reason: "third, on the second image", result: 2 });
    await rate("2026-11-01T10:03:00.000Z", { job_id: "c", verdict: "bad", reason: "fourth" });
    await rate("2026-11-01T10:04:00.000Z", { job_id: "d", verdict: "good", reason: "fifth" });
    await rate("2026-11-01T10:05:00.000Z", { job_id: "e", verdict: "bad", reason: "newest", result: 1 });

    const result = await describeModel("gpt-image");

    expect(result.isError).toBeFalsy();
    expect(ratingsOf(result)).toEqual([
      { job_id: "e", result: 1, verdict: "bad", reason: "newest", rated_at: "2026-11-01T10:05:00.000Z", prompt: "prompt of e" },
      { job_id: "d", verdict: "good", reason: "fifth", rated_at: "2026-11-01T10:04:00.000Z", prompt: "prompt of d" },
      { job_id: "c", verdict: "bad", reason: "fourth", rated_at: "2026-11-01T10:03:00.000Z", prompt: "prompt of c" },
      { job_id: "f", result: 2, verdict: "good", reason: "third, on the second image", rated_at: "2026-11-01T10:02:00.000Z", prompt: "prompt of f" },
      { job_id: "b", verdict: "bad", reason: "second", rated_at: "2026-11-01T10:01:00.000Z", prompt: "prompt of b" },
    ]);
    const text = textOf(result);
    expect(text).toContain('bad on result 1 of Job e ("prompt of e"): newest');
    expect(text).toContain('good on Job d ("prompt of d"): fifth');
    expect(text.indexOf("newest")).toBeLessThan(text.indexOf("fifth"));
    expect(text).not.toContain("oldest");
  });

  test("shows only the start of a long prompt, on one line", async () => {
    const prompt = `A watercolour fox\n  sitting in tall grass at dusk, ${"with fireflies all around ".repeat(10)}`;
    await start([jobRecord("fox", "2026-11-01T09:00:00.000Z", { prompt })]);
    await rate("2026-11-01T10:00:00.000Z", { job_id: "fox", verdict: "good", reason: "lovely light" });

    const result = await describeModel("gpt-image");

    expect(ratingsOf(result)).toMatchObject([
      { prompt: "A watercolour fox sitting in tall grass at dusk, with fireflies all around with…" },
    ]);
    expect(textOf(result)).toContain('("A watercolour fox sitting in tall grass at dusk, with fireflies all around with…"): lovely light');
  });

  test("follows the Model by Provider, Protocol and model id, so renaming its Alias keeps its Ratings", async () => {
    await start([
      jobRecord("fox", "2026-11-01T09:00:00.000Z"),
      // Once run under the same Alias, but on another model id: not this Model's Rating.
      jobRecord("owl", "2026-11-01T09:30:00.000Z", { modelId: "dall-e-3" }),
      jobRecord("cat", "2026-11-01T09:45:00.000Z", { provider: "relay" }),
    ]);
    await rate("2026-11-01T10:00:00.000Z", { job_id: "fox", verdict: "good", reason: "the fur looks real" });
    await rate("2026-11-01T10:01:00.000Z", { job_id: "owl", verdict: "bad", reason: "not this Model" });
    await rate("2026-11-01T10:02:00.000Z", { job_id: "cat", verdict: "bad", reason: "not this Provider" });

    await harness!.client.callTool({ name: "open_settings", arguments: {} });
    const page = new URL(harness!.openedUrls[0]!);
    const renamed = await fetch(new URL("/api/models/gpt-image", page.origin), {
      method: "PATCH",
      headers: { origin: page.origin, "x-litevision-token": page.searchParams.get("token")!, "content-type": "application/json" },
      body: JSON.stringify({ alias: "gpt-image-hq" }),
    });
    expect(renamed.status).toBe(200);

    const result = await describeModel("gpt-image-hq");

    expect(result.isError).toBeFalsy();
    expect(ratingsOf(result)).toEqual([
      { job_id: "fox", verdict: "good", reason: "the fur looks real", rated_at: "2026-11-01T10:00:00.000Z", prompt: "prompt of fox" },
    ]);
  });

  test("shows only a Job's current Ratings: a later one of the same result supersedes the earlier", async () => {
    await start([jobRecord("fox", "2026-11-01T09:00:00.000Z")]);
    await rate("2026-11-01T10:00:00.000Z", { job_id: "fox", verdict: "good", reason: "lovely", result: 1 });
    await rate("2026-11-01T10:01:00.000Z", { job_id: "fox", verdict: "bad", reason: "the whole set is off" });
    await rate("2026-11-01T10:02:00.000Z", { job_id: "fox", verdict: "bad", reason: "the tail is missing", result: 1 });

    const result = await describeModel("gpt-image");

    expect(ratingsOf(result)).toMatchObject([
      { job_id: "fox", result: 1, verdict: "bad", reason: "the tail is missing" },
      { job_id: "fox", verdict: "bad", reason: "the whole set is off" },
    ]);
    expect(textOf(result)).not.toContain("lovely");
  });

  test("says when the Model has no Ratings yet", async () => {
    await start([jobRecord("fox", "2026-11-01T09:00:00.000Z")]);
    const result = await describeModel("gpt-image");
    expect(ratingsOf(result)).toEqual([]);
    expect(textOf(result)).toContain("Recent Ratings: none recorded yet.");
  });

  test("list_models without `model` does not show Ratings", async () => {
    await start([jobRecord("fox", "2026-11-01T09:00:00.000Z")]);
    await rate("2026-11-01T10:00:00.000Z", { job_id: "fox", verdict: "good", reason: "the fur looks real" });

    const result = await listModels();

    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as { models: Array<Record<string, unknown>> }).models[0]).not.toHaveProperty("recent_ratings");
    expect(textOf(result)).not.toContain("the fur looks real");
    expect(textOf(result)).not.toContain("Recent Ratings");
  });
});
