import { catalog, licenceLine, memoryLabel, platformLabel, type LocalModel, type Platform } from "../../local/catalog.ts";
import type { GuideParameter, ParameterGuide } from "../parameter-guide.ts";

/**
 * Written from each local Model's sd-server recipe, stable-diffusion.cpp's docs and the model cards, and what was
 * measured on a 16 GB M4 Mac. The licence and the weights each quantisation downloads come from the catalog
 * `local install` uses, so the guide and the install never disagree.
 */

const checked = "2026-11-16";

const api = "https://github.com/leejet/stable-diffusion.cpp/blob/master-1104-5dcfa79/examples/server/api.md";

const samplers =
  "euler, euler_a, heun, dpm2, dpm++2s_a, dpm++2m, dpm++2mv2, ipndm, ipndm_v, lcm, ddim_trailing, tcd, res_multistep, res_2s, er_sde, euler_cfg_pp, euler_a_cfg_pp, euler_ge, dpm++2m_sde, dpm++2m_sde_bt, lms.";

const schedulers =
  "discrete, karras, exponential, ays, gits, sgm_uniform, simple, smoothstep, kl_optimal, lcm, bong_tangent, ltx2, logit_normal, flux2, flux, beta, llada_image.";

const free = "free, as it runs on the User's machine";

const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;

/** The weights each quantisation downloads in all, and the memory `local install` chooses each for. */
function memoryNote(model: LocalModel): string {
  const shared = Object.values(model.files).reduce((sum, file) => sum + file.size, 0);
  const sizes = Object.entries(model.quants).map(([quant, files]) => `${quant} ${gb(shared + Object.values(files).reduce((sum, file) => sum + file.size, 0))}`);
  const fits = (Object.keys(model.fit) as Platform[]).map(
    (platform) => `on ${platformLabel[platform]}, ${model.fit[platform].map(([gbFrom, quant]) => `${quant} from ${gbFrom} GB ${memoryLabel[platform]}`).join(", ")}`,
  );
  return `Weights per quantisation, all files together: ${sizes.join(", ")}. \`local install\` chooses ${fits.join("; ")}; below the last, the Model will likely not fit.`;
}

function guideOf(model: LocalModel): ParameterGuide {
  const { recipe } = model;
  const { defaults, features } = recipe;
  const multiple = recipe.size_multiple ?? 8;
  const size = (side: "width" | "height"): GuideParameter => ({
    name: side,
    values: `pixels, a multiple of ${multiple}.`,
    default: String(defaults[side]),
    price: `${free}; more pixels take longer.`,
  });
  const parameters: GuideParameter[] = [
    size("width"),
    size("height"),
    {
      name: "sample_params.sample_steps",
      values: defaults.custom_sigmas === undefined ? "a positive integer." : "set by sample_params.custom_sigmas, so changing this alone does not change the steps.",
      default: String(defaults.steps),
      price: `${free}; each step adds time.`,
    },
    {
      name: "sample_params.guidance.txt_cfg",
      values: "a number; 1 turns classifier-free guidance off.",
      default: String(defaults.cfg_scale),
      price: `${free}; above 1 each step runs the Model twice, so it takes about twice as long.`,
    },
    { name: "sample_params.sample_method", values: samplers, default: defaults.sampling_method, price: "no effect." },
    { name: "sample_params.scheduler", values: schedulers, default: "the Model's own", price: "no effect." },
    ...(features.includes("flow_shift") ? [{ name: "sample_params.flow_shift", values: "a number.", default: "the Model's own", price: "no effect." }] : []),
    ...(defaults.custom_sigmas === undefined
      ? []
      : [
          {
            name: "sample_params.custom_sigmas",
            values: "sigmas from highest to 0; their count, less one, is the number of steps.",
            default: `the recipe's ${JSON.stringify(defaults.custom_sigmas)}`,
            price: `${free}; each step adds time.`,
          },
        ]),
    ...(features.includes("ref_images")
      ? [{ name: "ref_images", values: "images to edit or draw from; litevision fills it from `references`.", default: "none", price: `${free}; each reference image adds time.` }]
      : []),
    { name: "negative_prompt", values: "text; it acts only when sample_params.guidance.txt_cfg is above 1.", default: "none", price: "no effect." },
    { name: "seed", values: "an integer; -1 picks one at random.", default: "-1", price: "no effect." },
    { name: "batch_count", values: "images per Job; litevision sends `n` here.", default: "1", price: `${free}; each image takes as long as one alone.` },
    { name: "output_format", values: "png, jpeg, webp.", default: "png", price: "no effect." },
  ];
  return {
    family: model.title,
    parameters,
    sources: [model.docsUrl, api, recipe.model_url],
    checked,
    notes: [
      licenceLine(model),
      `Speed: ${model.speed}.`,
      memoryNote(model),
      ...model.guideNotes,
    ],
    shapeFields: [{ width: "width", height: "height" }],
    formatField: "output_format",
  };
}

const guides = new Map(catalog.models.map((model) => [model.recipe.id, guideOf(model)]));

/** The guide for a Model litevision installs, by its recipe id; none for a recipe of the User's own. */
export function sdcppGuide(modelId: string): ParameterGuide | undefined {
  return guides.get(modelId);
}
