import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readHistoryLines, tinyPng } from "./helpers.ts";
import { startSettingsHarness, type SettingsHarness } from "./settings-harness.ts";

let harness: SettingsHarness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

const ratedAt = new Date("2026-10-30T12:00:00.000Z");

/** A Job's latest record as the Job runner writes it. */
function jobRecord(id: string, createdAt: string, overrides: Record<string, unknown> = {}) {
  return {
    type: "job",
    id,
    createdAt,
    model: "gpt-image",
    provider: "openai",
    protocol: "openai-images",
    modelId: "gpt-image-1",
    prompt: `prompt of ${id}`,
    parameters: { n: 1, aspectRatio: "1:1", size: { width: 1024, height: 1024, aspectRatio: "1:1" }, references: [], providerOptions: {} },
    durationMs: 12_300,
    files: [],
    outcome: "completed",
    ...overrides,
  };
}

/** Starts the settings server over a Job history: `fox` completed with two images, then `owl` failed, then `cat` running. */
async function start(): Promise<{ h: SettingsHarness; foxFiles: string[] }> {
  const h = (harness = await startSettingsHarness({ now: () => ratedAt }));
  const folder = join(h.dirs.output, "2026-10-30");
  await mkdir(folder, { recursive: true });
  const foxFiles = [join(folder, "fox-1.png"), join(folder, "fox-2.png")];
  for (const file of foxFiles) await writeFile(file, tinyPng);

  const lines = [
    jobRecord("fox", "2026-10-30T09:00:00.000Z", { outcome: "running", durationMs: 0 }),
    jobRecord("fox", "2026-10-30T09:00:00.000Z", { files: foxFiles }),
    jobRecord("owl", "2026-10-30T10:00:00.000Z", { outcome: "failed", error: { kind: "auth", message: "The key was rejected." } }),
    { type: "rating", jobId: "fox", verdict: "good", reason: "lovely", ratedAt: "2026-10-30T09:05:00.000Z" },
    jobRecord("cat", "2026-10-30T11:00:00.000Z", { outcome: "running", durationMs: 500 }),
    { type: "rating", jobId: "fox", verdict: "bad", reason: "the tail is missing", ratedAt: "2026-10-30T09:10:00.000Z" },
  ];
  await mkdir(h.dirs.data, { recursive: true });
  await writeFile(join(h.dirs.data, "jobs.jsonl"), lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return { h, foxFiles };
}

describe("Job history", () => {
  test("lists Jobs newest first with prompt, Model, duration, thumbnails and the current Rating", async () => {
    const { h, foxFiles } = await start();
    const response = await h.send("GET", "/api/jobs");

    expect(response.status).toBe(200);
    const { jobs } = response.json();
    expect(jobs.map((job: { id: string }) => job.id)).toEqual(["cat", "owl", "fox"]);
    expect(jobs[2]).toEqual({
      id: "fox",
      createdAt: "2026-10-30T09:00:00.000Z",
      model: "gpt-image",
      modelId: "gpt-image-1",
      provider: "openai",
      prompt: "prompt of fox",
      durationMs: 12_300,
      outcome: "completed",
      files: [
        { path: foxFiles[0], thumbnail: "/api/jobs/fox/files/0" },
        { path: foxFiles[1], thumbnail: "/api/jobs/fox/files/1" },
      ],
      // The later Rating supersedes the earlier one.
      rating: { verdict: "bad", reason: "the tail is missing", ratedAt: "2026-10-30T09:10:00.000Z" },
    });
    expect(jobs[1]).toMatchObject({ id: "owl", outcome: "failed", error: "The key was rejected.", files: [], rating: null });
    expect(jobs[0]).toMatchObject({ id: "cat", outcome: "running", rating: null });
  });

  test("is empty before any Job has run", async () => {
    harness = await startSettingsHarness();
    expect((await harness.send("GET", "/api/jobs")).json()).toEqual({ jobs: [] });
  });

  test("the page has a Job history area", async () => {
    harness = await startSettingsHarness();
    const page = await harness.send("GET", "/");
    expect(page.text).toContain('id="history"');
    expect(page.text).toContain("/api/jobs");
  });
});

describe("rating from the page", () => {
  test("records the same structured Rating record as rate_job, and the listing shows it", async () => {
    const { h } = await start();
    const response = await h.send("POST", "/api/jobs/fox/rating", { body: { verdict: "good", reason: " sharp\nand  clean " } });

    expect(response.status).toBe(200);
    const rating = { verdict: "good", reason: "sharp and clean", ratedAt: ratedAt.toISOString() };
    expect(response.json()).toEqual({ rating });
    expect((await readHistoryLines(h)).at(-1)).toEqual({ type: "rating", jobId: "fox", ...rating });

    const { jobs } = (await h.send("GET", "/api/jobs")).json();
    expect(jobs.find((job: { id: string }) => job.id === "fox").rating).toEqual(rating);
  });

  test("an unknown Job is 404, a failed or running Job is 409, and nothing is recorded", async () => {
    const { h } = await start();
    const before = (await readHistoryLines(h)).length;
    const body = { verdict: "good", reason: "nice" };

    expect((await h.send("POST", "/api/jobs/nope/rating", { body })).status).toBe(404);

    const failed = await h.send("POST", "/api/jobs/owl/rating", { body });
    expect(failed.status).toBe(409);
    expect(failed.json().error).toContain("failed");

    const running = await h.send("POST", "/api/jobs/cat/rating", { body });
    expect(running.status).toBe(409);
    expect(running.json().error).toContain("still running");

    expect((await readHistoryLines(h)).length).toBe(before);
  });

  test("a verdict other than good or bad, or an empty reason, is rejected", async () => {
    const { h } = await start();
    expect((await h.send("POST", "/api/jobs/fox/rating", { body: { verdict: "meh", reason: "fine" } })).status).toBe(400);
    expect((await h.send("POST", "/api/jobs/fox/rating", { body: { verdict: "good", reason: "   " } })).status).toBe(400);
  });

  test("is rejected from a foreign Origin", async () => {
    const { h } = await start();
    const response = await h.send("POST", "/api/jobs/fox/rating", {
      body: { verdict: "good", reason: "nice" },
      origin: "https://evil.example",
    });
    expect(response.status).toBe(403);
  });
});

describe("thumbnails", () => {
  test("serve a file recorded in the Job history, with the token in the URL as an <img> sends it", async () => {
    const { h } = await start();
    const response = await h.send("GET", `/api/jobs/fox/files/1?token=${h.token}`, { token: null });

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("image/png");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.bytes).toEqual(tinyPng);
  });

  test("are refused without the token, with a wrong Host or from a foreign Origin", async () => {
    const { h } = await start();
    expect((await h.send("GET", "/api/jobs/fox/files/0", { token: null })).status).toBe(403);
    expect((await h.send("GET", `/api/jobs/fox/files/0?token=wrong`, { token: null })).status).toBe(403);
    expect((await h.send("GET", "/api/jobs/fox/files/0", { host: "evil.example" })).status).toBe(403);
    expect((await h.send("GET", "/api/jobs/fox/files/0", { origin: "https://evil.example" })).status).toBe(403);
  });

  test("only exist for files the Job history records", async () => {
    const { h } = await start();
    expect((await h.send("GET", "/api/jobs/fox/files/2")).status).toBe(404);
    expect((await h.send("GET", "/api/jobs/fox/files/-1")).status).toBe(404);
    expect((await h.send("GET", "/api/jobs/owl/files/0")).status).toBe(404);
    expect((await h.send("GET", "/api/jobs/nope/files/0")).status).toBe(404);
    expect((await h.send("GET", "/api/jobs/fox/files/..%2F..%2Fconfig%2Fcredentials.json")).status).toBe(404);
  });

  test("of a file that has since been deleted are 404, so the page shows a placeholder", async () => {
    const { h, foxFiles } = await start();
    await writeFile(join(h.dirs.data, "jobs.jsonl"), JSON.stringify(jobRecord("gone", "2026-10-30T12:00:00.000Z", { files: [foxFiles[0] + ".deleted"] })) + "\n");
    expect((await h.send("GET", "/api/jobs/gone/files/0")).status).toBe(404);
  });
});
