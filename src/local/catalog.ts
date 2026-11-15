/**
 * Everything `local install` downloads, pinned: each file by URL (a Hugging Face revision or a GitHub release), size
 * and SHA-256. A newer Runtime build or new weights come only with a new litevision release.
 */

/** A file litevision downloads, which must match its size and SHA-256 exactly. */
export interface PinnedFile {
  url: string;
  size: number;
  sha256: string;
}

/** A weight file, saved as `<folder>/<name>` in the Runtime's model folder, ComfyUI's layout. */
export interface WeightFile extends PinnedFile {
  folder: string;
  name: string;
}

/** The machines a Runtime build exists for: Apple Silicon, and Windows with an NVIDIA GPU (CUDA 12). */
export type Platform = "macos-arm64" | "windows-cuda12";

export const platformLabel: Record<Platform, string> = { "macos-arm64": "macOS on Apple Silicon", "windows-cuda12": "Windows with CUDA 12" };

/** What the quantisation table is keyed by on each platform. */
export const memoryLabel: Record<Platform, string> = { "macos-arm64": "unified memory", "windows-cuda12": "VRAM" };

export interface RuntimeBuild {
  /** The sd-server release tag; the build is installed in `runtime/<tag>/`. */
  tag: string;
  binary: string;
  /** Extracted in order: the first holds the binary, the others go next to it. */
  archives: PinnedFile[];
}

export interface LocalModel {
  /** What the User passes to `local install`, and the Alias it gets. */
  name: string;
  title: string;
  does: string;
  licence: { name: string; terms: string; url: string; commercial: boolean };
  /** sd-server's built-in recipe for the Model; litevision writes it, with the files it chose, as a user recipe. */
  recipe: { id: string } & Record<string, unknown>;
  /** The weights every quantisation uses, by recipe slot. */
  files: Record<string, WeightFile>;
  /** The weights each quantisation adds, by recipe slot, largest first. */
  quants: Record<string, Record<string, WeightFile>>;
  /** The quantisation to choose for at least this much memory, in GB, largest first; below the last, it will likely not fit. */
  fit: Record<Platform, Array<[minimumGb: number, quant: string]>>;
}

export interface Catalog {
  runtime: Record<Platform, RuntimeBuild>;
  models: LocalModel[];
}

const release = "https://github.com/leejet/stable-diffusion.cpp/releases/download/master-1104-5dcfa79";

const hf = (repo: string, revision: string, path: string) => `https://huggingface.co/${repo}/resolve/${revision}/${path}`;

const kleinGguf = "leejet/flux-3-image-klein-GGUF";
const kleinGgufRevision = "57dfa91df2284f4985a4107c399d05d12e0f9b63";

function kleinQuant(quant: string, size: number, sha256: string): Record<string, WeightFile> {
  const name = `flux3-image-klein-${quant}.gguf`;
  return { diffusion_model: { folder: "diffusion_models", name, url: hf(kleinGguf, kleinGgufRevision, name), size, sha256 } };
}

const flux3Klein: LocalModel = {
  name: "flux-3-klein",
  title: "FLUX 3 Image Klein",
  does: "generate, edit",
  licence: {
    name: "FLUX Kommunity License",
    terms: "free for commercial use under $5M annual revenue",
    url: "https://huggingface.co/black-forest-labs/flux-3-image-klein/blob/main/LICENSE.md",
    commercial: true,
  },
  recipe: {
    schema_version: 1,
    id: "flux3-klein",
    name: "FLUX.3 Image Klein",
    size_multiple: 16,
    description: "Supports text-to-image and reference-image editing.",
    model_url: "https://huggingface.co/black-forest-labs/flux-3-image-klein",
    slots: [
      { id: "diffusion_model", required: true },
      { id: "llm", required: true, label: "Qwen 3 VL 4B Text Encoder" },
      { id: "vae", required: false },
      { id: "tae", required: false },
    ],
    required_any: [["vae", "tae"]],
    defaults: { sampling_method: "euler", cfg_scale: 1, steps: 16, width: 1024, height: 1024 },
    features: ["flow_shift", "ref_images"],
  },
  files: {
    llm: {
      folder: "text_encoders",
      name: "Qwen3VL-4B-Instruct-Q4_K_M.gguf",
      url: hf("Qwen/Qwen3-VL-4B-Instruct-GGUF", "1cd86afb9a95c410a6038ab3b40d8b578c892266", "Qwen3VL-4B-Instruct-Q4_K_M.gguf"),
      size: 2497281664,
      sha256: "66358cb18bb6b3b1b6675aa412c7a88ef01d228f481184d13668e5201c730a0a",
    },
    vae: {
      folder: "vae",
      name: "flux2-vae.safetensors",
      url: hf("Comfy-Org/Flux-2-Klein-4B", "5b3abca5c0dc1ecd4eaf3340868d09063fc1c965", "split_files/vae/flux2-vae.safetensors"),
      size: 336211292,
      sha256: "868fe7b343cc8f3a19dbcfcafbc3d5f888802be3f89bd81b65b3621a066ce8f3",
    },
  },
  quants: {
    Q8_0: kleinQuant("Q8_0", 6151716032, "8b71ffd749bcacbd50cc0acca4f2d31a044c94412743e1e780db99bf13f89752"),
    Q6_K: kleinQuant("Q6_K", 4874083520, "a1ba881f2940a58a3f6090d357516ee611bcc29215256bbf46731c0350b9e6d4"),
    Q5_K: kleinQuant("Q5_K", 4173446336, "b335058ee1940937d7a95e1cf0f02fcad9c4ecb7a7cb8fce1a411eb55eeb2192"),
    Q4_K: kleinQuant("Q4_K", 3514023104, "19ddbfbed61da4bb16ebf169aaf48e9e5db43aba557be1ee537e9f00f586092e"),
    Q3_K: kleinQuant("Q3_K", 2813385920, "bb80b0e181a06652bd3faba076e5a066e10768dd8401adab508a352a9cd9de30"),
    Q2_K: kleinQuant("Q2_K", 2277604544, "c017e7385478008f3b9ea7cbd8ba3449096830cad67a917e133af2d2821e6da3"),
  },
  fit: {
    "macos-arm64": [
      [32, "Q8_0"],
      [24, "Q6_K"],
      [16, "Q4_K"],
    ],
    "windows-cuda12": [
      [16, "Q8_0"],
      [12, "Q6_K"],
      [8, "Q4_K"],
    ],
  },
};

export const catalog: Catalog = {
  runtime: {
    "macos-arm64": {
      tag: "master-1104-5dcfa79",
      binary: "sd-server",
      archives: [
        {
          url: `${release}/sd-master-5dcfa79-bin-Darwin-macOS-26.7.2-arm64.zip`,
          size: 38234884,
          sha256: "c1d93bfc0bdcddbf3e62d41dd63597cae69ec712804993bd4ad11599bbdcdd4b",
        },
      ],
    },
    "windows-cuda12": {
      tag: "master-1104-5dcfa79",
      binary: "sd-server.exe",
      archives: [
        {
          url: `${release}/sd-master-5dcfa79-bin-win-cuda12-x64.zip`,
          size: 412309812,
          sha256: "c7132d6f7e36dee6c39d3d51e8970470c615e5c9c8db498d6f73d5c14b4b1f5d",
        },
        {
          url: `${release}/cudart-sd-bin-win-cu12-x64.zip`,
          size: 563452046,
          sha256: "fe20366827d357c00797eebb58244dddab7fd9a348d70090c3871004c320f38d",
        },
      ],
    },
  },
  models: [flux3Klein],
};
