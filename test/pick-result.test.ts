import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startHarness, type Harness } from "./harness.ts";
import { readHistoryLines, recorded, textOf, type ToolResult } from "./helpers.ts";

/** Picks (ADR 0009): which of a Comparison's results the User prefers, kept apart from Ratings. */

const openai = { id: "openai", baseUrl: "https://api.openai.com/v1" };
const gptImage = { alias: "gpt-image", provider: "openai", modelId: "gpt-image-1", protocol: "openai-images" };
const dalle = { alias: "dall-e", provider: "openai", modelId: "dall-e-3", protocol: "openai-images" };

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

let clock = new Date("2026-11-05T12:00:00.000Z");

/** A completed Job's record as the Job runner writes it; `model` picks gpt-image or dall-e. */
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

const onDalle = { model: "dall-e", modelId: "dall-e-3" };

async function start(lines: Array<Record<string, unknown>>) {
  harness = await startHarness({
    config: { providers: [openai], models: [gptImage, dalle], defaultImageModel: "gpt-image" },
    credentials: { openai: { apiKey: "sk-test-0000secret0000" } },
    routes: { "POST https://api.openai.com/v1/images/generations": recorded("openai/generations.json") },
    now: () => clock,
  });
  await mkdir(harness.dirs.data, { recursive: true });
  await writeFile(join(harness.dirs.data, "jobs.jsonl"), lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
}

/** Comparison `c1`: Job `a` on gpt-image and Job `b` on dall-e. */
const comparisonC1 = () => [
  jobRecord("a", "2026-11-05T09:00:00.000Z", { comparison: "c1" }),
  jobRecord("b", "2026-11-05T09:00:00.000Z", { comparison: "c1", ...onDalle }),
];

async function pick(args: Record<string, unknown>, at?: string): Promise<ToolResult> {
  if (at !== undefined) clock = new Date(at);
  return harness!.client.callTool({ name: "pick_result", arguments: args });
}

const picksIn = async () => (await readHistoryLines(harness!)).filter((line) => line.type === "pick");

describe("pick_result", () => {
  test("records a Pick as a line of its own in the Job history", async () => {
    await start(comparisonC1());

    const result = await pick({ comparison_id: "c1", job_id: "b", result: 2 }, "2026-11-05T10:00:00.000Z");

    expect(result.isError, textOf(result)).toBeFalsy();
    expect(result.structuredContent).toEqual({ comparison_id: "c1", job_id: "b", result: 2, picked_at: "2026-11-05T10:00:00.000Z" });
    expect(textOf(result)).toContain("result 2 of Job b");
    expect((await readHistoryLines(harness!)).at(-1)).toEqual({
      type: "pick",
      comparison: "c1",
      jobId: "b",
      result: 2,
      pickedAt: "2026-11-05T10:00:00.000Z",
    });
  });

  test("picks a whole Job when `result` is omitted", async () => {
    await start(comparisonC1());

    const result = await pick({ comparison_id: "c1", job_id: "a" });

    expect(result.structuredContent).toEqual({ comparison_id: "c1", job_id: "a", picked_at: clock.toISOString() });
    expect(await picksIn()).toEqual([{ type: "pick", comparison: "c1", jobId: "a", pickedAt: clock.toISOString() }]);
  });

  test("records the Pick of a Comparison generate_comparison started", async () => {
    await start([]);
    const comparison = await harness!.client.callTool({
      name: "generate_comparison",
      arguments: { variants: [{ prompt: "a red fox" }, { prompt: "a red fox", model: "dall-e" }] },
    });
    const { comparison_id, jobs } = comparison.structuredContent as { comparison_id: string; jobs: Array<{ job_id: string }> };

    const result = await pick({ comparison_id, job_id: jobs[1]!.job_id });

    expect(result.isError, textOf(result)).toBeFalsy();
    expect(await picksIn()).toMatchObject([{ comparison: comparison_id, jobId: jobs[1]!.job_id }]);
  });

  test("an unknown Comparison errors and records nothing", async () => {
    await start(comparisonC1());

    const result = await pick({ comparison_id: "nope", job_id: "a" });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('no Comparison "nope"');
    expect(await picksIn()).toEqual([]);
  });

  test("a Job outside the Comparison errors, names the Comparison's Jobs, and records nothing", async () => {
    await start([...comparisonC1(), jobRecord("solo", "2026-11-05T08:00:00.000Z"), jobRecord("other", "2026-11-05T08:00:00.000Z", { comparison: "c2" })]);

    for (const job_id of ["solo", "other", "missing"]) {
      const result = await pick({ comparison_id: "c1", job_id });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain(`Job "${job_id}" is not part of Comparison c1`);
      expect(textOf(result)).toContain("a, b");
    }
    expect(await picksIn()).toEqual([]);
  });

  test("a result outside the Job's files, or a Job that has not completed, errors and records nothing", async () => {
    await start([
      jobRecord("a", "2026-11-05T09:00:00.000Z", { comparison: "c1" }),
      jobRecord("b", "2026-11-05T09:00:00.000Z", { comparison: "c1", outcome: "failed", files: [], error: { kind: "auth", message: "no" } }),
    ]);

    const outside = await pick({ comparison_id: "c1", job_id: "a", result: 3 });
    expect(outside.isError).toBe(true);
    expect(textOf(outside)).toContain("2 results");

    const failed = await pick({ comparison_id: "c1", job_id: "b" });
    expect(failed.isError).toBe(true);
    expect(textOf(failed)).toContain("failed");
    expect(await picksIn()).toEqual([]);
  });

  test("a later Pick for the same Comparison supersedes the earlier one when read back", async () => {
    await start(comparisonC1());
    await pick({ comparison_id: "c1", job_id: "a", result: 1 }, "2026-11-05T10:00:00.000Z");
    await pick({ comparison_id: "c1", job_id: "b" }, "2026-11-05T10:05:00.000Z");

    // Both stay in the append-only history; the latest is the Comparison's Pick now.
    expect((await picksIn()).map((line) => line.jobId)).toEqual(["a", "b"]);
    const listed = await recentPicksOf("gpt-image");
    expect(listed).toEqual([
      { comparison_id: "c1", job_id: "a", picked: false, picked_model: "dall-e", picked_at: "2026-11-05T10:05:00.000Z", prompt: "prompt of a" },
    ]);
  });

  test("a Pick is not a Rating and leaves every Option Status unchanged", async () => {
    const requested = { shape: "1024x1024", resolution: null };
    await start([
      jobRecord("a", "2026-11-05T09:00:00.000Z", { comparison: "c1", parameters: { ...jobRecord("a", "").parameters, providerOptions: { quality: "high" } } }),
      jobRecord("b", "2026-11-05T09:01:00.000Z", {
        comparison: "c1",
        parameters: { n: 2, requested, references: [], providerOptions: { size: "1024x1024" } },
        observed: [{ width: 1024, height: 1536 }, { width: 1024, height: 1536 }],
        mismatch: "asked for 1024x1024, got 1024x1536",
      }),
    ]);
    const before = await describeModel("gpt-image");

    // Picking the mismatched Job over the other neither makes its size Honoured nor changes the other Job's options.
    expect((await pick({ comparison_id: "c1", job_id: "b" })).isError).toBeFalsy();
    const after = await describeModel("gpt-image");

    const statusesOf = (result: ToolResult) => {
      const [model] = (result.structuredContent as { models: Array<Record<string, any>> }).models;
      return { statuses: model!.option_statuses, ratings: model!.recent_ratings };
    };
    expect(statusesOf(after)).toEqual(statusesOf(before));
    expect(statusesOf(after).statuses.accepted).toMatchObject([{ options: { quality: "high" }, job_id: "a" }]);
    expect(statusesOf(after).statuses.ignored).toMatchObject([{ options: { size: "1024x1024" }, job_id: "b" }]);
    expect(statusesOf(after).ratings).toEqual([]);
  });

  test("is listed, and the server instructions say to pick only when the User actually chooses", async () => {
    harness = await startHarness();
    const { tools } = await harness.client.listTools();
    expect(tools.map((tool) => tool.name)).toContain("pick_result");
    const instructions = harness.client.getInstructions()!;
    expect(instructions).toContain("`pick_result`");
    expect(instructions).toContain("only when the User actually chooses");
  });
});

const describeModel = (model: string) => harness!.client.callTool({ name: "list_models", arguments: { model } });

async function recentPicksOf(model: string): Promise<unknown[] | undefined> {
  const result = await describeModel(model);
  expect(result.isError, textOf(result)).toBeFalsy();
  return (result.structuredContent as { models: Array<{ recent_picks?: unknown[] }> }).models[0]!.recent_picks;
}

describe("list_models with `model`: recent Picks", () => {
  test("shows the Model's recent Comparisons with a Pick, newest Pick first: whether its Job was picked, and the start of the prompt", async () => {
    await start([
      ...comparisonC1(),
      jobRecord("c", "2026-11-05T09:10:00.000Z", { comparison: "c2", prompt: "a fox\n  in the snow" }),
      jobRecord("d", "2026-11-05T09:10:00.000Z", { comparison: "c2", ...onDalle }),
      // A Comparison without a Pick says nothing yet.
      jobRecord("e", "2026-11-05T09:20:00.000Z", { comparison: "c3" }),
      jobRecord("f", "2026-11-05T09:20:00.000Z", { comparison: "c3", ...onDalle }),
      // A Comparison gpt-image took no part in.
      jobRecord("g", "2026-11-05T09:30:00.000Z", { comparison: "c4", ...onDalle }),
      jobRecord("h", "2026-11-05T09:30:00.000Z", { comparison: "c4", ...onDalle }),
    ]);
    await pick({ comparison_id: "c2", job_id: "c", result: 2 }, "2026-11-05T10:00:00.000Z");
    await pick({ comparison_id: "c1", job_id: "b" }, "2026-11-05T10:01:00.000Z");
    await pick({ comparison_id: "c4", job_id: "g" }, "2026-11-05T10:02:00.000Z");

    const result = await describeModel("gpt-image");

    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as { models: Array<{ recent_picks?: unknown[] }> }).models[0]!.recent_picks).toEqual([
      { comparison_id: "c1", job_id: "a", picked: false, picked_model: "dall-e", picked_at: "2026-11-05T10:01:00.000Z", prompt: "prompt of a" },
      { comparison_id: "c2", job_id: "c", picked: true, result: 2, picked_model: "gpt-image", picked_at: "2026-11-05T10:00:00.000Z", prompt: "a fox in the snow" },
    ]);
    const text = textOf(result);
    expect(text).toContain('Job a in Comparison c1 ("prompt of a"): not picked; the User picked a Job on dall-e');
    expect(text).toContain('Job c in Comparison c2 ("a fox in the snow"): picked, result 2');
    expect(text.indexOf("Comparison c1")).toBeLessThan(text.indexOf("Comparison c2"));
    expect(text).not.toContain("Comparison c3");
    expect(text).not.toContain("Comparison c4");

    expect(await recentPicksOf("dall-e")).toMatchObject([
      { comparison_id: "c4", job_id: "g", picked: true },
      { comparison_id: "c4", job_id: "h", picked: false },
      { comparison_id: "c1", job_id: "b", picked: true },
      { comparison_id: "c2", job_id: "d", picked: false, picked_model: "gpt-image" },
    ]);
  });

  test("shows at most five Comparisons, and says when the Model has none yet", async () => {
    const ids = ["1", "2", "3", "4", "5", "6"];
    await start([
      ...ids.map((id) => jobRecord(`j${id}`, `2026-11-05T0${id}:00:00.000Z`, { comparison: `c${id}` })),
      // A second Job of this Model in c6: still one Comparison.
      jobRecord("j6b", "2026-11-05T06:00:00.000Z", { comparison: "c6" }),
    ]);
    expect(textOf(await describeModel("gpt-image"))).toContain("Recent Picks: none recorded yet.");

    for (const id of ids) await pick({ comparison_id: `c${id}`, job_id: `j${id}` }, `2026-11-05T10:0${id}:00.000Z`);

    const picks = (await recentPicksOf("gpt-image")) as Array<{ comparison_id: string }>;
    expect(picks.map((entry) => entry.comparison_id)).toEqual(["c6", "c6", "c5", "c4", "c3", "c2"]);
  });

  test("list_models without `model` does not show Picks", async () => {
    await start(comparisonC1());
    await pick({ comparison_id: "c1", job_id: "a" });

    const result = await harness!.client.callTool({ name: "list_models", arguments: {} });

    for (const model of (result.structuredContent as { models: Array<Record<string, unknown>> }).models) {
      expect(model).not.toHaveProperty("recent_picks");
    }
    expect(textOf(result)).not.toContain("Pick");
  });
});
