/**
 * A value litevision passes on as it is, such as Provider request fields or the Provider's own schema: `compact` keeps
 * it whole, even when it is empty.
 */
class Data {
  constructor(readonly value: unknown) {}
}

/** Marks `value` as data, kept whole: see {@link Data}. */
export function data(value: unknown): Data {
  return new Data(value);
}

/** Marks a record as data when it has keys; an empty one is left out. */
export function filled(value: Record<string, unknown>): Data | undefined {
  return Object.keys(value).length === 0 ? undefined : new Data(value);
}

/**
 * `value` without its null, undefined or empty-string fields and without empty arrays and objects; data stays whole.
 * An array keeps a null item, which holds its place, such as a file litevision could not read.
 */
export function compact(value: unknown): unknown {
  if (value instanceof Data) return value.value;
  if (Array.isArray(value)) {
    const items = value.map((item) => compact(item) ?? null);
    return items.length === 0 ? undefined : items;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).flatMap(([key, field]) => {
      const kept = field instanceof Data ? field.value : compact(field);
      return field instanceof Data || !isEmpty(kept) ? [[key, kept] as const] : [];
    });
    return entries.length === 0 ? undefined : Object.fromEntries(entries);
  }
  return value;
}

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

/**
 * A successful tool result in the one form every client shows the Agent (ADR 0017): its text is exactly the compact
 * JSON of its structured content.
 */
export function toolResult(output: Record<string, unknown>) {
  const structuredContent = (compact(output) ?? {}) as Record<string, unknown>;
  return { content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }], structuredContent };
}
