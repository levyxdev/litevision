import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Harness, Route } from "./harness.ts";

/** Replays a hand-written Provider response from `test/fixtures/`. */
export function recorded(name: string, status = 200): Route {
  return async () =>
    new Response(await readFile(join(import.meta.dir, "fixtures", name)), {
      status,
      headers: { "content-type": "application/json" },
    });
}

export type ToolResult = Awaited<ReturnType<Harness["client"]["callTool"]>>;

export function textOf(result: ToolResult): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  return content.map((part) => part.text ?? "").join("\n");
}

export async function readHistory(harness: Harness): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(join(harness.dirs.data, "jobs.jsonl"), "utf8");
  return text.trim().split("\n").map((line) => JSON.parse(line));
}

/** A 1×1 PNG, the image every OpenAI fixture returns. */
export const tinyPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
