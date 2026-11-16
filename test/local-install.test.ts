import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { access, constants, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Hardware } from "../src/local/hardware.ts";
import { startHarness, type Harness, type HarnessOptions } from "./harness.ts";
import { fakeDownloads, type FakeDownloads } from "./local-downloads.ts";
import { textOf } from "./helpers.ts";
import { inTurn } from "./recorded-http.ts";

const mac16: Hardware = { platform: "macos-arm64", memoryGb: 16 };
const tag = "master-1104-5dcfa79";

let downloads: FakeDownloads;
beforeAll(async () => {
  downloads = await fakeDownloads();
});

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function start(options: HarnessOptions = {}) {
  harness = await startHarness({ catalog: downloads.catalog, ...options, routes: { ...downloads.routes, ...options.routes } });
  return harness;
}

const install = (args: string[] = [], hardware: Hardware = mac16) => harness!.cli(["local", "install", "flux-3-klein", ...args], { hardware });
const home = (...path: string[]) => join(harness!.dirs.home, ...path);
const exists = (path: string) => access(path).then(() => true, () => false);
const downloaded = () => harness!.requests.map((request) => request.url);
const config = async () => JSON.parse(await readFile(home("config.json"), "utf8"));
const recipe = async () => JSON.parse(await readFile(home("models", "recipes", "flux3-klein.json"), "utf8"));

describe("local install", () => {
  test("leaves a Runtime, the weights and a configured Model that a Job runs on", async () => {
    await start({ reachRuntime: true, pollIntervalMs: 5 });
    const { code, output } = await install(["--yes"]);

    expect(code, output).toBe(0);
    expect(output).toContain("Q4_K, for 16 GB unified memory");
    expect(output).toContain("FLUX Kommunity License");
    expect(output).toContain("Speed: about 8 minutes per 1024x1024 image");
    await access(home("runtime", tag, "build", "bin", "sd-server"), constants.X_OK);
    for (const [path, bytes] of [...downloads.weights].filter(([path]) => /Q4_K|Qwen3VL|vae/.test(path))) {
      expect(await readFile(home("models", path))).toEqual(bytes);
    }
    expect((await recipe()).models).toEqual({
      diffusion_model: "diffusion_models/flux3-image-klein-Q4_K.gguf",
      llm: "text_encoders/Qwen3VL-4B-Instruct-Q4_K_M.gguf",
      vae: "vae/flux2-vae.safetensors",
    });
    expect(await config()).toMatchObject({
      providers: [{ id: "local" }],
      models: [{ alias: "flux-3-klein", provider: "local", modelId: "flux3-klein", protocol: "sdcpp", modality: "image" }],
    });

    const result = await harness!.client.callTool({ name: "generate_image", arguments: { prompt: "a red fox", model: "flux-3-klein" } });
    expect(result.isError, textOf(result)).toBeFalsy();
  });

  test("prints what it will download and downloads nothing until the User agrees", async () => {
    await start();
    const { code, output } = await install();

    expect(code).toBe(1);
    expect(output).toMatch(/To download \([\d.]+ (B|kB|MB|GB)\)/);
    expect(output).toContain("diffusion_models/flux3-image-klein-Q4_K.gguf");
    expect(output).toContain("--yes");
    expect(downloaded()).toEqual([]);
    expect(await exists(home("models"))).toBe(false);

    expect((await harness!.cli(["local", "install", "flux-3-klein"], { hardware: mac16, answer: false })).code).toBe(1);
    expect(downloaded()).toEqual([]);
    expect((await harness!.cli(["local", "install", "flux-3-klein"], { hardware: mac16, answer: true })).code).toBe(0);
    expect(await exists(home("models", "recipes", "flux3-klein.json"))).toBe(true);
  });

  for (const [hardware, quant] of [
    [mac16, "Q4_K"],
    [{ platform: "macos-arm64", memoryGb: 24 }, "Q6_K"],
    [{ platform: "macos-arm64", memoryGb: 64 }, "Q8_0"],
    [{ platform: "windows-cuda12", memoryGb: 8 }, "Q4_K"],
    [{ platform: "windows-cuda12", memoryGb: 16 }, "Q8_0"],
  ] as const) {
    test(`chooses ${quant} for ${hardware.memoryGb} GB on ${hardware.platform}`, async () => {
      await start();
      const { code, output } = await install(["--yes"], hardware);
      expect(code, output).toBe(0);
      expect((await recipe()).models.diffusion_model).toBe(`diffusion_models/flux3-image-klein-${quant}.gguf`);
    });
  }

  test("on Windows, puts the CUDA runtime next to sd-server.exe", async () => {
    await start();
    expect((await install(["--yes"], { platform: "windows-cuda12", memoryGb: 8 })).code).toBe(0);
    expect((await readdir(home("runtime", tag))).sort()).toEqual(["cudart64_12.dll", "sd-server.exe"]);
  });

  test("--quant overrides the table", async () => {
    await start();
    const { code, output } = await install(["--quant", "Q2_K", "--yes"]);
    expect(code, output).toBe(0);
    expect((await recipe()).models.diffusion_model).toBe("diffusion_models/flux3-image-klein-Q2_K.gguf");
  });

  test("an unknown --quant is refused with the ones there are", async () => {
    await start();
    const { code, output } = await install(["--quant", "Q9", "--yes"]);
    expect(code).toBe(1);
    expect(output).toContain("Q8_0, Q6_K, Q5_K, Q4_K, Q3_K, Q2_K");
  });

  test("a file whose SHA-256 does not match is deleted and the install fails, naming it", async () => {
    const url = downloads.urlOf("https://x/Qwen3VL-4B-Instruct-Q4_K_M.gguf");
    await start({ routes: { [`GET ${url}`]: () => new Response(Buffer.from("weights of something else")) } });
    const { code, output } = await install(["--yes"]);

    expect(code).toBe(1);
    expect(output).toContain("Qwen3VL-4B-Instruct-Q4_K_M.gguf");
    expect(output).toContain("SHA-256");
    expect(await readdir(home("models", "text_encoders"))).toEqual([]);
    expect(await exists(home("config.json"))).toBe(false);
  });

  describe("a download the connection drops", () => {
    const name = "flux3-image-klein-Q4_K.gguf";
    const url = () => downloads.urlOf(`https://x/${name}`);
    const bytes = () => downloads.weights.get(`diffusion_models/${name}`)!;
    /** Sends the first `cut` bytes, then, once they are written, resets the connection. */
    const dropsAfter = (cut: number) => () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(bytes().subarray(0, cut));
            setTimeout(() => controller.error(new Error("ECONNRESET: The socket connection was closed unexpectedly.")), 20);
          },
        }),
      );
    /** Sends the rest from the byte the request's Range asks for. */
    const resumes = (request: Request) => {
      const from = Number(/^bytes=(\d+)-$/.exec(request.headers.get("range") ?? "")?.[1]);
      return new Response(bytes().subarray(from), { status: 206 });
    };
    const ranges = () => harness!.requests.filter((request) => request.url === url()).map((request) => request.headers.get("range"));

    test("is resumed from where it stopped", async () => {
      await start({ routes: { [`GET ${url()}`]: inTurn(dropsAfter(5), resumes) } });
      const { code, output } = await install(["--yes"]);

      expect(code, output).toBe(0);
      expect(ranges()).toEqual([null, "bytes=5-"]);
      expect(await readFile(home("models", "diffusion_models", name))).toEqual(bytes());
    });

    test("that keeps failing stops the install, and running it again resumes", async () => {
      await start({ routes: { [`GET ${url()}`]: inTurn(dropsAfter(3), dropsAfter(3), dropsAfter(3), dropsAfter(3), dropsAfter(3), resumes) } });
      const failed = await install(["--yes"]);
      expect(failed.code).toBe(1);
      expect(failed.output).toContain("ECONNRESET");
      expect(failed.output).toContain("again to resume");

      const again = await install(["--yes"]);
      expect(again.code, again.output).toBe(0);
      expect(ranges().at(-1)).toBe("bytes=3-");
      expect(await readFile(home("models", "diffusion_models", name))).toEqual(bytes());
    });

    test("is downloaded again from the start when the server ignores the Range", async () => {
      await start({ routes: { [`GET ${url()}`]: inTurn(dropsAfter(5), () => new Response(bytes())) } });
      const { code, output } = await install(["--yes"]);

      expect(code, output).toBe(0);
      expect(await readFile(home("models", "diffusion_models", name))).toEqual(bytes());
    });
  });

  test("a quantisation that will likely not fit warns, names one that fits, and installs only with --force", async () => {
    await start();
    const refused = await install(["--quant", "Q8_0", "--yes"]);
    expect(refused.code).toBe(1);
    expect(refused.output).toContain("--quant Q4_K");
    expect(refused.output).toContain("--force");
    expect(downloaded()).toEqual([]);

    const forced = await install(["--quant", "Q8_0", "--yes", "--force"]);
    expect(forced.code, forced.output).toBe(0);
    expect((await recipe()).models.diffusion_model).toBe("diffusion_models/flux3-image-klein-Q8_0.gguf");
  });

  test("a Model too big for the machine at any quantisation warns and installs only with --force", async () => {
    await start();
    const small: Hardware = { platform: "macos-arm64", memoryGb: 8 };
    const refused = await install(["--yes"], small);
    expect(refused.code).toBe(1);
    expect(refused.output).toContain("8 GB unified memory");
    expect(refused.output).toContain("No Model litevision installs is likely to fit");
    expect((await install(["--yes", "--force"], small)).code).toBe(0);
  });

  test("reuses a matching file from an existing model folder instead of downloading it", async () => {
    await start();
    const comfy = join(harness!.cwd, "ComfyUI", "models");
    await mkdir(join(comfy, "vae", "flux"), { recursive: true });
    await writeFile(join(comfy, "vae", "flux", "renamed.safetensors"), downloads.weights.get("vae/flux2-vae.safetensors")!);
    // Older ComfyUI folders keep diffusion models in unet/.
    await mkdir(join(comfy, "unet"), { recursive: true });
    await writeFile(join(comfy, "unet", "klein.gguf"), downloads.weights.get("diffusion_models/flux3-image-klein-Q4_K.gguf")!);
    await writeFile(home("config.json"), JSON.stringify({ localModelFolders: [comfy] }));

    const { code, output } = await install(["--yes"]);
    expect(code, output).toBe(0);
    expect(downloaded().some((url) => /flux2-vae|Q4_K\.gguf/.test(url))).toBe(false);
    expect(await readFile(home("models", "vae", "flux2-vae.safetensors"))).toEqual(downloads.weights.get("vae/flux2-vae.safetensors")!);
    expect(await readFile(home("models", "diffusion_models", "flux3-image-klein-Q4_K.gguf"))).toEqual(
      downloads.weights.get("diffusion_models/flux3-image-klein-Q4_K.gguf")!,
    );
    expect(output).toContain(join(comfy, "vae", "flux", "renamed.safetensors"));
  });

  test("installing again downloads nothing new and replaces an outdated Runtime", async () => {
    await start();
    expect((await install(["--yes"])).code).toBe(0);
    await mkdir(home("runtime", "master-0001-old"), { recursive: true });
    harness!.requests.length = 0;

    const again = await install(["--yes"]);
    expect(again.code, again.output).toBe(0);
    expect(downloaded()).toEqual([]);
    expect(await readdir(home("runtime"))).toEqual([tag]);
    expect((await config()).models).toHaveLength(1);
  });

  test("a Runtime folder left without its binary is installed again", async () => {
    await start();
    await mkdir(home("runtime", tag), { recursive: true });
    await writeFile(home("runtime", tag, "leftover"), "");
    const { code, output } = await install(["--yes"]);
    expect(code, output).toBe(0);
    await access(home("runtime", tag, "build", "bin", "sd-server"), constants.X_OK);
  });

  test("when another Model has the Model's name as its Alias, takes the next free one", async () => {
    await start({ config: { providers: [], models: [{ alias: "flux-3-klein", provider: "openai", modelId: "x", protocol: "openai-images" }] } });
    const { code, output } = await install(["--yes"]);
    expect(code, output).toBe(0);
    expect(output).toContain('model "flux-3-klein-2"');
    expect((await config()).models.map((model: { alias: string }) => model.alias)).toEqual(["flux-3-klein", "flux-3-klein-2"]);
  });

  test("drops the address an earlier install gave the local Provider: litevision starts the Runtime itself", async () => {
    await start({ config: { providers: [{ id: "local", baseUrl: "http://127.0.0.1:1234" }], models: [] } });
    const { code, output } = await install(["--yes"]);
    expect(code, output).toBe(0);
    expect((await config()).providers).toEqual([{ id: "local" }]);
  });

    test("switching quantisation deletes the weights the old one alone used", async () => {
    await start();
    await install(["--yes"]);
    await install(["--quant", "Q2_K", "--yes"]);
    expect(await readdir(home("models", "diffusion_models"))).toEqual(["flux3-image-klein-Q2_K.gguf"]);
  });

  test("on a machine with no Runtime build, says which machines litevision supports", async () => {
    await start();
    const { code, output } = await install(["--yes"], { platform: undefined, name: "linux-x64" });
    expect(code).toBe(1);
    expect(output).toContain("linux-x64");
    expect(output).toContain("macOS on Apple Silicon");
  });

  test("an unknown Model is refused with the ones there are", async () => {
    await start();
    const { code, output } = await harness!.cli(["local", "install", "nope"], { hardware: mac16 });
    expect(code).toBe(1);
    expect(output).toContain("flux-3-klein");
  });
});

describe("local remove", () => {
  test("asks, then deletes the Model's weights and recipe and removes it from the configuration", async () => {
    await start();
    await install(["--yes"]);
    await writeFile(home("config.json"), JSON.stringify({ ...(await config()), defaultImageModel: "flux-3-klein" }));

    const asked = await harness!.cli(["local", "remove", "flux-3-klein"]);
    expect(asked.code).toBe(1);
    expect(asked.output).toContain("diffusion_models/flux3-image-klein-Q4_K.gguf");
    expect(await exists(home("models", "recipes", "flux3-klein.json"))).toBe(true);

    const { code, output } = await harness!.cli(["local", "remove", "flux-3-klein", "--yes"]);
    expect(code, output).toBe(0);
    // The folders it left empty go too; the Runtime stays for the next local Model.
    expect(await exists(home("models"))).toBe(false);
    await access(home("runtime", tag, "build", "bin", "sd-server"), constants.X_OK);
    const after = await config();
    expect(after.models).toEqual([]);
    expect(after.defaultImageModel).toBeUndefined();
  });

  test("keeps files another installed Model still uses", async () => {
    await start();
    await install(["--yes"]);
    await writeFile(home("models", "recipes", "other.json"), JSON.stringify({ id: "other", models: { vae: "vae/flux2-vae.safetensors" } }));

    const { code, output } = await harness!.cli(["local", "remove", "flux-3-klein", "--yes"]);
    expect(code, output).toBe(0);
    expect(await readdir(home("models", "vae"))).toEqual(["flux2-vae.safetensors"]);
    expect(await readdir(home("models"))).toEqual(["recipes", "vae"]);
    expect(output).toContain("other");
  });

  test("never deletes a file a recipe names outside the model folder", async () => {
    await start();
    await install(["--yes"]);
    const outside = join(harness!.cwd, "keep.gguf");
    await writeFile(outside, "mine");
    const stored = await recipe();
    await writeFile(home("models", "recipes", "flux3-klein.json"), JSON.stringify({ ...stored, models: { ...stored.models, tae: "../../cwd/keep.gguf" } }));

    expect((await harness!.cli(["local", "remove", "flux-3-klein", "--yes"])).code).toBe(0);
    expect(await readFile(outside, "utf8")).toBe("mine");
  });

  test("a Model that is not installed is reported as such", async () => {
    await start();
    const { code, output } = await harness!.cli(["local", "remove", "flux-3-klein", "--yes"]);
    expect(code).toBe(1);
    expect(output).toContain("is not installed");
  });
});
