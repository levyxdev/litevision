import { z } from "zod";
import { modelNotesMaxLength, modelSchema, type NotesHistory } from "../config.ts";
import { isPlainObject, readConfigObject, updateConfig, type ConfigObject } from "../config-store.ts";
import type { Dirs } from "../dirs.ts";
import { notesTooLong, replaceNotes, undoNotes } from "../model-notes.ts";
import { supportedProtocols } from "../protocols/index.ts";
import { SettingsError, shortName } from "./providers.ts";

/** A Model as the page sees it. */
export interface ModelView {
  alias: string;
  provider: string;
  modelId: string;
  protocol: string;
  notes: string;
  /** Who changed the Model Notes last and when, and the previous version to undo to. Absent until they first change. */
  notesHistory?: NotesHistory;
  /** True for the default image Model. */
  default: boolean;
}

const alias = shortName("An Alias");

const notes = z.string().trim().max(modelNotesMaxLength, notesTooLong);

export const addModelInput = z.object({
  alias,
  provider: z.string().min(1, "Choose a Provider."),
  modelId: z.string().trim().min(1, "Enter a model id.").max(200, "A model id is at most 200 characters."),
  protocol: z
    .string()
    .refine((value) => supportedProtocols.includes(value), `Choose a supported Protocol: ${supportedProtocols.join(", ")}.`),
  notes: notes.optional(),
});

export const updateModelInput = addModelInput.partial();

type StoredModel = z.infer<typeof modelSchema> & Record<string, unknown>;

const storedModels = z.array(modelSchema);

export async function listModels(dirs: Dirs): Promise<{ models: ModelView[]; defaultImageModel: string | null }> {
  const config = await readConfigObject(dirs);
  const defaultImageModel = typeof config.defaultImageModel === "string" ? config.defaultImageModel : null;
  return { models: modelsOf(config).map((model) => view(model, defaultImageModel)), defaultImageModel };
}

async function getModel(dirs: Dirs, wanted: string): Promise<ModelView> {
  const model = (await listModels(dirs)).models.find((candidate) => candidate.alias === wanted);
  if (model === undefined) throw notFound(wanted);
  return model;
}

/** Model Notes written with a new Model are the User's, with no previous version to undo to. */
export async function addModel(dirs: Dirs, input: z.infer<typeof addModelInput>, at: Date): Promise<ModelView> {
  await updateConfig(dirs, (config) => {
    const models = modelsOf(config);
    requireFreeAlias(models, input.alias);
    requireProvider(config, input.provider);
    const stored: StoredModel = { alias: input.alias, provider: input.provider, modelId: input.modelId, protocol: input.protocol };
    if (input.notes) {
      stored.notes = input.notes;
      stored.notesHistory = { changedBy: "User", changedAt: at.toISOString() };
    }
    config.models = [...models, stored];
  });
  return getModel(dirs, input.alias);
}

/**
 * Changes any of a Model's fields. Renaming the default image Model keeps it the default.
 * Changed Model Notes are recorded as the User's, keeping the previous version.
 */
export async function updateModel(dirs: Dirs, wanted: string, input: z.infer<typeof updateModelInput>, at: Date): Promise<ModelView> {
  await updateConfig(dirs, (config) => {
    const models = modelsOf(config);
    const model = models.find((candidate) => candidate.alias === wanted);
    if (model === undefined) throw notFound(wanted);
    if (input.alias !== undefined && input.alias !== wanted) {
      requireFreeAlias(models, input.alias);
      model.alias = input.alias;
      if (config.defaultImageModel === wanted) config.defaultImageModel = input.alias;
    }
    if (input.provider !== undefined) {
      requireProvider(config, input.provider);
      model.provider = input.provider;
    }
    if (input.modelId !== undefined) model.modelId = input.modelId;
    if (input.protocol !== undefined) model.protocol = input.protocol;
    if (input.notes !== undefined) replaceNotes(model, input.notes, "User", at);
  });
  return getModel(dirs, input.alias ?? wanted);
}

/** Swaps a Model's Notes with their previous version, as a change by the User; a second undo redoes. */
export async function undoModelNotes(dirs: Dirs, wanted: string, at: Date): Promise<ModelView> {
  await updateConfig(dirs, (config) => {
    const model = modelsOf(config).find((candidate) => candidate.alias === wanted);
    if (model === undefined) throw notFound(wanted);
    if (!undoNotes(model, at)) throw new SettingsError(409, `The Model Notes of "${wanted}" have no previous version to undo to.`);
  });
  return getModel(dirs, wanted);
}

/** Removes a Model; if it was the default image Model, no default is left. */
export async function removeModel(dirs: Dirs, wanted: string): Promise<void> {
  await updateConfig(dirs, (config) => {
    const models = modelsOf(config);
    if (!models.some((model) => model.alias === wanted)) throw notFound(wanted);
    config.models = models.filter((model) => model.alias !== wanted);
    if (config.defaultImageModel === wanted) delete config.defaultImageModel;
  });
}

export const setDefaultInput = z.object({ alias: z.string().nullable() });

/** Makes a Model the default image Model, or, with `null`, leaves no default. */
export async function setDefaultImageModel(dirs: Dirs, wanted: string | null): Promise<{ defaultImageModel: string | null }> {
  await updateConfig(dirs, (config) => {
    if (wanted === null) {
      delete config.defaultImageModel;
      return;
    }
    if (!modelsOf(config).some((model) => model.alias === wanted)) throw notFound(wanted);
    config.defaultImageModel = wanted;
  });
  return { defaultImageModel: wanted };
}

function requireFreeAlias(models: StoredModel[], wanted: string): void {
  if (models.some((model) => model.alias === wanted)) {
    throw new SettingsError(409, `A Model with the Alias "${wanted}" already exists. Choose another Alias.`);
  }
}

function requireProvider(config: ConfigObject, id: string): void {
  const providers = Array.isArray(config.providers) ? config.providers : [];
  if (!providers.some((provider) => isPlainObject(provider) && provider.id === id)) {
    throw new SettingsError(400, `There is no Provider named "${id}". Add it under Providers first.`);
  }
}

/** The stored Model objects themselves, so edits keep any fields litevision does not know. */
function modelsOf(config: ConfigObject): StoredModel[] {
  if (config.models === undefined) return [];
  const parsed = storedModels.safeParse(config.models);
  if (!parsed.success) throw new SettingsError(409, `The Models in config.json are invalid: ${z.prettifyError(parsed.error)}`);
  return config.models as StoredModel[];
}

function view(model: StoredModel, defaultImageModel: string | null): ModelView {
  return {
    alias: model.alias,
    provider: model.provider,
    modelId: model.modelId,
    protocol: model.protocol,
    notes: model.notes ?? "",
    ...(model.notesHistory && { notesHistory: model.notesHistory }),
    default: model.alias === defaultImageModel,
  };
}

function notFound(wanted: string): SettingsError {
  return new SettingsError(404, `There is no Model with the Alias "${wanted}".`);
}
