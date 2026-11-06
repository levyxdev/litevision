import { ConfigError, type Model } from "../config.ts";
import { readReferences } from "../images.ts";
import { mediaFactsOf } from "../media.ts";
import { fieldsToRead, readSeconds, readShape } from "./parameter-guide.ts";
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
  /** Omitted for no size of litevision's choosing: the Provider's default applies (ADR 0010). */
  aspectRatio?: AspectRatio;
  /** Local paths as the Agent gave them. */
  references: string[];
  providerOptions: Record<string, unknown>;
}

export interface NormalisedRequest {
  request: ImageRequest;
  /** What the Agent gave as `aspect_ratio`; omitted when it gave none. */
  requestedAspectRatio?: AspectRatio;
  /** True when the Model does not support the requested aspect ratio and the closest one was used instead. */
  aspectRatioAdjusted: boolean;
  /**
   * The shape the final request asks for, as litevision read it from the fields the Parameter Guide names, e.g.
   * `16:9` or `3840x2160`; null when it asks for none litevision can read, so the result's shape is not checked.
   */
  requestedShape: string | null;
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
 * Turns `generate_image` parameters into an ImageRequest (ADR 0010): reads the reference images, refuses only
 * `provider_options` that set a field litevision fills, and checks nothing else. Everything that would fail here fails
 * before any Provider request.
 */
export async function normaliseImageRequest(
  parameters: ImageParameters,
  model: Model,
  adapter: ProtocolAdapter,
  described: ModelDescription,
  cwd: string,
): Promise<NormalisedRequest> {
  const { capabilities } = described;
  const reserved = Object.keys(parameters.providerOptions).filter((key) => adapter.reservedOptions.includes(key));
  if (reserved.length > 0) {
    throw new ConfigError(
      `provider_options may not set ${reserved.map((key) => `\`${key}\``).join(", ")}: litevision fills ${reserved.length === 1 ? "that field" : "those fields"} itself, from the prompt, \`references\` and \`model\`. Use those instead.`,
    );
  }

  const translated = parameters.aspectRatio === undefined ? undefined : closestSize(capabilities.sizes, parameters.aspectRatio);
  const references = await readReferences(parameters.references, cwd);
  // A shape field in provider_options overrides the translated aspect ratio, which is otherwise what is sent.
  const read = readShape(fieldsToRead(adapter, model.modelId, "image").shape, parameters.providerOptions);
  return {
    request: {
      prompt: parameters.prompt,
      n: parameters.n,
      ...(translated === undefined ? {} : { size: translated.size }),
      references,
      providerOptions: parameters.providerOptions,
      model: { capabilities, ...(described.parameterSchema === undefined ? {} : { parameterSchema: described.parameterSchema }) },
    },
    ...(parameters.aspectRatio === undefined ? {} : { requestedAspectRatio: parameters.aspectRatio }),
    aspectRatioAdjusted: translated?.adjusted ?? false,
    requestedShape: read.set ? read.shape : (translated?.size.aspectRatio ?? null),
  };
}

/** The `generate_video` parameters, before they are checked against a Model's capabilities. */
export interface VideoParameters {
  prompt: string;
  /** Each omitted for none: the video Model's own default applies (ADR 0010). */
  aspectRatio?: AspectRatio;
  /** Whole seconds. */
  duration?: number;
  resolution?: string;
  /** Local paths as the Agent gave them. */
  firstFrame?: string;
  lastFrame?: string;
  references: string[];
  providerOptions: Record<string, unknown>;
}

export interface NormalisedVideoRequest {
  request: VideoRequest;
  /** What the Agent gave as `aspect_ratio`, `duration` and `resolution`; each omitted when it gave none. */
  requestedAspectRatio?: AspectRatio;
  requestedDuration?: number;
  /**
   * The shape and length the final request asks for, as litevision read them from the fields the Parameter Guide
   * names (ADR 0010); null when it asks for none litevision can read, which then goes unchecked.
   */
  requestedShape: string | null;
  requestedSeconds: number | null;
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
 * Turns `generate_video` parameters into a VideoRequest (ADR 0010): reads the frames and reference images, refuses
 * only `provider_options` that set a field litevision fills, and checks, defaults and rounds nothing. Everything that
 * would fail here fails before any Provider request.
 */
export async function normaliseVideoRequest(
  parameters: VideoParameters,
  model: Model,
  adapter: ProtocolAdapter,
  cwd: string,
): Promise<NormalisedVideoRequest> {
  const reservedOptions = adapter.reservedVideoOptions ?? [];
  const reserved = Object.keys(parameters.providerOptions).filter((key) => reservedOptions.includes(key));
  if (reserved.length > 0) {
    throw new ConfigError(
      `provider_options may not set ${reserved.map((key) => `\`${key}\``).join(", ")}: litevision fills ${reserved.length === 1 ? "that field" : "those fields"} itself, from the prompt, \`first_frame\`, \`last_frame\`, \`references\` and \`model\`. Use those instead.`,
    );
  }

  const frame = async (path: string | undefined) => (path === undefined ? undefined : (await readReferences([path], cwd))[0]);
  const [firstFrame, lastFrame, references] = await Promise.all([
    frame(parameters.firstFrame),
    frame(parameters.lastFrame),
    readReferences(parameters.references, cwd),
  ]);
  // Fields in provider_options override the translated parameters, which are otherwise what is sent.
  const fields = fieldsToRead(adapter, model.modelId, "video");
  const shape = readShape(fields.shape, parameters.providerOptions);
  const seconds = readSeconds(fields.duration, parameters.providerOptions);
  return {
    request: {
      prompt: parameters.prompt,
      ...(parameters.aspectRatio === undefined ? {} : { aspectRatio: parameters.aspectRatio }),
      ...(parameters.resolution === undefined ? {} : { resolution: parameters.resolution }),
      ...(parameters.duration === undefined ? {} : { seconds: parameters.duration }),
      ...(firstFrame === undefined ? {} : { firstFrame }),
      ...(lastFrame === undefined ? {} : { lastFrame }),
      references,
      providerOptions: parameters.providerOptions,
    },
    ...(parameters.aspectRatio === undefined ? {} : { requestedAspectRatio: parameters.aspectRatio }),
    ...(parameters.duration === undefined ? {} : { requestedDuration: parameters.duration }),
    // A Model whose guide names no shape field (Seedance follows its first frame) is not sent the translated ratio.
    requestedShape: shape.set ? shape.shape : fields.shape.length === 0 ? null : (parameters.aspectRatio ?? null),
    requestedSeconds: seconds.set ? seconds.seconds : (parameters.duration ?? null),
  };
}
