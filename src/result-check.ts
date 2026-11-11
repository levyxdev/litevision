import type { JobParameters } from "./history.ts";
import type { MediaFacts } from "./media.ts";
import { parseShape, parseSize } from "./protocols/parameter-guide.ts";

/**
 * The result check (ADR 0006, ADR 0010, ADR 0011): what the saved files turned out to be, read from their headers,
 * against what the final request asked for. It compares the shape, the pixel size and file format where the request
 * names them, and a video's length. What it finds decides whether the options it read are Honoured or Ignored.
 */

/** One thing the result check compared. */
export interface ResultCheck {
  /** The result's shape, its pixel size, a video's length, or the file format. */
  of: "shape" | "size" | "length" | "format";
  /** How the result differs from the request, e.g. "asked for 16:9, got 1024x1024"; empty when it matched. */
  problems: string[];
}

/** A result whose shape is more than 5% off the requested one; small differences come from rounding to a Model's grid. */
const aspectTolerance = Math.log(1.05);

/** Half a second either way: containers round a clip's length to whole frames. */
const durationToleranceSeconds = 0.5;

/**
 * The shape a result should have: what the final request asked for, as litevision read it (ADR 0010); undefined when
 * it could not tell, so the shape is not checked. Jobs recorded before that check against the size litevision chose,
 * or `width` and `height` in `provider_options` when the Agent set both.
 */
function expectedShape(parameters: JobParameters): { ratio: number; asked: string } | undefined {
  if (parameters.requested !== undefined) {
    const parsed = parameters.requested.shape === null ? undefined : parseShape(parameters.requested.shape);
    return parsed === undefined ? undefined : { ratio: parsed.ratio, asked: parsed.label };
  }
  const { width, height } = parameters.providerOptions;
  if (typeof width === "number" && typeof height === "number" && width > 0 && height > 0) {
    return { ratio: width / height, asked: `${width}x${height} in provider_options` };
  }
  const { size } = parameters;
  const ratio = size === undefined ? undefined : parseShape(size.aspectRatio);
  return size === undefined || ratio === undefined ? undefined : { ratio: ratio.ratio, asked: `${size.aspectRatio} (${size.width}x${size.height})` };
}

/**
 * What the result check compared for a completed Job, as far as the saved files' headers tell. Something the request
 * asks for that litevision cannot read, or a result it cannot read, is not checked.
 */
export function checkResult(parameters: JobParameters, observed: Array<MediaFacts | null>): ResultCheck[] {
  const files = observed.filter((facts) => facts !== null);
  const checks: ResultCheck[] = [];
  const expected = parameters.followsFirstFrame ? undefined : expectedShape(parameters);
  if (expected !== undefined && files.length > 0) {
    const problems = files
      .filter((facts) => Math.abs(Math.log(facts.width / facts.height / expected.ratio)) > aspectTolerance)
      .map((facts) => `asked for ${expected.asked}, got ${facts.width}x${facts.height}`);
    checks.push({ of: "shape", problems: [...new Set(problems)] });
  }
  // No Model's docs say it rounds an exact size, so the pixels must match.
  const { requested } = parameters;
  const size = requested?.size == null ? undefined : parseSize(requested.size);
  if (size !== undefined && files.length > 0) {
    // A size other than the shape came from the tier.
    const asked = requested!.size === requested!.shape ? requested!.size : `${requested!.resolution} (${requested!.size})`;
    const problems = files
      .filter((facts) => facts.width !== size.width || facts.height !== size.height)
      .map((facts) => `asked for ${asked}, got ${facts.width}x${facts.height}`);
    checks.push({ of: "size", problems: [...new Set(problems)] });
  }
  // What the final request asked for (ADR 0010); Jobs recorded before, what litevision chose.
  const seconds = parameters.requested !== undefined ? (parameters.requested.seconds ?? undefined) : parameters.seconds;
  const timed = files.flatMap((facts) => (facts.seconds === undefined ? [] : [facts.seconds]));
  if (seconds !== undefined && timed.length > 0) {
    const problems = timed.filter((got) => Math.abs(got - seconds) > durationToleranceSeconds).map((got) => `asked for ${seconds} s, got ${got} s`);
    checks.push({ of: "length", problems: [...new Set(problems)] });
  }
  const format = requested?.format ?? undefined;
  const formatted = files.flatMap((facts) => (facts.format === undefined ? [] : [facts.format]));
  if (format !== undefined && formatted.length > 0) {
    const problems = formatted.filter((got) => got !== format).map((got) => `asked for ${format}, got ${got}`);
    checks.push({ of: "format", problems: [...new Set(problems)] });
  }
  return checks;
}

/** How the result differs from what was requested; undefined when it matched as far as litevision can tell. */
export function mismatchOf(checks: ResultCheck[]): string | undefined {
  // A wrong shape is a wrong exact size too, said in the same words.
  const problems = new Set(checks.flatMap((check) => check.problems));
  return problems.size === 0 ? undefined : [...problems].join("; ");
}
