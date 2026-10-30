import { ConfigError, type Model } from "../config.ts";
import { readReferences } from "../images.ts";
import { formatSize, type AspectRatio, type ImageCapabilities, type ImageRequest, type ImageSize, type ProtocolAdapter } from "./protocol.ts";

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
  const target = Math.log(ratioOf(wanted));
  const distance = (size: ImageSize) => Math.abs(Math.log(size.width / size.height) - target);
  const [first, ...rest] = sizes;
  if (first === undefined) throw new Error("A Protocol adapter declared no supported sizes.");
  const size = rest.reduce((best, size) => (distance(size) < distance(best) ? size : best), first);
  return { size, adjusted: true };
}

function ratioOf(aspectRatio: AspectRatio): number {
  const [width, height] = aspectRatio.split(":").map(Number);
  return width! / height!;
}

/**
 * Checks `generate_image` parameters against a Model's capabilities (see `modelInfo`) and turns them into an
 * ImageRequest. Everything that would fail here fails before any Provider request.
 */
export async function normaliseImageRequest(
  parameters: ImageParameters,
  model: Model,
  adapter: ProtocolAdapter,
  capabilities: ImageCapabilities,
  cwd: string,
): Promise<NormalisedRequest> {
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
    request: { prompt: parameters.prompt, n: parameters.n, size, references, providerOptions: parameters.providerOptions },
    requestedAspectRatio: parameters.aspectRatio,
    aspectRatioAdjusted: adjusted,
  };
}
