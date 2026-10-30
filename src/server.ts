import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ConfigError, loadConfig, requireCredential, resolveModel } from "./config.ts";
import type { Dirs } from "./dirs.ts";
import type { HttpTransport } from "./http.ts";
import { JobFailedError, runJob } from "./jobs.ts";
import { normaliseImageRequest } from "./protocols/capabilities.ts";
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

- Use the Model the User names (pass its Alias as \`model\`); otherwise omit \`model\` to use the default image Model.
- Never ask the User for an API key or any other Credential. If litevision reports that nothing is configured, call \`open_settings\` so the User can set it up in their browser.
- \`generate_image\` returns file paths, not image data. Tell the User where the files are.
- Ask for an aspect ratio, not pixel sizes. If the Model does not support it, the closest supported one is used; when the result says it was adjusted, tell the User the actual size.
- If \`generate_image\` says a Model cannot do something (reference images, that many images), the error lists what the Model supports: choose another Model or change the request.
- Pass \`output_path\` when the images belong in the User's project (e.g. its assets folder); otherwise omit it.`;

function toolError(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

export function createServer(deps: ServerDeps): McpServer {
  const server = new McpServer({ name: "litevision", version: "0.0.0" }, { instructions });
  const now = deps.now ?? (() => new Date());
  const cwd = deps.cwd ?? process.cwd();

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
      },
    },
    async ({ prompt, model: alias, n, aspect_ratio, references, output_path, provider_options }) => {
      try {
        const resolved = resolveModel(await loadConfig(deps.dirs), alias);
        const { model } = resolved;
        const adapter = adapterFor(model);
        const credential = await requireCredential(deps.dirs, resolved.provider);
        const normalised = await normaliseImageRequest(
          { prompt, n, aspectRatio: aspect_ratio, references, providerOptions: provider_options },
          model,
          adapter,
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
        };
        const adjustment = normalised.aspectRatioAdjusted
          ? ` ${model.alias} does not support ${normalised.requestedAspectRatio}, so the closest supported aspect ratio was used.`
          : "";
        const text = `Saved ${job.files.length} image(s) from ${model.alias} at ${size.aspectRatio} (${formatSize(size)}), Job ${job.id}.${adjustment}\n${job.files.join("\n")}`;
        return { content: [{ type: "text", text }], structuredContent: output };
      } catch (error) {
        if (error instanceof ConfigError) return toolError(error.message);
        if (error instanceof JobFailedError) return toolError(`Job ${error.jobId} failed: ${error.message}`);
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
