import { readFile, rmdir, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Dirs } from "./dirs.ts";
import { removeJobs, type JobRecord } from "./history.ts";
import { fileTypeOf } from "./media.ts";
import { contentHash } from "./source-jobs.ts";

/**
 * Deleting Jobs from the Job history, for good (#62): their records, Ratings and Picks, and their Result files. A
 * Reference is never deleted: it belongs to whoever supplied it. The Option Status evidence is never touched (ADR 0015).
 * Both the `delete_jobs` tool and the settings page delete through here.
 */

/** Which Jobs to delete: exactly one of these. */
export type JobSelection = { jobIds: string[] } | { comparisonIds: string[] } | { all: true };

/** Why a Result file was left where it was. */
export type SkipReason = "content-changed" | "already-gone";

/** What a deletion did. */
export interface DeletionReport {
  /** The Jobs removed from the Job history, in the order it had them. */
  deletedJobs: string[];
  /** The Result files deleted. */
  deletedFiles: string[];
  /** The Result files not deleted: changed since the Job saved them, or no longer there. */
  skippedFiles: Array<{ jobId: string; file: string; reason: SkipReason }>;
  /** Selected Jobs still running, which were left alone; cancel them first. */
  runningJobs: string[];
  /** Job or Comparison ids the selection named that the Job history does not have. */
  notFound: string[];
  /** The Picks removed with the Job they picked; their Comparisons have no Pick now. */
  picksRemoved: Array<{ comparison: string; jobId: string; result?: number }>;
  /** Deleted Result files that remaining Jobs had used as a Reference, by their Source Jobs. */
  referencesOfOtherJobs: Array<{ file: string; jobIds: string[] }>;
}

/** Deletes the selected Jobs; Jobs still running are left and reported. */
export async function deleteJobs(dirs: Dirs, selection: JobSelection): Promise<DeletionReport> {
  let running: string[] = [];
  let notFound: string[] = [];
  const removed = await removeJobs(dirs, (jobs) => {
    const chosen = selected(jobs, selection);
    notFound = chosen.notFound;
    running = chosen.jobs.filter((job) => job.outcome === "running").map((job) => job.id);
    return new Set(chosen.jobs.filter((job) => job.outcome !== "running").map((job) => job.id));
  });

  const deletedFiles: string[] = [];
  const skippedFiles: DeletionReport["skippedFiles"] = [];
  for (const job of removed.jobs) {
    for (const [index, file] of job.files.entries()) {
      const outcome = await deleteResult(file, job.hashes?.[index]);
      if (outcome === "deleted") deletedFiles.push(file);
      else skippedFiles.push({ jobId: job.id, file, reason: outcome });
    }
    if (job.parameters.outputPath === undefined) await removeIfEmptyDatedFolder(dirs, job.files);
  }

  const deleted = new Set(deletedFiles);
  const users = new Map<string, string[]>();
  for (const job of removed.remaining) {
    for (const source of job.sourceJobs ?? []) {
      if (!deleted.has(source.file)) continue;
      const ids = users.get(source.file) ?? [];
      if (!ids.includes(job.id)) ids.push(job.id);
      users.set(source.file, ids);
    }
  }

  return {
    deletedJobs: removed.jobs.map((job) => job.id),
    deletedFiles,
    skippedFiles,
    runningJobs: running,
    notFound,
    picksRemoved: removed.picks.map((pick) => ({
      comparison: pick.comparison,
      jobId: pick.jobId,
      ...(pick.result === undefined ? {} : { result: pick.result }),
    })),
    referencesOfOtherJobs: [...users].map(([file, jobIds]) => ({ file, jobIds })),
  };
}

/** The Jobs a selection names, and the ids it names that the Job history does not have. */
function selected(jobs: JobRecord[], selection: JobSelection): { jobs: JobRecord[]; notFound: string[] } {
  if ("all" in selection) return { jobs, notFound: [] };
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
 * Job recorded before hashes, still an image or a video.
 */
async function deleteResult(file: string, hash: string | undefined): Promise<"deleted" | SkipReason> {
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return "already-gone";
    throw error;
  }
  const unchanged = hash !== undefined ? contentHash(bytes) === hash : fileTypeOf(bytes) !== undefined;
  if (!unchanged) return "content-changed";
  await unlink(file);
  return "deleted";
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
