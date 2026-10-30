import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Dirs } from "./dirs.ts";
import type { AspectRatio, ImageSize, ProviderErrorKind } from "./protocols/protocol.ts";

/**
 * The Job history, `jobs.jsonl`: append-only, one JSON record per line. A Job may get several records over its life;
 * the latest one for an id is what it is now.
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
  durationMs: number;
  files: string[];
  outcome: "completed" | "failed";
  /** Why a completed Job has fewer files than `parameters.n`. */
  shortfall?: string;
  error?: { kind: ProviderErrorKind; message: string };
}

const historyPath = (dirs: Dirs) => join(dirs.data, "jobs.jsonl");

export async function appendHistory(dirs: Dirs, record: JobRecord): Promise<void> {
  await mkdir(dirs.data, { recursive: true });
  await appendFile(historyPath(dirs), `${JSON.stringify(record)}\n`);
}

/** Every Job as its latest record says it is now, oldest first. Lines that cannot be read are skipped. */
export async function readJobs(dirs: Dirs): Promise<JobRecord[]> {
  let text: string;
  try {
    text = await readFile(historyPath(dirs), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const jobs = new Map<string, JobRecord>();
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isJobRecord(record)) continue;
    // Re-inserting moves the Job to where its latest record is, so a Job is ordered by when it last changed.
    jobs.delete(record.id);
    jobs.set(record.id, record);
  }
  return [...jobs.values()];
}

function isJobRecord(value: unknown): value is JobRecord {
  const record = value as Partial<JobRecord> | null;
  return typeof record === "object" && record !== null && record.type === "job" && typeof record.id === "string";
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
