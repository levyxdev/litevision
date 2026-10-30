import type { Dirs } from "../dirs.ts";
import type { HttpTransport } from "../http.ts";
import { adapterForProtocol } from "../protocols/index.ts";
import { getProvider, savedCredential } from "./providers.ts";

/** What the page shows after "test connection". The message never contains the Credential. */
export interface ConnectionTestResult {
  result: "success" | "failure" | "unsupported";
  message: string;
}

/** Tests a saved Provider with one Protocol's `testConnection`, through the injected HTTP transport. */
export async function testConnection(dirs: Dirs, http: HttpTransport, providerId: string, protocol: string): Promise<ConnectionTestResult> {
  const provider = await getProvider(dirs, providerId);
  const adapter = adapterForProtocol(protocol);
  if (adapter?.testConnection === undefined) {
    return { result: "unsupported", message: `Testing a connection with Protocol "${protocol}" is not supported yet.` };
  }
  const credential = await savedCredential(dirs, providerId);
  if (credential === undefined) {
    return { result: "failure", message: `Provider "${providerId}" has no Credential saved. Save one, then test again.` };
  }

  let outcome: { ok: boolean; message: string };
  try {
    outcome = await adapter.testConnection({ providerId, baseUrl: provider.baseUrl, credential }, http);
  } catch (error) {
    outcome = { ok: false, message: `Could not test Provider "${providerId}": ${(error as Error).message}` };
  }
  // A Provider may echo the Credential back in an error; it must never reach the page.
  const message = outcome.message.split(credential).join("[redacted]");
  return { result: outcome.ok ? "success" : "failure", message };
}
