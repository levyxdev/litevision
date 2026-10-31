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

/** What litevision knows about a Model when a Job starts: the Provider's cached answer where there is one (ADR 0004). */
export interface ModelDescription {
  /** The capabilities the request was checked against. */
  capabilities: ImageCapabilities;
  /** The Provider's own description of the Model's parameters, as `fetchModelInfo` reported it; omitted when none is known. */
  parameterSchema?: unknown;
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
  /** So an adapter need not ask the Provider about the Model again for every Job. */
  model: ModelDescription;
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

/** What a Job brought back. Fewer images than requested is still a result, as long as there is at least one. */
export interface JobImages {
  images: GeneratedImage[];
  /** Why fewer images than requested came back, in plain language naming the Provider; omitted when none are missing. */
  shortfall?: string;
  /** What the Provider says the Job cost, in its own unit; omitted when it does not say. */
  cost?: number;
}

/**
 * What an asynchronous Protocol needs to pick a submitted Job back up after litevision restarts, e.g. the Provider's
 * task ids. Recorded in the Job history, so it must survive `JSON.stringify`, and must never contain the Credential.
 */
export type ResumeHandle = Record<string, unknown>;

/** A Job a Provider has accepted. Synchronous Protocols resolve `wait` immediately. */
export interface SubmittedJob {
  wait(): Promise<JobImages>;
  /** Asynchronous Protocols only: recorded as soon as the Provider accepts the Job, for `resume`. */
  resumeHandle?: ResumeHandle;
}

/** What the Job runner lends an adapter while a Job is under way. */
export interface JobContext {
  /**
   * Resolves after one poll interval, which the Job runner sets. Rejects when litevision shuts down: let that
   * propagate, so the Job is left to be resumed rather than recorded as failed.
   */
  pause(): Promise<void>;
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

/** A Provider's model list, for the settings page. A failure message is plain language and never contains the Credential. */
export type ModelIdsResult = { ok: true; modelIds: string[] } | { ok: false; message: string };

/** What a Provider itself reports about one of its Models. */
export interface ProviderModelInfo {
  /** Omitted when the Provider describes the Model's parameters but not in terms litevision can map. */
  capabilities?: ImageCapabilities;
  /** The Provider's own description of the Model's request parameters (usually JSON Schema), shown to the Agent as is. */
  parameterSchema?: unknown;
}

/** The code that speaks one Protocol (ADR 0002). */
export interface ProtocolAdapter {
  /**
   * What a Model with this model id can do, from the adapter's own table: used whenever the Provider cannot be asked
   * (ADR 0004). Unknown model ids get the Protocol's most common capabilities.
   */
  builtInCapabilities(modelId: string): ImageCapabilities;
  /**
   * Asks the Provider what one Model can do. Optional: without it, `builtInCapabilities` always apply.
   * Resolves to undefined when the Provider knows nothing about the model id; a failure is thrown.
   */
  fetchModelInfo?(target: ModelTarget, http: HttpTransport): Promise<ProviderModelInfo | undefined>;
  /** Where the Agent can read which `provider_options` a Model accepts. */
  docsUrl(modelId: string): string;
  /** Request fields the adapter sets itself; `provider_options` may not set them. */
  reservedOptions: readonly string[];
  submit(request: ImageRequest, target: ModelTarget, http: HttpTransport, context: JobContext): Promise<SubmittedJob>;
  /**
   * Asynchronous Protocols only: picks up a Job from the resume handle its `submit` gave, after the litevision that
   * submitted it has gone. Without it, a Job lost with its process is reported as failed.
   */
  resume?(handle: ResumeHandle, target: ModelTarget, http: HttpTransport, context: JobContext): SubmittedJob;
  /**
   * Checks that a Provider's base URL and Credential work with this Protocol, for the settings page's
   * "test connection". Optional: the page reports "not supported yet" for a Protocol without it.
   */
  testConnection?(target: ProviderTarget, http: HttpTransport): Promise<ConnectionResult>;
  /**
   * The model ids a Provider offers through this Protocol, for picking Models in the settings page.
   * Optional: without it, the User types the model id.
   */
  listModelIds?(target: ProviderTarget, http: HttpTransport): Promise<ModelIdsResult>;
}
