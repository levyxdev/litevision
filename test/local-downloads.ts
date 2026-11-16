import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { catalog, type Catalog, type PinnedFile } from "../src/local/catalog.ts";
import type { Routes } from "./recorded-http.ts";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** A zip holding the given files, made with the system's bsdtar, which `local install` also extracts with. */
async function zip(files: Record<string, string>): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "litevision-zip-"));
  try {
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(dir, "in", path)), { recursive: true });
      await writeFile(join(dir, "in", path), text, { mode: 0o644 });
    }
    execFileSync("tar", ["--format", "zip", "-cf", join(dir, "out.zip"), "-C", join(dir, "in"), "."]);
    return await readFile(join(dir, "out.zip"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Runs the fake Runtime, logging next to itself. */
const fakeRuntimeLauncher = `#!/bin/sh\nFAKE_RUNTIME_DIR="$(dirname "$0")" exec '${process.execPath}' '${join(import.meta.dir, "fake-runtime.ts")}' "$@"\n`;

/**
 * What each Runtime archive holds: the binary inside a folder, as release archives may have it, and the CUDA runtime.
 * The macOS binary is the fake Runtime, so a Job can run on what `local install` installed.
 */
const archiveContents: Record<string, Record<string, string>> = {
  "sd-master-5dcfa79-bin-Darwin-macOS-26.7.2-arm64.zip": { "build/bin/sd-server": fakeRuntimeLauncher, "build/bin/libggml.dylib": "dylib" },
  "sd-master-5dcfa79-bin-win-cuda12-x64.zip": { "sd-server.exe": "MZ" },
  "cudart-sd-bin-win-cu12-x64.zip": { "cudart64_12.dll": "dll" },
};

export interface FakeDownloads {
  /** The real catalog, every file pinned to a small stand-in served from `routes`. */
  catalog: Catalog;
  routes: Routes;
  /** Each stand-in weight file's bytes, by `<folder>/<name>`. */
  weights: Map<string, Buffer<ArrayBuffer>>;
  /** The URL of each stand-in, by the real file's URL. */
  urlOf: (real: string) => string;
}

/** Stands in for Hugging Face and GitHub: the catalog's structure, with files small enough for tests. */
export async function fakeDownloads(): Promise<FakeDownloads> {
  const routes: Routes = {};
  const weights = new Map<string, Buffer<ArrayBuffer>>();
  const urlOf = (real: string) => `https://downloads.test/${new URL(real).pathname.split("/").pop()}`;
  const serve = (file: PinnedFile, bytes: Buffer): PinnedFile => {
    routes[`GET ${urlOf(file.url)}`] = () => new Response(bytes);
    return { ...file, url: urlOf(file.url), size: bytes.length, sha256: sha256(bytes) };
  };

  const runtime = Object.fromEntries(
    await Promise.all(
      Object.entries(catalog.runtime).map(async ([platform, build]) => [
        platform,
        { ...build, archives: await Promise.all(build.archives.map(async (archive) => serve(archive, await zip(archiveContents[urlOf(archive.url).split("/").pop()!]!)))) },
      ]),
    ),
  ) as Catalog["runtime"];

  const fake = <T extends { folder: string; name: string } & PinnedFile>(file: T): T => {
    const bytes = Buffer.from(`weights of ${file.name}`);
    weights.set(`${file.folder}/${file.name}`, bytes);
    return { ...file, ...serve(file, bytes) };
  };
  const mapSlots = <T extends { folder: string; name: string } & PinnedFile>(slots: Record<string, T>) =>
    Object.fromEntries(Object.entries(slots).map(([slot, file]) => [slot, fake(file)]));
  const models = catalog.models.map((model) => ({
    ...model,
    files: mapSlots(model.files),
    quants: Object.fromEntries(Object.entries(model.quants).map(([quant, slots]) => [quant, mapSlots(slots)])),
  }));

  return { catalog: { runtime, models }, routes, weights, urlOf };
}
