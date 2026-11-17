import { readFile } from "node:fs/promises";

/** What every litevision process on the machine relies on to share small files with the others. */

/** Whether a process is running; EPERM means it is, under another user. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** A JSON file's contents, or undefined when it is missing or unreadable. */
export async function readJson<T>(path: string): Promise<T | undefined> {
  return readFile(path, "utf8").then((text) => JSON.parse(text) as T, () => undefined);
}
