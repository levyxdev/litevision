import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Dirs } from "../src/dirs.ts";
import type { HttpTransport } from "../src/http.ts";

/** Answers one recorded Provider request. */
export type Route = (request: Request) => Response | Promise<Response>;

/** Keyed by "METHOD url", e.g. "POST https://api.openai.com/v1/images/generations". */
export type Routes = Record<string, Route>;

export interface RecordedTransport {
  http: HttpTransport;
  /** Every request litevision sent to a Provider, in order. */
  requests: Request[];
}

/** The injected HTTP transport: replays recorded Provider responses, and fails any request without one. */
export function recordedTransport(routes: Routes = {}): RecordedTransport {
  const requests: Request[] = [];
  const http: HttpTransport = async (input, init) => {
    const request = new Request(input, init);
    requests.push(request.clone() as Request);
    const route = routes[`${request.method} ${request.url}`];
    if (route === undefined) {
      throw new Error(`No recorded response for ${request.method} ${request.url}`);
    }
    return route(request);
  };
  return { http, requests };
}

/** Replays a file from `test/fixtures/` as a JSON response. */
export function fixture(name: string, status = 200): Route {
  return async () =>
    new Response(await readFile(join(import.meta.dir, "fixtures", name)), {
      status,
      headers: { "content-type": "application/json" },
    });
}

export interface TempDirsOptions {
  /** Written to `config.json` as JSON when given. */
  config?: unknown;
  /** Written to `credentials.json` as JSON when given. */
  credentials?: unknown;
}

/** Fresh configuration, data and output directories under one temporary root. */
export async function makeTempDirs(options: TempDirsOptions = {}): Promise<{ root: string; dirs: Dirs }> {
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
  return { root, dirs };
}
