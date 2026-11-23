import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { ConfigError, loadConfig, needsSettings, type ResolvedModel } from "./config.ts";
import type { Dirs } from "./dirs.ts";
import { appendEvidence } from "./evidence.ts";
import { fileStem, saveNamed, type FileToSave } from "./file-names.ts";
import { appendHistory, appendJobUpdate, readJob, readJobs, type JobRecord, type SourceJob } from "./history.ts";
import type { HttpTransport } from "./http.ts";
import { QueuePlace, withdraw } from "./local/queue.ts";
import type { Runtime } from "./local/runtime.ts";
import { fileTypeOf, mediaFactsOf, type MediaFacts } from "./media.ts";
import type { Requested } from "./protocols/parameter-guide.ts";
import type { NormalisedRequest, NormalisedVideoRequest } from "./protocols/requests.ts";
import { providerError, providerLabel } from "./protocols/errors.ts";
import { adapterForProtocol, credentialFor } from "./protocols/index.ts";
import { checkResult, mismatchOf } from "./result-check.ts";
import { contentHash, findSourceJobs } from "./source-jobs.ts";
import type { OptionInputs } from "./standing-options.ts";
import {
  ProviderError,
  type GeneratedFile,
  type JobContext,
  type JobImages,
  type JobVideo,
  type ModelTarget,
  type ProtocolAdapter,
  type ProviderErrorKind,
  type ReferenceImage,
  type ResumeHandle,
} from "./protocols/protocol.ts";

/** How long `generate_image`, `generate_video` and `get_job` wait for a Job before saying it is still running. */
export const defaultWaitLimitMs = 120_000;

/** How often asynchronous Protocols ask their Provider whether a Job is done. */
export const defaultPollIntervalMs = 3_000;

/** The delay before the first retry of a request the Provider never processed; each further retry waits twice as long. */
export const defaultRetryDelayMs = 2_000;

/** How the call that starts a Job waits for it. */
export interface StartOptions {
  /** false: return the Job running at once. Defaults to true: wait up to the wait limit. */
  wait?: boolean;
}

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
  /** Where Jobs on a Protocol that runs on the Runtime go, once the machine-wide queue gives them their turn. */
  runtime: Runtime;
}

interface SpecBase extends ResolvedModel {
  adapter: ProtocolAdapter;
  credential: string;
  /** Absolute folder to save into; omitted, results go under a dated folder in `dirs.output`. */
  outputDir?: string;
  /** What to name the saved files; omitted, they are named after the time the Job started. */
  name?: string;
  /** The Comparison this Job belongs to (ADR 0009), when it is one of several started together. */
  comparison?: string;
  /** What the merged `providerOptions` were made of. */
  options: OptionInputs;
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
  /** What the final request asked for, as litevision read it (ADR 0010); omitted on Jobs recorded before. */
  requested?: Requested;
}

/** How a Job's options were made, as the Job history records them; empty Standing Options are left out. */
function optionParameters({ options }: SpecBase): Pick<JobBase["parameters"], "standingOptions" | "jobOptions"> {
  return { ...(Object.keys(options.standing).length === 0 ? {} : { standingOptions: options.standing }), jobOptions: options.job };
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

/** Raised inside a Job that was cancelled before its Provider had it, or whose Provider cannot cancel it. */
class JobCancelled extends Error {}

/**
 * What a running Job's caller can do to it: ask to cancel it. Checked at every pause; once the Provider has the Job
 * and can cancel it, it is asked to, and the Job runs on until the Provider says it stopped. Otherwise the Job stops.
 */
class JobControl {
  requested = false;
  private cancelTask: (() => Promise<void>) | undefined;
  private sent = false;
  /** Rejects once a cancel is requested for a Job its Provider cannot cancel, so the Job stops at once. */
  readonly stopped: Promise<never>;
  private stop!: (error: JobCancelled) => void;

  constructor(readonly onRuntime: boolean) {
    this.stopped = new Promise<never>((_, reject) => {
      this.stop = reject;
    });
    this.stopped.catch(() => {});
  }

  /** The Provider has the Job: from now on, a cancel is sent to it, where the Protocol can. */
  submitted(adapter: ProtocolAdapter, handle: ResumeHandle, target: ModelTarget, http: HttpTransport): void {
    const cancel = adapter.cancel;
    if (cancel !== undefined) this.cancelTask = () => cancel.call(adapter, handle, target, http);
  }

  request(): void {
    this.requested = true;
    if (!this.onRuntime) this.stop(new JobCancelled());
  }

  async check(): Promise<void> {
    if (!this.requested) return;
    if (this.cancelTask === undefined) throw new JobCancelled();
    if (this.sent) return;
    this.sent = true;
    await this.cancelTask();
  }
}

/** What a cancelled Job's record and error say. */
function cancelledMessage(onRuntime: boolean, providerId: string): string {
  return onRuntime
    ? "The Job was cancelled."
    : `The Job was cancelled: litevision stopped waiting for it, but ${providerLabel(providerId)} may still finish it and bill for it.`;
}

/** What `cancel` did: stopped the Job, or asked its Runtime to, which stops it at its next step. */
export interface CancelOutcome {
  status: "cancelled" | "cancelling";
  message: string;
}

/** Raised inside a Job when litevision shuts down under it. Nothing more is recorded, so the Job can be resumed. */
/**
 * The User deleted the Job while something still ran it, as when it was taken for interrupted. To the Agent it is a Job
 * litevision does not have.
 */
class JobDeleted extends ConfigError {
  constructor(readonly id: string) {
    super(`litevision has no Job "${id}": it was deleted while it ran, and so were the Results it brought back.`);
  }
}

class JobAbandoned extends Error {
  constructor() {
    super("litevision shut down while the Job was running.");
  }
}

/** What a Job's records share; the rest of a record says where the Job stands. */
type JobBase = Omit<JobRecord, "durationMs" | "files" | "hashes" | "outcome" | "resume" | "cost" | "shortfall" | "observed" | "mismatch" | "error">;

type JobProgress = Partial<Pick<JobRecord, "files" | "hashes" | "resume" | "cost" | "shortfall" | "observed" | "mismatch" | "error">>;

const lostMessage = "litevision stopped before this Job finished, so its result is lost; start it again.";

/**
 * Runs Jobs for every Protocol: submit, wait, poll, download, save, and the Job history. A Job outlives the tool call
 * that started it: past the wait limit the caller gets its id, and `get` picks it up again, from the Job history when
 * litevision has restarted since.
 */
export class JobRunner {
  /** Every Job this process has run or resumed, settled or not. */
  private readonly jobs = new Map<string, Promise<CompletedJob>>();
  /** The Jobs this process is running now. */
  private readonly controls = new Map<string, JobControl>();
  private readonly abandons = new Set<() => void>();
  private closed = false;
  /** The latest save; the next one waits for it. */
  private saving: Promise<unknown> = Promise.resolve();
  private readonly waitLimitMs: number;
  private readonly pollIntervalMs: number;
  private readonly retryDelayMs: number;

  constructor(private readonly deps: JobRunnerDeps) {
    this.waitLimitMs = deps.waitLimitMs ?? defaultWaitLimitMs;
    this.pollIntervalMs = deps.pollIntervalMs ?? defaultPollIntervalMs;
    this.retryDelayMs = deps.retryDelayMs ?? defaultRetryDelayMs;
  }

  /**
   * Starts an image Job and waits for it up to the wait limit; with `wait` false, returns it running at once, and it
   * runs on in the background like a Job that outlasted the wait limit.
   */
  async start(spec: JobSpec, { wait = true }: StartOptions = {}): Promise<JobState> {
    const { request } = spec.normalised;
    const sourceJobs = await this.sourceJobsOf(request.references);
    const base = this.baseFor(spec, "image", request.prompt, sourceJobs, {
      n: request.n,
      requested: spec.normalised.requested,
      references: request.references.map((reference) => reference.path),
      ...(spec.outputDir === undefined ? {} : { outputPath: spec.outputDir }),
      ...(spec.name === undefined ? {} : { name: spec.name }),
      providerOptions: request.providerOptions,
      ...optionParameters(spec),
    });
    const target = await this.targetOf(spec);
    // Recorded before the Provider is called, so a Job lost with this process is never silently forgotten.
    await this.append(base, "running", {}, { first: true });
    const job = this.track(base, spec.credential, spec.adapter, target, async (target, context, control) => {
      const submitted = await spec.adapter.submit(request, target, this.deps.http, context);
      if (submitted.resumeHandle !== undefined) {
        await this.append(base, "running", { resume: submitted.resumeHandle });
        control.submitted(spec.adapter, submitted.resumeHandle, target, this.deps.http);
      }
      return submitted.wait();
    });
    return this.reply(base, job, wait);
  }

  /** Starts a video Job and waits for it up to the wait limit, or not at all when `wait` is false, as {@link start}. */
  async startVideo(spec: VideoJobSpec, { wait = true }: StartOptions = {}): Promise<JobState> {
    const { request } = spec.normalised;
    const submitVideo = spec.adapter.submitVideo;
    if (submitVideo === undefined) {
      throw new ConfigError(`Model "${spec.model.alias}" uses Protocol "${spec.model.protocol}", which litevision cannot make videos with.`);
    }
    const frames = [request.firstFrame, request.lastFrame].filter((frame) => frame !== undefined);
    const sourceJobs = await this.sourceJobsOf([...frames, ...request.references]);
    const base = this.baseFor(spec, "video", request.prompt, sourceJobs, {
      n: 1,
      requested: spec.normalised.requested,
      references: request.references.map((reference) => reference.path),
      ...(request.firstFrame === undefined ? {} : { firstFrame: request.firstFrame.path }),
      ...(request.lastFrame === undefined ? {} : { lastFrame: request.lastFrame.path }),
      ...(spec.outputDir === undefined ? {} : { outputPath: spec.outputDir }),
      ...(spec.name === undefined ? {} : { name: spec.name }),
      providerOptions: request.providerOptions,
      ...optionParameters(spec),
    });
    const target = await this.targetOf(spec);
    await this.append(base, "running", {}, { first: true });
    const job = this.track(base, spec.credential, spec.adapter, target, async (target, context, control) => {
      const submitted = await submitVideo.call(spec.adapter, request, target, this.deps.http, context);
      await this.append(base, "running", { resume: submitted.resumeHandle });
      control.submitted(spec.adapter, submitted.resumeHandle, target, this.deps.http);
      return videoAsImages(await submitted.wait());
    });
    return this.reply(base, job, wait);
  }

  /**
   * What the call that started a Job returns. A Job not waited for is still registered, so its failure is recorded
   * and handled there, and `get` reports it.
   */
  private reply(base: JobBase, job: Promise<CompletedJob>, wait: boolean): Promise<JobState> {
    const registered = this.register(base.id, job);
    return wait ? this.waitFor(base.model, base.id, registered) : Promise.resolve({ status: "running", id: base.id, model: base.model });
  }

  /**
   * Where a new Job goes, checked before it starts: a cloud Provider's base URL; for a Job on the Runtime, which has
   * its address only once the Job's turn comes, the installed Runtime.
   */
  private async targetOf(spec: SpecBase): Promise<ModelTarget> {
    const { provider, model, credential, adapter } = spec;
    if (adapter.onRuntime) await this.deps.runtime.requireInstalled();
    else if (provider.baseUrl === undefined) throw needsSettings(`Provider "${provider.id}" has no base URL.`);
    return { providerId: provider.id, baseUrl: provider.baseUrl ?? "", modelId: model.modelId, credential };
  }

  /** A new Job's Source Jobs: the earlier Jobs that saved what its reference images and video frames hold now. */
  private async sourceJobsOf(references: ReferenceImage[]): Promise<SourceJob[]> {
    return references.length === 0 ? [] : findSourceJobs(await readJobs(this.deps.dirs), references);
  }

  private baseFor(spec: SpecBase, modality: JobBase["modality"], prompt: string, sourceJobs: SourceJob[], parameters: JobBase["parameters"]): JobBase {
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
      ...(spec.comparison === undefined ? {} : { comparison: spec.comparison }),
      ...(sourceJobs.length === 0 ? {} : { sourceJobs }),
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
          ...(record.parameters.requested === undefined ? {} : { requested: record.parameters.requested }),
        };
      }
      if (record.outcome === "failed") {
        throw new JobFailedError(id, record.error?.kind ?? "other", record.error?.message ?? "The Job failed.");
      }
      job = this.register(id, this.resume(record));
    }
    return this.waitFor(record.model, id, job);
  }

  /**
   * Cancels a running Job. One this process runs stops at its next pause; on the Runtime, sd-server stops it at its
   * next step, keeping the Model loaded. A local Job another process runs is stopped by that process, through the
   * queue. A cloud Job is only no longer waited for: its Provider may still finish it and bill for it.
   */
  async cancel(id: string): Promise<CancelOutcome> {
    const record = await readJob(this.deps.dirs, id);
    if (record === undefined) throw new ConfigError(`litevision has no Job "${id}". Use the \`job_id\` that \`generate_image\` returned.`);
    if (record.outcome !== "running") {
      const ended = record.outcome === "completed" ? "already completed" : record.error?.kind === "cancelled" ? "already been cancelled" : "already failed";
      throw new ConfigError(`Job ${id} has ${ended}; there is nothing to cancel.`);
    }
    const adapter = adapterForProtocol(record.protocol);
    const control = this.controls.get(id);
    const job = this.jobs.get(id);
    const runtime = adapter?.onRuntime === true;
    const elsewhere = runtime && (await withdraw(this.deps.dirs, id));
    if (control !== undefined && job !== undefined) {
      control.request();
      return this.settled(id, job);
    }
    if (elsewhere) {
      return {
        status: "cancelling",
        message: "Another litevision session runs this Job and stops it: at once while it waits for its turn, else at the Runtime's next step. Call `get_job` to see it end.",
      };
    }
    // No process here runs the Job; a local one's task may still be on the Runtime. A cloud one another session waits
    // for ends there too: that session finds it cancelled before saving anything.
    if (runtime && record.resume !== undefined && adapter?.cancel !== undefined) {
      const baseUrl = await this.deps.runtime.address({ start: false });
      const target = { providerId: record.provider, baseUrl: baseUrl ?? "", modelId: record.modelId, credential: "" };
      if (baseUrl !== undefined) await adapter.cancel(record.resume, target, this.deps.http).catch(() => undefined);
    }
    const message = cancelledMessage(runtime, record.provider);
    await this.append(baseOf(record), "failed", { error: { kind: "cancelled", message } });
    return { status: "cancelled", message };
  }

  /** How a Job this process runs ended once cancelled, waiting up to the wait limit for it to stop. */
  private async settled(id: string, job: Promise<CompletedJob>): Promise<CancelOutcome> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<"waiting">((resolve) => {
      timer = setTimeout(() => resolve("waiting"), this.waitLimitMs);
    });
    try {
      const ended = await Promise.race([job.then(() => "completed" as const), limit]);
      if (ended === "completed") throw new ConfigError(`Job ${id} completed before it could be cancelled. Call \`get_job\` for its files.`);
      return { status: "cancelling", message: "The Runtime stops the Job at its next step. Call `get_job` to see it end." };
    } catch (error) {
      if (error instanceof JobFailedError && error.kind === "cancelled") return { status: "cancelled", message: error.message };
      if (error instanceof JobAbandoned) return { status: "cancelling", message: "litevision is shutting down." };
      throw error;
    } finally {
      clearTimeout(timer);
    }
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
    checkCancelled: async () => {},
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

  /** Keeps a Job for `get`. Its failure is handled here, so a Job no call waits for never rejects unhandled. */
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
    const credential = await credentialFor(this.deps.dirs, provider, adapter);
    // This process runs it now: claimed first, so it is not taken for interrupted and deleted meanwhile.
    await this.append(base, "running", { resume: handle });
    const target = { providerId: provider.id, baseUrl: provider.baseUrl ?? "", modelId: record.modelId, credential };
    if (video) {
      const resumeVideo = adapter.resumeVideo!;
      return this.track(base, credential, adapter, target, async (target, context, control) => {
        control.submitted(adapter, handle, target, this.deps.http);
        return videoAsImages(await resumeVideo.call(adapter, handle, target, this.deps.http, context).wait());
      }, true);
    }
    const resumeImages = adapter.resume!;
    return this.track(base, credential, adapter, target, (target, context, control) => {
      control.submitted(adapter, handle, target, this.deps.http);
      return resumeImages.call(adapter, handle, target, this.deps.http, context).wait();
    }, true);
  }

  /**
   * Runs a Job to its end: saves what it brought back and records how it went. A Job on the Runtime first waits for
   * its turn in the machine-wide queue, and goes to the Runtime's address.
   */
  private async track(
    base: JobBase,
    credential: string,
    adapter: ProtocolAdapter,
    target: ModelTarget,
    run: RunJob,
    /** A Job picked up after a restart: its task is on the Runtime that ran it, or gone with it. */
    resuming = false,
  ): Promise<CompletedJob> {
    // A Provider may echo the Credential back in an error; it must never reach the Agent or the history.
    const safe = (text: string) => redact(text, credential);
    const { n } = base.parameters;
    const control = new JobControl(adapter.onRuntime === true);
    this.controls.set(base.id, control);
    const context = checkedContext(this.context, () => control.check());
    try {
      const running = control.onRuntime ? this.onRuntime(base, target, context, control, run, resuming) : run(target, context, control);
      const result = await Promise.race([running, control.stopped]);
      // Cancelled from another session, which cannot reach this one but through the Job history.
      if ((await readJob(this.deps.dirs, base.id))?.error?.kind === "cancelled") throw new JobCancelled();
      if (this.closed) throw new JobAbandoned();
      const fetched = await fetchResults(this.deps.http, result.images, base.provider);
      const reasons = [result.shortfall, ...fetched.failures.map((failure) => failure.message)].filter((reason) => reason !== undefined);
      if (fetched.downloaded.length === 0) {
        throw fetched.failures[0] ?? providerError("other", base.provider, reasons[0] ?? "it returned nothing.");
      }
      const files = await this.save(base, fetched.downloaded);
      // Recorded with the files, so a later Job that uses one, or a copy of it, as a reference finds this Job.
      const hashes = fetched.downloaded.map((file) => contentHash(file.bytes));
      const observed = fetched.facts;
      const mismatch = mismatchOf(checkResult(base.parameters, observed));
      const shortfall =
        files.length >= n
          ? undefined
          : safe(
              `Got ${files.length} of ${n} images from ${providerLabel(base.provider)}.${reasons.length === 0 ? "" : ` ${reasons.join(" ")}`}`,
            );
      try {
        await this.append(base, "completed", { files, hashes, shortfall, cost: result.cost, observed, mismatch });
      } catch (error) {
        // The Job was deleted while it ran: its Results go with it.
        if (error instanceof JobDeleted) await Promise.all(files.map((file) => rm(file, { force: true })));
        throw error;
      }
      return {
        id: base.id,
        files,
        observed,
        ...(shortfall === undefined ? {} : { shortfall }),
        ...(mismatch === undefined ? {} : { mismatch }),
        ...(base.parameters.requested === undefined ? {} : { requested: base.parameters.requested }),
      };
    } catch (error) {
      if (error instanceof JobDeleted) throw error;
      if (error instanceof JobAbandoned || this.closed) throw new JobAbandoned();
      if (error instanceof JobCancelled || (error instanceof ProviderError && error.kind === "cancelled")) {
        const message = cancelledMessage(control.onRuntime, base.provider);
        await this.append(base, "failed", { error: { kind: "cancelled", message } });
        throw new JobFailedError(base.id, "cancelled", message);
      }
      const kind = error instanceof ProviderError ? error.kind : "other";
      const message = safe((error as Error).message);
      const options = error instanceof ProviderError ? error.options : [];
      await this.append(base, "failed", { error: { kind, message, ...(options.length === 0 ? {} : { options: [...options] }) } });
      throw new JobFailedError(base.id, kind, message);
    } finally {
      this.controls.delete(base.id);
    }
  }

  /**
   * Runs a Job on the Runtime once the machine-wide queue gives it the turn, which it holds until the Job ends: the
   * Runtime holds one Model and will not switch it under a running Job. Its queue file going away cancels it.
   */
  private async onRuntime(
    base: JobBase,
    target: ModelTarget,
    context: JobContext,
    control: JobControl,
    run: RunJob,
    resuming: boolean,
  ): Promise<JobImages> {
    const place = await QueuePlace.join(this.deps.dirs, base.id, base.modelId);
    const queued = checkedContext(this.context, async () => {
      if (await place.withdrawn()) control.request();
      await control.check();
    });
    try {
      while (!(await place.take())) await queued.pause();
      const baseUrl = await this.deps.runtime.address({ start: !resuming });
      if (baseUrl === undefined) {
        throw providerError("other", base.provider, "the Runtime that ran this Job has stopped, and its tasks with it. Generate again.");
      }
      return await run({ ...target, baseUrl }, queued, control);
    } finally {
      await place.leave();
    }
  }

  /**
   * Saves a Job's results under its `name`, or the time it started, in its folder. One at a time, so Jobs finishing
   * together, as in a Comparison, never take the same free name.
   */
  private save(base: JobBase, files: FileToSave[]): Promise<string[]> {
    const startedAt = new Date(base.createdAt);
    const folder = base.parameters.outputPath ?? join(this.deps.dirs.output, localDate(startedAt));
    const stem = base.parameters.name === undefined ? undefined : fileStem(base.parameters.name);
    const saving = this.saving.then(async () => {
      await mkdir(folder, { recursive: true });
      return saveNamed(folder, stem ?? localTime(startedAt), files, base.parameters.n > 1);
    });
    this.saving = saving.catch(() => undefined);
    return saving;
  }

  /**
   * Records where a Job stands. Its first record starts it in the Job history; every later one is appended only while
   * the Job is still there, and otherwise throws {@link JobDeleted}, so a Job the User deleted never comes back.
   */
  private async append(base: JobBase, outcome: JobRecord["outcome"], progress: JobProgress = {}, { first = false } = {}): Promise<void> {
    if (this.closed) throw new JobAbandoned();
    const defined = Object.fromEntries(Object.entries(progress).filter(([, value]) => value !== undefined));
    const record: JobRecord = {
      ...base,
      durationMs: this.deps.now().getTime() - Date.parse(base.createdAt),
      files: [],
      outcome,
      // A running Job names this process, so once it is gone the Job is known to be interrupted.
      ...(outcome === "running" ? { owner: { pid: process.pid } } : {}),
      ...defined,
    };
    const kept = first ? (await appendHistory(this.deps.dirs, record), true) : await appendJobUpdate(this.deps.dirs, record);
    // What the Job showed about its options counts even once the Job is deleted (ADR 0015). Evidence that fails to be
    // written is written on the next read; the Job itself went as recorded.
    await appendEvidence(this.deps.dirs, record).catch(() => undefined);
    if (!kept) throw new JobDeleted(base.id);
  }
}

/** How a Job runs once litevision knows where its Provider is: submit or pick up, then wait. */
type RunJob = (target: ModelTarget, context: JobContext, control: JobControl) => Promise<JobImages>;

/** The Job runner's context, with `check` run after every pause and before a submission. */
function checkedContext(context: JobContext, check: () => Promise<void>): JobContext {
  return {
    pause: async () => {
      await context.pause();
      await check();
    },
    backoff: async (retry) => {
      await context.backoff(retry);
      await check();
    },
    checkCancelled: check,
  };
}

function baseOf(record: JobRecord): JobBase {
  const { type, id, createdAt, model, provider, protocol, modelId, modality, prompt, parameters, comparison, sourceJobs } = record;
  return {
    type,
    id,
    createdAt,
    model,
    provider,
    protocol,
    modelId,
    ...(modality === undefined ? {} : { modality }),
    prompt,
    parameters,
    ...(comparison === undefined ? {} : { comparison }),
    ...(sourceJobs === undefined ? {} : { sourceJobs }),
  };
}



/** A video Job is saved like an image Job with one result. */
function videoAsImages(result: JobVideo): JobImages {
  return { images: [result.video], ...(result.cost === undefined ? {} : { cost: result.cost }) };
}

function redact(text: string, credential: string): string {
  return credential === "" ? text : text.split(credential).join("[redacted]");
}

/** Downloads what a Job brought back. One lost download does not cost the results that did arrive. */
async function fetchResults(
  http: HttpTransport,
  results: GeneratedFile[],
  providerId: string,
): Promise<{ downloaded: FileToSave[]; facts: Array<MediaFacts | null>; failures: ProviderError[] }> {
  const downloaded: FileToSave[] = [];
  const facts: Array<MediaFacts | null> = [];
  const failures: ProviderError[] = [];
  for (const result of results) {
    try {
      const bytes = "bytes" in result ? result.bytes : await download(http, result.url, providerId);
      downloaded.push({ bytes, extension: fileTypeOf(bytes)?.extension ?? "bin" });
      facts.push(mediaFactsOf(bytes) ?? null);
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      failures.push(error);
    }
  }
  return { downloaded, facts, failures };
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
