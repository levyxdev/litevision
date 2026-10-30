import { rm } from "node:fs/promises";
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
}

export interface Harness {
  client: Client;
  dirs: Dirs;
  /** Every request litevision sent to a Provider, in order. */
  requests: Request[];
  /** Every URL litevision asked to open in the User's browser, in order. No browser is launched. */
  openedUrls: string[];
  close(): Promise<void>;
}

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const { root, dirs } = await makeTempDirs(options);
  const { http, requests } = recordedTransport(options.routes);
  const openedUrls: string[] = [];

  const server = createServer({
    dirs,
    http,
    now: options.now,
    openBrowser:
      options.openBrowser ??
      (async (url) => {
        openedUrls.push(url);
      }),
    settingsIdleMs: options.settingsIdleMs,
  });
  const client = new Client({ name: "test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    dirs,
    requests,
    openedUrls,
    async close() {
      await client.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
