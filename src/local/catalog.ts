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

/** An sd-server recipe: the fields litevision reads, and the rest as sd-server has them. */
export interface Recipe {
  id: string;
  model_url: string;
  /** What width and height are multiples of; sd-server's default is 8. */
  size_multiple?: number;
  /** What sd-server uses for a field a request leaves out. */
  defaults: { sampling_method: string; cfg_scale: number; steps: number; width: number; height: number; custom_sigmas?: number[] };
  features: string[];
  [field: string]: unknown;
}

/** The licence line `local install` prints and the Parameter Guide carries. */
export const licenceLine = ({ licence }: LocalModel) =>
  `${licence.commercial ? "" : "Non-commercial use only. "}Licence: ${licence.name}, ${licence.terms}: ${licence.url}`;

export interface LocalModel {
  /** What the User passes to `local install`, and the Alias it gets. */
  name: string;
  title: string;
  does: string;
  licence: { name: string; terms: string; url: string; commercial: boolean };
  /** How fast it ran where it was measured, so the User knows before downloading. */
  speed: string;
  /** stable-diffusion.cpp's page on the Model, the first source of its Parameter Guide. */
  docsUrl: string;
  /** What its Parameter Guide says beyond the recipe's defaults: measurements, limits, advice. */
  guideNotes: string[];
  /** sd-server's built-in recipe for the Model; litevision writes it, with the files it chose, as a user recipe. */
  recipe: Recipe;
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

/** A repository at a pinned revision, and a file in it. */
const pinned = (repo: string, revision: string) => (folder: string, path: string, size: number, sha256: string, name = path.split("/").pop()!): WeightFile => ({
  folder,
  name,
  url: hf(repo, revision, path),
  size,
  sha256,
});

/** One diffusion model file per quantisation, largest first, named by `nameOf`. */
function diffusionQuants(repo: string, revision: string, nameOf: (quant: string) => string, quants: Array<[quant: string, size: number, sha256: string]>) {
  const file = pinned(repo, revision);
  return Object.fromEntries(quants.map(([quant, size, sha256]) => [quant, { diffusion_model: file("diffusion_models", nameOf(quant), size, sha256) }]));
}

const sdcppDocs = (page: string) => `https://github.com/leejet/stable-diffusion.cpp/blob/master-1104-5dcfa79/docs/models/${page}`;

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
  speed: "about 8 minutes per 1024x1024 image, and about 20 for an edit, on a 16 GB M4 Mac at Q4_K; smaller images are faster",
  docsUrl: sdcppDocs("flux3.md"),
  guideNotes: [
    "On the 16 GB M4 Mac at Q4_K, the weights took 5.9 GB of GPU memory; at 1024x1024, about 27 s per step and 30 s to decode, with heavy swapping, and about 78 s per step with one 1024x1024 reference image. A draft at 512x512 to 768x768, or with fewer steps, is much faster. Q6_K is not for 16 GB.",
    "Up to 10 reference images.",
  ],
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
    llm: pinned("Qwen/Qwen3-VL-4B-Instruct-GGUF", "1cd86afb9a95c410a6038ab3b40d8b578c892266")(
      "text_encoders",
      "Qwen3VL-4B-Instruct-Q4_K_M.gguf",
      2497281664,
      "66358cb18bb6b3b1b6675aa412c7a88ef01d228f481184d13668e5201c730a0a",
    ),
    vae: pinned("Comfy-Org/Flux-2-Klein-4B", "5b3abca5c0dc1ecd4eaf3340868d09063fc1c965")(
      "vae",
      "split_files/vae/flux2-vae.safetensors",
      336211292,
      "868fe7b343cc8f3a19dbcfcafbc3d5f888802be3f89bd81b65b3621a066ce8f3",
    ),
  },
  quants: diffusionQuants("leejet/flux-3-image-klein-GGUF", "57dfa91df2284f4985a4107c399d05d12e0f9b63", (quant) => `flux3-image-klein-${quant}.gguf`, [
    ["Q8_0", 6151716032, "8b71ffd749bcacbd50cc0acca4f2d31a044c94412743e1e780db99bf13f89752"],
    ["Q6_K", 4874083520, "a1ba881f2940a58a3f6090d357516ee611bcc29215256bbf46731c0350b9e6d4"],
    ["Q5_K", 4173446336, "b335058ee1940937d7a95e1cf0f02fcad9c4ecb7a7cb8fce1a411eb55eeb2192"],
    ["Q4_K", 3514023104, "19ddbfbed61da4bb16ebf169aaf48e9e5db43aba557be1ee537e9f00f586092e"],
    ["Q3_K", 2813385920, "bb80b0e181a06652bd3faba076e5a066e10768dd8401adab508a352a9cd9de30"],
    ["Q2_K", 2277604544, "c017e7385478008f3b9ea7cbd8ba3449096830cad67a917e133af2d2821e6da3"],
  ]),
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

const zImageTurbo: LocalModel = {
  name: "z-image-turbo",
  title: "Z-Image Turbo",
  does: "generate",
  licence: { name: "Apache License 2.0", terms: "free for commercial use", url: "https://huggingface.co/Tongyi-MAI/Z-Image-Turbo", commercial: true },
  speed: "not measured yet; it takes 9 steps by default, against 16 for FLUX 3 Image Klein",
  docsUrl: sdcppDocs("z_image.md"),
  guideNotes: ["Its recipe takes no reference images: it does not edit."],
  recipe: {
    schema_version: 1,
    id: "z-image-turbo",
    name: "Z-Image Turbo",
    model_url: "https://huggingface.co/Tongyi-MAI/Z-Image-Turbo",
    slots: [
      { id: "diffusion_model", required: true },
      { id: "llm", required: true, label: "Qwen 3 Text Encoder" },
      { id: "vae", required: false },
      { id: "tae", required: false },
    ],
    required_any: [["vae", "tae"]],
    defaults: { sampling_method: "euler", cfg_scale: 1, steps: 9, width: 1024, height: 1024 },
    features: ["flow_shift"],
  },
  files: {
    llm: pinned("unsloth/Qwen3-4B-Instruct-2507-GGUF", "a06e946bb6b655725eafa393f4a9745d460374c9")(
      "text_encoders",
      "Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
      2497281120,
      "3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597",
    ),
    // FLUX.1's VAE.
    vae: pinned("Comfy-Org/Z-Image-Turbo", "6fc90a3b1b653e935a0d175e260736de25b84df5")(
      "vae",
      "split_files/vae/ae.safetensors",
      335304388,
      "afc8e28272cd15db3919bacdb6918ce9c1ed22e96cb12c4d5ed0fba823529e38",
    ),
  },
  quants: diffusionQuants("leejet/Z-Image-Turbo-GGUF", "c61c0e422dc8b541b7548cf33a4ef8302b0f8085", (quant) => `z_image_turbo-${quant}.gguf`, [
    ["Q8_0", 6577440704, "df1c5baa86d1398c979495a6072dbcee79444fdb884a2445582ba0769c44e9a1"],
    ["Q6_K", 5263239104, "319f627beac8059b7546f36a7b4d5097b7f4ee6a1fc37585d0f75ca1d12d01af"],
    ["Q5_0", 4542547904, "12b4a5c064cf8a0fa45d665c5b399d43effbcbeb37748d028d0d0d0fc34c2255"],
    ["Q4_K", 3864250304, "14b375ab4f226bc5378f68f37e899ef3c2242b8541e61e2bc1aff40976086fbd"],
    ["Q3_K", 3143559104, "4b44bdaa7814f20d7cf144e3939bd93aa32f50660204dd0c2aea5c5376232980"],
    ["Q2_K", 2592442304, "a9cf1b0368e24c2f9d542d2951c01f6f7fc85ed8c9ed39b5b37b15375508d58a"],
  ]),
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

const qwenLicence: LocalModel["licence"] = {
  name: "Qwen Research License",
  terms: "for research or evaluation only; commercial use needs a separate licence from Qwen",
  url: "https://huggingface.co/Qwen/Qwen-Image-2.1/blob/main/LICENSE",
  commercial: false,
};

/** The text encoder, its vision projector for editing, and the VAE, which Qwen-Image-2.1 and its Turbo share. */
const qwen3vl = pinned("Qwen/Qwen3-VL-8B-Instruct-GGUF", "f982a07559d4a2f6c8744d840bf6fccab30eea96");
const qwenFiles: Record<string, WeightFile> = {
  llm: qwen3vl(
    "text_encoders",
    "Qwen3VL-8B-Instruct-Q4_K_M.gguf",
    5027784800,
    "67d1659bfe71b89d50b45a4ad1a9e5b997e5bb16ce5da66a6a6167abd569e9e2",
  ),
  llm_vision: qwen3vl(
    "text_encoders",
    "mmproj-Qwen3VL-8B-Instruct-F16.gguf",
    1159029824,
    "ca524100ebf825c9a870db1c580d03879e0da0ab2541697e2458e64891cf9d38",
  ),
  vae: pinned("Comfy-Org/Qwen-Image-2.1", "aacf31a6d48e707f352ecba714cee0680da3479b")(
    "vae",
    "vae/qwen_image_2.1_vae_bf16.safetensors",
    675509688,
    "bb21f7473051e1ac368515dd3f2e15cd44d7a11748ee8823e1ddca3e4876b7c9",
  ),
};

const qwenSlots = [
  { id: "diffusion_model", required: true },
  { id: "llm", required: true, label: "Qwen 3 VL 8B Text Encoder" },
  { id: "llm_vision", required: false, label: "Vision projector (required for separate GGUF text encoders)" },
  { id: "vae", required: false, label: "Qwen Image 2.1 VAE" },
  { id: "tae", required: false, label: "TAEQI2.1" },
];

const qwenNotes = [
  "For a transparent image, write the prompt as: This is an RGBA image with transparency. <description>. The image has alpha channel and the background is transparent. Only png and webp keep the transparency.",
];

/** The Qwen table, with each quantisation by the name its files use. */
const qwenFit = (q4: string): LocalModel["fit"] => ({
  "macos-arm64": [
    [48, "Q8_0"],
    [32, "Q6_K"],
    [16, q4],
  ],
  "windows-cuda12": [
    [24, "Q8_0"],
    [16, "Q6_K"],
    [12, q4],
  ],
});

const qwenImage: LocalModel = {
  name: "qwen-image-2.1",
  title: "Qwen-Image-2.1",
  does: "generate, edit",
  licence: qwenLicence,
  speed: "not measured yet; it takes 20 steps by default, against 8 for Qwen-Image-2.1 Turbo",
  docsUrl: sdcppDocs("qwen_image_2.1.md"),
  guideNotes: [...qwenNotes, "stable-diffusion.cpp's examples use sample_params.guidance.txt_cfg 6 for this Model, against the recipe's 1."],
  recipe: {
    schema_version: 1,
    id: "qwen-image-21",
    name: "Qwen Image 2.1",
    size_multiple: 32,
    description:
      "Supports generation and editing. Select the full Qwen Image 2.1 VAE or TAEQI2.1. Supply a separate vision projector when needed. Select acceleration LoRAs and adjust their settings separately.",
    model_url: "https://huggingface.co/Qwen/Qwen-Image-2.1",
    slots: qwenSlots,
    required_any: [["vae", "tae"]],
    defaults: { sampling_method: "euler", cfg_scale: 1, steps: 20, width: 1024, height: 1024 },
    features: ["flow_shift", "ref_images"],
  },
  files: qwenFiles,
  quants: diffusionQuants("leejet/Qwen-Image-2.1-GGUF", "0bca76da6edd8a18211e9717454615c1bbaaf6ed", (quant) => `qwen_image_2.1-${quant}.gguf`, [
    ["Q8_0", 7687155744, "f8b244b00937f0e444a40dbf7866460871b89b30142594973b6012d1b471dc0a"],
    ["Q6_K", 5996851232, "1c51d1a8e6cf2b215719dea0c4f0f4cbfff9214a1c7571e57913f57d6a9c3c12"],
    ["Q5_0", 5069910048, "8dfeb1ee091a5d7c7d8191f69723254f031de8fe67ec219a21bf7df57590ab43"],
    ["Q4_K", 4197494816, "29f9c83c249ff0292fb2943fceddfa2319b446601866c82a4f8be062abea72c2"],
    ["Q3_K", 3270553632, "5a6352cb450d334ba17a9d18c7fd8c3e774799245b9da0f963ce0c6624deb758"],
    ["Q2_K", 2561716256, "5f79e41d3424abb230ee1486e1f4adab1b07c8c0fd10601fc402fe9890443fe6"],
  ]),
  fit: qwenFit("Q4_K"),
};

const qwenImageTurbo: LocalModel = {
  name: "qwen-image-2.1-turbo",
  title: "Qwen-Image-2.1 Turbo",
  does: "generate, edit",
  licence: { ...qwenLicence, url: "https://huggingface.co/Qwen/Qwen-Image-2.1-Turbo/blob/main/LICENSE" },
  speed: "about 1.5 minutes per 512x512 image, and under 2 for an edit, on a 16 GB M4 Mac at Q4_K_M; larger images take longer",
  docsUrl: sdcppDocs("qwen_image_2.1.md"),
  guideNotes: [
    ...qwenNotes,
    "Distilled for 8 steps at sample_params.guidance.txt_cfg 1.",
    "On the 16 GB M4 Mac at Q4_K_M, the weights took 9.4 GB of GPU memory and the system swapped about 5 GB; a 512x512 image took 84 s, 68 s of it for the 8 steps, and an edit with one 512x512 reference image 103 s.",
  ],
  recipe: {
    schema_version: 1,
    id: "qwen-image-21-turbo",
    name: "Qwen Image 2.1 Turbo",
    size_multiple: 32,
    description:
      "Use the standalone Turbo diffusion weights for generation and editing with the fixed 8-step schedule. Select the Qwen Image 2.1 VAE or TAEQI2.1, and supply a vision projector when needed.",
    model_url: "https://huggingface.co/Qwen/Qwen-Image-2.1-Turbo",
    slots: qwenSlots,
    required_any: [["vae", "tae"]],
    defaults: {
      sampling_method: "euler",
      cfg_scale: 1,
      steps: 8,
      width: 1024,
      height: 1024,
      custom_sigmas: [1.0, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0.0],
    },
    features: ["ref_images"],
  },
  files: qwenFiles,
  quants: diffusionQuants("unsloth/Qwen-Image-2.1-Turbo-GGUF", "bd53e520a64472adaff780da0b2f2d7eb1605e30", (quant) => `qwen-image-2.1-turbo-${quant}.gguf`, [
    ["Q8_0", 7640860480, "399d2ddc3636f36456e2f5bfa57187da4e38721bc046430317f42a9eab5b1712"],
    ["Q6_K", 6271551296, "f4560fb47ad863ffed7e32737d3c42988c44bd0c459606777d7ffe2e895d0a70"],
    ["Q5_K_M", 5390223168, "37c51ff446f4db2e131a9d12c003f0c0e824c8b8ba4dcd8c6cd5753f13457f5f"],
    ["Q4_K_M", 4199565120, "8940e8b522af886e0c0f5afddf720e82dd223cb9a43580b5f61c4d740452ac20"],
    ["Q3_K_M", 3168290624, "2fd16e6590c8153980f0de4d8965007d8cf3cc497240e74c03db7bb05e799467"],
    ["Q2_K", 2466137920, "19c0c8aba44d7dbd760e0d916e3eae8dcc285244cbeca98c34aa0e59c32fb709"],
  ]),
  fit: qwenFit("Q4_K_M"),
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
  models: [flux3Klein, zImageTurbo, qwenImage, qwenImageTurbo],
};
