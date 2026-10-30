import { z } from "zod";
import type { HttpTransport } from "../http.ts";
import {
  ProviderError,
  type ConnectionResult,
  type GeneratedImage,
  type ProtocolAdapter,
  type ProviderTarget,
} from "./protocol.ts";

const successSchema = z.object({
  data: z.array(z.object({ b64_json: z.string().optional(), url: z.string().optional() })),
});

const errorSchema = z.object({ error: z.object({ message: z.string() }) });

/** OpenAI's images API: synchronous, results as base64 or links. */
export const openaiImages: ProtocolAdapter = {
  async submit(request, target, http) {
    const url = `${target.baseUrl.replace(/\/+$/, "")}/images/generations`;
    const providerLabel = `Provider "${target.providerId}"`;

    let response: Response;
    try {
      response = await http(url, {
        method: "POST",
        headers: { authorization: `Bearer ${target.credential}`, "content-type": "application/json" },
        body: JSON.stringify({ model: target.modelId, prompt: request.prompt, n: request.n }),
      });
    } catch (error) {
      throw new ProviderError("other", `Could not reach ${providerLabel}: ${(error as Error).message}`);
    }

    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const parsed = errorSchema.safeParse(body);
      const detail = parsed.success ? parsed.data.error.message : response.statusText;
      throw new ProviderError("other", `${providerLabel} returned HTTP ${response.status}: ${detail}`);
    }

    const parsed = successSchema.safeParse(body);
    if (!parsed.success) {
      throw new ProviderError("other", `${providerLabel} returned a response litevision could not read as OpenAI images.`);
    }
    const images = parsed.data.data.map((item): GeneratedImage => {
      if (item.b64_json !== undefined) return { bytes: Buffer.from(item.b64_json, "base64") };
      if (item.url !== undefined) return { url: item.url };
      throw new ProviderError("other", `${providerLabel} returned an image with neither data nor a link.`);
    });
    return { wait: async () => images };
  },

  testConnection: testOpenaiConnection,
};

const modelListSchema = z.object({ data: z.array(z.object({ id: z.string() })) });

/** Lists the Provider's models (`GET {baseUrl}/models`), which needs a working base URL and Credential. */
async function testOpenaiConnection(target: ProviderTarget, http: HttpTransport): Promise<ConnectionResult> {
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
  return { ok: true, message: `Connected to ${providerLabel}. It offers ${parsed.data.data.length} model id(s).` };
}
