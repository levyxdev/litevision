import { z } from "zod";
import type { HttpTransport } from "../http.ts";
import { classifyProviderError, providerError, providerLabel, sendToProvider } from "./errors.ts";
import { inParallel } from "./parallel.ts";
import type {
  GeneratedImage,
  ImageCapabilities,
  ImageRequest,
  ImageSize,
  ModelIdsResult,
  ModelTarget,
  ProtocolAdapter,
  ProviderErrorKind,
  ProviderTarget,
} from "./protocol.ts";

const contentSchema = z.object({
  type: z.string(),
  text: z.string().optional(),
  data: z.string().optional(),
  uri: z.string().optional(),
});

const interactionSchema = z.object({
  status: z.string(),
  steps: z.array(z.object({ type: z.string(), content: z.array(contentSchema).optional() })).optional(),
  errors: z.array(z.object({ code: z.string().optional(), message: z.string().optional() })).optional(),
});

/** The Interactions API's `{ error: { code, message } }`, and Google's older `{ error: { code, message, status, details } }`. */
const errorSchema = z.object({
  error: z.object({
    code: z.union([z.string(), z.number()]).optional(),
    message: z.string().optional(),
    status: z.string().optional(),
    details: z.array(z.object({ reason: z.string().optional() })).optional(),
  }),
});

/** Codes Gemini gives when policy or safety blocked the output (https://ai.google.dev/gemini-api/docs/api-errors). */
const blockedCodes = new Set([
  "safety",
  "recitation",
  "language",
  "prohibited_content",
  "spii",
  "blocklist",
  "image_safety",
  "image_prohibited_content",
  "image_recitation",
  "image_other",
  "content_blocked",
]);

interface GeminiModel {
  capabilities: ImageCapabilities;
  /** Sent as `response_format.image_size`; omitted for Models that take only one size. */
  imageSize?: string;
}

const sizes = (entries: Array<[ImageSize["aspectRatio"], number, number]>): ImageSize[] =>
  entries.map(([aspectRatio, width, height]) => ({ aspectRatio, width, height }));

/** Gemini 3 image Models at the default 1K `image_size`; up to 14 reference images. */
const gemini3: GeminiModel = {
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
    maxImages: 4,
  },
  imageSize: "1K",
};

/** `gemini-2.5-flash-image`: one size per ratio, best with up to 3 reference images. */
const gemini25: GeminiModel = {
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
    maxImages: 4,
  },
};

/** Unknown model ids: Gemini 3 sizes, without assuming they take `image_size` or many references. */
const unknownModel: GeminiModel = { capabilities: { ...gemini3.capabilities, maxReferences: 3 } };

const gemini3Ids = ["gemini-nano-banana-2.1", "gemini-3.1-flash-image", "gemini-3.1-flash-lite-image", "gemini-3-pro-image"];

/** `includes` rather than equality, so `-preview` suffixes and relay prefixes such as `google/` still match. */
function geminiModel(modelId: string): GeminiModel {
  if (modelId.includes("gemini-2.5-flash-image")) return gemini25;
  if (gemini3Ids.some((id) => modelId.includes(id))) return gemini3;
  return unknownModel;
}

function interactionBody(request: ImageRequest, target: ModelTarget): Record<string, unknown> {
  const { response_format: extraFormat, ...options } = request.providerOptions;
  const { imageSize } = geminiModel(target.modelId);
  return {
    model: target.modelId,
    input: [
      { type: "text", text: request.prompt },
      ...request.references.map((reference) => ({
        type: "image",
        mime_type: reference.mimeType,
        data: Buffer.from(reference.bytes).toString("base64"),
      })),
    ],
    ...options,
    // provider_options may add to the response format (a larger `image_size`, a `mime_type`), but the image type and
    // aspect ratio are always litevision's.
    response_format: {
      ...(imageSize === undefined ? {} : { image_size: imageSize }),
      ...(isObject(extraFormat) ? extraFormat : {}),
      type: "image",
      aspect_ratio: request.size.aspectRatio,
    },
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Interaction error codes may be bare (`image_safety`) or a URI ending in one. */
function kindOf(status: number, codes: Array<string | undefined>, message: string | undefined): ProviderErrorKind {
  const bare = codes.filter((code) => code !== undefined).map((code) => code.split(/[/#]/).pop()!.toLowerCase());
  if (bare.some((code) => blockedCodes.has(code))) return "refusal";
  return classifyProviderError({ status, codes, message });
}

/** One Interaction, one image. */
async function sendInteraction(request: ImageRequest, target: ModelTarget, http: HttpTransport): Promise<GeneratedImage[]> {
  const response = await sendToProvider(http, target.providerId, `${trimmed(target.baseUrl)}/interactions`, {
    method: "POST",
    headers: { "x-goog-api-key": target.credential, "content-type": "application/json" },
    body: JSON.stringify(interactionBody(request, target)),
  });

  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const parsed = errorSchema.safeParse(body);
    const error = parsed.success ? parsed.data.error : undefined;
    const message = error?.message ?? (response.statusText || undefined);
    const codes = [typeof error?.code === "string" ? error.code : undefined, error?.status, ...(error?.details ?? []).map((detail) => detail.reason)];
    const detail = message === undefined ? `HTTP ${response.status}` : `HTTP ${response.status}: ${message}`;
    throw providerError(kindOf(response.status, codes, message), target.providerId, detail);
  }

  const parsed = interactionSchema.safeParse(body);
  if (!parsed.success) {
    throw providerError("other", target.providerId, "its response could not be read as a Gemini Interaction.");
  }
  const interaction = parsed.data;
  // Only `model_output` steps hold results: interim "thought" images live in `thought` steps and are skipped.
  const content = (interaction.steps ?? []).filter((step) => step.type === "model_output").flatMap((step) => step.content ?? []);
  // Like the SDK's `output_image`, keep the last image: one request is one image.
  const image = content.filter((block) => block.type === "image" && (block.data !== undefined || block.uri !== undefined)).at(-1);
  if (image !== undefined) {
    return [image.data !== undefined ? { bytes: Buffer.from(image.data, "base64") } : { url: image.uri! }];
  }

  // A blocked generation still answers HTTP 200, with the reason in `errors`.
  const errors = interaction.errors ?? [];
  if (errors.length > 0) {
    const message = errors.map((error) => error.message ?? error.code).join(" ");
    throw providerError(kindOf(200, errors.map((error) => error.code), message), target.providerId, message);
  }
  const said = content.flatMap((block) => (block.text === undefined ? [] : [block.text])).join(" ");
  throw providerError(
    "other",
    target.providerId,
    `the Interaction ended "${interaction.status}" with no image.${said === "" ? "" : ` The model wrote: ${said}`}`,
  );
}

/** Gemini's Interactions API (`POST /interactions`): synchronous, one image per request, references sent inline. */
export const gemini: ProtocolAdapter = {
  builtInCapabilities: (modelId) => geminiModel(modelId).capabilities,

  // Gemini's `/models` says nothing about image sizes or limits, so there is no `fetchModelInfo` (ADR 0004).

  docsUrl: () => "https://ai.google.dev/api/interactions-api",

  reservedOptions: ["model", "input"],

  async submit(request, target, http) {
    return { wait: () => inParallel(request.n, target.providerId, () => sendInteraction(request, target, http)) };
  },

  async testConnection(target, http) {
    const list = await fetchModelIds(target, http);
    if (!list.ok) return list;
    return {
      ok: true,
      message: `Connected to Provider "${target.providerId}". It offers ${list.modelIds.length} image model id(s).`,
    };
  },

  listModelIds: fetchModelIds,
};

const modelListSchema = z.object({
  models: z.array(z.object({ name: z.string() })).optional(),
  nextPageToken: z.string().optional(),
});

/** Gemini lists every model; these name patterns pick out the image ones. */
const looksLikeImageModel = (modelId: string) => /image|nano-banana/.test(modelId);

/** `GET {baseUrl}/models`, every page, keeping image model ids. Model ids come back sorted, without `models/`. */
async function fetchModelIds(target: ProviderTarget, http: HttpTransport): Promise<ModelIdsResult> {
  const label = providerLabel(target.providerId);
  const modelIds: string[] = [];
  let pageToken: string | undefined;
  do {
    const url = `${trimmed(target.baseUrl)}/models?pageSize=1000${pageToken === undefined ? "" : `&pageToken=${encodeURIComponent(pageToken)}`}`;
    let response: Response;
    try {
      response = await http(url, { headers: { "x-goog-api-key": target.credential } });
    } catch (error) {
      return { ok: false, message: `Could not reach ${label}: ${(error as Error).message}` };
    }

    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const parsed = errorSchema.safeParse(body);
      const detail = (parsed.success ? parsed.data.error.message : undefined) ?? response.statusText;
      return { ok: false, message: `${label} returned HTTP ${response.status}: ${detail}` };
    }
    const parsed = modelListSchema.safeParse(body);
    if (!parsed.success) {
      return { ok: false, message: `${label} answered, but not with a Gemini model list. Check the base URL.` };
    }
    modelIds.push(...(parsed.data.models ?? []).map((model) => model.name.replace(/^models\//, "")));
    pageToken = parsed.data.nextPageToken || undefined;
  } while (pageToken !== undefined);

  return { ok: true, modelIds: modelIds.filter(looksLikeImageModel).sort() };
}

function trimmed(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}
