import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { catalog } from "../src/local/catalog.ts";
import { startSettingsHarness, type SettingsHarness, type SettingsHarnessOptions } from "./settings-harness.ts";

let harness: SettingsHarness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function start(options: SettingsHarnessOptions = {}): Promise<SettingsHarness> {
  harness = await startSettingsHarness(options);
  return harness;
}

const mac = { platform: "macos-arm64", memoryGb: 16 } as const;
const klein = catalog.models.find((model) => model.name === "flux-3-klein")!;
const local = { id: "local" };
const kleinModel = { alias: "flux-3-klein", provider: "local", modelId: klein.recipe.id, protocol: "sdcpp", modality: "image" };
const installed = { config: { providers: [local], models: [kleinModel] }, hardware: mac };

/** What `local install` leaves in place: the Runtime binary, the recipe and the weight files it names. */
async function install(h: SettingsHarness, { runtime = true, skip = [] as string[] } = {}) {
  const build = catalog.runtime["macos-arm64"];
  if (runtime) {
    await mkdir(join(h.dirs.home, "runtime", build.tag, "build", "bin"), { recursive: true });
    await writeFile(join(h.dirs.home, "runtime", build.tag, "build", "bin", build.binary), "");
  }
  const files = Object.values({ ...klein.files, ...klein.quants.Q4_K }).map((file) => `${file.folder}/${file.name}`);
  for (const file of files.filter((candidate) => !skip.includes(candidate))) {
    await mkdir(join(h.dirs.home, "models", file, ".."), { recursive: true });
    await writeFile(join(h.dirs.home, "models", file), "weights");
  }
  await mkdir(join(h.dirs.home, "models", "recipes"), { recursive: true });
  const models = Object.fromEntries(files.map((file, index) => [`slot${index}`, file]));
  await writeFile(join(h.dirs.home, "models", "recipes", `${klein.recipe.id}.json`), JSON.stringify({ ...klein.recipe, models }));
  return files;
}

const testLocal = () => harness!.send("POST", "/api/providers/local/test-connection", { body: {} });

describe("the local Provider on the settings page", () => {
  test("is listed as local, with no base URL or Credential", async () => {
    const h = await start({ config: { providers: [local] } });
    expect((await h.send("GET", "/api/providers")).json()).toEqual({ providers: [{ id: "local", baseUrl: "", credential: null, local: true }] });
  });

  test("its connection test finds the Runtime and every weight file in place, without a Protocol and without calling anything", async () => {
    const h = await start(installed);
    await install(h);
    const response = await testLocal();
    expect(response.json()).toEqual({ result: "success", message: expect.stringContaining('"flux-3-klein"') });
    expect(h.requests).toHaveLength(0);
  });

  test("its connection test names a missing Runtime and a missing recipe", async () => {
    await start(installed);
    const { result, message } = (await testLocal()).json();
    expect(result).toBe("failure");
    expect(message).toContain(`sd-server ${catalog.runtime["macos-arm64"].tag}`);
    expect(message).toContain(`models/recipes/${klein.recipe.id}.json`);
    expect(message).toContain("npx -y litevision local install flux-3-klein");
  });

  test("its connection test names each missing weight file", async () => {
    const h = await start(installed);
    const vae = `${klein.files.vae!.folder}/${klein.files.vae!.name}`;
    await install(h, { skip: [vae] });
    const { result, message } = (await testLocal()).json();
    expect(result).toBe("failure");
    expect(message).toContain(`models/${vae}`);
    expect(message).not.toContain("sd-server");
  });

  test("on Windows its connection test names a missing NVIDIA driver", async () => {
    await start({ ...installed, hardware: { platform: "windows-cuda12", memoryGb: 0 } });
    const { result, message } = (await testLocal()).json();
    expect(result).toBe("failure");
    expect(message).toContain("NVIDIA GPU with its driver");
  });

  test("on a machine with no Runtime build its connection test says so", async () => {
    await start({ ...installed, hardware: { platform: undefined, name: "linux-x64" } });
    const { result, message } = (await testLocal()).json();
    expect(result).toBe("failure");
    expect(message).toContain("linux-x64");
  });
});

describe("local Models are added only by local install", () => {
  const relay = { id: "relay", baseUrl: "https://relay.example/v1" };

  test("the page cannot add a Model on the local Provider or the sdcpp Protocol", async () => {
    const h = await start({ config: { providers: [local, relay] } });
    for (const body of [
      { alias: "mine", provider: "local", modelId: "my-recipe", protocol: "sdcpp" },
      { alias: "mine", provider: "relay", modelId: "my-recipe", protocol: "sdcpp" },
      { alias: "mine", provider: "local", modelId: "my-recipe", protocol: "openai-images" },
    ]) {
      const response = await h.send("POST", "/api/models", { body });
      expect(response.status).toBe(400);
      expect(response.json().error).toContain("local install");
    }
    expect((await h.readConfig()).models).toBeUndefined();
  });

  test("the page cannot turn a Model into a local one, or a local one into another", async () => {
    const cloud = { alias: "cloud", provider: "relay", modelId: "gpt-image-2", protocol: "openai-images", modality: "image" };
    const h = await start({ config: { providers: [local, relay], models: [cloud, kleinModel] } });
    expect((await h.send("PATCH", "/api/models/cloud", { body: { provider: "local", protocol: "sdcpp" } })).status).toBe(400);
    expect((await h.send("PATCH", "/api/models/flux-3-klein", { body: { modelId: "another-recipe" } })).status).toBe(400);
    expect((await h.send("PATCH", "/api/models/flux-3-klein", { body: { notes: "fast at 512px" } })).status).toBe(200);
    expect((await h.readConfig()).models).toEqual([cloud, { ...kleinModel, notes: "fast at 512px", notesHistory: expect.anything() }]);
  });

  test("the page cannot add a Provider named local", async () => {
    const h = await start();
    const response = await h.send("POST", "/api/providers", { body: { id: "local", baseUrl: "http://127.0.0.1:1234" } });
    expect(response.status).toBe(400);
    expect(response.json().error).toContain("local install");
    expect((await h.readConfig().catch(() => ({}))).providers).toBeUndefined();
  });
});
