import { z } from "zod";
import type { HttpTransport } from "../http.ts";
import { classifyProviderError, httpProviderError, providerError, providerLabel } from "./errors.ts";
import {
  ProviderError,
  type GeneratedImage,
  type JobContext,
  type JobImages,
  type ModelIdsResult,
  type ModelTarget,
  type ProtocolAdapter,
  type ProviderTarget,
  type ReferenceImage,
  type SubmittedJob,
} from "./protocol.ts";
import { apimartGuide } from "./guides/apimart.ts";
import { multipartBody } from "./multipart.ts";
import { sendToProvider } from "./send.ts";

/**
 * APIMart (https://docs.apimart.ai/en): asynchronous. A Job is one or more tasks submitted to `/images/generations`,
 * each polled at `/tasks/{task_id}` until it completes. Result links expire after 24 hours, so the Job runner
 * downloads them as soon as a task completes. Every model has its own docs page and request fields; this Protocol sets
 * only the fields they share and passes the rest through from `provider_options`.
 */

const docsBase = "https://docs.apimart.ai/en/api-reference/images";

const errorSchema = z.object({
  error: z.object({
    code: z.union([z.number(), z.string()]).nullish(),
    message: z.string().optional(),
    type: z.string().nullish(),
  }),
});

const submittedSchema = z.object({
  data: z.array(z.object({ task_id: z.string() })).min(1),
});

const taskSchema = z.object({
  data: z.object({
    status: z.string(),
    cost: z.number().optional(),
    result: z
      .object({
        images: z.array(z.object({ url: z.union([z.array(z.string()), z.string()]) })).optional(),
      })
      .nullish(),
    error: errorSchema.shape.error.nullish(),
  }),
});

const resumeSchema = z.object({ taskIds: z.array(z.string()).min(1) });

interface KnownModel {
  matches: RegExp;
  docsPage: string;
  /** True when one task makes all `n` images; otherwise each image is its own task. */
  batches: boolean;
}

/**
 * The models whose docs page litevision knows, and whether one task makes all `n` images (their docs give `n` a
 * range, as their Parameter Guide entries say). Any other model gets one task per image, which always works.
 */
const knownModels: KnownModel[] = [
  { matches: /^gpt-image-2-official$/, docsPage: "gpt-image-2/official", batches: true },
  { matches: /^gpt-image-2(-ext)?$/, docsPage: "gpt-image-2/generation", batches: false },
  { matches: /^gpt-image-2\.5-(flare|sunburst)$/, docsPage: "gpt-image-2.5/generation", batches: true },
  { matches: /^gpt-image-2\.6-(flare|sunburst)$/, docsPage: "gpt-image-2.6/generation", batches: true },
  { matches: /^gpt-image-2\.5-ext$/, docsPage: "gpt-image-2.5-ext/generation", batches: true },
  { matches: /^gpt-image-2\.6-ext$/, docsPage: "gpt-image-2.6-ext/generation", batches: false },
  { matches: /^gpt-image-1(\.5)?(-official)?$/, docsPage: "gpt-image-1/generation", batches: true },
  { matches: /^gemini-nano-banana-2\.1$/, docsPage: "gemini-nano-banana-2.1/generation", batches: true },
  { matches: /^(gemini-3\.1-flash-lite-image(-ext)?|nano-banana-2-lite)$/, docsPage: "gemini-3.1-flash/generation-lite", batches: true },
  { matches: /^(gemini-3-pro-image-preview(-official)?|nano-banana-pro(-ext)?)$/, docsPage: "gemini-3-pro/generation", batches: false },
  // Seedream takes `n` up to 15, but text-to-image alone cannot make several in one task, so each image is its own.
  { matches: /^seedream-4[.-]5$/i, docsPage: "seedream-4.5/generation", batches: false },
];

const known = (modelId: string) => knownModels.find((model) => model.matches.test(modelId));

const headers = (credential: string) => ({ authorization: `Bearer ${credential}` });
const baseUrlOf = (target: ProviderTarget) => target.baseUrl.replace(/\/+$/, "");

/** `options` are the `provider_options` keys the request sent, so a rejection naming one is reported as a rejected option. */
async function errorOf(response: Response, providerId: string, options: readonly string[] = []): Promise<ProviderError> {
  const parsed = errorSchema.safeParse(await response.json().catch(() => undefined));
  const error = parsed.success ? parsed.data.error : undefined;
  return httpProviderError(providerId, {
    status: response.status,
    codes: [error?.type],
    message: error?.message ?? (response.statusText || undefined),
    options,
  });
}

const uploadedSchema = z.object({ url: z.string().min(1) });

/**
 * Uploads one reference image through APIMart's own `POST /uploads/images`, which answers with a public link: some
 * models take only links, and the User's images then reach no host but APIMart (ADR 0010).
 */
async function uploadReference(reference: ReferenceImage, target: ModelTarget, http: HttpTransport, context: JobContext): Promise<string> {
  const { body, contentType } = multipartBody([], [{ name: "file", ...reference }]);
  const init = { method: "POST", headers: { ...headers(target.credential), "content-type": contentType }, body };
  const failed = (error: Error) =>
    new ProviderError(error instanceof ProviderError ? error.kind : "other", `Could not upload the reference image ${reference.fileName} to APIMart. ${error.message}`);
  let response: Response;
  try {
    response = await sendToProvider(http, target.providerId, `${baseUrlOf(target)}/uploads/images`, init, { context });
  } catch (error) {
    throw error instanceof ProviderError ? failed(error) : error;
  }
  if (!response.ok) throw failed(await errorOf(response, target.providerId));
  const parsed = uploadedSchema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) throw failed(providerError("other", target.providerId, "its answer to the upload had no link."));
  return parsed.data.url;
}

async function submitTask(
  body: Record<string, unknown>,
  options: readonly string[],
  target: ModelTarget,
  http: HttpTransport,
  context: JobContext,
): Promise<string> {
  const init = {
    method: "POST",
    headers: { ...headers(target.credential), "content-type": "application/json" },
    body: JSON.stringify(body),
  };
  const response = await sendToProvider(http, target.providerId, `${baseUrlOf(target)}/images/generations`, init, { context });
  if (!response.ok) throw await errorOf(response, target.providerId, options);
  const parsed = submittedSchema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) throw providerError("other", target.providerId, "its answer to the submission had no task id.");
  return parsed.data.data[0]!.task_id;
}

/** Polls one task until it ends, and returns its images or its typed error. */
async function pollTask(taskId: string, target: ModelTarget, http: HttpTransport, context: JobContext): Promise<JobImages> {
  // `language=en` asks for the error message of a failed task in English.
  const url = `${baseUrlOf(target)}/tasks/${encodeURIComponent(taskId)}?language=en`;
  for (;;) {
    // A failed check is retried without submitting the task again.
    const response = await sendToProvider(http, target.providerId, url, { headers: headers(target.credential) }, { context, poll: true });
    if (!response.ok) throw await errorOf(response, target.providerId);
    const parsed = taskSchema.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) throw providerError("other", target.providerId, `its status for task ${taskId} could not be read.`);
    const task = parsed.data.data;
    if (task.status === "completed") {
      const images = (task.result?.images ?? [])
        .flatMap((image) => (Array.isArray(image.url) ? image.url : [image.url]))
        .map((url): GeneratedImage => ({ url }));
      if (images.length === 0) throw providerError("other", target.providerId, `task ${taskId} completed without images.`);
      return { images, ...(task.cost === undefined ? {} : { cost: task.cost }) };
    }
    if (task.status === "failed") {
      const error = task.error ?? undefined;
      const kind = classifyProviderError({
        status: typeof error?.code === "number" ? error.code : 0,
        codes: [error?.type],
        message: error?.message,
      });
      throw providerError(kind, target.providerId, error?.message ?? `task ${taskId} failed.`);
    }
    if (task.status === "cancelled") throw providerError("other", target.providerId, `task ${taskId} was cancelled.`);
    // "pending" or "processing".
    await context.pause();
  }
}

/** Waits for every task of a Job and keeps whatever images came back; only when none did does the Job fail. */
function waitForTasks(
  taskIds: string[],
  target: ModelTarget,
  http: HttpTransport,
  context: JobContext,
  submissionFailures: Error[] = [],
): SubmittedJob {
  return {
    resumeHandle: { taskIds },
    async wait() {
      const settled = await Promise.allSettled(taskIds.map((taskId) => pollTask(taskId, target, http, context)));
      const done = settled.flatMap((outcome) => (outcome.status === "fulfilled" ? [outcome.value] : []));
      const failures = [...submissionFailures, ...settled.flatMap((outcome) => (outcome.status === "rejected" ? [outcome.reason as Error] : []))];
      // Shutting down abandons the Job, whatever else happened to its tasks.
      const abandoned = settled.find((outcome) => outcome.status === "rejected" && !(outcome.reason instanceof ProviderError));
      if (abandoned !== undefined && abandoned.status === "rejected") throw abandoned.reason;

      const images = done.flatMap((result) => result.images);
      if (images.length === 0) throw failures[0] ?? providerError("other", target.providerId, "it returned no images.");
      const costs = done.flatMap((result) => (result.cost === undefined ? [] : [result.cost]));
      const total = taskIds.length + submissionFailures.length;
      return {
        images,
        ...(costs.length === 0 ? {} : { cost: costs.reduce((sum, cost) => sum + cost, 0) }),
        ...(failures.length === 0
          ? {}
          : { shortfall: `${failures.length} of ${total} tasks at ${providerLabel(target.providerId)} failed: ${failures[0]!.message}` }),
      };
    },
  };
}

const schemaResponse = z.object({ parameters: z.object({ input_schema: z.unknown() }).optional() });

const modelListSchema = z.object({
  data: z.array(z.object({ id: z.string(), category: z.string().optional() })),
});

/** `GET {baseUrl}/models` with categories, keeping only image models. */
async function fetchModelIds(target: ProviderTarget, http: HttpTransport): Promise<ModelIdsResult> {
  const label = providerLabel(target.providerId);
  let response: Response;
  try {
    response = await http(`${baseUrlOf(target)}/models?expand=category&category=image`, { headers: headers(target.credential) });
  } catch (error) {
    return { ok: false, message: `Could not reach ${label}: ${(error as Error).message}` };
  }
  if (!response.ok) {
    const parsed = errorSchema.safeParse(await response.json().catch(() => undefined));
    const detail = parsed.success ? parsed.data.error.message : response.statusText;
    return { ok: false, message: `${label} returned HTTP ${response.status}: ${detail}` };
  }
  const parsed = modelListSchema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) return { ok: false, message: `${label} answered, but not with an APIMart model list. Check the base URL.` };
  const ids = parsed.data.data.filter((model) => model.category === "image").map((model) => model.id);
  return { ok: true, modelIds: ids.sort() };
}

export const apimart: ProtocolAdapter = {
  async fetchModelInfo(target, http) {
    const response = await http(`${baseUrlOf(target)}/models/${encodeURIComponent(target.modelId)}/schema`, {
      headers: headers(target.credential),
    });
    if (response.status === 404) return undefined;
    if (!response.ok) throw await errorOf(response, target.providerId);
    const body: unknown = await response.json();
    // The single-model answer has the same shape as one item of the model list; tolerate it wrapped in `data`.
    const item = schemaResponse.safeParse((body as { data?: unknown } | null)?.data ?? body);
    const parameterSchema = item.success ? item.data.parameters?.input_schema : undefined;
    return parameterSchema === undefined ? undefined : { parameterSchema };
  },

  docsUrl: (modelId) => {
    const model = known(modelId);
    return model === undefined ? "https://docs.apimart.ai/en" : `${docsBase}/${model.docsPage}`;
  },

  parameterGuide: (modelId, modality) => (modality === "image" ? apimartGuide(modelId) : undefined),

  requestFields: { image: { shape: ["size"], resolution: "resolution" } },

  reservedOptions: ["model", "prompt", "image_urls"],

  async submit(request, target, http, context) {
    const batches = known(target.modelId)?.batches ?? false;
    // Every upload finishes before any generation request, so a failed one costs nothing.
    const imageUrls = await Promise.all(request.references.map((reference) => uploadReference(reference, target, http, context)));
    const body = {
      model: target.modelId,
      prompt: request.prompt,
      n: batches ? request.n : 1,
      ...(imageUrls.length === 0 ? {} : { image_urls: imageUrls }),
      ...request.providerOptions,
    };
    const settled = await Promise.allSettled(Array.from({ length: batches ? 1 : request.n }, () => submitTask(body, Object.keys(request.providerOptions), target, http, context)));
    const taskIds = settled.flatMap((outcome) => (outcome.status === "fulfilled" ? [outcome.value] : []));
    const failures = settled.flatMap((outcome) => (outcome.status === "rejected" ? [outcome.reason as Error] : []));
    if (taskIds.length === 0) throw failures[0]!;
    return waitForTasks(taskIds, target, http, context, failures);
  },

  resume(handle, target, http, context) {
    const parsed = resumeSchema.safeParse(handle);
    if (!parsed.success) throw providerError("other", target.providerId, "the Job history holds no task ids to pick the Job up from.");
    return waitForTasks(parsed.data.taskIds, target, http, context);
  },

  async testConnection(target, http) {
    const list = await fetchModelIds(target, http);
    if (!list.ok) return list;
    return { ok: true, message: `Connected to Provider "${target.providerId}". It offers ${list.modelIds.length} image model id(s).` };
  },

  listModelIds: fetchModelIds,
};
