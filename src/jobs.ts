import { randomUUID } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ResolvedModel } from "./config.ts";
import type { Dirs } from "./dirs.ts";
import { imageTypeOf } from "./images.ts";
import type { HttpTransport } from "./http.ts";
import type { NormalisedRequest } from "./protocols/capabilities.ts";
import {
  ProviderError,
  type AspectRatio,
  type GeneratedImage,
  type ImageSize,
  type ProtocolAdapter,
  type ProviderErrorKind,
} from "./protocols/protocol.ts";

export interface JobRunnerDeps {
  dirs: Dirs;
  http: HttpTransport;
  now: () => Date;
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
}

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

/** One line of `jobs.jsonl`. */
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
  error?: { kind: ProviderErrorKind; message: string };
}

/** Submits a Job, waits for it, saves its images and records it in the Job history. */
export async function runJob(deps: JobRunnerDeps, spec: JobSpec): Promise<CompletedJob> {
  const id = randomUUID();
  const { request } = spec.normalised;
  const startedAt = deps.now();
  const target = {
    providerId: spec.provider.id,
    baseUrl: spec.provider.baseUrl,
    modelId: spec.model.modelId,
    credential: spec.credential,
  };
  const record = (outcome: JobRecord["outcome"], files: string[], error?: JobRecord["error"]): JobRecord => ({
    type: "job",
    id,
    createdAt: startedAt.toISOString(),
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
    durationMs: deps.now().getTime() - startedAt.getTime(),
    files,
    outcome,
    ...(error === undefined ? {} : { error }),
  });

  try {
    const submitted = await spec.adapter.submit(request, target, deps.http);
    const images = await submitted.wait();
    const folder = spec.outputDir ?? join(deps.dirs.output, localDate(startedAt));
    const files = await saveImages(deps.http, folder, id, startedAt, images, spec.provider.id);
    await appendHistory(deps.dirs, record("completed", files));
    return { id, files };
  } catch (error) {
    const kind = error instanceof ProviderError ? error.kind : "other";
    // A Provider may echo the Credential back in an error; it must never reach the Agent or the history.
    const message = redact((error as Error).message, spec.credential);
    await appendHistory(deps.dirs, record("failed", [], { kind, message }));
    throw new JobFailedError(id, kind, message);
  }
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
): Promise<string[]> {
  await mkdir(folder, { recursive: true });
  const base = `${localTime(startedAt)}-${jobId.slice(0, 8)}`;
  const files: string[] = [];
  for (const [index, image] of images.entries()) {
    const bytes = "bytes" in image ? image.bytes : await download(http, image.url, providerId);
    const suffix = images.length === 1 ? "" : `-${index + 1}`;
    const file = join(folder, `${base}${suffix}.${imageTypeOf(bytes)?.extension ?? "bin"}`);
    await writeFile(file, bytes);
    files.push(file);
  }
  return files;
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

async function appendHistory(dirs: Dirs, record: JobRecord): Promise<void> {
  await mkdir(dirs.data, { recursive: true });
  await appendFile(join(dirs.data, "jobs.jsonl"), `${JSON.stringify(record)}\n`);
}

const pad = (value: number) => String(value).padStart(2, "0");

function localDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function localTime(date: Date): string {
  return `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}
