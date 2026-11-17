import { access, appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Dirs } from "./dirs.ts";
import { withFileLock } from "./file-lock.ts";
import { readJobs, type JobRecord, type ModelKey } from "./history.ts";
import type { MediaFacts } from "./media.ts";
import type { Modality } from "./protocols/protocol.ts";
import type { CheckedRequest } from "./result-check.ts";

/**
 * Option Status evidence, `evidence.jsonl` (ADR 0015): append-only, one line per Job when it ends, holding only the
 * facts an Option Status reads. It outlives the Job history, which the User may delete, so it holds no prompt, no
 * Result or Reference path, no Rating and no Pick. Every read and write of the evidence goes through this module, and
 * holds one machine-wide lock, so evidence is never written twice by two processes repairing it at once.
 */

/** One line of `evidence.jsonl`: what one ended Job says about its Model's `provider_options`. */
export interface Evidence extends ModelKey {
  type: "evidence";
  jobId: string;
  /** When the Job started, as an ISO date-time. */
  createdAt: string;
  /** When the Job ended, as an ISO date-time; evidence counts in this order. Absent on evidence written before. */
  endedAt?: string;
  /** Absent for Jobs recorded before videos existed, which are all image Jobs. */
  modality?: Modality;
  outcome: "completed" | "failed";
  /** What the request asked for, as far as the result check reads it, with the `provider_options` sent. */
  request: CheckedRequest;
  /** What each Result turned out to be, in order; a Result litevision could not read is `null`. */
  observed?: Array<MediaFacts | null>;
  /**
   * What the Provider's answer said, for a Job it rejected as a rejected option or an unsupported request; other
   * failures say nothing about options, and their messages may name a local path.
   */
  error?: JobRecord["error"];
}

const evidencePath = (dirs: Dirs) => join(dirs.home, "evidence.jsonl");
const lockPath = (dirs: Dirs) => join(dirs.home, "evidence.lock");

/** The failures whose error an Option Status reads. */
const optionErrors: ReadonlySet<string> = new Set(["rejected_option", "unsupported"]);

/** The evidence of an ended Job; undefined while it is running. */
function evidenceOf(job: JobRecord): Evidence | undefined {
  if (job.outcome === "running") return undefined;
  const { providerOptions, requested, size, seconds, followsFirstFrame } = job.parameters;
  const error = job.error !== undefined && optionErrors.has(job.error.kind) ? job.error : undefined;
  return withoutUndefined<Evidence>({
    type: "evidence",
    jobId: job.id,
    createdAt: job.createdAt,
    endedAt: new Date(Date.parse(job.createdAt) + job.durationMs).toISOString(),
    provider: job.provider,
    protocol: job.protocol,
    modelId: job.modelId,
    modality: job.modality,
    outcome: job.outcome,
    request: withoutUndefined<CheckedRequest>({ providerOptions, requested, size, seconds, followsFirstFrame }),
    observed: job.observed,
    error,
  });
}

/** The object with its undefined fields left out, so a line holds only what the Job had. */
function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as T;
}

/** Records the evidence of a Job that has just ended. When it fails, the next read writes it (see {@link readEvidence}). */
export async function appendEvidence(dirs: Dirs, job: JobRecord): Promise<void> {
  const evidence = evidenceOf(job);
  if (evidence === undefined) return;
  // The folder also holds credentials.json.
  await mkdir(dirs.home, { recursive: true, mode: 0o700 });
  await withFileLock(lockPath(dirs), () => appendFile(evidencePath(dirs), `${JSON.stringify(evidence)}\n`));
}

/**
 * Every Job's evidence, in the order the Jobs ended. First it writes the evidence of every ended Job the Job history
 * has and the evidence lacks: all of them on the first run after upgrading, else any whose evidence failed to be
 * written when it ended. A Job recorded twice counts once, as its latest line says. Lines that cannot be read are
 * skipped.
 */
export async function readEvidence(dirs: Dirs, jobs?: JobRecord[]): Promise<Evidence[]> {
  // Before anything is configured there is no evidence, nor a folder to keep the lock in.
  if (!(await exists(dirs.home))) return [];
  const evidence = await keepEvidence(dirs, jobs ?? (await readJobs(dirs)));
  const byJob = new Map(evidence.map((line) => [line.jobId, line]));
  // Stable, so Jobs that ended together keep the order they were written in.
  return [...byJob.values()].sort((a, b) => endOf(a) - endOf(b));
}

/**
 * Writes the evidence of those of `jobs` that have ended and have none yet, and returns all the evidence written so
 * far, as it is in the file. Deleting Jobs calls it first, so their evidence is never lost with them.
 */
export async function keepEvidence(dirs: Dirs, jobs: JobRecord[]): Promise<Evidence[]> {
  return withFileLock(lockPath(dirs), async () => {
    const written = parseEvidence(await readEvidenceText(dirs));
    const known = new Set(written.map((line) => line.jobId));
    const missing = jobs.flatMap((job) => {
      const lacking = known.has(job.id) ? undefined : evidenceOf(job);
      return lacking === undefined ? [] : [lacking];
    });
    if (missing.length > 0) {
      await mkdir(dirs.home, { recursive: true, mode: 0o700 });
      await appendFile(evidencePath(dirs), missing.map((line) => `${JSON.stringify(line)}\n`).join(""));
    }
    return [...written, ...missing];
  });
}

/** When a Job ended; evidence written before it said so counts from when the Job started. */
const endOf = (evidence: Evidence) => Date.parse(evidence.endedAt ?? evidence.createdAt);

async function readEvidenceText(dirs: Dirs): Promise<string> {
  try {
    return await readFile(evidencePath(dirs), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

function parseEvidence(text: string): Evidence[] {
  return text.split("\n").flatMap((line) => {
    if (line.trim() === "") return [];
    try {
      const record: unknown = JSON.parse(line);
      return isEvidence(record) ? [record] : [];
    } catch {
      return [];
    }
  });
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

function isEvidence(value: unknown): value is Evidence {
  const record = value as Partial<Evidence> | null;
  return (
    typeof record === "object" &&
    record !== null &&
    record.type === "evidence" &&
    typeof record.jobId === "string" &&
    typeof record.createdAt === "string" &&
    typeof record.request === "object" &&
    record.request !== null
  );
}
