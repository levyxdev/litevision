import { z } from "zod";
import type { HttpTransport } from "../http.ts";
import { classifyProviderError, httpProviderError, providerError, providerLabel } from "./errors.ts";
import {
  ProviderError,
  type GeneratedImage,
  type JobContext,
  type JobVideo,
  type Modality,
  type ModelIdsResult,
  type ModelTarget,
  type ProtocolAdapter,
  type ProviderTarget,
  type ReferenceImage,
  type SubmittedVideoJob,
} from "./protocol.ts";
import { togetherGuide } from "./guides/together.ts";
import { sendToProvider } from "./send.ts";

/**
 * Together AI (https://docs.together.ai): images are synchronous at `/v1/images/generations`, videos are asynchronous
 * jobs at `/v2/videos`, polled until they complete; both are this one Protocol (ADR 0005). The base URL is the API's
 * root, `https://api.together.ai`; a base URL that ends in `/v1` or `/v2` works too. Together serves some models
 * itself and passes others through to their makers, which an organization must allow first.
 */

/** Together's generic parameter pages: the docs link of a model with no Parameter Guide. */
const genericDocs = {
  image: "https://docs.together.ai/docs/inference/images/parameters",
  video: "https://docs.together.ai/docs/inference/videos/parameters",
};

/**
 * FLUX.1 Kontext takes its one reference image in `image_url`; every other image model takes `reference_images`. This
 * is the only wire format that differs by model, so it is the only model-id rule here: the rest is the Parameter Guide.
 */
const singleImageUrl = /^black-forest-labs\/FLUX\.1-kontext-/i;

const errorSchema = z.object({
  error: z.object({
    message: z.string().optional(),
    code: z.string().nullish(),
    type: z.string().nullish(),
    /** The request field Together rejected, e.g. `width`. */
    param: z.string().nullish(),
  }),
});

const imagesSchema = z.object({
  data: z.array(z.object({ b64_json: z.string().nullish(), url: z.string().nullish() })),
});

const videoSchema = z.object({
  id: z.string(),
  status: z.string(),
  outputs: z.object({ video_url: z.string().optional(), cost: z.number().optional() }).nullish(),
  error: z.object({ message: z.string().optional(), code: z.string().nullish() }).nullish(),
});

const resumeSchema = z.object({ videoId: z.string().min(1) });

const modelListSchema = z.array(z.object({ id: z.string(), type: z.string().optional() }));

/** The API's root, whether the User gave it with or without a version. */
const rootOf = (target: ProviderTarget) => target.baseUrl.replace(/\/+$/, "").replace(/\/v[12]$/, "");

const authorization = (credential: string) => ({ authorization: `Bearer ${credential}` });

const dataUrl = (image: ReferenceImage) => `data:${image.mimeType};base64,${Buffer.from(image.bytes).toString("base64")}`;

/** Together's code for a model its makers run, which the organization has not allowed yet. */
const passthroughBlocked = "third_party_data_sharing_blocked";

/**
 * The fix is the User's choice, because allowing it sends their prompts to the model's maker. The link in Together's
 * own message leads nowhere, so this names where the switch is.
 */
function passthroughError(providerId: string): ProviderError {
  return new ProviderError(
    "unsupported",
    `${providerLabel(providerId)} runs this model through its maker, which the User's Together organization does not allow yet. ` +
      'Only the User can change that: in Together\'s dashboard (https://api.together.ai/settings), Organization → General → Privacy → "Passthrough models", which sends prompts for such models to their makers. ' +
      "Tell the User, or choose a model Together serves itself.",
  );
}

/**
 * Together answers errors as JSON on images and as plain text on some video routes; both are read. `options` are the
 * `provider_options` keys the request sent, so a rejection naming one is reported as a rejected option.
 */
async function errorOf(response: Response, providerId: string, options: readonly string[] = []): Promise<ProviderError> {
  const text = await response.text().catch(() => "");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  const parsed = errorSchema.safeParse(body);
  const error = parsed.success ? parsed.data.error : undefined;
  if (error?.code === passthroughBlocked) return passthroughError(providerId);
  const plain = body === undefined ? text.trim().slice(0, 300) : "";
  return httpProviderError(providerId, {
    status: response.status,
    codes: [error?.code, error?.type],
    message: error?.message ?? (plain || response.statusText || undefined),
    param: error?.param,
    options,
  });
}

async function postJson(
  url: string,
  body: Record<string, unknown>,
  providerOptions: Record<string, unknown>,
  target: ModelTarget,
  http: HttpTransport,
  context: JobContext,
): Promise<unknown> {
  const init = {
    method: "POST",
    headers: { ...authorization(target.credential), "content-type": "application/json" },
    body: JSON.stringify(body),
  };
  const response = await sendToProvider(http, target.providerId, url, init, { context });
  if (!response.ok) throw await errorOf(response, target.providerId, Object.keys(providerOptions));
  return response.json().catch(() => undefined);
}

/** Polls one of Together's videos until it is made or has failed. */
function waitForVideo(videoId: string, target: ModelTarget, http: HttpTransport, context: JobContext): SubmittedVideoJob {
  const url = `${rootOf(target)}/v2/videos/${encodeURIComponent(videoId)}`;
  return {
    resumeHandle: { videoId },
    async wait(): Promise<JobVideo> {
      for (;;) {
        // A failed check is retried without submitting the video again.
        const response = await sendToProvider(http, target.providerId, url, { headers: authorization(target.credential) }, { context, poll: true });
        if (!response.ok) throw await errorOf(response, target.providerId);
        const parsed = videoSchema.safeParse(await response.json().catch(() => undefined));
        if (!parsed.success) throw providerError("other", target.providerId, `its status for video ${videoId} could not be read.`);
        const job = parsed.data;
        if (job.status === "completed") {
          const link = job.outputs?.video_url;
          if (link === undefined) throw providerError("other", target.providerId, `video ${videoId} completed without a link to it.`);
          return { video: { url: link }, ...(job.outputs?.cost === undefined ? {} : { cost: job.outputs.cost }) };
        }
        if (job.status === "failed") throw videoFailure(job.error ?? undefined, target.providerId, videoId);
        if (job.status === "cancelled") throw providerError("other", target.providerId, `video ${videoId} was cancelled.`);
        // "queued" or "in_progress".
        await context.pause();
      }
    },
  };
}

/** Why Together could not make a video, e.g. `{ code: "invalidDuration" }`: Together's camel-case codes for a request it cannot do. */
function videoFailure(error: { message?: string; code?: string | null } | undefined, providerId: string, videoId: string): ProviderError {
  if (error?.code === passthroughBlocked) return passthroughError(providerId);
  const rejected = /^(unsupported|invalid)/i.test(error?.code ?? "");
  const kind = rejected ? "unsupported" : classifyProviderError({ status: 0, codes: [error?.code], message: error?.message });
  const detail = [error?.code, error?.message].filter(Boolean).join(": ");
  return providerError(kind, providerId, detail || `video ${videoId} failed.`);
}

/** `GET /v1/models`, keeping the image and video models. */
async function fetchModelIds(target: ProviderTarget, http: HttpTransport): Promise<ModelIdsResult> {
  const label = providerLabel(target.providerId);
  let response: Response;
  try {
    response = await http(`${rootOf(target)}/v1/models`, { headers: authorization(target.credential) });
  } catch (error) {
    return { ok: false, message: `Could not reach ${label}: ${(error as Error).message}` };
  }
  if (!response.ok) return { ok: false, message: (await errorOf(response, target.providerId)).message };
  const parsed = modelListSchema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) return { ok: false, message: `${label} answered, but not with a Together model list. Check the base URL.` };
  const modalities: Record<string, Modality> = {};
  for (const model of parsed.data) {
    if (model.type === "image" || model.type === "video") modalities[model.id] = model.type;
  }
  return { ok: true, modelIds: Object.keys(modalities).sort(), modalities };
}

export const together: ProtocolAdapter = {
  // Together's model list gives each model's type and price, but not its parameters, so there is no `fetchModelInfo`.

  parameterGuide: (modelId, modality) => togetherGuide(modelId, modality),

  docsUrl: (modelId, modality = "image") => togetherGuide(modelId, modality)?.sources[0] ?? genericDocs[modality],

  requestFields: {
    image: { shape: [{ width: "width", height: "height" }, "aspect_ratio"], format: "output_format" },
    video: { shape: [{ width: "width", height: "height" }, "ratio"], duration: "seconds", resolution: "resolution" },
  },

  reservedOptions: ["model", "prompt", "response_format", "reference_images", "image_url"],

  reservedVideoOptions: ["model", "prompt", "media"],

  async submit(request, target, http, context) {
    const { references } = request;
    const body = {
      model: target.modelId,
      prompt: request.prompt,
      n: request.n,
      // Together answers with links by default; base64 needs no second request and no User-Agent for the download.
      response_format: "base64",
      ...(references.length === 0
        ? {}
        : singleImageUrl.test(target.modelId)
          ? { image_url: dataUrl(references[0]!) }
          : { reference_images: references.map(dataUrl) }),
      ...request.providerOptions,
    };
    const parsed = imagesSchema.safeParse(await postJson(`${rootOf(target)}/v1/images/generations`, body, request.providerOptions, target, http, context));
    if (!parsed.success) throw providerError("other", target.providerId, "its response could not be read as Together images.");
    const images = parsed.data.data.map((item): GeneratedImage => {
      if (item.b64_json) return { bytes: Buffer.from(item.b64_json, "base64") };
      if (item.url) return { url: item.url };
      throw providerError("other", target.providerId, "it returned an image with neither data nor a link.");
    });
    if (images.length === 0) throw providerError("other", target.providerId, "it returned no images.");
    const shortfall =
      images.length < request.n
        ? `${providerLabel(target.providerId)} returned ${images.length} of ${request.n} images without saying why.`
        : undefined;
    return { wait: async () => ({ images, ...(shortfall === undefined ? {} : { shortfall }) }) };
  },

  async submitVideo(request, target, http, context) {
    const frames = [
      ...(request.firstFrame === undefined ? [] : [{ input_image: dataUrl(request.firstFrame), frame: "first" }]),
      ...(request.lastFrame === undefined ? [] : [{ input_image: dataUrl(request.lastFrame), frame: "last" }]),
    ];
    const media = {
      ...(frames.length === 0 ? {} : { frame_images: frames }),
      ...(request.references.length === 0 ? {} : { reference_images: request.references.map(dataUrl) }),
    };
    const body = {
      model: target.modelId,
      prompt: request.prompt,
      ...(Object.keys(media).length === 0 ? {} : { media }),
      ...request.providerOptions,
    };
    const parsed = videoSchema.safeParse(await postJson(`${rootOf(target)}/v2/videos`, body, request.providerOptions, target, http, context));
    if (!parsed.success) throw providerError("other", target.providerId, "its answer to the submission had no video id.");
    if (parsed.data.status === "failed") throw videoFailure(parsed.data.error ?? undefined, target.providerId, parsed.data.id);
    return waitForVideo(parsed.data.id, target, http, context);
  },

  resumeVideo(handle, target, http, context) {
    const parsed = resumeSchema.safeParse(handle);
    if (!parsed.success) throw providerError("other", target.providerId, "the Job history holds no video id to pick the Job up from.");
    return waitForVideo(parsed.data.videoId, target, http, context);
  },

  async testConnection(target, http) {
    const list = await fetchModelIds(target, http);
    if (!list.ok) return list;
    const count = (modality: Modality) => Object.values(list.modalities ?? {}).filter((value) => value === modality).length;
    return {
      ok: true,
      message: `Connected to Provider "${target.providerId}". It offers ${count("image")} image and ${count("video")} video model id(s).`,
    };
  },

  listModelIds: fetchModelIds,
};
