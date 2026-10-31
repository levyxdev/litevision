import { z } from "zod";
import type { HttpTransport } from "../http.ts";
import { classifyProviderError, httpProviderError, providerError, providerLabel, sendToProvider } from "./errors.ts";
import {
  aspectRatios,
  ProviderError,
  type AspectRatio,
  type GeneratedImage,
  type ImageCapabilities,
  type ImageSize,
  type JobContext,
  type JobImages,
  type ModelIdsResult,
  type ModelTarget,
  type ProtocolAdapter,
  type ProviderTarget,
  type SubmittedJob,
} from "./protocol.ts";

/**
 * APIMart (https://docs.apimart.ai/en): asynchronous. A Job is one or more tasks submitted to `/images/generations`,
 * each polled at `/tasks/{task_id}` until it completes. Result links expire after 24 hours, so the Job runner
 * downloads them as soon as a task completes. Every model has its own docs page and request fields; this Protocol sets
 * only the fields they share and passes the rest through from `provider_options`.
 */

const docsBase = "https://docs.apimart.ai/en/api-reference/images";

/** One task per image always works; only some models make several images in one task. */
const maxImagesPerJob = 4;

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

const sizes = (entries: Array<[AspectRatio, number, number]>): ImageSize[] =>
  entries.map(([aspectRatio, width, height]) => ({ aspectRatio, width, height }));

interface KnownModel {
  matches: RegExp;
  docsPage: string;
  capabilities: ImageCapabilities;
  /** True when one task makes all `n` images; otherwise each image is its own task. */
  batches: boolean;
}

/** The models litevision knows without asking APIMart, with sizes at each model's default resolution. */
const knownModels: KnownModel[] = [
  {
    matches: /^gpt-image-2(-ext|-official)?$/,
    docsPage: "gpt-image-2/generation",
    capabilities: {
      sizes: sizes([
        ["1:1", 1024, 1024],
        ["3:2", 1536, 1024],
        ["2:3", 1024, 1536],
        ["4:3", 1024, 768],
        ["3:4", 768, 1024],
        ["16:9", 1536, 864],
        ["9:16", 864, 1536],
      ]),
      maxReferences: 15,
      maxImages: maxImagesPerJob,
    },
    batches: false,
  },
  {
    matches: /^gpt-image-1(\.5)?(-official)?$/,
    docsPage: "gpt-image-1/generation",
    capabilities: {
      sizes: sizes([
        ["1:1", 1024, 1024],
        ["3:2", 1536, 1024],
        ["2:3", 1024, 1536],
      ]),
      // Its docs page asks for public image links; litevision sends data URIs, so it claims none until that is confirmed.
      maxReferences: 0,
      maxImages: maxImagesPerJob,
    },
    batches: true,
  },
  {
    matches: /^(gemini-3-pro-image-preview(-official)?|nano-banana-pro(-ext)?)$/,
    docsPage: "gemini-3-pro/generation",
    capabilities: {
      sizes: sizes([
        ["1:1", 1024, 1024],
        ["3:2", 1264, 848],
        ["2:3", 848, 1264],
        ["4:3", 1200, 896],
        ["3:4", 896, 1200],
        ["16:9", 1376, 768],
        ["9:16", 768, 1376],
      ]),
      maxReferences: 14,
      maxImages: maxImagesPerJob,
    },
    batches: false,
  },
  {
    matches: /^seedream-4[.-]5$/i,
    docsPage: "seedream-4.5/generation",
    capabilities: {
      sizes: sizes([
        ["1:1", 2048, 2048],
        ["3:2", 2496, 1664],
        ["2:3", 1664, 2496],
        ["4:3", 2304, 1728],
        ["3:4", 1728, 2304],
        ["16:9", 2560, 1440],
        ["9:16", 1440, 2560],
      ]),
      // References and images together may not exceed 15, and each task makes one image.
      maxReferences: 14,
      maxImages: maxImagesPerJob,
    },
    batches: false,
  },
];

/** For a model litevision does not know: square only and no references, until APIMart's schema says otherwise. */
const unknownModel: ImageCapabilities = {
  sizes: sizes([["1:1", 1024, 1024]]),
  maxReferences: 0,
  maxImages: maxImagesPerJob,
};

const known = (modelId: string) => knownModels.find((model) => model.matches.test(modelId));

const headers = (credential: string) => ({ authorization: `Bearer ${credential}` });
const baseUrlOf = (target: ProviderTarget) => target.baseUrl.replace(/\/+$/, "");

async function errorOf(response: Response, providerId: string): Promise<ProviderError> {
  const parsed = errorSchema.safeParse(await response.json().catch(() => undefined));
  const error = parsed.success ? parsed.data.error : undefined;
  return httpProviderError(providerId, {
    status: response.status,
    codes: [error?.type],
    message: error?.message ?? (response.statusText || undefined),
  });
}

async function submitTask(body: Record<string, unknown>, target: ModelTarget, http: HttpTransport): Promise<string> {
  const response = await sendToProvider(http, target.providerId, `${baseUrlOf(target)}/images/generations`, {
    method: "POST",
    headers: { ...headers(target.credential), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await errorOf(response, target.providerId);
  const parsed = submittedSchema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) throw providerError("other", target.providerId, "its answer to the submission had no task id.");
  return parsed.data.data[0]!.task_id;
}

/** How many failed status checks in a row are put down to a passing outage before the task is given up. */
const toleratedPollFailures = 5;

/** Polls one task until it ends, and returns its images or its typed error. */
async function pollTask(taskId: string, target: ModelTarget, http: HttpTransport, context: JobContext): Promise<JobImages> {
  // `language=en` asks for the error message of a failed task in English.
  const url = `${baseUrlOf(target)}/tasks/${encodeURIComponent(taskId)}?language=en`;
  let failures = 0;
  for (;;) {
    let response: Response | undefined;
    try {
      response = await sendToProvider(http, target.providerId, url, { headers: headers(target.credential) });
    } catch (error) {
      if (++failures > toleratedPollFailures) throw error;
    }
    if (response !== undefined && !response.ok) {
      const transient = response.status >= 500 || response.status === 429;
      if (!transient || ++failures > toleratedPollFailures) throw await errorOf(response, target.providerId);
      response = undefined;
    }
    if (response !== undefined) {
      failures = 0;
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
    }
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

/** Reads the capabilities APIMart's JSON Schema for a model implies, filling sizes from the built-in table where it can. */
function capabilitiesFromSchema(schema: unknown, modelId: string): ImageCapabilities | undefined {
  const properties = z
    .object({
      properties: z.object({
        size: z.object({ enum: z.array(z.unknown()) }).optional(),
        image_urls: z.object({ maxItems: z.number().int().nonnegative().optional() }).optional(),
      }),
    })
    .safeParse(schema);
  if (!properties.success) return undefined;
  const { size, image_urls } = properties.data.properties;
  const ratios = aspectRatios.filter((ratio) => size?.enum.includes(ratio));
  if (ratios.length === 0) return undefined;
  const builtIn = known(modelId)?.capabilities ?? unknownModel;
  return {
    sizes: ratios.map((ratio) => builtIn.sizes.find((candidate) => candidate.aspectRatio === ratio) ?? nominalSize(ratio)),
    maxReferences: image_urls === undefined ? 0 : (image_urls.maxItems ?? Math.max(builtIn.maxReferences, 1)),
    maxImages: maxImagesPerJob,
  };
}

/** About a megapixel at the given ratio, for a model whose sizes APIMart lists only as ratios. */
function nominalSize(aspectRatio: AspectRatio): ImageSize {
  const [width, height] = aspectRatio.split(":").map(Number) as [number, number];
  const scale = Math.sqrt((1024 * 1024) / (width * height));
  const round = (value: number) => Math.round((value * scale) / 16) * 16;
  return { aspectRatio, width: round(width), height: round(height) };
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
  builtInCapabilities: (modelId) => known(modelId)?.capabilities ?? unknownModel,

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
    if (parameterSchema === undefined) return undefined;
    const capabilities = capabilitiesFromSchema(parameterSchema, target.modelId);
    return { parameterSchema, ...(capabilities === undefined ? {} : { capabilities }) };
  },

  docsUrl: (modelId) => {
    const model = known(modelId);
    return model === undefined ? "https://docs.apimart.ai/en" : `${docsBase}/${model.docsPage}`;
  },

  reservedOptions: ["model", "prompt", "size", "n", "image_urls"],

  async submit(request, target, http, context) {
    const batches = known(target.modelId)?.batches ?? false;
    const body = {
      model: target.modelId,
      prompt: request.prompt,
      size: request.size.aspectRatio,
      n: batches ? request.n : 1,
      ...(request.references.length === 0
        ? {}
        : { image_urls: request.references.map((reference) => `data:${reference.mimeType};base64,${Buffer.from(reference.bytes).toString("base64")}`) }),
      ...request.providerOptions,
    };
    const settled = await Promise.allSettled(Array.from({ length: batches ? 1 : request.n }, () => submitTask(body, target, http)));
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
