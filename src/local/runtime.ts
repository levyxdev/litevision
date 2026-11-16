import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { readdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { writeFileAtomic } from "../config-store.ts";
import type { Dirs } from "../dirs.ts";
import type { HttpTransport } from "../http.ts";
import { providerError } from "../protocols/errors.ts";
import type { Catalog } from "./catalog.ts";
import { runtimePlatform } from "./hardware.ts";
import { isAlive, readJson, readQueueState, whileIdle, writeQueueState, type QueueState } from "./queue.ts";

/**
 * The one Runtime on the machine (ADR 0014). The first local Job starts the Runtime litevision installed, on
 * 127.0.0.1 and a free port, and records it in `runtime.json`; every other litevision process uses it from there. The
 * process that started it stops it when it exits, and unloads its Model once it has sat idle.
 */

/** How long the Runtime's Model may sit without a local Job before it is unloaded, freeing its memory. */
export const defaultRuntimeIdleMs = 10 * 60_000;

/** How long sd-server keeps a finished task: long enough for `get_job` after a restart. Its own default is 600. */
export const completedTtlSeconds = 86_400;

/** How long the Runtime may take to answer once started. */
const startLimitMs = 60_000;

/** What a RuntimeManager needs: where litevision keeps the Runtime, how to reach it, and the build it installed. */
export interface RuntimeDeps {
  dirs: Dirs;
  http: HttpTransport;
  catalog: Catalog;
  /** Defaults to {@link defaultRuntimeIdleMs}. */
  idleMs?: number;
}

/** `runtime.json`: the shared Runtime, and the litevision process that stops it on exit. */
interface Lock {
  runtimePid: number;
  port: number;
  ownerPid: number;
  /** The one RuntimeManager in the owner process, as two may share a process. */
  ownerId: string;
}

const lockPath = (dirs: Dirs) => join(dirs.home, "runtime.json");
const urlOf = (port: number) => `http://127.0.0.1:${port}`;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address !== null ? resolve(address.port) : reject(new Error("no port"))));
    });
  });
}

/** Starts, shares and stops the Runtime for one litevision process. */
export class RuntimeManager {
  /** Identifies this manager in the lock, as two may share a process. */
  private readonly id = randomUUID();
  /** The Runtime this manager stops: one it started or adopted. */
  private owned: Lock | undefined;
  private idleTimer: ReturnType<typeof setInterval> | undefined;
  private readonly idleMs: number;
  private readonly killOnExit = () => {
    if (this.owned !== undefined) kill(this.owned.runtimePid);
  };

  constructor(private readonly deps: RuntimeDeps) {
    this.idleMs = deps.idleMs ?? defaultRuntimeIdleMs;
  }

  /** The installed Runtime binary for this litevision's pinned build on this platform, if there is one. */
  private async binary(): Promise<string | undefined> {
    const platform = runtimePlatform();
    if (platform === undefined) return undefined;
    const build = this.deps.catalog.runtime[platform];
    const folder = join(this.deps.dirs.home, "runtime", build.tag);
    const entries = await readdir(folder, { recursive: true, withFileTypes: true }).catch(() => []);
    const found = entries.find((entry) => entry.isFile() && entry.name === build.binary);
    return found === undefined ? undefined : join(found.parentPath, found.name);
  }

  /** The lock of a Runtime that is running and answers; undefined when there is none. */
  private async live(): Promise<Lock | undefined> {
    const lock = await readJson<Lock>(lockPath(this.deps.dirs));
    return lock !== undefined && isAlive(lock.runtimePid) && (await this.answers(lock.port)) ? lock : undefined;
  }

  private async answers(port: number): Promise<boolean> {
    try {
      return (await this.deps.http(`${urlOf(port)}/sdcpp/v1/models/status`)).ok;
    } catch {
      return false;
    }
  }

  /**
   * Where a local Job goes: the shared Runtime litevision installed, started if none runs, or, without one installed,
   * the Provider's own base URL, a Runtime the User runs. Called only while holding the queue's turn, so two processes
   * never start one at once. With `start` false, as for a Job picked up after a restart, none is started: undefined.
   */
  async address(configured: string, { start = true }: { start?: boolean } = {}): Promise<string | undefined> {
    const binary = await this.binary();
    if (binary === undefined) return configured;
    const lock = await this.live();
    if (lock !== undefined) {
      // A Runtime whose litevision died without stopping it is adopted, so that one stops it.
      if (!isAlive(lock.ownerPid)) await this.own({ ...lock, ownerPid: process.pid, ownerId: this.id });
      return urlOf(lock.port);
    }
    return start ? urlOf(await this.start(binary)) : undefined;
  }

  private async start(binary: string): Promise<number> {
    const { dirs } = this.deps;
    const port = await freePort();
    const logPath = join(dirs.home, "runtime", "sd-server.log");
    const log = openSync(logPath, "w");
    const args = ["--listen-ip", "127.0.0.1", "--listen-port", String(port), "--model-dir", join(dirs.home, "models"), "--completed-ttl-seconds", String(completedTtlSeconds)];
    const child = spawn(binary, args, { stdio: ["ignore", log, log] });
    closeSync(log);
    let exited = false;
    child.once("exit", () => {
      exited = true;
    });
    const spawned = await new Promise<boolean>((resolve) => {
      child.once("spawn", () => resolve(true));
      child.once("error", () => resolve(false));
    });
    if (!spawned || child.pid === undefined) throw providerError("other", "local", `the Runtime ${binary} could not be started.`);
    await this.own({ runtimePid: child.pid, port, ownerPid: process.pid, ownerId: this.id });
    for (const started = Date.now(); !(await this.answers(port)); ) {
      if (exited || Date.now() - started > startLimitMs) {
        const said = (await readFile(logPath, "utf8").catch(() => "")).trim().split("\n").slice(-5).join("\n");
        await this.stop();
        throw providerError("other", "local", `the Runtime ${exited ? "exited as it started" : "did not answer once started"}. Its log, ${logPath}, ends: ${said}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // A Model loaded by an earlier Runtime is gone with it.
    await writeQueueState(dirs, { model: null, endedAt: Date.now() });
    return port;
  }

  /** Records this manager as the one that stops the Runtime, and unloads it when idle. */
  private async own(lock: Lock): Promise<void> {
    await writeFileAtomic(lockPath(this.deps.dirs), JSON.stringify(lock));
    this.owned = lock;
    process.removeListener("exit", this.killOnExit);
    process.once("exit", this.killOnExit);
    this.idleTimer ??= setInterval(() => void this.unloadIfIdle().catch(() => {}), Math.min(this.idleMs / 4, 30_000));
    this.idleTimer.unref();
  }

  /** Unloads the Model once no local Job has run for the idle period; the Runtime keeps running. */
  private async unloadIfIdle(): Promise<void> {
    const { dirs, http } = this.deps;
    const idle = (state: QueueState) => state.model !== null && Date.now() - state.endedAt >= this.idleMs;
    const port = this.owned?.port;
    if (port === undefined || !idle(await readQueueState(dirs))) return;
    await whileIdle(dirs, async () => {
      // Read again holding the turn: a Job may have run since.
      const state = await readQueueState(dirs);
      if (!idle(state)) return;
      const response = await http(`${urlOf(port)}/sdcpp/v1/models/unload`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      if (response.ok) await writeQueueState(dirs, { model: null, endedAt: state.endedAt });
    });
  }

  /** Stops the Runtime this manager started or adopted; a Job another process had running on it then fails. */
  async stop(): Promise<void> {
    clearInterval(this.idleTimer);
    this.idleTimer = undefined;
    process.removeListener("exit", this.killOnExit);
    const owned = this.owned;
    this.owned = undefined;
    if (owned === undefined) return;
    if ((await readJson<Lock>(lockPath(this.deps.dirs)))?.ownerId === this.id) await rm(lockPath(this.deps.dirs), { force: true });
    kill(owned.runtimePid);
  }
}

function kill(pid: number): void {
  try {
    process.kill(pid);
  } catch {
    // Already gone.
  }
}
