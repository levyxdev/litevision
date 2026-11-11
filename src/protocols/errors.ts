import { optionKeyOf } from "./parameter-guide.ts";
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
  rejected_option:
    "rejected an option in the request. Fix it using what the Provider said and the Model's docs, and try again; if it names the prompt or the number of images, change that instead.",
  other: "failed to complete the Job.",
};

/** Where a ProviderError's message turns from litevision's explanation to what the Provider said. */
const saidMarker = " The Provider said: ";

/**
 * A ProviderError of the given kind, explained in plain language, followed by what the Provider said; `options` are
 * the `provider_options` keys it named.
 */
export function providerError(kind: ProviderErrorKind, providerId: string, detail?: string, options: readonly string[] = []): ProviderError {
  const said = detail === undefined || detail === "" ? "" : `${saidMarker}${detail}`;
  return new ProviderError(kind, `${providerLabel(providerId)} ${explanations[kind]}${said}`, options);
}

/** What a Provider's error response carried, in whatever form its Protocol uses. */
export interface ProviderErrorResponse {
  status: number;
  /** Machine-readable codes or types from the body, e.g. OpenAI's `error.code` and `error.type`, Gemini's `error.status`. */
  codes?: Array<string | null | undefined>;
  /** The human-readable message from the body. */
  message?: string;
  /** The request parameter the body names as the problem, where the Protocol has a field for it (OpenAI's `error.param`). */
  param?: string | null;
  /** The `provider_options` keys the request sent: a 400 or 422 whose message names one rejected that option. */
  options?: readonly string[];
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

/** The parameters a 400 or 422 answer names: its own field for one, and any `provider_options` key its message mentions. */
function namedParameters(response: ProviderErrorResponse): string[] {
  if (response.status !== 400 && response.status !== 422) return [];
  const message = response.message ?? "";
  const mentioned = (response.options ?? []).filter((name) => namesOption(message, name));
  return [...(response.param ? [response.param] : []), ...mentioned];
}

/** Whether a Provider's message names a `provider_options` key, as a word of its own. */
export function namesOption(message: string, key: string): boolean {
  return new RegExp(`(^|[^\\w])${escapeRegExp(key)}($|[^\\w])`).test(message);
}

/** What the Provider itself said in a failed Job's error message, without litevision's explanation; undefined when it said nothing. */
export function providerSaid(message: string): string | undefined {
  const at = message.indexOf(saidMarker);
  return at === -1 ? undefined : message.slice(at + saidMarker.length);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Classifies an error response: the Provider's codes first (so OpenAI's 429 `insufficient_quota` is balance, not
 * rate limit), then the HTTP status, then the wording of its message, then whether it names a parameter it rejected.
 * The named parameters are left out of the wording, since a name says nothing about the problem: rejecting
 * `safety_tolerance` is a rejected option, but a prompt "flagged by the safety filter" is still a refusal.
 */
export function classifyProviderError(response: ProviderErrorResponse): ProviderErrorKind {
  const codes = (response.codes ?? []).filter((code): code is string => typeof code === "string");
  const named = namedParameters(response);
  const wording = named.reduce((text, name) => text.split(name).join(""), response.message ?? "");
  return matchKind(codes) ?? kindOfStatus(response.status) ?? matchKind([wording]) ?? (named.length > 0 ? "rejected_option" : "other");
}

/**
 * The typed ProviderError for an HTTP error response. A rejected option carries the `provider_options` keys the answer
 * named, in its own field or in its message, so the Job history can record them as Rejected (ADR 0011).
 */
export function httpProviderError(providerId: string, response: ProviderErrorResponse): ProviderError {
  const detail = response.message === undefined ? `HTTP ${response.status}` : `HTTP ${response.status}: ${response.message}`;
  const kind = classifyProviderError(response);
  const sent = new Set(response.options ?? []);
  const named = kind === "rejected_option" ? [...new Set(namedParameters(response).map(optionKeyOf))].filter((key) => sent.has(key)) : [];
  return providerError(kind, providerId, detail, named);
}
