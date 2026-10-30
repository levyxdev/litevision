import type { Dirs } from "../dirs.ts";
import type { HttpTransport } from "../http.ts";
import { adapterForProtocol } from "../protocols/index.ts";
import type { ProtocolAdapter, ProviderTarget } from "../protocols/protocol.ts";
import { getProvider, savedCredential } from "./providers.ts";

/** What the page shows after "test connection". The message never contains the Credential. */
export interface ConnectionTestResult {
  result: "success" | "failure" | "unsupported";
  message: string;
}

/** What the page gets when it fetches a Provider's model ids. A message never contains the Credential. */
export type ModelIdsResponse = { result: "success"; modelIds: string[] } | { result: "failure" | "unsupported"; message: string };

/** Tests a saved Provider with one Protocol's `testConnection`, through the injected HTTP transport. */
export async function testConnection(dirs: Dirs, http: HttpTransport, providerId: string, protocol: string): Promise<ConnectionTestResult> {
  const call = await prepare(dirs, providerId, protocol, (adapter) => adapter.testConnection);
  if (call === "unsupported") {
    return { result: "unsupported", message: `Testing a connection with Protocol "${protocol}" is not supported yet.` };
  }
  if (call.kind === "failure") return { result: "failure", message: call.message };

  let outcome: { ok: boolean; message: string };
  try {
    outcome = await call.run(http);
  } catch (error) {
    outcome = { ok: false, message: unreachable(providerId, error) };
  }
  return { result: outcome.ok ? "success" : "failure", message: call.redact(outcome.message) };
}

/** Fetches the model ids a saved Provider offers through one Protocol. When it cannot, the User types a model id instead. */
export async function fetchModelIds(dirs: Dirs, http: HttpTransport, providerId: string, protocol: string): Promise<ModelIdsResponse> {
  const typeInstead = "You can still type the model id.";
  const call = await prepare(dirs, providerId, protocol, (adapter) => adapter.listModelIds);
  if (call === "unsupported") {
    return { result: "unsupported", message: `Fetching model ids with Protocol "${protocol}" is not supported, so type the model id.` };
  }
  if (call.kind === "failure") return { result: "failure", message: `${call.message} ${typeInstead}` };

  let message: string;
  try {
    const list = await call.run(http);
    if (list.ok) return { result: "success", modelIds: list.modelIds };
    message = list.message;
  } catch (error) {
    message = unreachable(providerId, error);
  }
  return { result: "failure", message: `${call.redact(message)} ${typeInstead}` };
}

type ProviderCall<T> = (target: ProviderTarget, http: HttpTransport) => Promise<T>;

type Prepared<T> =
  | "unsupported"
  | { kind: "failure"; message: string }
  | {
      kind: "ready";
      run(http: HttpTransport): Promise<T>;
      /** A Provider may echo the Credential back in an error; it must never reach the page. */
      redact(message: string): string;
    };

/** Finds the Provider, the adapter's call and the saved Credential a Provider-level call from the page needs. */
async function prepare<T>(
  dirs: Dirs,
  providerId: string,
  protocol: string,
  pick: (adapter: ProtocolAdapter) => ProviderCall<T> | undefined,
): Promise<Prepared<T>> {
  const provider = await getProvider(dirs, providerId);
  const adapter = adapterForProtocol(protocol);
  const providerCall = adapter === undefined ? undefined : pick(adapter);
  if (providerCall === undefined) return "unsupported";
  const credential = await savedCredential(dirs, providerId);
  if (credential === undefined) {
    return { kind: "failure", message: `Provider "${providerId}" has no Credential saved. Save one, then try again.` };
  }
  const target = { providerId, baseUrl: provider.baseUrl, credential };
  return {
    kind: "ready",
    run: (http) => providerCall.call(adapter, target, http),
    redact: (message) => message.split(credential).join("[redacted]"),
  };
}

function unreachable(providerId: string, error: unknown): string {
  return `Could not reach Provider "${providerId}": ${(error as Error).message}`;
}
