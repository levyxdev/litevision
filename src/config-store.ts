import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ConfigError, credentialsSchema } from "./config.ts";
import type { Dirs } from "./dirs.ts";

/** `config.json` as stored: every field is kept, including ones this version of litevision does not know. */
export type ConfigObject = Record<string, unknown>;

/** `credentials.json` as stored: Credentials by Provider id. */
export type CredentialsObject = Record<string, { apiKey: string } & Record<string, unknown>>;

export const configPath = (dirs: Dirs) => join(dirs.config, "config.json");
export const credentialsPath = (dirs: Dirs) => join(dirs.config, "credentials.json");

export async function readConfigObject(dirs: Dirs): Promise<ConfigObject> {
  const path = configPath(dirs);
  const value = await readJsonFile(path);
  if (value === undefined) return {};
  if (!isPlainObject(value)) throw new ConfigError(`${path} is not a JSON object, so litevision will not change it. Fix or remove it.`);
  return value;
}

/** Reads the Credentials. Never include a value from the result in anything shown to the Agent. */
export async function readCredentialsObject(dirs: Dirs): Promise<CredentialsObject> {
  const value = (await readJsonFile(credentialsPath(dirs))) ?? {};
  // Only the shape is reported, so a malformed file never echoes its contents in an error.
  if (!credentialsSchema.safeParse(value).success) {
    throw new ConfigError("credentials.json is malformed, so litevision will not change it. Fix or remove it.");
  }
  return value as CredentialsObject;
}

/**
 * Changes `config.json` in place: `change` edits the stored object, and every field it leaves alone is kept.
 * Writes are atomic, so a running MCP server never reads a half-written file.
 */
export function updateConfig<T>(dirs: Dirs, change: (config: ConfigObject) => T): Promise<T> {
  return serialised(configPath(dirs), async () => {
    const config = await readConfigObject(dirs);
    const result = change(config);
    await writeFileAtomic(configPath(dirs), `${JSON.stringify(config, null, 2)}\n`);
    return result;
  });
}

/** Like {@link updateConfig}, for `credentials.json`, which always ends up with mode 600. */
export function updateCredentials<T>(dirs: Dirs, change: (credentials: CredentialsObject) => T): Promise<T> {
  return serialised(credentialsPath(dirs), async () => {
    const credentials = await readCredentialsObject(dirs);
    const result = change(credentials);
    await writeFileAtomic(credentialsPath(dirs), `${JSON.stringify(credentials, null, 2)}\n`, 0o600);
    return result;
  });
}

/** Writes a temporary file next to `path`, then renames it over `path`. */
export async function writeFileAtomic(path: string, text: string, mode = 0o644): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, text, { mode, flag: "wx" });
    // The umask may have narrowed `mode`; set it exactly, before the file becomes visible.
    await chmod(temporary, mode);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

const queues = new Map<string, Promise<unknown>>();

/** Runs read-change-write cycles on one file one at a time within this process. */
function serialised<T>(path: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(path) ?? Promise.resolve();
  const next = previous.then(task);
  const settled = next.catch(() => undefined);
  queues.set(path, settled);
  void settled.then(() => {
    if (queues.get(path) === settled) queues.delete(path);
  });
  return next;
}

async function readJsonFile(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch {
    const name = path.endsWith("credentials.json") ? "credentials.json" : path;
    throw new ConfigError(`${name} is not valid JSON, so litevision will not change it. Fix or remove it.`);
  }
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
