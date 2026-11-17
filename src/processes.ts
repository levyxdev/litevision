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

/**
 * Whether a process of this user is running. The Job history is this user's, so a process of another user with that
 * pid only reuses the pid of one that has ended.
 */
export function isOwnProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A JSON file's contents, or undefined when it is missing or unreadable. */
export async function readJson<T>(path: string): Promise<T | undefined> {
  return readFile(path, "utf8").then((text) => JSON.parse(text) as T, () => undefined);
}
