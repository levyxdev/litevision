import { providerError, providerLabel } from "./errors.ts";
import type { GeneratedImage, JobImages } from "./protocol.ts";

/**
 * For Models that return one image per request: sends `n` requests at once and keeps whatever comes back.
 * Only when every request fails does the Job fail, with the first request's error.
 */
export async function inParallel(n: number, providerId: string, send: () => Promise<GeneratedImage[]>): Promise<JobImages> {
  const settled = await Promise.allSettled(Array.from({ length: n }, () => send()));
  const images = settled.flatMap((outcome) => (outcome.status === "fulfilled" ? outcome.value : []));
  const failures = settled.flatMap((outcome) => (outcome.status === "rejected" ? [outcome.reason as Error] : []));
  if (images.length === 0) throw failures[0] ?? providerError("other", providerId, "it returned no images.");
  if (failures.length === 0) return { images };
  return {
    images,
    shortfall: `${failures.length} of ${n} requests to ${providerLabel(providerId)} failed: ${failures[0]!.message}`,
  };
}
