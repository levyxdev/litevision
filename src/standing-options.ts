import { isDeepStrictEqual } from "node:util";
import { ConfigError, type ChangeAuthor, type StandingOptionsHistory } from "./config.ts";
import { isPlainObject, updateModelAsAgent } from "./config-store.ts";
import type { Dirs } from "./dirs.ts";
import { adapterForProtocol } from "./protocols/index.ts";
import { reservedConflicts } from "./protocols/requests.ts";
import type { Modality } from "./protocols/protocol.ts";

/**
 * Standing Options (ADR 0010): `provider_options` set once on a Model, by the User or by the Agent with the User's
 * agreement, sent with every Job on it. The Agent's own `provider_options` are merged over them for one Job.
 */

/**
 * The options a Job sends: the Agent's values win; plain objects merge key by key, recursively; any other value
 * replaces; `null` removes the key for this Job.
 */
export function mergeOptions(standing: Record<string, unknown>, agent: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...standing };
  for (const [key, value] of Object.entries(agent)) {
    if (value === null) delete merged[key];
    else if (isPlainObject(value)) merged[key] = mergeOptions(isPlainObject(merged[key]) ? merged[key] : {}, value);
    else merged[key] = value;
  }
  return merged;
}

/** The request fields a Protocol fills itself for a Modality, which neither Standing Options nor `provider_options` may set. */
export function reservedFields(protocol: string, modality: Modality): readonly string[] {
  const adapter = adapterForProtocol(protocol);
  if (adapter === undefined) return [];
  return modality === "video" ? (adapter.reservedVideoOptions ?? []) : adapter.reservedOptions;
}

/** Why a value cannot be a Model's Standing Options, in words the User can act on; undefined when it can. */
export function standingOptionsProblem(value: unknown, protocol: string, modality: Modality): string | undefined {
  if (!isPlainObject(value)) {
    return 'Standing Options must be a JSON object of request fields, such as { "quality": "high" }.';
  }
  const conflicts = reservedConflicts(value, reservedFields(protocol, modality));
  if (conflicts.length === 0) return undefined;
  return `Standing Options may not set ${conflicts.join(", ")}: litevision fills ${conflicts.length === 1 ? "that field" : "those fields"} itself for Protocol "${protocol}".`;
}

/** The part of a stored Model that holds its Standing Options. */
export interface StandingOptionsHolder {
  standingOptions?: Record<string, unknown>;
  standingOptionsHistory?: StandingOptionsHistory;
}

/**
 * Replaces a Model's Standing Options whole, keeping what they were as the one previous version; `{}` removes them.
 * Returns false, and records nothing, when they are unchanged. Check the value with {@link standingOptionsProblem} first.
 */
export function replaceStandingOptions(model: StandingOptionsHolder, value: Record<string, unknown>, changedBy: ChangeAuthor, at: Date): boolean {
  const current = model.standingOptions ?? {};
  if (isDeepStrictEqual(value, current)) return false;
  setStandingOptions(model, value);
  model.standingOptionsHistory = { changedBy, changedAt: at.toISOString(), previous: current };
  return true;
}

/** Swaps the current and previous Standing Options, as a change by the User; a second undo redoes. False when there is nothing to undo to. */
export function undoStandingOptions(model: StandingOptionsHolder, at: Date): boolean {
  const previous = model.standingOptionsHistory?.previous;
  if (previous === undefined) return false;
  const current = model.standingOptions ?? {};
  setStandingOptions(model, previous);
  model.standingOptionsHistory = { changedBy: "User", changedAt: at.toISOString(), previous: current };
  return true;
}

/** Empty Standing Options are removed rather than stored. */
function setStandingOptions(model: StandingOptionsHolder, value: Record<string, unknown>): void {
  if (Object.keys(value).length === 0) delete model.standingOptions;
  else model.standingOptions = value;
}

export interface AgentStandingChange {
  standingOptions: Record<string, unknown>;
  previous: Record<string, unknown>;
  /** False when they already were these options, so nothing was recorded. */
  changed: boolean;
  /** The last change, which is this one when `changed`. */
  history?: StandingOptionsHistory;
}

/** `update_standing_options`: replaces one Model's Standing Options in `config.json` as a change by the Agent. */
export function updateStandingOptionsAsAgent(dirs: Dirs, alias: string, value: Record<string, unknown>, at: Date): Promise<AgentStandingChange> {
  return updateModelAsAgent(dirs, alias, (model) => {
    const problem = standingOptionsProblem(value, model.protocol, model.modality ?? "image");
    if (problem !== undefined) throw new ConfigError(problem);
    const previous = model.standingOptions ?? {};
    const changed = replaceStandingOptions(model, value, "Agent", at);
    return { standingOptions: value, previous, changed, history: model.standingOptionsHistory };
  });
}
