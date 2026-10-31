import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Dirs } from "./dirs.ts";
import type { AspectRatio, ImageSize, ProviderErrorKind, ResumeHandle } from "./protocols/protocol.ts";

/**
 * The Job history, `jobs.jsonl`: append-only, one JSON record per line. A Job gets several records over its life
 * (running when it starts, running again once an asynchronous Provider accepts it, then completed or failed); the
 * latest one for an id is what it is now. Ratings are lines of their own, and the latest for a Job is its Rating now.
 * Every read of the history goes through this module.
 */

/** The `generate_image` parameters of a Job, as recorded in the Job history. */
export interface JobParameters {
  n: number;
  /** What the Agent asked for. */
  aspectRatio: AspectRatio;
  /** What was actually requested from the Provider. */
  size: ImageSize;
  /** Absolute paths of the reference images. */
  references: string[];
  /** Absolute folder the Agent asked to save into, when it gave one. */
  outputPath?: string;
  providerOptions: Record<string, unknown>;
}

/** One Job line of `jobs.jsonl`. */
export interface JobRecord {
  type: "job";
  id: string;
  createdAt: string;
  model: string;
  provider: string;
  protocol: string;
  modelId: string;
  prompt: string;
  parameters: JobParameters;
  /** So far, while the Job is running. */
  durationMs: number;
  files: string[];
  outcome: "running" | "completed" | "failed";
  /** While running: what the Protocol needs to pick the Job back up after a restart; absent for synchronous Protocols. */
  resume?: ResumeHandle;
  /** What the Provider says a completed Job cost, in its own unit, when it says. */
  cost?: number;
  /** Why a completed Job has fewer files than `parameters.n`. */
  shortfall?: string;
  error?: { kind: ProviderErrorKind; message: string };
}

export const verdicts = ["good", "bad"] as const;
export type Verdict = (typeof verdicts)[number];

/** Long enough for one line, short enough to stay one. */
export const ratingReasonMaxLength = 200;

/** One Rating line of `jobs.jsonl`: the User's verdict on a completed Job. A later one for the same Job supersedes it. */
export interface RatingRecord {
  type: "rating";
  jobId: string;
  verdict: Verdict;
  /** One line. */
  reason: string;
  ratedAt: string;
}

/** A Job as it is now, with its current Rating if the User has given one. */
export interface RatedJob {
  job: JobRecord;
  rating?: RatingRecord;
}

/** Why a Rating was not recorded. Its message is safe to show the Agent and the User. */
export class RatingError extends Error {
  constructor(
    readonly kind: "unknown-job" | "not-completed" | "invalid",
    message: string,
  ) {
    super(message);
    this.name = "RatingError";
  }
}

const historyPath = (dirs: Dirs) => join(dirs.data, "jobs.jsonl");

export async function appendHistory(dirs: Dirs, record: JobRecord | RatingRecord): Promise<void> {
  await mkdir(dirs.data, { recursive: true });
  await appendFile(historyPath(dirs), `${JSON.stringify(record)}\n`);
}

/** Every Job as its latest record says it is now, oldest first. Lines that cannot be read are skipped. */
export async function readJobs(dirs: Dirs): Promise<JobRecord[]> {
  return (await readRecords(dirs)).jobs;
}

/** One Job as its latest record says it is now, if the history has it. */
export async function readJob(dirs: Dirs, id: string): Promise<JobRecord | undefined> {
  return (await readJobs(dirs)).find((job) => job.id === id);
}

/** Every Job with its current Rating, most recently started first. */
export async function readRatedJobs(dirs: Dirs): Promise<RatedJob[]> {
  const { jobs, ratings } = await readRecords(dirs);
  return jobs
    .map((job) => ({ job, ...(ratings.has(job.id) ? { rating: ratings.get(job.id) } : {}) }))
    .sort((a, b) => Date.parse(b.job.createdAt) - Date.parse(a.job.createdAt));
}

/**
 * Records the User's verdict on a Job. Only a completed Job can be rated; the reason is kept to one line.
 * Throws {@link RatingError} when the Job is unknown, has not completed, or the reason is empty.
 */
export async function rateJob(
  dirs: Dirs,
  rating: { jobId: string; verdict: Verdict; reason: string },
  now: Date,
): Promise<RatingRecord> {
  const reason = rating.reason.replace(/\s+/g, " ").trim();
  if (reason === "") throw new RatingError("invalid", "Give a one-line reason for the Rating.");
  if (reason.length > ratingReasonMaxLength) {
    throw new RatingError("invalid", `Keep the reason to one line of at most ${ratingReasonMaxLength} characters.`);
  }
  const job = await readJob(dirs, rating.jobId);
  if (job === undefined) throw new RatingError("unknown-job", `litevision has no Job "${rating.jobId}".`);
  if (job.outcome === "running") {
    throw new RatingError("not-completed", `Job ${job.id} is still running; it can be rated once it has completed.`);
  }
  if (job.outcome === "failed") {
    throw new RatingError("not-completed", `Job ${job.id} failed and saved no images, so there is nothing to rate.`);
  }
  const record: RatingRecord = { type: "rating", jobId: job.id, verdict: rating.verdict, reason, ratedAt: now.toISOString() };
  await appendHistory(dirs, record);
  return record;
}

/** One pass over `jobs.jsonl`: the latest record of each Job, and the latest Rating of each. */
async function readRecords(dirs: Dirs): Promise<{ jobs: JobRecord[]; ratings: Map<string, RatingRecord> }> {
  let text: string;
  try {
    text = await readFile(historyPath(dirs), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { jobs: [], ratings: new Map() };
    throw error;
  }
  const jobs = new Map<string, JobRecord>();
  const ratings = new Map<string, RatingRecord>();
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (isRatingRecord(record)) {
      ratings.set(record.jobId, record);
      continue;
    }
    if (!isJobRecord(record)) continue;
    // Re-inserting moves the Job to where its latest record is, so a Job is ordered by when it last changed.
    jobs.delete(record.id);
    jobs.set(record.id, record);
  }
  return { jobs: [...jobs.values()], ratings };
}

function isJobRecord(value: unknown): value is JobRecord {
  const record = value as Partial<JobRecord> | null;
  return typeof record === "object" && record !== null && record.type === "job" && typeof record.id === "string";
}

function isRatingRecord(value: unknown): value is RatingRecord {
  const record = value as Partial<RatingRecord> | null;
  return (
    typeof record === "object" &&
    record !== null &&
    record.type === "rating" &&
    typeof record.jobId === "string" &&
    verdicts.includes(record.verdict as Verdict) &&
    typeof record.reason === "string"
  );
}

/** Which upstream model a Job ran on; an Alias may be renamed, so it is not part of this. */
export interface ModelKey {
  provider: string;
  protocol: string;
  modelId: string;
}

/**
 * The `provider_options` known to work with a Model: every key a completed Job sent, with the value it most recently
 * sent. "Works" means the Provider accepted it and returned images; whether it changed the result is not known.
 */
export function knownGoodOptions(jobs: JobRecord[], model: ModelKey): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  for (const job of jobs) {
    if (job.outcome !== "completed") continue;
    if (job.provider !== model.provider || job.protocol !== model.protocol || job.modelId !== model.modelId) continue;
    Object.assign(options, job.parameters?.providerOptions);
  }
  return options;
}
