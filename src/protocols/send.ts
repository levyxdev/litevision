import type { HttpTransport } from "../http.ts";
import { providerLabel } from "./errors.ts";
import { ProviderError, type JobContext } from "./protocol.ts";

/** How many times a request is sent again after its first attempt. */
const maxRetries = 2;

export interface SendOptions {
  /** Lends the growing delay before each retry. */
  context: JobContext;
  /**
   * A status check of a Job the Provider has already accepted. Sending it again cannot start a second Job, so any
   * passing failure is retried: a network error, a timeout, any 5xx, and rate limiting of the checks.
   */
  poll?: boolean;
}

/**
 * Sends one request of a Job and returns the Provider's answer, error statuses included, for the adapter to read.
 * It is retried only where the Provider certainly did not process it, so a passing outage costs the Agent no turn and
 * the User no second charge. A network failure becomes a ProviderError naming the Provider. Retries happen here, so
 * the Job history sees only the final outcome.
 */
export async function sendToProvider(
  http: HttpTransport,
  providerId: string,
  url: string,
  init: RequestInit | undefined,
  { context, poll = false }: SendOptions,
): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    const last = attempt > maxRetries;
    try {
      const response = await http(url, init);
      if (last || !retryableStatus(response.status, poll)) return response;
      await response.body?.cancel().catch(() => undefined);
    } catch (error) {
      const stage = stageOf(error);
      if (last || (!poll && stage !== "before-send")) throw networkError(providerId, error, stage, poll, attempt);
    }
    await context.backoff(attempt);
  }
}

/** 502, 503 and 504 come from a gateway in front of the Provider, so the Provider never saw the request. */
function retryableStatus(status: number, poll: boolean): boolean {
  if (poll) return status >= 500 || status === 429;
  return status === 502 || status === 503 || status === 504;
}

/** How far a failed request got: the stage decides whether the Provider may have processed it. */
type Stage = "before-send" | "timeout" | "unknown";

/** Errors raised while looking up or connecting to the host, before any of the request was written. */
const beforeSendCodes = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "ENETDOWN",
  "EHOSTUNREACH",
  "EHOSTDOWN",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/** Errors raised while waiting for an answer to a request already sent. */
const timeoutCodes = new Set(["UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "ETIMEDOUT", "TimeoutError", "Timeout"]);

/**
 * Reads where a network failure happened from the error and its cause, as Node's `fetch` (undici) reports them. A
 * failed connect or host lookup comes first, so an `ETIMEDOUT` while connecting still counts as before sending.
 * Anything unrecognised is "unknown", and treated as possibly processed.
 */
function stageOf(error: unknown): Stage {
  const layers = [error, (error as { cause?: unknown } | null)?.cause].filter(
    (layer): layer is { code?: unknown; name?: unknown; syscall?: unknown } => typeof layer === "object" && layer !== null,
  );
  const names = layers.flatMap((layer) => [layer.code, layer.name]).filter((name): name is string => typeof name === "string");
  if (layers.some((layer) => layer.syscall === "connect" || layer.syscall === "getaddrinfo")) return "before-send";
  if (names.some((name) => beforeSendCodes.has(name))) return "before-send";
  if (names.some((name) => timeoutCodes.has(name))) return "timeout";
  return "unknown";
}

/** An error's message with its cause's, since `fetch` says only "fetch failed" and puts the reason in the cause. */
function describe(error: unknown): string {
  const message = (error as Error | null)?.message ?? String(error);
  const cause = (error as { cause?: unknown } | null)?.cause;
  const reason = cause instanceof Error ? cause.message : undefined;
  return reason === undefined || reason === message ? message : `${message}: ${reason}`;
}

function networkError(providerId: string, error: unknown, stage: Stage, poll: boolean, attempts: number): ProviderError {
  const label = providerLabel(providerId);
  const tries = attempts > 1 ? ` (tried ${attempts} times)` : "";
  if (poll || stage === "before-send") return new ProviderError("other", `Could not reach ${label}${tries}: ${describe(error)}`);
  const what = stage === "timeout" ? `${label} did not answer in time` : `The connection to ${label} failed`;
  return new ProviderError(
    "other",
    `${what} after the request was sent: ${describe(error)}. The Provider may have processed the request and charged for it, so litevision did not send it again. Tell the User before trying again.`,
  );
}
