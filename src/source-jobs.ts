import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import type { JobRecord, SourceJob } from "./history.ts";
import type { ReferenceImage } from "./protocols/protocol.ts";

/**
 * Source Jobs: the earlier Jobs whose results are among a Job's reference images (GLOSSARY.md). A saved result is known
 * by the content hash recorded when it was saved, so a reference that is a copy of it, anywhere, still matches. Old
 * outputs are never read again: the User deletes the ones they do not want, and a deleted one is shown as deleted.
 */

/** The content hash litevision records for a saved file and compares a reference image against. */
export function contentHash(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/**
 * The Source Jobs of a Job with the given reference images, a video's frames among them: for each reference whose
 * content an earlier Job saved, that Job and result, once each, in the order of the references. When several Jobs saved
 * the same content, the one that started first made it.
 */
export function findSourceJobs(history: JobRecord[], references: Array<Pick<ReferenceImage, "path" | "bytes">>): SourceJob[] {
  const saved = new Map<string, Omit<SourceJob, "reference">>();
  const oldestFirst = history
    .filter((job) => job.outcome === "completed" && job.hashes !== undefined)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  for (const job of oldestFirst) {
    job.hashes!.forEach((hash, index) => {
      const file = job.files[index];
      if (file !== undefined && !saved.has(hash)) saved.set(hash, { jobId: job.id, result: index + 1, file });
    });
  }
  const found: SourceJob[] = [];
  for (const reference of references) {
    const source = saved.get(contentHash(reference.bytes));
    if (source === undefined || found.some((known) => known.jobId === source.jobId && known.result === source.result)) continue;
    found.push({ ...source, reference: reference.path });
  }
  return found;
}

/** A Source Job as `get_job` and `list_models` show it. */
export interface ShownSourceJob extends SourceJob {
  /** Alias the Source Job ran under, when the history still has it. */
  model?: string;
  /** True when the Source Job's file is no longer where it was saved. */
  deleted: boolean;
}

/** A Job's Source Jobs, with each one's Model and whether its file has been deleted since. */
export async function showSourceJobs(job: JobRecord, jobsById: Map<string, JobRecord>): Promise<ShownSourceJob[]> {
  return Promise.all(
    (job.sourceJobs ?? []).map(async (source) => {
      const model = jobsById.get(source.jobId)?.model;
      return { ...source, ...(model === undefined ? {} : { model }), deleted: await isGone(source.file) };
    }),
  );
}

/** Whether nothing is at `path` any more. Only its absence is looked at; the file is not read. */
async function isGone(path: string): Promise<boolean> {
  try {
    await stat(path);
    return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR";
  }
}
