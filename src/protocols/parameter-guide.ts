import type { ProtocolAdapter } from "./protocol.ts";

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
  /** Where the entry was written from. A Protocol may take the first as the Model's docs link, as Together does. */
  sources: string[];
  /** When the sources were last checked, as an ISO date. */
  checked: string;
  /** Anything uncertain, or where the sources disagree. */
  notes?: string[];
  /** The fields the result check reads the requested shape from, tried in order (ADR 0006, ADR 0010). */
  shapeFields: ShapeField[];
  /** The field the result check reads the requested length in seconds from; video only. */
  durationField?: string;
  /**
   * The pixel size of each resolution tier at each aspect ratio, by tier as written and then ratio, e.g.
   * `{ "2K": { "16:9": "2752x1536" } }`, where the docs give them. A request naming a tier and a ratio found here is
   * checked against that size (ADR 0011); any other tier is not checked for size.
   */
  tierSizes?: TierSizes;
  /** The field the result check reads the requested file format from, where it is not the Protocol's. */
  formatField?: string;
}

/** Pixel sizes by resolution tier as written, then by aspect ratio, e.g. `{ "2K": { "16:9": "2752x1536" } }`. */
export type TierSizes = Record<string, Record<string, string>>;

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

/** The request fields litevision reads the requested shape, length and resolution tier from (ADR 0010). */
export interface RequestFields {
  shape: ShapeField[];
  duration?: string;
  /** The field holding the resolution tier, e.g. `resolution` (`4K`, `1080P`); checked only through `tierSizes`. */
  resolution?: string;
  /** The pixel size each tier makes at each ratio, from the Model's Parameter Guide. */
  tierSizes?: TierSizes;
  /** The field holding the file format, e.g. `output_format` (`png`) or `response_format.mime_type` (`image/png`). */
  format?: string;
}

/**
 * The fields to read a Model's requested shape, length, tier and format from: the shape and length from its guide
 * entry, else its Protocol's; the tier always from its Protocol, which names the one field every model of it uses, and
 * the sizes of its tiers from the guide; the format from the guide where it names one, else from the Protocol.
 */
export function fieldsToRead(
  adapter: Pick<ProtocolAdapter, "parameterGuide" | "requestFields">,
  modelId: string,
  modality: "image" | "video",
): RequestFields {
  const guide = adapter.parameterGuide?.(modelId, modality);
  const fallback = (modality === "video" ? adapter.requestFields.video : adapter.requestFields.image) ?? { shape: [] };
  if (guide === undefined) return fallback;
  return {
    shape: guide.shapeFields,
    ...(guide.durationField === undefined ? {} : { duration: guide.durationField }),
    ...(fallback.resolution === undefined ? {} : { resolution: fallback.resolution }),
    ...(guide.tierSizes === undefined ? {} : { tierSizes: guide.tierSizes }),
    ...(guide.formatField === undefined ? (fallback.format === undefined ? {} : { format: fallback.format }) : { format: guide.formatField }),
  };
}

/** A field's value in a request body; `path` is dotted for nested fields. */
export function valueAt(body: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => (typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined), body);
}

const positive = (value: unknown): number | undefined => {
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) && number > 0 ? number : undefined;
};

/** A shape as written, with its width-over-height ratio; undefined for a value such as `auto` that says no shape. */
export function parseShape(text: string): { label: string; ratio: number } | undefined {
  const match = /^\s*(\d+(?:\.\d+)?)\s*([x×:])\s*(\d+(?:\.\d+)?)\s*$/i.exec(text);
  if (match === null) return undefined;
  const width = Number(match[1]);
  const height = Number(match[3]);
  if (!(width > 0 && height > 0)) return undefined;
  return { label: `${match[1]}${match[2] === ":" ? ":" : "x"}${match[3]}`, ratio: width / height };
}

/** A size as written in pixels, e.g. `1792x2400`, from a shape label; undefined for a ratio such as `16:9`. */
export function parseSize(text: string): { width: number; height: number } | undefined {
  const match = /^(\d+)x(\d+)$/.exec(text);
  return match === null ? undefined : { width: Number(match[1]), height: Number(match[2]) };
}

/** The first of the shape fields a request body sets, which is the one its shape is read from; undefined when it sets none. */
function shapeFieldSet(fields: ShapeField[], body: Record<string, unknown>): ShapeField | undefined {
  return fields.find((field) =>
    typeof field === "string" ? valueAt(body, field) !== undefined : valueAt(body, field.width) !== undefined || valueAt(body, field.height) !== undefined,
  );
}

/**
 * The shape a request asks for, from the first of its shape fields it sets, e.g. `16:9` or `2048x1152`; null when it
 * sets none, or one that says no shape (e.g. `auto`).
 */
function readShape(fields: ShapeField[], body: Record<string, unknown>): string | null {
  const field = shapeFieldSet(fields, body);
  if (field === undefined) return null;
  if (typeof field === "string") {
    const value = valueAt(body, field);
    return typeof value === "string" ? (parseShape(value)?.label ?? null) : null;
  }
  const w = positive(valueAt(body, field.width));
  const h = positive(valueAt(body, field.height));
  return w === undefined || h === undefined ? null : `${w}x${h}`;
}

/** The `provider_options` key a request field is set through: the field itself, or for a dotted field its first part. */
export function optionKeyOf(field: string): string {
  return field.split(".")[0]!;
}

/** Every request field the result check may read, dotted for nested ones, e.g. `response_format.image_size`. */
export function fieldsChecked(fields: RequestFields): string[] {
  const shape = fields.shape.flatMap((field) => (typeof field === "string" ? [field] : [field.width, field.height]));
  return [...shape, fields.duration, fields.resolution, fields.format].filter((field) => field !== undefined);
}

/**
 * The request fields the result check reads from these options (ADR 0011), dotted for nested ones: for the shape,
 * those of the shape field it is read from; for the pixel size, the same for exact dimensions, else the tier field;
 * for the length and the format, their fields. Empty where the options set none.
 */
export function checkedOptionKeys(fields: RequestFields, options: Record<string, unknown>): Record<"shape" | "size" | "length" | "format", string[]> {
  const set = (field: string | undefined) => (field !== undefined && valueAt(options, field) !== undefined ? [field] : []);
  const shapeField = shapeFieldSet(fields.shape, options);
  const shape = shapeField === undefined ? [] : typeof shapeField === "string" ? [shapeField] : [...set(shapeField.width), ...set(shapeField.height)];
  const shapeRead = readShape(fields.shape, options);
  return {
    shape,
    // Exact pixels are read from the shape fields; otherwise the size is the tier's, so its Option Status is the tier's.
    size: shapeRead !== null && parseSize(shapeRead) !== undefined ? shape : set(fields.resolution),
    length: set(fields.duration),
    format: set(fields.format),
  };
}

/** The resolution tier a request asks for, as written, e.g. `4K`; null when the field is missing or not text. */
function readResolution(field: string | undefined, body: Record<string, unknown>): string | null {
  const value = field === undefined ? undefined : valueAt(body, field);
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** The image formats litevision reads from a file's header, by the names and media types a request may give them. */
const readableFormats: Record<string, string> = { png: "png", jpeg: "jpeg", jpg: "jpeg", webp: "webp", gif: "gif" };

/** The file format a request asks for, e.g. `png` for `PNG` or `image/png`; null when unset or not one litevision can read. */
function readFormat(field: string | undefined, body: Record<string, unknown>): string | null {
  const value = field === undefined ? undefined : valueAt(body, field);
  return typeof value === "string" ? (readableFormats[value.trim().toLowerCase().replace(/^image\//, "")] ?? null) : null;
}

/** The length in seconds a request asks for; null when the field is missing or cannot be read. */
function readSeconds(field: string | undefined, body: Record<string, unknown>): number | null {
  return field === undefined ? null : (positive(valueAt(body, field)) ?? null);
}

/**
 * What a final request asks for, as litevision read it from the request's own fields (ADR 0010). It travels as one
 * value from the request through the Job history to every tool output.
 */
export interface Requested {
  /** The shape, e.g. `16:9` or `3840x2160`; null when unreadable, so the result's shape goes unchecked. */
  shape: string | null;
  /** The resolution tier, as written, e.g. `4K` or `1080P`; null when the request sets none. */
  resolution: string | null;
  /**
   * The pixel size, e.g. `1792x2400`, where the request names exact dimensions or a tier and ratio the Parameter Guide
   * sizes; null when it names none litevision can read, so the result's pixel size goes unchecked. Absent on Jobs
   * recorded before it was checked.
   */
  size?: string | null;
  /**
   * The file format, e.g. `png`; null when the request names none litevision can read from a file's header, so the
   * result's format goes unchecked. Absent on Jobs recorded before it was checked.
   */
  format?: string | null;
  /** Video only: the length in seconds; null when unreadable, so the length goes unchecked. Absent on image Jobs. */
  seconds?: number | null;
}

/** Reads what a request body asks for from the fields to read; the length only for video. */
export function readRequested(fields: RequestFields, body: Record<string, unknown>, modality: "image" | "video"): Requested {
  const shape = readShape(fields.shape, body);
  const resolution = readResolution(fields.resolution, body);
  const tierSize = shape === null || resolution === null ? undefined : fields.tierSizes?.[resolution]?.[shape];
  return {
    shape,
    resolution,
    size: shape !== null && parseSize(shape) !== undefined ? shape : (tierSize ?? null),
    format: readFormat(fields.format, body),
    ...(modality === "video" ? { seconds: readSeconds(fields.duration, body) } : {}),
  };
}
