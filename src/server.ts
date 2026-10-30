import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ConfigError, loadConfig, requireCredential, resolveModel } from "./config.ts";
import type { Dirs } from "./dirs.ts";
import type { HttpTransport } from "./http.ts";
import { JobFailedError, runJob } from "./jobs.ts";
import { adapterFor } from "./protocols/index.ts";

export interface ServerDeps {
  dirs: Dirs;
  http: HttpTransport;
  now?: () => Date;
}

export const instructions = `litevision generates images through Models the User has configured with their own Providers.

- Use the Model the User names (pass its Alias as \`model\`); otherwise omit \`model\` to use the default image Model.
- Never ask the User for an API key or any other Credential. If litevision reports that nothing is configured, call \`open_settings\` so the User can set it up in their browser.
- \`generate_image\` returns file paths, not image data. Tell the User where the files are.`;

function toolError(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

export function createServer(deps: ServerDeps): McpServer {
  const server = new McpServer({ name: "litevision", version: "0.0.0" }, { instructions });
  const now = deps.now ?? (() => new Date());

  server.registerTool(
    "generate_image",
    {
      description:
        "Generate images from a text prompt with one of the User's configured Models. Saves the images locally and returns their file paths.",
      inputSchema: {
        prompt: z.string().min(1).describe("Sent to the Model verbatim."),
        model: z.string().optional().describe("Alias of the Model to use. Omit to use the default image Model."),
      },
      outputSchema: {
        job_id: z.string(),
        model: z.string().describe("Alias of the Model that ran the Job."),
        files: z.array(z.string()).describe("Paths of the saved images."),
      },
    },
    async ({ prompt, model: alias }) => {
      try {
        const resolved = resolveModel(await loadConfig(deps.dirs), alias);
        const { model } = resolved;
        const adapter = adapterFor(model);
        const credential = await requireCredential(deps.dirs, resolved.provider);

        const job = await runJob(
          { dirs: deps.dirs, http: deps.http, now },
          { ...resolved, adapter, credential, request: { prompt, n: 1 } },
        );
        const output = { job_id: job.id, model: model.alias, files: job.files };
        const text = `Saved ${job.files.length} image(s) from ${model.alias} (Job ${job.id}):\n${job.files.join("\n")}`;
        return { content: [{ type: "text", text }], structuredContent: output };
      } catch (error) {
        if (error instanceof ConfigError) return toolError(error.message);
        if (error instanceof JobFailedError) return toolError(`Job ${error.jobId} failed: ${error.message}`);
        throw error;
      }
    },
  );

  return server;
}
