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

/** Every line of `jobs.jsonl`, in order. A Job has several: one when it starts, more as it changes. */
export async function readHistoryLines(harness: Pick<Harness, "dirs">): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(join(harness.dirs.data, "jobs.jsonl"), "utf8");
  return text.trim().split("\n").map((line) => JSON.parse(line));
}

/** Each Job's latest record in `jobs.jsonl`, ordered by when the Job started. Rating records are left out. */
export async function readHistory(harness: Pick<Harness, "dirs">): Promise<Array<Record<string, unknown>>> {
  const latest = new Map<unknown, Record<string, unknown>>();
  for (const record of await readHistoryLines(harness)) if (record.type === "job") latest.set(record.id, record);
  return [...latest.values()];
}

/** A 1×1 PNG, the image every OpenAI fixture returns. */
export const tinyPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** A PNG signature and header claiming the given size: enough for litevision to read its dimensions, not to decode it. */
export function pngOfSize(width: number, height: number): Buffer {
  const header = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write("IHDR", 12, "latin1");
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header;
}

/** The boxes of an MP4 that say how large and how long it is, and nothing else. */
export function mp4Of(width: number, height: number, seconds: number): Buffer {
  const box = (type: string, body: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(8 + body.length, 0);
    head.write(type, 4, "latin1");
    return Buffer.concat([head, body]);
  };
  const ftyp = box("ftyp", Buffer.from("isom\0\0\x02\0isomiso2mp41", "latin1"));
  const mvhd = Buffer.alloc(100);
  mvhd.writeUInt32BE(1000, 12);
  mvhd.writeUInt32BE(Math.round(seconds * 1000), 16);
  const tkhd = Buffer.alloc(84);
  tkhd.writeUInt32BE(width * 65536, 76);
  tkhd.writeUInt32BE(height * 65536, 80);
  return Buffer.concat([ftyp, box("moov", Buffer.concat([box("mvhd", mvhd), box("trak", box("tkhd", tkhd))]))]);
}
