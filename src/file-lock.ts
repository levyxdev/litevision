import { randomUUID } from "node:crypto";
import { link, rm, writeFile } from "node:fs/promises";
import { isAlive, readJson } from "./local/queue.ts";

/**
 * A lock shared by every litevision process on the machine: a file at `path` naming the process that holds it, made by
 * linking a finished file, which is atomic, so two processes never both hold it. A lock left by a process that died is
 * removed by whoever finds it.
 */

interface Holder {
  pid: number;
  token: string;
}

/** How long to wait before asking again while another process holds the lock. */
const retryMs = 5;

/** Runs `work` holding the lock at `path`, waiting while another holds it. Never call it again from inside `work`. */
export async function withFileLock<T>(path: string, work: () => Promise<T>): Promise<T> {
  const token = await take(path);
  try {
    return await work();
  } finally {
    await release(path, token);
  }
}

async function take(path: string): Promise<string> {
  const token = randomUUID();
  const draft = `${path}.${token}`;
  await writeFile(draft, JSON.stringify({ pid: process.pid, token } satisfies Holder));
  try {
    for (;;) {
      try {
        await link(draft, path);
        return token;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const holder = await readJson<Holder>(path);
      if (holder !== undefined && !isAlive(holder.pid)) await release(path, holder.token);
      else await new Promise((resolve) => setTimeout(resolve, retryMs));
    }
  } finally {
    await rm(draft, { force: true });
  }
}

/** Removes the lock if `token` still holds it; another process may have taken it since. */
async function release(path: string, token: string): Promise<void> {
  if ((await readJson<Holder>(path))?.token === token) await rm(path, { force: true });
}
