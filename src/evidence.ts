import { access, appendFile, link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Dirs } from "./dirs.ts";
import { readJobs, type JobRecord, type ModelKey } from "./history.ts";
import type { MediaFacts } from "./media.ts";
import type { Modality } from "./protocols/protocol.ts";
import type { CheckedRequest } from "./result-check.ts";

/**
 * Option Status evidence, `evidence.jsonl` (ADR 0015): append-only, one line per Job when it ends, holding only the
 * facts an Option Status reads. It outlives the Job history, which the User may delete, so it holds no prompt, no
 * Result or Reference path, no Rating and no Pick. Every read and write of the evidence goes through this module.
 */

/** One line of `evidence.jsonl`: what one ended Job says about its Model's `provider_options`. */
export interface Evidence extends ModelKey {
  type: "evidence";
  jobId: string;
  /** When the Job started, as an ISO date-time. */
  createdAt: string;
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

/** Records the evidence of a Job that has just ended. */
export async function appendEvidence(dirs: Dirs, job: JobRecord): Promise<void> {
  const evidence = evidenceOf(job);
  if (evidence === undefined) return;
  if ((await ensureEvidence(dirs)).has(job.id)) return;
  // The folder also holds credentials.json.
  await mkdir(dirs.home, { recursive: true, mode: 0o700 });
  await appendFile(evidencePath(dirs), `${JSON.stringify(evidence)}\n`);
}

/**
 * Every Job's evidence, in the order the Jobs ended. A Job recorded twice, as when it ended while the evidence was
 * first being written, counts once, where it last appears, as in the Job history. Lines that cannot be read are skipped.
 */
export async function readEvidence(dirs: Dirs): Promise<Evidence[]> {
  await ensureEvidence(dirs);
  let text: string;
  try {
    text = await readFile(evidencePath(dirs), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const byJob = new Map<string, Evidence>();
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isEvidence(record)) continue;
    // Re-inserting moves the Job to where its latest line is.
    byJob.delete(record.jobId);
    byJob.set(record.jobId, record);
  }
  return [...byJob.values()];
}

/**
 * Writes the evidence of every Job already in the Job history, when there is no evidence yet: the first run after
 * upgrading. It appears whole or not at all, so several litevision processes starting together leave one; a Job that
 * ends meanwhile is appended after it, and may appear twice. With no ended Job to write, it writes nothing. Returns the ids of the Jobs this call wrote, none when the evidence was
 * already there or another process wrote it first.
 */
async function ensureEvidence(dirs: Dirs): Promise<Set<string>> {
  const path = evidencePath(dirs);
  if (await exists(path)) return new Set();
  const written = (await readJobs(dirs)).flatMap((job) => {
    const evidence = evidenceOf(job);
    return evidence === undefined ? [] : [evidence];
  });
  if (written.length === 0) return new Set();
  await mkdir(dirs.home, { recursive: true, mode: 0o700 });
  const draft = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(draft, written.map((evidence) => `${JSON.stringify(evidence)}\n`).join(""));
  try {
    await link(draft, path);
    return new Set(written.map((evidence) => evidence.jobId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return new Set();
  } finally {
    await unlink(draft);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
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
