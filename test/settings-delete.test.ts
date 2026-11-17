import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readHistory, readHistoryLines, tinyPng } from "./helpers.ts";
import { startSettingsHarness, type SettingsHarness } from "./settings-harness.ts";
import { contentHash } from "../src/source-jobs.ts";

/** Deleting Jobs from the settings page (#67, #68), through the same deletion as `delete_jobs`. */

let harness: SettingsHarness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

function jobRecord(id: string, minute: number, overrides: Record<string, unknown> = {}) {
  return {
    type: "job",
    id,
    createdAt: new Date(Date.UTC(2026, 10, 1, 0, minute)).toISOString(),
    model: "gpt-image",
    provider: "openai",
    protocol: "openai-images",
    modelId: "gpt-image-1",
    modality: "image",
    prompt: `prompt of ${id}`,
    parameters: { n: 1, references: [], providerOptions: {} },
    durationMs: 1000,
    files: [],
    outcome: "completed",
    ...overrides,
  };
}

/** Starts the settings server over a Job history: `fox` with a saved image, a Comparison of `left` and `right` picked on `right`, `cat` running. */
async function start(): Promise<{ h: SettingsHarness; foxFile: string }> {
  const h = (harness = await startSettingsHarness());
  const folder = join(h.dirs.output, "2026-11-01");
  await mkdir(folder, { recursive: true });
  const foxFile = join(folder, "fox.png");
  await writeFile(foxFile, tinyPng);
  const lines = [
    jobRecord("fox", 1, { files: [foxFile], hashes: [contentHash(tinyPng)] }),
    { type: "rating", jobId: "fox", verdict: "good", reason: "nice", ratedAt: "2026-11-01T01:00:00.000Z" },
    jobRecord("left", 2, { comparison: "cmp" }),
    jobRecord("right", 3, { comparison: "cmp" }),
    { type: "pick", comparison: "cmp", jobId: "right", pickedAt: "2026-11-01T02:00:00.000Z" },
    // Run by this process, so a live session.
    jobRecord("cat", 4, { outcome: "running", owner: { pid: process.pid } }),
  ];
  await mkdir(h.dirs.home, { recursive: true });
  await writeFile(join(h.dirs.home, "jobs.jsonl"), lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return { h, foxFile };
}

describe("POST /api/jobs/delete with Job ids", () => {
  test("deletes the Jobs and returns the deletion report", async () => {
    const { h, foxFile } = await start();

    const response = await h.send("POST", "/api/jobs/delete", { body: { jobIds: ["fox"] } });

    expect(response.status).toBe(200);
    expect(response.json()).toEqual({
      deletedJobs: ["fox"],
      deletedFiles: [foxFile],
      alreadyGone: [],
      skippedFiles: [],
      runningJobs: [],
      notFound: [],
      picksRemoved: [],
      referencesOfOtherJobs: [],
    });
    expect(await Bun.file(foxFile).exists()).toBe(false);
    expect((await readHistoryLines(h)).some((line) => line.jobId === "fox" || line.id === "fox")).toBe(false);
  });

  test("leaves running Jobs and reports them", async () => {
    const { h } = await start();
    const response = await h.send("POST", "/api/jobs/delete", { body: { jobIds: ["cat", "fox"] } });
    expect(response.json()).toMatchObject({ deletedJobs: ["fox"], runningJobs: ["cat"] });
    expect((await readHistory(h)).map((job) => job.id)).toContain("cat");
  });

  test("deleting one Job of a Comparison keeps the others; deleting the picked one removes its Pick", async () => {
    const { h } = await start();
    expect((await h.send("POST", "/api/jobs/delete", { body: { jobIds: ["left"] } })).json()).toMatchObject({ picksRemoved: [] });
    expect((await readHistory(h)).map((job) => job.id)).toEqual(["fox", "right", "cat"]);

    const both = (await h.send("POST", "/api/jobs/delete", { body: { jobIds: ["right"] } })).json();
    expect(both.picksRemoved).toEqual([{ comparison: "cmp", jobId: "right" }]);
    expect((await readHistoryLines(h)).some((line) => line.type === "pick")).toBe(false);
  });

  test("refuses a body without Job ids, deleting nothing", async () => {
    const { h } = await start();
    for (const body of [{}, { jobIds: [] }, { jobIds: "fox" }]) {
      expect((await h.send("POST", "/api/jobs/delete", { body })).status).toBe(400);
    }
    expect((await readHistory(h)).map((job) => job.id)).toEqual(["fox", "left", "right", "cat"]);
  });

  test("follows the settings server's token and origin checks", async () => {
    const { h } = await start();
    expect((await h.send("POST", "/api/jobs/delete", { body: { jobIds: ["fox"] }, token: null })).status).toBe(403);
    expect((await h.send("POST", "/api/jobs/delete", { body: { jobIds: ["fox"] }, origin: "http://evil.example" })).status).toBe(403);
    expect((await h.send("POST", "/api/jobs/delete", { body: { jobIds: ["fox"] }, origin: null })).status).toBe(403);
    expect((await readHistory(h)).map((job) => job.id)).toContain("fox");
  });
});

describe("POST /api/jobs/delete with filters", () => {
  test("deletes exactly the Jobs matching them now, leaving running ones and reporting them", async () => {
    const { h } = await start();
    const other = jobRecord("dalle", 5, { model: "dalle-old", modelId: "dall-e-3" });
    await writeFile(join(h.dirs.home, "jobs.jsonl"), JSON.stringify(other) + "\n", { flag: "a" });

    const report = (await h.send("POST", "/api/jobs/delete", { body: { filter: { model: "gpt-image" } } })).json();

    expect(report.deletedJobs.sort()).toEqual(["fox", "left", "right"]);
    expect(report.runningJobs).toEqual(["cat"]);
    expect((await readHistory(h)).map((job) => job.id)).toEqual(["cat", "dalle"]);
  });

  test("combines filters, and with none deletes every Job not running", async () => {
    const { h } = await start();
    expect((await h.send("POST", "/api/jobs/delete", { body: { filter: { outcome: "completed", modality: "video" } } })).json().deletedJobs).toEqual([]);
    expect((await h.send("POST", "/api/jobs/delete", { body: { filter: {} } })).json().deletedJobs.sort()).toEqual(["fox", "left", "right"]);
    expect((await readHistory(h)).map((job) => job.id)).toEqual(["cat"]);
  });

  test("refuses Job ids and filters together, and a filter value it does not know", async () => {
    const { h } = await start();
    expect((await h.send("POST", "/api/jobs/delete", { body: { jobIds: ["fox"], filter: {} } })).status).toBe(400);
    expect((await h.send("POST", "/api/jobs/delete", { body: { filter: { outcome: "great" } } })).status).toBe(400);
    expect((await readHistory(h)).map((job) => job.id)).toEqual(["fox", "left", "right", "cat"]);
  });

  test("the Job history page says how many Jobs, Results and Picks deleting everything matching would remove", async () => {
    const { h } = await start();
    expect((await h.send("GET", "/api/jobs")).json().deletable).toEqual({ jobs: 3, results: 1, picks: 1 });
    expect((await h.send("GET", "/api/jobs?outcome=running")).json().deletable).toEqual({ jobs: 0, results: 0, picks: 0 });
    // With fox gone, the Comparison's Jobs and its Pick are left.
    await h.send("POST", "/api/jobs/delete", { body: { jobIds: ["fox"] } });
    expect((await h.send("GET", "/api/jobs")).json().deletable).toEqual({ jobs: 2, results: 0, picks: 1 });
  });
});

describe("a Job left running by a session that has ended", () => {
  test("is listed as interrupted, counts as deletable, and can be deleted", async () => {
    const { h } = await start();
    const child = Bun.spawn(["true"]);
    await child.exited;
    const orphan = jobRecord("orphan", 6, { outcome: "running", owner: { pid: child.pid } });
    // Recorded before Jobs named their process.
    const old = jobRecord("old", 7, { outcome: "running" });
    await writeFile(join(h.dirs.home, "jobs.jsonl"), [orphan, old].map((line) => JSON.stringify(line)).join("\n") + "\n", { flag: "a" });

    const listed = (await h.send("GET", "/api/jobs?outcome=running")).json();
    expect(listed.jobs.map((job: { id: string; interrupted?: boolean }) => [job.id, job.interrupted ?? false])).toEqual([
      ["old", true],
      ["orphan", true],
      ["cat", false],
    ]);
    expect(listed.deletable).toEqual({ jobs: 2, results: 0, picks: 0 });

    const report = (await h.send("POST", "/api/jobs/delete", { body: { jobIds: ["orphan", "old", "cat"] } })).json();
    expect(report.deletedJobs.sort()).toEqual(["old", "orphan"]);
    expect(report.runningJobs).toEqual(["cat"]);
  });
});
