import type { JobParameters } from "./history.ts";
import type { MediaFacts } from "./media.ts";
import { parseShape } from "./protocols/parameter-guide.ts";

/**
 * The result check (ADR 0006, ADR 0010): what the saved files turned out to be, read from their headers, against what
 * the final request asked for. It compares the shape and a video's length; ADR 0011 extends it to the pixel size and
 * file format a request names, which it does not compare yet. What it finds decides whether the options it read are
 * Honoured or Ignored (ADR 0011).
 */

/** One thing the result check compared. */
export interface ResultCheck {
  /** The result's shape, or a video's length. */
  of: "shape" | "length";
  /** How the result differs from the request, e.g. "asked for 16:9, got 1024x1024"; absent when it matched. */
  problem?: string;
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
    const problems = new Set(
      files
        .filter((facts) => Math.abs(Math.log(facts.width / facts.height / expected.ratio)) > aspectTolerance)
        .map((facts) => `asked for ${expected.asked}, got ${facts.width}x${facts.height}`),
    );
    checks.push({ of: "shape", ...(problems.size === 0 ? {} : { problem: [...problems].join("; ") }) });
  }
  // What the final request asked for (ADR 0010); Jobs recorded before, what litevision chose.
  const seconds = parameters.requested !== undefined ? (parameters.requested.seconds ?? undefined) : parameters.seconds;
  const timed = files.flatMap((facts) => (facts.seconds === undefined ? [] : [facts.seconds]));
  if (seconds !== undefined && timed.length > 0) {
    const problems = new Set(timed.filter((got) => Math.abs(got - seconds) > durationToleranceSeconds).map((got) => `asked for ${seconds} s, got ${got} s`));
    checks.push({ of: "length", ...(problems.size === 0 ? {} : { problem: [...problems].join("; ") }) });
  }
  return checks;
}

/** How the result differs from what was requested; undefined when it matched as far as litevision can tell. */
export function mismatchOf(checks: ResultCheck[]): string | undefined {
  const problems = checks.flatMap((check) => (check.problem === undefined ? [] : [check.problem]));
  return problems.length === 0 ? undefined : problems.join("; ");
}
