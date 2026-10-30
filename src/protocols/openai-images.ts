import { z } from "zod";
import { ProviderError, type GeneratedImage, type ProtocolAdapter } from "./protocol.ts";

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
};
