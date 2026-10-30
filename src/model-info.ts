import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ConfigError, loadConfig, requireCredential, type ResolvedModel } from "./config.ts";
import { serialised, writeFileAtomic } from "./config-store.ts";
import type { Dirs } from "./dirs.ts";
import type { HttpTransport } from "./http.ts";
import { adapterFor } from "./protocols/index.ts";
import { aspectRatios, type ImageCapabilities, type ProviderModelInfo } from "./protocols/protocol.ts";

/**
 * What litevision knows about one Model: its capabilities, asked of the Provider where its Protocol can, and cached
 * (ADR 0004).
 */

export interface ModelInfoDeps {
  dirs: Dirs;
  http: HttpTransport;
  now: () => Date;
  /** How long to wait for the Provider before falling back; defaults to {@link defaultModelInfoTimeoutMs}. */
  timeoutMs?: number;
}

export interface ModelInfo {
  capabilities: ImageCapabilities;
  /** "provider" when the Provider reported the capabilities, "built-in" when they come from the adapter's own table. */
  source: "provider" | "built-in";
  docsUrl: string;
  /** The Provider's own description of the Model's parameters, when it publishes one. */
  parameterSchema?: unknown;
}

/** A day: Providers change their Models rarely, and the settings page refreshes whenever the User touches one. */
export const modelInfoTtlMs = 24 * 60 * 60 * 1000;

export const defaultModelInfoTimeoutMs = 5000;

const sizeSchema = z.object({
  aspectRatio: z.enum(aspectRatios),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

const capabilitiesSchema = z.object({
  sizes: z.array(sizeSchema).min(1),
  maxReferences: z.number().int().nonnegative(),
  maxImages: z.number().int().positive(),
});

const entrySchema = z.object({
  fetchedAt: z.string(),
  /** Null when the Provider had nothing to say about the model id. */
  capabilities: capabilitiesSchema.nullable(),
  parameterSchema: z.unknown().optional(),
});

type CacheEntry = z.infer<typeof entrySchema>;

const cachePath = (dirs: Dirs) => join(dirs.data, "capabilities.json");

/** Keyed by where the Model lives rather than its Alias, which the User may rename. */
function cacheKey({ model, provider }: ResolvedModel): string {
  return `${model.protocol} ${provider.baseUrl} ${model.modelId}`;
}

/**
 * Everything known about a Model. Asks the Provider when the cached answer is missing or older than a day, or when
 * `refresh` is set; when the Provider cannot be asked, falls back to the cached answer, then to the built-in one.
 */
export async function modelInfo(deps: ModelInfoDeps, resolved: ResolvedModel, options: { refresh?: boolean } = {}): Promise<ModelInfo> {
  const adapter = adapterFor(resolved.model);
  const builtIn: ModelInfo = {
    capabilities: adapter.builtInCapabilities(resolved.model.modelId),
    source: "built-in",
    docsUrl: adapter.docsUrl(resolved.model.modelId),
  };
  const fetchModelInfo = adapter.fetchModelInfo;
  if (fetchModelInfo === undefined) return builtIn;

  const key = cacheKey(resolved);
  const cached = (await readCache(deps.dirs))[key];
  const fresh = cached !== undefined && deps.now().getTime() - Date.parse(cached.fetchedAt) < modelInfoTtlMs;
  let entry = fresh && !options.refresh ? cached : undefined;

  if (entry === undefined) {
    const credential = await requireCredential(deps.dirs, resolved.provider).catch((error: unknown) => {
      if (error instanceof ConfigError) return undefined;
      throw error;
    });
    const reported =
      credential === undefined
        ? undefined
        : await withTimeout(
            fetchModelInfo.call(
              adapter,
              { providerId: resolved.provider.id, baseUrl: resolved.provider.baseUrl, modelId: resolved.model.modelId, credential },
              deps.http,
            ),
            deps.timeoutMs ?? defaultModelInfoTimeoutMs,
          ).then(
            (info) => ({ info }),
            () => undefined,
          );
    if (reported !== undefined) {
      entry = toEntry(reported.info, deps.now());
      await writeCacheEntry(deps.dirs, key, entry);
    } else {
      entry = cached;
    }
  }

  if (entry === undefined) return builtIn;
  return {
    ...builtIn,
    ...(entry.capabilities === null ? {} : { capabilities: entry.capabilities, source: "provider" as const }),
    ...(entry.parameterSchema === undefined ? {} : { parameterSchema: entry.parameterSchema }),
  };
}

/** Asks the Provider again about the Model with this Alias, e.g. after the User added it. Never fails. */
export async function refreshModelInfo(deps: ModelInfoDeps, alias: string): Promise<void> {
  await refreshMatching(deps, (resolved) => resolved.model.alias === alias);
}

/** Asks the Provider again about each of its Models that use `protocol`, e.g. after a successful "test connection". Never fails. */
export async function refreshProviderModelInfo(deps: ModelInfoDeps, providerId: string, protocol: string): Promise<void> {
  await refreshMatching(deps, (resolved) => resolved.provider.id === providerId && resolved.model.protocol === protocol);
}

async function refreshMatching(deps: ModelInfoDeps, wanted: (resolved: ResolvedModel) => boolean): Promise<void> {
  try {
    const config = await loadConfig(deps.dirs);
    const resolved = config.models.flatMap((model) => {
      const provider = config.providers.find((candidate) => candidate.id === model.provider);
      return provider === undefined ? [] : [{ model, provider }];
    });
    await Promise.all(resolved.filter(wanted).map((model) => modelInfo(deps, model, { refresh: true }).catch(() => undefined)));
  } catch {
    // Refreshing is a courtesy; a broken configuration is reported where the User is editing it.
  }
}

/** Validates what an adapter reported, so a Provider's odd answer can never break `generate_image`. */
function toEntry(info: ProviderModelInfo | undefined, now: Date): CacheEntry {
  const capabilities = capabilitiesSchema.safeParse(info?.capabilities);
  return {
    fetchedAt: now.toISOString(),
    capabilities: capabilities.success ? capabilities.data : null,
    ...(info?.parameterSchema === undefined ? {} : { parameterSchema: info.parameterSchema }),
  };
}

async function readCache(dirs: Dirs): Promise<Record<string, CacheEntry>> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(cachePath(dirs), "utf8"));
  } catch {
    // Missing or unreadable: the cache is only a cache.
    return {};
  }
  const parsed = z.record(z.string(), z.unknown()).safeParse(value);
  if (!parsed.success) return {};
  const entries: Record<string, CacheEntry> = {};
  for (const [key, raw] of Object.entries(parsed.data)) {
    const entry = entrySchema.safeParse(raw);
    if (entry.success) entries[key] = entry.data;
  }
  return entries;
}

function writeCacheEntry(dirs: Dirs, key: string, entry: CacheEntry): Promise<void> {
  return serialised(cachePath(dirs), async () => {
    const entries = await readCache(dirs);
    entries[key] = entry;
    await writeFileAtomic(cachePath(dirs), `${JSON.stringify(entries, null, 2)}\n`);
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`No answer within ${ms} ms.`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
