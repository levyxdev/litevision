import { z } from "zod";
import type { HttpTransport } from "../http.ts";
import { httpProviderError, providerError, providerLabel } from "./errors.ts";
import { veniceGuide } from "./guides/venice.ts";
import { inParallel } from "./parallel.ts";
import type {
  GeneratedImage,
  ImageRequest,
  JobContext,
  JobImages,
  ModelIdsResult,
  ModelTarget,
  ProtocolAdapter,
  ProviderModelInfo,
  ProviderTarget,
} from "./protocol.ts";
import { sendToProvider } from "./send.ts";

/**
 * Venice's native image API. Text-to-image models (Venice type `image`) answer `/image/generate` with base64 JSON;
 * edit models (Venice type `inpaint`, separate model ids such as `nano-banana-pro-edit`) answer `/image/edit` and
 * `/image/multi-edit` with one binary image per request.
 */

const generateDocs = "https://docs.venice.ai/api-reference/endpoint/image/generate";
const editDocs = "https://docs.venice.ai/api-reference/endpoint/image/edit";

const modelListSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      type: z.string().optional(),
      // Each model's sizes, tiers and reference limit, which litevision shows the Agent as its parameter schema.
      model_spec: z.object({ constraints: z.record(z.string(), z.unknown()).optional() }).passthrough().optional(),
    }),
  ),
});

type ListedModel = z.infer<typeof modelListSchema>["data"][number];
type ModelType = "image" | "inpaint";

const errorSchema = z.object({
  error: z.union([z.string(), z.object({ message: z.string().optional(), code: z.string().nullish() })]),
  code: z.string().optional(),
  suggested_prompt: z.string().optional(),
  /** Why a request was invalid, by field: `{ _errors: [], cfg_scale: { _errors: ["Number must be …"] } }`. */
  details: z.record(z.string(), z.unknown()).optional(),
});

const generateSchema = z.object({
  images: z.array(z.string()),
  content_policy_violation_count: z.number().int().nonnegative().optional(),
});

/** Venice's edit models all end in `-edit` (or are `qwen-edit-…`). */
function looksLikeEdit(modelId: string): boolean {
  return /(^|-)edit(-|$)/.test(modelId);
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
 * Venice's own constraints for a model (its sizes, tiers and reference limit), from its image and edit model lists;
 * undefined when neither has it. Throws when a list cannot be read.
 */
async function lookUpModel(target: ModelTarget, http: HttpTransport): Promise<{ constraints?: unknown } | undefined> {
  const types: ModelType[] = looksLikeEdit(target.modelId) ? ["inpaint", "image"] : ["image", "inpaint"];
  for (const type of types) {
    const list = await listModels(target, type, http);
    if (!list.ok) throw new Error(list.message);
    const listed = list.models.find((model) => model.id === target.modelId);
    if (listed !== undefined) return listed.model_spec?.constraints === undefined ? {} : { constraints: listed.model_spec.constraints };
  }
  return undefined;
}

function errorMessage(body: unknown): string | undefined {
  const parsed = errorSchema.safeParse(body);
  if (!parsed.success) return undefined;
  return typeof parsed.data.error === "string" ? parsed.data.error : parsed.data.error.message;
}

const fieldErrorsSchema = z.object({ _errors: z.array(z.string()) });

/** What `details` says about each field, e.g. `cfg_scale: Number must be less than or equal to 20`. */
function fieldProblems(details: Record<string, unknown> | undefined): string[] {
  return Object.entries(details ?? {}).flatMap(([field, value]) => {
    const parsed = fieldErrorsSchema.safeParse(value);
    return field === "_errors" || !parsed.success || parsed.data._errors.length === 0 ? [] : [`${field}: ${parsed.data._errors.join(", ")}`];
  });
}

/** The typed ProviderError for a Venice error response; `options` are the `provider_options` keys the request sent. */
async function veniceError(response: Response, providerId: string, options: readonly string[]): Promise<Error> {
  const body: unknown = await response.json().catch(() => undefined);
  const parsed = errorSchema.safeParse(body);
  const error = parsed.success ? parsed.data : undefined;
  const nested = typeof error?.error === "object" ? error.error : undefined;
  const problems = fieldProblems(error?.details);
  const said = errorMessage(body) ?? (response.statusText || undefined);
  const message = said === undefined ? undefined : problems.length === 0 ? said : `${said}: ${problems.join("; ")}`;
  const suggestion = error?.suggested_prompt === undefined ? "" : ` Venice suggests this prompt instead: ${error.suggested_prompt}`;
  return httpProviderError(providerId, {
    status: response.status,
    codes: [error?.code, nested?.code],
    message: message === undefined ? undefined : `${message}${suggestion}`,
    options,
  });
}

/** Defaults litevision sets on every request; `provider_options` may override each. Prompts go out verbatim. */
const sharedDefaults = { safe_mode: false, enhance_prompt: false };

async function generate(request: ImageRequest, target: ModelTarget, http: HttpTransport, context: JobContext): Promise<JobImages> {
  const body = {
    model: target.modelId,
    prompt: request.prompt,
    variants: request.n,
    return_binary: false,
    ...sharedDefaults,
    hide_watermark: true,
    format: "png",
    ...request.providerOptions,
  };
  const response = await sendToProvider(http, target.providerId, apiUrl(target.baseUrl, "/image/generate"), {
    method: "POST",
    headers: { ...authorization(target.credential), "content-type": "application/json" },
    body: JSON.stringify(body),
  }, { context });
  if (!response.ok) throw await veniceError(response, target.providerId, Object.keys(request.providerOptions));

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
async function edit(request: ImageRequest, target: ModelTarget, http: HttpTransport, context: JobContext): Promise<GeneratedImage[]> {
  const encoded = request.references.map((reference) => Buffer.from(reference.bytes).toString("base64"));
  const [path, inputs] =
    encoded.length === 1
      ? ["/image/edit", { model: target.modelId, image: encoded[0] }]
      : ["/image/multi-edit", { modelId: target.modelId, images: encoded }];
  const body = {
    ...inputs,
    prompt: request.prompt,
    ...sharedDefaults,
    output_format: "png",
    ...request.providerOptions,
  };
  const response = await sendToProvider(http, target.providerId, apiUrl(target.baseUrl, path), {
    method: "POST",
    headers: { ...authorization(target.credential), "content-type": "application/json" },
    body: JSON.stringify(body),
  }, { context });
  if (!response.ok) throw await veniceError(response, target.providerId, Object.keys(request.providerOptions));
  if (response.headers.get("content-type")?.includes("json")) {
    throw providerError("other", target.providerId, "it answered an edit with JSON rather than an image.");
  }
  return [{ bytes: new Uint8Array(await response.arrayBuffer()) }];
}

export const venice: ProtocolAdapter = {
  async fetchModelInfo(target, http): Promise<ProviderModelInfo | undefined> {
    const model = await lookUpModel(target, http);
    if (model === undefined) return undefined;
    return model.constraints === undefined ? {} : { parameterSchema: model.constraints };
  },

  docsUrl: (modelId) => (looksLikeEdit(modelId) ? editDocs : generateDocs),

  parameterGuide: (modelId, modality) => (modality === "image" ? veniceGuide(modelId) : undefined),

  requestFields: { image: { shape: [{ width: "width", height: "height" }, "aspect_ratio"], resolution: "resolution" } },

  reservedOptions: ["model", "modelId", "prompt", "return_binary", "image", "images"],

  // Reference images go to the edit endpoints, a prompt alone to `/image/generate`; Venice says which a model takes.
  async submit(request, target, http, context) {
    if (request.references.length > 0) {
      return { wait: () => inParallel(request.n, target.providerId, () => edit(request, target, http, context)) };
    }
    const images = await generate(request, target, http, context);
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
