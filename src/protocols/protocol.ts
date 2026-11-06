import type { HttpTransport } from "../http.ts";
import type { ParameterGuide, RequestFields, ShapeField } from "./parameter-guide.ts";

/** What a Model generates (ADR 0005). */
export const modalities = ["image", "video"] as const;
export type Modality = (typeof modalities)[number];

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
 * A generation request in litevision's own terms, independent of any Protocol (ADR 0010). It carries no size: the
 * Agent sets the Model's own size fields in `providerOptions`, and without them the Provider's default applies.
 */
export interface ImageRequest {
  /** Sent verbatim. */
  prompt: string;
  /** How many images the Job brings back: the Provider's count field where it has one, else as many requests. */
  n: number;
  /** Empty for text-to-image; never checked against a count. */
  references: ReferenceImage[];
  /** The Agent's options merged over the Standing Options, sent untouched. Never contains an adapter's `reservedOptions`. */
  providerOptions: Record<string, unknown>;
}

/**
 * A video generation request in litevision's own terms (ADR 0010). It carries no shape, tier or length: the Agent
 * sets the Model's own fields in `providerOptions`, and without them the video Model's defaults apply.
 */
export interface VideoRequest {
  prompt: string;
  firstFrame?: ReferenceImage;
  lastFrame?: ReferenceImage;
  references: ReferenceImage[];
  /** Merged into the Provider request untouched. Never contains an adapter's `reservedVideoOptions`. */
  providerOptions: Record<string, unknown>;
}

/** Everything an adapter needs to reach one Model. */
export interface ModelTarget {
  providerId: string;
  baseUrl: string;
  modelId: string;
  credential: string;
}

/** One result file: either its bytes, or a link the Job runner downloads straight away. */
export type GeneratedFile = { bytes: Uint8Array } | { url: string };

/** One result image. */
export type GeneratedImage = GeneratedFile;

/** What a video Job brought back: one video. */
export interface JobVideo {
  video: GeneratedFile;
  /** What the Provider says the Job cost, in its own unit; omitted when it does not say. */
  cost?: number;
}

/** A video Job a Provider has accepted; video Jobs are always asynchronous. */
export interface SubmittedVideoJob {
  wait(): Promise<JobVideo>;
  /** Recorded as soon as the Provider accepts the Job, for `resumeVideo`. */
  resumeHandle: ResumeHandle;
}

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
  /**
   * Resolves after the delay before retry number `retry` (1 for the first), longer for each, which the Job runner
   * sets. Rejects when litevision shuts down, like `pause`.
   */
  backoff(retry: number): Promise<void>;
}

/** `rejected_option`: the Provider answered 400 or 422 naming a parameter of the request, which the Agent can fix. */
export type ProviderErrorKind = "auth" | "balance" | "refusal" | "rate_limit" | "unsupported" | "rejected_option" | "other";

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

/**
 * A Provider's model list, for the settings page. `modalities` gives each model id's Modality when the Provider says;
 * a failure message is plain language and never contains the Credential.
 */
export type ModelIdsResult =
  | { ok: true; modelIds: string[]; modalities?: Record<string, Modality> }
  | { ok: false; message: string };

/** What a Provider itself reports about one of its Models. */
export interface ProviderModelInfo {
  /** The Provider's own description of the Model's request parameters (usually JSON Schema), shown to the Agent as is. */
  parameterSchema?: unknown;
}

/** The code that speaks one Protocol (ADR 0002). */
export interface ProtocolAdapter {
  /**
   * Asks the Provider to describe one Model's parameters; its answer wins over the built-in Parameter Guide (ADR 0010).
   * Optional. Resolves to undefined when the Provider knows nothing about the model id; a failure is thrown.
   */
  fetchModelInfo?(target: ModelTarget, http: HttpTransport): Promise<ProviderModelInfo | undefined>;
  /**
   * Where the Agent can read which `provider_options` a Model accepts: the page for the Model's family where the
   * adapter knows one, else the Provider's API reference (ADR 0006).
   */
  docsUrl(modelId: string, modality?: Modality): string;
  /**
   * The built-in Parameter Guide entry for the model id's family (ADR 0010); undefined when litevision knows no family
   * for it, never a guessed entry.
   */
  parameterGuide?(modelId: string, modality: Modality): ParameterGuide | undefined;
  /**
   * The request fields this Protocol carries the shape (and, for video, the length) in, which the result check reads
   * when the Model's Parameter Guide entry names none of its own, and the resolution tier, which is only reported.
   */
  requestFields: { image: RequestFields; video?: RequestFields };
  /** Request fields the adapter sets itself; `provider_options` may not set them. */
  reservedOptions: readonly string[];
  submit(request: ImageRequest, target: ModelTarget, http: HttpTransport, context: JobContext): Promise<SubmittedJob>;
  /** Video Protocols only (ADR 0005): request fields the adapter sets itself for a video Job. */
  reservedVideoOptions?: readonly string[];
  /** Video Protocols only: submits a video Job. */
  submitVideo?(request: VideoRequest, target: ModelTarget, http: HttpTransport, context: JobContext): Promise<SubmittedVideoJob>;
  /** Video Protocols only: picks a video Job up from the resume handle `submitVideo` gave. */
  resumeVideo?(handle: ResumeHandle, target: ModelTarget, http: HttpTransport, context: JobContext): SubmittedVideoJob;
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
