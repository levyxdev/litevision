import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startHarness, type Harness, type HarnessOptions, type Route } from "./harness.ts";
import { readEvidenceLines, readHistory, recorded, tinyPng } from "./helpers.ts";

/** Option Status evidence lives apart from the Job history (ADR 0015). */

const generationsUrl = "POST https://api.openai.com/v1/images/generations";
const editsUrl = "POST https://api.openai.com/v1/images/edits";

function openaiSetup(route: Route = recorded("openai/generations.json"), edits: Route = recorded("openai/edits.json")): HarnessOptions {
  return {
    config: {
      providers: [{ id: "openai", baseUrl: "https://api.openai.com/v1" }],
      models: [{ alias: "gpt-image", provider: "openai", modelId: "gpt-image-1", protocol: "openai-images" }],
      defaultImageModel: "gpt-image",
    },
    credentials: { openai: { apiKey: "sk-test-0000secret0000" } },
    routes: { [generationsUrl]: route, [editsUrl]: edits },
    now: () => new Date("2026-11-17T12:00:00.000Z"),
    waitLimitMs: 40,
  };
}

let harness: Harness | undefined;
let second: Harness | undefined;
afterEach(async () => {
  await second?.close();
  await harness?.close();
  harness = second = undefined;
});

async function generate(args: Record<string, unknown> = {}): Promise<string> {
  const result = await harness!.client.callTool({ name: "generate_image", arguments: { prompt: "a red fox", ...args } });
  return (result.structuredContent as { job_id: string } | undefined)?.job_id ?? "";
}

const evidenceLines = () => readEvidenceLines(harness!);

type Statuses = Record<string, Array<{ options: unknown; job_id: string }>>;

/** The same Option Statuses, each marked as from a deleted Job, as they read once the Job history is gone. */
const fromDeletedJobs = (statuses: Statuses): Statuses =>
  Object.fromEntries(Object.entries(statuses).map(([name, list]) => [name, list.map((status) => ({ ...status, job_deleted: true }))]));

async function statuses(of: Harness = harness!): Promise<Record<string, Array<{ options: unknown; job_id: string }>>> {
  const listed = await of.client.callTool({ name: "list_models", arguments: { model: "gpt-image" } });
  return (listed.structuredContent as { models: Array<{ option_statuses: Record<string, Array<{ options: unknown; job_id: string }>> }> }).models[0]!
    .option_statuses;
}

describe("Option Status evidence", () => {
  test("outlasts the Job history: with jobs.jsonl gone, the Option Statuses stay, from deleted Jobs", async () => {
    harness = await startHarness(openaiSetup());
    const jobId = await generate({ provider_options: { quality: "high" } });
    const before = await statuses();
    expect(before.accepted).toMatchObject([{ options: { quality: "high" }, job_id: jobId }]);

    await rm(join(harness.dirs.home, "jobs.jsonl"));

    expect(await statuses()).toEqual(fromDeletedJobs(before));
  });

  test("a Job that completes appends one line, with no prompt, path, Rating or Pick", async () => {
    harness = await startHarness(openaiSetup());
    const reference = join(harness.cwd, "secret-fox.png");
    await writeFile(reference, tinyPng);
    const outputPath = join(harness.cwd, "private-folder");
    const jobId = await generate({
      prompt: "a confidential red fox",
      references: [reference],
      output_path: outputPath,
      name: "hidden-name",
      provider_options: { quality: "high" },
    });
    await harness.client.callTool({ name: "rate_job", arguments: { job_id: jobId, verdict: "good", reason: "the fur looks real" } });

    const lines = await evidenceLines();

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      type: "evidence",
      jobId,
      createdAt: "2026-11-17T12:00:00.000Z",
      provider: "openai",
      protocol: "openai-images",
      modelId: "gpt-image-1",
      modality: "image",
      outcome: "completed",
      request: { providerOptions: { quality: "high" } },
    });
    const text = JSON.stringify(lines[0]);
    for (const secret of ["confidential", "secret-fox", "private-folder", "hidden-name", "fur looks real", harness.cwd, harness.dirs.output]) {
      expect(text).not.toContain(secret);
    }
  });

  test("a Job the Provider rejected appends one line with what the Provider said", async () => {
    harness = await startHarness(openaiSetup(recorded("openai/invalid-value.json", 400)));
    await generate({ provider_options: { quality: "ultra" } });
    const [job] = await readHistory(harness);
    const jobId = job!.id;

    const lines = await evidenceLines();

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ jobId, outcome: "failed", error: { kind: "rejected_option" } });
    expect((await statuses()).rejected).toMatchObject([{ options: { quality: "ultra" }, job_id: jobId }]);
  });

  test("a Job that failed for another reason than the Provider's answer keeps no error, which may name a local path", async () => {
    harness = await startHarness(openaiSetup());
    const blocked = join(harness.cwd, "private-file");
    await writeFile(blocked, "not a folder");
    await generate({ output_path: join(blocked, "inside") });
    const [job] = await readHistory(harness);
    expect(job).toMatchObject({ outcome: "failed", error: { message: expect.stringContaining("private-file") } });

    const lines = await evidenceLines();

    expect(lines).toMatchObject([{ jobId: job!.id, outcome: "failed" }]);
    expect(JSON.stringify(lines[0])).not.toContain("private-file");
  });

  test("a running Job appends nothing until it ends", async () => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    harness = await startHarness(
      openaiSetup(async (request) => {
        await released;
        return recorded("openai/generations.json")(request);
      }),
    );
    const jobId = await generate({ wait: false });

    expect(await evidenceLines()).toEqual([]);

    release();
    await harness.client.callTool({ name: "get_job", arguments: { job_id: jobId } });
    expect((await evidenceLines()).map((line) => line.jobId)).toEqual([jobId]);
  });
});

describe("evidence that could not be written", () => {
  test("never fails the Job; the next read writes it, in the order the Jobs ended", async () => {
    let tick = 0;
    harness = await startHarness({ ...openaiSetup(), now: () => new Date(Date.UTC(2026, 10, 17, 12, 0, tick++)) });
    // A folder where the evidence goes makes every write fail.
    await mkdir(join(harness.dirs.home, "evidence.jsonl"), { recursive: true });
    const first = await harness.client.callTool({ name: "generate_image", arguments: { prompt: "a red fox", provider_options: { quality: "high" } } });
    expect(first.isError).toBeFalsy();
    const firstId = (first.structuredContent as { job_id: string; status: string }).job_id;
    expect(first.structuredContent).toMatchObject({ status: "completed" });
    expect((await readHistory(harness)).at(-1)).toMatchObject({ id: firstId, outcome: "completed" });

    await rm(join(harness.dirs.home, "evidence.jsonl"), { recursive: true });
    const secondId = await generate({ provider_options: { quality: "high" } });

    expect((await statuses()).accepted).toMatchObject([{ options: { quality: "high" }, job_id: secondId }]);
    expect((await evidenceLines()).map((line) => line.jobId).sort()).toEqual([firstId, secondId].sort());
  });
});

describe("the first run after upgrading", () => {
  /** A Job of the gpt-image Model as an earlier release recorded it in the Job history. */
  function jobRecord(id: string, createdAt: string, overrides: Record<string, unknown>): Record<string, unknown> {
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
      parameters: { n: 1, references: [], providerOptions: {} },
      durationMs: 1_000,
      files: [],
      outcome: "completed",
      ...overrides,
    };
  }

  const history = [
    jobRecord("high", "2026-11-01T01:00:00.000Z", {
      parameters: { n: 1, references: [], providerOptions: { quality: "high" } },
      files: ["/out/high.png"],
      observed: [{ width: 1024, height: 1024, format: "png" }],
    }),
    jobRecord("wide", "2026-11-01T02:00:00.000Z", {
      parameters: {
        n: 1,
        references: [],
        requested: { shape: "1536x1024", resolution: null, size: "1536x1024", format: null },
        providerOptions: { size: "1536x1024" },
      },
      files: ["/out/wide.png"],
      observed: [{ width: 1024, height: 1024, format: "png" }],
    }),
    jobRecord("ultra", "2026-11-01T03:00:00.000Z", {
      parameters: { n: 1, references: [], providerOptions: { quality: "ultra" } },
      outcome: "failed",
      error: { kind: "rejected_option", message: "Invalid value: 'ultra'.", options: ["quality"] },
    }),
    jobRecord("running", "2026-11-01T04:00:00.000Z", {
      parameters: { n: 1, references: [], providerOptions: { quality: "low" } },
      outcome: "running",
    }),
  ];

  test("writes the evidence of every ended Job once, and the Option Statuses are those the Job history gave", async () => {
    harness = await startHarness(openaiSetup());
    second = await startHarness({ ...openaiSetup(), shareHomeWith: harness });
    await mkdir(harness.dirs.home, { recursive: true });
    await writeFile(join(harness.dirs.home, "jobs.jsonl"), history.map((job) => JSON.stringify(job)).join("\n") + "\n");

    const [fromFirst, fromSecond] = await Promise.all([statuses(harness), statuses(second)]);

    expect(fromSecond).toEqual(fromFirst);
    expect(fromFirst).toMatchObject({
      honoured: [],
      ignored: [{ options: { size: "1536x1024" }, job_id: "wide", reason: "asked for 1536x1024, got 1024x1024" }],
      rejected: [{ options: { quality: "ultra" }, job_id: "ultra" }],
      accepted: [{ options: { quality: "high" }, job_id: "high" }],
    });
    expect((await evidenceLines()).map((line) => line.jobId)).toEqual(["high", "wide", "ultra"]);

    await rm(join(harness.dirs.home, "jobs.jsonl"));
    expect(await statuses()).toEqual(fromDeletedJobs(fromFirst));
  });
});
