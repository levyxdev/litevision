import type { HttpTransport } from "../http.ts";

/** A generation request in litevision's own terms, independent of any Protocol. */
export interface ImageRequest {
  /** Sent verbatim. */
  prompt: string;
  n: number;
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

/** The code that speaks one Protocol (ADR 0002). */
export interface ProtocolAdapter {
  submit(request: ImageRequest, target: ModelTarget, http: HttpTransport): Promise<SubmittedJob>;
}
