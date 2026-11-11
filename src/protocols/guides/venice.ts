import { guideFor, type GuideParameter, type ParameterGuide } from "../parameter-guide.ts";

/**
 * Written from Venice's image API reference and its public model list, checked 2026-11-05. Venice's model list, when it
 * answers, wins over these: it is the source of truth for each model's sizes (ADR 0010).
 */

const checked = "2026-11-05";

const generateSources = [
  "https://docs.venice.ai/api-reference/endpoint/image/generate",
  "https://docs.venice.ai/models/image",
  "https://api.venice.ai/api/v1/models?type=image",
];

const editSources = [
  "https://docs.venice.ai/api-reference/endpoint/image/edit",
  "https://docs.venice.ai/api-reference/endpoint/image/multi-edit",
  "https://api.venice.ai/api/v1/models?type=inpaint",
];

const generateCommon: GuideParameter[] = [
  { name: "variants", values: "1–4 images per request; litevision sends `n` here.", default: "1", price: "each image is billed." },
  { name: "format", values: "jpeg, png, webp.", default: "png (litevision's choice; Venice's own is webp)", price: "no effect." },
  { name: "negative_prompt", values: "text.", default: "none", price: "no effect." },
  { name: "seed", values: "−999,999,999 to 999,999,999.", default: "random", price: "no effect." },
  { name: "safe_mode", values: "true, false.", default: "false (litevision's choice; Venice's own is true)", price: "no effect." },
  { name: "hide_watermark", values: "true, false.", default: "true (litevision's choice)", price: "no effect." },
];

const ratioShape = [{ width: "width", height: "height" }, "aspect_ratio"];

const pixelModels: ParameterGuide = {
  family: "Venice pixel-sized models (venice-sd35, wai-Illustrious, lustify, z-image-turbo, chroma)",
  parameters: [
    {
      name: "width",
      values: "1–1280, divisible by the model's widthHeightDivisor (16 for venice-sd35 and wai-Illustrious, 8 for the rest).",
      default: "1024",
      price: "$0.01 per image whatever the size.",
    },
    { name: "height", values: "as width.", default: "1024", price: "as width." },
    { name: "cfg_scale", values: "0–20.", default: "the Provider picks", price: "no effect." },
    { name: "steps", values: "per model (venice-sd35: up to 30).", default: "per model (venice-sd35: 25)", price: "no effect." },
    ...generateCommon,
  ],
  sources: generateSources,
  checked,
  shapeFields: ratioShape,
};

const tierModels: ParameterGuide = {
  family: "Venice models sized by aspect ratio and resolution tier",
  parameters: [
    {
      name: "aspect_ratio",
      values: "per model, most of 1:1, 3:2, 16:9, 21:9, 9:16, 2:3, 3:4, 4:5 (grok-imagine-* lack 21:9 and 4:5 in part; 4:3 only on seedream-v5-*).",
      default: "1:1",
      price: "no effect.",
    },
    {
      name: "resolution",
      values: "1K, 2K, and on some models 4K; per model.",
      default: "1K",
      price:
        "per model at 1K / 2K / 4K: gpt-image-2-5-flare and -sunburst $0.07 / $0.15 / $0.23; gpt-image-2 $0.27 / $0.51 / $0.84; nano-banana-2 and -2-1 $0.10 / $0.14 / $0.19; nano-banana-pro $0.18 / $0.23 / $0.35; flux-3-image $0.12 / $0.29 / $0.98; krea-2-turbo $0.04 / $0.06; grok-imagine-image $0.03 / $0.04; seedream-v5-pro $0.06 / $0.11; qwen-image-3-pro $0.05 / $0.09; the same at 1K and 2K on ideogram-v4-5 ($0.26), qwen-image-3 ($0.04), qwen-image-2-1-turbo ($0.02) and qwen-image-2-1-pro ($0.05).",
    },
    {
      name: "quality",
      values: "low, medium, high on models that list qualities (gpt-image-2*, ideogram-v4-5; grok-imagine-image-2-0 low, medium).",
      default: "high",
      price: "gpt-image-2 at 1K: $0.02 low, $0.07 medium, $0.26 high; gpt-image-2.5 at 1K: $0.03, $0.04, $0.07.",
    },
    ...generateCommon,
  ],
  sources: generateSources,
  checked,
  notes: ["Venice publishes no pixel sizes for these models.", "gpt-image-2's headline prices are $0.01 above its per-quality high prices; both are in Venice's model list."],
  shapeFields: ratioShape,
};

const ratioModels: ParameterGuide = {
  family: "Venice models sized by aspect ratio",
  parameters: [
    {
      name: "aspect_ratio",
      values: "per model, most of 1:1, 3:2, 16:9, 21:9, 9:16, 2:3, 3:4, 4:5 (gpt-image-1-5: 1:1, 3:2, 2:3; flux-2-max also auto).",
      default: "1:1 (flux-2-max: auto)",
      price:
        "no effect; per image: flux-2-pro $0.03, flux-2-max $0.09, gpt-image-1-5 $0.26, hunyuan-image-v3 $0.09, ideogram-v4 $0.06, krea-v2-large $0.07, krea-v2-medium $0.04, luma-uni-1 $0.05, luma-uni-1-max $0.12, muse-image $0.02, nano-banana-2-lite $0.06, recraft-v4 $0.05, recraft-v4-pro $0.29, seedream-v4 $0.05, seedream-v5-lite $0.05, qwen-image $0.03, qwen-image-2 $0.05, qwen-image-2-pro $0.10, wan-2-7-text-to-image $0.0375, wan-2-7-pro-text-to-image $0.094.",
    },
    ...generateCommon,
  ],
  sources: generateSources,
  checked,
  notes: ["The Qwen Image models reject width and height with a 400.", "krea-v2-* and luma-uni-1* take up to 3 style_references."],
  shapeFields: ratioShape,
};

const editModels: ParameterGuide = {
  family: "Venice edit models (`-edit`)",
  parameters: [
    {
      name: "aspect_ratio",
      values: "auto, 1:1, 3:2, 16:9, 21:9, 9:16, 2:3, 3:4, 4:3, 4:5; a subset per model.",
      default: "auto",
      price: "no effect.",
    },
    {
      name: "resolution",
      values: "1K, 2K, and on some models 4K; per model.",
      default: "1K",
      price: "per model, e.g. nano-banana-pro-edit $0.18 / $0.23 / $0.35, gpt-image-2-5-flare-edit $0.08 / $0.15 / $0.24.",
    },
    {
      name: "quality",
      values: "low, medium, high; only on /image/multi-edit (several references), where the model lists qualities. /image/edit rejects it.",
      default: "the model's default tier",
      price: "per model.",
    },
    { name: "output_format", values: "jpeg, png, webp.", default: "png (litevision's choice)", price: "no effect." },
  ],
  sources: editSources,
  checked,
  notes: [
    "Reference images per Job: the model list's maxInputImages, else 3, or 1 when combineImages is false. The multi-edit docs name capabilities.maxInputImages, the model list puts it in constraints.",
    "One reference image goes to /image/edit, several to /image/multi-edit; each image of a Job is its own request.",
  ],
  shapeFields: ["aspect_ratio"],
  formatField: "output_format",
};

const entries: Array<{ matches: RegExp; guide: ParameterGuide }> = [
  { matches: /(^|-)edit(-|$)/, guide: editModels },
  { matches: /^(venice-sd35|wai-Illustrious|lustify-(sdxl|v7|v8)|z-image-turbo|chroma)$/, guide: pixelModels },
  {
    matches:
      /^(gpt-image-2(-5-(flare|sunburst))?|nano-banana-(2|2-1|pro)|flux-3-image|krea-2-turbo|grok-imagine-image(-2-0)?|ideogram-v4-5|seedream-v5-pro|qwen-image-3(-pro)?|qwen-image-2-1-(turbo|pro))$/,
    guide: tierModels,
  },
  {
    matches:
      /^(flux-2-(pro|max)|gpt-image-1-5|hunyuan-image-v3|ideogram-v4|krea-v2-(large|medium)|luma-uni-1(-max)?|muse-image|nano-banana-2-lite|recraft-v4(-pro)?|seedream-v4|seedream-v5-lite|qwen-image(-2(-pro)?)?|wan-2-7(-pro)?-text-to-image)$/,
    guide: ratioModels,
  },
];

export const veniceGuide = (modelId: string): ParameterGuide | undefined => guideFor(entries, modelId);
