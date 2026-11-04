import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ConfigError,
  defaultModelAlias,
  loadConfig,
  modelNotesMaxLength,
  needsSettings,
  notesAuthors,
  requireCredential,
  resolveModel,
  type Config,
  type Model,
} from "./config.ts";
import type { Dirs } from "./dirs.ts";
import { optionsRecord, rateJob, readJob, ratingReasonMaxLength, RatingError, readRatedJobs, verdicts, type OptionsRecord, type RatedJob, type SuspectOption } from "./history.ts";
import type { HttpTransport } from "./http.ts";
import { JobFailedError, JobRunner, type JobState } from "./jobs.ts";
import type { MediaFacts } from "./media.ts";
import { modelInfo, videoModelInfo, type ModelInfoDeps } from "./model-info.ts";
import { updateNotesAsAgent } from "./model-notes.ts";
import { describeCapabilities, describeVideoCapabilities, normaliseImageRequest, normaliseVideoRequest } from "./protocols/capabilities.ts";
import { adapterFor, adapterForProtocol } from "./protocols/index.ts";
import { aspectRatios, formatSize, modalities } from "./protocols/protocol.ts";
import { openInBrowser, type OpenBrowser } from "./settings/browser.ts";
import { settingsOpener } from "./settings/opener.ts";
import { defaultSettingsIdleMs } from "./settings/server.ts";
import { version } from "../package.json";

export interface ServerDeps {
  dirs: Dirs;
  http: HttpTransport;
  now?: () => Date;
  /** Relative `references` and `output_path` resolve against this; defaults to the process's working directory. */
  cwd?: string;
  /** Opens the settings page for `open_settings`. Defaults to the User's default browser. */
  openBrowser?: OpenBrowser;
  /** How long the settings page `open_settings` starts may sit idle before it shuts down. */
  settingsIdleMs?: number;
  /** How long `generate_image` and `get_job` wait for a Job before returning its id; defaults to two minutes. */
  waitLimitMs?: number;
  /** How often asynchronous Protocols poll their Provider; defaults to three seconds. */
  pollIntervalMs?: number;
}

export const instructions = `litevision generates images and videos through Models the User has configured with their own Providers. Each Model makes one Modality: image Models work with \`generate_image\`, video Models with \`generate_video\`.

- Use the Model the User names (pass its Alias as \`model\`).
- When the User names none, omit \`model\` to use the default Model of that Modality, unless the request needs something the default lacks (e.g. legible Chinese text, reference images, an aspect ratio, a first frame). Then call \`list_models\` and choose by each Model's capabilities and Model Notes.
- Never ask the User for an API key or any other Credential. If litevision reports that nothing is configured, call \`open_settings\` so the User can set it up in their browser.
- \`generate_image\` and \`generate_video\` return file paths, not media data. Tell the User where the files are.
- A Job that takes longer than two minutes keeps running in the background (videos often do): the tool then returns its Job id with status "running". Tell the User it is still running, and call \`get_job\` with that Job id to wait for it again and get the files.
- Ask for an aspect ratio (and for a video, a duration), not pixel sizes. If the Model does not support it, the closest supported one is used; when the result says it was adjusted, tell the User what was used.
- Every result says what litevision actually got (pixel size, and a video's length). If it says the result does not match the request, tell the User, and check the Model's docs before trying again.
- If a tool says a Model cannot do something (reference images, that many images, a first frame), the error lists what the Model supports: choose another Model or change the request.
- Pass \`output_path\` when the files belong in the User's project (e.g. its assets folder); otherwise omit it.
- For Provider-specific \`provider_options\`: first reuse the Model's Known-good Options, which \`list_models\` shows. Only when none cover what you need, read the Model's docs link (\`list_models\` with \`model\` also gives the Provider's parameter schema when it publishes one). Read the docs again when a result does not match the request, when the Provider rejects an option (its error carries the docs link), or when options are marked suspect because a result that used them did not match or the User rated it bad. litevision passes \`provider_options\` through unchecked.
- If fewer images came back than you asked for, the result says why. Tell the User.
- When the User says what they think of a result ("this one's great", "the text is wrong", "that's not 4K"), call \`rate_job\` with that Job's id, their verdict (good or bad) and a one-line reason in their words. This is how litevision learns which options work, so do it whenever the User states a verdict in the conversation; never invent one, and never rate a result yourself.
- Model Notes say what each Model is good or bad at. When the User learns something worth keeping, you may propose new Model Notes: short, replacing the old text whole rather than adding to it. Before calling \`update_model_notes\`, show the User the old and new Model Notes and get their agreement; never change them without it.`;

/** The structured form of one Model in `list_models`. */
const listedModelSchema = z.object({
  alias: z.string(),
  provider: z.string(),
  protocol: z.string(),
  model_id: z.string().describe("The Provider's own name for the model."),
  modality: z.enum(modalities).describe("What the Model generates: images with `generate_image`, videos with `generate_video`."),
  default: z.boolean().describe("True for the default Model of its Modality."),
  notes: z.string().describe("Model Notes: what the Model is good or bad at, agreed with the User."),
  capabilities: z
    .object({
      aspect_ratios: z.array(z.object({ aspect_ratio: z.enum(aspectRatios), size: z.string() })),
      reference_images: z.boolean(),
      max_reference_images: z.number(),
      max_images_per_job: z.number(),
    })
    .nullable()
    .describe("An image Model's capabilities; null for a video Model, or when the Model cannot be used (`problem` then says why)."),
  video_capabilities: z
    .object({
      resolutions: z.array(
        z.object({
          resolution: z.string().nullable().describe("The tier's name to pass as `resolution`; null when the Model takes none."),
          aspect_ratios: z.array(z.object({ aspect_ratio: z.enum(aspectRatios), size: z.string() })),
        }),
      ),
      durations: z.array(z.number()).describe("Every clip length in seconds the Model can make."),
      default_duration: z.number(),
      first_frame: z.boolean(),
      last_frame: z.boolean(),
      max_reference_images: z.number(),
    })
    .optional()
    .describe("A video Model's capabilities; the first resolution is the default."),
  docs_url: z.string().nullable().describe("Where to read which `provider_options` this Model accepts."),
  known_good_options: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Known-good Options: `provider_options` whose results matched the request and that the User has not rated bad. Reuse them."),
  suspect_options: z
    .record(z.string(), z.object({ value: z.unknown(), reason: z.string(), job_id: z.string(), cause: z.enum(["rating", "mismatch"]) }))
    .optional()
    .describe(
      "`provider_options` last used by a Job the User rated bad (cause \"rating\", with the User's reason) or whose result did not match the request (cause \"mismatch\"). Check the docs before sending them again.",
    ),
  problem: z.string().optional(),
  parameter_schema: z
    .unknown()
    .optional()
    .describe("Only with `model`: the Provider's own description of the Model's parameters, when it publishes one."),
});

/** One Model as `list_models` reports it, as structured output and as a line of text; `detailed` adds what only `model` asks for. */
async function listedModel(
  deps: ModelInfoDeps,
  config: Config,
  model: Model,
  isDefault: boolean,
  detailed: boolean,
  ratedJobs: RatedJob[],
) {
  const base = {
    alias: model.alias,
    provider: model.provider,
    protocol: model.protocol,
    model_id: model.modelId,
    modality: model.modality,
    default: isDefault,
    notes: model.notes ?? "",
  };
  const heading = `${model.alias}${isDefault ? ` (default ${model.modality})` : ""}: ${model.modality} Model ${model.modelId} on ${model.provider} via ${model.protocol}.`;
  const notes = model.notes ? ` Notes: ${model.notes}` : "";

  let described: { output: Partial<z.infer<typeof listedModelSchema>>; summary: string; docsUrl: string; parameterSchema?: unknown };
  try {
    const provider = config.providers.find((candidate) => candidate.id === model.provider);
    if (provider === undefined) throw needsSettings(`Model "${model.alias}" refers to Provider "${model.provider}", which is not configured.`);
    if (model.modality === "video") {
      const info = videoModelInfo({ model, provider });
      described = {
        output: { capabilities: null, video_capabilities: videoCapabilitiesOutput(info.capabilities) },
        summary: describeVideoCapabilities(info.capabilities),
        docsUrl: info.docsUrl,
      };
    } else {
      const info = await modelInfo(deps, { model, provider });
      const { capabilities } = info;
      described = {
        output: {
          capabilities: {
            aspect_ratios: capabilities.sizes.map((size) => ({ aspect_ratio: size.aspectRatio, size: formatSize(size) })),
            reference_images: capabilities.maxReferences > 0,
            max_reference_images: capabilities.maxReferences,
            max_images_per_job: capabilities.maxImages,
          },
        },
        summary: describeCapabilities(capabilities),
        docsUrl: info.docsUrl,
        ...(info.parameterSchema === undefined ? {} : { parameterSchema: info.parameterSchema }),
      };
    }
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    return {
      output: { ...base, capabilities: null, docs_url: null, problem: error.message },
      text: `${heading} Cannot be used: ${error.message}${notes}`,
    };
  }

  const record = optionsOf(ratedJobs, model);
  const output: z.infer<typeof listedModelSchema> = {
    ...base,
    capabilities: null,
    ...described.output,
    docs_url: described.docsUrl,
    known_good_options: record.knownGood,
    suspect_options: suspectOutput(record),
  };
  let text = `${heading} Supports ${described.summary}${notes} provider_options docs: ${described.docsUrl}`;
  const goodKeys = Object.keys(record.knownGood);
  const suspectKeys = Object.keys(record.suspect);
  if (detailed) {
    text += `\nKnown-good Options: ${goodKeys.length === 0 ? "none recorded yet" : JSON.stringify(record.knownGood)}`;
    for (const [key, suspect] of Object.entries(record.suspect)) {
      text += `\nSuspect: ${key}=${JSON.stringify(suspect.value)}, used by Job ${suspect.jobId}, ${suspectWhy(suspect)}`;
    }
    if (described.parameterSchema !== undefined) {
      output.parameter_schema = described.parameterSchema;
      text += `\nParameter schema from the Provider: ${JSON.stringify(described.parameterSchema)}`;
    }
  } else {
    if (goodKeys.length > 0) text += ` Known-good Options: ${goodKeys.join(", ")}.`;
    if (suspectKeys.length > 0) text += ` Suspect options: ${suspectKeys.join(", ")}.`;
  }
  return { output, text };
}

function videoCapabilitiesOutput(capabilities: ReturnType<typeof videoModelInfo>["capabilities"]) {
  return {
    resolutions: capabilities.resolutions.map((tier) => ({
      resolution: tier.name ?? null,
      aspect_ratios: tier.sizes.map((size) => ({ aspect_ratio: size.aspectRatio, size: formatSize(size) })),
    })),
    durations: capabilities.durations,
    default_duration: capabilities.defaultDuration,
    first_frame: capabilities.firstFrame,
    last_frame: capabilities.lastFrame,
    max_reference_images: capabilities.maxReferences,
  };
}

function suspectOutput(record: OptionsRecord) {
  return Object.fromEntries(
    Object.entries(record.suspect).map(([key, suspect]) => [
      key,
      { value: suspect.value, reason: suspect.reason, job_id: suspect.jobId, cause: suspect.cause },
    ]),
  );
}

/** What the Job history says about a Model's `provider_options` (ADR 0006). */
async function modelOptions(deps: Pick<ModelInfoDeps, "dirs">, model: Model): Promise<OptionsRecord> {
  return optionsOf(await readRatedJobs(deps.dirs), model);
}

function optionsOf(ratedJobs: RatedJob[], model: Model): OptionsRecord {
  return optionsRecord(ratedJobs, { provider: model.provider, protocol: model.protocol, modelId: model.modelId });
}

/** The docs link and recorded options for the Model a Job ran on, read from the Job history. */
async function jobDocs(dirs: Dirs, jobId: string): Promise<{ docsUrl: string; options: OptionsRecord } | undefined> {
  const job = await readJob(dirs, jobId);
  const docsUrl = job === undefined ? undefined : adapterForProtocol(job.protocol)?.docsUrl(job.modelId, job.modality ?? "image");
  if (job === undefined || docsUrl === undefined) return undefined;
  return { docsUrl, options: optionsRecord(await readRatedJobs(dirs), job) };
}

function suspectWhy(suspect: SuspectOption): string {
  return suspect.cause === "rating"
    ? `which the User rated bad: "${suspect.reason}"`
    : `whose result did not match the request: ${suspect.reason}`;
}

/**
 * Where the Agent should look when a Provider rejected a request or a result did not match it: the docs link, and the
 * Known-good Options (ADR 0006).
 */
function optionsHint(docsUrl: string, record: OptionsRecord): string {
  const good = Object.keys(record.knownGood).length === 0 ? "none recorded yet" : JSON.stringify(record.knownGood);
  const suspect = Object.entries(record.suspect)
    .map(([key, entry]) => ` Suspect: ${key}=${JSON.stringify(entry.value)}, used by a Job ${suspectWhy(entry)}.`)
    .join("");
  return ` Docs for this Model's provider_options: ${docsUrl}. Known-good Options: ${good}.${suspect}`;
}

/** The structured form of what each saved file turned out to be. */
const observedSchema = z
  .array(z.object({ width: z.number(), height: z.number(), seconds: z.number().optional() }).nullable())
  .describe("What each saved file turned out to be, in the order of `files`, read from the file itself; null where litevision could not tell.");

const mismatchSchema = z
  .string()
  .optional()
  .describe("Present when the result's shape or length differs from the request: an option may not have taken effect. Tell the User.");

/** One sentence on what the saved files are, e.g. "Got 1344x768." */
function observedText(observed: Array<MediaFacts | null>): string {
  const known = [...new Set(observed.flatMap((facts) => (facts === null ? [] : [describeFacts(facts)])))];
  return known.length === 0 ? "" : ` Got ${known.join(", ")}.`;
}

function describeFacts(facts: MediaFacts): string {
  return `${facts.width}x${facts.height}${facts.seconds === undefined ? "" : `, ${facts.seconds} s`}`;
}

function mismatchText(mismatch: string | undefined, docsUrl: string): string {
  if (mismatch === undefined) return "";
  return ` The result does not match the request: ${mismatch}. A provider_option may not have taken effect, so these options are not recorded as Known-good; check ${docsUrl} before trying again.`;
}

const jobStatusSchema = z
  .enum(["completed", "running"])
  .describe('"running" when the Job outlasted the wait limit and continues in the background; call `get_job` with its `job_id`.');

/** The fields `generate_image` and `get_job` share. */
function jobOutput(job: JobState) {
  return {
    job_id: job.id,
    status: job.status,
    model: job.model,
    files: job.status === "completed" ? job.files : [],
    observed: job.status === "completed" ? job.observed : [],
    ...(job.status === "completed" && job.shortfall !== undefined ? { shortfall: job.shortfall } : {}),
    ...(job.status === "completed" && job.mismatch !== undefined ? { mismatch: job.mismatch } : {}),
  };
}

function jobText(job: JobState & { status: "running" }): string {
  return `Job ${job.id} on ${job.model} is still running and continues in the background. Call \`get_job\` with job_id "${job.id}" to wait for it again and get the files.`;
}

function toolError(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

/**
 * A generation tool's error. When the Provider rejected the request or failed it for a reason it did not classify,
 * the error carries the Model's docs link and Known-good Options, so the Agent need not look them up (ADR 0006).
 */
async function failure(error: unknown, hint: (() => Promise<string>) | undefined) {
  if (error instanceof ConfigError) return toolError(error.message);
  if (error instanceof JobFailedError) {
    const helpful = hint !== undefined && (error.kind === "unsupported" || error.kind === "other");
    return toolError(`Job ${error.jobId} failed: ${error.message}${helpful ? await hint() : ""}`);
  }
  throw error;
}

export function createServer(deps: ServerDeps): McpServer {
  const server = new McpServer({ name: "litevision", version }, { instructions });
  const now = deps.now ?? (() => new Date());
  const cwd = deps.cwd ?? process.cwd();
  const infoDeps: ModelInfoDeps = { dirs: deps.dirs, http: deps.http, now };
  const jobs = new JobRunner({ dirs: deps.dirs, http: deps.http, now, waitLimitMs: deps.waitLimitMs, pollIntervalMs: deps.pollIntervalMs });

  server.registerTool(
    "generate_image",
    {
      description:
        "Generate images from a text prompt with one of the User's configured Models. Saves the images locally and returns their file paths.",
      inputSchema: {
        prompt: z.string().min(1).describe("Sent to the Model verbatim."),
        model: z.string().optional().describe("Alias of the Model to use. Omit to use the default image Model."),
        n: z.number().int().positive().default(1).describe("How many images to generate in this Job, up to the Model's maximum."),
        aspect_ratio: z
          .enum(aspectRatios)
          .default("1:1")
          .describe("Wanted aspect ratio. If the Model does not support it, the closest supported one is used and reported."),
        references: z
          .array(z.string().min(1))
          .default([])
          .describe("Local paths of reference images to edit or draw on. Relative paths resolve against litevision's working directory."),
        output_path: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Folder to save the images in, e.g. the project's assets folder; created if missing. Relative paths resolve against litevision's working directory. Omit to save under a dated folder in the User's home directory.",
          ),
        provider_options: z
          .record(z.string(), z.unknown())
          .default({})
          .describe(
            "Provider-specific request fields passed through untouched, e.g. { \"quality\": \"high\" } for OpenAI. Cannot override fields litevision sets from the other parameters.",
          ),
      },
      outputSchema: {
        job_id: z.string(),
        status: jobStatusSchema,
        model: z.string().describe("Alias of the Model that ran the Job."),
        files: z.array(z.string()).describe("Paths of the saved images; empty while the Job is running."),
        aspect_ratio: z.enum(aspectRatios).describe("Aspect ratio actually used."),
        size: z.string().describe("Size actually requested from the Provider, e.g. 1536x1024."),
        requested_aspect_ratio: z.enum(aspectRatios),
        aspect_ratio_adjusted: z
          .boolean()
          .describe("True when the Model does not support the requested aspect ratio and the closest one was used."),
        shortfall: z.string().optional().describe("Present when fewer images than `n` were saved: how many, and why."),
        observed: observedSchema,
        mismatch: mismatchSchema,
      },
    },
    async ({ prompt, model: alias, n, aspect_ratio, references, output_path, provider_options }) => {
      let failureHint: (() => Promise<string>) | undefined;
      try {
        const resolved = resolveModel(await loadConfig(deps.dirs), alias);
        const { model } = resolved;
        const adapter = adapterFor(model);
        const credential = await requireCredential(deps.dirs, resolved.provider);
        const info = await modelInfo(infoDeps, resolved);
        const normalised = await normaliseImageRequest(
          { prompt, n, aspectRatio: aspect_ratio, references, providerOptions: provider_options },
          model,
          adapter,
          info,
          cwd,
        );

        const outputDir = output_path === undefined ? undefined : resolve(cwd, output_path);
        failureHint = async () => optionsHint(info.docsUrl, await modelOptions(deps, model));
        const job = await jobs.start({ ...resolved, adapter, credential, normalised, outputDir });
        const { size } = normalised.request;
        const output = {
          ...jobOutput(job),
          aspect_ratio: size.aspectRatio,
          size: formatSize(size),
          requested_aspect_ratio: normalised.requestedAspectRatio,
          aspect_ratio_adjusted: normalised.aspectRatioAdjusted,
        };
        const adjustment = normalised.aspectRatioAdjusted
          ? ` ${model.alias} does not support ${normalised.requestedAspectRatio}, so the closest supported aspect ratio was used.`
          : "";
        const text =
          job.status === "running"
            ? `${jobText(job)} It asks ${model.alias} for ${size.aspectRatio} (${formatSize(size)}).${adjustment}`
            : `Saved ${job.files.length} image(s) from ${model.alias} at ${size.aspectRatio} (${formatSize(size)}), Job ${job.id}.${adjustment}${observedText(job.observed)}${mismatchText(job.mismatch, info.docsUrl)}${job.shortfall === undefined ? "" : ` ${job.shortfall}`}\n${job.files.join("\n")}`;
        return { content: [{ type: "text", text }], structuredContent: output };
      } catch (error) {
        return failure(error, failureHint);
      }
    },
  );

  server.registerTool(
    "generate_video",
    {
      description:
        "Generate one video from a text prompt with one of the User's configured video Models, optionally from a first and last frame or reference images. Saves the video locally and returns its file path. Videos often take minutes: the Job then keeps running in the background.",
      inputSchema: {
        prompt: z.string().min(1).describe("Sent to the Model verbatim. Describe motion and camera movement, not only the scene."),
        model: z.string().optional().describe("Alias of the video Model to use. Omit to use the default video Model."),
        aspect_ratio: z
          .enum(aspectRatios)
          .optional()
          .describe(
            "Wanted aspect ratio. Omit for 16:9, or for the first frame's shape when `first_frame` is given. If the Model does not support it, the closest supported one is used and reported.",
          ),
        duration: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Wanted length in seconds. Omit for the Model's default. If the Model cannot make it, the closest length it can is used and reported."),
        resolution: z
          .string()
          .min(1)
          .optional()
          .describe("A resolution tier the Model lists in `list_models`, e.g. 720P. Omit for the Model's default."),
        first_frame: z.string().min(1).optional().describe("Local path of an image the video starts from."),
        last_frame: z.string().min(1).optional().describe("Local path of an image the video ends on."),
        references: z
          .array(z.string().min(1))
          .default([])
          .describe("Local paths of reference images for characters, objects or style. Relative paths resolve against litevision's working directory."),
        output_path: z
          .string()
          .min(1)
          .optional()
          .describe("Folder to save the video in; created if missing. Omit to save under a dated folder in the User's home directory."),
        provider_options: z
          .record(z.string(), z.unknown())
          .default({})
          .describe("Provider-specific request fields passed through untouched, e.g. { \"generate_audio\": true }. Reuse the Model's Known-good Options from `list_models`."),
      },
      outputSchema: {
        job_id: z.string(),
        status: jobStatusSchema,
        model: z.string().describe("Alias of the Model that ran the Job."),
        files: z.array(z.string()).describe("Path of the saved video; empty while the Job is running."),
        aspect_ratio: z.enum(aspectRatios).describe("Aspect ratio actually used."),
        size: z.string().describe("Size the request implies, e.g. 1280x720."),
        resolution: z.string().nullable().describe("Resolution tier actually requested; null when the Model takes none."),
        duration: z.number().describe("Length in seconds actually requested."),
        requested_aspect_ratio: z.enum(aspectRatios),
        aspect_ratio_adjusted: z.boolean(),
        duration_adjusted: z.boolean().describe("True when the Model cannot make the requested length and the closest one was used."),
        observed: observedSchema,
        mismatch: mismatchSchema,
      },
    },
    async ({ prompt, model: alias, aspect_ratio, duration, resolution, first_frame, last_frame, references, output_path, provider_options }) => {
      let failureHint: (() => Promise<string>) | undefined;
      try {
        const resolved = resolveModel(await loadConfig(deps.dirs), alias, "video");
        const { model } = resolved;
        const adapter = adapterFor(model);
        const info = videoModelInfo(resolved);
        const credential = await requireCredential(deps.dirs, resolved.provider);
        const normalised = await normaliseVideoRequest(
          {
            prompt,
            ...(aspect_ratio === undefined ? {} : { aspectRatio: aspect_ratio }),
            ...(duration === undefined ? {} : { duration }),
            ...(resolution === undefined ? {} : { resolution }),
            ...(first_frame === undefined ? {} : { firstFrame: first_frame }),
            ...(last_frame === undefined ? {} : { lastFrame: last_frame }),
            references,
            providerOptions: provider_options,
          },
          model,
          adapter,
          info.capabilities,
          cwd,
        );

        const outputDir = output_path === undefined ? undefined : resolve(cwd, output_path);
        failureHint = async () => optionsHint(info.docsUrl, await modelOptions(deps, model));
        const job = await jobs.startVideo({ ...resolved, adapter, credential, normalised, outputDir });
        const { size, seconds } = normalised.request;
        const output = {
          ...jobOutput(job),
          aspect_ratio: size.aspectRatio,
          size: formatSize(size),
          resolution: normalised.request.resolution ?? null,
          duration: seconds,
          requested_aspect_ratio: normalised.requestedAspectRatio,
          aspect_ratio_adjusted: normalised.aspectRatioAdjusted,
          duration_adjusted: normalised.durationAdjusted,
        };
        const asked = `${seconds} s at ${size.aspectRatio}${normalised.request.resolution === undefined ? "" : ` ${normalised.request.resolution}`} (${formatSize(size)})`;
        const adjustments = [
          normalised.aspectRatioAdjusted ? `${model.alias} does not support ${normalised.requestedAspectRatio}, so the closest supported aspect ratio was used.` : "",
          normalised.durationAdjusted ? `${model.alias} cannot make ${normalised.requestedDuration} s, so the closest length it can was used.` : "",
        ]
          .filter(Boolean)
          .map((sentence) => ` ${sentence}`)
          .join("");
        const text =
          job.status === "running"
            ? `${jobText(job)} It asks ${model.alias} for ${asked}.${adjustments}`
            : `Saved a video from ${model.alias}, ${asked}, Job ${job.id}.${adjustments}${observedText(job.observed)}${mismatchText(job.mismatch, info.docsUrl)}\n${job.files.join("\n")}`;
        return { content: [{ type: "text", text }], structuredContent: output };
      } catch (error) {
        return failure(error, failureHint);
      }
    },
  );

  server.registerTool(
    "get_job",
    {
      description:
        "Get a Job's status, waiting up to two minutes while it runs; once it has completed, the paths of its saved images or video. Use it when `generate_image` or `generate_video` returned a Job that is still running.",
      inputSchema: {
        job_id: z.string().min(1).describe("The `job_id` that `generate_image` or `generate_video` returned."),
      },
      outputSchema: {
        job_id: z.string(),
        status: jobStatusSchema,
        model: z.string().describe("Alias of the Model that ran the Job."),
        files: z.array(z.string()).describe("Paths of the saved images or video; empty while the Job is running."),
        shortfall: z.string().optional().describe("Present when fewer images than asked for were saved: how many, and why."),
        observed: observedSchema,
        mismatch: mismatchSchema,
      },
    },
    async ({ job_id }) => {
      try {
        const job = await jobs.get(job_id);
        const docsUrl =
          job.status === "completed" && job.mismatch !== undefined
            ? ((await jobDocs(deps.dirs, job_id))?.docsUrl ?? "the Model's docs link in `list_models`")
            : "";
        const text =
          job.status === "running"
            ? jobText(job)
            : `Job ${job.id} completed: saved ${job.files.length} file(s) from ${job.model}.${observedText(job.observed)}${mismatchText(job.mismatch, docsUrl)}${job.shortfall === undefined ? "" : ` ${job.shortfall}`}\n${job.files.join("\n")}`;
        return { content: [{ type: "text", text }], structuredContent: jobOutput(job) };
      } catch (error) {
        // A video often outlasts `generate_video`'s wait, so its rejection may first reach the Agent here.
        return failure(error, async () => {
          const docs = await jobDocs(deps.dirs, job_id);
          return docs === undefined ? "" : optionsHint(docs.docsUrl, docs.options);
        });
      }
    },
  );

  server.registerTool(
    "rate_job",
    {
      description:
        "Record the User's Rating of a completed Job: good or bad, plus a one-line reason. Call it only when the User has actually said what they think of the result; never invent a verdict. A later Rating of the same Job replaces the earlier one.",
      inputSchema: {
        job_id: z.string().min(1).describe("The `job_id` that `generate_image`, `generate_video` or `get_job` returned."),
        verdict: z.enum(verdicts).describe("The User's verdict."),
        reason: z
          .string()
          .max(ratingReasonMaxLength)
          .describe(`Why, in one line and in the User's words, e.g. "the text is misspelled". At most ${ratingReasonMaxLength} characters.`),
      },
      outputSchema: {
        job_id: z.string(),
        verdict: z.enum(verdicts),
        reason: z.string().describe("The reason as recorded, on one line."),
        rated_at: z.string().describe("When the Rating was recorded, ISO 8601."),
      },
    },
    async ({ job_id, verdict, reason }) => {
      try {
        const rating = await rateJob(deps.dirs, { jobId: job_id, verdict, reason }, now());
        const output = { job_id: rating.jobId, verdict: rating.verdict, reason: rating.reason, rated_at: rating.ratedAt };
        return {
          content: [{ type: "text", text: `Recorded a ${rating.verdict} Rating on Job ${rating.jobId}: ${rating.reason}` }],
          structuredContent: output,
        };
      } catch (error) {
        if (error instanceof RatingError) return toolError(error.message);
        throw error;
      }
    },
  );

  server.registerTool(
    "list_models",
    {
      description:
        "List the User's configured Models: Alias, Modality (image or video), Provider, Protocol, capabilities, Model Notes, the Known-good Options for `provider_options` and a docs link, and which Models are the defaults. Use it to choose a Model when the request needs something the default may lack. Pass `model` for one Model in detail, with the values of its Known-good and suspect options and the Provider's parameter schema.",
      inputSchema: {
        model: z.string().optional().describe("Alias of one Model to describe in detail. Omit to list every Model."),
      },
      outputSchema: {
        default_model: z.string().nullable().describe("Alias of the default image Model, used when `generate_image` gets no `model`."),
        default_video_model: z.string().nullable().describe("Alias of the default video Model, used when `generate_video` gets no `model`."),
        models: z.array(listedModelSchema),
      },
    },
    async ({ model: alias }) => {
      try {
        const config = await loadConfig(deps.dirs);
        if (config.models.length === 0) throw needsSettings("litevision has no Model configured yet.");
        const defaultModel = defaultModelAlias(config, "image") ?? null;
        const defaultVideoModel = defaultModelAlias(config, "video") ?? null;
        let models = config.models;
        if (alias !== undefined) {
          models = models.filter((model) => model.alias === alias);
          if (models.length === 0) {
            throw new ConfigError(`Unknown Model Alias "${alias}". Known Aliases: ${config.models.map((model) => model.alias).join(", ")}.`);
          }
        }
        const ratedJobs = await readRatedJobs(deps.dirs);
        const entries = await Promise.all(
          models.map((model) =>
            listedModel(
              infoDeps,
              config,
              model,
              model.alias === (model.modality === "video" ? defaultVideoModel : defaultModel),
              alias !== undefined,
              ratedJobs,
            ),
          ),
        );
        const text = entries.map((entry) => entry.text).join("\n");
        return {
          content: [{ type: "text", text }],
          structuredContent: { default_model: defaultModel, default_video_model: defaultVideoModel, models: entries.map((entry) => entry.output) },
        };
      } catch (error) {
        if (error instanceof ConfigError) return toolError(error.message);
        throw error;
      }
    },
  );

  server.registerTool(
    "update_model_notes",
    {
      description: `Replace a Model's Notes with new text, whole: never append. Call it only after showing the User the old and new Model Notes and getting their agreement. At most ${modelNotesMaxLength} characters. The previous version is kept, and the User can undo the change in the settings page.`,
      inputSchema: {
        model: z.string().min(1).describe("Alias of the Model."),
        notes: z
          .string()
          .describe(`The complete new Model Notes the User agreed to, at most ${modelNotesMaxLength} characters. An empty string clears them.`),
      },
      outputSchema: {
        model: z.string(),
        notes: z.string().describe("The Model Notes now."),
        previous_notes: z.string().describe("The Model Notes before this call."),
        changed: z.boolean().describe("False when the text was already the Model Notes, so nothing was recorded."),
        changed_by: z.enum(notesAuthors).nullable().describe("Who made the last change."),
        changed_at: z.string().nullable().describe("When the last change was made, ISO 8601."),
      },
    },
    async ({ model, notes }) => {
      try {
        const change = await updateNotesAsAgent(deps.dirs, model, notes, now());
        const output = {
          model,
          notes: change.notes,
          previous_notes: change.previous,
          changed: change.changed,
          changed_by: change.history?.changedBy ?? null,
          changed_at: change.history?.changedAt ?? null,
        };
        const summary = change.changed
          ? `Replaced the Model Notes of ${model}. The User can undo this in the settings page.`
          : `The Model Notes of ${model} already were this text; nothing changed.`;
        const text = `${summary}\nBefore: ${change.previous || "(none)"}\nNow: ${change.notes || "(none)"}`;
        return { content: [{ type: "text", text }], structuredContent: output };
      } catch (error) {
        if (error instanceof ConfigError) return toolError(error.message);
        throw error;
      }
    },
  );

  const settings = settingsOpener({
    dirs: deps.dirs,
    http: deps.http,
    now,
    idleMs: deps.settingsIdleMs ?? defaultSettingsIdleMs,
    openBrowser: deps.openBrowser ?? openInBrowser,
  });
  server.server.onclose = () => {
    jobs.close();
    void settings.close();
  };

  server.registerTool(
    "open_settings",
    {
      description:
        "Open litevision's settings page in the User's browser, where the User adds Providers, enters Credentials and sets up Models. Call it whenever litevision reports that something is not configured. The User enters Credentials only on that page, never in the conversation.",
      inputSchema: {},
    },
    async () => {
      try {
        await settings.open();
      } catch {
        // The page URL carries the one-time token, so it is never given to the Agent.
        return toolError(
          "Could not open the User's browser. Ask the User to run `litevision settings` in a terminal, which opens the settings page and prints its address.",
        );
      }
      const text =
        "Opened the litevision settings page in the User's browser. Ask the User to finish setting up there and tell you when they are done. Never ask the User for a Credential in the conversation.";
      return { content: [{ type: "text", text }] };
    },
  );

  return server;
}
