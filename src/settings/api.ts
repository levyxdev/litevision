import type { IncomingMessage } from "node:http";
import { z } from "zod";
import type { Dirs } from "../dirs.ts";
import type { HttpTransport } from "../http.ts";
import { refreshModelInfo, refreshProviderModelInfo, type ModelInfoDeps } from "../model-info.ts";
import { supportedProtocols } from "../protocols/index.ts";
import { fetchModelIds, testConnection } from "./connection.ts";
import {
  addModel,
  addModelInput,
  listModels,
  removeModel,
  setDefaultImageModel,
  setDefaultInput,
  updateModel,
  updateModelInput,
} from "./models.ts";
import {
  addProvider,
  addProviderInput,
  getProvider,
  listProviders,
  providerPresets,
  removeCredential,
  removeProvider,
  SettingsError,
  updateProvider,
  updateProviderInput,
} from "./providers.ts";

export interface RouteContext {
  params: Record<string, string>;
  /** The parsed JSON body; `undefined` for GET. */
  body: unknown;
  dirs: Dirs;
  http: HttpTransport;
}

/** `undefined` answers 204 No Content. */
export type RouteResult = { status?: number; body: unknown } | undefined;

interface Route {
  method: string;
  /** Path segments; `:name` captures one segment into `params.name`. */
  path: string;
  handler(context: RouteContext): Promise<RouteResult>;
}

/**
 * The settings JSON API. Every route sits behind the three checks of ADR 0001.
 * Areas added later (Job history) add their routes here.
 */
const routes: Route[] = [
  {
    method: "GET",
    path: "/api/presets",
    handler: async () => ({ body: { presets: providerPresets } }),
  },
  {
    method: "GET",
    path: "/api/providers",
    handler: async ({ dirs }) => ({ body: { providers: await listProviders(dirs) } }),
  },
  {
    method: "POST",
    path: "/api/providers",
    handler: async ({ dirs, body }) => ({ status: 201, body: { provider: await addProvider(dirs, parse(addProviderInput, body)) } }),
  },
  {
    method: "GET",
    path: "/api/providers/:id",
    handler: async ({ dirs, params }) => ({ body: { provider: await getProvider(dirs, params.id!) } }),
  },
  {
    method: "PATCH",
    path: "/api/providers/:id",
    handler: async ({ dirs, params, body }) => ({
      body: { provider: await updateProvider(dirs, params.id!, parse(updateProviderInput, body)) },
    }),
  },
  {
    method: "DELETE",
    path: "/api/providers/:id",
    handler: async ({ dirs, params }) => {
      await removeProvider(dirs, params.id!);
      return undefined;
    },
  },
  {
    method: "DELETE",
    path: "/api/providers/:id/credential",
    handler: async ({ dirs, params }) => ({ body: { provider: await removeCredential(dirs, params.id!) } }),
  },
  {
    method: "POST",
    path: "/api/providers/:id/test-connection",
    handler: async ({ dirs, http, params, body }) => {
      const { protocol } = parse(protocolInput, body);
      const result = await testConnection(dirs, http, params.id!, protocol);
      if (result.result === "success") await refreshProviderModelInfo(infoDeps(dirs, http), params.id!, protocol);
      return { body: result };
    },
  },
  {
    method: "POST",
    path: "/api/providers/:id/model-ids",
    handler: async ({ dirs, http, params, body }) => {
      const { protocol } = parse(protocolInput, body);
      return { body: await fetchModelIds(dirs, http, params.id!, protocol) };
    },
  },
  {
    method: "GET",
    path: "/api/protocols",
    handler: async () => ({ body: { protocols: supportedProtocols() } }),
  },
  {
    method: "GET",
    path: "/api/models",
    handler: async ({ dirs }) => ({ body: await listModels(dirs) }),
  },
  {
    method: "POST",
    path: "/api/models",
    handler: async ({ dirs, http, body }) => {
      const model = await addModel(dirs, parse(addModelInput, body));
      await refreshModelInfo(infoDeps(dirs, http), model.alias);
      return { status: 201, body: { model } };
    },
  },
  {
    method: "PATCH",
    path: "/api/models/:alias",
    handler: async ({ dirs, http, params, body }) => {
      const model = await updateModel(dirs, params.alias!, parse(updateModelInput, body));
      await refreshModelInfo(infoDeps(dirs, http), model.alias);
      return { body: { model } };
    },
  },
  {
    method: "DELETE",
    path: "/api/models/:alias",
    handler: async ({ dirs, params }) => {
      await removeModel(dirs, params.alias!);
      return undefined;
    },
  },
  {
    method: "PUT",
    path: "/api/default-image-model",
    handler: async ({ dirs, body }) => ({ body: await setDefaultImageModel(dirs, parse(setDefaultInput, body).alias) }),
  },
];

/** Adding or changing a Model, or a successful "test connection", asks the Provider again about its Models (ADR 0004). */
function infoDeps(dirs: Dirs, http: HttpTransport): ModelInfoDeps {
  return { dirs, http, now: () => new Date() };
}

const protocolInput = z.object({ protocol: z.string().trim().min(1, "Choose a Protocol.") });

export function matchRoute(method: string, pathname: string): { handler: Route["handler"]; params: Record<string, string> } | undefined {
  const segments = pathname.split("/");
  for (const route of routes) {
    if (route.method !== method) continue;
    const pattern = route.path.split("/");
    if (pattern.length !== segments.length) continue;
    const params: Record<string, string> = {};
    const matches = pattern.every((part, index) => {
      const segment = segments[index]!;
      if (!part.startsWith(":")) return part === segment;
      if (segment === "") return false;
      try {
        params[part.slice(1)] = decodeURIComponent(segment);
      } catch {
        return false;
      }
      return true;
    });
    if (matches) return { handler: route.handler, params };
  }
  return undefined;
}

const maxBodyBytes = 64 * 1024;

export async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > maxBodyBytes) throw new SettingsError(413, "The request is too large.");
    chunks.push(chunk);
  }
  if (size === 0) return {};
  if (!String(request.headers["content-type"] ?? "").startsWith("application/json")) {
    throw new SettingsError(415, "Send JSON.");
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new SettingsError(400, "The request is not valid JSON.");
  }
}

function parse<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const parsed = schema.safeParse(body);
  // Report what is wrong, never the values themselves: one of them may be a Credential.
  if (!parsed.success) throw new SettingsError(400, parsed.error.issues.map((issue) => issue.message).join(" "));
  return parsed.data;
}
