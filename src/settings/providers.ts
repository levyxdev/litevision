import { z } from "zod";
import { providerSchema } from "../config.ts";
import { isPlainObject, readConfigObject, readCredentialsObject, updateConfig, updateCredentials } from "../config-store.ts";
import type { Dirs } from "../dirs.ts";

/** A request the settings API refuses. Its message is shown on the page. */
export class SettingsError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** A Provider as the page sees it: its Credential only ever by its last 4 characters. */
export interface ProviderView {
  id: string;
  baseUrl: string;
  credential: { last4: string } | null;
}

export interface ProviderPreset {
  id: string;
  label: string;
  baseUrl: string;
  /** The Protocol its Models usually speak, used by default for "test connection". */
  protocol: string;
}

export const providerPresets: ProviderPreset[] = [
  { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", protocol: "openai-images" },
  { id: "gemini", label: "Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", protocol: "gemini" },
  { id: "venice", label: "Venice", baseUrl: "https://api.venice.ai/api/v1", protocol: "venice" },
  { id: "apimart", label: "APIMart", baseUrl: "https://api.apimart.ai/v1", protocol: "apimart" },
];

const providerId = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, "A Provider id is 1–64 letters, digits, '.', '_' or '-', starting with a letter or digit.");

const baseUrl = z
  .string()
  .trim()
  .refine((value) => URL.canParse(value) && /^https?:$/.test(new URL(value).protocol), "The base URL must be an http(s) URL.")
  .transform((value) => value.replace(/\/+$/, ""));

const credential = z.string().trim().min(1, "The Credential is empty.");

export const addProviderInput = z.object({ id: providerId, baseUrl, credential: credential.optional() });
export const updateProviderInput = z.object({ baseUrl: baseUrl.optional(), credential: credential.optional() });

const storedProviders = z.array(providerSchema);

/** The Providers in `config.json`, with their Credentials masked. */
export async function listProviders(dirs: Dirs): Promise<ProviderView[]> {
  const providers = providersOf(await readConfigObject(dirs));
  const credentials = await readCredentialsObject(dirs);
  return providers.map((provider) => view(provider.id, provider.baseUrl, credentials[provider.id]?.apiKey));
}

export async function getProvider(dirs: Dirs, id: string): Promise<ProviderView> {
  const provider = (await listProviders(dirs)).find((candidate) => candidate.id === id);
  if (provider === undefined) throw notFound(id);
  return provider;
}

export async function addProvider(dirs: Dirs, input: z.infer<typeof addProviderInput>): Promise<ProviderView> {
  await updateConfig(dirs, (config) => {
    const providers = providersOf(config);
    if (providers.some((provider) => provider.id === input.id)) {
      throw new SettingsError(409, `A Provider named "${input.id}" already exists.`);
    }
    config.providers = [...providers, { id: input.id, baseUrl: input.baseUrl }];
  });
  if (input.credential !== undefined) await saveCredential(dirs, input.id, input.credential);
  return getProvider(dirs, input.id);
}

/** Changes a Provider's base URL and/or replaces its Credential. */
export async function updateProvider(dirs: Dirs, id: string, input: z.infer<typeof updateProviderInput>): Promise<ProviderView> {
  await updateConfig(dirs, (config) => {
    const provider = providersOf(config).find((candidate) => candidate.id === id);
    if (provider === undefined) throw notFound(id);
    if (input.baseUrl !== undefined) provider.baseUrl = input.baseUrl;
  });
  if (input.credential !== undefined) await saveCredential(dirs, id, input.credential);
  return getProvider(dirs, id);
}

export async function removeCredential(dirs: Dirs, id: string): Promise<ProviderView> {
  await getProvider(dirs, id);
  await deleteCredential(dirs, id);
  return getProvider(dirs, id);
}

/** Removes a Provider and its Credential, unless a Model still uses it. */
export async function removeProvider(dirs: Dirs, id: string): Promise<void> {
  await updateConfig(dirs, (config) => {
    const providers = providersOf(config);
    if (!providers.some((provider) => provider.id === id)) throw notFound(id);
    const users = (Array.isArray(config.models) ? config.models : [])
      .filter((model) => isPlainObject(model) && model.provider === id)
      .map((model) => String((model as Record<string, unknown>).alias));
    if (users.length > 0) {
      throw new SettingsError(409, `Provider "${id}" is used by Model(s) ${users.join(", ")}. Remove those Models first.`);
    }
    config.providers = providers.filter((provider) => provider.id !== id);
  });
  await deleteCredential(dirs, id);
}

/** Reads one Provider's saved Credential, for Provider calls only. Never return it to the page. */
export async function savedCredential(dirs: Dirs, id: string): Promise<string | undefined> {
  return (await readCredentialsObject(dirs))[id]?.apiKey;
}

function saveCredential(dirs: Dirs, id: string, apiKey: string): Promise<void> {
  return updateCredentials(dirs, (credentials) => {
    credentials[id] = { ...credentials[id], apiKey };
  });
}

async function deleteCredential(dirs: Dirs, id: string): Promise<void> {
  if ((await readCredentialsObject(dirs))[id] === undefined) return;
  await updateCredentials(dirs, (credentials) => {
    delete credentials[id];
  });
}

/** The stored Provider objects themselves, so edits keep any fields litevision does not know. */
function providersOf(config: Record<string, unknown>): Array<z.infer<typeof providerSchema> & Record<string, unknown>> {
  if (config.providers === undefined) return [];
  const parsed = storedProviders.safeParse(config.providers);
  if (!parsed.success) throw new SettingsError(409, `The Providers in config.json are invalid: ${z.prettifyError(parsed.error)}`);
  return config.providers as Array<z.infer<typeof providerSchema> & Record<string, unknown>>;
}

function view(id: string, baseUrl: string, apiKey: string | undefined): ProviderView {
  return { id, baseUrl, credential: apiKey === undefined ? null : { last4: apiKey.slice(-4) } };
}

function notFound(id: string): SettingsError {
  return new SettingsError(404, `There is no Provider named "${id}".`);
}
