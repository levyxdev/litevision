import { randomUUID } from "node:crypto";
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
  type ResolvedModel,
} from "./config.ts";
import type { Dirs } from "./dirs.ts";
import {
  optionsRecord,
  PickError,
  pickResult,
  rateJob,
  readJob,
  ratingReasonMaxLength,
  RatingError,
  readRatedJobs,
  recentPicks,
  recentRatings,
  verdicts,
  type OptionsRecord,
  type PickRecord,
  type PickWithJob,
  type RatedJob,
  type RatingRecord,
  type RatingWithJob,
  type SuspectOption,
} from "./history.ts";
import type { HttpTransport } from "./http.ts";
import { JobFailedError, JobRunner, type JobState } from "./jobs.ts";
import type { MediaFacts } from "./media.ts";
import { modelInfo, videoModelInfo, type ModelInfoDeps } from "./model-info.ts";
import { updateNotesAsAgent } from "./model-notes.ts";
import { describeCapabilities, describeVideoCapabilities, normaliseImageRequest, normaliseVideoRequest } from "./protocols/capabilities.ts";
import { adapterFor, adapterForProtocol } from "./protocols/index.ts";
import { guideOutput, guideSummary, guideText, type ParameterGuide } from "./protocols/parameter-guide.ts";
import { aspectRatios, formatSize, modalities, type AspectRatio, type Modality, type ProviderErrorKind } from "./protocols/protocol.ts";
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
  /** The delay before the first retry of a request the Provider never processed; defaults to two seconds. */
  retryDelayMs?: number;
}

export const instructions = `litevision generates images and videos through Models the User has configured with their own Providers. Before writing a prompt, use the litevision Skill. If you do not have it, mention once that the User can install it with \`npx skills add levyxdev/litevision\`.

- Never ask the User for an API key or any other Credential. If litevision reports that nothing is configured, call \`open_settings\` so the User can set it up in their browser.
- Use the Model the User names. When they name none, omit \`model\` for the default, unless the request needs something the default lacks; then choose with \`list_models\`.
- For \`provider_options\`, reuse the Model's Known-good Options. For any other option, or one marked suspect, read the Model's docs and parameter schema first (\`list_models\` with \`model\`).
- If the Provider rejects an option (the error says it "rejected an option"), fix it from the Provider's message and the docs and try again, at most twice. If it is still rejected, stop and tell the User what the Provider said.
- Tell the User where the files are, and pass on whatever a result says was adjusted, did not match the request, or came back short.
- \`generate_comparison\` costs as much as all its Jobs. Start a Comparison only when the User asks for one or agrees to it.
- When the User says what they think of a result, call \`rate_job\` with their verdict and a one-line reason in their words; when it is about one result of a Job with several, pass \`result\`. Never invent a verdict, and never rate a result yourself.
- When the User chooses among a Comparison's results, call \`pick_result\`, only when the User actually chooses. A Pick is not a Rating: if they also give a verdict, call \`rate_job\` too.
- Before calling \`update_model_notes\`, show the User the old and new Model Notes and get their agreement; never change them without it.`;

/** How many of a Model's Ratings `list_models` with `model` shows (ADR 0008). */
const recentRatingsShown = 5;
/** Of how many Comparisons `list_models` with `model` shows a Model's Picks. */
const recentPicksShown = 5;
/** How much of a Job's prompt a recent Rating or Pick shows. */
const promptStartLength = 80;

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
  parameters: z
    .string()
    .optional()
    .describe("In brief, what litevision knows about the Model's request parameters: its Parameter Guide, the Provider's own description, or that it knows neither."),
  parameter_guide: z
    .object({
      family: z.string(),
      checked: z.string().describe("When the sources were last checked; read the docs first when this is old."),
      sources: z.array(z.string()),
      parameters: z.array(
        z.object({
          name: z.string().describe("The Provider's own field name for `provider_options`, dotted for nested fields."),
          values: z.string(),
          default: z.string(),
          price: z.string().describe("How the value changes the price."),
        }),
      ),
      notes: z.array(z.string()),
    })
    .nullable()
    .optional()
    .describe(
      "Only with `model`: the built-in Parameter Guide for the Model's family. Null when litevision has none, or when the Provider describes the Model itself (see `parameter_schema`).",
    ),
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
  recent_ratings: z
    .array(
      z.object({
        job_id: z.string(),
        result: z.number().optional().describe("Which result of the Job, from 1; absent when the Rating is about the whole Job."),
        verdict: z.enum(verdicts),
        reason: z.string().describe("The User's reason, in their words."),
        rated_at: z.string(),
        prompt: z.string().describe("The start of the Job's prompt."),
      }),
    )
    .optional()
    .describe(
      `Only with \`model\`: the Model's ${recentRatingsShown} most recent Ratings, newest first. When they say something the Model Notes do not, propose new Model Notes to the User.`,
    ),
  recent_picks: z
    .array(
      z.object({
        comparison_id: z.string(),
        job_id: z.string().describe("This Model's Job in the Comparison."),
        picked: z.boolean().describe("Whether the User picked this Model's Job."),
        result: z.number().optional().describe("When picked: which result of the Job the User picked, from 1; absent when they picked the whole Job."),
        picked_model: z.string().optional().describe("Alias of the Model whose Job the User picked."),
        picked_at: z.string(),
        prompt: z.string().describe("The start of this Model's Job's prompt."),
      }),
    )
    .optional()
    .describe(
      `Only with \`model\`: the current Picks of up to ${recentPicksShown} Comparisons this Model took part in, most recently picked first, one entry per Job of this Model in them. A Pick is a relative preference among the Comparison's results, not a Rating.`,
    ),
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

  let described: {
    output: Partial<z.infer<typeof listedModelSchema>>;
    summary: string;
    docsUrl: string;
    parameterSchema?: unknown;
    guide?: ParameterGuide;
  };
  try {
    const provider = config.providers.find((candidate) => candidate.id === model.provider);
    if (provider === undefined) throw needsSettings(`Model "${model.alias}" refers to Provider "${model.provider}", which is not configured.`);
    if (model.modality === "video") {
      const info = videoModelInfo({ model, provider });
      described = {
        output: { capabilities: null, video_capabilities: videoCapabilitiesOutput(info.capabilities) },
        summary: describeVideoCapabilities(info.capabilities),
        docsUrl: info.docsUrl,
        ...(info.guide === undefined ? {} : { guide: info.guide }),
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
        ...(info.guide === undefined ? {} : { guide: info.guide }),
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
    parameters: parametersSummary(described, model.provider),
    known_good_options: record.knownGood,
    suspect_options: suspectOutput(record),
  };
  let text = `${heading} Supports ${described.summary}${notes} provider_options docs: ${described.docsUrl}`;
  if (!detailed) text += ` ${output.parameters}`;
  const goodKeys = Object.keys(record.knownGood);
  const suspectKeys = Object.keys(record.suspect);
  if (detailed) {
    text += `\nKnown-good Options: ${goodKeys.length === 0 ? "none recorded yet" : JSON.stringify(record.knownGood)}`;
    for (const [key, suspect] of Object.entries(record.suspect)) {
      text += `\nSuspect: ${key}=${JSON.stringify(suspect.value)}, used by Job ${suspect.jobId}, ${suspectWhy(suspect)}`;
    }
    const ratings = recentRatings(ratedJobs, model, recentRatingsShown);
    output.recent_ratings = ratings.map(recentRatingOutput);
    text += ratings.length === 0 ? "\nRecent Ratings: none recorded yet." : "\nRecent Ratings, newest first:";
    for (const rated of ratings) text += `\n- ${describeRecentRating(rated)}`;
    const picks = recentPicks(ratedJobs, model, recentPicksShown);
    output.recent_picks = picks.map(recentPickOutput);
    text += picks.length === 0 ? "\nRecent Picks: none recorded yet." : "\nRecent Picks in Comparisons, newest first:";
    for (const picked of picks) text += `\n- ${describeRecentPick(picked)}`;
    output.parameter_guide = described.parameterSchema === undefined && described.guide !== undefined ? guideOutput(described.guide) : null;
    if (described.parameterSchema !== undefined) output.parameter_schema = described.parameterSchema;
    text += `\n${parameterHelp(described, model.provider)}`;
  } else {
    if (goodKeys.length > 0) text += ` Known-good Options: ${goodKeys.join(", ")}.`;
    if (suspectKeys.length > 0) text += ` Suspect options: ${suspectKeys.join(", ")}.`;
  }
  return { output, text };
}

/** What litevision knows about a Model's parameters, as `list_models` and failed Jobs report it. */
interface ParameterKnowledge {
  docsUrl: string;
  /** The Provider's own description; it wins over the built-in guide (ADR 0010). */
  parameterSchema?: unknown;
  guide?: ParameterGuide;
}

/** One sentence: the guide's family and parameter names, or where else to look. */
function parametersSummary(known: ParameterKnowledge, providerId: string): string {
  if (known.parameterSchema !== undefined) {
    return `Provider "${providerId}" describes this Model's parameters itself; \`list_models\` with \`model\` shows its description.`;
  }
  if (known.guide !== undefined) return guideSummary(known.guide);
  return noGuide(known.docsUrl);
}

/** Everything known about a Model's parameters: the Provider's description, else the full built-in guide. */
function parameterHelp(known: ParameterKnowledge, providerId: string): string {
  if (known.parameterSchema !== undefined) {
    return `Parameter schema from Provider "${providerId}", which wins over litevision's own Parameter Guide: ${JSON.stringify(known.parameterSchema)}`;
  }
  if (known.guide !== undefined) return guideText(known.guide);
  return noGuide(known.docsUrl);
}

function noGuide(docsUrl: string): string {
  return `litevision has no Parameter Guide for this model id; read ${docsUrl} before setting provider_options.`;
}

/** A Rating as `rate_job` and `list_models` report it. */
function ratingOutput(rating: RatingRecord) {
  return {
    job_id: rating.jobId,
    ...(rating.result === undefined ? {} : { result: rating.result }),
    verdict: rating.verdict,
    reason: rating.reason,
    rated_at: rating.ratedAt,
  };
}

/** What a Rating is about, in words: the whole Job, or one result of it. */
function ratingSubject(rating: RatingRecord): string {
  return rating.result === undefined ? `Job ${rating.jobId}` : `result ${rating.result} of Job ${rating.jobId}`;
}

function recentRatingOutput({ rating, job }: RatingWithJob) {
  return { ...ratingOutput(rating), prompt: promptStart(job.prompt) };
}

function describeRecentRating({ rating, job }: RatingWithJob): string {
  return `${rating.verdict} on ${ratingSubject(rating)} (${JSON.stringify(promptStart(job.prompt))}): ${rating.reason}`;
}

/** A Pick as `pick_result` reports it. */
function pickOutput(pick: PickRecord) {
  return {
    comparison_id: pick.comparison,
    job_id: pick.jobId,
    ...(pick.result === undefined ? {} : { result: pick.result }),
    picked_at: pick.pickedAt,
  };
}

function recentPickOutput({ pick, job, picked }: PickWithJob) {
  const isPicked = pick.jobId === job.id;
  return {
    comparison_id: pick.comparison,
    job_id: job.id,
    picked: isPicked,
    ...(isPicked && pick.result !== undefined ? { result: pick.result } : {}),
    ...(picked === undefined ? {} : { picked_model: picked.model }),
    picked_at: pick.pickedAt,
    prompt: promptStart(job.prompt),
  };
}

function describeRecentPick({ pick, job, picked }: PickWithJob): string {
  const subject = `Job ${job.id} in Comparison ${pick.comparison} (${JSON.stringify(promptStart(job.prompt))})`;
  if (pick.jobId === job.id) return `${subject}: picked${pick.result === undefined ? "" : `, result ${pick.result}`}`;
  return `${subject}: not picked; the User picked ${picked === undefined ? `Job ${pick.jobId}` : `a Job on ${picked.model}`}`;
}

/** Enough of a prompt, on one line, for the Agent to tell which Job a Rating is about. */
function promptStart(prompt: string): string {
  const line = prompt.replace(/\s+/g, " ").trim();
  return line.length <= promptStartLength ? line : `${line.slice(0, promptStartLength).trimEnd()}…`;
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

/** The docs link, built-in Parameter Guide and recorded options for the Model a Job ran on, read from the Job history. */
async function jobDocs(dirs: Dirs, jobId: string): Promise<{ known: ParameterKnowledge; provider: string; options: OptionsRecord } | undefined> {
  const job = await readJob(dirs, jobId);
  const adapter = job === undefined ? undefined : adapterForProtocol(job.protocol);
  if (job === undefined || adapter === undefined) return undefined;
  const modality = job.modality ?? "image";
  const guide = adapter.parameterGuide?.(job.modelId, modality);
  const known = { docsUrl: adapter.docsUrl(job.modelId, modality), ...(guide === undefined ? {} : { guide }) };
  return { known, provider: job.provider, options: optionsRecord(await readRatedJobs(dirs), job) };
}

function suspectWhy(suspect: SuspectOption): string {
  return suspect.cause === "rating"
    ? `which the User rated bad: "${suspect.reason}"`
    : `whose result did not match the request: ${suspect.reason}`;
}

/**
 * Where the Agent should look when a Provider rejected a request: the docs link and Known-good Options (ADR 0006), and
 * for a rejected or unsupported request also what litevision knows of the Model's parameters (ADR 0010).
 */
function failureHint(known: ParameterKnowledge, providerId: string, record: OptionsRecord, kind: ProviderErrorKind): string {
  const help = kind === "rejected_option" || kind === "unsupported" ? `\n${parameterHelp(known, providerId)}` : "";
  return `${optionsHint(known.docsUrl, record)}${help}`;
}

/** The docs link and the Known-good Options (ADR 0006). */
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
async function failure(error: unknown, hint: Hint | undefined) {
  const reason = await failureReason(error, hint);
  return toolError(error instanceof JobFailedError ? `Job ${error.jobId} failed: ${reason}` : reason);
}

/** What to add to a failed Job's error, given how it failed. */
type Hint = (kind: ProviderErrorKind) => Promise<string>;

/** Why a Job failed or could not start, safe to show the Agent; any other error is rethrown. */
async function failureReason(error: unknown, hint: Hint | undefined): Promise<string> {
  if (error instanceof ConfigError) return error.message;
  if (error instanceof JobFailedError) {
    const helpful = hint !== undefined && (error.kind === "unsupported" || error.kind === "rejected_option" || error.kind === "other");
    return `${error.message}${helpful ? await hint(error.kind) : ""}`;
  }
  throw error;
}

/** A Job checked and ready to start, and how to report it: shared by the single-Job tools and `generate_comparison`. */
interface PreparedJob {
  model: Model;
  start(comparison?: string): Promise<JobState>;
  report(job: JobState): { output: Record<string, unknown>; text: string };
  /** The Model's docs link, Known-good Options and Parameter Guide, for a failed Job's error (ADR 0006, ADR 0010). */
  hint: Hint;
}

interface ImageArgs {
  prompt: string;
  n: number;
  aspect_ratio: AspectRatio;
  references: string[];
  output_path?: string;
  provider_options: Record<string, unknown>;
}

interface VideoArgs {
  prompt: string;
  aspect_ratio?: AspectRatio;
  duration?: number;
  resolution?: string;
  first_frame?: string;
  last_frame?: string;
  references: string[];
  output_path?: string;
  provider_options: Record<string, unknown>;
}

const imageJobShape = {
  job_id: z.string(),
  status: jobStatusSchema,
  model: z.string().describe("Alias of the Model that ran the Job."),
  files: z.array(z.string()).describe("Paths of the saved images; empty while the Job is running."),
  aspect_ratio: z.enum(aspectRatios).describe("Aspect ratio actually used."),
  size: z.string().describe("Size actually requested from the Provider, e.g. 1536x1024."),
  requested_aspect_ratio: z.enum(aspectRatios),
  aspect_ratio_adjusted: z.boolean().describe("True when the Model does not support the requested aspect ratio and the closest one was used."),
  shortfall: z.string().optional().describe("Present when fewer images than `n` were saved: how many, and why."),
  observed: observedSchema,
  mismatch: mismatchSchema,
};

const videoJobShape = {
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
};

const failedJobSchema = z.object({
  job_id: z.string().nullable().describe("Null when the Job could not start."),
  status: z.literal("failed"),
  model: z.string().describe("Alias of the Model the Job ran on."),
  files: z.array(z.string()).describe("Always empty."),
  error: z.string().describe("Why the Job failed."),
});

/** The most Jobs one Comparison starts (ADR 0009). */
export const maxComparisonVariants = 4;

/**
 * The one Modality a Comparison's Models share (ADR 0009): `wanted` when given, else the named Models', else image.
 * Throws when the variants name Models of both Modalities, or of another one than `wanted`.
 */
function comparisonModality(config: Config, variants: Array<{ model?: string | undefined }>, wanted: Modality | undefined): Modality {
  const named = variants.flatMap((variant) => config.models.filter((model) => model.alias === variant.model));
  const found = new Set([...(wanted === undefined ? [] : [wanted]), ...named.map((model) => model.modality)]);
  if (found.size > 1) {
    const makes = [...new Map(named.map((model) => [model.alias, `${model.alias} makes ${model.modality}s`])).values()].join(", ");
    const asked = wanted === undefined ? "" : ` and \`modality\` is ${wanted}`;
    throw new ConfigError(
      `A Comparison's Models must share one Modality, but ${makes}${asked}. Compare image Models or video Models, not both.`,
    );
  }
  return [...found][0] ?? "image";
}

export function createServer(deps: ServerDeps): McpServer {
  const server = new McpServer({ name: "litevision", version }, { instructions });
  const now = deps.now ?? (() => new Date());
  const cwd = deps.cwd ?? process.cwd();
  const infoDeps: ModelInfoDeps = { dirs: deps.dirs, http: deps.http, now };
  const jobs = new JobRunner({ dirs: deps.dirs, http: deps.http, now, waitLimitMs: deps.waitLimitMs, pollIntervalMs: deps.pollIntervalMs, retryDelayMs: deps.retryDelayMs });

  /** Checks an image Job against its Model before anything is sent, so a bad request starts no Job. */
  const prepareImage = async (resolved: ResolvedModel, args: ImageArgs): Promise<PreparedJob> => {
    const { model } = resolved;
    const adapter = adapterFor(model);
    const credential = await requireCredential(deps.dirs, resolved.provider);
    const info = await modelInfo(infoDeps, resolved);
    const normalised = await normaliseImageRequest(
      { prompt: args.prompt, n: args.n, aspectRatio: args.aspect_ratio, references: args.references, providerOptions: args.provider_options },
      model,
      adapter,
      info,
      cwd,
    );
    const outputDir = args.output_path === undefined ? undefined : resolve(cwd, args.output_path);
    return {
      model,
      start: (comparison) => jobs.start({ ...resolved, adapter, credential, normalised, outputDir, ...(comparison === undefined ? {} : { comparison }) }),
      hint: async (kind) => failureHint(info, model.provider, await modelOptions(deps, model), kind),
      report: (job) => {
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
        return { output, text };
      },
    };
  };

  /** Checks a video Job against its Model before anything is sent, so a bad request starts no Job. */
  const prepareVideo = async (resolved: ResolvedModel, args: VideoArgs): Promise<PreparedJob> => {
    const { model } = resolved;
    const adapter = adapterFor(model);
    const info = videoModelInfo(resolved);
    const credential = await requireCredential(deps.dirs, resolved.provider);
    const normalised = await normaliseVideoRequest(
      {
        prompt: args.prompt,
        ...(args.aspect_ratio === undefined ? {} : { aspectRatio: args.aspect_ratio }),
        ...(args.duration === undefined ? {} : { duration: args.duration }),
        ...(args.resolution === undefined ? {} : { resolution: args.resolution }),
        ...(args.first_frame === undefined ? {} : { firstFrame: args.first_frame }),
        ...(args.last_frame === undefined ? {} : { lastFrame: args.last_frame }),
        references: args.references,
        providerOptions: args.provider_options,
      },
      model,
      adapter,
      info.capabilities,
      cwd,
    );
    const outputDir = args.output_path === undefined ? undefined : resolve(cwd, args.output_path);
    return {
      model,
      start: (comparison) =>
        jobs.startVideo({ ...resolved, adapter, credential, normalised, outputDir, ...(comparison === undefined ? {} : { comparison }) }),
      hint: async (kind) => failureHint(info, model.provider, await modelOptions(deps, model), kind),
      report: (job) => {
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
        return { output, text };
      },
    };
  };

  /** Runs one prepared Job on its own, as `generate_image` and `generate_video` do. */
  const runSingle = async (prepare: () => Promise<PreparedJob>) => {
    let prepared: PreparedJob | undefined;
    try {
      prepared = await prepare();
      const { output, text } = prepared.report(await prepared.start());
      return { content: [{ type: "text" as const, text }], structuredContent: output };
    } catch (error) {
      return failure(error, prepared?.hint);
    }
  };

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
      outputSchema: imageJobShape,
    },
    async ({ model: alias, ...args }) => runSingle(async () => prepareImage(resolveModel(await loadConfig(deps.dirs), alias), args)),
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
      outputSchema: videoJobShape,
    },
    async ({ model: alias, ...args }) => runSingle(async () => prepareVideo(resolveModel(await loadConfig(deps.dirs), alias, "video"), args)),
  );

  server.registerTool(
    "generate_comparison",
    {
      description: `Start a Comparison: 2 to ${maxComparisonVariants} Jobs together for one request, differing in prompt, in Model, or both, so the User can choose among their results. All variants' Models must share one Modality. Start one only when the User asks for a Comparison or agrees to one: it costs as much as all its Jobs. Saves each Job's files locally and returns them under one Comparison id.`,
      inputSchema: {
        variants: z
          .array(
            z.object({
              prompt: z.string().min(1).describe("Sent to this variant's Model verbatim."),
              model: z.string().optional().describe("Alias of this variant's Model. Omit to use the default Model of the Comparison's Modality."),
              n: z
                .number()
                .int()
                .positive()
                .optional()
                .describe("Image Comparisons only: how many images this variant's Job makes, up to its Model's maximum. Defaults to 1."),
            }),
          )
          .min(2)
          .max(maxComparisonVariants)
          .describe(`The Jobs to start, 2 to ${maxComparisonVariants}, one per variant.`),
        modality: z
          .enum(modalities)
          .optional()
          .describe("image or video. Omit to take it from the variants' Models; when no variant names one, image."),
        aspect_ratio: z
          .enum(aspectRatios)
          .optional()
          .describe("Wanted aspect ratio for every Job. Omit for 1:1 images or 16:9 videos. Each Model that does not support it uses its closest one."),
        references: z
          .array(z.string().min(1))
          .default([])
          .describe("Local paths of reference images every Job gets. Relative paths resolve against litevision's working directory."),
        output_path: z
          .string()
          .min(1)
          .optional()
          .describe("Folder to save every Job's files in; created if missing. Omit to save under a dated folder in the User's home directory."),
        duration: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Video Comparisons only: wanted length in seconds. Omit for each Model's default."),
      },
      outputSchema: {
        comparison_id: z.string(),
        modality: z.enum(modalities),
        jobs: z
          .array(z.union([z.object(imageJobShape), z.object(videoJobShape), failedJobSchema]))
          .describe(
            "One per variant, in the order given: each as `generate_image` or `generate_video` returns it, or status \"failed\" with why. A \"running\" Job continues in the background; call `get_job` with its `job_id`.",
          ),
      },
    },
    async ({ variants, modality: wanted, aspect_ratio, references, output_path, duration }) => {
      let prepared: PreparedJob[];
      let modality: Modality;
      try {
        const config = await loadConfig(deps.dirs);
        modality = comparisonModality(config, variants, wanted);
        if (modality === "image" && duration !== undefined) {
          throw new ConfigError("`duration` applies only to a video Comparison; leave it out for images.");
        }
        if (modality === "video" && variants.some((variant) => (variant.n ?? 1) > 1)) {
          throw new ConfigError("A video Job makes one video, so leave `n` out of a video Comparison's variants.");
        }
        // Every variant is checked before any Job starts, so a bad one costs nothing.
        prepared = await Promise.all(
          variants.map((variant) => {
            const resolved = resolveModel(config, variant.model, modality);
            const shared = { prompt: variant.prompt, references, provider_options: {}, ...(output_path === undefined ? {} : { output_path }) };
            return modality === "video"
              ? prepareVideo(resolved, { ...shared, ...(aspect_ratio === undefined ? {} : { aspect_ratio }), ...(duration === undefined ? {} : { duration }) })
              : prepareImage(resolved, { ...shared, n: variant.n ?? 1, aspect_ratio: aspect_ratio ?? "1:1" });
          }),
        );
      } catch (error) {
        return failure(error, undefined);
      }

      const comparisonId = randomUUID();
      const settled = await Promise.allSettled(prepared.map((job) => job.start(comparisonId)));
      const results = await Promise.all(
        settled.map(async (outcome, index) => {
          const job = prepared[index]!;
          if (outcome.status === "fulfilled") return job.report(outcome.value);
          // Whatever stopped this Job, the others' results still go back to the Agent.
          const reason = await failureReason(outcome.reason, job.hint).catch(
            () => `litevision could not run this Job: ${(outcome.reason as Error).message}`,
          );
          const jobId = outcome.reason instanceof JobFailedError ? outcome.reason.jobId : null;
          return {
            output: { job_id: jobId, status: "failed" as const, model: job.model.alias, files: [], error: reason },
            text: `Job${jobId === null ? "" : ` ${jobId}`} on ${job.model.alias} failed: ${reason}`,
          };
        }),
      );
      const text = [
        `Comparison ${comparisonId}: ${results.length} ${modality} Jobs. Show the User every result so they can choose; when they do, call \`pick_result\`.`,
        ...results.map((result, index) => `Variant ${index + 1}: ${result.text}`),
      ].join("\n\n");
      return {
        content: [{ type: "text", text }],
        structuredContent: { comparison_id: comparisonId, modality, jobs: results.map((result) => result.output) },
      };
    },
  );

  server.registerTool(
    "get_job",
    {
      description:
        "Get a Job's status, waiting up to two minutes while it runs; once it has completed, the paths of its saved images or video. Use it when `generate_image`, `generate_video` or `generate_comparison` returned a Job that is still running.",
      inputSchema: {
        job_id: z.string().min(1).describe("The `job_id` that `generate_image`, `generate_video` or `generate_comparison` returned."),
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
            ? ((await jobDocs(deps.dirs, job_id))?.known.docsUrl ?? "the Model's docs link in `list_models`")
            : "";
        const text =
          job.status === "running"
            ? jobText(job)
            : `Job ${job.id} completed: saved ${job.files.length} file(s) from ${job.model}.${observedText(job.observed)}${mismatchText(job.mismatch, docsUrl)}${job.shortfall === undefined ? "" : ` ${job.shortfall}`}\n${job.files.join("\n")}`;
        return { content: [{ type: "text", text }], structuredContent: jobOutput(job) };
      } catch (error) {
        // A video often outlasts `generate_video`'s wait, so its rejection may first reach the Agent here.
        return failure(error, async (kind) => {
          const docs = await jobDocs(deps.dirs, job_id);
          return docs === undefined ? "" : failureHint(docs.known, docs.provider, docs.options, kind);
        });
      }
    },
  );

  server.registerTool(
    "rate_job",
    {
      description:
        "Record the User's Rating of a completed Job, or of one result of it: good or bad, plus a one-line reason. Call it only when the User has actually said what they think of the result; never invent a verdict. A later Rating of the same Job and result replaces the earlier one; a Rating of the whole Job and one of a single result stand side by side.",
      inputSchema: {
        job_id: z.string().min(1).describe("The `job_id` that `generate_image`, `generate_video` or `get_job` returned."),
        result: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Which result the verdict is about, from 1 in the order of the Job's files. Omit when it is about the whole Job."),
        verdict: z.enum(verdicts).describe("The User's verdict."),
        reason: z
          .string()
          .max(ratingReasonMaxLength)
          .describe(`Why, in one line and in the User's words, e.g. "the text is misspelled". At most ${ratingReasonMaxLength} characters.`),
      },
      outputSchema: {
        job_id: z.string(),
        result: z.number().optional().describe("The result rated; absent for a Rating of the whole Job."),
        verdict: z.enum(verdicts),
        reason: z.string().describe("The reason as recorded, on one line."),
        rated_at: z.string().describe("When the Rating was recorded, ISO 8601."),
      },
    },
    async ({ job_id, result, verdict, reason }) => {
      try {
        const rating = await rateJob(deps.dirs, { jobId: job_id, result, verdict, reason }, now());
        return {
          content: [{ type: "text", text: `Recorded a ${rating.verdict} Rating on ${ratingSubject(rating)}: ${rating.reason}` }],
          structuredContent: ratingOutput(rating),
        };
      } catch (error) {
        if (error instanceof RatingError) return toolError(error.message);
        throw error;
      }
    },
  );

  server.registerTool(
    "pick_result",
    {
      description:
        "Record the User's Pick within a Comparison: the Job, or the one result of it, the User chose among the Comparison's results. Call it only when the User actually chooses; never pick for them. A later Pick for the same Comparison replaces the earlier one. A Pick is a relative preference, not a Rating: it does not mark the result good or the others bad.",
      inputSchema: {
        comparison_id: z.string().min(1).describe("The `comparison_id` that `generate_comparison` returned."),
        job_id: z.string().min(1).describe("The `job_id` of the chosen Job, one of the Comparison's Jobs."),
        result: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Which result of that Job the User chose, from 1 in the order of its files. Omit when the Job made one result or the User chose the Job as a whole."),
      },
      outputSchema: {
        comparison_id: z.string(),
        job_id: z.string(),
        result: z.number().optional().describe("The result picked; absent when the Job was picked as a whole."),
        picked_at: z.string().describe("When the Pick was recorded, ISO 8601."),
      },
    },
    async ({ comparison_id, job_id, result }) => {
      try {
        const pick = await pickResult(deps.dirs, { comparison: comparison_id, jobId: job_id, result }, now());
        const subject = pick.result === undefined ? `Job ${pick.jobId}` : `result ${pick.result} of Job ${pick.jobId}`;
        return {
          content: [{ type: "text", text: `Recorded the User's Pick in Comparison ${pick.comparison}: ${subject}.` }],
          structuredContent: pickOutput(pick),
        };
      } catch (error) {
        if (error instanceof PickError) return toolError(error.message);
        throw error;
      }
    },
  );

  server.registerTool(
    "list_models",
    {
      description:
        "List the User's configured Models: Alias, Modality (image or video), Provider, Protocol, capabilities, Model Notes, the Known-good Options for `provider_options` and a docs link, and which Models are the defaults. Use it to choose a Model when the request needs something the default may lack. Pass `model` for one Model in detail, with the values of its Known-good and suspect options, its five most recent Ratings, the Picks of up to five Comparisons it took part in (most recently picked first), and the Provider's parameter schema.",
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
