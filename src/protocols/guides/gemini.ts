import { guideFor, type ParameterGuide } from "../parameter-guide.ts";
import { googleTierSizes } from "./google-sizes.ts";

/** Written from Google's image generation guide, Interactions API reference, model pages and pricing, checked 2026-11-05. */

const checked = "2026-11-05";

const sources = [
  "https://ai.google.dev/gemini-api/docs/image-generation",
  "https://aistudio.google.com/api-reference/interactions-api/create-interaction",
  "https://ai.google.dev/gemini-api/docs/pricing",
];

const tenRatios = "1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9";
const fourteenRatios = `${tenRatios}, 1:4, 4:1, 1:8, 8:1`;

const ratio = (ratios: string) => ({
  name: "response_format.aspect_ratio",
  values: `${ratios}.`,
  default: "the shape of the input image, else 1:1",
  price: "no effect: every ratio of a tier costs the same.",
});

const mimeType = { name: "response_format.mime_type", values: "image/jpeg.", default: "the Provider picks", price: "no effect." };

const imageSize = (values: string, price: string) => ({
  name: "response_format.image_size",
  values: `${values} Uppercase K: a lowercase 1k is rejected.`,
  default: "1K",
  price,
});

const shape = ["response_format.aspect_ratio"];

const nanoBanana21: ParameterGuide = {
  family: "Nano Banana 2.1 (gemini-nano-banana-2.1)",
  parameters: [
    ratio(fourteenRatios),
    imageSize("1K, 2K, 4K (16:9: 1376x768, 2752x1536, 5504x3072).", "about $0.034 at 1K, $0.050 at 2K, $0.113 at 4K ($30 per 1M image tokens)."),
    mimeType,
  ],
  sources: [...sources, "https://ai.google.dev/gemini-api/docs/models/gemini-nano-banana-2.1"],
  checked,
  notes: ["4K tokens: the image guide says 2520, the pricing page 3780 ($0.113); the price above follows the pricing page."],
  shapeFields: shape,
  // Only 16:9's sizes are documented for this model.
  tierSizes: googleTierSizes(["1K", "2K", "4K"], ["16:9"]),
};

const flash31: ParameterGuide = {
  family: "Nano Banana 2 (gemini-3.1-flash-image)",
  parameters: [
    ratio(fourteenRatios),
    imageSize("512, 1K, 2K, 4K (16:9: 688x384, 1376x768, 2752x1536, 5504x3072).", "about $0.045 at 512, $0.067 at 1K, $0.101 at 2K, $0.151 at 4K."),
    mimeType,
  ],
  sources: [...sources, "https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-image"],
  checked,
  notes: [
    'The small tier\'s value is "512" (the guide also calls it 0.5K).',
    "The guide prints 21:9 at 512 as 792x168, which is not 21:9; probably 792x336.",
  ],
  shapeFields: shape,
  tierSizes: googleTierSizes(["512", "1K", "2K", "4K"]),
};

const flashLite31: ParameterGuide = {
  family: "Nano Banana 2 Lite (gemini-3.1-flash-lite-image)",
  parameters: [ratio(tenRatios), imageSize("1K only; 2K and 4K are not supported.", "about $0.034 per image."), mimeType],
  sources: [...sources, "https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-lite-image"],
  checked,
  notes: ['The model page speaks of "14 aspect ratios" but lists the 10 above.', "Not optimized for several reference images."],
  shapeFields: shape,
};

const pro3: ParameterGuide = {
  family: "Nano Banana Pro (gemini-3-pro-image)",
  parameters: [
    ratio(tenRatios),
    imageSize("1K, 2K, 4K (16:9: 1376x768, 2752x1536, 5504x3072).", "about $0.134 at 1K, the same at 2K, $0.24 at 4K."),
    mimeType,
  ],
  sources: [...sources, "https://ai.google.dev/gemini-api/docs/models/gemini-3-pro-image"],
  checked,
  notes: ["Up to 14 reference images, 5 of them with high fidelity."],
  shapeFields: shape,
  tierSizes: googleTierSizes(["1K", "2K", "4K"], tenRatios.split(", ")),
};

const flash25: ParameterGuide = {
  family: "Nano Banana (gemini-2.5-flash-image)",
  parameters: [
    { ...ratio(tenRatios), values: `${tenRatios}; one size each (16:9 is 1344x768).` },
    mimeType,
  ],
  sources: [...sources, "https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash-image"],
  checked,
  notes: ["Takes no image_size. Works best with up to 3 reference images.", "Costs $0.039 per image."],
  shapeFields: shape,
};

const entries = [
  { matches: /gemini-nano-banana-2\.1/, guide: nanoBanana21 },
  { matches: /gemini-3\.1-flash-lite-image/, guide: flashLite31 },
  { matches: /gemini-3\.1-flash-image/, guide: flash31 },
  { matches: /gemini-3-pro-image/, guide: pro3 },
  { matches: /gemini-2\.5-flash-image/, guide: flash25 },
];

export const geminiGuide = (modelId: string): ParameterGuide | undefined => guideFor(entries, modelId);
