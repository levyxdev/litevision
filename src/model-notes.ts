import { z } from "zod";
import { ConfigError, modelNotesMaxLength, modelSchema, needsSettings, type NotesAuthor, type NotesHistory } from "./config.ts";
import { updateConfig } from "./config-store.ts";
import type { Dirs } from "./dirs.ts";

/** The part of a stored Model that holds its Model Notes. */
export interface NotesHolder {
  notes?: string;
  notesHistory?: NotesHistory;
}

export const notesTooLong = `Model Notes are at most ${modelNotesMaxLength} characters.`;

/**
 * Replaces a Model's Notes whole, keeping what they were as the one previous version.
 * Returns false, and records nothing, when the text is unchanged.
 */
export function replaceNotes(model: NotesHolder, text: string, changedBy: NotesAuthor, at: Date): boolean {
  const current = model.notes ?? "";
  if (text === current) return false;
  setNotes(model, text);
  model.notesHistory = { changedBy, changedAt: at.toISOString(), previous: current };
  return true;
}

/** Swaps the current and previous Model Notes, as a change by the User; a second undo redoes. False when there is nothing to undo to. */
export function undoNotes(model: NotesHolder, at: Date): boolean {
  const previous = model.notesHistory?.previous;
  if (previous === undefined) return false;
  const current = model.notes ?? "";
  setNotes(model, previous);
  model.notesHistory = { changedBy: "User", changedAt: at.toISOString(), previous: current };
  return true;
}

/** Empty Model Notes are removed rather than stored. */
function setNotes(model: NotesHolder, text: string): void {
  if (text === "") delete model.notes;
  else model.notes = text;
}

export interface AgentNotesChange {
  notes: string;
  previous: string;
  /** False when the text was already the Model Notes, so nothing was recorded. */
  changed: boolean;
  /** The last change, which is this one when `changed`. */
  history?: NotesHistory;
}

/** `update_model_notes`: replaces one Model's Notes in `config.json` as a change by the Agent. */
export function updateNotesAsAgent(dirs: Dirs, alias: string, text: string, at: Date): Promise<AgentNotesChange> {
  const notes = text.trim();
  if (notes.length > modelNotesMaxLength) {
    throw new ConfigError(`${notesTooLong} This text has ${notes.length}. Shorten it and show the User the new text again.`);
  }
  return updateConfig(dirs, (config) => {
    const models = config.models ?? [];
    const parsed = z.array(modelSchema).safeParse(models);
    if (!parsed.success) throw needsSettings(`The Models in config.json are invalid: ${z.prettifyError(parsed.error)}`);
    const stored = models as Array<z.infer<typeof modelSchema>>;
    if (stored.length === 0) throw needsSettings("litevision has no image Model configured yet.");

    const model = stored.find((candidate) => candidate.alias === alias);
    if (model === undefined) {
      throw new ConfigError(`Unknown Model Alias "${alias}". Known Aliases: ${stored.map((candidate) => candidate.alias).join(", ")}.`);
    }
    const previous = model.notes ?? "";
    const changed = replaceNotes(model, notes, "Agent", at);
    return { notes, previous, changed, history: model.notesHistory };
  });
}
