import { randomUUID } from "node:crypto";
import { link, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../config-store.ts";
import type { Dirs } from "../dirs.ts";

/**
 * The machine-wide queue of local Jobs (ADR 0014): every litevision process on the machine puts its local Jobs in
 * `queue/`, one file each, and only the Job holding `queue/turn` uses the Runtime. The turn goes to the oldest Job on
 * the Model the Runtime last ran, else the oldest Job, so Jobs on one Model run together. A file whose process has
 * died is removed by whoever finds it. A Job's file disappearing while it waits or runs is a request to cancel it.
 */

interface Entry {
  jobId: string;
  modelId: string;
  pid: number;
  /** Milliseconds since the epoch, for the order of the queue. */
  enqueuedAt: number;
}

interface Turn {
  /** The Job holding the turn, or {@link idleTurn} while litevision unloads the Runtime's Model. */
  jobId: string;
  pid: number;
  token: string;
}

/** What the queue remembers between Jobs: the Model the Runtime last ran, and when its last Job ended. */
export interface QueueState {
  model: string | null;
  endedAt: number;
}

/** What the turn names while no Job holds it, but the Runtime's Model is being unloaded. */
const idleTurn = "idle";

const folderOf = (dirs: Dirs) => join(dirs.home, "queue");
const entryPath = (dirs: Dirs, jobId: string) => join(folderOf(dirs), `${jobId}.job`);
const turnPath = (dirs: Dirs) => join(folderOf(dirs), "turn");
const statePath = (dirs: Dirs) => join(folderOf(dirs), "state.json");

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

/** What the queue remembers; before any local Job, no Model and no end. */
export async function readQueueState(dirs: Dirs): Promise<QueueState> {
  return (await readJson<QueueState>(statePath(dirs))) ?? { model: null, endedAt: 0 };
}

/** Records which Model the Runtime holds now and when its last Job ended. */
export async function writeQueueState(dirs: Dirs, state: QueueState): Promise<void> {
  await writeFileAtomic(statePath(dirs), JSON.stringify(state));
}

/** The Jobs waiting or running, oldest first. A Job whose process has died is removed. */
async function liveEntries(dirs: Dirs): Promise<Entry[]> {
  const names = (await readdir(folderOf(dirs)).catch(() => [])).filter((name) => name.endsWith(".job"));
  const entries: Entry[] = [];
  for (const name of names) {
    const entry = await readJson<Entry>(join(folderOf(dirs), name));
    if (entry === undefined) continue;
    if (isAlive(entry.pid)) entries.push(entry);
    else await rm(join(folderOf(dirs), name), { force: true });
  }
  return entries.sort((a, b) => a.enqueuedAt - b.enqueuedAt);
}

/** Whether a live process holds the turn; a turn left by a process that died is removed. */
async function turnHeld(dirs: Dirs): Promise<boolean> {
  const turn = await readJson<Turn>(turnPath(dirs));
  if (turn === undefined) return false;
  if (isAlive(turn.pid)) return true;
  // Another process may have removed it and taken the turn since; only the dead turn is removed.
  await releaseTurn(dirs, turn.token);
  return (await readJson<Turn>(turnPath(dirs))) !== undefined;
}

/** Takes the turn if no one holds it. Linking a finished file is atomic, so two processes never both get it. */
async function claimTurn(dirs: Dirs, jobId: string): Promise<string | undefined> {
  const token = randomUUID();
  const draft = join(folderOf(dirs), `turn.${token}`);
  await writeFile(draft, JSON.stringify({ jobId, pid: process.pid, token } satisfies Turn));
  try {
    await link(draft, turnPath(dirs));
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
    throw error;
  } finally {
    await rm(draft, { force: true });
  }
}

async function releaseTurn(dirs: Dirs, token: string): Promise<void> {
  const turn = await readJson<Turn>(turnPath(dirs));
  if (turn?.token === token) await rm(turnPath(dirs), { force: true });
}

/** A local Job's place in the queue, from when it joins until it leaves. */
export class QueuePlace {
  private token: string | undefined;

  private constructor(
    private readonly dirs: Dirs,
    private readonly entry: Entry,
  ) {}

  static async join(dirs: Dirs, jobId: string, modelId: string): Promise<QueuePlace> {
    await mkdir(folderOf(dirs), { recursive: true });
    const entry: Entry = { jobId, modelId, pid: process.pid, enqueuedAt: Date.now() };
    await writeFileAtomic(entryPath(dirs, jobId), JSON.stringify(entry));
    return new QueuePlace(dirs, entry);
  }

  /** Whether the Job's file is gone: someone asked to cancel it. */
  async withdrawn(): Promise<boolean> {
    return (await readJson<Entry>(entryPath(this.dirs, this.entry.jobId))) === undefined;
  }

  /** Takes the turn when it is this Job's; false while another Job holds it or comes first. */
  async take(): Promise<boolean> {
    if (await turnHeld(this.dirs)) return false;
    const entries = await liveEntries(this.dirs);
    const { model } = await readQueueState(this.dirs);
    const next = entries.find((entry) => entry.modelId === model) ?? entries[0];
    if (next?.jobId !== this.entry.jobId) return false;
    this.token = await claimTurn(this.dirs, this.entry.jobId);
    return this.token !== undefined;
  }

  /** Leaves the queue, giving up the turn if this Job held it, and records that its Model ran last. */
  async leave(): Promise<void> {
    await rm(entryPath(this.dirs, this.entry.jobId), { force: true });
    if (this.token === undefined) return;
    await writeQueueState(this.dirs, { model: this.entry.modelId, endedAt: Date.now() });
    await releaseTurn(this.dirs, this.token);
    this.token = undefined;
  }
}

/** Asks to cancel a local Job: removes its file. Says whether a live process had it waiting or running. */
export async function withdraw(dirs: Dirs, jobId: string): Promise<boolean> {
  const entry = await readJson<Entry>(entryPath(dirs, jobId));
  await rm(entryPath(dirs, jobId), { force: true });
  return entry !== undefined && isAlive(entry.pid);
}

/**
 * Runs `work` holding the turn, when no Job holds it or waits for it; for unloading an idle Runtime. Says whether it
 * ran.
 */
export async function whileIdle(dirs: Dirs, work: () => Promise<void>): Promise<boolean> {
  await mkdir(folderOf(dirs), { recursive: true });
  if ((await turnHeld(dirs)) || (await liveEntries(dirs)).length > 0) return false;
  const token = await claimTurn(dirs, idleTurn);
  if (token === undefined) return false;
  try {
    // A Job that joined meanwhile waits for the turn, and gets it once the work is done.
    await work();
    return true;
  } finally {
    await releaseTurn(dirs, token);
  }
}
