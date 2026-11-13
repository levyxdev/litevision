import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Dirs } from "./dirs.ts";
import { modalities, type Modality } from "./protocols/protocol.ts";

export const providerSchema = z.object({
  id: z.string().min(1),
  baseUrl: z.string().url(),
});

/** Model Notes stay short so `list_models` costs the Agent little context. */
export const modelNotesMaxLength = 300;

/** Who changed Model Notes: the User (in the settings page) or the Agent (with `update_model_notes`). */
export const notesAuthors = ["User", "Agent"] as const;
export type NotesAuthor = (typeof notesAuthors)[number];

/** The last change to a Model's Notes, and the one previous version it replaced. */
export const notesHistorySchema = z.object({
  changedBy: z.enum(notesAuthors),
  /** ISO 8601. */
  changedAt: z.string(),
  /** The Model Notes before the last change; `""` when there were none. Absent when there is nothing to undo to. */
  previous: z.string().optional(),
});

export type NotesHistory = z.infer<typeof notesHistorySchema>;

export const modelSchema = z.object({
  alias: z.string().min(1),
  provider: z.string().min(1),
  modelId: z.string().min(1),
  protocol: z.string().min(1),
  /** What the Model generates (ADR 0005); Models saved before videos existed are image Models. */
  modality: z.enum(modalities).default("image"),
  notes: z.string().optional(),
  notesHistory: notesHistorySchema.optional(),
  /** Standing Options (ADR 0010): request fields every Job on the Model sends, under the Agent's `provider_options`. */
  standingOptions: z.record(z.string(), z.unknown()).optional(),
});

const configSchema = z.object({
  providers: z.array(providerSchema).default([]),
  models: z.array(modelSchema).default([]),
  defaultImageModel: z.string().optional(),
  defaultVideoModel: z.string().optional(),
});

export const credentialsSchema = z.record(z.string(), z.object({ apiKey: z.string().min(1) }));

export type Provider = z.infer<typeof providerSchema>;
export type Model = z.infer<typeof modelSchema>;
export type Config = z.infer<typeof configSchema>;

/** A problem the Agent should relay to the User; its message is safe to show. */
export class ConfigError extends Error {}

/** A configuration problem only the User can fix, in the settings page. */
export function needsSettings(problem: string): ConfigError {
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
  const path = join(dirs.home, "config.json");
  const parsed = configSchema.safeParse((await readJson(path)) ?? {});
  if (!parsed.success) {
    throw needsSettings(`${path} is invalid: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

/** Reads one Provider's Credential. Never include the returned value in anything shown to the Agent. */
export async function requireCredential(dirs: Dirs, provider: Provider): Promise<string> {
  // Only the shape is validated here, so a malformed file never echoes its contents in an error.
  const parsed = credentialsSchema.safeParse((await readJson(join(dirs.home, "credentials.json"))) ?? {});
  if (!parsed.success) throw needsSettings("credentials.json is malformed.");
  const credential = parsed.data[provider.id]?.apiKey;
  if (credential === undefined) throw needsSettings(`Provider "${provider.id}" has no Credential saved.`);
  return credential;
}

export interface ResolvedModel {
  model: Model;
  provider: Provider;
}

/** Where the Config keeps each Modality's default Model. */
export const defaultKey = { image: "defaultImageModel", video: "defaultVideoModel" } as const;

/** The default Model's Alias for a Modality, when one is set and that Model exists with that Modality. */
export function defaultModelAlias(config: Config, modality: Modality = "image"): string | undefined {
  const wanted = config[defaultKey[modality]];
  return config.models.some((model) => model.alias === wanted && model.modality === modality) ? wanted : undefined;
}

/** Picks the Model for a Job: the named Alias, else the default Model of the wanted Modality. */
export function resolveModel(config: Config, alias: string | undefined, modality: Modality = "image"): ResolvedModel {
  const ofModality = config.models.filter((model) => model.modality === modality);
  const wanted = alias ?? config[defaultKey[modality]];
  const model = config.models.find((candidate) => candidate.alias === wanted);
  // Naming a Model of the other Modality gets pointed at the right tool, even when none of this Modality exist.
  if (ofModality.length === 0 && (alias === undefined || model === undefined)) throw needsSettings(`litevision has no ${modality} Model configured yet.`);

  const known = ofModality.map((candidate) => candidate.alias).join(", ");
  if (wanted === undefined) {
    throw needsSettings(`No default ${modality} Model is set. Pass \`model\` with one of: ${known}. Or:`);
  }
  if (model === undefined) {
    if (alias === undefined) throw needsSettings(`The default ${modality} Model "${wanted}" does not exist. Known Aliases: ${known}.`);
    throw new ConfigError(`Unknown Model Alias "${wanted}". Known ${modality} Model Aliases: ${known}.`);
  }
  if (model.modality !== modality) {
    if (alias === undefined) throw needsSettings(`The default ${modality} Model "${wanted}" makes ${model.modality}s. Pass \`model\` with one of: ${known}. Or:`);
    const tool = model.modality === "video" ? "generate_video" : "generate_image";
    throw new ConfigError(
      `Model "${model.alias}" generates ${model.modality}s, not ${modality}s. Use \`${tool}\` for it${ofModality.length === 0 ? "" : `, or one of these ${modality} Models: ${known}`}.`,
    );
  }
  const provider = config.providers.find((candidate) => candidate.id === model.provider);
  if (provider === undefined) {
    throw needsSettings(`Model "${model.alias}" refers to Provider "${model.provider}", which is not configured.`);
  }
  return { model, provider };
}
