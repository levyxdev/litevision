import type { HttpTransport } from "../http.ts";
import { ProviderError, type ProviderErrorKind } from "./protocol.ts";

/**
 * Shared Provider error mapping, so every Protocol adapter reports failures with the same kinds and wording.
 * Adapters pass what the Provider said; the Job runner redacts the Credential before anything is shown or recorded.
 */

/** How messages name a Provider, e.g. `Provider "openai"`. */
export function providerLabel(providerId: string): string {
  return `Provider "${providerId}"`;
}

const explanations: Record<ProviderErrorKind, string> = {
  auth: "rejected the Credential. Call `open_settings` so the User can check or replace it in their browser; never ask the User for it in the conversation.",
  balance: "reports insufficient balance or quota. The User needs to add credit or raise their limit with the Provider; or choose another Model.",
  refusal: "refused the request on content grounds. Rephrase the prompt, change the reference images, or choose another Model.",
  rate_limit: "is rate limiting requests. Wait a little and try again, or choose another Model.",
  unsupported: "does not support this request. Choose another Model or change the request.",
  other: "failed to complete the Job.",
};

/** A ProviderError of the given kind, explained in plain language, followed by what the Provider said. */
export function providerError(kind: ProviderErrorKind, providerId: string, detail?: string): ProviderError {
  const said = detail === undefined || detail === "" ? "" : ` The Provider said: ${detail}`;
  return new ProviderError(kind, `${providerLabel(providerId)} ${explanations[kind]}${said}`);
}

/** What a Provider's error response carried, in whatever form its Protocol uses. */
export interface ProviderErrorResponse {
  status: number;
  /** Machine-readable codes or types from the body, e.g. OpenAI's `error.code` and `error.type`, Gemini's `error.status`. */
  codes?: Array<string | null | undefined>;
  /** The human-readable message from the body. */
  message?: string;
}

const patterns: Array<[ProviderErrorKind, RegExp]> = [
  ["balance", /insufficient|quota|billing|balance|credit|payment/i],
  ["refusal", /moderation|content.?policy|safety|nsfw|blocked|prohibited/i],
  ["auth", /api.?key|unauthori[sz]ed|unauthenticated|authentication|permission.?denied|forbidden/i],
  ["rate_limit", /rate.?limit|too.?many.?requests/i],
];

function matchKind(texts: string[]): ProviderErrorKind | undefined {
  return patterns.find(([, pattern]) => texts.some((text) => pattern.test(text)))?.[0];
}

function kindOfStatus(status: number): ProviderErrorKind | undefined {
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "balance";
  if (status === 429) return "rate_limit";
  return undefined;
}

/**
 * Classifies an error response: the Provider's codes first (so OpenAI's 429 `insufficient_quota` is balance, not
 * rate limit), then the HTTP status, then the wording of its message.
 */
export function classifyProviderError(response: ProviderErrorResponse): ProviderErrorKind {
  const codes = (response.codes ?? []).filter((code): code is string => typeof code === "string");
  return matchKind(codes) ?? kindOfStatus(response.status) ?? matchKind([response.message ?? ""]) ?? "other";
}

/** The typed ProviderError for an HTTP error response. */
export function httpProviderError(providerId: string, response: ProviderErrorResponse): ProviderError {
  const detail = response.message === undefined ? `HTTP ${response.status}` : `HTTP ${response.status}: ${response.message}`;
  return providerError(classifyProviderError(response), providerId, detail);
}

/** Sends a request to a Provider; a network failure becomes a ProviderError naming the Provider. */
export async function sendToProvider(
  http: HttpTransport,
  providerId: string,
  url: string,
  init?: RequestInit,
): Promise<Response> {
  try {
    return await http(url, init);
  } catch (error) {
    throw new ProviderError("other", `Could not reach ${providerLabel(providerId)}: ${(error as Error).message}`);
  }
}
