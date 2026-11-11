import { readdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";

/** Characters no file name may hold on some system litevision runs on, control characters included. */
const illegal = /[<>:"/\\|?*\u0000-\u001f\u007f]/g;

/** Leaves room under the usual 255-byte limit for a clash suffix and an extension. */
const maxStemBytes = 200;

/**
 * The file name stem for the `name` the Agent gave a Job: any language, with only the characters a path cannot hold
 * removed, and trailing dots and spaces, which Windows drops. Undefined when nothing usable is left.
 */
export function fileStem(name: string): string | undefined {
  let stem = name.replace(illegal, "").trim().replace(/[. ]+$/, "");
  while (Buffer.byteLength(stem) > maxStemBytes) stem = [...stem].slice(0, -1).join("");
  return stem === "" ? undefined : stem;
}

/** One result to save: its bytes and the extension its format calls for, without the dot. */
export interface FileToSave {
  bytes: Uint8Array;
  extension: string;
}

/**
 * Saves a Job's results in `folder` under `stem`: a Job that asked for one result as `<stem>.ext`, one that asked for
 * `several` as `<stem>-1.ext`, `<stem>-2.ext`, however many arrived. A name already taken in the folder, whatever its
 * extension, moves on to the next free one: `<stem>-2`, `<stem>-3` for one result, the next free numbers for several.
 * Returns the paths in the order of `files`.
 */
export async function saveNamed(folder: string, stem: string, files: FileToSave[], several: boolean): Promise<string[]> {
  const taken = new Set((await readdir(folder)).map((entry) => comparable(entry.slice(0, entry.length - extname(entry).length))));
  const names = candidates(stem, several);
  const paths: string[] = [];
  for (const file of files) {
    for (;;) {
      const name = names.next().value;
      if (taken.has(comparable(name))) continue;
      taken.add(comparable(name));
      const path = join(folder, `${name}.${file.extension}`);
      try {
        // `wx` never overwrites a file another process saved since the folder was read.
        await writeFile(path, file.bytes, { flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw error;
      }
      paths.push(path);
      break;
    }
  }
  return paths;
}

/** The names a Job's results may take, in order: `<stem>`, `<stem>-2`, … for one result; `<stem>-1`, `<stem>-2`, … for several. */
function* candidates(stem: string, several: boolean): Generator<string, never> {
  if (!several) yield stem;
  for (let number = several ? 1 : 2; ; number += 1) yield `${stem}-${number}`;
}

/** File systems may ignore case and Unicode normalisation, so names that differ only there clash. */
function comparable(name: string): string {
  return name.normalize("NFC").toLowerCase();
}
