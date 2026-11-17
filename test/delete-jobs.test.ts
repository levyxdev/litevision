import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { startHarness, type Harness, type HarnessOptions, type Route } from "./harness.ts";
import { deadPid, readHistory, readHistoryLines, recorded, textOf, tinyPng, type ToolResult } from "./helpers.ts";
import { readdir } from "node:fs/promises";

/** Deleting Jobs from the Job history, with their Results (#62, ADR 0015). */

const root = "https://api.together.ai";
const imagesUrl = `POST ${root}/v1/images/generations`;

function togetherSetup(images: Route = recorded("together/images.json")): HarnessOptions {
  return {
    config: {
      providers: [{ id: "together-ai", baseUrl: `${root}/v1` }],
      models: [
        { alias: "sdxl", provider: "together-ai", modelId: "stabilityai/stable-diffusion-xl-base-1.0", protocol: "together" },
        { alias: "flux2", provider: "together-ai", modelId: "black-forest-labs/FLUX.2-pro", protocol: "together" },
      ],
      defaultImageModel: "sdxl",
    },
    credentials: { "together-ai": { apiKey: "together-test-0000secret0000" } },
    routes: { [imagesUrl]: images },
    now: () => new Date(2026, 10, 5, 9, 0, 0),
    waitLimitMs: 200,
  };
}

let harness: Harness | undefined;
let second: Harness | undefined;
afterEach(async () => {
  await second?.close();
  await harness?.close();
  harness = second = undefined;
});

function ok(result: ToolResult): Record<string, any> {
  expect(result.isError, textOf(result)).toBeFalsy();
  return result.structuredContent as Record<string, any>;
}

const call = (name: string, args: Record<string, unknown>, on: Harness = harness!) => on.client.callTool({ name, arguments: args });
const deleteJobs = (args: Record<string, unknown>) => call("delete_jobs", args);

async function generate(args: Record<string, unknown> = {}, on: Harness = harness!): Promise<{ job_id: string; files: string[] }> {
  return ok(await call("generate_image", { prompt: "a red fox", ...args }, on)) as { job_id: string; files: string[] };
}

const exists = (path: string) => Bun.file(path).exists();

describe("delete_jobs", () => {
  test("deletes a Job's records, Ratings and Results, and leaves other Jobs as they were", async () => {
    harness = await startHarness(togetherSetup());
    const gone = await generate({ name: "gone" });
    const kept = await generate({ name: "kept" });
    ok(await call("rate_job", { job_id: gone.job_id, verdict: "good", reason: "nice" }));
    ok(await call("rate_job", { job_id: kept.job_id, verdict: "bad", reason: "blurry" }));
    const keptLines = (await readHistoryLines(harness)).filter((line) => line.id === kept.job_id || line.jobId === kept.job_id);

    const report = ok(await deleteJobs({ job_ids: [gone.job_id] }));

    expect(report).toMatchObject({ deleted_jobs: [gone.job_id], deleted_files: gone.files, already_gone: [], skipped_files: [], running_jobs: [], not_found: [] });
    expect(await exists(gone.files[0]!)).toBe(false);
    expect(await exists(kept.files[0]!)).toBe(true);
    expect(await readHistoryLines(harness)).toEqual(keptLines);
  });

  test("refuses no selector or several, and deletes nothing", async () => {
    harness = await startHarness(togetherSetup());
    const job = await generate();
    for (const args of [{}, { job_ids: [job.job_id], all: true }, { job_ids: [job.job_id], comparison_ids: ["c"] }]) {
      const result = await deleteJobs(args);
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("exactly one of");
    }
    expect((await readHistory(harness)).map((record) => record.id)).toEqual([job.job_id]);
    expect(await exists(job.files[0]!)).toBe(true);
  });

  test("lists ids the Job history does not have", async () => {
    harness = await startHarness(togetherSetup());
    expect(ok(await deleteJobs({ job_ids: ["nope"] }))).toMatchObject({ deleted_jobs: [], not_found: ["nope"] });
    expect(ok(await deleteJobs({ comparison_ids: ["none"] }))).toMatchObject({ deleted_jobs: [], not_found: ["none"] });
  });

  test("with comparison_ids deletes all of a Comparison's Jobs and its Pick; deleting one of its Jobs keeps the others", async () => {
    harness = await startHarness(togetherSetup());
    const first = ok(await call("generate_comparison", { variants: [{ prompt: "a fox" }, { prompt: "a fox", model: "flux2" }] }));
    const other = ok(await call("generate_comparison", { variants: [{ prompt: "an owl" }, { prompt: "an owl", model: "flux2" }] }));
    const [a, b] = first.jobs as Array<{ job_id: string }>;
    const [c, d] = other.jobs as Array<{ job_id: string }>;
    ok(await call("pick_result", { comparison_id: first.comparison_id, job_id: b!.job_id }));
    ok(await call("pick_result", { comparison_id: other.comparison_id, job_id: c!.job_id }));

    const whole = ok(await deleteJobs({ comparison_ids: [first.comparison_id] }));
    expect(whole.deleted_jobs.sort()).toEqual([a!.job_id, b!.job_id].sort());
    expect(whole.picks_removed).toEqual([{ comparison_id: first.comparison_id, job_id: b!.job_id }]);

    const one = ok(await deleteJobs({ job_ids: [d!.job_id] }));
    expect(one).toMatchObject({ deleted_jobs: [d!.job_id], picks_removed: [] });
    expect((await readHistory(harness)).map((record) => record.id)).toEqual([c!.job_id]);
    expect((await readHistoryLines(harness)).filter((line) => line.type === "pick")).toEqual([
      expect.objectContaining({ comparison: other.comparison_id, jobId: c!.job_id }),
    ]);
  });

  test("a Comparison whose picked Job is deleted has no Pick, not an earlier one", async () => {
    harness = await startHarness(togetherSetup());
    const comparison = ok(await call("generate_comparison", { variants: [{ prompt: "a fox" }, { prompt: "a fox", model: "flux2" }] }));
    const [a, b] = comparison.jobs as Array<{ job_id: string }>;
    ok(await call("pick_result", { comparison_id: comparison.comparison_id, job_id: a!.job_id }));
    ok(await call("pick_result", { comparison_id: comparison.comparison_id, job_id: b!.job_id }));

    ok(await deleteJobs({ job_ids: [b!.job_id] }));

    expect((await readHistoryLines(harness)).filter((line) => line.type === "pick")).toEqual([]);
  });

  test("with all deletes every Job but those still running, which it lists", async () => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let held = false;
    harness = await startHarness(
      togetherSetup(async (request) => {
        if (held) await released;
        return recorded("together/images.json")(request);
      }),
    );
    const done = await generate();
    held = true;
    const running = ok(await call("generate_image", { prompt: "a slow fox", wait: false })) as { job_id: string };

    const report = ok(await deleteJobs({ all: true }));

    expect(report).toMatchObject({ deleted_jobs: [done.job_id], running_jobs: [running.job_id] });
    release();
    expect(ok(await call("get_job", { job_id: running.job_id }))).toMatchObject({ status: "completed" });
    expect((await readHistory(harness)).map((record) => record.id)).toEqual([running.job_id]);
  });

  test("leaves a Result that changed since it was saved, and one the User already deleted is simply gone, not skipped", async () => {
    harness = await startHarness(togetherSetup());
    const changed = await generate({ name: "changed" });
    const missing = await generate({ name: "missing" });
    await writeFile(changed.files[0]!, "edited by the User");
    await Bun.file(missing.files[0]!).delete();

    const result = await deleteJobs({ job_ids: [changed.job_id, missing.job_id] });
    const report = ok(result);

    expect(report.deleted_jobs.sort()).toEqual([changed.job_id, missing.job_id].sort());
    expect(report.deleted_files).toEqual([]);
    expect(report.already_gone).toEqual([missing.files[0]]);
    expect(report.skipped_files).toEqual([{ job_id: changed.job_id, file: changed.files[0], reason: "content-changed" }]);
    expect(await readFile(changed.files[0]!, "utf8")).toBe("edited by the User");
    expect(textOf(result)).toContain("1 Result was already gone");
    expect(textOf(result)).not.toContain(`Left ${missing.files[0]}`);
    expect(textOf(await deleteJobs({ all: true }))).toContain("Deleted 0 Jobs");
  });

  // Root may delete anything, so only another user can be refused.
  test.skipIf(process.getuid?.() === 0)("a Result it cannot delete is left and reported, and the rest of the deletion goes on", async () => {
    harness = await startHarness(togetherSetup());
    const locked = await generate({ name: "locked", output_path: join(harness.cwd, "locked") });
    const free = await generate({ name: "free" });
    await chmod(dirname(locked.files[0]!), 0o500);
    try {
      const report = ok(await deleteJobs({ job_ids: [locked.job_id, free.job_id] }));

      expect(report.deleted_jobs.sort()).toEqual([locked.job_id, free.job_id].sort());
      expect(report.deleted_files).toEqual(free.files);
      expect(report.skipped_files).toEqual([{ job_id: locked.job_id, file: locked.files[0], reason: "could-not-delete" }]);
      expect(await exists(locked.files[0]!)).toBe(true);
    } finally {
      await chmod(dirname(locked.files[0]!), 0o700);
    }
  });

  test("a Job recorded before hashes: deletes a Result still an image or video, leaves anything else", async () => {
    harness = await startHarness(togetherSetup());
    const folder = join(harness.dirs.output, "2026-01-02");
    await mkdir(folder, { recursive: true });
    const image = join(folder, "old-1.png");
    const replaced = join(folder, "old-2.png");
    await writeFile(image, tinyPng);
    await writeFile(replaced, "notes the User saved over it");
    const old = {
      type: "job",
      id: "old",
      createdAt: "2026-01-02T10:00:00.000Z",
      model: "sdxl",
      provider: "together-ai",
      protocol: "together",
      modelId: "stabilityai/stable-diffusion-xl-base-1.0",
      prompt: "an old fox",
      parameters: { n: 2, references: [], providerOptions: {} },
      durationMs: 1000,
      files: [image, replaced],
      outcome: "completed",
    };
    await mkdir(harness.dirs.home, { recursive: true });
    await writeFile(join(harness.dirs.home, "jobs.jsonl"), JSON.stringify(old) + "\n");

    const report = ok(await deleteJobs({ job_ids: ["old"] }));

    expect(report).toMatchObject({ deleted_files: [image], skipped_files: [{ job_id: "old", file: replaced, reason: "content-changed" }] });
    expect(await exists(replaced)).toBe(true);
  });

  test("never deletes a Reference; deletes a Result another Job used as one, and says so", async () => {
    harness = await startHarness(togetherSetup());
    const userImage = join(harness.cwd, "my-photo.png");
    await writeFile(userImage, Buffer.concat([tinyPng, Buffer.from("the User's own")]));
    const source = await generate({ name: "source", references: [userImage] });
    const user = await generate({ name: "user", references: [source.files[0]] });

    const report = ok(await deleteJobs({ job_ids: [source.job_id] }));

    expect(report.deleted_files).toEqual(source.files);
    expect(report.references_of_other_jobs).toEqual([{ file: source.files[0], job_ids: [user.job_id] }]);
    expect(await exists(userImage)).toBe(true);
  });

  test("removes a dated folder once empty, never an output_path folder", async () => {
    harness = await startHarness(togetherSetup());
    const dated = await generate();
    const chosen = join(harness.cwd, "assets");
    const named = await generate({ output_path: chosen });
    expect(dirname(named.files[0]!)).toBe(chosen);

    ok(await deleteJobs({ all: true }));

    expect(await exists(dated.files[0]!)).toBe(false);
    expect(await stat(dirname(dated.files[0]!)).catch(() => undefined)).toBeUndefined();
    expect((await stat(chosen)).isDirectory()).toBe(true);
    expect((await stat(harness.dirs.output)).isDirectory()).toBe(true);
  });
});

describe("after deleting a Job", () => {
  test("its Option Statuses stay, marked as from a deleted Job", async () => {
    harness = await startHarness(togetherSetup());
    const job = await generate({ provider_options: { steps: 4 } });
    ok(await deleteJobs({ job_ids: [job.job_id] }));

    const listed = ok(await call("list_models", { model: "sdxl" }));
    expect(listed.models[0].option_statuses.accepted).toEqual([
      { options: { steps: 4 }, job_id: job.job_id, job_deleted: true, date: expect.any(String) },
    ]);
    expect(textOf(await call("list_models", { model: "sdxl" }))).toContain(`Job ${job.job_id} (deleted)`);
  });

  test("get_job answers as for a Job litevision never had", async () => {
    harness = await startHarness(togetherSetup());
    const job = await generate();
    ok(await deleteJobs({ job_ids: [job.job_id] }));

    const result = await call("get_job", { job_id: job.job_id });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(`litevision has no Job "${job.job_id}"`);
  });

  test("a remaining Job shows its deleted Source Job as deleted, and its own record is unchanged", async () => {
    harness = await startHarness(togetherSetup());
    const source = await generate({ name: "source" });
    const user = await generate({ name: "user", references: [source.files[0]] });
    const before = (await readHistory(harness)).find((record) => record.id === user.job_id);

    ok(await deleteJobs({ job_ids: [source.job_id] }));

    expect((await readHistory(harness)).find((record) => record.id === user.job_id)).toEqual(before!);
    const shown = ok(await call("get_job", { job_id: user.job_id }));
    expect(shown.source_jobs).toEqual([
      { job_id: source.job_id, result: 1, file: source.files[0], deleted: true, job_deleted: true, reference: source.files[0] },
    ]);
  });
});

describe("two sessions sharing a home", () => {
  test("one deletes while the other records Jobs, and no record is lost", async () => {
    harness = await startHarness(togetherSetup());
    second = await startHarness({ ...togetherSetup(), shareHomeWith: harness });
    const doomed = await Promise.all(Array.from({ length: 10 }, () => generate()));

    const [, ...made] = await Promise.all([
      deleteJobs({ job_ids: doomed.map((job) => job.job_id) }),
      ...Array.from({ length: 10 }, () => generate({}, second)),
    ]);

    const history = await readHistory(harness);
    expect(history.map((record) => record.id).sort()).toEqual(made.map((job) => job.job_id).sort());
    expect(history.every((record) => record.outcome === "completed")).toBe(true);
  });
});

describe("a Job left running by a session that has ended", () => {
  function runningRecord(id: string, owner?: { pid: number }) {
    return {
      type: "job",
      id,
      createdAt: "2026-11-01T10:00:00.000Z",
      model: "sdxl",
      provider: "together-ai",
      protocol: "together",
      modelId: "stabilityai/stable-diffusion-xl-base-1.0",
      prompt: `prompt of ${id}`,
      parameters: { n: 1, references: [], providerOptions: {} },
      durationMs: 0,
      files: [],
      outcome: "running",
      ...(owner === undefined ? {} : { owner }),
    };
  }

  test("is interrupted and can be deleted; a Job a live session runs cannot", async () => {
    harness = await startHarness(togetherSetup());
    const lines = [runningRecord("orphan", { pid: await deadPid() }), runningRecord("before-owners"), runningRecord("live", { pid: process.pid })];
    await mkdir(harness.dirs.home, { recursive: true });
    await writeFile(join(harness.dirs.home, "jobs.jsonl"), lines.map((line) => JSON.stringify(line)).join("\n") + "\n");

    const report = ok(await deleteJobs({ all: true }));

    expect(report.deleted_jobs.sort()).toEqual(["before-owners", "orphan"]);
    expect(report.running_jobs).toEqual(["live"]);
  });

  test("a running Job records the process that runs it", async () => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    harness = await startHarness(
      togetherSetup(async (request) => {
        await released;
        return recorded("together/images.json")(request);
      }),
    );
    const running = ok(await call("generate_image", { prompt: "a slow fox", wait: false })) as { job_id: string };

    expect((await readHistory(harness))[0]).toMatchObject({ id: running.job_id, outcome: "running", owner: { pid: process.pid } });
    release();
    ok(await call("get_job", { job_id: running.job_id }));
    expect((await readHistory(harness))[0]).not.toHaveProperty("owner");
  });

  test("a Job deleted while something still ran it does not come back, nor do the Results it saves", async () => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    harness = await startHarness(
      togetherSetup(async (request) => {
        await released;
        return recorded("together/images.json")(request);
      }),
    );
    const running = ok(await call("generate_image", { prompt: "a slow fox", wait: false })) as { job_id: string };
    // As an older litevision, or a process whose pid was reused, would leave it: taken for interrupted.
    const [record] = await readHistory(harness);
    await writeFile(join(harness.dirs.home, "jobs.jsonl"), JSON.stringify({ ...record, owner: { pid: await deadPid() } }) + "\n", { flag: "a" });
    expect(ok(await deleteJobs({ job_ids: [running.job_id] })).deleted_jobs).toEqual([running.job_id]);

    release();
    // Long enough for the Job to finish in the background, saving and recording what it brought back.
    await Bun.sleep(300);
    const result = await call("get_job", { job_id: running.job_id });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(`litevision has no Job "${running.job_id}"`);
    expect(await Bun.file(join(harness.dirs.home, "jobs.jsonl")).text()).toBe("");
    expect(await readdir(harness.dirs.output, { recursive: true }).then((names) => names.filter((name) => name.endsWith(".png")))).toEqual([]);
  });

  test("keeps the evidence of a Job whose evidence had failed to be written", async () => {
    harness = await startHarness(togetherSetup());
    await mkdir(join(harness.dirs.home, "evidence.jsonl"), { recursive: true });
    const job = await generate({ provider_options: { steps: 4 } });
    const { rm } = await import("node:fs/promises");
    await rm(join(harness.dirs.home, "evidence.jsonl"), { recursive: true });

    ok(await deleteJobs({ job_ids: [job.job_id] }));

    const listed = ok(await call("list_models", { model: "sdxl" }));
    expect(listed.models[0].option_statuses.accepted).toMatchObject([{ options: { steps: 4 }, job_id: job.job_id, job_deleted: true }]);
  });
});

describe("a lock left behind", () => {
  test("by a process long since gone, whose pid now names another, does not hold up Jobs", async () => {
    harness = await startHarness(togetherSetup());
    await mkdir(harness.dirs.home, { recursive: true });
    const stale = { pid: process.pid, token: "left-behind", at: Date.now() - 10 * 60_000 };
    await writeFile(join(harness.dirs.home, "jobs.lock"), JSON.stringify(stale));
    await writeFile(join(harness.dirs.home, "evidence.lock"), JSON.stringify(stale));

    const job = await generate();

    expect((await readHistory(harness)).map((record) => record.id)).toEqual([job.job_id]);
  }, 5_000);
});

