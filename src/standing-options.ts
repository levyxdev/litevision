import { isPlainObject } from "./config-store.ts";
import { adapterForProtocol } from "./protocols/index.ts";
import type { Modality } from "./protocols/protocol.ts";

/**
 * Standing Options (ADR 0010): `provider_options` the User set once on a Model, sent with every Job on it. The Agent's
 * own `provider_options` are merged over them for one Job.
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
  const reserved = Object.keys(value).filter((key) => reservedFields(protocol, modality).includes(key));
  if (reserved.length === 0) return undefined;
  const names = reserved.map((key) => `\`${key}\``).join(", ");
  return `Standing Options may not set ${names}: litevision fills ${reserved.length === 1 ? "that field" : "those fields"} itself for Protocol "${protocol}".`;
}
