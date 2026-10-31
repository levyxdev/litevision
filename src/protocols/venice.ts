import { z } from "zod";
import type { HttpTransport } from "../http.ts";
import { httpProviderError, providerError, providerLabel, sendToProvider } from "./errors.ts";
import { inParallel } from "./parallel.ts";
import {
  aspectRatios,
  type AspectRatio,
  type GeneratedImage,
  type ImageCapabilities,
  type ImageRequest,
  type ImageSize,
  type JobImages,
  type ModelDescription,
  type ModelIdsResult,
  type ModelTarget,
  type ProtocolAdapter,
  type ProviderModelInfo,
  type ProviderTarget,
} from "./protocol.ts";

/**
 * Venice's native image API. Text-to-image models (Venice type `image`) answer `/image/generate` with base64 JSON;
 * edit models (Venice type `inpaint`, separate model ids such as `nano-banana-pro-edit`) answer `/image/edit` and
 * `/image/multi-edit` with one binary image per request.
 */

const generateDocs = "https://docs.venice.ai/api-reference/endpoint/image/generate";
const editDocs = "https://docs.venice.ai/api-reference/endpoint/image/edit";

/** `/image/generate` takes 1–4 `variants`; the edit endpoints get one request per image, capped the same way. */
const maxImages = 4;

/** What litevision needs to know to call one Venice model. */
interface VeniceModel {
  /** "generate" models take a prompt alone; "edit" models need at least one reference image. */
  kind: "generate" | "edit";
  /** How `/image/generate` sizes the image: `width`/`height` ("pixels") or `aspect_ratio` ("ratio"). Edits always use `aspect_ratio`. */
  sizing: "pixels" | "ratio";
  /** Undefined when Venice's constraints cannot be mapped onto litevision's aspect ratios. */
  capabilities?: ImageCapabilities;
  /** Venice's own constraints for the model, shown to the Agent as its parameter schema. */
  constraints?: unknown;
}

const constraintsSchema = z.object({
  aspectRatios: z.array(z.string()).optional(),
  widthHeightDivisor: z.number().positive().optional(),
  combineImages: z.boolean().optional(),
  maxInputImages: z.number().int().positive().optional(),
});

type Constraints = z.infer<typeof constraintsSchema>;

/** Pixel-sized models are the ones with a `widthHeightDivisor` above 1; the rest take `aspect_ratio`. */
const sizingOf = (constraints: Constraints): VeniceModel["sizing"] => ((constraints.widthHeightDivisor ?? 1) > 1 ? "pixels" : "ratio");

const modelListSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      type: z.string().optional(),
      model_spec: z
        .object({
          constraints: z.record(z.string(), z.unknown()).optional(),
          // The multi-edit docs also name `capabilities.maxInputImages`; the model schema puts it in `constraints`.
          capabilities: z.object({ maxInputImages: z.number().int().positive().optional() }).passthrough().optional(),
        })
        .passthrough()
        .optional(),
    }),
  ),
});

type ListedModel = z.infer<typeof modelListSchema>["data"][number];
type ModelType = "image" | "inpaint";

const errorSchema = z.object({
  error: z.union([z.string(), z.object({ message: z.string().optional(), code: z.string().nullish() })]),
  code: z.string().optional(),
  suggested_prompt: z.string().optional(),
});

const generateSchema = z.object({
  images: z.array(z.string()),
  content_policy_violation_count: z.number().int().nonnegative().optional(),
});

/** A nominal size of about a megapixel for an aspect ratio, divisible by `divisor`; at most `maxSide` on either side. */
function sizeFor(aspectRatio: AspectRatio, divisor: number, maxSide = Infinity): ImageSize {
  const [w, h] = aspectRatio.split(":").map(Number) as [number, number];
  const area = 1024 * 1024;
  let width = Math.sqrt((area * w) / h);
  let height = Math.sqrt((area * h) / w);
  const scale = Math.min(1, maxSide / width, maxSide / height);
  width *= scale;
  height *= scale;
  const snap = (value: number) => Math.max(divisor, Math.round(value / divisor) * divisor);
  return { aspectRatio, width: snap(width), height: snap(height) };
}

/** Pixel-sized models: every aspect ratio, within `/image/generate`'s 1280-pixel limit. */
function pixelSizes(divisor: number): ImageSize[] {
  return aspectRatios.map((ratio) => sizeFor(ratio, divisor, 1280));
}

/** Ratio-sized models: the ratios Venice lists that litevision knows. The sizes are nominal; Venice picks the pixels. */
function ratioSizes(ratios: readonly string[]): ImageSize[] {
  return aspectRatios.filter((ratio) => ratios.includes(ratio)).map((ratio) => sizeFor(ratio, 16));
}

/** Venice's edit models all end in `-edit` (or are `qwen-edit-…`). */
function looksLikeEdit(modelId: string): boolean {
  return /(^|-)edit(-|$)/.test(modelId);
}

/** Known pixel-sized models; any other text-to-image model is assumed to size by aspect ratio, as most Venice models do. */
const pixelModels = ["venice-sd35", "hidream", "lustify-sdxl", "flux-dev", "flux-dev-uncensored", "pony-realism"];

/** What litevision assumes when Venice's model list cannot be asked (ADR 0004). */
function builtInModel(modelId: string): VeniceModel & { capabilities: ImageCapabilities } {
  if (looksLikeEdit(modelId)) {
    // The edit endpoints' documented aspect ratios, and the documented default of 3 input images.
    return { kind: "edit", sizing: "ratio", capabilities: { sizes: ratioSizes(aspectRatios), maxReferences: 3, maxImages } };
  }
  if (pixelModels.includes(modelId)) {
    return { kind: "generate", sizing: "pixels", capabilities: { sizes: pixelSizes(16), maxReferences: 0, maxImages } };
  }
  return {
    kind: "generate",
    sizing: "ratio",
    capabilities: { sizes: ratioSizes(["1:1", "16:9", "9:16", "3:2", "2:3"]), maxReferences: 0, maxImages },
  };
}

/** Reads one entry of Venice's model list. */
function describeModel(listed: ListedModel, listType: ModelType): VeniceModel {
  const raw = listed.model_spec?.constraints;
  const parsed = constraintsSchema.safeParse(raw ?? {});
  const constraints = parsed.success ? parsed.data : {};
  const nonEmpty = (capabilities: ImageCapabilities) => (capabilities.sizes.length === 0 ? undefined : capabilities);

  if ((listed.type ?? listType) === "inpaint") {
    const maxReferences =
      constraints.maxInputImages ?? listed.model_spec?.capabilities?.maxInputImages ?? (constraints.combineImages === false ? 1 : 3);
    return {
      kind: "edit",
      sizing: "ratio",
      capabilities: nonEmpty({ sizes: ratioSizes(constraints.aspectRatios ?? []), maxReferences, maxImages }),
      constraints: raw,
    };
  }
  if (sizingOf(constraints) === "pixels") {
    return {
      kind: "generate",
      sizing: "pixels",
      capabilities: { sizes: pixelSizes(constraints.widthHeightDivisor!), maxReferences: 0, maxImages },
      constraints: raw,
    };
  }
  return {
    kind: "generate",
    sizing: "ratio",
    capabilities: nonEmpty({ sizes: ratioSizes(constraints.aspectRatios ?? []), maxReferences: 0, maxImages }),
    constraints: raw,
  };
}

const apiUrl = (baseUrl: string, path: string) => `${baseUrl.replace(/\/+$/, "")}${path}`;
const authorization = (credential: string) => ({ authorization: `Bearer ${credential}` });

/** `GET {baseUrl}/models?type=…`. Failures come back as a plain-language message that never contains the Credential. */
async function listModels(
  target: ProviderTarget,
  type: ModelType,
  http: HttpTransport,
): Promise<{ ok: true; models: ListedModel[] } | { ok: false; message: string }> {
  const label = providerLabel(target.providerId);
  let response: Response;
  try {
    response = await http(apiUrl(target.baseUrl, `/models?type=${type}`), { headers: authorization(target.credential) });
  } catch (error) {
    return { ok: false, message: `Could not reach ${label}: ${(error as Error).message}` };
  }
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    return { ok: false, message: `${label} returned HTTP ${response.status}: ${errorMessage(body) ?? response.statusText}` };
  }
  const parsed = modelListSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, message: `${label} answered, but not with a Venice model list. Check the base URL.` };
  }
  return { ok: true, models: parsed.data.data };
}

/**
 * How to call a model, from what litevision already knows about it rather than another model list request: only edit
 * models take reference images, and Venice's constraints (the parameter schema) say how to size the rest. Without
 * them, the built-in guess.
 */
function describedModel(described: ModelDescription, modelId: string): Pick<VeniceModel, "kind" | "sizing"> {
  const kind = described.capabilities.maxReferences > 0 ? "edit" : "generate";
  const constraints = constraintsSchema.safeParse(described.parameterSchema);
  if (described.parameterSchema === undefined || !constraints.success) return { kind, sizing: builtInModel(modelId).sizing };
  return { kind, sizing: sizingOf(constraints.data) };
}

/** Finds a model in Venice's image and edit model lists; undefined when neither has it. Throws when a list cannot be read. */
async function lookUpModel(target: ModelTarget, http: HttpTransport): Promise<VeniceModel | undefined> {
  const types: ModelType[] = looksLikeEdit(target.modelId) ? ["inpaint", "image"] : ["image", "inpaint"];
  for (const type of types) {
    const list = await listModels(target, type, http);
    if (!list.ok) throw new Error(list.message);
    const listed = list.models.find((model) => model.id === target.modelId);
    if (listed !== undefined) return describeModel(listed, type);
  }
  return undefined;
}

function errorMessage(body: unknown): string | undefined {
  const parsed = errorSchema.safeParse(body);
  if (!parsed.success) return undefined;
  return typeof parsed.data.error === "string" ? parsed.data.error : parsed.data.error.message;
}

/** The typed ProviderError for a Venice error response. */
async function veniceError(response: Response, providerId: string): Promise<Error> {
  const body: unknown = await response.json().catch(() => undefined);
  const parsed = errorSchema.safeParse(body);
  const error = parsed.success ? parsed.data : undefined;
  const nested = typeof error?.error === "object" ? error.error : undefined;
  const message = errorMessage(body) ?? (response.statusText || undefined);
  const suggestion = error?.suggested_prompt === undefined ? "" : ` Venice suggests this prompt instead: ${error.suggested_prompt}`;
  return httpProviderError(providerId, {
    status: response.status,
    codes: [error?.code, nested?.code],
    message: message === undefined ? undefined : `${message}${suggestion}`,
  });
}

/** Defaults litevision sets on every request; `provider_options` may override each. Prompts go out verbatim. */
const sharedDefaults = { safe_mode: false, enhance_prompt: false };

async function generate(request: ImageRequest, target: ModelTarget, model: Pick<VeniceModel, "sizing">, http: HttpTransport): Promise<JobImages> {
  const { size } = request;
  const sizing = model.sizing === "pixels" ? { width: size.width, height: size.height } : { aspect_ratio: size.aspectRatio };
  const body = {
    model: target.modelId,
    prompt: request.prompt,
    variants: request.n,
    return_binary: false,
    ...sizing,
    ...sharedDefaults,
    hide_watermark: true,
    format: "png",
    ...request.providerOptions,
  };
  const response = await sendToProvider(http, target.providerId, apiUrl(target.baseUrl, "/image/generate"), {
    method: "POST",
    headers: { ...authorization(target.credential), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await veniceError(response, target.providerId);

  const parsed = generateSchema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) throw providerError("other", target.providerId, "its response could not be read as Venice images.");
  const { images, content_policy_violation_count: omitted = 0 } = parsed.data;
  if (images.length === 0) {
    if (omitted > 0) throw providerError("refusal", target.providerId, `it omitted all ${omitted} images under the model provider's content policy.`);
    throw providerError("other", target.providerId, "it returned no images.");
  }
  const result: JobImages = { images: images.map((image): GeneratedImage => ({ bytes: Buffer.from(image, "base64") })) };
  if (images.length < request.n) {
    result.shortfall =
      omitted > 0
        ? `${providerLabel(target.providerId)} omitted ${omitted} image${omitted === 1 ? "" : "s"} under the model provider's content policy.`
        : `${providerLabel(target.providerId)} returned ${images.length} of ${request.n} images without saying why.`;
  }
  return result;
}

/** One reference goes to `/image/edit`, several to `/image/multi-edit` (which names the model `modelId`). One image per request. */
async function edit(request: ImageRequest, target: ModelTarget, http: HttpTransport): Promise<GeneratedImage[]> {
  const encoded = request.references.map((reference) => Buffer.from(reference.bytes).toString("base64"));
  const [path, inputs] =
    encoded.length === 1
      ? ["/image/edit", { model: target.modelId, image: encoded[0] }]
      : ["/image/multi-edit", { modelId: target.modelId, images: encoded }];
  const body = {
    ...inputs,
    prompt: request.prompt,
    aspect_ratio: request.size.aspectRatio,
    ...sharedDefaults,
    output_format: "png",
    ...request.providerOptions,
  };
  const response = await sendToProvider(http, target.providerId, apiUrl(target.baseUrl, path), {
    method: "POST",
    headers: { ...authorization(target.credential), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await veniceError(response, target.providerId);
  if (response.headers.get("content-type")?.includes("json")) {
    throw providerError("other", target.providerId, "it answered an edit with JSON rather than an image.");
  }
  return [{ bytes: new Uint8Array(await response.arrayBuffer()) }];
}

export const venice: ProtocolAdapter = {
  builtInCapabilities: (modelId) => builtInModel(modelId).capabilities,

  async fetchModelInfo(target, http): Promise<ProviderModelInfo | undefined> {
    const model = await lookUpModel(target, http);
    if (model === undefined) return undefined;
    return {
      ...(model.capabilities === undefined ? {} : { capabilities: model.capabilities }),
      ...(model.constraints === undefined ? {} : { parameterSchema: model.constraints }),
    };
  },

  docsUrl: (modelId) => (looksLikeEdit(modelId) ? editDocs : generateDocs),

  reservedOptions: ["model", "modelId", "prompt", "variants", "return_binary", "width", "height", "aspect_ratio", "image", "images"],

  async submit(request, target, http) {
    const model = describedModel(request.model, target.modelId);

    if (request.references.length > 0) {
      return { wait: () => inParallel(request.n, target.providerId, () => edit(request, target, http)) };
    }
    if (model.kind === "edit") {
      throw providerError(
        "unsupported",
        target.providerId,
        `"${target.modelId}" is an edit model and needs at least one reference image. Pass \`references\`, or choose a text-to-image Model.`,
      );
    }
    const images = await generate(request, target, model, http);
    return { wait: async () => images };
  },

  async testConnection(target, http) {
    const list = await listModels(target, "image", http);
    if (!list.ok) return list;
    return { ok: true, message: `Connected to Provider "${target.providerId}". It offers ${list.models.length} image model id(s).` };
  },

  async listModelIds(target, http): Promise<ModelIdsResult> {
    // Text-to-image and edit models are separate ids on Venice; the User may want either.
    const lists = await Promise.all((["image", "inpaint"] as const).map((type) => listModels(target, type, http)));
    const failed = lists.find((list) => !list.ok);
    if (failed !== undefined && !failed.ok) return failed;
    const ids = lists.flatMap((list) => (list.ok ? list.models.map((model) => model.id) : []));
    return { ok: true, modelIds: [...new Set(ids)].sort() };
  },
};
