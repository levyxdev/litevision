import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { Dirs } from "../dirs.ts";
import {
  PickError,
  pickResult,
  rateJob,
  RatingError,
  ratingOf,
  ratingReasonMaxLength,
  readJob,
  matchesFilter,
  readRatedJobs,
  verdicts,
  type JobFilter,
  type PickRecord,
  type RatingRecord,
} from "../history.ts";
import { fileTypeOf } from "../media.ts";
import { modalities, type Modality } from "../protocols/protocol.ts";
import { SettingsError } from "./providers.ts";

/**
 * The settings page's Job history area: Jobs newest first, a Comparison's Jobs together, their images or videos, Ratings
 * and Picks, and rating and picking from the page.
 */

export const rateJobInput = z.object({
  /** Which result, from 1 in the order of the Job's files; absent to rate the whole Job. */
  result: z.number({ message: "Choose a result by its number." }).int("Choose a result by its number.").positive("Choose a result by its number.").optional(),
  verdict: z.enum(verdicts, { message: "Choose good or bad." }),
  reason: z.string().max(ratingReasonMaxLength, `Keep the reason to at most ${ratingReasonMaxLength} characters.`),
});

export const pickInput = z.object({
  jobId: z.string({ message: "Choose one of the Comparison's Jobs." }).min(1, "Choose one of the Comparison's Jobs."),
  /** Which result of that Job, from 1 in the order of its files; absent to pick the whole Job. */
  result: z.number({ message: "Choose a result by its number." }).int("Choose a result by its number.").positive("Choose a result by its number.").optional(),
});

export interface ListedPick {
  jobId: string;
  result?: number;
  pickedAt: string;
}

export interface ListedRating {
  verdict: RatingRecord["verdict"];
  reason: string;
  ratedAt: string;
}

export interface ListedJob {
  id: string;
  createdAt: string;
  model: string;
  modelId: string;
  provider: string;
  prompt: string;
  durationMs: number;
  outcome: "running" | "completed" | "failed";
  /** Image Jobs make images, video Jobs one video. */
  modality: Modality;
  /** `thumbnail` is the path the settings server serves the file at; the page adds its token to it. `rating` is this result's own. */
  files: Array<{ path: string; thumbnail: string; rating: ListedRating | null }>;
  /** The whole Job's Rating. */
  rating: ListedRating | null;
  /** Why a failed Job failed. */
  error?: string;
  /** Why a completed Job has fewer images than asked for. */
  shortfall?: string;
  /** How a completed Job's result differs from its request (ADR 0006). */
  mismatch?: string;
  /**
   * For a Job of a Comparison: the Comparison's id, how many Jobs it has in the Job history (filters may show fewer),
   * and its current Pick, whichever of its Jobs that is.
   */
  comparison?: { id: string; size: number; pick: ListedPick | null };
}

/** How many entries, a Job or a whole Comparison each, one page of the Job history holds. */
export const jobHistoryPageSize = 20;

const outcomes = ["completed", "failed", "running"] as const;

/** Which Jobs the Job history tab shows, or deletes: those matching every filter given. */
export const jobFilterInput = z.object({
  /** The Alias the Job recorded, whether or not a Model has it now. */
  model: z.string().min(1).optional(),
  outcome: z.enum(outcomes, { message: "Choose completed, failed or running." }).optional(),
  modality: z.enum(modalities, { message: "Choose image or video." }).optional(),
}) satisfies z.ZodType<JobFilter>;

export const jobHistoryQuery = jobFilterInput.extend({
  /** How many entries to skip: 0, or the `nextOffset` of the page before. */
  offset: z.coerce.number({ message: "Give the offset as a whole number." }).int("Give the offset as a whole number.").nonnegative("Give the offset as a whole number.").default(0),
});

/** One page of the Job history tab. */
export interface JobHistoryPage {
  /** The page's Jobs, a Comparison's together, newest entry first. */
  jobs: ListedJob[];
  /** How many entries match the filters, on every page. */
  total: number;
  /** How many Jobs those entries hold. */
  totalJobs: number;
  /** What deleting every matching Job would remove: the Jobs not running, their Results, and the Picks of them. */
  deletable: { jobs: number; results: number; picks: number };
  /** Where the next page starts; null on the last. */
  nextOffset: number | null;
  /** Every Alias a Job in the history recorded, for the Model filter; renamed and removed Models' included. */
  aliases: string[];
}

/** One page of the Job history, filtered. A Comparison counts as one entry and is never split between pages. */
export async function jobHistoryPage(dirs: Dirs, query: z.infer<typeof jobHistoryQuery>): Promise<JobHistoryPage> {
  const { offset, ...filter } = query;
  const listed = await listJobHistory(dirs);
  const matching = listed.filter((job) => matchesFilter(job, filter));
  const entries = entriesOf(matching);
  const end = offset + jobHistoryPageSize;
  const doomed = matching.filter((job) => job.outcome !== "running");
  const doomedIds = new Set(doomed.map((job) => job.id));
  const picks = new Set(doomed.flatMap((job) => (job.comparison?.pick && doomedIds.has(job.comparison.pick.jobId) ? [job.comparison.id] : [])));
  return {
    jobs: entries.slice(offset, end).flat(),
    total: entries.length,
    totalJobs: matching.length,
    deletable: { jobs: doomed.length, results: doomed.reduce((count, job) => count + job.files.length, 0), picks: picks.size },
    nextOffset: end < entries.length ? end : null,
    aliases: [...new Set(listed.map((job) => job.model))].sort(),
  };
}

/** The listed Jobs as entries: one Job, or a Comparison's Jobs, which {@link listJobHistory} keeps next to each other. */
function entriesOf(jobs: ListedJob[]): ListedJob[][] {
  const entries: ListedJob[][] = [];
  for (const job of jobs) {
    const last = entries.at(-1);
    if (job.comparison !== undefined && last?.[0]?.comparison?.id === job.comparison.id) last.push(job);
    else entries.push([job]);
  }
  return entries;
}

/**
 * Every Job, newest first, except that a Comparison's Jobs are listed together, in the order they started, where its
 * newest Job would be.
 */
export async function listJobHistory(dirs: Dirs): Promise<ListedJob[]> {
  const listed = (await readRatedJobs(dirs)).map((rated) => {
    const { job, pick } = rated;
    const listedRatingOf = (result?: number) => {
      const current = ratingOf(rated, result);
      return current === undefined ? null : listedRating(current);
    };
    return {
      id: job.id,
      createdAt: job.createdAt,
      model: job.model,
      modelId: job.modelId,
      provider: job.provider,
      prompt: job.prompt,
      durationMs: job.durationMs,
      outcome: job.outcome,
      modality: job.modality ?? "image",
      files: job.files.map((path, index) => ({
        path,
        thumbnail: `/api/jobs/${encodeURIComponent(job.id)}/files/${index}`,
        rating: listedRatingOf(index + 1),
      })),
      rating: listedRatingOf(),
      ...(job.error === undefined ? {} : { error: job.error.message }),
      ...(job.shortfall === undefined ? {} : { shortfall: job.shortfall }),
      ...(job.mismatch === undefined ? {} : { mismatch: `The result does not match the request: ${job.mismatch}.` }),
      ...(job.comparison === undefined ? {} : { comparison: { id: job.comparison, size: 0, pick: pick === undefined ? null : listedPick(pick) } }),
    } satisfies ListedJob;
  });
  const byComparison = new Map<string, ListedJob[]>();
  for (const job of listed) {
    if (job.comparison === undefined) continue;
    const ofComparison = byComparison.get(job.comparison.id) ?? [];
    byComparison.set(job.comparison.id, ofComparison);
    ofComparison.unshift(job);
  }
  for (const ofComparison of byComparison.values()) for (const job of ofComparison) job.comparison!.size = ofComparison.length;
  return listed.flatMap((job) => {
    if (job.comparison === undefined) return [job];
    const ofComparison = byComparison.get(job.comparison.id);
    // A Comparison's Jobs go where its newest Job is; the others were already listed there.
    if (ofComparison === undefined) return [];
    byComparison.delete(job.comparison.id);
    return ofComparison;
  });
}

export async function pickFromPage(dirs: Dirs, comparison: string, input: z.infer<typeof pickInput>, now: Date): Promise<ListedPick> {
  try {
    return listedPick(await pickResult(dirs, { comparison, ...input }, now));
  } catch (error) {
    if (!(error instanceof PickError)) throw error;
    throw new SettingsError({ "unknown-comparison": 404, "not-in-comparison": 400, "not-completed": 409, invalid: 400 }[error.kind], error.message);
  }
}

export async function rateJobFromPage(dirs: Dirs, jobId: string, input: z.infer<typeof rateJobInput>, now: Date): Promise<ListedRating> {
  try {
    return listedRating(await rateJob(dirs, { jobId, ...input }, now));
  } catch (error) {
    if (!(error instanceof RatingError)) throw error;
    throw new SettingsError({ "unknown-job": 404, "not-completed": 409, invalid: 400 }[error.kind], error.message);
  }
}

/**
 * One image or video of a Job, by its position in the Job history's record. Only files the history records can be
 * served, and only when they are still on disk and still an image or a video.
 */
export async function jobImage(dirs: Dirs, jobId: string, index: string): Promise<{ bytes: Uint8Array; contentType: string }> {
  const job = await readJob(dirs, jobId);
  const path = /^\d+$/.test(index) ? job?.files[Number(index)] : undefined;
  if (path === undefined) throw new SettingsError(404, "No such file in the Job history.");
  let bytes: Uint8Array;
  try {
    bytes = await readFile(path);
  } catch {
    throw new SettingsError(404, "The file is no longer on disk.");
  }
  const type = fileTypeOf(bytes);
  if (type === undefined) throw new SettingsError(404, "The file is no longer an image or a video.");
  return { bytes, contentType: type.mimeType };
}

function listedPick(pick: PickRecord): ListedPick {
  return { jobId: pick.jobId, ...(pick.result === undefined ? {} : { result: pick.result }), pickedAt: pick.pickedAt };
}

function listedRating(rating: RatingRecord): ListedRating {
  return { verdict: rating.verdict, reason: rating.reason, ratedAt: rating.ratedAt };
}
