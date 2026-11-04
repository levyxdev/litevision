import { ConfigError, type Model } from "../config.ts";
import { readReferences } from "../images.ts";
import { mediaFactsOf } from "../media.ts";
import {
  formatSize,
  type AspectRatio,
  type ImageCapabilities,
  type ImageRequest,
  type ImageSize,
  type ModelDescription,
  type ProtocolAdapter,
  type VideoCapabilities,
  type VideoRequest,
} from "./protocol.ts";

/** The `generate_image` parameters, before they are checked against a Model's capabilities. */
export interface ImageParameters {
  prompt: string;
  n: number;
  aspectRatio: AspectRatio;
  /** Local paths as the Agent gave them. */
  references: string[];
  providerOptions: Record<string, unknown>;
}

export interface NormalisedRequest {
  request: ImageRequest;
  requestedAspectRatio: AspectRatio;
  /** True when the Model does not support the requested aspect ratio and the closest one was used instead. */
  aspectRatioAdjusted: boolean;
}

/** One sentence describing a Model's capabilities, for errors and tool output. */
export function describeCapabilities(capabilities: ImageCapabilities): string {
  const ratios = capabilities.sizes.map((size) => `${size.aspectRatio} (${formatSize(size)})`).join(", ");
  const references =
    capabilities.maxReferences === 0
      ? "no reference images"
      : `up to ${capabilities.maxReferences} reference image${capabilities.maxReferences === 1 ? "" : "s"}`;
  return `aspect ratios ${ratios}; up to ${capabilities.maxImages} image${capabilities.maxImages === 1 ? "" : "s"} per Job; ${references}.`;
}

/** The supported size whose ratio is closest to the wanted one, compared on a log scale so portrait and landscape weigh the same. */
export function closestSize(sizes: ImageSize[], wanted: AspectRatio): { size: ImageSize; adjusted: boolean } {
  const exact = sizes.find((size) => size.aspectRatio === wanted);
  if (exact !== undefined) return { size: exact, adjusted: false };
  return { size: sizeClosestTo(sizes, ratioOf(wanted)), adjusted: true };
}

/** The supported size whose shape is closest to a width-over-height ratio. */
function sizeClosestTo(sizes: ImageSize[], ratio: number): ImageSize {
  const target = Math.log(ratio);
  const distance = (size: ImageSize) => Math.abs(Math.log(size.width / size.height) - target);
  const [first, ...rest] = sizes;
  if (first === undefined) throw new Error("A Protocol adapter declared no supported sizes.");
  return rest.reduce((best, size) => (distance(size) < distance(best) ? size : best), first);
}

/** An aspect ratio as a number, width over height. */
export function ratioOf(aspectRatio: AspectRatio): number {
  const [width, height] = aspectRatio.split(":").map(Number);
  return width! / height!;
}

/**
 * Checks `generate_image` parameters against what is known about a Model (see `modelInfo`) and turns them into an
 * ImageRequest. Everything that would fail here fails before any Provider request.
 */
export async function normaliseImageRequest(
  parameters: ImageParameters,
  model: Model,
  adapter: ProtocolAdapter,
  described: ModelDescription,
  cwd: string,
): Promise<NormalisedRequest> {
  const { capabilities } = described;
  const unsupported = (problem: string) =>
    new ConfigError(`${problem} Model "${model.alias}" supports: ${describeCapabilities(capabilities)} Choose another Model or change the request.`);

  if (parameters.n > capabilities.maxImages) {
    throw unsupported(`Model "${model.alias}" cannot generate ${parameters.n} images in one Job.`);
  }
  if (parameters.references.length > 0 && capabilities.maxReferences === 0) {
    throw unsupported(`Model "${model.alias}" cannot take reference images.`);
  }
  if (parameters.references.length > capabilities.maxReferences) {
    throw unsupported(`Model "${model.alias}" cannot take ${parameters.references.length} reference images.`);
  }
  const reserved = Object.keys(parameters.providerOptions).filter((key) => adapter.reservedOptions.includes(key));
  if (reserved.length > 0) {
    throw new ConfigError(
      `provider_options may not set ${reserved.map((key) => `\`${key}\``).join(", ")}: litevision sets ${reserved.length === 1 ? "it" : "them"} from the \`generate_image\` parameters. Use those instead.`,
    );
  }

  const { size, adjusted } = closestSize(capabilities.sizes, parameters.aspectRatio);
  const references = await readReferences(parameters.references, cwd);
  return {
    request: {
      prompt: parameters.prompt,
      n: parameters.n,
      size,
      references,
      providerOptions: parameters.providerOptions,
      model: { capabilities, ...(described.parameterSchema === undefined ? {} : { parameterSchema: described.parameterSchema }) },
    },
    requestedAspectRatio: parameters.aspectRatio,
    aspectRatioAdjusted: adjusted,
  };
}

/** The `generate_video` parameters, before they are checked against a Model's capabilities. */
export interface VideoParameters {
  prompt: string;
  /** Omitted for the first frame's shape when there is one, else 16:9. */
  aspectRatio?: AspectRatio;
  /** Whole seconds; omitted for the Model's default. */
  duration?: number;
  /** A resolution tier's name; omitted for the Model's default. */
  resolution?: string;
  /** Local paths as the Agent gave them. */
  firstFrame?: string;
  lastFrame?: string;
  references: string[];
  providerOptions: Record<string, unknown>;
}

export interface NormalisedVideoRequest {
  request: VideoRequest;
  requestedAspectRatio: AspectRatio;
  aspectRatioAdjusted: boolean;
  /** True when the Agent gave no aspect ratio, so the size follows the first frame's shape. */
  followsFirstFrame: boolean;
  /** What the Agent asked for; omitted when it left the length to the Model. */
  requestedDuration?: number;
  /** True when the Model cannot make the requested length and the closest one was used instead. */
  durationAdjusted: boolean;
}

/** One sentence describing a video Model's capabilities, for errors and tool output. */
export function describeVideoCapabilities(capabilities: VideoCapabilities): string {
  const tiers = capabilities.resolutions
    .map((tier) => {
      const ratios = tier.sizes.map((size) => `${size.aspectRatio} (${formatSize(size)})`).join(", ");
      return tier.name === undefined ? `aspect ratios ${ratios}` : `${tier.name}: ${ratios}`;
    })
    .join("; ");
  const { durations } = capabilities;
  const lengths = isRun(durations) && durations.length > 2 ? `${durations[0]}–${durations.at(-1)} s` : `${durations.join(", ")} s`;
  const frames = [capabilities.firstFrame && "a first frame", capabilities.lastFrame && "a last frame"].filter(Boolean).join(" and ");
  const references =
    capabilities.maxReferences === 0
      ? "no reference images"
      : `up to ${capabilities.maxReferences} reference image${capabilities.maxReferences === 1 ? "" : "s"}`;
  const named = capabilities.resolutions.some((tier) => tier.name !== undefined);
  return `${named ? "resolutions " : ""}${tiers}; ${lengths} (default ${capabilities.defaultDuration} s); ${frames || "no first or last frame"}; ${references}.`;
}

function isRun(values: number[]): boolean {
  return values.every((value, index) => index === 0 || value === values[index - 1]! + 1);
}

/**
 * Checks `generate_video` parameters against a video Model's capabilities and turns them into a VideoRequest.
 * Everything that would fail here fails before any Provider request.
 */
export async function normaliseVideoRequest(
  parameters: VideoParameters,
  model: Model,
  adapter: ProtocolAdapter,
  capabilities: VideoCapabilities,
  cwd: string,
): Promise<NormalisedVideoRequest> {
  const unsupported = (problem: string) =>
    new ConfigError(
      `${problem} Model "${model.alias}" supports: ${describeVideoCapabilities(capabilities)} Choose another Model or change the request.`,
    );

  const [defaultTier] = capabilities.resolutions;
  if (defaultTier === undefined) throw new Error("A Protocol adapter declared no video resolutions.");
  let tier = defaultTier;
  if (parameters.resolution !== undefined) {
    const wanted = parameters.resolution.toLowerCase();
    const named = capabilities.resolutions.find((candidate) => candidate.name?.toLowerCase() === wanted);
    if (named === undefined) throw unsupported(`Model "${model.alias}" has no resolution "${parameters.resolution}".`);
    tier = named;
  }
  if (parameters.firstFrame !== undefined && !capabilities.firstFrame) throw unsupported(`Model "${model.alias}" cannot start from a given first frame.`);
  if (parameters.lastFrame !== undefined && !capabilities.lastFrame) throw unsupported(`Model "${model.alias}" cannot end on a given last frame.`);
  if (parameters.references.length > 0 && capabilities.maxReferences === 0) throw unsupported(`Model "${model.alias}" cannot take reference images.`);
  if (parameters.references.length > capabilities.maxReferences) {
    throw unsupported(`Model "${model.alias}" cannot take ${parameters.references.length} reference images.`);
  }
  const reservedOptions = adapter.reservedVideoOptions ?? [];
  const reserved = Object.keys(parameters.providerOptions).filter((key) => reservedOptions.includes(key));
  if (reserved.length > 0) {
    throw new ConfigError(
      `provider_options may not set ${reserved.map((key) => `\`${key}\``).join(", ")}: litevision sets ${reserved.length === 1 ? "it" : "them"} from the \`generate_video\` parameters. Use those instead.`,
    );
  }

  const frame = async (path: string | undefined) => (path === undefined ? undefined : (await readReferences([path], cwd))[0]);
  const [firstFrame, lastFrame, references] = await Promise.all([
    frame(parameters.firstFrame),
    frame(parameters.lastFrame),
    readReferences(parameters.references, cwd),
  ]);
  // A video made from a first frame keeps that frame's shape unless the Agent asked for another.
  const frameFacts = parameters.aspectRatio === undefined && firstFrame !== undefined ? mediaFactsOf(firstFrame.bytes) : undefined;
  const { size, adjusted } =
    frameFacts === undefined
      ? closestSize(tier.sizes, parameters.aspectRatio ?? "16:9")
      : { size: sizeClosestTo(tier.sizes, frameFacts.width / frameFacts.height), adjusted: false };
  const seconds =
    parameters.duration === undefined
      ? capabilities.defaultDuration
      : capabilities.durations.reduce((best, candidate) =>
          Math.abs(candidate - parameters.duration!) < Math.abs(best - parameters.duration!) ? candidate : best,
        );
  return {
    request: {
      prompt: parameters.prompt,
      size,
      ...(tier.name === undefined ? {} : { resolution: tier.name }),
      seconds,
      ...(firstFrame === undefined ? {} : { firstFrame }),
      ...(lastFrame === undefined ? {} : { lastFrame }),
      references,
      providerOptions: parameters.providerOptions,
    },
    requestedAspectRatio: frameFacts === undefined ? (parameters.aspectRatio ?? "16:9") : size.aspectRatio,
    aspectRatioAdjusted: adjusted,
    followsFirstFrame: frameFacts !== undefined,
    ...(parameters.duration === undefined ? {} : { requestedDuration: parameters.duration }),
    durationAdjusted: parameters.duration !== undefined && seconds !== parameters.duration,
  };
}
