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
  changeAuthors,
  resolveModel,
  type Config,
  type Model,
  type ResolvedModel,
} from "./config.ts";
import { deleteJobs, skipReasonNames, type DeletionReport } from "./deletion.ts";
import type { Dirs } from "./dirs.ts";
import { fileStem } from "./file-names.ts";
import {
  PickError,
  pickResult,
  rateJob,
  readJob,
  readJobs,
  ratingReasonMaxLength,
  RatingError,
  readRatedJobs,
  recentPicks,
  recentRatings,
  verdicts,
  type PickRecord,
  type PickWithJob,
  type RatedJob,
  type RatingRecord,
  type RatingWithJob,
  type JobRecord,
} from "./history.ts";
import type { HttpTransport } from "./http.ts";
import { JobFailedError, JobRunner, type JobState, type StartOptions } from "./jobs.ts";
import { catalog, type Catalog } from "./local/catalog.ts";
import { RuntimeManager, type Runtime } from "./local/runtime.ts";
import { modelInfo, videoModelInfo, type ModelInfoDeps } from "./model-info.ts";
import { updateNotesAsAgent } from "./model-notes.ts";
import { byStatus, optionStatusNames, optionStatusReader, type OptionStatus, type OptionStatusName, type StatusedModel } from "./option-status.ts";
import { showSourceJobs, type ShownSourceJob } from "./source-jobs.ts";
import { mergeOptions, optionSources, updateStandingOptionsAsAgent, type OptionInputs, type OptionSources } from "./standing-options.ts";
import { normaliseImageRequest, normaliseVideoRequest } from "./protocols/requests.ts";
import { adapterFor, adapterForProtocol, credentialFor } from "./protocols/index.ts";
import { guideOutput, guideSummary, guideText, type ParameterGuide, type Requested } from "./protocols/parameter-guide.ts";
import { modalities, type Modality, type ProviderErrorKind } from "./protocols/protocol.ts";
import { toolResult } from "./result.ts";
import { openInBrowser, type OpenBrowser } from "./settings/browser.ts";
import { settingsOpener, settingsTabs } from "./settings/opener.ts";
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
  /** How long `generate_image`, `generate_video` and `get_job` wait for a Job before returning its id; defaults to two minutes. */
  waitLimitMs?: number;
  /** How often asynchronous Protocols poll their Provider; defaults to three seconds. */
  pollIntervalMs?: number;
  /** The delay before the first retry of a request the Provider never processed; defaults to two seconds. */
  retryDelayMs?: number;
  /** Where litevision finds the Runtime build it installed; defaults to the pinned catalog. */
  catalog?: Catalog;
  /** How long the Runtime's Model may sit idle before it is unloaded; defaults to ten minutes. */
  runtimeIdleMs?: number;
  /** Where local Jobs run; defaults to the shared Runtime litevision installed. */
  runtime?: Runtime;
}

export const instructions = `litevision generates images and videos through Models the User configured with their own Providers. Before writing a prompt, use the litevision Skill; if you do not have it, mention once that the User can install it with \`npx skills add levyxdev/litevision\`.

- Never ask the User for a Credential. When litevision reports something is not configured, call \`open_settings\`.
- Use the Model the User names. Otherwise omit \`model\` for the default, unless the request needs something it lacks; then choose with \`list_models\`.
- \`provider_options\` go to the Provider untranslated, in each Model's own fields from its Parameter Guide (\`list_models\` with \`model\`), over its Standing Options. Reuse Honoured values; never resend a Rejected or Ignored value unchanged.
- When the Provider rejects an option, fix it from its message and the docs and retry, at most twice; then tell the User what it said.
- Tell the User where the files are, and pass on any \`mismatch\`, \`shortfall\` or \`overrides\` in a result.
- Start a Comparison (\`generate_comparison\`) only when the User asks or agrees.
- When the User judges a result, call \`rate_job\`; when they choose among a Comparison's results, call \`pick_result\`.
- Change Model Notes or Standing Options only with the User's agreement.
- Delete Jobs only when the User asks.`;

/** How many of a Model's Ratings `list_models` with `model` shows (ADR 0008). */
const recentRatingsShown = 5;
/** Of how many Comparisons `list_models` with `model` shows a Model's Picks. */
const recentPicksShown = 5;
/** How much of a Job's prompt a recent Rating or Pick shows. */
const promptStartLength = 80;

/** One Option Status as `list_models` gives it (ADR 0011). */
const optionStatusSchema = z.object({
  options: z
    .record(z.string(), z.unknown())
    .describe("The `provider_options` keys and the values sent; several keys when a check reads them together, such as width and height."),
  job_id: z.string().describe("The Job the latest evidence comes from."),
  job_deleted: z.literal(true).optional().describe("True when the User has deleted that Job since; the evidence still stands."),
  date: z.string().describe("When that Job started."),
  reason: z.string().optional().describe("Ignored: how the result differed from the request. Rejected: what the Provider said."),
});

/** A Job's Source Jobs as `get_job` and the Ratings in `list_models` give them. */
const sourceJobsSchema = z
  .array(
    z.object({
      job_id: z.string(),
      result: z.number().describe("Which result of the Source Job, from 1."),
      model: z.string().optional().describe("Alias of the Model that ran the Source Job."),
      file: z.string().describe("Where the Source Job saved that result."),
      deleted: z.boolean().describe("True when the User has deleted or moved that file since."),
      job_deleted: z.literal(true).optional().describe("True when the User has deleted the Source Job itself from the Job history."),
      reference: z.string().describe("This Job's reference image or video frame that had the result's content."),
    }),
  )
  .optional()
  .describe("Source Jobs: earlier Jobs whose results were among this Job's reference images or video frames, found by content. Absent when there are none.");

/** Option Statuses in brief, as `list_models` without `model` gives them: the option keys under each status. */
const statusKeysSchema = z
  .array(z.string())
  .optional()
  .describe('`provider_options` keys, joined with "+" where a check reads them together, e.g. width+height.');

/** The structured form of one Model in `list_models`. */
const listedModelSchema = z.object({
  alias: z.string(),
  provider: z.string(),
  model_id: z.string().describe("The Provider's own name for the model."),
  modality: z.enum(modalities).describe("What the Model generates: images with `generate_image`, videos with `generate_video`."),
  notes: z.string().optional().describe("Model Notes: what the Model is good or bad at, agreed with the User."),
  standing_options: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Standing Options the User set or agreed to: request fields every Job on this Model sends."),
  docs_url: z.string().optional().describe("Only with `model`: where to read which `provider_options` this Model accepts."),
  parameters: z
    .string()
    .optional()
    .describe(
      "In brief, what litevision knows about the Model's request parameters: its Parameter Guide, the Provider's own description, or that it knows neither. With `model`, only when it knows neither.",
    ),
  parameter_guide: z
    .object({
      family: z.string(),
      checked: z.string().describe("When the sources were last checked."),
      sources: z.array(z.string()).optional(),
      parameters: z
        .array(
          z.object({
            name: z.string().describe("The Provider's own field name for `provider_options`, dotted for nested fields."),
            values: z.string().optional(),
            default: z.string().optional(),
            price: z.string().optional().describe("How the value changes the price."),
          }),
        )
        .optional(),
      notes: z.array(z.string()).optional(),
    })
    .optional()
    .describe(
      "Only with `model`: the built-in Parameter Guide for the Model's family. Absent when litevision has none, or when the Provider describes the Model itself (see `parameter_schema`).",
    ),
  option_statuses: z
    .union([
      z.object({ honoured: statusKeysSchema, ignored: statusKeysSchema, rejected: statusKeysSchema, accepted: statusKeysSchema }),
      z.object({
        honoured: z.array(optionStatusSchema).optional(),
        ignored: z.array(optionStatusSchema).optional(),
        rejected: z.array(optionStatusSchema).optional(),
        accepted: z.array(optionStatusSchema).optional(),
      }),
    ])
    .optional()
    .describe(
      "Option Statuses: what the latest evidence says about each `provider_options` value sent to this Model, from facts alone; Ratings and Picks never change them. Without `model`, the keys under each status; with `model`, each value with its Job and date.",
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
        source_jobs: sourceJobsSchema,
      }),
    )
    .optional()
    .describe(`Only with \`model\`: the Model's ${recentRatingsShown} most recent Ratings, newest first, each with its Job's Source Jobs.`),
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
      `Only with \`model\`: the current Picks of up to ${recentPicksShown} Comparisons this Model took part in, most recently picked first, one entry per Job of this Model in them.`,
    ),
  parameter_schema: z
    .unknown()
    .optional()
    .describe("Only with `model`: the Provider's own description of the Model's parameters, when it publishes one."),
});

/** One Model as `list_models` reports it: what choosing it needs, or with `detailed`, its full evidence (ADR 0011). */
async function listedModel(
  deps: ModelInfoDeps,
  config: Config,
  model: Model,
  detailed: boolean,
  ratedJobs: RatedJob[],
  statusesOf: (model: StatusedModel) => OptionStatus[],
): Promise<z.input<typeof listedModelSchema>> {
  const base = {
    alias: model.alias,
    provider: model.provider,
    model_id: model.modelId,
    modality: model.modality,
    notes: model.notes,
    standing_options: model.standingOptions,
  };

  let described: {
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
        docsUrl: info.docsUrl,
        ...(info.guide === undefined ? {} : { guide: info.guide }),
      };
    } else {
      const info = await modelInfo(deps, { model, provider });
      described = {
        docsUrl: info.docsUrl,
        ...(info.parameterSchema === undefined ? {} : { parameterSchema: info.parameterSchema }),
        ...(info.guide === undefined ? {} : { guide: info.guide }),
      };
    }
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    return { ...base, problem: error.message };
  }

  const statuses = statusesOf(model);
  if (!detailed) return { ...base, parameters: parametersSummary(described, model.provider), option_statuses: optionStatusKeys(statuses) };

  const byId = new Map(ratedJobs.map(({ job }) => [job.id, job]));
  const ratings: RecentRating[] = await Promise.all(
    recentRatings(ratedJobs, model, recentRatingsShown).map(async (rated) => ({ ...rated, sources: await showSourceJobs(rated.job, byId) })),
  );
  const known = described.parameterSchema !== undefined || described.guide !== undefined;
  return {
    ...base,
    docs_url: described.docsUrl,
    ...(known ? {} : { parameters: parametersSummary(described, model.provider) }),
    option_statuses: optionStatusesOutput(statuses),
    recent_ratings: ratings.map(recentRatingOutput),
    recent_picks: recentPicks(ratedJobs, model, recentPicksShown).map(recentPickOutput),
    ...(described.parameterSchema !== undefined
      ? { parameter_schema: described.parameterSchema }
      : described.guide === undefined
        ? {}
        : { parameter_guide: guideOutput(described.guide) }),
  };
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

/** The `source_jobs` field of a Job's output, left out when it has none. */
function sourceJobsField(sources: ShownSourceJob[]) {
  if (sources.length === 0) return {};
  return {
    source_jobs: sources.map((source) => ({
      job_id: source.jobId,
      result: source.result,
      ...(source.model === undefined ? {} : { model: source.model }),
      file: source.file,
      deleted: source.deleted,
      ...(source.jobDeleted ? { job_deleted: true as const } : {}),
      reference: source.reference,
    })),
  };
}

/** A deletion report as `delete_jobs` gives it. */
function deletionOutput(report: DeletionReport) {
  return {
    deleted_jobs: report.deletedJobs,
    deleted_files: report.deletedFiles,
    already_gone: report.alreadyGone,
    skipped_files: report.skippedFiles.map(({ jobId, file, reason }) => ({ job_id: jobId, file, reason })),
    running_jobs: report.runningJobs,
    not_found: report.notFound,
    picks_removed: report.picksRemoved.map(({ comparison, jobId, result }) => ({
      comparison_id: comparison,
      job_id: jobId,
      ...(result === undefined ? {} : { result }),
    })),
    references_of_other_jobs: report.referencesOfOtherJobs.map(({ file, jobIds }) => ({ file, job_ids: jobIds })),
  };
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

/** A recent Rating with its Job's Source Jobs, so a chain of edits reads in order. */
type RecentRating = RatingWithJob & { sources: ShownSourceJob[] };

function recentRatingOutput({ rating, job, sources }: RecentRating) {
  return { ...ratingOutput(rating), prompt: promptStart(job.prompt), ...sourceJobsField(sources) };
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

/** Enough of a prompt, on one line, for the Agent to tell which Job a Rating is about. */
function promptStart(prompt: string): string {
  const line = prompt.replace(/\s+/g, " ").trim();
  return line.length <= promptStartLength ? line : `${line.slice(0, promptStartLength).trimEnd()}…`;
}

const statusLabels: Record<OptionStatusName, string> = {
  honoured: "Honoured",
  ignored: "Ignored",
  rejected: "Rejected",
  accepted: "Accepted",
};

/** What each status means, where `list_models` and a failed Job's error list them one per line. */
const statusGlosses: Partial<Record<OptionStatusName, string>> = { accepted: " (not rejected, effect unknown)" };

/** Option Statuses grouped as `list_models` gives them (ADR 0011). */
function optionStatusesOutput(statuses: OptionStatus[]) {
  const grouped = byStatus(statuses);
  return Object.fromEntries(
    optionStatusNames.map((name) => [
      name,
      grouped[name].map((status) => ({
        options: status.options,
        job_id: status.jobId,
        ...(status.jobDeleted ? { job_deleted: true as const } : {}),
        date: status.date,
        ...(status.reason === undefined ? {} : { reason: status.reason }),
      })),
    ]),
  );
}

/** The option keys under each status, e.g. `{ honoured: ["width+height"], accepted: ["seed"] }`. */
function optionStatusKeys(statuses: OptionStatus[]) {
  const grouped = byStatus(statuses);
  return Object.fromEntries(optionStatusNames.map((name) => [name, [...new Set(grouped[name].map((status) => Object.keys(status.options).join("+")))]]));
}

/** One Option Status per line, grouped by status, each with its date and Job id. */
function optionStatusesText(statuses: OptionStatus[]): string {
  if (statuses.length === 0) return "Option Statuses of the options sent: none recorded yet.";
  const grouped = byStatus(statuses);
  const lines = optionStatusNames.flatMap((name) =>
    grouped[name].map(
      (status) =>
        `- ${statusLabels[name]}${statusGlosses[name] ?? ""}: ${JSON.stringify(status.options)}, Job ${status.jobId}${status.jobDeleted ? " (deleted)" : ""} on ${status.date.slice(0, 10)}${status.reason === undefined ? "" : `: ${status.reason}`}`,
    ),
  );
  return ["Option Statuses of the options sent, from the latest evidence for each value:", ...lines].join("\n");
}

/** What the evidence of ended Jobs says about a Model's `provider_options` (ADR 0011, ADR 0015). */
async function modelStatuses(deps: Pick<ModelInfoDeps, "dirs">, model: StatusedModel): Promise<OptionStatus[]> {
  return (await optionStatusReader(deps.dirs))(model);
}

/**
 * What litevision knows about the parameters of the Model a Job ran on, read from the Job history: the docs link, the
 * built-in Parameter Guide and, where the Provider is still configured, its own description, which wins (ADR 0010).
 */
async function jobDocs(
  deps: ModelInfoDeps,
  jobId: string,
): Promise<{ known: ParameterKnowledge; provider: string; statuses: OptionStatus[]; sent: Record<string, unknown> } | undefined> {
  const job = await readJob(deps.dirs, jobId);
  const adapter = job === undefined ? undefined : adapterForProtocol(job.protocol);
  if (job === undefined || adapter === undefined) return undefined;
  const modality = job.modality ?? "image";
  const guide = adapter.parameterGuide?.(job.modelId, modality);
  let known: ParameterKnowledge = { docsUrl: adapter.docsUrl(job.modelId, modality), ...(guide === undefined ? {} : { guide }) };
  const provider = modality === "image" ? (await loadConfig(deps.dirs).catch(() => undefined))?.providers.find((candidate) => candidate.id === job.provider) : undefined;
  if (provider !== undefined) {
    const model = { alias: job.model, provider: job.provider, modelId: job.modelId, protocol: job.protocol, modality };
    known = await modelInfo(deps, { model, provider });
  }
  return { known, provider: job.provider, statuses: await modelStatuses(deps, job), sent: job.parameters.providerOptions };
}

/**
 * Where the Agent should look when a Provider rejected a request: the docs link, the Option Statuses of the options the
 * Job sent (ADR 0011), which already count this rejection, and for a rejected or unsupported request also what
 * litevision knows of the Model's parameters (ADR 0010).
 */
function failureHint(known: ParameterKnowledge, providerId: string, statuses: OptionStatus[], sent: Record<string, unknown>, kind: ProviderErrorKind): string {
  const help = kind === "rejected_option" || kind === "unsupported" ? `\n${parameterHelp(known, providerId)}` : "";
  const paths = optionPaths(sent);
  const ofSent = statuses.filter((status) => Object.keys(status.options).some((key) => paths.has(key)));
  return ` Docs for this Model's provider_options: ${known.docsUrl}.\n${optionStatusesText(ofSent)}${help}`;
}

/** Every key path in `options`, e.g. `response_format` and `response_format.image_size`, as Option Statuses name them. */
function optionPaths(options: Record<string, unknown>, prefix = ""): Set<string> {
  const paths = new Set<string>();
  for (const [key, value] of Object.entries(options)) {
    paths.add(`${prefix}${key}`);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      for (const inner of optionPaths(value as Record<string, unknown>, `${prefix}${key}.`)) paths.add(inner);
    }
  }
  return paths;
}

/** The structured form of what each saved file turned out to be. */
const observedSchema = z
  .array(z.object({ width: z.number(), height: z.number(), seconds: z.number().optional(), format: z.string().optional() }).nullable())
  .optional()
  .describe("What each saved file turned out to be, in the order of `files`, read from the file itself; null where litevision could not tell.");

/** What litevision checks a Job's result for, when it can read it from the request (ADR 0006). */
const checkedFacts = ["shape", "size", "format", "length"] as const;

const uncheckedSchema = z
  .array(z.enum(checkedFacts))
  .optional()
  .describe(
    "Present when litevision could not read from the request what the result should be, so did not check it: shape, size (in pixels), format or length (videos).",
  );

/** The `unchecked` field of a Job's output: what litevision could not read from the request, so did not check. */
function uncheckedOutput(requested: Requested) {
  const unread: Record<(typeof checkedFacts)[number], boolean> = {
    shape: requested.shape === null,
    // Absent on a Job recorded before litevision checked it, so unchecked too.
    size: requested.size == null,
    format: requested.format == null,
    // Only a video Job has a length.
    length: requested.seconds === null,
  };
  return { unchecked: checkedFacts.filter((fact) => unread[fact]) };
}

const mismatchSchema = z
  .string()
  .optional()
  .describe("Present when the result's shape, pixel size, length or file format differs from the request: how.");

const optionsSentSchema = z
  .object({
    standing: z.record(z.string(), z.unknown()).optional().describe("From the Model's Standing Options."),
    job: z.record(z.string(), z.unknown()).optional().describe("From this Job's own `provider_options`."),
  })
  .optional()
  .describe("The `provider_options` sent to the Provider, by where each came from; merged, they are exactly what was sent.");

const overridesSchema = z
  .array(
    z.object({
      option: z.string().describe("The option's path, e.g. quality or output.quality."),
      standing: z.unknown().describe("Its Standing Option value."),
      job: z.unknown().optional().describe("What this Job sent instead."),
      dropped: z.literal(true).optional().describe("True when this Job dropped it with `null`."),
    }),
  )
  .optional()
  .describe("Present when this Job replaced or dropped a Standing Option.");

/** The `options_sent` and `overrides` fields of a Job's output. */
function optionsOutput(sources: OptionSources) {
  return {
    options_sent: { standing: sources.standing, job: sources.job },
    overrides: sources.overrides.map(({ option, standing, job }) => ({ option, standing, ...(job === null ? { dropped: true as const } : { job }) })),
  };
}

/** What a Job sent, by source, and any Standing Option it overrode, e.g. " This Job overrode Standing Options: steps 28 → 40."; empty when it sent nothing. */
function optionsText({ standing, job, overrides }: OptionSources): string {
  const parts = [
    Object.keys(standing).length === 0 ? null : `${JSON.stringify(standing)} from Standing Options`,
    Object.keys(job).length === 0 ? null : `${JSON.stringify(job)} from this Job`,
  ].filter((part) => part !== null);
  const sent = parts.length === 0 ? "" : ` Sent ${parts.join(" and ")}.`;
  if (overrides.length === 0) return sent;
  const changed = overrides.map(({ option, standing, job }) => `${option} ${JSON.stringify(standing)} → ${job === null ? "dropped" : JSON.stringify(job)}`);
  return `${sent} This Job overrode Standing Options: ${changed.join(", ")}.`;
}

/** What a Job on `model` is made of, given the Agent's own `provider_options`, what it sends, and where each option came from. */
function optionsFor(model: Model, job: Record<string, unknown>) {
  const inputs: OptionInputs = { standing: model.standingOptions ?? {}, job };
  return { inputs, sent: mergeOptions(inputs.standing, job), split: optionSources(inputs) };
}

/** Where an ended or running Job's options came from, from its Job history record; undefined for Jobs recorded before. */
function recordedSources(record: JobRecord | undefined): OptionSources | undefined {
  const parameters = record?.parameters;
  return parameters?.jobOptions === undefined ? undefined : optionSources({ standing: parameters.standingOptions ?? {}, job: parameters.jobOptions });
}

const jobStatusSchema = z
  .enum(["completed", "running"])
  .describe('"running" when the Job outlasted the wait limit, or `wait` was false, and continues in the background.');

const waitSchema = z
  .boolean()
  .default(true)
  .describe(
    "false: start the Job and return its `job_id` at once; it runs in the background. Defaults to true: wait for the Job, up to two minutes.",
  );

/**
 * `references` is a flat list with no role per image: the prompt says what each is for, and litevision sends the prompt
 * verbatim (ADR 0010). So the order is the one thing litevision guarantees about them.
 */
function referencesSchema(purpose: string, caveat: string) {
  return z
    .array(z.string().min(1))
    .default([])
    .describe(
      `Local paths of reference images ${purpose}. Relative paths resolve against litevision's working directory. Sent to the Model in the order given, so the prompt can call them image 1, image 2, … and say what each is for. ${caveat}`,
    );
}

const kontextTakesFirst = "FLUX.1 Kontext on Together takes only the first.";

/** How a Job's own `provider_options` meet the Model's Standing Options, which every Job sends. */
const overStanding =
  "Merged over the Model's Standing Options, which every Job sends: your values win, objects merge key by key, and `null` drops a key. Add only what they lack, and override one only when the User asks.";

/** Why and how to start several Jobs at once, said once on each tool that starts one (ADR 0012). */
const severalJobs =
  "To make several at once, with different prompts, Models or options, start each Job with `wait: false`, then collect each with `get_job`: tool calls often run one after another even when sent together, and Jobs started this way run at the same time.";

/** The fields `generate_image`, `generate_video` and `get_job` share. */
function jobOutput(job: JobState) {
  return {
    job_id: job.id,
    status: job.status,
    model: job.model,
    ...(job.status === "completed"
      ? { files: job.files, observed: job.observed, shortfall: job.shortfall, mismatch: job.mismatch, ...(job.requested === undefined ? {} : uncheckedOutput(job.requested)) }
      : {}),
  };
}

function toolError(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

/**
 * A generation tool's error. When the Provider rejected the request or failed it for a reason it did not classify,
 * the error carries the Model's docs link and Option Statuses, so the Agent need not look them up (ADR 0011).
 */
async function failure(error: unknown, hint: Hint | undefined, split?: OptionSources) {
  const reason = await failureReason(error, hint, split);
  if (!(error instanceof JobFailedError)) return toolError(reason);
  return toolError(error.kind === "cancelled" ? `Job ${error.jobId}: ${reason}` : `Job ${error.jobId} failed: ${reason}`);
}

/** Whether a failed Job's options reached the Provider: it failed there, rather than being cancelled first. */
function reachedProvider(error: unknown): error is JobFailedError {
  return error instanceof JobFailedError && error.kind !== "cancelled";
}

/** What to add to a failed Job's error, given how it failed. */
type Hint = (kind: ProviderErrorKind) => Promise<string>;

/** Why a Job failed or could not start, safe to show the Agent, with the options it sent; any other error is rethrown. */
async function failureReason(error: unknown, hint: Hint | undefined, split?: OptionSources): Promise<string> {
  if (error instanceof ConfigError) return error.message;
  if (error instanceof JobFailedError) {
    const helpful = hint !== undefined && (error.kind === "unsupported" || error.kind === "rejected_option" || error.kind === "other");
    const sent = split === undefined || !reachedProvider(error) ? "" : optionsText(split);
    return `${error.message}${sent}${helpful ? await hint(error.kind) : ""}`;
  }
  throw error;
}

/** A Job checked and ready to start, and how to report it: shared by the single-Job tools and `generate_comparison`. */
interface PreparedJob {
  model: Model;
  /** Starts the Job; with `wait` false, returns it running at once. */
  start(how?: StartOptions & { comparison?: string }): Promise<JobState>;
  report(job: JobState): z.input<z.ZodObject<typeof imageJobShape>> & z.input<z.ZodObject<typeof videoJobShape>>;
  /** The Model's docs link, Option Statuses and Parameter Guide, for a failed Job's error (ADR 0010, ADR 0011). */
  hint: Hint;
  /** Where the options the Job sends came from. */
  optionSplit: OptionSources;
}

interface ImageArgs {
  prompt: string;
  n: number;
  references: string[];
  output_path?: string;
  name?: string;
  provider_options: Record<string, unknown>;
}

interface VideoArgs {
  prompt: string;
  first_frame?: string;
  last_frame?: string;
  references: string[];
  output_path?: string;
  name?: string;
  provider_options: Record<string, unknown>;
}

const imageJobShape = {
  job_id: z.string(),
  status: jobStatusSchema,
  model: z.string().describe("Alias of the Model that ran the Job."),
  files: z.array(z.string()).optional().describe("Paths of the saved images, once the Job has completed."),
  unchecked: uncheckedSchema,
  shortfall: z.string().optional().describe("Present when fewer images than `n` were saved: how many, and why."),
  observed: observedSchema,
  mismatch: mismatchSchema,
  options_sent: optionsSentSchema,
  overrides: overridesSchema,
};

const videoJobShape = {
  job_id: z.string(),
  status: jobStatusSchema,
  model: z.string().describe("Alias of the Model that ran the Job."),
  files: z.array(z.string()).optional().describe("Path of the saved video, once the Job has completed."),
  unchecked: uncheckedSchema,
  observed: observedSchema,
  mismatch: mismatchSchema,
  options_sent: optionsSentSchema,
  overrides: overridesSchema,
};

const failedJobSchema = z.object({
  job_id: z.string().optional().describe("Absent when the Job could not start."),
  status: z.literal("failed"),
  model: z.string().describe("Alias of the Model the Job ran on."),
  error: z.string().describe("Why the Job failed."),
  options_sent: optionsSentSchema.describe("Present when the request reached the Provider: the options it got, by where each came from."),
  overrides: overridesSchema,
});

/** The `name` parameter of the tools that start Jobs. */
function nameSchema(what: string, example: string, timeExample: string) {
  return z
    .string()
    .min(1)
    .optional()
    .describe(
      `What to name ${what}, in any language, e.g. the person or product it is for: "张三" saves ${example}. A name already taken in the folder gets -2, -3. Omit to name them after the time the Job started, e.g. ${timeExample}.`,
    );
}

/** The `name` the Agent gave, refused before the Job starts when no file could be named after it. */
function checkedName(name: string | undefined): string | undefined {
  if (name !== undefined && fileStem(name) === undefined) {
    throw new ConfigError(`\`name\` "${name}" has nothing a file name can hold once the characters a path cannot hold are removed. Give another, or omit it.`);
  }
  return name;
}

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

/** What `generate_comparison` returns. */
const comparisonOutput = {
    comparison_id: z.string(),
    modality: z.enum(modalities),
    jobs: z
      .array(z.union([z.object(imageJobShape), z.object(videoJobShape), failedJobSchema]))
      .describe(
        'One per variant, in the order given: each as `generate_image` or `generate_video` returns it, or status "failed" with why.',
      ),
  };

/** What `get_job` returns. */
const getJobOutput = {
    job_id: z.string(),
    status: jobStatusSchema,
    model: z.string().describe("Alias of the Model that ran the Job."),
    files: z.array(z.string()).optional().describe("Paths of the saved images or video, once the Job has completed."),
    shortfall: z.string().optional().describe("Present when fewer images than asked for were saved: how many, and why."),
    unchecked: uncheckedSchema,
    observed: observedSchema,
    mismatch: mismatchSchema,
    source_jobs: sourceJobsSchema,
    options_sent: optionsSentSchema,
    overrides: overridesSchema,
  };

/** What `cancel_job` returns. */
const cancelOutput = {
    job_id: z.string(),
    status: z
      .enum(["cancelled", "cancelling"])
      .describe('"cancelling" while the Runtime or another litevision session has yet to stop it.'),
    message: z.string(),
  };

/** What `delete_jobs` returns. */
const deletionReportOutput = {
    deleted_jobs: z.array(z.string()).optional(),
    deleted_files: z.array(z.string()).optional(),
    already_gone: z.array(z.string()).optional().describe("Result files that were no longer there, as when the User had deleted or moved them."),
    skipped_files: z
      .array(z.object({ job_id: z.string(), file: z.string(), reason: z.enum(skipReasonNames) }))
      .optional()
      .describe("Files left where they were: `content-changed` when the file is no longer what the Job saved, so the User may have edited it; `could-not-delete` when the system refused, e.g. for want of permission."),
    running_jobs: z.array(z.string()).optional().describe("Selected Jobs a litevision session is still running, left alone."),
    not_found: z.array(z.string()).optional().describe("Job or Comparison ids the Job history does not have."),
    picks_removed: z.array(z.object({ comparison_id: z.string(), job_id: z.string(), result: z.number().optional() })).optional(),
    references_of_other_jobs: z
      .array(z.object({ file: z.string(), job_ids: z.array(z.string()) }))
      .optional()
      .describe("Deleted files that remaining Jobs had used as a reference image or video frame."),
  };

/** What `rate_job` returns. */
const ratingOutputShape = {
    job_id: z.string(),
    result: z.number().optional().describe("The result rated; absent for a Rating of the whole Job."),
    verdict: z.enum(verdicts),
    reason: z.string().describe("The reason as recorded, on one line."),
    rated_at: z.string().describe("When the Rating was recorded, ISO 8601."),
  };

/** What `pick_result` returns. */
const pickOutputShape = {
    comparison_id: z.string(),
    job_id: z.string(),
    result: z.number().optional().describe("The result picked; absent when the Job was picked as a whole."),
    picked_at: z.string().describe("When the Pick was recorded, ISO 8601."),
  };

/** What `list_models` returns. */
const listModelsOutput = {
    default_model: z.string().optional().describe("Alias of the default image Model, used when `generate_image` gets no `model`."),
    default_video_model: z.string().optional().describe("Alias of the default video Model, used when `generate_video` gets no `model`."),
    models: z.array(listedModelSchema),
  };

/** What `update_model_notes` returns. */
const modelNotesOutput = {
    model: z.string(),
    notes: z.string().optional().describe("The Model Notes now; absent when there are none."),
    previous_notes: z.string().optional().describe("The Model Notes before this call; absent when there were none."),
    changed: z.boolean().describe("False when the text was already the Model Notes, so nothing was recorded."),
    changed_by: z.enum(changeAuthors).optional().describe("Who made the last change."),
    changed_at: z.string().optional().describe("When the last change was made, ISO 8601."),
  };

/** What `update_standing_options` returns. */
const standingOptionsOutput = {
    model: z.string(),
    standing_options: z.record(z.string(), z.unknown()).optional().describe("The Standing Options now; absent when there are none."),
    previous_standing_options: z.record(z.string(), z.unknown()).optional().describe("The Standing Options before this call; absent when there were none."),
    changed: z.boolean().describe("False when they already were these options, so nothing was recorded."),
    changed_by: z.enum(changeAuthors).optional().describe("Who made the last change."),
    changed_at: z.string().optional().describe("When the last change was made, ISO 8601."),
  };

/** What `open_settings` returns. */
const openSettingsOutput = {
    opened: z.literal(true).describe("The settings page is open in the User's browser."),
    tab: z.enum(settingsTabs).optional().describe("The tab it opened on, when one was asked for."),
  };

export function createServer(deps: ServerDeps): McpServer {
  const server = new McpServer({ name: "litevision", version }, { instructions });
  const now = deps.now ?? (() => new Date());
  const cwd = deps.cwd ?? process.cwd();
  const infoDeps: ModelInfoDeps = { dirs: deps.dirs, http: deps.http, now };
  const runtime = deps.runtime ?? new RuntimeManager({ dirs: deps.dirs, http: deps.http, catalog: deps.catalog ?? catalog, idleMs: deps.runtimeIdleMs });
  const jobs = new JobRunner({
    dirs: deps.dirs,
    http: deps.http,
    now,
    waitLimitMs: deps.waitLimitMs,
    pollIntervalMs: deps.pollIntervalMs,
    retryDelayMs: deps.retryDelayMs,
    runtime,
  });

  /** Checks an image Job against its Model before anything is sent, so a bad request starts no Job. */
  const prepareImage = async (resolved: ResolvedModel, args: ImageArgs): Promise<PreparedJob> => {
    const { model } = resolved;
    const adapter = adapterFor(model);
    const credential = await credentialFor(deps.dirs, resolved.provider, adapter);
    const info = await modelInfo(infoDeps, resolved);
    const options = optionsFor(model, args.provider_options);
    const normalised = await normaliseImageRequest(
      {
        prompt: args.prompt,
        n: args.n,
        references: args.references,
        providerOptions: options.sent,
      },
      model,
      adapter,
      cwd,
    );
    const outputDir = args.output_path === undefined ? undefined : resolve(cwd, args.output_path);
    const name = checkedName(args.name);
    return {
      model,
      optionSplit: options.split,
      start: ({ comparison, wait } = {}) =>
        jobs.start({ ...resolved, adapter, credential, normalised, outputDir, options: options.inputs, ...(name === undefined ? {} : { name }), ...(comparison === undefined ? {} : { comparison }) }, { wait }),
      hint: async (kind) => failureHint(info, model.provider, await modelStatuses(deps, model), options.sent, kind),
      report: (job) => ({ ...jobOutput(job), ...uncheckedOutput(normalised.requested), ...optionsOutput(options.split) }),
    };
  };

  /** Checks a video Job against its Model before anything is sent, so a bad request starts no Job. */
  const prepareVideo = async (resolved: ResolvedModel, args: VideoArgs): Promise<PreparedJob> => {
    const { model } = resolved;
    const adapter = adapterFor(model);
    const info = videoModelInfo(resolved);
    const credential = await credentialFor(deps.dirs, resolved.provider, adapter);
    const options = optionsFor(model, args.provider_options);
    const normalised = await normaliseVideoRequest(
      {
        prompt: args.prompt,
        ...(args.first_frame === undefined ? {} : { firstFrame: args.first_frame }),
        ...(args.last_frame === undefined ? {} : { lastFrame: args.last_frame }),
        references: args.references,
        providerOptions: options.sent,
      },
      model,
      adapter,
      cwd,
    );
    const outputDir = args.output_path === undefined ? undefined : resolve(cwd, args.output_path);
    const name = checkedName(args.name);
    return {
      model,
      optionSplit: options.split,
      start: ({ comparison, wait } = {}) =>
        jobs.startVideo({ ...resolved, adapter, credential, normalised, outputDir, options: options.inputs, ...(name === undefined ? {} : { name }), ...(comparison === undefined ? {} : { comparison }) }, { wait }),
      hint: async (kind) => failureHint(info, model.provider, await modelStatuses(deps, model), options.sent, kind),
      report: (job) => ({ ...jobOutput(job), ...uncheckedOutput(normalised.requested), ...optionsOutput(options.split) }),
    };
  };

  /** Runs one prepared Job on its own, as `generate_image` and `generate_video` do; with `wait` false, in the background. */
  const runSingle = async (wait: boolean, outputSchema: typeof imageJobShape | typeof videoJobShape, prepare: () => Promise<PreparedJob>) => {
    let prepared: PreparedJob | undefined;
    try {
      prepared = await prepare();
      return toolResult(outputSchema, prepared.report(await prepared.start({ wait })));
    } catch (error) {
      return failure(error, prepared?.hint, prepared?.optionSplit);
    }
  };

  server.registerTool(
    "generate_image",
    {
      description:
        `Generate images from a text prompt with one of the User's configured Models. Saves the images locally and returns their file paths; a Job still running continues in the background, and \`get_job\` collects it. ${severalJobs}`,
      // Strict, so a parameter that no longer exists (`aspect_ratio`, ADR 0010) is refused by name, not ignored.
      inputSchema: z.strictObject({
        prompt: z.string().min(1).describe("Sent to the Model verbatim."),
        model: z.string().optional().describe("Alias of the Model to use. Omit to use the default image Model."),
        n: z
          .number()
          .int()
          .positive()
          .default(1)
          .describe("How many images this Job brings back: sent as the Model's own count field, or as that many requests where it has none."),
        references: referencesSchema("to edit or draw on", kontextTakesFirst),
        output_path: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Folder to save the images in, e.g. the project's assets folder; created if missing. Relative paths resolve against litevision's working directory. Omit to save under a dated folder in the User's home directory.",
          ),
        name: nameSchema("the images", "张三.png; several images as 张三-1.png, 张三-2.png", "140500.png"),
        provider_options: z
          .record(z.string(), z.unknown())
          .default({})
          .describe(
            `The Model's own request fields, passed through untouched, e.g. { "size": "2048x1152" } for OpenAI: see its Parameter Guide in \`list_models\`. ${overStanding} Only the model id, prompt, reference image fields and response format are litevision's.`,
          ),
        wait: waitSchema,
      }),
      outputSchema: imageJobShape,
    },
    async ({ model: alias, wait, ...args }) => runSingle(wait, imageJobShape, async () => prepareImage(resolveModel(await loadConfig(deps.dirs), alias), args)),
  );

  server.registerTool(
    "generate_video",
    {
      description:
        `Generate one video from a text prompt with one of the User's configured video Models, optionally from a first and last frame or reference images. Saves the video locally and returns its file path. Videos often take minutes: a Job still running continues in the background, and \`get_job\` collects it. ${severalJobs}`,
      inputSchema: z.strictObject({
        prompt: z.string().min(1).describe("Sent to the Model verbatim. Describe motion and camera movement, not only the scene."),
        model: z.string().optional().describe("Alias of the video Model to use. Omit to use the default video Model."),
        first_frame: z.string().min(1).optional().describe("Local path of an image the video starts from."),
        last_frame: z.string().min(1).optional().describe("Local path of an image the video ends on."),
        references: referencesSchema("for characters, objects or style", "`first_frame` and `last_frame` are not among them."),
        output_path: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Folder to save the video in; created if missing. Relative paths resolve against litevision's working directory. Omit to save under a dated folder in the User's home directory.",
          ),
        name: nameSchema("the video", "张三.mp4", "140500.mp4"),
        provider_options: z
          .record(z.string(), z.unknown())
          .default({})
          .describe(
            `The Model's own request fields, passed through untouched, e.g. { "resolution": "1080P", "ratio": "9:16", "seconds": "10" } for Wan 2.7: see its Parameter Guide in \`list_models\`. ${overStanding} Only the model id, prompt and media fields are litevision's.`,
          ),
        wait: waitSchema,
      }),
      outputSchema: videoJobShape,
    },
    async ({ model: alias, wait, ...args }) => runSingle(wait, videoJobShape, async () => prepareVideo(resolveModel(await loadConfig(deps.dirs), alias, "video"), args)),
  );

  server.registerTool(
    "generate_comparison",
    {
      description: `Start a Comparison: 2 to ${maxComparisonVariants} Jobs together for one request, differing in prompt, in Model, or both, so the User can choose among their results. It costs as much as all its Jobs. All variants' Models must share one Modality. Saves each Job's files locally and returns them under one Comparison id; show the User every result. A Job still running continues in the background, and \`get_job\` collects it.`,
      inputSchema: z.strictObject({
        variants: z
          .array(
            z.strictObject({
              prompt: z.string().min(1).describe("Sent to this variant's Model verbatim."),
              model: z.string().optional().describe("Alias of this variant's Model. Omit to use the default Model of the Comparison's Modality."),
              n: z
                .number()
                .int()
                .positive()
                .optional()
                .describe("Image Comparisons only: how many images this variant's Job makes. Defaults to 1."),
              name: nameSchema("this variant's files", "张三.png or 张三.mp4", "140500.png or 140500.mp4"),
              provider_options: z
                .record(z.string(), z.unknown())
                .default({})
                .describe(`This variant's own request fields, in its Model's own names (see its Parameter Guide). ${overStanding}`),
            }),
          )
          .min(2)
          .max(maxComparisonVariants)
          .describe(`The Jobs to start, 2 to ${maxComparisonVariants}, one per variant.`),
        modality: z
          .enum(modalities)
          .optional()
          .describe("image or video. Omit to take it from the variants' Models; when no variant names one, image."),
        references: referencesSchema("every Job gets", kontextTakesFirst),
        output_path: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Folder to save every Job's files in; created if missing. Relative paths resolve against litevision's working directory. Omit to save under a dated folder in the User's home directory.",
          ),
      }),
      outputSchema: comparisonOutput,
    },
    async ({ variants, modality: wanted, references, output_path }) => {
      let prepared: PreparedJob[];
      let modality: Modality;
      try {
        const config = await loadConfig(deps.dirs);
        modality = comparisonModality(config, variants, wanted);
        if (modality === "video" && variants.some((variant) => (variant.n ?? 1) > 1)) {
          throw new ConfigError("A video Job makes one video, so leave `n` out of a video Comparison's variants.");
        }
        // Every variant is checked before any Job starts, so a bad one costs nothing.
        prepared = await Promise.all(
          variants.map((variant) => {
            const resolved = resolveModel(config, variant.model, modality);
            const shared = {
              prompt: variant.prompt,
              references,
              provider_options: variant.provider_options,
              ...(output_path === undefined ? {} : { output_path }),
              ...(variant.name === undefined ? {} : { name: variant.name }),
            };
            return modality === "video"
              ? prepareVideo(resolved, shared)
              : prepareImage(resolved, { ...shared, n: variant.n ?? 1 });
          }),
        );
      } catch (error) {
        return failure(error, undefined);
      }

      const comparisonId = randomUUID();
      const settled = await Promise.allSettled(prepared.map((job) => job.start({ comparison: comparisonId })));
      const results = await Promise.all(
        settled.map(async (outcome, index) => {
          const job = prepared[index]!;
          if (outcome.status === "fulfilled") return job.report(outcome.value);
          // Whatever stopped this Job, the others' results still go back to the Agent.
          const reason = await failureReason(outcome.reason, job.hint, job.optionSplit).catch(
            () => `litevision could not run this Job: ${(outcome.reason as Error).message}`,
          );
          const jobId = outcome.reason instanceof JobFailedError ? outcome.reason.jobId : undefined;
          return {
            job_id: jobId,
            status: "failed" as const,
            model: job.model.alias,
            error: reason,
            ...(reachedProvider(outcome.reason) ? optionsOutput(job.optionSplit) : {}),
          };
        }),
      );
      return toolResult(comparisonOutput, { comparison_id: comparisonId, modality, jobs: results });
    },
  );

  server.registerTool(
    "get_job",
    {
      description:
        "Get a Job's status, waiting up to two minutes while it runs; once it has completed, the paths of its saved images or video. Use it when `generate_image`, `generate_video` or `generate_comparison` returned a Job that is still running, as they do at once with `wait: false`.",
      inputSchema: {
        job_id: z.string().min(1).describe("The `job_id` that `generate_image`, `generate_video` or `generate_comparison` returned."),
      },
      outputSchema: getJobOutput,
    },
    async ({ job_id }) => {
      try {
        const job = await jobs.get(job_id);
        const history = await readJobs(deps.dirs);
        const record = history.find((candidate) => candidate.id === job_id);
        const sources = record === undefined ? [] : await showSourceJobs(record, new Map(history.map((known) => [known.id, known])));
        const optionSplit = recordedSources(record);
        return toolResult(getJobOutput, { ...jobOutput(job), ...sourceJobsField(sources), ...(optionSplit === undefined ? {} : optionsOutput(optionSplit)) });
      } catch (error) {
        // A video often outlasts `generate_video`'s wait, so its rejection may first reach the Agent here.
        const record = await readJob(deps.dirs, job_id).catch(() => undefined);
        return failure(
          error,
          async (kind) => {
            const docs = await jobDocs(infoDeps, job_id);
            return docs === undefined ? "" : failureHint(docs.known, docs.provider, docs.statuses, docs.sent, kind);
          },
          recordedSources(record),
        );
      }
    },
  );

  server.registerTool(
    "cancel_job",
    {
      description:
        "Cancel a running Job the User no longer wants, such as a long local one. On a local Model the Runtime stops it at its next step and keeps the Model loaded; a Job still waiting for its turn never starts. On a cloud Model litevision only stops waiting: the Provider may still finish the Job and bill for it. While it is `cancelling`, `get_job` shows it end.",
      inputSchema: {
        job_id: z.string().min(1).describe("The `job_id` that `generate_image`, `generate_video` or `generate_comparison` returned."),
      },
      outputSchema: cancelOutput,
    },
    async ({ job_id }) => {
      try {
        const outcome = await jobs.cancel(job_id);
        return toolResult(cancelOutput, { job_id, ...outcome });
      } catch (error) {
        return failure(error, undefined);
      }
    },
  );

  server.registerTool(
    "delete_jobs",
    {
      description:
        "Delete Jobs from the User's Job history for good, with no undo: their records, Ratings and Picks, and the image and video files they saved. Reference images are never deleted, nor are folders named with `output_path`. Give exactly one of `job_ids`, `comparison_ids` or `all`. A Job a litevision session is still running is left alone: cancel it first. A Job whose session ended before it finished is interrupted, and is deleted like any other. What litevision learnt about each Model's `provider_options` is kept. Tell the User what the report says was skipped and why.",
      inputSchema: {
        job_ids: z.array(z.string().min(1)).min(1).optional().describe("The Jobs to delete."),
        comparison_ids: z.array(z.string().min(1)).min(1).optional().describe("Comparisons to delete with all their Jobs."),
        all: z.literal(true).optional().describe("Delete every Job in the Job history."),
      },
      outputSchema: deletionReportOutput,
    },
    async ({ job_ids, comparison_ids, all }) => {
      const given = [job_ids, comparison_ids, all].filter((selector) => selector !== undefined).length;
      if (given !== 1) {
        return toolError(`Give exactly one of \`job_ids\`, \`comparison_ids\` or \`all: true\`; ${given === 0 ? "none was" : `${given} were`} given. Nothing was deleted.`);
      }
      const report = await deleteJobs(
        deps.dirs,
        job_ids !== undefined ? { jobIds: job_ids } : comparison_ids !== undefined ? { comparisonIds: comparison_ids } : { all: true },
      );
      return toolResult(deletionReportOutput, deletionOutput(report));
    },
  );

  server.registerTool(
    "rate_job",
    {
      description:
        "Record the User's Rating of a completed Job, or of one result of it: their own verdict, good or bad, plus a one-line reason in their words. Never invent a verdict or rate a result yourself. A later Rating of the same Job and result replaces the earlier one; a Rating of the whole Job and one of a single result stand side by side.",
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
      outputSchema: ratingOutputShape,
    },
    async ({ job_id, result, verdict, reason }) => {
      try {
        const rating = await rateJob(deps.dirs, { jobId: job_id, result, verdict, reason }, now());
        return toolResult(ratingOutputShape, ratingOutput(rating));
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
        "Record the User's Pick within a Comparison: the Job, or the one result of it, the User chose among the Comparison's results. Never pick for them. A later Pick for the same Comparison replaces the earlier one. A Pick is a relative preference, not a Rating: when the User also gives a verdict, call `rate_job` too.",
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
      outputSchema: pickOutputShape,
    },
    async ({ comparison_id, job_id, result }) => {
      try {
        const pick = await pickResult(deps.dirs, { comparison: comparison_id, jobId: job_id, result }, now());
        return toolResult(pickOutputShape, pickOutput(pick));
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
        "List the User's configured Models, to choose one by what it accepts and costs: each Model's Alias, Modality (image or video), model id, Provider, Model Notes, Standing Options, a summary of its Parameter Guide and the `provider_options` keys under each Option Status, and the default Model of each Modality. Pass `model` for one Model in detail: its docs link, full Parameter Guide (or the Provider's own parameter schema, which wins), each Option Status with its value, Job, date and reason, its five most recent Ratings and the Picks of up to five Comparisons it took part in. An Option Status is what the latest evidence shows of a value sent, from facts alone: Honoured, the result was checked and matched; Ignored, it was checked and did not match; Rejected, the Provider's error named it; Accepted, the Provider did not reject it, but nothing checks its effect. Providers change their rules, so read the docs first when a date is old.",
      inputSchema: {
        model: z.string().optional().describe("Alias of one Model to describe in detail. Omit to list every Model."),
      },
      outputSchema: listModelsOutput,
    },
    async ({ model: alias }) => {
      try {
        const config = await loadConfig(deps.dirs);
        if (config.models.length === 0) throw needsSettings("litevision has no Model configured yet.");
        const defaultModel = defaultModelAlias(config, "image");
        const defaultVideoModel = defaultModelAlias(config, "video");
        let models = config.models;
        if (alias !== undefined) {
          models = models.filter((model) => model.alias === alias);
          if (models.length === 0) {
            throw new ConfigError(`Unknown Model Alias "${alias}". Known Aliases: ${config.models.map((model) => model.alias).join(", ")}.`);
          }
        }
        const ratedJobs = await readRatedJobs(deps.dirs);
        const statusesOf = await optionStatusReader(deps.dirs);
        const detailed = alias !== undefined;
        const entries = await Promise.all(models.map((model) => listedModel(infoDeps, config, model, detailed, ratedJobs, statusesOf)));
        return toolResult(listModelsOutput, { ...(detailed ? {} : { default_model: defaultModel, default_video_model: defaultVideoModel }), models: entries });
      } catch (error) {
        if (error instanceof ConfigError) return toolError(error.message);
        throw error;
      }
    },
  );

  server.registerTool(
    "update_model_notes",
    {
      description: `Replace a Model's Notes with new text, whole: never append. Before calling it, show the User the old and new Model Notes. At most ${modelNotesMaxLength} characters. The previous version is kept, and the User can undo the change in the settings page.`,
      inputSchema: {
        model: z.string().min(1).describe("Alias of the Model."),
        notes: z
          .string()
          .describe(`The complete new Model Notes the User agreed to, at most ${modelNotesMaxLength} characters. An empty string clears them.`),
      },
      outputSchema: modelNotesOutput,
    },
    async ({ model, notes }) => {
      try {
        const change = await updateNotesAsAgent(deps.dirs, model, notes, now());
        return toolResult(modelNotesOutput, {
          model,
          notes: change.notes,
          previous_notes: change.previous,
          changed: change.changed,
          changed_by: change.history?.changedBy,
          changed_at: change.history?.changedAt,
        });
      } catch (error) {
        if (error instanceof ConfigError) return toolError(error.message);
        throw error;
      }
    },
  );

  server.registerTool(
    "update_standing_options",
    {
      description:
        "Replace a Model's Standing Options, whole, as when the User wants a value on every Job of it: the request fields every Job on it sends, under each Job's `provider_options`. Before calling it, show the User the old and new Standing Options. Write the Model's own fields from its Parameter Guide; fields litevision fills itself are refused. The previous version is kept, and the User can undo the change in the settings page.",
      inputSchema: {
        model: z.string().min(1).describe("Alias of the Model."),
        standing_options: z
          .record(z.string(), z.unknown())
          .describe('The complete new Standing Options the User agreed to, such as { "size": "1024x1024" }. {} clears them.'),
      },
      outputSchema: standingOptionsOutput,
    },
    async ({ model, standing_options }) => {
      try {
        const change = await updateStandingOptionsAsAgent(deps.dirs, model, standing_options, now());
        return toolResult(standingOptionsOutput, {
          model,
          standing_options: change.standingOptions,
          previous_standing_options: change.previous,
          changed: change.changed,
          changed_by: change.history?.changedBy,
          changed_at: change.history?.changedAt,
        });
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
    void runtime.stop();
    void settings.close();
  };

  server.registerTool(
    "open_settings",
    {
      description:
        "Open litevision's settings page in the User's browser, where the User adds Providers, enters Credentials and sets up Models, and reviews, rates and deletes past Jobs. Then ask the User to finish there and tell you when they are done.",
      inputSchema: {
        tab: z
          .enum(settingsTabs)
          .optional()
          .describe("The tab to open: `providers`, `models` or `history` (the Job history). Omit to open the page as it opens by default."),
      },
      outputSchema: openSettingsOutput,
    },
    async ({ tab }) => {
      try {
        await settings.open(tab);
      } catch {
        // The page URL carries the one-time token, so it is never given to the Agent.
        return toolError(
          "Could not open the User's browser. Ask the User to run `litevision settings` in a terminal, which opens the settings page and prints its address.",
        );
      }
      return toolResult(openSettingsOutput, { opened: true, tab });
    },
  );

  return server;
}
