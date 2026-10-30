import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Dirs } from "../src/dirs.ts";
import type { HttpTransport } from "../src/http.ts";
import { createServer } from "../src/server.ts";

export type Route = (request: Request) => Response | Promise<Response>;

export interface HarnessOptions {
  config?: unknown;
  credentials?: unknown;
  /** Keyed by "METHOD url", e.g. "POST https://api.openai.com/v1/images/generations". */
  routes?: Record<string, Route>;
  now?: () => Date;
}

export interface Harness {
  client: Client;
  dirs: Dirs;
  /** Every request litevision sent to a Provider, in order. */
  requests: Request[];
  close(): Promise<void>;
}

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "litevision-test-"));
  const dirs: Dirs = {
    config: join(root, "config"),
    data: join(root, "data"),
    output: join(root, "outputs"),
  };
  await mkdir(dirs.config, { recursive: true });
  if (options.config !== undefined) {
    await writeFile(join(dirs.config, "config.json"), JSON.stringify(options.config));
  }
  if (options.credentials !== undefined) {
    await writeFile(join(dirs.config, "credentials.json"), JSON.stringify(options.credentials));
  }

  const requests: Request[] = [];
  const routes = options.routes ?? {};
  const http: HttpTransport = async (input, init) => {
    const request = new Request(input, init);
    requests.push(request.clone() as Request);
    const route = routes[`${request.method} ${request.url}`];
    if (route === undefined) {
      throw new Error(`No recorded response for ${request.method} ${request.url}`);
    }
    return route(request);
  };

  const server = createServer({ dirs, http, now: options.now });
  const client = new Client({ name: "test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    dirs,
    requests,
    async close() {
      await client.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
