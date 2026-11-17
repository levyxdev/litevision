import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startSettingsHarness, type SettingsHarness } from "./settings-harness.ts";

/** The Job history tab loads a page at a time and filters (#66). */

let harness: SettingsHarness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

/** A Job's latest record, started `minute` minutes into the day, so later minutes are newer. */
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

async function start(lines: unknown[]): Promise<SettingsHarness> {
  const h = (harness = await startSettingsHarness());
  await mkdir(h.dirs.home, { recursive: true });
  await writeFile(join(h.dirs.home, "jobs.jsonl"), lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return h;
}

interface Page {
  jobs: Array<{ id: string; comparison?: { id: string; size: number } }>;
  total: number;
  totalJobs: number;
  nextOffset: number | null;
  aliases: string[];
}

async function page(h: SettingsHarness, query = ""): Promise<Page> {
  const response = await h.send("GET", `/api/jobs${query}`);
  expect(response.status).toBe(200);
  return response.json<Page>();
}

const ids = (listed: Page) => listed.jobs.map((job) => job.id);

describe("GET /api/jobs, a page at a time", () => {
  test("gives 20 entries, newest first, with the total and where the next page starts", async () => {
    const h = await start(Array.from({ length: 25 }, (_, i) => jobRecord(`j${i}`, i)));

    const first = await page(h);
    expect(ids(first)).toEqual(Array.from({ length: 20 }, (_, i) => `j${24 - i}`));
    expect(first).toMatchObject({ total: 25, totalJobs: 25, nextOffset: 20 });

    const second = await page(h, "?offset=20");
    expect(ids(second)).toEqual(["j4", "j3", "j2", "j1", "j0"]);
    expect(second.nextOffset).toBeNull();
  });

  test("counts a Comparison as one entry and never splits it across pages", async () => {
    const singles = Array.from({ length: 19 }, (_, i) => jobRecord(`j${i}`, 10 + i));
    const comparison = ["c1", "c2", "c3"].map((id, i) => jobRecord(id, i, { comparison: "cmp" }));
    const h = await start([...comparison, ...singles, jobRecord("oldest", -5)]);

    const first = await page(h);
    expect(ids(first)).toEqual([...Array.from({ length: 19 }, (_, i) => `j${18 - i}`), "c1", "c2", "c3"]);
    expect(first).toMatchObject({ total: 21, totalJobs: 23, nextOffset: 20 });
    expect(first.jobs.at(-1)!.comparison).toMatchObject({ id: "cmp", size: 3 });
    expect(ids(await page(h, "?offset=20"))).toEqual(["oldest"]);
  });
});

describe("GET /api/jobs, filtered", () => {
  const history = [
    jobRecord("fox", 1),
    jobRecord("owl", 2, { outcome: "failed", error: { kind: "other", message: "timed out" } }),
    jobRecord("old", 3, { model: "dalle-old", modelId: "dall-e-3" }),
    jobRecord("clip", 4, { model: "wan", modality: "video", provider: "together", protocol: "together", modelId: "wan" }),
    jobRecord("legacy", 5, { modality: undefined }),
    jobRecord("busy", 6, { outcome: "running" }),
    jobRecord("cmp-a", 7, { comparison: "cmp" }),
    jobRecord("cmp-b", 8, { comparison: "cmp", model: "dalle-old", modelId: "dall-e-3" }),
  ];

  test("by the Alias each Job recorded, including Aliases no Model has any more", async () => {
    const h = await start(history);
    const listed = await page(h, "?model=dalle-old");
    expect(ids(listed)).toEqual(["cmp-b", "old"]);
    expect(listed).toMatchObject({ total: 2, totalJobs: 2 });
    expect(listed.jobs[0]!.comparison).toMatchObject({ id: "cmp", size: 2 });
    expect(listed.aliases).toEqual(["dalle-old", "gpt-image", "wan"]);
  });

  test("by outcome and by Modality, a Job recorded before videos counting as an image", async () => {
    const h = await start(history);
    expect(ids(await page(h, "?outcome=failed"))).toEqual(["owl"]);
    expect(ids(await page(h, "?outcome=completed")).sort()).toEqual(["clip", "cmp-a", "cmp-b", "fox", "legacy", "old"]);
    expect(ids(await page(h, "?modality=video"))).toEqual(["clip"]);
    expect(ids(await page(h, "?modality=image"))).not.toContain("clip");
    expect(ids(await page(h, "?modality=image"))).toContain("legacy");
  });

  test("by several filters together", async () => {
    const h = await start(history);
    expect(ids(await page(h, "?model=gpt-image&outcome=completed&modality=image"))).toEqual(["cmp-a", "legacy", "fox"]);
    const none = await page(h, "?model=wan&outcome=failed");
    expect(none).toMatchObject({ jobs: [], total: 0, totalJobs: 0, nextOffset: null });
  });

  test("refuses a filter value it does not know", async () => {
    const h = await start(history);
    for (const query of ["?outcome=great", "?modality=audio", "?offset=-1", "?offset=x"]) {
      expect((await h.send("GET", `/api/jobs${query}`)).status).toBe(400);
    }
  });
});
