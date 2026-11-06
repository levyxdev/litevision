import { guideFor, type GuideParameter, type ParameterGuide } from "../parameter-guide.ts";

/** Written from Together's image and video docs, model catalog and OpenAPI schema, and BFL's FLUX.2 docs, checked 2026-11-05. */

const checked = "2026-11-05";

const imageSources = [
  "https://docs.together.ai/docs/inference/images/parameters",
  "https://docs.together.ai/docs/inference/images/reference-images",
  "https://docs.together.ai/docs/serverless/models",
];

const videoSources = [
  "https://docs.together.ai/docs/inference/videos/parameters",
  "https://docs.together.ai/docs/inference/videos/reference-and-keyframes",
  "https://docs.together.ai/docs/serverless/models#video-models",
];

const pixels = (range: string, price: string): GuideParameter[] => [
  { name: "width", values: `${range}, a multiple of 8.`, default: "1024", price },
  { name: "height", values: `${range}, a multiple of 8.`, default: "1024", price },
];

const common: GuideParameter[] = [
  { name: "n", values: "1–4 images per request; litevision sends `n` here.", default: "1", price: "each image is billed." },
  { name: "seed", values: "any integer.", default: "random", price: "no effect." },
  { name: "output_format", values: "jpeg, png.", default: "jpeg", price: "no effect." },
];

const imageShape = [{ width: "width", height: "height" }, "aspect_ratio"];

const flux2: ParameterGuide = {
  family: "FLUX.2 [pro], [flex], [dev]",
  parameters: [
    ...pixels("256–1920", "the [pro] and [flex] estimate is $0.03+ per image, [dev] $0.0154+; larger images cost more."),
    {
      name: "reference_images",
      values: "an array of image links; litevision fills it from `references`. Together gives no count; BFL says up to 10.",
      default: "none",
      price: "not documented.",
    },
    { name: "prompt_upsampling", values: "true, false.", default: "true", price: "no effect." },
    { name: "steps", values: "[dev] and [flex] only.", default: "the Provider picks", price: "not documented." },
    { name: "guidance", values: "[dev] and [flex] only.", default: "the Provider picks", price: "not documented." },
    ...common,
  ],
  sources: [...imageSources, "https://docs.together.ai/docs/quickstart-flux", "https://docs.bfl.ml/flux_2/flux2_overview"],
  checked,
  notes: [
    "Default size: the quickstart says 1024x768, the API reference 1024x1024.",
    "Most output: Together's quickstart says up to 9 MP for [pro], BFL says up to 4 MP.",
  ],
  shapeFields: imageShape,
};

const flux2Max: ParameterGuide = {
  family: "FLUX.2 [max]",
  parameters: [...pixels("assumed 256–1920 as for the other FLUX.2 models", "$0.07 per megapixel at 50 steps: doubling the pixels doubles the price."), ...common],
  sources: [...imageSources, "https://docs.together.ai/docs/quickstart-flux"],
  checked,
  notes: ["Together documents neither its size range nor reference images."],
  shapeFields: imageShape,
};

const kontext: ParameterGuide = {
  family: "FLUX.1 Kontext [pro], [max]",
  parameters: [
    {
      name: "aspect_ratio",
      values: 'a ratio such as "1:1", "16:9", "9:16", "4:3", "3:2" (examples Together gives).',
      default: "the Provider picks",
      price: "[pro] $0.04 and [max] $0.08 per megapixel.",
    },
    ...pixels("multiples of 8, in place of aspect_ratio", "billed per megapixel."),
    { name: "image_url", values: "one image link; litevision fills it from the first of `references`.", default: "none", price: "not documented." },
    { name: "steps", values: "an integer; more than the default costs proportionally more.", default: "28", price: "price × steps ÷ 28 above the default." },
    ...common,
  ],
  sources: [...imageSources, "https://docs.together.ai/docs/quickstart-flux"],
  checked,
  notes: ["`aspect_ratio` is in Together's docs but not in its OpenAPI schema."],
  shapeFields: imageShape,
};

const flux11: ParameterGuide = {
  family: "FLUX1.1 [pro]",
  parameters: [...pixels("multiples of 8", "$0.04 per megapixel: doubling the pixels doubles the price."), ...common],
  sources: imageSources,
  checked,
  notes: ["Takes no reference images."],
  shapeFields: imageShape,
};

const gemini3Pro: ParameterGuide = {
  family: "Gemini 3 Pro Image on Together",
  parameters: [
    {
      name: "width",
      values:
        "with height, one of Together's sizes: 1K 1024x1024, 1264x848, 848x1264, 1200x896, 896x1200, 928x1152, 1152x928, 768x1376, 1376x768, 1584x672; 2K 2048x2048, 2528x1696, 2752x1536 and the like; 4K 4096x4096, 5504x3072 and the like.",
      default: "1024",
      price: "$0.134 at 1K or 2K (the same), about $0.24 at 4K.",
    },
    { name: "height", values: "with width, as above.", default: "1024", price: "as width." },
    { name: "reference_images", values: "an array of image links; litevision fills it from `references`. Count not documented by Together (Google: up to 14).", default: "none", price: "not documented." },
    ...common,
  ],
  sources: imageSources,
  checked,
  notes: ['Together gives some sizes as alternatives ("1548x672 or 1584x672", "5096x3392 or 5056x3392"); Google says 1584x672 and 5056x3392.'],
  shapeFields: imageShape,
};

const flash25: ParameterGuide = {
  family: "Gemini 2.5 Flash Image on Together",
  parameters: [
    ...pixels("not documented by Together", "estimated at $0.039+ per image."),
    { name: "reference_images", values: "an array of image links; litevision fills it from `references`. Count not documented.", default: "none", price: "not documented." },
    ...common,
  ],
  sources: imageSources,
  checked,
  notes: ["Together documents no sizes for this model; Google's own sizes are about a megapixel at each ratio."],
  shapeFields: imageShape,
};

const imageEntries = [
  { matches: /^black-forest-labs\/FLUX\.2-max$/i, guide: flux2Max },
  { matches: /^black-forest-labs\/FLUX\.2-(pro|flex|dev)$/i, guide: flux2 },
  { matches: /^black-forest-labs\/FLUX\.1-kontext-(pro|max)$/i, guide: kontext },
  { matches: /^black-forest-labs\/FLUX\.1\.1-pro$/i, guide: flux11 },
  { matches: /^google\/gemini-3-pro-image$/i, guide: gemini3Pro },
  { matches: /^google\/flash-image-2\.5$/i, guide: flash25 },
];

const videoCommon: GuideParameter[] = [
  { name: "seed", values: "0–2,147,483,647.", default: "random", price: "no effect." },
  { name: "negative_prompt", values: "text, at most 500 characters.", default: "none", price: "no effect." },
  {
    name: "media.frame_images",
    values: 'litevision fills it from `first_frame` and `last_frame` as { input_image, frame: "first" | "last" }.',
    default: "none",
    price: "not documented.",
  },
];

const wan = (variant: string, seconds: string, media: string): ParameterGuide => ({
  family: `Wan 2.7 ${variant}`,
  parameters: [
    {
      name: "resolution",
      values: "720P, 1080P (16:9 is 1280x720 or 1920x1080; 4:3 is 1104x832 or 1648x1248).",
      default: "1080P",
      price: "$0.10 per video in Together's catalog, which gives no resolution or length.",
    },
    { name: "ratio", values: "16:9, 9:16, 1:1, 4:3, 3:4.", default: "16:9", price: "no effect." },
    { name: "seconds", values: `${seconds}, as a string.`, default: '"5"', price: "not documented." },
    ...videoCommon,
  ],
  sources: [...videoSources, "https://docs.together.ai/docs/wan2.7-quickstart"],
  checked,
  notes: [media, "30 fps MP4."],
  shapeFields: ["ratio"],
  durationField: "seconds",
});

const seedance25: ParameterGuide = {
  family: "Seedance 2.5",
  parameters: [
    { name: "resolution", values: "480p, 720p.", default: "720p", price: "480p $0.115 per second; 720p from $0.249 per second." },
    { name: "seconds", values: "4–30 whole seconds, as a string.", default: '"5"', price: "billed per second of output." },
    { name: "media.reference_images", values: "up to 30 image links; litevision fills it from `references`.", default: "none", price: "not documented." },
    ...videoCommon,
  ],
  sources: [...videoSources, "https://docs.together.ai/docs/seedance2.5-quickstart"],
  checked,
  notes: [
    "Takes no ratio, width or height: the shape follows the first frame, else the model picks. Audio is always on.",
    "Frames and references cannot be combined.",
    'The catalog lists $0.115 under "Price per video"; the quickstart says per second, which is what is given here.',
  ],
  shapeFields: [],
  durationField: "seconds",
};

const videoEntries = [
  { matches: /^Wan-AI\/wan2\.7-t2v$/i, guide: wan("text-to-video", "2–15", "Takes no frames or reference images.") },
  { matches: /^Wan-AI\/wan2\.7-i2v$/i, guide: wan("image-to-video", "2–15", "Takes a first and/or last frame.") },
  {
    matches: /^Wan-AI\/wan2\.7-r2v$/i,
    guide: wan("reference-to-video", "2–10", "Takes several reference images in media.reference_images; Together gives no count."),
  },
  { matches: /^ByteDance\/Seedance-2\.5$/i, guide: seedance25 },
];

export const togetherGuide = (modelId: string, modality: "image" | "video"): ParameterGuide | undefined =>
  guideFor(modality === "video" ? videoEntries : imageEntries, modelId);
