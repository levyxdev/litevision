import { ConfigError, type Model } from "../config.ts";
import { isPlainObject } from "../config-store.ts";
import { readReferences } from "../images.ts";
import { fieldsToRead, readResolution, readSeconds, readShape } from "./parameter-guide.ts";
import type { ImageRequest, ProtocolAdapter, VideoRequest } from "./protocol.ts";

/**
 * Turns the generation tools' parameters into requests in litevision's own terms (ADR 0010). Only `provider_options`
 * that set a field litevision fills are refused; nothing else is checked, defaulted or adjusted, and the Provider decides
 * what is valid. Reading the reference images and frames from disk is the one thing that can fail here, before any
 * Provider request.
 */

/** The `generate_image` parameters. */
export interface ImageParameters {
  prompt: string;
  n: number;
  /** Local paths as the Agent gave them. */
  references: string[];
  /** The Agent's `provider_options` merged over the Model's Standing Options. */
  providerOptions: Record<string, unknown>;
}

export interface NormalisedRequest {
  request: ImageRequest;
  /**
   * The shape the request asks for, as litevision read it from the fields the Parameter Guide names, e.g. `16:9` or
   * `3840x2160`; null when it asks for none litevision can read, so the result's shape is not checked.
   */
  requestedShape: string | null;
  /** The resolution tier the request asks for, e.g. `4K`; null when it sets none. Reported only, never checked. */
  requestedResolution: string | null;
}

/** The `generate_video` parameters. */
export interface VideoParameters {
  prompt: string;
  /** Local paths as the Agent gave them. */
  firstFrame?: string;
  lastFrame?: string;
  references: string[];
  /** The Agent's `provider_options` merged over the Model's Standing Options. */
  providerOptions: Record<string, unknown>;
}

export interface NormalisedVideoRequest {
  request: VideoRequest;
  /** The shape and length the request asks for, as litevision read them; null when unreadable, which goes unchecked. */
  requestedShape: string | null;
  requestedSeconds: number | null;
  /** The resolution tier the request asks for, e.g. `1080P`; null when it sets none. Reported only, never checked. */
  requestedResolution: string | null;
}

/**
 * The reserved fields that options set, each in words for an error, e.g. `` `prompt` ``. A reserved field may be dotted
 * one level deep (`response_format.type`): options then set it by setting that key, or by making its parent anything
 * but an object, which would replace the field litevision fills.
 */
export function reservedConflicts(options: Record<string, unknown>, reservedFields: readonly string[]): string[] {
  const conflictOf = (field: string): string | undefined => {
    const [parent, child] = field.split(".") as [string, string | undefined];
    if (!Object.hasOwn(options, parent)) return undefined;
    const value = options[parent];
    if (child === undefined) return `\`${field}\``;
    if (!isPlainObject(value)) return `\`${parent}\` as anything but an object (litevision sets \`${field}\` in it)`;
    return Object.hasOwn(value, child) ? `\`${field}\`` : undefined;
  };
  // In the order the options name them, so the error reads like what was sent.
  const order = Object.keys(options);
  return [...reservedFields]
    .sort((a, b) => order.indexOf(a.split(".")[0]!) - order.indexOf(b.split(".")[0]!))
    .map(conflictOf)
    .filter((conflict) => conflict !== undefined);
}

/** Refuses merged options that set a field litevision fills itself, naming each. */
function refuseReserved(providerOptions: Record<string, unknown>, reservedFields: readonly string[], fromWhat: string): void {
  const conflicts = reservedConflicts(providerOptions, reservedFields);
  if (conflicts.length === 0) return;
  throw new ConfigError(
    `provider_options, and the Model's Standing Options they are merged over, may not set ${conflicts.join(", ")}: litevision fills ${conflicts.length === 1 ? "that field" : "those fields"} itself, from ${fromWhat}. Use those instead.`,
  );
}

export async function normaliseImageRequest(
  parameters: ImageParameters,
  model: Model,
  adapter: ProtocolAdapter,
  cwd: string,
): Promise<NormalisedRequest> {
  refuseReserved(parameters.providerOptions, adapter.reservedOptions, "the prompt, `references` and `model`");
  const references = await readReferences(parameters.references, cwd);
  const fields = fieldsToRead(adapter, model.modelId, "image");
  return {
    request: { prompt: parameters.prompt, n: parameters.n, references, providerOptions: parameters.providerOptions },
    requestedShape: readShape(fields.shape, parameters.providerOptions),
    requestedResolution: readResolution(fields.resolution, parameters.providerOptions),
  };
}

export async function normaliseVideoRequest(
  parameters: VideoParameters,
  model: Model,
  adapter: ProtocolAdapter,
  cwd: string,
): Promise<NormalisedVideoRequest> {
  refuseReserved(parameters.providerOptions, adapter.reservedVideoOptions ?? [], "the prompt, `first_frame`, `last_frame`, `references` and `model`");
  const frame = async (path: string | undefined) => (path === undefined ? undefined : (await readReferences([path], cwd))[0]);
  const [firstFrame, lastFrame, references] = await Promise.all([
    frame(parameters.firstFrame),
    frame(parameters.lastFrame),
    readReferences(parameters.references, cwd),
  ]);
  const fields = fieldsToRead(adapter, model.modelId, "video");
  return {
    request: {
      prompt: parameters.prompt,
      ...(firstFrame === undefined ? {} : { firstFrame }),
      ...(lastFrame === undefined ? {} : { lastFrame }),
      references,
      providerOptions: parameters.providerOptions,
    },
    requestedShape: readShape(fields.shape, parameters.providerOptions),
    requestedSeconds: readSeconds(fields.duration, parameters.providerOptions),
    requestedResolution: readResolution(fields.resolution, parameters.providerOptions),
  };
}
