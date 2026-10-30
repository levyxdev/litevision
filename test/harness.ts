import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Dirs } from "../src/dirs.ts";
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
  /**
   * Stands in for the MCP server process restarting: closes this server, abandoning its running Jobs, and connects
   * `client` to a new one on the same directories and Provider responses.
   */
  restart(): Promise<void>;
  close(): Promise<void>;
}

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const { root, dirs } = await makeTempDirs(options);
  const cwd = join(root, "cwd");
  await mkdir(cwd, { recursive: true });
  const { http, requests } = recordedTransport(options.routes);
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
    async restart() {
      await disconnect();
      connected = await connect();
    },
    async close() {
      await disconnect();
      await rm(root, { recursive: true, force: true });
    },
  };
}
