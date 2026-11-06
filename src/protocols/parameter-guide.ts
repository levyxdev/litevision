/**
 * The Parameter Guide (ADR 0010): what litevision knows in advance about a Model's request parameters, written from
 * the Provider's docs and shipped with each release. It informs the Agent; nothing is checked or refused against it.
 */

/** One request parameter, under the Provider's own field name. */
export interface GuideParameter {
  /** The field name in the request body, dotted for nested fields, e.g. `response_format.image_size`. */
  name: string;
  /** Its allowed values: an enum, a range or a rule in words. */
  values: string;
  /** What the Provider uses when the field is not sent, e.g. `auto`, or "the Provider picks". */
  default: string;
  /** How the value changes the price, in words; "no effect" or "not documented" where that is what is known. */
  price: string;
}

/**
 * A request field that carries the requested shape: a field holding `WIDTHxHEIGHT` or a ratio such as `16:9`, or a
 * pair of fields holding the width and height in pixels.
 */
export type ShapeField = string | { width: string; height: string };

/** The built-in Parameter Guide entry for one model family. */
export interface ParameterGuide {
  /** The family's name, e.g. "GPT Image 2.5". */
  family: string;
  parameters: GuideParameter[];
  /** Where the entry was written from. */
  sources: string[];
  /** When the sources were last checked, as an ISO date. */
  checked: string;
  /** Anything uncertain, or where the sources disagree. */
  notes?: string[];
  /** The fields the result check reads the requested shape from, tried in order (ADR 0006, ADR 0010). */
  shapeFields: ShapeField[];
  /** The field the result check reads the requested length in seconds from; video only. */
  durationField?: string;
}

/** A few words on a guide for the full list: its family, check date and parameter names. */
export function guideSummary(guide: ParameterGuide): string {
  return `Parameter Guide for ${guide.family} (checked ${guide.checked}): ${guide.parameters.map((parameter) => parameter.name).join(", ")}.`;
}

/** The whole guide as text, one parameter per line. */
export function guideText(guide: ParameterGuide): string {
  const lines = [
    `Parameter Guide for ${guide.family}, checked ${guide.checked} (sources: ${guide.sources.join(", ")}):`,
    ...guide.parameters.map(
      (parameter) => `- ${parameter.name}: ${parameter.values} Default: ${parameter.default}. Price: ${parameter.price}`,
    ),
    ...(guide.notes ?? []).map((note) => `Note: ${note}`),
  ];
  return lines.join("\n");
}

/** The guide as `list_models` gives it in structured output. */
export function guideOutput(guide: ParameterGuide) {
  return {
    family: guide.family,
    checked: guide.checked,
    sources: guide.sources,
    parameters: guide.parameters.map((parameter) => ({ ...parameter })),
    notes: guide.notes ?? [],
  };
}

/** Finds the entry whose pattern matches a model id; relay prefixes such as `openai/` are ignored. */
export function guideFor(entries: Array<{ matches: RegExp; guide: ParameterGuide }>, modelId: string): ParameterGuide | undefined {
  const bare = modelId.replace(/^.*\//, "");
  return entries.find((entry) => entry.matches.test(modelId) || entry.matches.test(bare))?.guide;
}
