import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ConfigError, loadConfig, needsSettings, requireCredential, type ResolvedModel } from "./config.ts";
import type { Dirs } from "./dirs.ts";
import { appendHistory, readJob, type JobRecord } from "./history.ts";
import type { HttpTransport } from "./http.ts";
import { fileTypeOf, mediaFactsOf, type MediaFacts } from "./media.ts";
import { ratioOf, type NormalisedRequest, type NormalisedVideoRequest } from "./protocols/capabilities.ts";
import { providerError, providerLabel } from "./protocols/errors.ts";
import { adapterForProtocol } from "./protocols/index.ts";
import {
  formatSize,
  ProviderError,
  type GeneratedFile,
  type JobContext,
  type JobImages,
  type JobVideo,
  type ProtocolAdapter,
  type ProviderErrorKind,
} from "./protocols/protocol.ts";

/** How long `generate_image` and `get_job` wait for a Job before saying it is still running. */
export const defaultWaitLimitMs = 120_000;

/** How often asynchronous Protocols ask their Provider whether a Job is done. */
export const defaultPollIntervalMs = 3_000;

/** The delay before the first retry of a request the Provider never processed; each further retry waits twice as long. */
export const defaultRetryDelayMs = 2_000;

export interface JobRunnerDeps {
  dirs: Dirs;
  http: HttpTransport;
  now: () => Date;
  /** Defaults to {@link defaultWaitLimitMs}. */
  waitLimitMs?: number;
  /** Defaults to {@link defaultPollIntervalMs}. */
  pollIntervalMs?: number;
  /** Defaults to {@link defaultRetryDelayMs}. */
  retryDelayMs?: number;
}

interface SpecBase extends ResolvedModel {
  adapter: ProtocolAdapter;
  credential: string;
  /** Absolute folder to save into; omitted, results go under a dated folder in `dirs.output`. */
  outputDir?: string;
}

export interface JobSpec extends SpecBase {
  normalised: NormalisedRequest;
}

export interface VideoJobSpec extends SpecBase {
  normalised: NormalisedVideoRequest;
}

export interface CompletedJob {
  id: string;
  files: string[];
  /** Why fewer files than requested were saved; omitted when none are missing. Safe to show the Agent. */
  shortfall?: string;
  /** What each saved file turned out to be, in the order of `files`; `null` where litevision could not tell. */
  observed: Array<MediaFacts | null>;
  /** How the result differs from the request (ADR 0006); omitted when it matched as far as litevision can tell. */
  mismatch?: string;
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
type JobBase = Omit<JobRecord, "durationMs" | "files" | "outcome" | "resume" | "cost" | "shortfall" | "observed" | "mismatch" | "error">;

type JobProgress = Partial<Pick<JobRecord, "files" | "resume" | "cost" | "shortfall" | "observed" | "mismatch" | "error">>;

const lostMessage = "litevision stopped before this Job finished, so its result is lost; start it again.";

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
  private readonly retryDelayMs: number;

  constructor(private readonly deps: JobRunnerDeps) {
    this.waitLimitMs = deps.waitLimitMs ?? defaultWaitLimitMs;
    this.pollIntervalMs = deps.pollIntervalMs ?? defaultPollIntervalMs;
    this.retryDelayMs = deps.retryDelayMs ?? defaultRetryDelayMs;
  }

  /** Starts an image Job and waits for it up to the wait limit. */
  async start(spec: JobSpec): Promise<JobState> {
    const { request } = spec.normalised;
    const base = this.baseFor(spec, "image", request.prompt, {
      n: request.n,
      aspectRatio: spec.normalised.requestedAspectRatio,
      size: request.size,
      references: request.references.map((reference) => reference.path),
      ...(spec.outputDir === undefined ? {} : { outputPath: spec.outputDir }),
      providerOptions: request.providerOptions,
    });
    const target = targetOf(spec);
    // Recorded before the Provider is called, so a Job lost with this process is never silently forgotten.
    await this.append(base, "running");
    const job = this.track(base, spec.credential, async (context) => {
      const submitted = await spec.adapter.submit(request, target, this.deps.http, context);
      if (submitted.resumeHandle !== undefined) await this.append(base, "running", { resume: submitted.resumeHandle });
      return submitted.wait();
    });
    return this.waitFor(base.model, base.id, this.register(base.id, job));
  }

  /** Starts a video Job and waits for it up to the wait limit. */
  async startVideo(spec: VideoJobSpec): Promise<JobState> {
    const { request } = spec.normalised;
    const submitVideo = spec.adapter.submitVideo;
    if (submitVideo === undefined) {
      throw new ConfigError(`Model "${spec.model.alias}" uses Protocol "${spec.model.protocol}", which litevision cannot make videos with.`);
    }
    const base = this.baseFor(spec, "video", request.prompt, {
      n: 1,
      aspectRatio: spec.normalised.requestedAspectRatio,
      size: request.size,
      references: request.references.map((reference) => reference.path),
      seconds: request.seconds,
      ...(request.resolution === undefined ? {} : { resolution: request.resolution }),
      ...(spec.normalised.followsFirstFrame ? { followsFirstFrame: true as const } : {}),
      ...(request.firstFrame === undefined ? {} : { firstFrame: request.firstFrame.path }),
      ...(request.lastFrame === undefined ? {} : { lastFrame: request.lastFrame.path }),
      ...(spec.outputDir === undefined ? {} : { outputPath: spec.outputDir }),
      providerOptions: request.providerOptions,
    });
    const target = targetOf(spec);
    await this.append(base, "running");
    const job = this.track(base, spec.credential, async (context) => {
      const submitted = await submitVideo.call(spec.adapter, request, target, this.deps.http, context);
      await this.append(base, "running", { resume: submitted.resumeHandle });
      return videoAsImages(await submitted.wait());
    });
    return this.waitFor(base.model, base.id, this.register(base.id, job));
  }

  private baseFor(spec: SpecBase, modality: JobBase["modality"], prompt: string, parameters: JobBase["parameters"]): JobBase {
    return {
      type: "job",
      id: randomUUID(),
      createdAt: this.deps.now().toISOString(),
      model: spec.model.alias,
      provider: spec.provider.id,
      protocol: spec.model.protocol,
      modelId: spec.model.modelId,
      modality,
      prompt,
      parameters,
    };
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
          observed: record.observed ?? record.files.map(() => null),
          ...(record.shortfall === undefined ? {} : { shortfall: record.shortfall }),
          ...(record.mismatch === undefined ? {} : { mismatch: record.mismatch }),
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
    pause: () => this.sleep(this.pollIntervalMs),
    backoff: (retry) => this.sleep(this.retryDelayMs * 2 ** (retry - 1)),
  };

  /** Resolves after `ms`, or rejects with {@link JobAbandoned} when litevision shuts down first. */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new JobAbandoned());
      const abandon = () => {
        clearTimeout(timer);
        reject(new JobAbandoned());
      };
      const timer = setTimeout(() => {
        this.abandons.delete(abandon);
        resolve();
      }, ms);
      this.abandons.add(abandon);
    });
  }

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
    const video = record.modality === "video";
    const resume = video ? adapter?.resumeVideo : adapter?.resume;
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
    if (video) {
      const resumeVideo = adapter.resumeVideo!;
      return this.track(base, credential, async (context) => videoAsImages(await resumeVideo.call(adapter, handle, target, this.deps.http, context).wait()));
    }
    const resumeImages = adapter.resume!;
    return this.track(base, credential, (context) => resumeImages.call(adapter, handle, target, this.deps.http, context).wait());
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
      const saved = await saveFiles(this.deps.http, folder, base.id, startedAt, result.images, base.provider);
      const reasons = [result.shortfall, ...saved.failures.map((failure) => failure.message)].filter((reason) => reason !== undefined);
      if (saved.files.length === 0) {
        throw saved.failures[0] ?? providerError("other", base.provider, reasons[0] ?? "it returned nothing.");
      }
      const observed = saved.facts;
      const mismatch = mismatchOf(base.parameters, observed);
      const shortfall =
        saved.files.length >= n
          ? undefined
          : safe(
              `Got ${saved.files.length} of ${n} images from ${providerLabel(base.provider)}.${reasons.length === 0 ? "" : ` ${reasons.join(" ")}`}`,
            );
      await this.append(base, "completed", { files: saved.files, shortfall, cost: result.cost, observed, mismatch });
      return {
        id: base.id,
        files: saved.files,
        observed,
        ...(shortfall === undefined ? {} : { shortfall }),
        ...(mismatch === undefined ? {} : { mismatch }),
      };
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
  const { type, id, createdAt, model, provider, protocol, modelId, modality, prompt, parameters } = record;
  return { type, id, createdAt, model, provider, protocol, modelId, ...(modality === undefined ? {} : { modality }), prompt, parameters };
}

function targetOf(spec: SpecBase) {
  return { providerId: spec.provider.id, baseUrl: spec.provider.baseUrl, modelId: spec.model.modelId, credential: spec.credential };
}

/** A video Job is saved like an image Job with one result. */
function videoAsImages(result: JobVideo): JobImages {
  return { images: [result.video], ...(result.cost === undefined ? {} : { cost: result.cost }) };
}

/** A result whose shape is more than 5% off the requested one; small differences come from rounding to a Model's grid. */
const aspectTolerance = Math.log(1.05);

/** Half a second either way: containers round a clip's length to whole frames. */
const durationToleranceSeconds = 0.5;

/**
 * How the saved files differ from what was requested, as far as their headers tell (ADR 0006). Pixel counts are not
 * compared, since `provider_options` such as a resolution tier are meant to change them; the shape and length are.
 */
/**
 * The shape a result should have: `width` and `height` from `provider_options` when the Agent set both (video Models
 * leave them open), else the ratio asked for, not the size table's rounding of it (Kontext answers 16:9 with 1392x752).
 */
function expectedShape(parameters: JobRecord["parameters"]): { ratio: number; asked: string } {
  const { width, height } = parameters.providerOptions;
  if (typeof width === "number" && typeof height === "number" && width > 0 && height > 0) {
    return { ratio: width / height, asked: `${width}x${height} in provider_options` };
  }
  return { ratio: ratioOf(parameters.size.aspectRatio), asked: `${parameters.size.aspectRatio} (${formatSize(parameters.size)})` };
}

function mismatchOf(parameters: JobRecord["parameters"], observed: Array<MediaFacts | null>): string | undefined {
  const { seconds, followsFirstFrame } = parameters;
  const expected = expectedShape(parameters);
  const problems = new Set<string>();
  for (const facts of observed) {
    if (facts === null) continue;
    if (!followsFirstFrame && Math.abs(Math.log(facts.width / facts.height / expected.ratio)) > aspectTolerance) {
      problems.add(`asked for ${expected.asked}, got ${facts.width}x${facts.height}`);
    }
    if (seconds !== undefined && facts.seconds !== undefined && Math.abs(facts.seconds - seconds) > durationToleranceSeconds) {
      problems.add(`asked for ${seconds} s, got ${facts.seconds} s`);
    }
  }
  return problems.size === 0 ? undefined : [...problems].join("; ");
}

function redact(text: string, credential: string): string {
  return text.split(credential).join("[redacted]");
}

async function saveFiles(
  http: HttpTransport,
  folder: string,
  jobId: string,
  startedAt: Date,
  results: GeneratedFile[],
  providerId: string,
): Promise<{ files: string[]; facts: Array<MediaFacts | null>; failures: ProviderError[] }> {
  await mkdir(folder, { recursive: true });
  const base = `${localTime(startedAt)}-${jobId.slice(0, 8)}`;
  const files: string[] = [];
  const facts: Array<MediaFacts | null> = [];
  const failures: ProviderError[] = [];
  for (const [index, image] of results.entries()) {
    let bytes: Uint8Array;
    try {
      bytes = "bytes" in image ? image.bytes : await download(http, image.url, providerId);
    } catch (error) {
      // One lost download should not cost the images that did arrive.
      if (!(error instanceof ProviderError)) throw error;
      failures.push(error);
      continue;
    }
    const suffix = results.length === 1 ? "" : `-${index + 1}`;
    const file = join(folder, `${base}${suffix}.${fileTypeOf(bytes)?.extension ?? "bin"}`);
    await writeFile(file, bytes);
    files.push(file);
    facts.push(mediaFactsOf(bytes) ?? null);
  }
  return { files, facts, failures };
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
