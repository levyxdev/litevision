import { z } from "zod";
import type { HttpTransport } from "../http.ts";
import { httpProviderError, providerError, sendToProvider } from "./errors.ts";
import { multipartBody } from "./multipart.ts";
import {
  formatSize,
  ProviderError,
  type GeneratedImage,
  type ImageCapabilities,
  type ImageRequest,
  type ModelIdsResult,
  type ModelTarget,
  type ProtocolAdapter,
  type ProviderTarget,
} from "./protocol.ts";

const successSchema = z.object({
  data: z.array(z.object({ b64_json: z.string().optional(), url: z.string().optional() })),
});

const errorSchema = z.object({
  error: z.object({
    message: z.string().optional(),
    code: z.string().nullish(),
    type: z.string().nullish(),
  }),
});

const gptImage: ImageCapabilities = {
  sizes: [
    { aspectRatio: "1:1", width: 1024, height: 1024 },
    { aspectRatio: "3:2", width: 1536, height: 1024 },
    { aspectRatio: "2:3", width: 1024, height: 1536 },
  ],
  maxReferences: 16,
  maxImages: 10,
};

const dalle3: ImageCapabilities = {
  sizes: [
    { aspectRatio: "1:1", width: 1024, height: 1024 },
    { aspectRatio: "16:9", width: 1792, height: 1024 },
    { aspectRatio: "9:16", width: 1024, height: 1792 },
  ],
  maxReferences: 0,
  maxImages: 1,
};

const dalle2: ImageCapabilities = {
  sizes: [{ aspectRatio: "1:1", width: 1024, height: 1024 }],
  maxReferences: 1,
  maxImages: 10,
};

/** Text-to-image goes to `/images/generations` as JSON; with references, to `/images/edits` as multipart. */
function buildRequest(request: ImageRequest, target: ModelTarget): { url: string; init: RequestInit } {
  const baseUrl = target.baseUrl.replace(/\/+$/, "");
  const headers = { authorization: `Bearer ${target.credential}` };
  const fields = {
    model: target.modelId,
    prompt: request.prompt,
    n: request.n,
    size: formatSize(request.size),
    ...request.providerOptions,
  };

  if (request.references.length === 0) {
    return {
      url: `${baseUrl}/images/generations`,
      init: { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(fields) },
    };
  }

  // dall-e-2 takes a single `image`; the gpt-image Models take an array as `image[]`.
  const imageField = target.modelId.startsWith("dall-e-2") ? "image" : "image[]";
  const { body, contentType } = multipartBody(
    Object.entries(fields).map(([name, value]) => [name, typeof value === "string" ? value : JSON.stringify(value)]),
    request.references.map((reference) => ({ name: imageField, ...reference })),
  );
  return { url: `${baseUrl}/images/edits`, init: { method: "POST", headers: { ...headers, "content-type": contentType }, body } };
}

/** OpenAI's images API: synchronous, results as base64 or links. */
export const openaiImages: ProtocolAdapter = {
  builtInCapabilities(modelId) {
    if (modelId.startsWith("dall-e-3")) return dalle3;
    if (modelId.startsWith("dall-e-2")) return dalle2;
    // gpt-image-1 and its successors; also the safest guess for a relay's own model names.
    return gptImage;
  },

  // OpenAI's `/models` says nothing about image sizes or limits, so there is no `fetchModelInfo`.

  docsUrl: () => "https://platform.openai.com/docs/api-reference/images/create",

  reservedOptions: ["model", "prompt", "n", "size", "image", "image[]"],

  async submit(request, target, http) {
    const { url, init } = buildRequest(request, target);
    const response = await sendToProvider(http, target.providerId, url, init);

    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const parsed = errorSchema.safeParse(body);
      const error = parsed.success ? parsed.data.error : undefined;
      throw httpProviderError(target.providerId, {
        status: response.status,
        codes: [error?.code, error?.type],
        message: error?.message ?? (response.statusText || undefined),
      });
    }

    const parsed = successSchema.safeParse(body);
    if (!parsed.success) {
      throw providerError("other", target.providerId, "its response could not be read as OpenAI images.");
    }
    const images = parsed.data.data.map((item): GeneratedImage => {
      if (item.b64_json !== undefined) return { bytes: Buffer.from(item.b64_json, "base64") };
      if (item.url !== undefined) return { url: item.url };
      throw providerError("other", target.providerId, "it returned an image with neither data nor a link.");
    });
    return { wait: async () => ({ images }) };
  },

  async testConnection(target, http) {
    const list = await fetchModelIds(target, http);
    if (!list.ok) return list;
    return { ok: true, message: `Connected to Provider "${target.providerId}". It offers ${list.modelIds.length} model id(s).` };
  },

  listModelIds: fetchModelIds,
};

const modelListSchema = z.object({ data: z.array(z.object({ id: z.string() })) });

/** `GET {baseUrl}/models`, which needs a working base URL and Credential. Model ids come back sorted. */
async function fetchModelIds(target: ProviderTarget, http: HttpTransport): Promise<ModelIdsResult> {
  const providerLabel = `Provider "${target.providerId}"`;
  let response: Response;
  try {
    response = await http(`${target.baseUrl.replace(/\/+$/, "")}/models`, {
      headers: { authorization: `Bearer ${target.credential}` },
    });
  } catch (error) {
    return { ok: false, message: `Could not reach ${providerLabel}: ${(error as Error).message}` };
  }

  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const parsed = errorSchema.safeParse(body);
    const detail = parsed.success ? parsed.data.error.message : response.statusText;
    return { ok: false, message: `${providerLabel} returned HTTP ${response.status}: ${detail}` };
  }
  const parsed = modelListSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, message: `${providerLabel} answered, but not with an OpenAI-style model list. Check the base URL.` };
  }
  return { ok: true, modelIds: parsed.data.data.map((model) => model.id).sort() };
}
