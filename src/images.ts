import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { ConfigError } from "./config.ts";
import type { ReferenceImage } from "./protocols/protocol.ts";

export interface ImageType {
  extension: string;
  mimeType: string;
}

/** Recognises an image by its leading bytes; undefined when it is not a known image format. */
export function imageTypeOf(bytes: Uint8Array): ImageType | undefined {
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
  if (bytes[0] === 0x89 && ascii(1, 4) === "PNG") return { extension: "png", mimeType: "image/png" };
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { extension: "jpg", mimeType: "image/jpeg" };
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return { extension: "webp", mimeType: "image/webp" };
  if (ascii(0, 4) === "GIF8") return { extension: "gif", mimeType: "image/gif" };
  return undefined;
}

/** Reads reference images from disk; relative paths resolve against `cwd`. */
export async function readReferences(paths: string[], cwd: string): Promise<ReferenceImage[]> {
  return Promise.all(
    paths.map(async (given) => {
      const path = resolve(cwd, given);
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await readFile(path));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") throw new ConfigError(`Reference image "${given}" does not exist (looked for ${path}).`);
        if (code === "EISDIR") throw new ConfigError(`Reference image "${given}" is a directory, not an image file.`);
        throw new ConfigError(`Could not read reference image "${given}": ${(error as Error).message}`);
      }
      const type = imageTypeOf(bytes);
      if (type === undefined) {
        throw new ConfigError(`Reference image "${given}" is not a PNG, JPEG, WebP or GIF image.`);
      }
      return { path, fileName: basename(path), mimeType: type.mimeType, bytes };
    }),
  );
}
