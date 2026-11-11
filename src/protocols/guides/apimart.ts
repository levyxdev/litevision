import { guideFor, type GuideParameter, type ParameterGuide } from "../parameter-guide.ts";

/**
 * Written from APIMart's per-model docs pages, checked 2026-11-05. APIMart's own schema endpoint, when it answers, wins
 * over these (ADR 0010).
 */

const checked = "2026-11-05";
const page = (path: string) => `https://docs.apimart.ai/en/api-reference/images/${path}`;
const pricing = "https://apimart.ai/pricing";
const pricingNote = "APIMart publishes prices only on its pricing page, which depends on the account tier; figures here are approximate.";

const references = (count: string): GuideParameter => ({
  name: "image_urls",
  values: `${count}; litevision uploads \`references\` through APIMart's upload endpoint and fills this with the links.`,
  default: "none",
  price: "not documented.",
});

const count = (range: string): GuideParameter => ({
  name: "n",
  values: `${range} images per task; litevision sends \`n\` here, or one task per image where the model makes one at a time.`,
  default: "1",
  price: "each image is billed.",
});

const fifteenRatios = "1:1, 3:2, 2:3, 4:3, 3:4, 5:4, 4:5, 16:9, 9:16, 2:1, 1:2, 3:1, 1:3, 21:9, 9:21";
const exactPixels = "or exact WIDTHxHEIGHT under OpenAI's rule (multiples of 16, at most 3840 a side and 3:1, 655,360–8,294,400 pixels)";
const gptTiers = "1k, 2k, 4k (16:9 is 1536x864, 2048x1152 or 3840x2160).";

const gptImage25: ParameterGuide = {
  family: "GPT Image 2.5 / 2.6 on APIMart",
  parameters: [
    { name: "size", values: `auto, ${fifteenRatios}, ${exactPixels}.`, default: "auto", price: "set by resolution." },
    { name: "resolution", values: `${gptTiers} Ignored for exact pixels.`, default: "1k", price: "billed by output tokens, which grow with the tier and the quality." },
    { name: "quality", values: "auto, low, medium, high, xhigh, max.", default: "auto", price: "at 1024x1024 about $0.006 low to $0.21 max ($30 per 1M output tokens)." },
    { name: "background", values: "auto, opaque, transparent.", default: "auto", price: "no effect." },
    { name: "moderation", values: "auto, low.", default: "low", price: "no effect." },
    references("up to 16 public links"),
    count("1–4"),
  ],
  sources: [page("gpt-image-2.5/generation"), page("gpt-image-2.6/generation"), pricing],
  checked,
  notes: ["GPT Image 2.6 adds complexity, markup_url, GIF and SVG output.", pricingNote],
  shapeFields: ["size"],
  // Only 16:9's sizes are documented, as in the resolution values above.
  tierSizes: { "1k": { "16:9": "1536x864" }, "2k": { "16:9": "2048x1152" }, "4k": { "16:9": "3840x2160" } },
};

const gptImage2: ParameterGuide = {
  family: "GPT Image 2 on APIMart",
  parameters: [
    { name: "size", values: `auto (= 1:1), ${fifteenRatios}, ${exactPixels}.`, default: "1:1", price: "set by resolution." },
    { name: "resolution", values: gptTiers, default: "1k", price: "about $0.0085 at 1K, $0.015 at 2K, $0.022 at 4K per image." },
    references("up to 15 links or data URIs (gpt-image-2-official: up to 16 public links)"),
    count("1 (gpt-image-2-official: 1–4)"),
  ],
  sources: [page("gpt-image-2/generation"), page("gpt-image-2/official"), pricing],
  checked,
  notes: [
    "Without size, the output takes the input image's resolution.",
    "The gpt-image-2 page gives two pixel sizes for many 1k ratios (1:1 is 1024x1024 or 1254x1254), so the exact 1k output is uncertain.",
    pricingNote,
  ],
  shapeFields: ["size"],
};

const gptImageExt: ParameterGuide = {
  family: "GPT Image 2.5 / 2.6 Ext on APIMart",
  parameters: [
    { name: "size", values: "auto, 1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3, 5:4, 4:5, 21:9; no exact pixels.", default: "auto", price: "no effect." },
    { name: "resolution", values: "1K, 2K, 4K (gpt-image-2.6-ext: only 1k today).", default: "1K", price: "about $0.0085 at 1K, $0.03 at 2K, $0.04 at 4K per image." },
    { name: "version", values: "flare, sunburst.", default: "the Provider picks", price: "billed by version × resolution × images delivered." },
    references("up to 16 links or data URIs"),
    count("1–4 (gpt-image-2.6-ext: 1)"),
  ],
  sources: [page("gpt-image-2.5-ext/generation"), page("gpt-image-2.6-ext/generation"), pricing],
  checked,
  notes: [pricingNote],
  shapeFields: ["size"],
};

const gptImage1: ParameterGuide = {
  family: "GPT Image 1 / 1.5 on APIMart",
  parameters: [
    { name: "size", values: "1:1, 3:2, 2:3 (1024x1024, 1536x1024, 1024x1536).", default: "1:1", price: "not documented." },
    { name: "quality", values: "auto, low, medium, high.", default: "auto", price: "not documented." },
    { name: "background", values: "auto, opaque, transparent.", default: "auto", price: "no effect." },
    references("up to 15 public links"),
    count("1–4"),
  ],
  sources: [page("gpt-image-1/generation")],
  checked,
  notes: ["OpenAI shut gpt-image-1 down on 2026-10-23."],
  shapeFields: ["size"],
};

const geminiRatios10 = "auto, 1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9";

const gemini = (family: string, path: string, ratios: string, tiers: string, refs: string, n: string, notes: string[]): ParameterGuide => ({
  family,
  parameters: [
    { name: "size", values: `${ratios}.`, default: "auto: the model decides, and image-to-image follows the reference", price: "no effect." },
    { name: "resolution", values: tiers, default: "1K", price: "higher tiers cost more." },
    references(refs),
    count(n),
  ],
  sources: [page(path), pricing],
  checked,
  notes: [...notes, pricingNote],
  shapeFields: ["size"],
});

const seedream = (
  family: string,
  path: string,
  ratios: string,
  tiers: string,
  defaultTier: string,
  refs: string,
  n: string,
  notes: string[],
  defaultSize = "1:1",
): ParameterGuide => ({
  family,
  parameters: [
    { name: "size", values: `${ratios}.`, default: defaultSize, price: "no effect." },
    { name: "resolution", values: tiers, default: defaultTier, price: "higher tiers cost more." },
    references(refs),
    count(n),
  ],
  sources: [page(path), pricing],
  checked,
  notes: [...notes, pricingNote],
  shapeFields: ["size"],
});

const seedreamRatios = "1:1, 4:3, 3:4, 16:9, 9:16, 3:2, 2:3, 2:1, 1:2, 21:9, 9:21, auto (needs reference images)";

const flux2: ParameterGuide = {
  family: "FLUX.2 on APIMart",
  parameters: [
    { name: "size", values: "1:1, 4:3, 3:4, 16:9, 9:16, 3:2, 2:3, 21:9, 9:21, auto, or WIDTHxHEIGHT.", default: "1:1", price: "set by resolution." },
    { name: "resolution", values: "1MP, 2MP, 3MP, 4MP (1K, 2K, 4K are taken as 2MP, 3MP, 4MP; 16:9 is 1344x752 at 1MP, 2720x1536 at 4MP).", default: "2MP", price: "flux-2-pro about $0.024, $0.036, $0.048, $0.06." },
    { name: "width", values: "with height, in place of size: at least 64 each, at most 4,194,304 pixels.", default: "none", price: "by megapixels." },
    { name: "height", values: "with width, as above.", default: "none", price: "by megapixels." },
    { name: "safety_tolerance", values: "0–5.", default: "the Provider picks", price: "no effect." },
    { name: "seed", values: "any integer.", default: "random", price: "no effect." },
    references("up to 8"),
    count("1"),
  ],
  sources: [page("flux-2/generation"), pricing],
  checked,
  notes: ["steps (1–50) and guidance (1.5–10) apply to flux-2-flex only.", pricingNote],
  shapeFields: [{ width: "width", height: "height" }, "size"],
};

const fluxKontext: ParameterGuide = {
  family: "FLUX.1 Kontext on APIMart",
  parameters: [
    { name: "size", values: "1:1, 4:3, 3:4, 16:9, 9:16, 3:2, 2:3, 21:9, 9:21, auto; about a megapixel (16:9 is 1392x752). Pixels are mapped to the nearest ratio; width and height fail.", default: "1:1", price: "not documented." },
    references("up to 4"),
    count("1"),
  ],
  sources: [page("flux-kontext/generation")],
  checked,
  shapeFields: ["size"],
};

const flux3: ParameterGuide = {
  family: "FLUX 3 Image on APIMart",
  parameters: [
    { name: "aspect_ratio", values: "21:9, 2:1, 16:9, 3:2, 7:5, 4:3, 5:4, 1:1, 4:5, 3:4, 5:7, 2:3, 9:16, 1:2, 9:21, auto; also taken as size. Pixels are rejected.", default: "auto", price: "no effect." },
    { name: "resolution", values: "768sq, 1k, 1.5k, 2k, 4k (about 0.6, 1, 2, 4 and 16 MP).", default: "1k", price: "about $0.033, $0.038, $0.056, $0.08, $0.49." },
    { name: "safety_tolerance", values: "0–4.", default: "the Provider picks", price: "no effect." },
    references("up to 10"),
    count("1"),
  ],
  sources: [page("flux-3-image/generation"), pricing],
  checked,
  notes: ["seed, steps, guidance and negative_prompt are rejected.", pricingNote],
  shapeFields: ["aspect_ratio", "size"],
};

const entries: Array<{ matches: RegExp; guide: ParameterGuide }> = [
  { matches: /^gpt-image-2\.[56]-ext$/, guide: gptImageExt },
  { matches: /^gpt-image-2\.[56]-(flare|sunburst)$/, guide: gptImage25 },
  { matches: /^gpt-image-2(-ext|-official)?$/, guide: gptImage2 },
  { matches: /^gpt-image-1(\.5)?(-official)?$/, guide: gptImage1 },
  {
    matches: /^gemini-nano-banana-2\.1(-ext)?$/,
    guide: gemini(
      "Nano Banana 2.1 on APIMart",
      "gemini-nano-banana-2.1/generation",
      `${geminiRatios10}, 1:4, 4:1, 1:8, 8:1`,
      "1K, 2K, 4K; 0.5K and 512 are rejected, an unknown tier is taken as 1K.",
      "no fixed count, links or data URIs, up to 20 MB each",
      "1–4 (Ext: 1)",
      [],
    ),
  },
  {
    matches: /^(gemini-3\.1-flash-image-preview(-official)?|nano-banana-2(-ext)?)$/,
    guide: gemini(
      "Nano Banana 2 (Gemini 3.1 Flash Image) on APIMart",
      "gemini-3.1-flash/generation",
      `${geminiRatios10}, 1:4, 4:1, 1:8, 8:1`,
      "0.5K, 1K, 2K, 4K.",
      "up to 14",
      "1",
      ["APIMart calls the small tier 0.5K where Google's own API says 512."],
    ),
  },
  {
    matches: /^(gemini-3\.1-flash-lite-image(-ext)?|nano-banana-2-lite)$/,
    guide: gemini(
      "Nano Banana 2 Lite on APIMart",
      "gemini-3.1-flash/generation-lite",
      geminiRatios10,
      "1K only; 2K, 4K and 0.5K are silently taken as 1K.",
      "up to 14",
      "1–4",
      [],
    ),
  },
  {
    matches: /^(gemini-3-pro-image-preview(-official)?|nano-banana-pro(-ext)?)$/,
    guide: gemini("Nano Banana Pro on APIMart", "gemini-3-pro/generation", geminiRatios10, "1K, 2K, 4K.", "up to 14", "1", [
      "With size auto and no reference, the docs say the result is 1:1 or 16:9.",
    ]),
  },
  {
    matches: /^(gemini-2\.5-flash-image-preview(-official)?|nano-banana(-ext)?)$/,
    guide: gemini("Nano Banana on APIMart", "gemini-2.5-flash/generation", geminiRatios10, "1K only.", "up to 14", "1", [
      "APIMart allows 14 reference images; Google says the model works best with up to 3.",
      "Prompts of at most 1000 characters.",
    ]),
  },
  {
    matches: /^seedream-4[.-]0$/i,
    guide: seedream("Seedream 4.0 on APIMart", "seedream-4/generation", seedreamRatios, "1K, 2K, 4K.", "2K", "references and n together at most 15", "1–15", []),
  },
  {
    matches: /^seedream-4[.-]5$/i,
    guide: seedream("Seedream 4.5 on APIMart", "seedream-4.5/generation", seedreamRatios, "2K, 4K; no 1K (16:9 is 2560x1440 at 2K, 5404x3040 at 4K).", "2K", "references and n together at most 15", "1–15", [
      "More than one image switches to sequential mode; text-to-image alone cannot make several.",
    ]),
  },
  {
    matches: /^seedream-5[.-]0-lite$/i,
    guide: seedream("Seedream 5.0 Lite on APIMart", "seedream-5-lite/generation", seedreamRatios.replace(", 9:21", ""), "2K, 3K, 4K; no 1K.", "2K", "references and n together at most 15", "1–15", [
      'The page header says "2K / 3K" while the field lists 2K, 3K and 4K.',
    ]),
  },
  {
    matches: /^seedream-5[.-]0-(pro|flash)$/i,
    guide: {
      ...seedream(
        "Seedream 5.0 Pro / Flash on APIMart",
        "seedream-5-0-pro/generation",
        "auto, 1:1, 4:3, 3:4, 16:9, 9:16, 3:2, 2:3, 2:1, 1:2, 21:9, or exact pixels (921,600–4,624,220 pixels, ratio 1/16–16)",
        "1K, 1.5K, 2K; 3K and 4K are rejected.",
        "1K",
        "up to 10, the first free and each further one a fixed surcharge",
        "1",
        ['1.5K costs the same as 1K. The Flash page says "also accepted: seedream-5.0-pro", probably a copy error.'],
        "auto",
      ),
      sources: [page("seedream-5-0-pro/generation"), page("seedream-5-0-flash/generation"), pricing],
    },
  },
  { matches: /^flux-2-(flex|pro|max)$/, guide: flux2 },
  { matches: /^flux-kontext-(pro|max)$/, guide: fluxKontext },
  { matches: /^flux-3-image$/, guide: flux3 },
];

export const apimartGuide = (modelId: string): ParameterGuide | undefined => guideFor(entries, modelId);
