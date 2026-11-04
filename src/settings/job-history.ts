import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { Dirs } from "../dirs.ts";
import { rateJob, RatingError, ratingReasonMaxLength, readJob, readRatedJobs, verdicts, type RatingRecord } from "../history.ts";
import { fileTypeOf } from "../media.ts";
import type { Modality } from "../protocols/protocol.ts";
import { SettingsError } from "./providers.ts";

/** The settings page's Job history area: Jobs newest first, their images or videos and Ratings, and rating from the page. */

export const rateJobInput = z.object({
  verdict: z.enum(verdicts, { message: "Choose good or bad." }),
  reason: z.string().max(ratingReasonMaxLength, `Keep the reason to at most ${ratingReasonMaxLength} characters.`),
});

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
  /** `thumbnail` is the path the settings server serves the file at; the page adds its token to it. */
  files: Array<{ path: string; thumbnail: string }>;
  rating: ListedRating | null;
  /** Why a failed Job failed. */
  error?: string;
  /** Why a completed Job has fewer images than asked for. */
  shortfall?: string;
  /** How a completed Job's result differs from its request (ADR 0006). */
  mismatch?: string;
}

export async function listJobHistory(dirs: Dirs): Promise<ListedJob[]> {
  return (await readRatedJobs(dirs)).map(({ job, rating }) => ({
    id: job.id,
    createdAt: job.createdAt,
    model: job.model,
    modelId: job.modelId,
    provider: job.provider,
    prompt: job.prompt,
    durationMs: job.durationMs,
    outcome: job.outcome,
    modality: job.modality ?? "image",
    files: job.files.map((path, index) => ({ path, thumbnail: `/api/jobs/${encodeURIComponent(job.id)}/files/${index}` })),
    rating: rating === undefined ? null : listedRating(rating),
    ...(job.error === undefined ? {} : { error: job.error.message }),
    ...(job.shortfall === undefined ? {} : { shortfall: job.shortfall }),
    ...(job.mismatch === undefined ? {} : { mismatch: `The result does not match the request: ${job.mismatch}.` }),
  }));
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

function listedRating(rating: RatingRecord): ListedRating {
  return { verdict: rating.verdict, reason: rating.reason, ratedAt: rating.ratedAt };
}
