import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ResolvedModel } from "./config.ts";
import type { Dirs } from "./dirs.ts";
import { appendHistory, type JobRecord } from "./history.ts";
import { imageTypeOf } from "./images.ts";
import type { HttpTransport } from "./http.ts";
import type { NormalisedRequest } from "./protocols/capabilities.ts";
import { providerError, providerLabel } from "./protocols/errors.ts";
import { ProviderError, type GeneratedImage, type ProtocolAdapter, type ProviderErrorKind } from "./protocols/protocol.ts";

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
  /** Why fewer files than requested were saved; omitted when none are missing. Safe to show the Agent. */
  shortfall?: string;
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
  const record = (
    outcome: JobRecord["outcome"],
    files: string[],
    problem: { shortfall?: string; error?: JobRecord["error"] } = {},
  ): JobRecord => ({
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
    ...(problem.shortfall === undefined ? {} : { shortfall: problem.shortfall }),
    ...(problem.error === undefined ? {} : { error: problem.error }),
  });
  // A Provider may echo the Credential back in an error; it must never reach the Agent or the history.
  const safe = (text: string) => redact(text, spec.credential);

  try {
    const submitted = await spec.adapter.submit(request, target, deps.http);
    const result = await submitted.wait();
    const folder = spec.outputDir ?? join(deps.dirs.output, localDate(startedAt));
    const saved = await saveImages(deps.http, folder, id, startedAt, result.images, spec.provider.id);
    const reasons = [result.shortfall, ...saved.failures.map((failure) => failure.message)].filter((reason) => reason !== undefined);
    if (saved.files.length === 0) {
      throw saved.failures[0] ?? providerError("other", spec.provider.id, reasons[0] ?? "it returned no images.");
    }
    const shortfall =
      saved.files.length >= request.n
        ? undefined
        : safe(
            `Got ${saved.files.length} of ${request.n} images from ${providerLabel(spec.provider.id)}.${reasons.length === 0 ? "" : ` ${reasons.join(" ")}`}`,
          );
    await appendHistory(deps.dirs, record("completed", saved.files, { shortfall }));
    return { id, files: saved.files, ...(shortfall === undefined ? {} : { shortfall }) };
  } catch (error) {
    const kind = error instanceof ProviderError ? error.kind : "other";
    const message = safe((error as Error).message);
    await appendHistory(deps.dirs, record("failed", [], { error: { kind, message } }));
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
