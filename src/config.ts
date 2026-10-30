import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Dirs } from "./dirs.ts";

const providerSchema = z.object({
  id: z.string().min(1),
  baseUrl: z.string().url(),
});

const modelSchema = z.object({
  alias: z.string().min(1),
  provider: z.string().min(1),
  modelId: z.string().min(1),
  protocol: z.string().min(1),
});

const configSchema = z.object({
  providers: z.array(providerSchema).default([]),
  models: z.array(modelSchema).default([]),
  defaultImageModel: z.string().optional(),
});

const credentialsSchema = z.record(z.string(), z.object({ apiKey: z.string().min(1) }));

export type Provider = z.infer<typeof providerSchema>;
export type Model = z.infer<typeof modelSchema>;
export type Config = z.infer<typeof configSchema>;

/** A problem the Agent should relay to the User; its message is safe to show. */
export class ConfigError extends Error {}

/** A configuration problem only the User can fix, in the settings page. */
function needsSettings(problem: string): ConfigError {
  return new ConfigError(
    `${problem} Call \`open_settings\` so the User can fix this in their browser. Never ask the User for an API key or any other Credential in the conversation.`,
  );
}

async function readJson(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw needsSettings(`${path} is not valid JSON.`);
  }
}

export async function loadConfig(dirs: Dirs): Promise<Config> {
  const path = join(dirs.config, "config.json");
  const parsed = configSchema.safeParse((await readJson(path)) ?? {});
  if (!parsed.success) {
    throw needsSettings(`${path} is invalid: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

/** Reads one Provider's Credential. Never include the returned value in anything shown to the Agent. */
export async function requireCredential(dirs: Dirs, provider: Provider): Promise<string> {
  // Only the shape is validated here, so a malformed file never echoes its contents in an error.
  const parsed = credentialsSchema.safeParse((await readJson(join(dirs.config, "credentials.json"))) ?? {});
  if (!parsed.success) throw needsSettings("credentials.json is malformed.");
  const credential = parsed.data[provider.id]?.apiKey;
  if (credential === undefined) throw needsSettings(`Provider "${provider.id}" has no Credential saved.`);
  return credential;
}

export interface ResolvedModel {
  model: Model;
  provider: Provider;
}

/** Picks the Model for a Job: the named Alias, else the default image Model. */
export function resolveModel(config: Config, alias: string | undefined): ResolvedModel {
  if (config.models.length === 0) throw needsSettings("litevision has no image Model configured yet.");

  const known = config.models.map((model) => model.alias).join(", ");
  const wanted = alias ?? config.defaultImageModel;
  if (wanted === undefined) {
    throw needsSettings(`No default image Model is set. Pass \`model\` with one of: ${known}. Or:`);
  }
  const model = config.models.find((candidate) => candidate.alias === wanted);
  if (model === undefined) {
    if (alias === undefined) throw needsSettings(`The default image Model "${wanted}" does not exist. Known Aliases: ${known}.`);
    throw new ConfigError(`Unknown Model Alias "${wanted}". Known Aliases: ${known}.`);
  }
  const provider = config.providers.find((candidate) => candidate.id === model.provider);
  if (provider === undefined) {
    throw needsSettings(`Model "${model.alias}" refers to Provider "${model.provider}", which is not configured.`);
  }
  return { model, provider };
}
