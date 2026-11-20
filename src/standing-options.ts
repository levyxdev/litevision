import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { ConfigError, modelSchema, needsSettings } from "./config.ts";
import { isPlainObject, updateConfig } from "./config-store.ts";
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

export interface AgentStandingChange {
  standingOptions: Record<string, unknown>;
  previous: Record<string, unknown>;
  /** False when they already were these options, so nothing was written. */
  changed: boolean;
}

/** `update_standing_options`: replaces one Model's Standing Options in `config.json` with ones the User agreed to; `{}` clears them. */
export function updateStandingOptionsAsAgent(dirs: Dirs, alias: string, value: Record<string, unknown>): Promise<AgentStandingChange> {
  return updateConfig(dirs, (config) => {
    const models = config.models ?? [];
    const parsed = z.array(modelSchema).safeParse(models);
    if (!parsed.success) throw needsSettings(`The Models in config.json are invalid: ${z.prettifyError(parsed.error)}`);
    const stored = models as Array<z.input<typeof modelSchema>>;
    if (stored.length === 0) throw needsSettings("litevision has no Model configured yet.");

    const model = stored.find((candidate) => candidate.alias === alias);
    if (model === undefined) {
      throw new ConfigError(`Unknown Model Alias "${alias}". Known Aliases: ${stored.map((candidate) => candidate.alias).join(", ")}.`);
    }
    const previous = model.standingOptions ?? {};
    if (isDeepStrictEqual(previous, value)) return { standingOptions: value, previous, changed: false };
    if (Object.keys(value).length === 0) {
      delete model.standingOptions;
    } else {
      const problem = standingOptionsProblem(value, model.protocol, model.modality ?? "image");
      if (problem !== undefined) throw new ConfigError(problem);
      model.standingOptions = value;
    }
    return { standingOptions: value, previous, changed: true };
  });
}
