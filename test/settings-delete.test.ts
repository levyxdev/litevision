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
    jobRecord("cat", 4, { outcome: "running" }),
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
