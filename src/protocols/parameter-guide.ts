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

/** The request fields litevision reads the requested shape, length and resolution tier from (ADR 0010). */
export interface RequestFields {
  shape: ShapeField[];
  duration?: string;
  /** The field holding the resolution tier, e.g. `resolution` (`4K`, `1080P`); reported to the Agent, never checked. */
  resolution?: string;
}

/**
 * The fields to read a Model's requested shape, length and tier from: the shape and length from its guide entry, else
 * its Protocol's; the tier always from its Protocol, which names the one field every model of it uses.
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
  };
}

/** A field's value in a request body; `path` is dotted for nested fields. */
function valueAt(body: Record<string, unknown>, path: string): unknown {
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

/** The `provider_options` keys each field of a shape field is set through: one for a single field, two for a pair. */
export function optionKeysOf(field: ShapeField): string[] {
  return typeof field === "string" ? [optionKeyOf(field)] : [...new Set([optionKeyOf(field.width), optionKeyOf(field.height)])];
}

/**
 * The `provider_options` keys the result check reads (ADR 0011): for the shape, those of the shape field it is read
 * from; for the length, the length field's. Empty where the options set none.
 */
export function checkedOptionKeys(fields: RequestFields, options: Record<string, unknown>): { shape: string[]; length: string[] } {
  const shape = shapeFieldSet(fields.shape, options);
  const length = fields.duration === undefined ? undefined : optionKeyOf(fields.duration);
  return {
    shape: shape === undefined ? [] : optionKeysOf(shape).filter((key) => key in options),
    length: length !== undefined && length in options ? [length] : [],
  };
}

/** The resolution tier a request asks for, as written, e.g. `4K`; null when the field is missing or not text. */
function readResolution(field: string | undefined, body: Record<string, unknown>): string | null {
  const value = field === undefined ? undefined : valueAt(body, field);
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
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
  /** The resolution tier, as written, e.g. `4K` or `1080P`; null when the request sets none. Reported, never checked. */
  resolution: string | null;
  /** Video only: the length in seconds; null when unreadable, so the length goes unchecked. Absent on image Jobs. */
  seconds?: number | null;
}

/** Reads what a request body asks for from the fields to read; the length only for video. */
export function readRequested(fields: RequestFields, body: Record<string, unknown>, modality: "image" | "video"): Requested {
  return {
    shape: readShape(fields.shape, body),
    resolution: readResolution(fields.resolution, body),
    ...(modality === "video" ? { seconds: readSeconds(fields.duration, body) } : {}),
  };
}
