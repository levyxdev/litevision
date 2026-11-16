import { z } from "zod";
import type { HttpTransport } from "../http.ts";
import { httpProviderError, providerError } from "./errors.ts";
import { sendToProvider } from "./send.ts";
import { ProviderError, type GeneratedImage, type JobContext, type JobImages, type ModelTarget, type ProtocolAdapter, type SubmittedJob } from "./protocol.ts";

/**
 * stable-diffusion.cpp's `sd-server`, a Runtime on the User's own machine: no account, no Credential. Jobs go through
 * its native asynchronous API. A Model's model id is the id of a recipe in the Runtime's model folder whose `models`
 * name the weight files, so loading it needs nothing else; a built-in recipe names none. Loading replaces whatever the
 * Runtime has loaded, a Model it was started with included.
 */

const docs = "https://github.com/leejet/stable-diffusion.cpp/blob/master/examples/server/api.md";

const errorSchema = z.object({ error: z.string().optional(), message: z.string().optional(), code: z.string().optional() });

const submittedSchema = z.object({ id: z.string() });

const statusSchema = z.object({ state: z.string(), recipe: z.string().nullish(), error: z.string().nullish() });

const jobSchema = z.object({
  status: z.string(),
  result: z.object({ images: z.array(z.object({ b64_json: z.string() })) }).nullish(),
  error: z.object({ code: z.string().optional(), message: z.string().optional() }).nullish(),
});

const baseUrlOf = (target: { baseUrl: string }) => target.baseUrl.replace(/\/+$/, "");

/**
 * The typed error for an error answer: sd-server says what went wrong in `error`, sometimes with more in `message`,
 * and about its loaded Model, a `code`. `doing` says what litevision was asking for, where that helps.
 */
async function errorOf(response: Response, providerId: string, { options = [], doing }: { options?: readonly string[]; doing?: string } = {}) {
  const parsed = errorSchema.safeParse(await response.json().catch(() => undefined));
  const body = parsed.success ? parsed.data : {};
  const said = [body.error, body.message].filter((part) => part !== undefined).join(": ") || response.statusText || "no reason given";
  const message = doing === undefined ? said : `${doing} failed: ${said}`;
  return httpProviderError(providerId, { status: response.status, codes: [body.code], message, options });
}

/**
 * Makes sure the Runtime has the Model's recipe loaded, loading it in place of any other. A load already under way is
 * waited out first. sd-server answers a load only once it is done; if that answer is lost, its status tells.
 */
async function ensureLoaded(target: ModelTarget, http: HttpTransport, context: JobContext): Promise<void> {
  const base = baseUrlOf(target);
  const doing = `Loading the Model's recipe "${target.modelId}"`;
  let loadSent = false;
  for (;;) {
    const response = await sendToProvider(http, target.providerId, `${base}/sdcpp/v1/models/status`, undefined, { context, poll: true });
    if (!response.ok) throw await errorOf(response, target.providerId);
    const parsed = statusSchema.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) throw providerError("other", target.providerId, "its Model status could not be read.");
    const status = parsed.data;
    if (status.state === "ready" && status.recipe === target.modelId) return;
    if (status.state === "loading") {
      await context.pause();
      continue;
    }
    if (loadSent) throw providerError("other", target.providerId, `${doing} failed: ${status.error ?? `the Runtime is ${status.state}`}`);

    loadSent = true;
    const init = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ recipe: target.modelId }) };
    let load: Response;
    try {
      load = await sendToProvider(http, target.providerId, `${base}/sdcpp/v1/models/load`, init, { context });
    } catch (error) {
      // A lost answer: the status says how the load went. Anything else, such as shutting down, propagates.
      if (error instanceof ProviderError) continue;
      throw error;
    }
    if (!load.ok) throw await errorOf(load, target.providerId, { doing });
    const loaded = statusSchema.safeParse(await load.json().catch(() => undefined));
    if (loaded.success && loaded.data.state === "ready" && loaded.data.recipe === target.modelId) return;
  }
}

const dataUrl = (reference: { mimeType: string; bytes: Uint8Array }) =>
  `data:${reference.mimeType};base64,${Buffer.from(reference.bytes).toString("base64")}`;

/** Polls sd-server's task for a Job until it ends and returns its images, or its typed error. */
async function pollJob(jobId: string, target: ModelTarget, http: HttpTransport, context: JobContext): Promise<JobImages> {
  const url = `${baseUrlOf(target)}/sdcpp/v1/jobs/${encodeURIComponent(jobId)}`;
  for (;;) {
    const response = await sendToProvider(http, target.providerId, url, undefined, { context, poll: true });
    if (response.status === 404 || response.status === 410) {
      throw providerError(
        "other",
        target.providerId,
        `the Runtime no longer has task ${jobId}: sd-server forgets every task when it restarts, and keeps a finished one for a day when litevision started it, else for 10 minutes by default. Generate again.`,
      );
    }
    if (!response.ok) throw await errorOf(response, target.providerId);
    const parsed = jobSchema.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) throw providerError("other", target.providerId, `its status for task ${jobId} could not be read.`);
    const job = parsed.data;
    if (job.status === "completed") {
      const images = (job.result?.images ?? []).map((image): GeneratedImage => ({ bytes: Buffer.from(image.b64_json, "base64") }));
      if (images.length === 0) throw providerError("other", target.providerId, `task ${jobId} completed without images.`);
      return { images };
    }
    if (job.status === "cancelled") throw providerError("cancelled", target.providerId, job.error?.message ?? `task ${jobId} cancelled.`);
    if (job.status === "failed") {
      throw providerError("other", target.providerId, job.error?.message ?? `task ${jobId} ${job.status}.`);
    }
    // "queued" or "generating".
    await context.pause();
  }
}

function waitForJob(jobId: string, target: ModelTarget, http: HttpTransport, context: JobContext): SubmittedJob {
  return { resumeHandle: { jobId }, wait: () => pollJob(jobId, target, http, context) };
}

export const sdcpp: ProtocolAdapter = {
  needsCredential: false,

  onRuntime: true,

  docsUrl: () => `${docs}#post-sdcppv1img_gen`,

  requestFields: { image: { shape: [{ width: "width", height: "height" }], format: "output_format" } },

  reservedOptions: ["prompt", "ref_images"],

  async submit(request, target, http, context) {
    await ensureLoaded(target, http, context);
    await context.checkCancelled();
    const body = {
      prompt: request.prompt,
      batch_count: request.n,
      ...(request.references.length === 0 ? {} : { ref_images: request.references.map(dataUrl) }),
      ...request.providerOptions,
    };
    const init = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
    const response = await sendToProvider(http, target.providerId, `${baseUrlOf(target)}/sdcpp/v1/img_gen`, init, { context });
    if (!response.ok) throw await errorOf(response, target.providerId, { options: Object.keys(request.providerOptions) });
    const parsed = submittedSchema.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) throw providerError("other", target.providerId, "its answer to the submission had no task id.");
    return waitForJob(parsed.data.id, target, http, context);
  },

  resume(handle, target, http, context) {
    return waitForJob(String(handle.jobId), target, http, context);
  },

  /** sd-server cancels a queued task at once, and a generating one at its next step; the Model stays loaded. */
  async cancel(handle, target, http) {
    const url = `${baseUrlOf(target)}/sdcpp/v1/jobs/${encodeURIComponent(String(handle.jobId))}/cancel`;
    const response = await http(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch((error: Error) => {
      throw providerError("other", target.providerId, `cancelling task ${String(handle.jobId)} failed: ${error.message}`);
    });
    // A task the Runtime no longer has, or one already finished, needs no cancelling.
    if (!response.ok && response.status !== 404 && response.status !== 409 && response.status !== 410) throw await errorOf(response, target.providerId);
  },
};
