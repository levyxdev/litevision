import { readFile, rm, stat } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import type { Dirs } from "../src/dirs.ts";
import { startSettingsServer, type SettingsServer } from "../src/settings/server.ts";
import { makeTempDirs, recordedTransport, type Routes, type TempDirsOptions } from "./recorded-http.ts";

export interface SettingsHarnessOptions extends TempDirsOptions {
  /** Recorded Provider responses, keyed by "METHOD url". */
  routes?: Routes;
  /** Defaults to a minute, so only idle-shutdown tests need to think about it. */
  idleMs?: number;
  /** The clock the settings server records changes with, e.g. who changed Model Notes when. */
  now?: () => Date;
}

/**
 * Overrides for one request. Each defaults to what the settings page itself would send;
 * pass `null` to leave the header (or token) out, or a string to send a wrong one.
 */
export interface SendOptions {
  body?: unknown;
  token?: string | null;
  host?: string | null;
  origin?: string | null;
  headers?: Record<string, string>;
}

export interface SettingsResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  /** The body parsed as JSON. */
  json<T = any>(): T;
}

export interface SettingsHarness {
  dirs: Dirs;
  /** The settings server under test. */
  server: SettingsServer;
  /** The page's own origin, `http://127.0.0.1:<port>`. */
  origin: string;
  /** The one-time token from the URL litevision opens. */
  token: string;
  /** Every request litevision sent to a Provider, in order. */
  requests: Request[];
  /**
   * Sends one real HTTP request to the settings server, the way the page does: with the token
   * (as the `x-litevision-token` header), the right `Host`, and, for anything but GET, the page's
   * `Origin` and a JSON body.
   */
  send(method: string, path: string, options?: SendOptions): Promise<SettingsResponse>;
  /** `config.json` as written on disk, parsed. */
  readConfig(): Promise<any>;
  /** `credentials.json` as written on disk, parsed. */
  readCredentials(): Promise<any>;
  /** Permission bits of a file in the configuration directory, e.g. `0o600`. */
  fileMode(name: string): Promise<number>;
  close(): Promise<void>;
}

/** Starts the settings server on a random port against temporary directories and recorded Provider responses. */
export async function startSettingsHarness(options: SettingsHarnessOptions = {}): Promise<SettingsHarness> {
  const { root, dirs } = await makeTempDirs(options);
  const { http, requests } = recordedTransport(options.routes);
  const server = await startSettingsServer({ dirs, http, idleMs: options.idleMs ?? 60_000, now: options.now });
  const token = new URL(server.url).searchParams.get("token") ?? "";
  const { host } = new URL(server.origin);

  return {
    dirs,
    server,
    origin: server.origin,
    token,
    requests,
    send: (method, path, sendOptions = {}) =>
      send(server.origin, method, path, {
        token,
        host,
        origin: method === "GET" ? null : server.origin,
        ...sendOptions,
      }),
    readConfig: async () => JSON.parse(await readFile(join(dirs.config, "config.json"), "utf8")),
    readCredentials: async () => JSON.parse(await readFile(join(dirs.config, "credentials.json"), "utf8")),
    fileMode: async (name) => (await stat(join(dirs.config, name))).mode & 0o777,
    async close() {
      await server.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function send(origin: string, method: string, path: string, options: SendOptions): Promise<SettingsResponse> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.token != null) headers["x-litevision-token"] = options.token;
  if (options.host != null) headers.host = options.host;
  if (options.origin != null) headers.origin = options.origin;
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  if (body !== undefined) headers["content-type"] = "application/json";

  return new Promise((resolve, reject) => {
    // node:http rather than fetch, so tests can send any Host header, or none at all.
    const request = httpRequest(new URL(path, origin), { method, headers, setHost: false }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: response.statusCode ?? 0, headers: response.headers, text, json: () => JSON.parse(text) });
      });
    });
    request.on("error", reject);
    request.end(body);
  });
}
