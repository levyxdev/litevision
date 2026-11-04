import { z } from "zod";
import type { HttpTransport } from "../http.ts";
import { classifyProviderError, httpProviderError, providerError, providerLabel, sendToProvider } from "./errors.ts";
import {
  ProviderError,
  type AspectRatio,
  type GeneratedImage,
  type ImageCapabilities,
  type ImageSize,
  type JobContext,
  type JobVideo,
  type Modality,
  type ModelIdsResult,
  type ModelTarget,
  type ProtocolAdapter,
  type ProviderTarget,
  type ReferenceImage,
  type SubmittedVideoJob,
  type VideoCapabilities,
} from "./protocol.ts";

/**
 * Together AI (https://docs.together.ai): images are synchronous at `/v1/images/generations`, videos are asynchronous
 * jobs at `/v2/videos`, polled until they complete; both are this one Protocol (ADR 0005). The base URL is the API's
 * root, `https://api.together.ai`; a base URL that ends in `/v1` or `/v2` works too. Together serves some models
 * itself and passes others through to their makers, which an organization must allow first.
 */

const docs = {
  flux: "https://docs.together.ai/docs/quickstart-flux",
  imageParameters: "https://docs.together.ai/docs/inference/images/parameters",
  referenceImages: "https://docs.together.ai/docs/inference/images/reference-images",
  wan: "https://docs.together.ai/docs/wan2.7-quickstart",
  seedance: "https://docs.together.ai/docs/seedance2.5-quickstart",
  videoParameters: "https://docs.together.ai/docs/inference/videos/parameters",
};

const sizes = (entries: Array<[AspectRatio, number, number]>): ImageSize[] =>
  entries.map(([aspectRatio, width, height]) => ({ aspectRatio, width, height }));

/** About a megapixel at each ratio, in multiples of 64 as diffusion models prefer; Together asks for multiples of 8. */
const megapixelSizes = sizes([
  ["1:1", 1024, 1024],
  ["16:9", 1344, 768],
  ["9:16", 768, 1344],
  ["4:3", 1152, 896],
  ["3:4", 896, 1152],
  ["3:2", 1216, 832],
  ["2:3", 832, 1216],
]);

/**
 * At most 1024 a side, multiples of 8: the most an image model whose limits litevision does not know is safe to be
 * asked for. Stable Diffusion XL, for one, rejects a side above 1024.
 */
const cappedSizes = sizes([
  ["1:1", 1024, 1024],
  ["16:9", 1024, 576],
  ["9:16", 576, 1024],
  ["4:3", 1024, 768],
  ["3:4", 768, 1024],
  ["3:2", 1024, 680],
  ["2:3", 680, 1024],
]);

/** Together answers with at most four images per request. */
const maxImagesPerJob = 4;

interface ImageFamily {
  matches: RegExp;
  capabilities: ImageCapabilities;
  /** `pixels` sends `width` and `height`; `ratio` sends `aspect_ratio` (FLUX.1 Kontext). */
  sizing: "pixels" | "ratio";
  /** How reference images are sent: an array, or Kontext's single `image_url`. */
  references: "reference_images" | "image_url";
  docsUrl: string;
}

const imageFamilies: ImageFamily[] = [
  {
    matches: /^black-forest-labs\/FLUX\.1-kontext-/i,
    capabilities: { sizes: megapixelSizes, maxReferences: 1, maxImages: maxImagesPerJob },
    sizing: "ratio",
    references: "image_url",
    docsUrl: docs.flux,
  },
  {
    // Together documents `reference_images` for FLUX.2 [pro], [flex] and [dev], not [max].
    matches: /^black-forest-labs\/FLUX\.2-(pro|flex|dev)$/i,
    capabilities: { sizes: megapixelSizes, maxReferences: 4, maxImages: maxImagesPerJob },
    sizing: "pixels",
    references: "reference_images",
    docsUrl: docs.flux,
  },
  {
    matches: /^black-forest-labs\//i,
    capabilities: { sizes: megapixelSizes, maxReferences: 0, maxImages: maxImagesPerJob },
    sizing: "pixels",
    references: "reference_images",
    docsUrl: docs.flux,
  },
  {
    // Google's fixed 1K sizes.
    matches: /^google\/gemini-3-pro-image$/i,
    capabilities: {
      sizes: sizes([
        ["1:1", 1024, 1024],
        ["16:9", 1376, 768],
        ["9:16", 768, 1376],
        ["4:3", 1200, 896],
        ["3:4", 896, 1200],
        ["3:2", 1264, 848],
        ["2:3", 848, 1264],
      ]),
      maxReferences: 14,
      maxImages: maxImagesPerJob,
    },
    sizing: "pixels",
    references: "reference_images",
    docsUrl: docs.referenceImages,
  },
  {
    matches: /^google\/flash-image-2\.5$/i,
    capabilities: {
      sizes: sizes([
        ["1:1", 1024, 1024],
        ["16:9", 1344, 768],
        ["9:16", 768, 1344],
        ["4:3", 1184, 864],
        ["3:4", 864, 1184],
        ["3:2", 1248, 832],
        ["2:3", 832, 1248],
      ]),
      maxReferences: 3,
      maxImages: maxImagesPerJob,
    },
    sizing: "pixels",
    references: "reference_images",
    docsUrl: docs.referenceImages,
  },
];

/** Every other image model: sized in pixels within 1024 a side, no reference images until Together documents them for it. */
const otherImages: ImageFamily = {
  matches: /.*/,
  capabilities: { sizes: cappedSizes, maxReferences: 0, maxImages: maxImagesPerJob },
  sizing: "pixels",
  references: "reference_images",
  docsUrl: docs.imageParameters,
};

const imageFamily = (modelId: string) => imageFamilies.find((family) => family.matches.test(modelId)) ?? otherImages;

interface VideoFamily {
  matches: RegExp;
  capabilities: VideoCapabilities;
  /** `tier+ratio` sends `resolution` and `ratio` (Wan 2.7); `tier` sends `resolution` alone (Seedance 2.5); `pixels` sends `width` and `height`. */
  sizing: "tier+ratio" | "tier" | "pixels";
  docsUrl: string;
}

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => from + index);

const wanResolutions = [
  {
    name: "1080P",
    sizes: sizes([
      ["16:9", 1920, 1080],
      ["9:16", 1080, 1920],
      ["1:1", 1440, 1440],
      ["4:3", 1632, 1248],
      ["3:4", 1248, 1632],
    ]),
  },
  {
    name: "720P",
    sizes: sizes([
      ["16:9", 1280, 720],
      ["9:16", 720, 1280],
      ["1:1", 960, 960],
      ["4:3", 1088, 832],
      ["3:4", 832, 1088],
    ]),
  },
];

const wan = (capabilities: Pick<VideoCapabilities, "durations" | "firstFrame" | "lastFrame" | "maxReferences">): VideoCapabilities => ({
  resolutions: wanResolutions,
  defaultDuration: 5,
  ...capabilities,
});

const videoFamilies: VideoFamily[] = [
  {
    matches: /^Wan-AI\/wan2\.7-t2v$/i,
    capabilities: wan({ durations: range(2, 15), firstFrame: false, lastFrame: false, maxReferences: 0 }),
    sizing: "tier+ratio",
    docsUrl: docs.wan,
  },
  {
    matches: /^Wan-AI\/wan2\.7-i2v$/i,
    capabilities: wan({ durations: range(2, 15), firstFrame: true, lastFrame: true, maxReferences: 0 }),
    sizing: "tier+ratio",
    docsUrl: docs.wan,
  },
  {
    matches: /^Wan-AI\/wan2\.7-r2v$/i,
    capabilities: wan({ durations: range(2, 10), firstFrame: false, lastFrame: false, maxReferences: 5 }),
    sizing: "tier+ratio",
    docsUrl: docs.wan,
  },
  {
    // No `ratio`, `width` or `height`, and capped at 720p.
    matches: /^ByteDance\/Seedance-2\.5$/i,
    capabilities: {
      resolutions: [
        { name: "720p", sizes: sizes([["16:9", 1280, 720]]) },
        { name: "480p", sizes: sizes([["16:9", 854, 480]]) },
      ],
      durations: range(4, 30),
      defaultDuration: 5,
      firstFrame: true,
      lastFrame: true,
      maxReferences: 30,
    },
    sizing: "tier",
    docsUrl: docs.seedance,
  },
];

/**
 * Every other video model: Together's generic fields, at 720p. Its own error says what a model does not take, and
 * `provider_options` may override `width` and `height` (ADR 0004's pass-through).
 */
const otherVideos: VideoFamily = {
  matches: /.*/,
  capabilities: {
    resolutions: [
      {
        sizes: sizes([
          ["16:9", 1280, 720],
          ["9:16", 720, 1280],
          ["1:1", 960, 960],
          ["4:3", 1088, 816],
          ["3:4", 816, 1088],
          ["3:2", 1152, 768],
          ["2:3", 768, 1152],
        ]),
      },
    ],
    durations: range(1, 10),
    defaultDuration: 5,
    firstFrame: true,
    lastFrame: true,
    maxReferences: 4,
  },
  sizing: "pixels",
  docsUrl: docs.videoParameters,
};

const videoFamily = (modelId: string) => videoFamilies.find((family) => family.matches.test(modelId)) ?? otherVideos;

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

/** Together answers errors as JSON on images and as plain text on some video routes; both are read. */
async function errorOf(response: Response, providerId: string): Promise<ProviderError> {
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
  // Together names the field it rejected, so a field named e.g. `safety_tolerance` is a request problem, not a refusal.
  if (error?.param && response.status === 400 && error.message !== undefined) {
    return providerError("unsupported", providerId, `HTTP 400: ${error.message}`);
  }
  return httpProviderError(providerId, {
    status: response.status,
    codes: [error?.code, error?.type],
    message: error?.message ?? (plain || response.statusText || undefined),
  });
}

async function postJson(url: string, body: Record<string, unknown>, target: ModelTarget, http: HttpTransport): Promise<unknown> {
  const response = await sendToProvider(http, target.providerId, url, {
    method: "POST",
    headers: { ...authorization(target.credential), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await errorOf(response, target.providerId);
  return response.json().catch(() => undefined);
}

/** How many failed status checks in a row are put down to a passing outage before the Job is given up. */
const toleratedPollFailures = 5;

/** Polls one of Together's videos until it is made or has failed. */
function waitForVideo(videoId: string, target: ModelTarget, http: HttpTransport, context: JobContext): SubmittedVideoJob {
  const url = `${rootOf(target)}/v2/videos/${encodeURIComponent(videoId)}`;
  return {
    resumeHandle: { videoId },
    async wait(): Promise<JobVideo> {
      let failures = 0;
      for (;;) {
        let response: Response | undefined;
        try {
          response = await sendToProvider(http, target.providerId, url, { headers: authorization(target.credential) });
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
        }
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
  builtInCapabilities: (modelId) => imageFamily(modelId).capabilities,

  builtInVideoCapabilities: (modelId) => videoFamily(modelId).capabilities,

  // Together's model list gives each model's type and price, but not its sizes or limits, so there is no `fetchModelInfo`.

  docsUrl: (modelId, modality = "image") => (modality === "video" ? videoFamily(modelId) : imageFamily(modelId)).docsUrl,

  reservedOptions: ["model", "prompt", "n", "width", "height", "aspect_ratio", "response_format", "reference_images", "image_url"],

  // `width` and `height` stay open, for video models litevision has no table for.
  reservedVideoOptions: ["model", "prompt", "seconds", "resolution", "ratio", "media"],

  async submit(request, target, http) {
    const family = imageFamily(target.modelId);
    const { size, references } = request;
    const body = {
      model: target.modelId,
      prompt: request.prompt,
      n: request.n,
      ...(family.sizing === "ratio" ? { aspect_ratio: size.aspectRatio } : { width: size.width, height: size.height }),
      // Together answers with links by default; base64 needs no second request and no User-Agent for the download.
      response_format: "base64",
      ...(references.length === 0
        ? {}
        : family.references === "image_url"
          ? { image_url: dataUrl(references[0]!) }
          : { reference_images: references.map(dataUrl) }),
      ...request.providerOptions,
    };
    const parsed = imagesSchema.safeParse(await postJson(`${rootOf(target)}/v1/images/generations`, body, target, http));
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
    const family = videoFamily(target.modelId);
    const { size } = request;
    const frames = [
      ...(request.firstFrame === undefined ? [] : [{ input_image: dataUrl(request.firstFrame), frame: "first" }]),
      ...(request.lastFrame === undefined ? [] : [{ input_image: dataUrl(request.lastFrame), frame: "last" }]),
    ];
    const media = {
      ...(frames.length === 0 ? {} : { frame_images: frames }),
      ...(request.references.length === 0 ? {} : { reference_images: request.references.map(dataUrl) }),
    };
    const sizing =
      family.sizing === "pixels"
        ? { width: size.width, height: size.height }
        : { resolution: request.resolution, ...(family.sizing === "tier+ratio" ? { ratio: size.aspectRatio } : {}) };
    const body = {
      model: target.modelId,
      prompt: request.prompt,
      seconds: String(request.seconds),
      ...sizing,
      ...(Object.keys(media).length === 0 ? {} : { media }),
      ...request.providerOptions,
    };
    const parsed = videoSchema.safeParse(await postJson(`${rootOf(target)}/v2/videos`, body, target, http));
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
