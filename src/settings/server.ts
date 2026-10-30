import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Dirs } from "../dirs.ts";
import type { HttpTransport } from "../http.ts";
import { ConfigError } from "../config.ts";
import { matchRoute, readJsonBody } from "./api.ts";
import { renderPage } from "./page.ts";
import { SettingsError } from "./providers.ts";

export interface SettingsServerOptions {
  dirs: Dirs;
  /** Used for Provider calls such as "test connection". */
  http: HttpTransport;
  /** The server shuts itself down after this long without an accepted request. */
  idleMs: number;
  /** Timestamps changes, such as who changed Model Notes when. Defaults to the system clock. */
  now?: () => Date;
}

export interface SettingsServer {
  /** The URL to open in the User's browser. It carries the one-time token, so show it only to the User. */
  url: string;
  /** The page's own origin, `http://127.0.0.1:<port>`. */
  origin: string;
  close(): Promise<void>;
  /** Settles once the server has shut down, whether closed or idle. */
  closed: Promise<void>;
}

export const tokenHeader = "x-litevision-token";

/** Fifteen minutes. */
export const defaultSettingsIdleMs = 15 * 60 * 1000;

/** Starts the settings page on 127.0.0.1 on a random port (ADR 0001). */
export async function startSettingsServer(options: SettingsServerOptions): Promise<SettingsServer> {
  const token = randomBytes(32).toString("base64url");
  const now = options.now ?? (() => new Date());
  let host = "";
  let origin = "";

  const server = createServer((request, response) => {
    if (!isAllowed(request, { token, host, origin })) {
      sendJson(response, 403, { error: "Forbidden." });
      return;
    }
    resetIdle();
    void handle(request, response).catch((error: Error) => {
      if (response.headersSent) {
        response.end();
        return;
      }
      if (error instanceof SettingsError) sendJson(response, error.status, { error: error.message });
      else if (error instanceof ConfigError) sendJson(response, 409, { error: error.message });
      else sendJson(response, 500, { error: "Something went wrong in the settings server." });
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", origin);
    if (url.pathname.startsWith("/api/")) {
      const route = matchRoute(request.method ?? "GET", url.pathname);
      if (route === undefined) throw new SettingsError(404, "Not found.");
      const body = request.method === "GET" || request.method === "HEAD" ? undefined : await readJsonBody(request);
      const result = await route.handler({ params: route.params, body, dirs: options.dirs, http: options.http, now });
      if (result === undefined) {
        response.writeHead(204, commonHeaders);
        response.end();
      } else {
        sendJson(response, result.status ?? 200, result.body);
      }
      return;
    }
    if (request.method === "GET" && url.pathname === "/") {
      const nonce = randomBytes(16).toString("base64");
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`,
        ...commonHeaders,
      });
      response.end(renderPage(nonce));
      return;
    }
    sendJson(response, 404, { error: "Not found." });
  }

  let idleTimer: NodeJS.Timeout | undefined;
  function resetIdle(): void {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => void close(), options.idleMs);
  }

  let closing: Promise<void> | undefined;
  let markClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    markClosed = resolve;
  });
  function close(): Promise<void> {
    closing ??= new Promise<void>((resolve) => {
      clearTimeout(idleTimer);
      server.close(() => resolve());
      server.closeAllConnections();
    }).then(markClosed);
    return closing;
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  host = `127.0.0.1:${port}`;
  origin = `http://${host}`;
  resetIdle();

  return { url: `${origin}/?token=${token}`, origin, close, closed };
}

/** The three checks of ADR 0001: the one-time token, a `Host` of 127.0.0.1, and the page's own `Origin`. */
function isAllowed(request: IncomingMessage, expected: { token: string; host: string; origin: string }): boolean {
  if (request.headers.host !== expected.host) return false;

  const { origin } = request.headers;
  // Browsers leave `Origin` out of same-origin GETs, but always send it on anything that changes state.
  const readOnly = request.method === "GET" || request.method === "HEAD";
  if (origin === undefined ? !readOnly : origin !== expected.origin) return false;

  const header = request.headers[tokenHeader];
  const presented =
    (typeof header === "string" ? header : undefined) ??
    new URL(request.url ?? "/", expected.origin).searchParams.get("token") ??
    "";
  return sameSecret(presented, expected.token);
}

function sameSecret(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const commonHeaders = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", ...commonHeaders });
  response.end(JSON.stringify(body));
}
