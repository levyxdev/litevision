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
      modality: "image",
      files: [
        { path: foxFiles[0], thumbnail: "/api/jobs/fox/files/0", rating: null },
        { path: foxFiles[1], thumbnail: "/api/jobs/fox/files/1", rating: null },
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

  test("rates one result, which the listing shows on that file beside the whole Job's Rating", async () => {
    const { h } = await start();
    const response = await h.send("POST", "/api/jobs/fox/rating", { body: { result: 2, verdict: "good", reason: "the second one is great" } });

    expect(response.status).toBe(200);
    const rating = { verdict: "good", reason: "the second one is great", ratedAt: ratedAt.toISOString() };
    expect(response.json()).toEqual({ rating });
    expect((await readHistoryLines(h)).at(-1)).toEqual({ type: "rating", jobId: "fox", result: 2, ...rating });

    const { jobs } = (await h.send("GET", "/api/jobs")).json();
    const fox = jobs.find((job: { id: string }) => job.id === "fox");
    expect(fox.files.map((file: { rating: unknown }) => file.rating)).toEqual([null, rating]);
    // The whole Job's Rating is untouched by a Rating of one result.
    expect(fox.rating).toEqual({ verdict: "bad", reason: "the tail is missing", ratedAt: "2026-10-30T09:10:00.000Z" });
  });

  test("a later Rating of the same result supersedes the earlier one in the listing", async () => {
    const { h } = await start();
    await h.send("POST", "/api/jobs/fox/rating", { body: { result: 1, verdict: "good", reason: "nice" } });
    await h.send("POST", "/api/jobs/fox/rating", { body: { result: 1, verdict: "bad", reason: "six legs" } });

    const { jobs } = (await h.send("GET", "/api/jobs")).json();
    const fox = jobs.find((job: { id: string }) => job.id === "fox");
    expect(fox.files.map((file: { rating: { reason: string } | null }) => file.rating?.reason ?? null)).toEqual(["six legs", null]);
  });

  test("a result outside the Job's files is rejected, and nothing is recorded", async () => {
    const { h } = await start();
    const before = (await readHistoryLines(h)).length;

    const response = await h.send("POST", "/api/jobs/fox/rating", { body: { result: 3, verdict: "good", reason: "nice" } });
    expect(response.status).toBe(400);
    expect(response.json().error).toContain("2 results");
    expect((await h.send("POST", "/api/jobs/fox/rating", { body: { result: 1.5, verdict: "good", reason: "nice" } })).status).toBe(400);

    expect((await readHistoryLines(h)).length).toBe(before);
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

describe("Comparisons in the Job history (ADR 0009)", () => {
  const pickedAt = ratedAt.toISOString();

  /**
   * Comparison `cmp`: `left` (two images) and `right`, with a Job started on its own between them, and one before and
   * after. `failed` is a third Job of the Comparison that saved nothing.
   */
  async function startWithComparison(extra: Array<Record<string, unknown>> = []): Promise<SettingsHarness> {
    const h = (harness = await startSettingsHarness({ now: () => ratedAt }));
    const lines = [
      jobRecord("early", "2026-10-30T07:00:00.000Z"),
      jobRecord("left", "2026-10-30T08:00:00.000Z", { comparison: "cmp", files: ["/out/left-1.png", "/out/left-2.png"] }),
      jobRecord("between", "2026-10-30T08:00:00.500Z"),
      jobRecord("right", "2026-10-30T08:00:01.000Z", { comparison: "cmp", model: "dall-e", modelId: "dall-e-3", files: ["/out/right-1.png"] }),
      jobRecord("failed", "2026-10-30T08:00:00.200Z", { comparison: "cmp", outcome: "failed", error: { kind: "auth", message: "no" } }),
      jobRecord("late", "2026-10-30T09:00:00.000Z"),
      ...extra,
    ];
    await mkdir(h.dirs.data, { recursive: true });
    await writeFile(join(h.dirs.data, "jobs.jsonl"), lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
    return h;
  }

  const listed = async (h: SettingsHarness) => (await h.send("GET", "/api/jobs")).json().jobs as Array<Record<string, any>>;

  test("lists a Comparison's Jobs together, in the order they started, where its newest Job is", async () => {
    const h = await startWithComparison();
    const jobs = await listed(h);

    expect(jobs.map((job) => job.id)).toEqual(["late", "left", "failed", "right", "between", "early"]);
    for (const job of jobs.slice(1, 4)) expect(job.comparison).toEqual({ id: "cmp", pick: null });
    expect(jobs[0]).not.toHaveProperty("comparison");
    expect(jobs[4]).not.toHaveProperty("comparison");
  });

  test("picking from the page records the same structured Pick record as pick_result, and the listing shows it", async () => {
    const h = await startWithComparison();

    const response = await h.send("POST", "/api/comparisons/cmp/pick", { body: { jobId: "left", result: 2 } });

    expect(response.status).toBe(200);
    expect(response.json()).toEqual({ pick: { jobId: "left", result: 2, pickedAt } });
    expect((await readHistoryLines(h)).at(-1)).toEqual({ type: "pick", comparison: "cmp", jobId: "left", result: 2, pickedAt });
    const jobs = await listed(h);
    for (const id of ["left", "failed", "right"]) {
      expect(jobs.find((job) => job.id === id)!.comparison).toEqual({ id: "cmp", pick: { jobId: "left", result: 2, pickedAt } });
    }
    // A Pick is not a Rating.
    expect(jobs.find((job) => job.id === "left")!.rating).toBeNull();
  });

  test("a later Pick supersedes the earlier one in the listing", async () => {
    const h = await startWithComparison([{ type: "pick", comparison: "cmp", jobId: "left", pickedAt: "2026-10-30T08:30:00.000Z" }]);

    expect((await listed(h)).find((job) => job.id === "right")!.comparison.pick).toEqual({ jobId: "left", pickedAt: "2026-10-30T08:30:00.000Z" });
    expect((await h.send("POST", "/api/comparisons/cmp/pick", { body: { jobId: "right" } })).status).toBe(200);
    expect((await listed(h)).find((job) => job.id === "left")!.comparison.pick).toEqual({ jobId: "right", pickedAt });
  });

  test("an unknown Comparison is 404, a Job outside it or a result it lacks is 400, a failed Job is 409, and nothing is recorded", async () => {
    const h = await startWithComparison();
    const before = (await readHistoryLines(h)).length;

    expect((await h.send("POST", "/api/comparisons/nope/pick", { body: { jobId: "left" } })).status).toBe(404);
    const outside = await h.send("POST", "/api/comparisons/cmp/pick", { body: { jobId: "between" } });
    expect(outside.status).toBe(400);
    expect(outside.json().error).toContain("not part of Comparison cmp");
    expect((await h.send("POST", "/api/comparisons/cmp/pick", { body: { jobId: "left", result: 3 } })).status).toBe(400);
    expect((await h.send("POST", "/api/comparisons/cmp/pick", { body: { jobId: "left", result: 0 } })).status).toBe(400);
    expect((await h.send("POST", "/api/comparisons/cmp/pick", { body: {} })).status).toBe(400);
    expect((await h.send("POST", "/api/comparisons/cmp/pick", { body: { jobId: "failed" } })).status).toBe(409);
    expect((await h.send("POST", "/api/comparisons/cmp/pick", { body: { jobId: "left" }, origin: "https://evil.example" })).status).toBe(403);

    expect((await readHistoryLines(h)).length).toBe(before);
  });

  test("the page groups a Comparison and posts Picks", async () => {
    harness = await startSettingsHarness();
    const page = (await harness.send("GET", "/")).text;
    expect(page).toContain("/api/comparisons/");
    expect(page).toContain("/pick");
    expect(page).toContain("Comparison");
  });
});
