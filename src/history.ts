import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Dirs } from "./dirs.ts";
import type { MediaFacts } from "./media.ts";
import type { AspectRatio, ImageSize, Modality, ProviderErrorKind, ResumeHandle } from "./protocols/protocol.ts";

/**
 * The Job history, `jobs.jsonl`: append-only, one JSON record per line. A Job gets several records over its life
 * (running when it starts, running again once an asynchronous Provider accepts it, then completed or failed); the
 * latest one for an id is what it is now. Ratings are lines of their own: the latest for a Job, or for one result of it,
 * is its Rating now.
 * Every read of the history goes through this module.
 */

/** The `generate_image` or `generate_video` parameters of a Job, as recorded in the Job history. */
export interface JobParameters {
  /** Always 1 for a video Job. */
  n: number;
  /** What the Agent asked for. */
  aspectRatio: AspectRatio;
  /** What was actually requested from the Provider. */
  size: ImageSize;
  /** Absolute paths of the reference images. */
  references: string[];
  /** Video Jobs only: the length requested from the Provider, in seconds. */
  seconds?: number;
  /** Video Jobs only: the resolution tier requested, when the Model takes one by name. */
  resolution?: string;
  /** Video Jobs only: true when the first frame decides the video's shape, so it is not checked (ADR 0006). */
  followsFirstFrame?: true;
  /** Video Jobs only: absolute paths of the first and last frames, when given. */
  firstFrame?: string;
  lastFrame?: string;
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
  /** Absent for Jobs recorded before videos existed, which are all image Jobs. */
  modality?: Modality;
  prompt: string;
  parameters: JobParameters;
  /** The id of the Comparison the Job was started in (ADR 0009); absent for a Job started on its own. */
  comparison?: string;
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
  /** What each saved file turned out to be, in the order of `files`; a file litevision could not read is `null`. */
  observed?: Array<MediaFacts | null>;
  /** How the result differs from what was requested (ADR 0006); absent when it matched as far as litevision can tell. */
  mismatch?: string;
  error?: { kind: ProviderErrorKind; message: string };
}

export const verdicts = ["good", "bad"] as const;
export type Verdict = (typeof verdicts)[number];

/** Long enough for one line, short enough to stay one. */
export const ratingReasonMaxLength = 200;

/**
 * One Rating line of `jobs.jsonl`: the User's verdict on a completed Job, or on one result of it. A later one for the
 * same Job and result supersedes it; a Rating of the whole Job and one of a single result stand side by side.
 */
export interface RatingRecord {
  type: "rating";
  jobId: string;
  /** Which result, from 1 in the order of the Job's `files`; absent when the Rating is about the whole Job. */
  result?: number;
  verdict: Verdict;
  /** One line. */
  reason: string;
  ratedAt: string;
}

/** A Job as it is now, with its current Ratings. */
export interface RatedJob {
  job: JobRecord;
  /** At most one for the whole Job and one for each result, in the order they were recorded. */
  ratings: RatingRecord[];
}

/** The current Rating of the whole Job, or of one result when `result` is given. */
export function ratingOf({ ratings }: RatedJob, result?: number): RatingRecord | undefined {
  return ratings.find((rating) => rating.result === result);
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

/** Every Job with its current Ratings, most recently started first. */
export async function readRatedJobs(dirs: Dirs): Promise<RatedJob[]> {
  const { jobs, ratings } = await readRecords(dirs);
  return jobs
    .map((job) => ({ job, ratings: [...(ratings.get(job.id)?.values() ?? [])] }))
    .sort((a, b) => Date.parse(b.job.createdAt) - Date.parse(a.job.createdAt));
}

/**
 * Records the User's verdict on a Job, or with `result` on one of its results. Only a completed Job can be rated; the
 * reason is kept to one line. Throws {@link RatingError} when the Job is unknown, has not completed, has no such
 * result, or the reason is empty.
 */
export async function rateJob(
  dirs: Dirs,
  rating: { jobId: string; result?: number; verdict: Verdict; reason: string },
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
  const { result } = rating;
  if (result !== undefined && !(Number.isInteger(result) && result >= 1 && result <= job.files.length)) {
    const count = job.files.length === 1 ? "1 result" : `${job.files.length} results`;
    throw new RatingError("invalid", `Job ${job.id} has ${count}, numbered from 1 in the order of its files.`);
  }
  const record: RatingRecord = {
    type: "rating",
    jobId: job.id,
    ...(result === undefined ? {} : { result }),
    verdict: rating.verdict,
    reason,
    ratedAt: now.toISOString(),
  };
  await appendHistory(dirs, record);
  return record;
}

/**
 * One pass over `jobs.jsonl`: the latest record of each Job, and per Job its latest Rating of the whole Job and of each
 * result, keyed by result number (0 for the whole Job) in the order they were recorded.
 */
async function readRecords(dirs: Dirs): Promise<{ jobs: JobRecord[]; ratings: Map<string, Map<number, RatingRecord>> }> {
  let text: string;
  try {
    text = await readFile(historyPath(dirs), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { jobs: [], ratings: new Map() };
    throw error;
  }
  const jobs = new Map<string, JobRecord>();
  const ratings = new Map<string, Map<number, RatingRecord>>();
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (isRatingRecord(record)) {
      const ofJob = ratings.get(record.jobId) ?? new Map<number, RatingRecord>();
      ratings.set(record.jobId, ofJob);
      // Re-inserting keeps the Ratings in the order they were last recorded.
      ofJob.delete(record.result ?? 0);
      ofJob.set(record.result ?? 0, record);
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
    typeof record.reason === "string" &&
    (record.result === undefined || (Number.isInteger(record.result) && record.result >= 1))
  );
}

/** Which upstream model a Job ran on; an Alias may be renamed, so it is not part of this. */
export interface ModelKey {
  provider: string;
  protocol: string;
  modelId: string;
}

function ranOn(job: JobRecord, model: ModelKey): boolean {
  return job.provider === model.provider && job.protocol === model.protocol && job.modelId === model.modelId;
}

/** A current Rating with the Job it is about. */
export interface RatingWithJob {
  rating: RatingRecord;
  job: JobRecord;
}

/**
 * A Model's most recent current Ratings, newest first, at most `limit` (ADR 0008). A Model is followed by Provider,
 * Protocol and model id, so its Ratings survive renaming its Alias.
 */
export function recentRatings(jobs: RatedJob[], model: ModelKey, limit: number): RatingWithJob[] {
  return jobs
    .filter(({ job }) => ranOn(job, model))
    .flatMap(({ job, ratings }) => ratings.map((rating) => ({ rating, job })))
    .sort((a, b) => Date.parse(b.rating.ratedAt) - Date.parse(a.rating.ratedAt))
    .slice(0, limit);
}

/** One `provider_options` key whose latest value is in doubt, and why. */
export interface SuspectOption {
  value: unknown;
  /** Why it is suspect: the User rated a Job that sent it bad, or the latest Job that sent it did not match. */
  cause: "rating" | "mismatch";
  /** The Rating's reason in the User's words, or how the result differed from the request. */
  reason: string;
  jobId: string;
}

/** What the Job history says about a Model's `provider_options` (ADR 0006). */
export interface OptionsRecord {
  /** Known-good Options: each key with the value it most recently sent from a Job that matched its request. */
  knownGood: Record<string, unknown>;
  /** Keys whose latest value the User rated bad and has not rated good since, or whose latest Job did not match. */
  suspect: Record<string, SuspectOption>;
}

/**
 * The Rating that speaks for a Job's options: the latest of the whole Job, or of its only result. The results of one
 * Job share its options, so a Rating of one result among several says more about chance than about them (ADR 0006).
 */
function optionsRating({ job, ratings }: RatedJob): RatingRecord | undefined {
  return ratings.findLast((rating) => rating.result === undefined || (rating.result === 1 && job.files.length === 1));
}

/**
 * Known-good and suspect `provider_options` for a Model, oldest Job first (ADR 0006). Each key's latest value counts,
 * and only a Rating of the whole Job, or of its only result, counts for its options (see {@link optionsRating}).
 * A value the User rated bad stays suspect, whenever it is sent again, until the User rates a Job that sent it good:
 * no Job without a Rating clears the User's verdict, matching or not. Otherwise a value is suspect when its latest Job
 * did not match its request, and Known-good when it did.
 */
export function optionsRecord(jobs: RatedJob[], model: ModelKey): OptionsRecord {
  const state = new Map<string, { value: unknown; suspect?: SuspectOption }>();
  /** Per key, the values the User rated bad and not good since, by their JSON. */
  const ratedBad = new Map<string, Map<string, SuspectOption>>();
  const ordered = [...jobs].sort((a, b) => Date.parse(a.job.createdAt) - Date.parse(b.job.createdAt));
  for (const ratedJob of ordered) {
    const { job } = ratedJob;
    if (job.outcome !== "completed") continue;
    const rating = optionsRating(ratedJob);
    if (!ranOn(job, model)) continue;
    for (const [key, value] of Object.entries(job.parameters?.providerOptions ?? {})) {
      const asJson = JSON.stringify(value);
      const badValues = ratedBad.get(key) ?? new Map<string, SuspectOption>();
      ratedBad.set(key, badValues);
      if (rating?.verdict === "bad") badValues.set(asJson, { value, cause: "rating", reason: rating.reason, jobId: job.id });
      if (rating?.verdict === "good") badValues.delete(asJson);

      const verdict = badValues.get(asJson);
      if (verdict !== undefined) state.set(key, { value, suspect: verdict });
      else if (job.mismatch !== undefined && rating?.verdict !== "good") {
        state.set(key, { value, suspect: { value, cause: "mismatch", reason: job.mismatch, jobId: job.id } });
      } else state.set(key, { value });
    }
  }
  const record: OptionsRecord = { knownGood: {}, suspect: {} };
  for (const [key, { value, suspect }] of state) {
    if (suspect === undefined) record.knownGood[key] = value;
    else record.suspect[key] = suspect;
  }
  return record;
}
