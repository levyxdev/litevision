import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ConfigError,
  defaultModelAlias,
  loadConfig,
  needsSettings,
  requireCredential,
  resolveModel,
  type Config,
  type Model,
} from "./config.ts";
import type { Dirs } from "./dirs.ts";
import { knownGoodOptions, readJobs } from "./history.ts";
import type { HttpTransport } from "./http.ts";
import { JobFailedError, runJob } from "./jobs.ts";
import { modelInfo, type ModelInfoDeps } from "./model-info.ts";
import { describeCapabilities, normaliseImageRequest } from "./protocols/capabilities.ts";
import { adapterFor } from "./protocols/index.ts";
import { aspectRatios, formatSize } from "./protocols/protocol.ts";
import { openInBrowser, type OpenBrowser } from "./settings/browser.ts";
import { settingsOpener } from "./settings/opener.ts";
import { defaultSettingsIdleMs } from "./settings/server.ts";

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
}

export const instructions = `litevision generates images through Models the User has configured with their own Providers.

- Use the Model the User names (pass its Alias as \`model\`).
- When the User names none, omit \`model\` to use the default image Model, unless the request needs something the default lacks (e.g. legible Chinese text, reference images, an aspect ratio). Then call \`list_models\` and choose by each Model's capabilities and Model Notes.
- Never ask the User for an API key or any other Credential. If litevision reports that nothing is configured, call \`open_settings\` so the User can set it up in their browser.
- \`generate_image\` returns file paths, not image data. Tell the User where the files are.
- Ask for an aspect ratio, not pixel sizes. If the Model does not support it, the closest supported one is used; when the result says it was adjusted, tell the User the actual size.
- If \`generate_image\` says a Model cannot do something (reference images, that many images), the error lists what the Model supports: choose another Model or change the request.
- Pass \`output_path\` when the images belong in the User's project (e.g. its assets folder); otherwise omit it.
- For Provider-specific \`provider_options\`, call \`list_models\` with \`model\` first: it gives the Model's docs link, the Provider's parameter schema when it publishes one, and options that already worked for this Model. litevision passes \`provider_options\` through unchecked; if the Provider rejects one, its error says why, so fix it and try again.
- If fewer images came back than you asked for, the result says why. Tell the User.`;

/** The structured form of one Model in `list_models`. */
const listedModelSchema = z.object({
  alias: z.string(),
  provider: z.string(),
  protocol: z.string(),
  model_id: z.string().describe("The Provider's own name for the model."),
  default: z.boolean(),
  notes: z.string().describe("Model Notes: what the Model is good or bad at, agreed with the User."),
  capabilities: z
    .object({
      aspect_ratios: z.array(z.object({ aspect_ratio: z.enum(aspectRatios), size: z.string() })),
      reference_images: z.boolean(),
      max_reference_images: z.number(),
      max_images_per_job: z.number(),
    })
    .nullable()
    .describe("Null when the Model cannot be used; `problem` then says why."),
  docs_url: z.string().nullable().describe("Where to read which `provider_options` this Model accepts."),
  problem: z.string().optional(),
  parameter_schema: z
    .unknown()
    .optional()
    .describe("Only with `model`: the Provider's own description of the Model's parameters, when it publishes one."),
  known_good_options: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Only with `model`: `provider_options` that completed Jobs on this Model have sent, with the latest value of each."),
});

/** One Model as `list_models` reports it, as structured output and as a line of text; `detailed` adds what only `model` asks for. */
async function listedModel(deps: ModelInfoDeps, config: Config, model: Model, isDefault: boolean, detailed: boolean) {
  const base = {
    alias: model.alias,
    provider: model.provider,
    protocol: model.protocol,
    model_id: model.modelId,
    default: isDefault,
    notes: model.notes ?? "",
  };
  const heading = `${model.alias}${isDefault ? " (default)" : ""}: ${model.modelId} on ${model.provider} via ${model.protocol}.`;
  const notes = model.notes ? ` Notes: ${model.notes}` : "";

  let info;
  try {
    const provider = config.providers.find((candidate) => candidate.id === model.provider);
    if (provider === undefined) throw needsSettings(`Model "${model.alias}" refers to Provider "${model.provider}", which is not configured.`);
    info = await modelInfo(deps, { model, provider });
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    return {
      output: { ...base, capabilities: null, docs_url: null, problem: error.message },
      text: `${heading} Cannot be used: ${error.message}${notes}`,
    };
  }
  const { capabilities } = info;
  const output: z.infer<typeof listedModelSchema> = {
    ...base,
    capabilities: {
      aspect_ratios: capabilities.sizes.map((size) => ({ aspect_ratio: size.aspectRatio, size: formatSize(size) })),
      reference_images: capabilities.maxReferences > 0,
      max_reference_images: capabilities.maxReferences,
      max_images_per_job: capabilities.maxImages,
    },
    docs_url: info.docsUrl,
  };
  let text = `${heading} Supports ${describeCapabilities(capabilities)}${notes} provider_options: ${info.docsUrl}`;
  if (detailed) {
    const knownGood = knownGoodOptions(await readJobs(deps.dirs), { provider: model.provider, protocol: model.protocol, modelId: model.modelId });
    output.known_good_options = knownGood;
    text += `\nKnown-good provider_options: ${Object.keys(knownGood).length === 0 ? "none recorded yet" : JSON.stringify(knownGood)}`;
    if (info.parameterSchema !== undefined) {
      output.parameter_schema = info.parameterSchema;
      text += `\nParameter schema from the Provider: ${JSON.stringify(info.parameterSchema)}`;
    }
  }
  return { output, text };
}

function toolError(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

export function createServer(deps: ServerDeps): McpServer {
  const server = new McpServer({ name: "litevision", version: "0.0.0" }, { instructions });
  const now = deps.now ?? (() => new Date());
  const cwd = deps.cwd ?? process.cwd();
  const infoDeps: ModelInfoDeps = { dirs: deps.dirs, http: deps.http, now };

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
        model: z.string().describe("Alias of the Model that ran the Job."),
        files: z.array(z.string()).describe("Paths of the saved images."),
        aspect_ratio: z.enum(aspectRatios).describe("Aspect ratio actually used."),
        size: z.string().describe("Size actually requested from the Provider, e.g. 1536x1024."),
        requested_aspect_ratio: z.enum(aspectRatios),
        aspect_ratio_adjusted: z
          .boolean()
          .describe("True when the Model does not support the requested aspect ratio and the closest one was used."),
        shortfall: z.string().optional().describe("Present when fewer images than `n` were saved: how many, and why."),
      },
    },
    async ({ prompt, model: alias, n, aspect_ratio, references, output_path, provider_options }) => {
      try {
        const resolved = resolveModel(await loadConfig(deps.dirs), alias);
        const { model } = resolved;
        const adapter = adapterFor(model);
        const credential = await requireCredential(deps.dirs, resolved.provider);
        const { capabilities } = await modelInfo(infoDeps, resolved);
        const normalised = await normaliseImageRequest(
          { prompt, n, aspectRatio: aspect_ratio, references, providerOptions: provider_options },
          model,
          adapter,
          capabilities,
          cwd,
        );

        const outputDir = output_path === undefined ? undefined : resolve(cwd, output_path);
        const job = await runJob(
          { dirs: deps.dirs, http: deps.http, now },
          { ...resolved, adapter, credential, normalised, outputDir },
        );
        const { size } = normalised.request;
        const output = {
          job_id: job.id,
          model: model.alias,
          files: job.files,
          aspect_ratio: size.aspectRatio,
          size: formatSize(size),
          requested_aspect_ratio: normalised.requestedAspectRatio,
          aspect_ratio_adjusted: normalised.aspectRatioAdjusted,
          ...(job.shortfall === undefined ? {} : { shortfall: job.shortfall }),
        };
        const shortfall = job.shortfall === undefined ? "" : ` ${job.shortfall}`;
        const adjustment = normalised.aspectRatioAdjusted
          ? ` ${model.alias} does not support ${normalised.requestedAspectRatio}, so the closest supported aspect ratio was used.`
          : "";
        const text = `Saved ${job.files.length} image(s) from ${model.alias} at ${size.aspectRatio} (${formatSize(size)}), Job ${job.id}.${adjustment}${shortfall}\n${job.files.join("\n")}`;
        return { content: [{ type: "text", text }], structuredContent: output };
      } catch (error) {
        if (error instanceof ConfigError) return toolError(error.message);
        if (error instanceof JobFailedError) return toolError(`Job ${error.jobId} failed: ${error.message}`);
        throw error;
      }
    },
  );

  server.registerTool(
    "list_models",
    {
      description:
        "List the User's configured image Models: Alias, Provider, Protocol, capabilities, Model Notes and a docs link for `provider_options`, and which one is the default. Use it to choose a Model when the request needs something the default may lack. Pass `model` for one Model in detail, with the Provider's parameter schema and the `provider_options` known to work.",
      inputSchema: {
        model: z.string().optional().describe("Alias of one Model to describe in detail. Omit to list every Model."),
      },
      outputSchema: {
        default_model: z.string().nullable().describe("Alias of the default image Model, used when `generate_image` gets no `model`."),
        models: z.array(listedModelSchema),
      },
    },
    async ({ model: alias }) => {
      try {
        const config = await loadConfig(deps.dirs);
        if (config.models.length === 0) throw needsSettings("litevision has no image Model configured yet.");
        const defaultModel = defaultModelAlias(config) ?? null;
        let models = config.models;
        if (alias !== undefined) {
          models = models.filter((model) => model.alias === alias);
          if (models.length === 0) {
            throw new ConfigError(`Unknown Model Alias "${alias}". Known Aliases: ${config.models.map((model) => model.alias).join(", ")}.`);
          }
        }
        const entries = await Promise.all(
          models.map((model) => listedModel(infoDeps, config, model, model.alias === defaultModel, alias !== undefined)),
        );
        const text = entries.map((entry) => entry.text).join("\n");
        return {
          content: [{ type: "text", text }],
          structuredContent: { default_model: defaultModel, models: entries.map((entry) => entry.output) },
        };
      } catch (error) {
        if (error instanceof ConfigError) return toolError(error.message);
        throw error;
      }
    },
  );

  const settings = settingsOpener({
    dirs: deps.dirs,
    http: deps.http,
    idleMs: deps.settingsIdleMs ?? defaultSettingsIdleMs,
    openBrowser: deps.openBrowser ?? openInBrowser,
  });
  server.server.onclose = () => void settings.close();

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
