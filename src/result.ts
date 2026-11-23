import { z } from "zod";

/** A tool's outputSchema as JSON Schema, the form every client receives it in. */
export type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
};

/**
 * What a result field holds, read from its schema (ADR 0017):
 * - `value`: any JSON value, such as an option's value or the Provider's own schema; kept whole, even when empty.
 * - `record`: a set of Provider request fields, such as Standing Options; kept whole, and left out when empty.
 * - `fields`: litevision's own fields, compacted.
 */
export type FieldKind = "value" | "record" | "fields";

function branches(schema: JsonSchema): JsonSchema[] {
  const alternatives = schema.anyOf ?? schema.oneOf;
  return alternatives === undefined ? [schema] : alternatives.flatMap(branches);
}

function isRecord(schema: JsonSchema): boolean {
  return schema.type === "object" && schema.properties === undefined && schema.additionalProperties !== false;
}

function isAnyValue(schema: JsonSchema): boolean {
  return schema.type === undefined && schema.properties === undefined && schema.items === undefined && schema.anyOf === undefined && schema.oneOf === undefined;
}

export function fieldKind(schema: JsonSchema): FieldKind {
  const all = branches(schema);
  if (all.some(isAnyValue)) return "value";
  if (all.some(isRecord)) return "record";
  return "fields";
}

/** The schema of field `key` of an object, across every alternative that has it. */
export function fieldSchema(schema: JsonSchema, key: string): JsonSchema {
  return { anyOf: branches(schema).flatMap((branch) => (branch.properties?.[key] === undefined ? [] : [branch.properties[key]])) };
}

/** The schema of an array's items, across every alternative. */
export function itemSchema(schema: JsonSchema): JsonSchema {
  return { anyOf: branches(schema).flatMap((branch) => (branch.items === undefined ? [] : [branch.items])) };
}

/**
 * `value` without its null, undefined or empty-string fields and without empty arrays and objects, as its schema
 * describes it: a `value` field stays whole, and a `record` stays whole unless empty. An array keeps a null item, which
 * holds its place, such as a file litevision could not read.
 */
export function compact(value: unknown, schema: JsonSchema): unknown {
  const kind = fieldKind(schema);
  if (kind === "value") return value ?? undefined;
  if (kind === "record") return value === null || (typeof value === "object" && Object.keys(value as object).length === 0) ? undefined : value;
  if (Array.isArray(value)) {
    const items = value.map((item) => compact(item, itemSchema(schema)) ?? null);
    return items.length === 0 ? undefined : items;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).flatMap(([key, field]) => {
      const kept = compact(field, fieldSchema(schema, key));
      return kept === undefined ? [] : [[key, kept] as const];
    });
    return entries.length === 0 ? undefined : Object.fromEntries(entries);
  }
  return value === null || value === "" ? undefined : value;
}

const jsonSchemas = new WeakMap<z.ZodRawShape, JsonSchema>();

/** An outputSchema as JSON Schema, converted once per tool. */
function jsonSchemaOf(shape: z.ZodRawShape): JsonSchema {
  let schema = jsonSchemas.get(shape);
  if (schema === undefined) {
    schema = z.toJSONSchema(z.object(shape), { io: "output" }) as JsonSchema;
    jsonSchemas.set(shape, schema);
  }
  return schema;
}

/**
 * A successful tool result in the one form every client shows the Agent (ADR 0017): its text is exactly the compact
 * JSON of its structured content, compacted as the tool's outputSchema describes each field.
 */
export function toolResult<Shape extends z.ZodRawShape>(outputSchema: Shape, output: z.input<z.ZodObject<Shape>>) {
  const structuredContent = (compact(output, jsonSchemaOf(outputSchema)) ?? {}) as Record<string, unknown>;
  return { content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }], structuredContent };
}
