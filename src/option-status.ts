import type { Dirs } from "./dirs.ts";
import { readEvidence, type Evidence } from "./evidence.ts";
import { ranOn, readJobs, type ModelKey } from "./history.ts";
import { namesOption, providerSaid } from "./protocols/errors.ts";
import { adapterForProtocol } from "./protocols/index.ts";
import { checkedOptionKeys, fieldsChecked, fieldsToRead, optionKeyOf, valueAt, type RequestFields } from "./protocols/parameter-guide.ts";
import type { Modality } from "./protocols/protocol.ts";
import { checkResult } from "./result-check.ts";

/**
 * The Option Status of each `provider_options` value on a Model (ADR 0011), derived on every read from the evidence
 * each ended Job left apart from the Job history (ADR 0015),
 * from facts alone: what the result check found and what the Provider's errors named. A Rating or a Pick never
 * changes it.
 */

export const optionStatusNames = ["honoured", "ignored", "rejected", "accepted"] as const;
export type OptionStatusName = (typeof optionStatusNames)[number];

/** One `provider_options` value, or the values of fields a check reads together, with the latest evidence about it. */
export interface OptionStatus {
  /**
   * The keys and the values sent, e.g. `{ width: 1792, height: 2400 }`. Several keys when a check reads them together.
   * A nested field a check reads has its own, dotted, e.g. `{ "response_format.image_size": "2K" }`; the rest of
   * its object shares one under the object's key.
   */
  options: Record<string, unknown>;
  status: OptionStatusName;
  /** The Job the evidence comes from. */
  jobId: string;
  /** True when the User has deleted that Job since; the evidence stands (ADR 0015). */
  jobDeleted?: true;
  /** When that Job started, as an ISO date-time. */
  date: string;
  /** Ignored: how the result differed from the request. Rejected: what the Provider said. */
  reason?: string;
}

/** The fields a Model's checks read together: each width and height pair among its shape fields. */
function groupsOf(fields: RequestFields): string[][] {
  return fields.shape.filter((field) => typeof field !== "string").map((pair) => [...new Set([pair.width, pair.height])]);
}

/** A set of `provider_options` that share an Option Status: their keys, dotted for nested fields, and the values sent. */
interface Unit {
  keys: string[];
  values: Record<string, unknown>;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A Job's `provider_options` split into the units that share an Option Status, in the order the options give them.
 * A nested field a check reads, one level deep as `response_format.image_size`, is a unit of its own, so a check
 * lands on the field it read rather than on the whole object; what else the object holds is one unit under its key.
 */
function unitsOf(options: Record<string, unknown>, fields: RequestFields): Unit[] {
  const units: Unit[] = [];
  const grouped = new Set<string>();
  const unit = (keys: string[]) => units.push({ keys, values: Object.fromEntries(keys.map((key) => [key, valueAt(options, key)])) });
  for (const group of groupsOf(fields)) {
    const present = group.filter((key) => valueAt(options, key) !== undefined && !grouped.has(key));
    if (present.length === 0) continue;
    for (const key of present) grouped.add(key);
    unit(present);
  }
  const nested = fieldsChecked(fields).filter((field) => field.split(".").length === 2);
  for (const [key, value] of Object.entries(options)) {
    if (grouped.has(key)) continue;
    const read = isObject(value) ? nested.filter((field) => optionKeyOf(field) === key && valueAt(options, field) !== undefined) : [];
    if (read.length === 0) {
      unit([key]);
      continue;
    }
    for (const field of read) if (!grouped.has(field)) unit([field]);
    const leaves = new Set(read.map((field) => field.split(".")[1]!));
    const rest = Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([leaf]) => !leaves.has(leaf)));
    if (Object.keys(rest).length > 0) units.push({ keys: [key], values: { [key]: rest } });
  }
  return units;
}

/**
 * Every Option Status of a Model, newest evidence first. `evidence` is in the order the Jobs ended (as
 * {@link readEvidence} gives it), so a Job's evidence counts from when it ended. `fields` are the request
 * fields its result check reads (from {@link fieldsToRead}), which say which options a check covered and which it
 * reads together.
 *
 * In that order, each unit's value takes the latest evidence: a completed Job makes what its check read Honoured
 * or Ignored and the rest Accepted, though a value already Honoured or Ignored keeps that until it is checked again or
 * rejected; a Job the Provider rejected, as a rejected option or an unsupported request, makes the units its error
 * names Rejected, and leaves the rest alone. Only the
 * latest Accepted value of each unit is kept, since it says nothing an earlier one did not.
 */
export function optionStatuses(evidence: Evidence[], model: ModelKey, fields: RequestFields): OptionStatus[] {
  /** By unit keys, then by the values' JSON. */
  const statuses = new Map<string, Map<string, OptionStatus>>();
  const record = ({ keys, values }: Unit, status: Omit<OptionStatus, "options">) => {
    const unit = keys.join("+");
    const ofUnit = statuses.get(unit) ?? new Map<string, OptionStatus>();
    statuses.set(unit, ofUnit);
    const id = JSON.stringify(values);
    const earlier = ofUnit.get(id);
    if (status.status === "accepted" && (earlier?.status === "honoured" || earlier?.status === "ignored")) return;
    ofUnit.delete(id);
    ofUnit.set(id, { options: values, ...status });
    arrived.set(ofUnit.get(id)!, jobsSeen);
  };
  /** When each Option Status's evidence arrived, counting Jobs in the order they ended. */
  const arrived = new Map<OptionStatus, number>();
  let jobsSeen = 0;

  for (const ofJob of evidence.filter((candidate) => ranOn(candidate, model))) {
    jobsSeen += 1;
    const options = ofJob.request.providerOptions ?? {};
    const units = unitsOf(options, fields);
    const source = { jobId: ofJob.jobId, date: ofJob.createdAt };
    if (ofJob.outcome === "failed") {
      const { error } = ofJob;
      if (error?.kind !== "rejected_option" && error?.kind !== "unsupported") continue;
      const said = providerSaid(error.message);
      // The keys the Provider's answer named, as recorded with the Job; for Jobs recorded without them, the keys its message
      // names. A nested field counts as named with its object's key, which is all a recorded answer says.
      const names = (key: string) => (error.options !== undefined ? error.options.includes(key) : said !== undefined && namesOption(said, key));
      const named = (key: string) => names(key) || names(optionKeyOf(key));
      for (const unit of units) {
        if (unit.keys.some(named)) record(unit, { status: "rejected", ...source, reason: said ?? error.message });
      }
      continue;
    }
    if (ofJob.outcome !== "completed") continue;
    const checked = checkedOptionKeys(fields, options);
    /** Per unit, the problems the checks that read it found; empty when they found none. */
    const found = new Map<Unit, string[]>();
    for (const check of checkResult(ofJob.request, ofJob.observed ?? [])) {
      const keys = checked[check.of];
      const unit = units.find((candidate) => keys.some((key) => candidate.keys.includes(key)));
      if (unit === undefined) continue;
      found.set(unit, [...new Set([...(found.get(unit) ?? []), ...check.problems])]);
    }
    for (const unit of units) {
      const problems = found.get(unit);
      if (problems === undefined) record(unit, { status: "accepted", ...source });
      else if (problems.length === 0) record(unit, { status: "honoured", ...source });
      else record(unit, { status: "ignored", ...source, reason: problems.join("; ") });
    }
  }

  const kept = [...statuses.values()].flatMap((ofUnit) => {
    const all = [...ofUnit.values()];
    const latestAccepted = all.filter((status) => status.status === "accepted").at(-1);
    return all.filter((status) => status.status !== "accepted" || status === latestAccepted);
  });
  // Stable, so the statuses one Job gave keep the order of its options.
  return kept.sort((a, b) => arrived.get(b)! - arrived.get(a)!);
}

/**
 * A Model's Option Statuses, with the fields its result check reads taken from its Protocol and Parameter Guide; a
 * Protocol litevision does not know checks nothing, so its options are only ever Accepted or Rejected.
 */
export function modelOptionStatuses(evidence: Evidence[], model: StatusedModel): OptionStatus[] {
  const adapter = adapterForProtocol(model.protocol);
  const fields = adapter === undefined ? { shape: [] } : fieldsToRead(adapter, model.modelId, model.modality ?? "image");
  return optionStatuses(evidence, model, fields);
}

/** A Model as Option Statuses are looked up for: which upstream model, and what it makes. */
export type StatusedModel = ModelKey & { modality?: Modality };

/**
 * Reads the evidence and the Job history once, for looking up the Option Statuses of any number of Models. Each is
 * marked when the Job it came from has been deleted since.
 */
export async function optionStatusReader(dirs: Dirs): Promise<(model: StatusedModel) => OptionStatus[]> {
  const jobs = await readJobs(dirs);
  const evidence = await readEvidence(dirs, jobs);
  const kept = new Set(jobs.map((job) => job.id));
  return (model) => modelOptionStatuses(evidence, model).map((status) => (kept.has(status.jobId) ? status : { ...status, jobDeleted: true }));
}

/** Option Statuses grouped by status, each group newest first. */
export function byStatus(statuses: OptionStatus[]): Record<OptionStatusName, OptionStatus[]> {
  return Object.fromEntries(optionStatusNames.map((name) => [name, statuses.filter((status) => status.status === name)])) as Record<
    OptionStatusName,
    OptionStatus[]
  >;
}
