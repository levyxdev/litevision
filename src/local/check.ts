import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { isPlainObject, readConfigObject } from "../config-store.ts";
import type { Dirs } from "../dirs.ts";
import { platformLabel, type Catalog } from "./catalog.ts";
import type { Hardware } from "./hardware.ts";
import { modelRoot, readRecipes, runtimeBinary } from "./install.ts";
import { localProviderId } from "./provider.ts";
import type { ConnectionTestResult } from "../settings/connection.ts";

/**
 * The settings page's connection test for the local Provider: whether the Runtime, each local Model's recipe and weight
 * files and, on Windows, the NVIDIA driver are in place, naming whatever is missing. Nothing is started or downloaded.
 */
export async function checkLocal(dirs: Dirs, catalog: Catalog, hardware: Hardware): Promise<ConnectionTestResult> {
  if (hardware.platform === undefined) {
    return { result: "failure", message: `litevision has no Runtime build for ${hardware.name}. Local Models run on ${Object.values(platformLabel).join(" and on ")}.` };
  }
  const missing: string[] = [];
  const build = catalog.runtime[hardware.platform];
  const noRuntime = (await runtimeBinary(dirs, catalog, hardware.platform)) === undefined;
  if (noRuntime) missing.push(`the Runtime, sd-server ${build.tag}`);
  if (hardware.platform === "windows-cuda12" && hardware.memoryGb === 0) {
    missing.push("an NVIDIA GPU with its driver: nvidia-smi found none. Install the driver for your GPU, with CUDA 12 or later");
  }

  const config = await readConfigObject(dirs);
  const models = (Array.isArray(config.models) ? config.models.filter(isPlainObject) : []).filter((model) => model.provider === localProviderId);
  const recipes = await readRecipes(dirs);
  const nameOf = (model: Record<string, unknown>) => catalog.models.find((candidate) => candidate.recipe.id === model.modelId)?.name;
  // Installing a Model again puts back its weights, and the Runtime too.
  const reinstall = new Set<string>();
  for (const model of models) {
    const recipe = recipes.find((candidate) => candidate.id === model.modelId);
    const before = missing.length;
    if (recipe === undefined) missing.push(`the recipe of "${String(model.alias)}", models/recipes/${String(model.modelId)}.json`);
    for (const file of recipe?.files ?? []) {
      const isFile = await stat(resolve(modelRoot(dirs), file)).then((stats) => stats.isFile(), () => false);
      if (!isFile) missing.push(`models/${file}, for "${String(model.alias)}"`);
    }
    const name = nameOf(model);
    if (missing.length > before && name !== undefined) reinstall.add(name);
  }
  if (noRuntime && reinstall.size === 0) reinstall.add(models.map(nameOf).find((name) => name !== undefined) ?? "<model>");

  if (missing.length > 0) {
    const again = [...reinstall].map((name) => `npx -y litevision local install ${name}`).join(", ");
    return { result: "failure", message: `Missing: ${missing.join("; ")}.${again === "" ? "" : ` To put them back: ${again}.`}` };
  }
  const aliases = models.map((model) => `"${String(model.alias)}"`).join(", ");
  return { result: "success", message: models.length === 0 ? "The Runtime is in place; no local Model is configured." : `The Runtime and the weights of ${aliases} are in place.` };
}
