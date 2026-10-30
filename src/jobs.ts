import { randomUUID } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ResolvedModel } from "./config.ts";
import type { Dirs } from "./dirs.ts";
import type { HttpTransport } from "./http.ts";
import {
  ProviderError,
  type GeneratedImage,
  type ImageRequest,
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
  request: ImageRequest;
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
  parameters: { n: number };
  durationMs: number;
  files: string[];
  outcome: "completed" | "failed";
  error?: { kind: ProviderErrorKind; message: string };
}

/** Submits a Job, waits for it, saves its images and records it in the Job history. */
export async function runJob(deps: JobRunnerDeps, spec: JobSpec): Promise<CompletedJob> {
  const id = randomUUID();
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
    prompt: spec.request.prompt,
    parameters: { n: spec.request.n },
    durationMs: deps.now().getTime() - startedAt.getTime(),
    files,
    outcome,
    ...(error === undefined ? {} : { error }),
  });

  try {
    const submitted = await spec.adapter.submit(spec.request, target, deps.http);
    const images = await submitted.wait();
    const files = await saveImages(deps, id, startedAt, images, spec.provider.id);
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
  deps: JobRunnerDeps,
  jobId: string,
  startedAt: Date,
  images: GeneratedImage[],
  providerId: string,
): Promise<string[]> {
  const folder = join(deps.dirs.output, localDate(startedAt));
  await mkdir(folder, { recursive: true });
  const base = `${localTime(startedAt)}-${jobId.slice(0, 8)}`;
  const files: string[] = [];
  for (const [index, image] of images.entries()) {
    const bytes = "bytes" in image ? image.bytes : await download(deps.http, image.url, providerId);
    const suffix = images.length === 1 ? "" : `-${index + 1}`;
    const file = join(folder, `${base}${suffix}.${extensionOf(bytes)}`);
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

function extensionOf(bytes: Uint8Array): string {
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
  if (bytes[0] === 0x89 && ascii(1, 4) === "PNG") return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "webp";
  if (ascii(0, 4) === "GIF8") return "gif";
  return "bin";
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
