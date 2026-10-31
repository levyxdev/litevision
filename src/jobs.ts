import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ConfigError, loadConfig, needsSettings, requireCredential, type ResolvedModel } from "./config.ts";
import type { Dirs } from "./dirs.ts";
import { appendHistory, readJob, type JobRecord } from "./history.ts";
import { imageTypeOf } from "./images.ts";
import type { HttpTransport } from "./http.ts";
import type { NormalisedRequest } from "./protocols/capabilities.ts";
import { providerError, providerLabel } from "./protocols/errors.ts";
import { adapterForProtocol } from "./protocols/index.ts";
import {
  ProviderError,
  type GeneratedImage,
  type JobContext,
  type JobImages,
  type ProtocolAdapter,
  type ProviderErrorKind,
} from "./protocols/protocol.ts";

/** How long `generate_image` and `get_job` wait for a Job before saying it is still running. */
export const defaultWaitLimitMs = 120_000;

/** How often asynchronous Protocols ask their Provider whether a Job is done. */
export const defaultPollIntervalMs = 3_000;

export interface JobRunnerDeps {
  dirs: Dirs;
  http: HttpTransport;
  now: () => Date;
  /** Defaults to {@link defaultWaitLimitMs}. */
  waitLimitMs?: number;
  /** Defaults to {@link defaultPollIntervalMs}. */
  pollIntervalMs?: number;
}

export interface JobSpec extends ResolvedModel {
  adapter: ProtocolAdapter;
  credential: string;
  normalised: NormalisedRequest;
  /** Absolute folder to save into; omitted, images go under a dated folder in `dirs.output`. */
  outputDir?: string;
}

export interface CompletedJob {
  id: string;
  files: string[];
  /** Why fewer files than requested were saved; omitted when none are missing. Safe to show the Agent. */
  shortfall?: string;
}

/** Where a Job stands once the wait limit has passed or it has finished. A failed Job is thrown as {@link JobFailedError}. */
export type JobState = { model: string } & ({ status: "running"; id: string } | ({ status: "completed" } & CompletedJob));

/** A Job that did not complete. Its message is safe to show the Agent. */
export class JobFailedError extends Error {
  constructor(
    readonly jobId: string,
    readonly kind: ProviderErrorKind,
    message: string,
  ) {
    super(message);
  }
}

/** Raised inside a Job when litevision shuts down under it. Nothing more is recorded, so the Job can be resumed. */
class JobAbandoned extends Error {
  constructor() {
    super("litevision shut down while the Job was running.");
  }
}

/** What a Job's records share; the rest of a record says where the Job stands. */
type JobBase = Omit<JobRecord, "durationMs" | "files" | "outcome" | "resume" | "cost" | "shortfall" | "error">;

type JobProgress = Partial<Pick<JobRecord, "files" | "resume" | "cost" | "shortfall" | "error">>;

const lostMessage = "litevision stopped before this Job finished, so its result is lost; generate the images again.";

/**
 * Runs Jobs for every Protocol: submit, wait, poll, download, save, and the Job history. A Job outlives the tool call
 * that started it: past the wait limit the caller gets its id, and `get` picks it up again, from the Job history when
 * litevision has restarted since.
 */
export class JobRunner {
  /** Every Job this process has run or resumed, settled or not. */
  private readonly jobs = new Map<string, Promise<CompletedJob>>();
  private readonly abandons = new Set<() => void>();
  private closed = false;
  private readonly waitLimitMs: number;
  private readonly pollIntervalMs: number;

  constructor(private readonly deps: JobRunnerDeps) {
    this.waitLimitMs = deps.waitLimitMs ?? defaultWaitLimitMs;
    this.pollIntervalMs = deps.pollIntervalMs ?? defaultPollIntervalMs;
  }

  /** Starts a Job and waits for it up to the wait limit. */
  async start(spec: JobSpec): Promise<JobState> {
    const { request } = spec.normalised;
    const base: JobBase = {
      type: "job",
      id: randomUUID(),
      createdAt: this.deps.now().toISOString(),
      model: spec.model.alias,
      provider: spec.provider.id,
      protocol: spec.model.protocol,
      modelId: spec.model.modelId,
      prompt: request.prompt,
      parameters: {
        n: request.n,
        aspectRatio: spec.normalised.requestedAspectRatio,
        size: request.size,
        references: request.references.map((reference) => reference.path),
        ...(spec.outputDir === undefined ? {} : { outputPath: spec.outputDir }),
        providerOptions: request.providerOptions,
      },
    };
    const target = {
      providerId: spec.provider.id,
      baseUrl: spec.provider.baseUrl,
      modelId: spec.model.modelId,
      credential: spec.credential,
    };
    // Recorded before the Provider is called, so a Job lost with this process is never silently forgotten.
    await this.append(base, "running");
    const job = this.track(base, spec.credential, async (context) => {
      const submitted = await spec.adapter.submit(request, target, this.deps.http, context);
      if (submitted.resumeHandle !== undefined) await this.append(base, "running", { resume: submitted.resumeHandle });
      return submitted.wait();
    });
    return this.waitFor(base.model, base.id, this.register(base.id, job));
  }

  /**
   * Where a Job stands, waiting up to the wait limit while it runs. A Job this process is not running is answered
   * from the Job history; if it was still running when litevision stopped, it is resumed where its Protocol can.
   */
  async get(id: string): Promise<JobState> {
    const record = await readJob(this.deps.dirs, id);
    if (record === undefined) {
      throw new ConfigError(`litevision has no Job "${id}". Use the \`job_id\` that \`generate_image\` returned.`);
    }
    let job = this.jobs.get(id);
    if (job === undefined) {
      if (record.outcome === "completed") {
        return {
          status: "completed",
          id,
          model: record.model,
          files: record.files,
          ...(record.shortfall === undefined ? {} : { shortfall: record.shortfall }),
        };
      }
      if (record.outcome === "failed") {
        throw new JobFailedError(id, record.error?.kind ?? "other", record.error?.message ?? "The Job failed.");
      }
      job = this.register(id, this.resume(record));
    }
    return this.waitFor(record.model, id, job);
  }

  /** Abandons every running Job where it stands, as if the process had stopped; `get` resumes them later. */
  close(): void {
    this.closed = true;
    for (const abandon of this.abandons) abandon();
    this.abandons.clear();
  }

  private readonly context: JobContext = {
    pause: () =>
      new Promise((resolve, reject) => {
        if (this.closed) return reject(new JobAbandoned());
        const abandon = () => {
          clearTimeout(timer);
          reject(new JobAbandoned());
        };
        const timer = setTimeout(() => {
          this.abandons.delete(abandon);
          resolve();
        }, this.pollIntervalMs);
        this.abandons.add(abandon);
      }),
  };

  private register(id: string, job: Promise<CompletedJob>): Promise<CompletedJob> {
    this.jobs.set(id, job);
    job.catch((error: unknown) => {
      // A Job that could not be resumed for want of configuration may be resumed once the User fixes it.
      if (error instanceof ConfigError) this.jobs.delete(id);
    });
    return job;
  }

  private async waitFor(model: string, id: string, job: Promise<CompletedJob>): Promise<JobState> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), this.waitLimitMs);
    });
    try {
      const done = await Promise.race([job, limit]);
      return done === undefined ? { status: "running", id, model } : { status: "completed", model, ...done };
    } catch (error) {
      if (error instanceof JobAbandoned) return { status: "running", id, model };
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Picks up a Job that was running when litevision stopped. */
  private async resume(record: JobRecord): Promise<CompletedJob> {
    const handle = record.resume;
    const base = baseOf(record);
    const adapter = adapterForProtocol(record.protocol);
    const resume = adapter?.resume;
    if (handle === undefined || adapter === undefined || resume === undefined) {
      await this.append(base, "failed", { error: { kind: "other", message: lostMessage } });
      throw new JobFailedError(record.id, "other", lostMessage);
    }
    const provider = (await loadConfig(this.deps.dirs)).providers.find((candidate) => candidate.id === record.provider);
    if (provider === undefined) {
      throw needsSettings(`Job "${record.id}" ran on Provider "${record.provider}", which is no longer configured, so it cannot be picked up again.`);
    }
    const credential = await requireCredential(this.deps.dirs, provider);
    const target = { providerId: provider.id, baseUrl: provider.baseUrl, modelId: record.modelId, credential };
    return this.track(base, credential, (context) => resume.call(adapter, handle, target, this.deps.http, context).wait());
  }

  /** Runs a Job to its end: saves what it brought back and records how it went. */
  private async track(base: JobBase, credential: string, run: (context: JobContext) => Promise<JobImages>): Promise<CompletedJob> {
    // A Provider may echo the Credential back in an error; it must never reach the Agent or the history.
    const safe = (text: string) => redact(text, credential);
    const { n } = base.parameters;
    try {
      const result = await run(this.context);
      if (this.closed) throw new JobAbandoned();
      const startedAt = new Date(base.createdAt);
      const folder = base.parameters.outputPath ?? join(this.deps.dirs.output, localDate(startedAt));
      const saved = await saveImages(this.deps.http, folder, base.id, startedAt, result.images, base.provider);
      const reasons = [result.shortfall, ...saved.failures.map((failure) => failure.message)].filter((reason) => reason !== undefined);
      if (saved.files.length === 0) {
        throw saved.failures[0] ?? providerError("other", base.provider, reasons[0] ?? "it returned no images.");
      }
      const shortfall =
        saved.files.length >= n
          ? undefined
          : safe(
              `Got ${saved.files.length} of ${n} images from ${providerLabel(base.provider)}.${reasons.length === 0 ? "" : ` ${reasons.join(" ")}`}`,
            );
      await this.append(base, "completed", { files: saved.files, shortfall, cost: result.cost });
      return { id: base.id, files: saved.files, ...(shortfall === undefined ? {} : { shortfall }) };
    } catch (error) {
      if (error instanceof JobAbandoned || this.closed) throw new JobAbandoned();
      const kind = error instanceof ProviderError ? error.kind : "other";
      const message = safe((error as Error).message);
      await this.append(base, "failed", { error: { kind, message } });
      throw new JobFailedError(base.id, kind, message);
    }
  }

  private async append(base: JobBase, outcome: JobRecord["outcome"], progress: JobProgress = {}): Promise<void> {
    if (this.closed) throw new JobAbandoned();
    const defined = Object.fromEntries(Object.entries(progress).filter(([, value]) => value !== undefined));
    await appendHistory(this.deps.dirs, {
      ...base,
      durationMs: this.deps.now().getTime() - Date.parse(base.createdAt),
      files: [],
      outcome,
      ...defined,
    });
  }
}

function baseOf(record: JobRecord): JobBase {
  const { type, id, createdAt, model, provider, protocol, modelId, prompt, parameters } = record;
  return { type, id, createdAt, model, provider, protocol, modelId, prompt, parameters };
}

function redact(text: string, credential: string): string {
  return text.split(credential).join("[redacted]");
}

async function saveImages(
  http: HttpTransport,
  folder: string,
  jobId: string,
  startedAt: Date,
  images: GeneratedImage[],
  providerId: string,
): Promise<{ files: string[]; failures: ProviderError[] }> {
  await mkdir(folder, { recursive: true });
  const base = `${localTime(startedAt)}-${jobId.slice(0, 8)}`;
  const files: string[] = [];
  const failures: ProviderError[] = [];
  for (const [index, image] of images.entries()) {
    let bytes: Uint8Array;
    try {
      bytes = "bytes" in image ? image.bytes : await download(http, image.url, providerId);
    } catch (error) {
      // One lost download should not cost the images that did arrive.
      if (!(error instanceof ProviderError)) throw error;
      failures.push(error);
      continue;
    }
    const suffix = images.length === 1 ? "" : `-${index + 1}`;
    const file = join(folder, `${base}${suffix}.${imageTypeOf(bytes)?.extension ?? "bin"}`);
    await writeFile(file, bytes);
    files.push(file);
  }
  return { files, failures };
}

async function download(http: HttpTransport, url: string, providerId: string): Promise<Uint8Array> {
  const response = await http(url).catch((error: Error) => {
    throw new ProviderError("other", `Could not download a result from Provider "${providerId}": ${error.message}`);
  });
  if (!response.ok) {
    throw new ProviderError("other", `Downloading a result from Provider "${providerId}" failed with HTTP ${response.status}.`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

const pad = (value: number) => String(value).padStart(2, "0");

function localDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function localTime(date: Date): string {
  return `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}
