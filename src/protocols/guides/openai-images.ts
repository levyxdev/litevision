import { guideFor, type ParameterGuide } from "../parameter-guide.ts";

/** Written from OpenAI's images API reference, image generation guide and model pages, checked 2026-11-05. */

const checked = "2026-11-05";

const sources = [
  "https://developers.openai.com/api/reference/resources/images/methods/generate",
  "https://developers.openai.com/api/reference/resources/images/methods/edit",
  "https://developers.openai.com/api/docs/guides/image-generation",
];

const shared = {
  background: {
    name: "background",
    values: "auto, opaque, transparent (transparent needs output_format png or webp).",
    default: "auto",
    price: "no effect.",
  },
  outputFormat: {
    name: "output_format",
    values: "png, jpeg, webp.",
    default: "png",
    price: "no effect.",
  },
  outputCompression: {
    name: "output_compression",
    values: "0–100, for jpeg and webp.",
    default: "100",
    price: "no effect.",
  },
  moderation: { name: "moderation", values: "auto, low.", default: "auto", price: "no effect." },
  n: { name: "n", values: "1–10 images per request; litevision sends `n` here.", default: "1", price: "each image is billed." },
};

const arbitrarySize =
  "auto, or any WIDTHxHEIGHT: both sides multiples of 16, the long side at most 3:1 to the short, at most 3840 a side, 655,360–8,294,400 pixels in all (above 2560x1440 is experimental). Popular: 1024x1024, 1536x1024, 1024x1536, 2048x2048, 2048x1152, 3840x2160, 2160x3840.";

const sizePrice = "billed by output tokens, which grow with the size and the quality; a larger non-square size can cost fewer tokens than a square.";

const gptImage25: ParameterGuide = {
  family: "GPT Image 2.5",
  parameters: [
    { name: "size", values: arbitrarySize, default: "auto", price: sizePrice },
    {
      name: "quality",
      values: "auto, low, medium, high, xhigh, max.",
      default: "auto",
      price: "the main price lever: at 1024x1024 about $0.006 low, $0.013 medium, $0.053 high, up to $0.21 max ($30 per 1M image output tokens).",
    },
    shared.background,
    shared.outputFormat,
    shared.outputCompression,
    shared.moderation,
    shared.n,
  ],
  sources: [...sources, "https://developers.openai.com/api/docs/models/gpt-image-2.5-flare"],
  checked,
  shapeFields: ["size"],
};

const gptImage26: ParameterGuide = {
  ...gptImage25,
  family: "GPT Image 2.6",
  parameters: [
    ...gptImage25.parameters,
    { name: "complexity", values: "low, medium, high.", default: "high", price: "no separate fee." },
  ],
  sources: [...sources, "https://developers.openai.com/api/docs/models/gpt-image-2.6-sunburst"],
  notes: ["The size rule above is GPT Image 2.5's: OpenAI does not say outright that 2.6 still images take arbitrary sizes."],
};

const gptImage2: ParameterGuide = {
  family: "GPT Image 2",
  parameters: [
    { name: "size", values: arbitrarySize, default: "auto", price: sizePrice },
    {
      name: "quality",
      values: "auto, low, medium, high.",
      default: "auto",
      price: "1024x1024 costs $0.006 low, $0.053 medium, $0.211 high; 1536x1024 and 1024x1536 cost $0.005, $0.041, $0.165.",
    },
    { ...shared.background, values: "auto, opaque, transparent (transparent is a preview on gpt-image-2)." },
    shared.outputFormat,
    shared.outputCompression,
    shared.moderation,
    shared.n,
  ],
  sources: [...sources, "https://developers.openai.com/api/docs/models/gpt-image-2"],
  checked,
  shapeFields: ["size"],
};

const gptImage1: ParameterGuide = {
  family: "GPT Image 1.x",
  parameters: [
    {
      name: "size",
      values: "auto, 1024x1024, 1536x1024, 1024x1536.",
      default: "auto",
      price: "gpt-image-1.5: portrait and landscape cost about 1.5 times the square.",
    },
    {
      name: "quality",
      values: "auto, low, medium, high.",
      default: "auto",
      price: "gpt-image-1.5 at 1024x1024: $0.009 low, $0.034 medium, $0.133 high; gpt-image-1-mini: $0.005, $0.011, $0.036.",
    },
    { name: "input_fidelity", values: "high, low (gpt-image-1-mini takes low only).", default: "low", price: "not documented." },
    shared.background,
    shared.outputFormat,
    shared.outputCompression,
    shared.moderation,
    shared.n,
  ],
  sources: [...sources, "https://developers.openai.com/api/docs/models/gpt-image-1.5"],
  checked,
  notes: ["OpenAI marks gpt-image-1.5 deprecated and shut gpt-image-1 down on 2026-10-23; a relay may still serve them."],
  shapeFields: ["size"],
};

const entries = [
  { matches: /^gpt-image-2\.6(-|$)/, guide: gptImage26 },
  { matches: /^gpt-image-2\.5(-|$)/, guide: gptImage25 },
  { matches: /^gpt-image-2(-\d{4}-\d{2}-\d{2})?$/, guide: gptImage2 },
  { matches: /^(gpt-image-1(\.5|-mini)?|chatgpt-image-latest)$/, guide: gptImage1 },
];

export const openaiImagesGuide = (modelId: string): ParameterGuide | undefined => guideFor(entries, modelId);
