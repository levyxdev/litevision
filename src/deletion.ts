import { readFile, rmdir, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Dirs } from "./dirs.ts";
import { keepEvidence } from "./evidence.ts";
import { isDeletable, matchesFilter, removeJobs, type JobFilter, type JobRecord } from "./history.ts";
import { fileTypeOf } from "./media.ts";
import { contentHash } from "./source-jobs.ts";

/**
 * Deleting Jobs from the Job history, for good (#62): their records, Ratings and Picks, and their Result files. A
 * Reference is never deleted: it belongs to whoever supplied it. The Option Status evidence is never touched (ADR 0015).
 * Both the `delete_jobs` tool and the settings page delete through here.
 */

/** Which Jobs to delete: exactly one of these. A filter takes the Jobs matching it when the deletion runs. */
export type JobSelection = { jobIds: string[] } | { comparisonIds: string[] } | { filter: JobFilter } | { all: true };

/** Why a Result file was left where it was: no longer what the Job saved, or the system refused to remove it. */
export const skipReasonNames = ["content-changed", "could-not-delete"] as const;
export type SkipReason = (typeof skipReasonNames)[number];

/** What a deletion did. */
export interface DeletionReport {
  /** The Jobs removed from the Job history, in the order it had them. */
  deletedJobs: string[];
  /** The Result files deleted. */
  deletedFiles: string[];
  /** The Result files that were not there any more, as when the User had deleted or moved them: nothing to delete. */
  alreadyGone: string[];
  /** The Result files left where they were, and why. */
  skippedFiles: Array<{ jobId: string; file: string; reason: SkipReason }>;
  /** Selected Jobs a live litevision session is still running, which were left alone; cancel them first. */
  runningJobs: string[];
  /** Job or Comparison ids the selection named that the Job history does not have. */
  notFound: string[];
  /** The Picks removed with the Job they picked; their Comparisons have no Pick now. */
  picksRemoved: Array<{ comparison: string; jobId: string; result?: number }>;
  /** Deleted Result files that remaining Jobs had used as a Reference, by their Source Jobs. */
  referencesOfOtherJobs: Array<{ file: string; jobIds: string[] }>;
}

/** Deletes the selected Jobs; Jobs a live session still runs are left and reported, interrupted ones deleted. */
export async function deleteJobs(dirs: Dirs, selection: JobSelection): Promise<DeletionReport> {
  let running: string[] = [];
  let notFound: string[] = [];
  const removed = await removeJobs(dirs, (jobs) => {
    const chosen = selected(jobs, selection);
    notFound = chosen.notFound;
    // An interrupted Job is running nowhere, so it goes like an ended one.
    running = chosen.jobs.filter((job) => !isDeletable(job)).map((job) => job.id);
    return new Set(chosen.jobs.filter(isDeletable).map((job) => job.id));
  });
  // What litevision learnt from these Jobs outlives them (ADR 0015), even where their evidence failed to be written.
  await keepEvidence(dirs, removed.jobs);

  const deletedFiles: string[] = [];
  const alreadyGone: string[] = [];
  const skippedFiles: DeletionReport["skippedFiles"] = [];
  for (const job of removed.jobs) {
    for (const [index, file] of job.files.entries()) {
      const outcome = await deleteResult(file, job.hashes?.[index]);
      if (outcome === "deleted") deletedFiles.push(file);
      else if (outcome === "already-gone") alreadyGone.push(file);
      else skippedFiles.push({ jobId: job.id, file, reason: outcome });
    }
    if (job.parameters.outputPath === undefined) await removeIfEmptyDatedFolder(dirs, job.files);
  }

  const deleted = new Set(deletedFiles);
  /** Each deleted Result file, with the remaining Jobs whose Source Job it was. */
  const usedAsReference = new Map<string, string[]>();
  for (const job of removed.remaining) {
    for (const source of job.sourceJobs ?? []) {
      if (!deleted.has(source.file)) continue;
      const ids = usedAsReference.get(source.file) ?? [];
      if (!ids.includes(job.id)) ids.push(job.id);
      usedAsReference.set(source.file, ids);
    }
  }

  return {
    deletedJobs: removed.jobs.map((job) => job.id),
    deletedFiles,
    alreadyGone,
    skippedFiles,
    runningJobs: running,
    notFound,
    picksRemoved: removed.picks.map((pick) => ({
      comparison: pick.comparison,
      jobId: pick.jobId,
      ...(pick.result === undefined ? {} : { result: pick.result }),
    })),
    referencesOfOtherJobs: [...usedAsReference].map(([file, jobIds]) => ({ file, jobIds })),
  };
}

/** The Jobs a selection names, and the ids it names that the Job history does not have. */
function selected(jobs: JobRecord[], selection: JobSelection): { jobs: JobRecord[]; notFound: string[] } {
  if ("all" in selection) return { jobs, notFound: [] };
  if ("filter" in selection) return { jobs: jobs.filter((job) => matchesFilter(job, selection.filter)), notFound: [] };
  if ("jobIds" in selection) {
    const ids = new Set(selection.jobIds);
    const known = new Set(jobs.map((job) => job.id));
    return { jobs: jobs.filter((job) => ids.has(job.id)), notFound: [...ids].filter((id) => !known.has(id)) };
  }
  const ids = new Set(selection.comparisonIds);
  const known = new Set(jobs.flatMap((job) => (job.comparison === undefined ? [] : [job.comparison])));
  return {
    jobs: jobs.filter((job) => job.comparison !== undefined && ids.has(job.comparison)),
    notFound: [...ids].filter((id) => !known.has(id)),
  };
}

/**
 * Deletes one Result file if it is still what the Job saved: the same content, by the hash recorded with it, or for a
 * Job recorded before hashes, still an image or a video. A file that is not there any more is already gone, as the
 * deletion wants. The Job history is already rewritten, so a file the system refuses to read or remove is left and
 * reported rather than stopping the deletion.
 */
async function deleteResult(file: string, hash: string | undefined): Promise<"deleted" | "already-gone" | SkipReason> {
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch (error) {
    if (isMissing(error)) return "already-gone";
    // A folder put where the Result was is not what the Job saved.
    return (error as NodeJS.ErrnoException).code === "EISDIR" ? "content-changed" : "could-not-delete";
  }
  const unchanged = hash !== undefined ? contentHash(bytes) === hash : fileTypeOf(bytes) !== undefined;
  if (!unchanged) return "content-changed";
  try {
    await unlink(file);
  } catch (error) {
    return isMissing(error) ? "already-gone" : "could-not-delete";
  }
  return "deleted";
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Removes the dated folders under the default outputs folder that a Job's Results were saved in, once nothing else is
 * in them. A folder the Agent named with `output_path` is never removed: it was chosen, not made by litevision.
 */
async function removeIfEmptyDatedFolder(dirs: Dirs, files: string[]): Promise<void> {
  const output = resolve(dirs.output);
  for (const folder of new Set(files.map((file) => dirname(resolve(file))))) {
    if (dirname(folder) !== output) continue;
    // Fails while anything is left in it, which is the point.
    await rmdir(folder).catch(() => undefined);
  }
}
