import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { parseCommand } from "../src/cli.ts";
import type { Dirs } from "../src/dirs.ts";
import { catalog, type Catalog } from "../src/local/catalog.ts";
import { runtimePlatform, type Hardware } from "../src/local/hardware.ts";
import { runLocal } from "../src/local/install.ts";
import type { Runtime } from "../src/local/runtime.ts";
import { createServer } from "../src/server.ts";
import { makeTempDirs, recordedTransport, type Route, type Routes } from "./recorded-http.ts";

export type { Route };

export interface HarnessOptions {
  config?: unknown;
  credentials?: unknown;
  /** Keyed by "METHOD url", e.g. "POST https://api.openai.com/v1/images/generations". */
  routes?: Routes;
  now?: () => Date;
  /** Idle period of the settings page `open_settings` starts. */
  settingsIdleMs?: number;
  /** Replaces the default browser stand-in, which records each URL in `openedUrls`. */
  openBrowser?: (url: string) => Promise<void>;
  /** How long `generate_image` and `get_job` wait for a Job; tests keep it short. */
  waitLimitMs?: number;
  /** How often asynchronous Protocols poll their Provider; tests keep it short. */
  pollIntervalMs?: number;
  /** The delay before retrying a request the Provider never processed; 1 ms unless a test sets it. */
  retryDelayMs?: number;
  /** What `local install` downloads; its files are served from `routes`. */
  catalog?: Catalog;
  /**
   * Installs a fake Runtime binary, a script that serves sd-server's API, where litevision looks for this platform's
   * build, and sends requests to it, on 127.0.0.1 with no recorded route, through for real.
   */
  runtime?: boolean;
  /** Stands in for the shared Runtime with one at this address, answered from `routes`, as for a cloud Provider. */
  runtimeAt?: string;
  /** Sends requests on 127.0.0.1 with no recorded route through for real, to a Runtime `local install` installed. */
  reachRuntime?: boolean;
  /** How long the Runtime may sit idle before its Model is unloaded; tests keep it short. */
  runtimeIdleMs?: number;
  /** Runs this harness on another's home and output folders, as a second session on the same machine. */
  shareHomeWith?: Harness;
}

/** One event the fake Runtime logged: `start` (with `args`), `load`, `unload`, `generate`, `done` or `cancel`. */
export interface RuntimeEvent {
  event: string;
  recipe?: string | null;
  id?: string;
  args?: string[];
  at: number;
  pid: number;
}

export interface FakeRuntime {
  /** Everything the fake Runtime did so far, across every start, in order. */
  events(): Promise<RuntimeEvent[]>;
  /** How long each Job takes on the Runtime from now on. */
  setJobMs(ms: number): Promise<void>;
}

export interface CliOptions {
  /** The machine `local install` sees; never read from the one running the tests. */
  hardware?: Hardware;
  /** The User's answer when asked; absent, no one can answer, as when the Agent runs the command. */
  answer?: boolean;
}

export interface Harness {
  client: Client;
  dirs: Dirs;
  /** The server's working directory: an empty temporary folder that relative paths resolve against. */
  cwd: string;
  /** Every request litevision sent to a Provider, in order. */
  requests: Request[];
  /** Every URL litevision asked to open in the User's browser, in order. No browser is launched. */
  openedUrls: string[];
  /** With the `runtime` option, or on a home shared with a harness that has it. */
  runtime: FakeRuntime | undefined;
  /** @internal The temporary root this harness's home is under. */
  root: string;
  /**
   * Stands in for the MCP server process restarting: closes this server, abandoning its running Jobs, and connects
   * `client` to a new one on the same directories and Provider responses.
   */
  restart(): Promise<void>;
  /** Runs a CLI command on the same home and Provider responses, as the Agent would in a terminal. */
  cli(args: string[], options?: CliOptions): Promise<{ code: number; output: string }>;
  close(): Promise<void>;
}

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const shared = options.shareHomeWith;
  const { root, dirs } = shared === undefined ? await makeTempDirs(options) : { root: shared.root, dirs: shared.dirs };
  const cwd = join(root, shared === undefined ? "cwd" : `cwd-${crypto.randomUUID()}`);
  await mkdir(cwd, { recursive: true });
  const runtime = shared?.runtime ?? (options.runtime ? await installFakeRuntime(root, dirs, options.catalog ?? catalog) : undefined);
  const { http, requests } = recordedTransport(options.routes, (url) => (runtime !== undefined || options.reachRuntime === true) && url.hostname === "127.0.0.1");
  const openedUrls: string[] = [];

  const connect = async () => {
    const server = createServer({
      dirs,
      http,
      now: options.now,
      cwd,
      openBrowser:
        options.openBrowser ??
        (async (url) => {
          openedUrls.push(url);
        }),
      settingsIdleMs: options.settingsIdleMs,
      waitLimitMs: options.waitLimitMs,
      pollIntervalMs: options.pollIntervalMs,
      retryDelayMs: options.retryDelayMs ?? 1,
      catalog: options.catalog,
      runtimeIdleMs: options.runtimeIdleMs,
      ...(options.runtimeAt === undefined ? {} : { runtime: recordedRuntime(options.runtimeAt) }),
    });
    const client = new Client({ name: "test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return { server, client };
  };
  let connected = await connect();
  const disconnect = async () => {
    await connected.client.close();
    await connected.server.close();
  };

  return {
    get client() {
      return connected.client;
    },
    dirs,
    cwd,
    requests,
    openedUrls,
    runtime,
    root,
    async restart() {
      await disconnect();
      connected = await connect();
    },
    async cli(args, cliOptions = {}) {
      const command = parseCommand(args);
      if (command.kind === "exit") return { code: command.code, output: command.output };
      if (command.kind !== "local") throw new Error(`harness.cli runs only local commands, not ${args.join(" ")}`);
      const lines: string[] = [];
      const code = await runLocal(command, {
        dirs,
        http,
        catalog: options.catalog ?? catalog,
        hardware: async () => {
          if (cliOptions.hardware === undefined) throw new Error("Pass the hardware the command sees.");
          return cliOptions.hardware;
        },
        confirm: cliOptions.answer === undefined ? undefined : async () => cliOptions.answer!,
        print: (line) => lines.push(line),
        pause: async () => {},
      });
      return { code, output: lines.join("\n") };
    },
    async close() {
      await disconnect();
      if (shared === undefined) await rm(root, { recursive: true, force: true });
    },
  };
}

/** A Runtime that is always installed and running at `url`, which never starts or stops a process. */
function recordedRuntime(url: string): Runtime {
  return { requireInstalled: async () => {}, address: async () => url, stop: async () => {} };
}

/** Writes the fake Runtime's launcher where litevision finds the installed Runtime build for this platform. */
export async function installFakeRuntime(root: string, dirs: Dirs, catalog: Catalog): Promise<FakeRuntime> {
  const platform = runtimePlatform();
  if (platform === undefined) throw new Error("The fake Runtime needs a platform litevision has a Runtime build for.");
  const build = catalog.runtime[platform];
  const folder = join(dirs.home, "runtime", build.tag);
  const logs = join(root, "fake-runtime");
  await mkdir(folder, { recursive: true });
  await mkdir(logs, { recursive: true });
  const binary = join(folder, build.binary);
  const script = join(import.meta.dir, "fake-runtime.ts");
  await writeFile(binary, `#!/bin/sh\nFAKE_RUNTIME_DIR='${logs}' exec '${process.execPath}' '${script}' "$@"\n`);
  await chmod(binary, 0o755);
  return {
    async events() {
      const text = await readFile(join(logs, "log.jsonl"), "utf8").catch(() => "");
      return text.trim() === "" ? [] : text.trim().split("\n").map((line) => JSON.parse(line) as RuntimeEvent);
    },
    async setJobMs(ms) {
      await writeFile(join(logs, "fake.json"), JSON.stringify({ jobMs: ms }));
    },
  };
}
