import type { HttpTransport } from "../http.ts";

/** The aspect ratios the Agent may ask for. Each Model supports some of them. */
export const aspectRatios = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"] as const;
export type AspectRatio = (typeof aspectRatios)[number];

/** One aspect ratio a Model supports, and the concrete size it produces. */
export interface ImageSize {
  aspectRatio: AspectRatio;
  width: number;
  height: number;
}

/** A size as Providers usually write it, e.g. `1536x1024`. */
export function formatSize(size: ImageSize): string {
  return `${size.width}x${size.height}`;
}

/** What one Model can do, as declared by its Protocol adapter. */
export interface ImageCapabilities {
  /** Every supported aspect ratio with the size it maps to; never empty. */
  sizes: ImageSize[];
  /** How many reference images one Job may take; 0 when the Model cannot take any. */
  maxReferences: number;
  /** How many images one Job may produce. */
  maxImages: number;
}

/** A reference image, already read from disk. */
export interface ReferenceImage {
  /** Absolute path it was read from. */
  path: string;
  /** File name to give the Provider, e.g. `fox.png`. */
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
}

/**
 * A generation request in litevision's own terms, independent of any Protocol.
 * The shared normalisation has already checked it against the adapter's capabilities.
 */
export interface ImageRequest {
  /** Sent verbatim. */
  prompt: string;
  /** At most the Model's `maxImages`. */
  n: number;
  /** One of the Model's supported sizes. */
  size: ImageSize;
  /** At most the Model's `maxReferences`; empty for text-to-image. */
  references: ReferenceImage[];
  /** Merged into the Provider request untouched. Never contains an adapter's `reservedOptions`. */
  providerOptions: Record<string, unknown>;
}

/** Everything an adapter needs to reach one Model. */
export interface ModelTarget {
  providerId: string;
  baseUrl: string;
  modelId: string;
  credential: string;
}

/** One result image: either its bytes, or a link the Job runner downloads straight away. */
export type GeneratedImage = { bytes: Uint8Array } | { url: string };

/** A Job a Provider has accepted. Synchronous Protocols resolve `wait` immediately. */
export interface SubmittedJob {
  wait(): Promise<GeneratedImage[]>;
}

export type ProviderErrorKind = "auth" | "balance" | "refusal" | "rate_limit" | "unsupported" | "other";

/** A failure reported by, or while reaching, a Provider. Its message names the Provider. */
export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
  ) {
    super(message);
  }
}

/** Everything an adapter needs to reach a Provider before any Model is chosen. */
export interface ProviderTarget {
  providerId: string;
  baseUrl: string;
  credential: string;
}

/** The outcome of "test connection". Its message is plain language and never contains the Credential. */
export interface ConnectionResult {
  ok: boolean;
  message: string;
}

/** The code that speaks one Protocol (ADR 0002). */
export interface ProtocolAdapter {
  /** What a Model with this model id can do. Unknown model ids get the Protocol's most common capabilities. */
  capabilities(modelId: string): ImageCapabilities;
  /** Request fields the adapter sets itself; `provider_options` may not set them. */
  reservedOptions: readonly string[];
  submit(request: ImageRequest, target: ModelTarget, http: HttpTransport): Promise<SubmittedJob>;
  /**
   * Checks that a Provider's base URL and Credential work with this Protocol, for the settings page's
   * "test connection". Optional: the page reports "not supported yet" for a Protocol without it.
   * Provider-level calls the settings page needs later (such as listing Models) sit alongside it.
   */
  testConnection?(target: ProviderTarget, http: HttpTransport): Promise<ConnectionResult>;
}
