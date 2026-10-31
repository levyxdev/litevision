import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { Dirs } from "../dirs.ts";
import { rateJob, RatingError, ratingReasonMaxLength, readJob, readRatedJobs, verdicts, type RatingRecord } from "../history.ts";
import { imageTypeOf } from "../images.ts";
import { SettingsError } from "./providers.ts";

/** The settings page's Job history area: Jobs newest first, their images and Ratings, and rating from the page. */

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
  /** `thumbnail` is the path the settings server serves the image at; the page adds its token to it. */
  files: Array<{ path: string; thumbnail: string }>;
  rating: ListedRating | null;
  /** Why a failed Job failed. */
  error?: string;
  /** Why a completed Job has fewer images than asked for. */
  shortfall?: string;
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
    files: job.files.map((path, index) => ({ path, thumbnail: `/api/jobs/${encodeURIComponent(job.id)}/files/${index}` })),
    rating: rating === undefined ? null : listedRating(rating),
    ...(job.error === undefined ? {} : { error: job.error.message }),
    ...(job.shortfall === undefined ? {} : { shortfall: job.shortfall }),
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
 * One image of a Job, by its position in the Job history's record. Only files the history records can be served,
 * and only when they are still on disk and still an image.
 */
export async function jobImage(dirs: Dirs, jobId: string, index: string): Promise<{ bytes: Uint8Array; contentType: string }> {
  const job = await readJob(dirs, jobId);
  const path = /^\d+$/.test(index) ? job?.files[Number(index)] : undefined;
  if (path === undefined) throw new SettingsError(404, "No such image in the Job history.");
  let bytes: Uint8Array;
  try {
    bytes = await readFile(path);
  } catch {
    throw new SettingsError(404, "The image is no longer on disk.");
  }
  const type = imageTypeOf(bytes);
  if (type === undefined) throw new SettingsError(404, "The file is no longer an image.");
  return { bytes, contentType: type.mimeType };
}

function listedRating(rating: RatingRecord): ListedRating {
  return { verdict: rating.verdict, reason: rating.reason, ratedAt: rating.ratedAt };
}
