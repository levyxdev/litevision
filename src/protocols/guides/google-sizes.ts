import type { TierSizes } from "../parameter-guide.ts";

/**
 * Google's native sizes for its Gemini image models, from its image generation guide, shared by the Gemini and the
 * Together Parameter Guides.
 */

/**
 * Google's sizes per ratio at 512, 1K, 2K and 4K, as given for Gemini 3.1 Flash Image. Gemini 3 Pro Image's are its 1K,
 * 2K and 4K columns.
 */
export const googleSizes: Array<[ratio: string, ...sizes: string[]]> = [
  ["1:1", "512x512", "1024x1024", "2048x2048", "4096x4096"],
  ["1:4", "256x1024", "512x2048", "1024x4096", "2048x8192"],
  ["1:8", "192x1536", "384x3072", "768x6144", "1536x12288"],
  ["2:3", "424x632", "848x1264", "1696x2528", "3392x5056"],
  ["3:2", "632x424", "1264x848", "2528x1696", "5056x3392"],
  ["3:4", "448x600", "896x1200", "1792x2400", "3584x4800"],
  ["4:1", "1024x256", "2048x512", "4096x1024", "8192x2048"],
  ["4:3", "600x448", "1200x896", "2400x1792", "4800x3584"],
  ["4:5", "464x576", "928x1152", "1856x2304", "3712x4608"],
  ["5:4", "576x464", "1152x928", "2304x1856", "4608x3712"],
  ["8:1", "1536x192", "3072x384", "6144x768", "12288x1536"],
  ["9:16", "384x688", "768x1376", "1536x2752", "3072x5504"],
  ["16:9", "688x384", "1376x768", "2752x1536", "5504x3072"],
  ["21:9", "792x168", "1584x672", "3168x1344", "6336x2688"],
];

/** The tiers of {@link googleSizes}'s columns, as Gemini's `image_size` writes them. */
export const googleTiers = ["512", "1K", "2K", "4K"];

/**
 * The sizes of the given tiers at the given ratios, by tier and then ratio, for a guide's `tierSizes`. Google's 21:9 at
 * 512, 792x168, is not 21:9, so it is left out rather than checked against.
 */
export function googleTierSizes(tiers: string[], ratios?: string[]): TierSizes {
  return Object.fromEntries(
    tiers.map((tier) => {
      const column = googleTiers.indexOf(tier) + 1;
      const rows = googleSizes.filter(([ratio]) => (ratios === undefined || ratios.includes(ratio)) && !(ratio === "21:9" && tier === "512"));
      return [tier, Object.fromEntries(rows.map((row) => [row[0], row[column]!]))];
    }),
  );
}
