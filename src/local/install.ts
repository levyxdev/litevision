import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, copyFile, link, mkdir, readdir, readFile, rename, rm, rmdir, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, isAbsolute, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { ConfigError, defaultKey } from "../config.ts";
import { isPlainObject, readConfigObject, updateConfig, writeFileAtomic, type ConfigObject } from "../config-store.ts";
import type { Dirs } from "../dirs.ts";
import type { HttpTransport } from "../http.ts";
import { memoryLabel, platformLabel, type Catalog, type LocalModel, type PinnedFile, type Platform, type WeightFile } from "./catalog.ts";
import type { Hardware } from "./hardware.ts";

export type LocalCommand =
  | { kind: "local"; action: "install"; model: string; quant?: string; yes: boolean; force: boolean }
  | { kind: "local"; action: "remove"; model: string; yes: boolean };

export interface LocalDeps {
  dirs: Dirs;
  http: HttpTransport;
  catalog: Catalog;
  hardware: () => Promise<Hardware>;
  /** Asks the User a yes/no question; absent when no one can answer, as when the Agent runs the command. */
  confirm?: (question: string) => Promise<boolean>;
  print: (line: string) => void;
  /** Waits before a download is tried again; tests pass one that does not wait. */
  pause?: (ms: number) => Promise<void>;
}

/** A problem `local install` or `local remove` reports to whoever ran it. */
class LocalError extends Error {}

/** The local Provider: the Runtime at sd-server's default address. */
const localProvider = { id: "local", baseUrl: "http://127.0.0.1:1234" };

/** Runs `local install` or `local remove`; returns the exit code. */
export async function runLocal(command: LocalCommand, deps: LocalDeps): Promise<number> {
  try {
    return command.action === "install" ? await install(command, deps) : await remove(command, deps);
  } catch (error) {
    if (!(error instanceof LocalError || error instanceof ConfigError)) throw error;
    deps.print(error.message);
    return 1;
  }
}

const runtimeRoot = (dirs: Dirs) => join(dirs.home, "runtime");
const modelRoot = (dirs: Dirs) => join(dirs.home, "models");
const recipePath = (dirs: Dirs, model: LocalModel) => join(modelRoot(dirs), "recipes", `${model.recipe.id}.json`);
/** How sd-server names a file in its first model folder: its path there. */
const fileId = (file: WeightFile) => `${file.folder}/${file.name}`;

/** Where a file id from a recipe lives, or undefined for one outside the model folder, which is never touched. */
function weightPath(dirs: Dirs, id: string): string | undefined {
  const path = resolve(modelRoot(dirs), id);
  const inside = relative(modelRoot(dirs), path);
  return inside === "" || inside.startsWith("..") || isAbsolute(inside) ? undefined : path;
}

/** Older ComfyUI folders keep diffusion models in `unet/` and text encoders in `clip/`. */
const comfyFolders: Record<string, string[]> = { diffusion_models: ["diffusion_models", "unet"], text_encoders: ["text_encoders", "clip"] };

function formatSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} kB`;
  return `${bytes} B`;
}

function findModel(catalog: Catalog, name: string): LocalModel {
  const model = catalog.models.find((candidate) => candidate.name === name);
  if (model === undefined) throw new LocalError(`Unknown local Model "${name}". litevision installs: ${catalog.models.map((candidate) => candidate.name).join(", ")}.`);
  return model;
}

/** The quantisation the table chooses for this much memory, or undefined when even the smallest will likely not fit. */
const tableQuant = (model: LocalModel, platform: Platform, memoryGb: number) => model.fit[platform].find(([minimum]) => memoryGb >= minimum)?.[1];

/** Says what fits instead of a quantisation that will likely not: a smaller one, else another Model. */
function alternative(catalog: Catalog, model: LocalModel, platform: Platform, memoryGb: number): string {
  const suggested = tableQuant(model, platform, memoryGb);
  if (suggested !== undefined) return `${suggested} is likely to fit: use --quant ${suggested}.`;
  const other = catalog.models.find((candidate) => candidate !== model && tableQuant(candidate, platform, memoryGb) !== undefined);
  if (other !== undefined) return `${other.title} is likely to fit: npx -y litevision local install ${other.name}`;
  return "No Model litevision installs is likely to fit this machine.";
}

async function sha256Of(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function matches(path: string, file: PinnedFile): Promise<boolean> {
  const size = await stat(path).then((stats) => (stats.isFile() ? stats.size : -1), () => -1);
  return size === file.size && (await sha256Of(path)) === file.sha256;
}

/** Every file under a folder, or none when it does not exist. */
async function filesUnder(root: string): Promise<Array<{ name: string; path: string }>> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isFile()).map((entry) => ({ name: entry.name, path: join(entry.parentPath, entry.name) }));
}

/** A file in the User's own model folders with the same contents, found by size, then hash, in its ComfyUI category. */
async function findReusable(folders: string[], file: WeightFile): Promise<string | undefined> {
  for (const folder of folders) {
    for (const category of comfyFolders[file.folder] ?? [file.folder]) {
      for (const { path } of await filesUnder(join(folder, category))) if (await matches(path, file)) return path;
    }
  }
  return undefined;
}

function modelFolders(config: ConfigObject): string[] {
  const folders = config.localModelFolders;
  return Array.isArray(folders) ? folders.filter((folder): folder is string => typeof folder === "string") : [];
}

/** How many times one download is tried before the install stops; each try resumes where the last one stopped. */
const downloadAttempts = 5;

/** A server's refusal, such as 404, which trying again would not change, unlike a dropped connection or a server error. */
class HttpRefusal extends Error {}

/**
 * Downloads a pinned file to `target` through `<target>.partial`, resuming with a Range request after a dropped
 * connection, also in a later install, and checks its SHA-256 once whole.
 */
async function download(file: PinnedFile, target: string, label: string, deps: LocalDeps): Promise<void> {
  deps.print(`Downloading ${label} (${formatSize(file.size)})…`);
  await mkdir(dirname(target), { recursive: true });
  const partial = `${target}.partial`;
  let reported = 0;
  for (let attempt = 1; ; attempt++) {
    try {
      await downloadOnce(file, partial, (received) => {
        // Reports progress on large files.
        const tenths = Math.floor((received / file.size) * 10);
        if (file.size > 1e8 && tenths > reported && tenths < 10) {
          reported = tenths;
          deps.print(`  ${tenths * 10}%`);
        }
      }, deps);
      break;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const failed = `Downloading ${label} from ${file.url} failed: ${reason}`;
      if (error instanceof HttpRefusal) throw new LocalError(failed);
      if (attempt === downloadAttempts) throw new LocalError(`${failed} Run the same command again to resume.`);
      deps.print(`  ${reason} Trying again (${attempt + 1} of ${downloadAttempts})…`);
      await (deps.pause ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(2000 * attempt);
    }
  }
  if ((await sha256Of(partial)) !== file.sha256) {
    await rm(partial, { force: true });
    throw new LocalError(`${label} does not match its pinned SHA-256, so it was deleted and the install stopped. Try again; if it fails again, the file at ${file.url} has changed.`);
  }
  await rename(partial, target);
}

/** One try: asks for the bytes after what `partial` already holds, and appends them, or starts over if the server sends it all. */
async function downloadOnce(file: PinnedFile, partial: string, progress: (received: number) => void, deps: LocalDeps): Promise<void> {
  const have = await stat(partial).then((info) => (info.size < file.size ? info.size : 0), () => 0);
  const response = await deps.http(file.url, have > 0 ? { headers: { range: `bytes=${have}-` } } : undefined);
  const resumed = have > 0 && response.status === 206;
  if (response.status === 416) {
    // What `partial` holds no longer fits the file: the next try starts over.
    await rm(partial, { force: true });
    throw new Error("HTTP 416.");
  }
  if (!response.ok || response.body === null) {
    const refusal = response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429;
    throw new (refusal ? HttpRefusal : Error)(`HTTP ${response.status}.`);
  }
  let received = resumed ? have : 0;
  const counting = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      received += chunk.length;
      progress(received);
      done(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), counting, createWriteStream(partial, { flags: resumed ? "a" : "w" }));
}

/** Extracts a zip with the system's bsdtar: built into macOS and Windows 10 and later. */
async function extract(archive: string, into: string): Promise<void> {
  const tar = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
  await mkdir(into, { recursive: true });
  await promisify(execFile)(tar, ["-xf", archive, "-C", into]);
}

async function findFile(root: string, name: string): Promise<string | undefined> {
  return (await filesUnder(root)).find((file) => file.name === name)?.path;
}

/** The installed sd-server binary for this litevision's pinned build, if it is there. */
function runtimeBinary(dirs: Dirs, catalog: Catalog, platform: Platform): Promise<string | undefined> {
  const build = catalog.runtime[platform];
  return findFile(join(runtimeRoot(dirs), build.tag), build.binary);
}

/** Downloads and extracts the pinned Runtime build into `runtime/<tag>/`, which appears only once it is complete. */
async function installRuntime(platform: Platform, deps: LocalDeps): Promise<void> {
  const build = deps.catalog.runtime[platform];
  const staging = join(runtimeRoot(deps.dirs), `${build.tag}.partial`);
  await rm(staging, { recursive: true, force: true });
  let binaryDir = staging;
  for (const [index, archive] of build.archives.entries()) {
    const zip = join(runtimeRoot(deps.dirs), `${build.tag}.${index}.zip`);
    await download(archive, zip, `the Runtime (sd-server ${build.tag}), ${basename(new URL(archive.url).pathname)}`, deps);
    try {
      await extract(zip, binaryDir);
    } catch (error) {
      throw new LocalError(`Extracting the Runtime archive ${archive.url} failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await rm(zip, { force: true });
    }
    if (index === 0) {
      const binary = await findFile(staging, build.binary);
      if (binary === undefined) throw new LocalError(`The Runtime archive ${archive.url} holds no ${build.binary}.`);
      await chmod(binary, 0o755);
      binaryDir = dirname(binary);
    }
  }
  // A folder left without its binary, by an interrupted install or by hand, is replaced.
  await rm(join(runtimeRoot(deps.dirs), build.tag), { recursive: true, force: true });
  await rename(staging, join(runtimeRoot(deps.dirs), build.tag));
}

/** Deletes Runtime builds other than this litevision's, once it is installed. One the system will not delete is reported. */
async function removeOutdatedRuntimes(platform: Platform, deps: LocalDeps): Promise<void> {
  const current = deps.catalog.runtime[platform].tag;
  for (const entry of await readdir(runtimeRoot(deps.dirs)).catch(() => [])) {
    if (entry === current) continue;
    await rm(join(runtimeRoot(deps.dirs), entry), { recursive: true, force: true }).catch(() => {
      deps.print(`Could not delete the outdated Runtime runtime/${entry}; it may still be running.`);
    });
  }
}

interface InstalledRecipe {
  id: string;
  /** The files it names, by sd-server's file id. */
  files: string[];
}

/** Every recipe in the Runtime's model folder, litevision's or the User's: what decides which files are in use. */
async function readRecipes(dirs: Dirs): Promise<InstalledRecipe[]> {
  const folder = join(modelRoot(dirs), "recipes");
  const recipes: InstalledRecipe[] = [];
  for (const name of await readdir(folder).catch(() => [])) {
    if (!name.endsWith(".json")) continue;
    const value: unknown = await readFile(join(folder, name), "utf8").then(JSON.parse, () => undefined);
    if (!isPlainObject(value)) continue;
    const files = isPlainObject(value.models) ? Object.values(value.models).filter((file): file is string => typeof file === "string") : [];
    recipes.push({ id: typeof value.id === "string" ? value.id : name.replace(/\.json$/, ""), files });
  }
  return recipes;
}

/** Deletes weight files no recipe names any more. */
async function deleteUnused(dirs: Dirs, candidates: string[]): Promise<void> {
  const used = new Set((await readRecipes(dirs)).flatMap((recipe) => recipe.files));
  for (const file of candidates) {
    const path = weightPath(dirs, file);
    if (!used.has(file) && path !== undefined) await rm(path, { force: true });
  }
}

/** Removes each folder that is now empty, and the folders above it up to and including `root`; never one with files. */
async function removeEmptyFolders(root: string, folders: string[]): Promise<void> {
  for (const folder of new Set(folders)) {
    for (let current = folder; current === root || current.startsWith(root + sep); current = dirname(current)) {
      // rmdir refuses a folder that is not empty, so a folder with anything left in it stays.
      if (!(await rmdir(current).then(() => true, () => false))) break;
      if (current === root) break;
    }
  }
}

const modelsOf = (config: ConfigObject): Array<Record<string, unknown>> => (Array.isArray(config.models) ? config.models.filter(isPlainObject) : []);
const isInstalledModel = (model: Record<string, unknown>, local: LocalModel) => model.provider === localProvider.id && model.modelId === local.recipe.id;

/** The Model's name as its Alias, or, when another Model has it, the first free `<name>-2`, `<name>-3`, … */
function freeAlias(config: ConfigObject, model: LocalModel): string {
  const taken = new Set(modelsOf(config).map((candidate) => candidate.alias));
  let alias = model.name;
  for (let number = 2; taken.has(alias); number++) alias = `${model.name}-${number}`;
  return alias;
}

async function ask(deps: LocalDeps, yes: boolean, question: string, nothingDone: string): Promise<boolean> {
  if (yes) return true;
  if (deps.confirm === undefined) {
    deps.print(`${nothingDone} Run again with --yes once the User agrees.`);
    return false;
  }
  if (await deps.confirm(question)) return true;
  deps.print(nothingDone);
  return false;
}

async function install(command: Extract<LocalCommand, { action: "install" }>, deps: LocalDeps): Promise<number> {
  const { dirs, catalog, print } = deps;
  const model = findModel(catalog, command.model);
  const quants = Object.keys(model.quants);
  if (command.quant !== undefined && !quants.includes(command.quant)) {
    throw new LocalError(`${model.title} has no quantisation "${command.quant}". Choose one of: ${quants.join(", ")}.`);
  }
  const hardware = await deps.hardware();
  if (hardware.platform === undefined) {
    throw new LocalError(`litevision has no Runtime build for ${hardware.name}. Local Models run on ${Object.values(platformLabel).join(" and on ")}.`);
  }
  const { platform, memoryGb } = hardware;
  const config = await readConfigObject(dirs);

  const memory = `${memoryGb} GB ${memoryLabel[platform]}`;
  const suggested = tableQuant(model, platform, memoryGb);
  const quant = command.quant ?? suggested ?? model.fit[platform].at(-1)![1];
  const fits = suggested !== undefined && quants.indexOf(quant) >= quants.indexOf(suggested);

  print(`${model.title} (${model.name}): ${model.does}.`);
  print(`${model.licence.commercial ? "" : "Non-commercial use only. "}Licence: ${model.licence.name}, ${model.licence.terms}: ${model.licence.url}`);
  print(`Speed: ${model.speed}.`);
  print(command.quant === undefined ? `Quantisation: ${quant}, for ${memory}. Others, with --quant: ${quants.filter((other) => other !== quant).join(", ")}.` : `Quantisation: ${quant}.`);
  if (!fits) print(`Warning: ${model.title} at ${quant} will likely not fit in ${memory}. ${alternative(catalog, model, platform, memoryGb)}`);

  // What is already in place, what can be reused from the User's own model folders, and what must be downloaded.
  const files = Object.entries({ ...model.files, ...model.quants[quant] });
  const target = (file: WeightFile) => join(modelRoot(dirs), file.folder, file.name);
  const folders = modelFolders(config);
  const reuse: Array<[WeightFile, string]> = [];
  const toDownload: WeightFile[] = [];
  for (const [, file] of files) {
    if (await matches(target(file), file)) continue;
    const found = await findReusable(folders, file);
    if (found === undefined) toDownload.push(file);
    else reuse.push([file, found]);
  }
  const build = catalog.runtime[platform];
  const runtimeMissing = (await runtimeBinary(dirs, catalog, platform)) === undefined;
  const downloads: Array<[string, number]> = [
    ...(runtimeMissing ? build.archives.map((archive): [string, number] => [`Runtime sd-server ${build.tag} for ${platformLabel[platform]}`, archive.size]) : []),
    ...toDownload.map((file): [string, number] => [fileId(file), file.size]),
  ];
  const total = formatSize(downloads.reduce((sum, [, size]) => sum + size, 0));

  if (downloads.length === 0) print("Nothing to download.");
  else {
    print(`To download (${total}), into ${dirs.home}:`);
    for (const [label, size] of downloads) print(`  ${label} (${formatSize(size)})`);
  }
  for (const [, found] of reuse) print(`Reused instead of downloaded: ${found}`);

  if (!fits && !command.force) {
    print("Nothing downloaded. Pass --force to install it anyway.");
    return 1;
  }
  if (downloads.length > 0 && !(await ask(deps, command.yes, `Download ${total}?`, "Nothing downloaded."))) {
    return 1;
  }

  if (runtimeMissing) await installRuntime(platform, deps);
  for (const [file, found] of reuse) {
    await mkdir(dirname(target(file)), { recursive: true });
    await rm(target(file), { force: true });
    // A hard link takes no more disk space; another volume needs a copy.
    await link(found, target(file)).catch(async () => {
      print(`${found} is on another volume, so it is copied, taking ${formatSize(file.size)} more.`);
      await copyFile(found, target(file));
    });
  }
  for (const file of toDownload) await download(file, target(file), fileId(file), deps);

  const previous = (await readRecipes(dirs)).find((recipe) => recipe.id === model.recipe.id)?.files ?? [];
  const recipe = { ...model.recipe, models: Object.fromEntries(files.map(([slot, file]) => [slot, fileId(file)])) };
  await writeFileAtomic(recipePath(dirs, model), `${JSON.stringify(recipe, null, 2)}\n`);
  await deleteUnused(dirs, previous);

  let alias = "";
  await updateConfig(dirs, (stored) => {
    const providers = Array.isArray(stored.providers) ? stored.providers : [];
    if (!providers.some((provider) => isPlainObject(provider) && provider.id === localProvider.id)) stored.providers = [...providers, { ...localProvider }];
    const models = modelsOf(stored);
    const installed = models.find((candidate) => isInstalledModel(candidate, model));
    alias = typeof installed?.alias === "string" ? installed.alias : freeAlias(stored, model);
    if (installed === undefined) {
      stored.models = [...models, { alias, provider: localProvider.id, modelId: model.recipe.id, protocol: "sdcpp", modality: "image" }];
    }
  });
  await removeOutdatedRuntimes(platform, deps);
  print(`Installed ${model.title}. The Agent uses it with model "${alias}".`);
  return 0;
}

async function remove(command: Extract<LocalCommand, { action: "remove" }>, deps: LocalDeps): Promise<number> {
  const { dirs, print } = deps;
  const model = findModel(deps.catalog, command.model);
  const recipes = await readRecipes(dirs);
  const installed = recipes.find((recipe) => recipe.id === model.recipe.id);
  const configured = modelsOf(await readConfigObject(dirs)).filter((candidate) => isInstalledModel(candidate, model));
  if (installed === undefined && configured.length === 0) throw new LocalError(`${model.title} (${model.name}) is not installed.`);

  const others = recipes.filter((recipe) => recipe !== installed);
  const files = (installed?.files ?? []).filter((file) => weightPath(dirs, file) !== undefined);
  const usedBy = (file: string) => others.filter((recipe) => recipe.files.includes(file)).map((recipe) => recipe.id);
  const deleted = files.filter((file) => usedBy(file).length === 0);
  let freed = 0;
  for (const file of deleted) freed += await stat(weightPath(dirs, file)!).then((stats) => stats.size, () => 0);

  print(`Removing ${model.title} (${model.name}):`);
  for (const file of deleted) print(`  delete models/${file}`);
  for (const file of files.filter((candidate) => !deleted.includes(candidate))) print(`  keep models/${file}, used by ${usedBy(file).join(", ")}`);
  for (const configuredModel of configured) print(`  remove the Model "${String(configuredModel.alias)}" from the configuration`);
  if (!(await ask(deps, command.yes, `Delete ${formatSize(freed)}?`, "Nothing deleted."))) return 1;

  for (const file of deleted) await rm(weightPath(dirs, file)!, { force: true });
  await rm(recipePath(dirs, model), { force: true });
  await removeEmptyFolders(modelRoot(dirs), [...deleted.map((file) => dirname(weightPath(dirs, file)!)), dirname(recipePath(dirs, model))]);
  await updateConfig(dirs, (stored) => {
    const aliases = modelsOf(stored).filter((candidate) => isInstalledModel(candidate, model)).map((candidate) => candidate.alias);
    stored.models = modelsOf(stored).filter((candidate) => !isInstalledModel(candidate, model));
    for (const key of Object.values(defaultKey)) if (aliases.includes(stored[key])) delete stored[key];
  });
  print(`Removed ${model.title}; ${formatSize(freed)} freed.`);
  return 0;
}
