import { afterEach, describe, expect, test } from "bun:test";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture } from "./recorded-http.ts";
import {
  startSettingsHarness,
  type SendOptions,
  type SettingsHarness,
  type SettingsHarnessOptions,
} from "./settings-harness.ts";

let harness: SettingsHarness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function start(options: SettingsHarnessOptions = {}): Promise<SettingsHarness> {
  harness = await startSettingsHarness(options);
  return harness;
}

describe("settings page access", () => {
  test("listens on 127.0.0.1 and serves the page at the URL litevision opens", async () => {
    const h = await start();
    expect(h.server.url).toStartWith("http://127.0.0.1:");
    expect(h.server.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const response = await h.send("GET", new URL(h.server.url).pathname + new URL(h.server.url).search, { token: null });
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toStartWith("text/html");
    expect(response.text).toContain("Providers");
  });
});

describe("idle shutdown", () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const isClosed = (h: SettingsHarness) => Promise.race([h.server.closed.then(() => true), sleep(0).then(() => false)]);

  test("shuts down after the idle period and stops accepting connections", async () => {
    const h = await start({ idleMs: 100 });
    expect(await isClosed(h)).toBe(false);
    await h.server.closed;
    await expect(h.send("GET", "/")).rejects.toThrow();
  });

  test("each accepted request postpones the shutdown", async () => {
    const h = await start({ idleMs: 300 });
    for (let i = 0; i < 6; i++) {
      await sleep(100);
      expect((await h.send("GET", "/api/providers")).status).toBe(200);
    }
    expect(await isClosed(h)).toBe(false);
    await h.server.closed;
  });

  test("rejected requests do not keep it alive", async () => {
    const h = await start({ idleMs: 300 });
    let shut = false;
    void h.server.closed.then(() => (shut = true));
    for (let i = 0; i < 6 && !shut; i++) {
      await sleep(100);
      await h.send("GET", "/api/providers", { token: "wrong" }).catch(() => undefined);
    }
    expect(shut).toBe(true);
  });

  test("close() shuts it down straight away", async () => {
    const h = await start();
    await h.server.close();
    expect(await isClosed(h)).toBe(true);
  });
});

describe("settings page rejects requests that fail any of the three checks", () => {
  const forbidden = async (method: string, path: string, options: SendOptions) => {
    const response = await harness!.send(method, path, options);
    expect(response.status).toBe(403);
    expect(response.text).not.toContain(harness!.token);
  };

  test("a missing token", async () => {
    await start();
    await forbidden("GET", "/", { token: null });
    await forbidden("GET", "/api/providers", { token: null });
    await forbidden("POST", "/api/providers", { token: null, body: { id: "openai", baseUrl: "https://api.openai.com/v1" } });
  });

  test("a wrong token, in the header or the URL", async () => {
    const h = await start();
    await forbidden("GET", "/api/providers", { token: "not-the-token" });
    await forbidden("GET", `/?token=${h.token.slice(0, -1)}x`, { token: null });
    await forbidden("GET", "/?token=", { token: null });
  });

  test("a Host other than 127.0.0.1:<port>, which is what DNS rebinding looks like", async () => {
    const h = await start();
    const port = new URL(h.origin).port;
    await forbidden("GET", "/", { host: `localhost:${port}` });
    await forbidden("GET", "/api/providers", { host: `evil.example:${port}` });
    await forbidden("GET", "/api/providers", { host: "127.0.0.1" });
    // Without any Host, Node's HTTP parser already refuses the request.
    expect((await h.send("GET", "/api/providers", { host: null })).status).toBe(400);
  });

  test("a foreign Origin, or a state-changing request with no Origin", async () => {
    const h = await start();
    const body = { id: "openai", baseUrl: "https://evil.example/v1" };
    await forbidden("GET", "/api/providers", { origin: "https://evil.example" });
    await forbidden("POST", "/api/providers", { origin: "https://evil.example", body });
    await forbidden("POST", "/api/providers", { origin: "http://localhost", body });
    await forbidden("POST", "/api/providers", { origin: "null", body });
    await forbidden("POST", "/api/providers", { origin: null, body });
    expect((await h.send("GET", "/api/providers")).status).toBe(200);
  });

  test("serves the page with headers that keep the token on the page", async () => {
    const h = await start();
    const response = await h.send("GET", "/");
    expect(response.status).toBe(200);
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.headers["x-frame-options"]).toBe("DENY");
    expect(String(response.headers["content-security-policy"])).toContain("frame-ancestors 'none'");
  });
});

const apiKey = "sk-test-0000secret0000";
const openai = { id: "openai", baseUrl: "https://api.openai.com/v1" };

describe("Providers", () => {
  test("adding a Provider writes config.json without the Credential and credentials.json with mode 600", async () => {
    const h = await start();
    const response = await h.send("POST", "/api/providers", { body: { ...openai, credential: apiKey } });

    expect(response.status).toBe(201);
    expect(response.json()).toEqual({ provider: { ...openai, credential: { last4: "0000" } } });
    expect(response.text).not.toContain(apiKey);

    expect(await h.readConfig()).toEqual({ providers: [openai] });
    expect(await h.readCredentials()).toEqual({ openai: { apiKey } });
    expect(await h.fileMode("credentials.json")).toBe(0o600);
  });

  test("reading Providers back shows each Credential only by its last 4 characters", async () => {
    const h = await start({
      config: { providers: [openai, { id: "relay", baseUrl: "https://relay.example/v1" }] },
      credentials: { openai: { apiKey } },
    });
    const response = await h.send("GET", "/api/providers");

    expect(response.status).toBe(200);
    expect(response.json()).toEqual({
      providers: [
        { ...openai, credential: { last4: "0000" } },
        { id: "relay", baseUrl: "https://relay.example/v1", credential: null },
      ],
    });
    expect(response.text).not.toContain(apiKey);
    expect((await h.send("GET", "/api/providers/openai")).json()).toEqual({ provider: { ...openai, credential: { last4: "0000" } } });
  });

  test("lists presets for OpenAI, Gemini, Venice and APIMart with their base URLs", async () => {
    const h = await start();
    const { presets } = (await h.send("GET", "/api/presets")).json();
    expect(presets.map((preset: { label: string; baseUrl: string }) => [preset.label, preset.baseUrl])).toEqual([
      ["OpenAI", "https://api.openai.com/v1"],
      ["Gemini", "https://generativelanguage.googleapis.com/v1beta"],
      ["Venice", "https://api.venice.ai/api/v1"],
      ["APIMart", "https://api.apimart.ai/v1"],
    ]);
  });

  test("keeps every other configuration field and Credential untouched", async () => {
    const config = {
      providers: [{ id: "relay", baseUrl: "https://relay.example/v1", note: "kept" }],
      models: [{ alias: "cheap", provider: "relay", modelId: "m1", protocol: "openai-images", extra: true }],
      defaultImageModel: "cheap",
      somethingNewer: { nested: [1, 2] },
    };
    const h = await start({ config, credentials: { relay: { apiKey: "relay-key-1234" } } });

    await h.send("POST", "/api/providers", { body: { ...openai, credential: apiKey } });
    await h.send("PATCH", "/api/providers/relay", { body: { baseUrl: "https://relay.example/v2/" } });

    expect(await h.readConfig()).toEqual({
      ...config,
      providers: [{ id: "relay", baseUrl: "https://relay.example/v2", note: "kept" }, openai],
    });
    expect(await h.readCredentials()).toEqual({ relay: { apiKey: "relay-key-1234" }, openai: { apiKey } });
  });

  test("makes credentials.json mode 600 even when it already existed with a wider mode", async () => {
    const h = await start({ config: { providers: [openai] }, credentials: {} });
    await chmod(join(h.dirs.config, "credentials.json"), 0o644);

    await h.send("PATCH", "/api/providers/openai", { body: { credential: apiKey } });

    expect(await h.fileMode("credentials.json")).toBe(0o600);
    expect(await h.readCredentials()).toEqual({ openai: { apiKey } });
  });

  test("replaces a Credential and removes it", async () => {
    const h = await start({ config: { providers: [openai] }, credentials: { openai: { apiKey } } });

    const replaced = await h.send("PATCH", "/api/providers/openai", { body: { credential: "sk-new-key-9876" } });
    expect(replaced.json()).toEqual({ provider: { ...openai, credential: { last4: "9876" } } });
    expect(await h.readCredentials()).toEqual({ openai: { apiKey: "sk-new-key-9876" } });

    const removed = await h.send("DELETE", "/api/providers/openai/credential");
    expect(removed.json()).toEqual({ provider: { ...openai, credential: null } });
    expect(await h.readCredentials()).toEqual({});
    expect(await h.readConfig()).toEqual({ providers: [openai] });
    expect(await h.fileMode("credentials.json")).toBe(0o600);
  });

  test("removes a Provider together with its Credential", async () => {
    const relay = { id: "relay", baseUrl: "https://relay.example/v1" };
    const h = await start({
      config: { providers: [openai, relay] },
      credentials: { openai: { apiKey }, relay: { apiKey: "relay-key-1234" } },
    });

    expect((await h.send("DELETE", "/api/providers/openai")).status).toBe(204);
    expect(await h.readConfig()).toEqual({ providers: [relay] });
    expect(await h.readCredentials()).toEqual({ relay: { apiKey: "relay-key-1234" } });
    expect((await h.send("GET", "/api/providers/openai")).status).toBe(404);
  });

  test("refuses to remove a Provider a Model still uses", async () => {
    const config = {
      providers: [openai],
      models: [{ alias: "gpt-image", provider: "openai", modelId: "gpt-image-1", protocol: "openai-images" }],
    };
    const h = await start({ config, credentials: { openai: { apiKey } } });

    const response = await h.send("DELETE", "/api/providers/openai");
    expect(response.status).toBe(409);
    expect(response.json().error).toContain("gpt-image");
    expect(await h.readConfig()).toEqual(config);
    expect(await h.readCredentials()).toEqual({ openai: { apiKey } });
  });

  test("rejects invalid Providers without echoing the Credential", async () => {
    const h = await start({ config: { providers: [openai] } });
    const cases: Array<[unknown, number]> = [
      [{ id: "openai", baseUrl: "https://api.openai.com/v1", credential: apiKey }, 409],
      [{ id: "custom", baseUrl: "not a url", credential: apiKey }, 400],
      [{ id: "custom", baseUrl: "file:///etc/passwd", credential: apiKey }, 400],
      [{ id: "../custom", baseUrl: "https://relay.example/v1", credential: apiKey }, 400],
      [{ id: "custom", baseUrl: "https://relay.example/v1", credential: "   " }, 400],
    ];
    for (const [body, status] of cases) {
      const response = await h.send("POST", "/api/providers", { body });
      expect(response.status).toBe(status);
      expect(response.json().error).toBeString();
      expect(response.text).not.toContain(apiKey);
    }
    expect(await h.readConfig()).toEqual({ providers: [openai] });
    expect((await h.send("PATCH", "/api/providers/missing", { body: { credential: apiKey } })).status).toBe(404);
  });

  test("adds a Provider with a custom base URL and no Credential yet", async () => {
    const h = await start();
    const response = await h.send("POST", "/api/providers", { body: { id: "my-relay", baseUrl: " http://localhost:8080/v1/ " } });
    expect(response.status).toBe(201);
    expect(response.json()).toEqual({ provider: { id: "my-relay", baseUrl: "http://localhost:8080/v1", credential: null } });
    expect(await h.readConfig()).toEqual({ providers: [{ id: "my-relay", baseUrl: "http://localhost:8080/v1" }] });
  });

  test("keeps every change when several arrive at once", async () => {
    const h = await start();
    const ids = ["a", "b", "c", "d", "e"];
    const responses = await Promise.all(
      ids.map((id) => h.send("POST", "/api/providers", { body: { id, baseUrl: `https://${id}.example/v1`, credential: `key-${id}-1234` } })),
    );
    expect(responses.map((response) => response.status)).toEqual([201, 201, 201, 201, 201]);
    expect((await h.readConfig()).providers.map((provider: { id: string }) => provider.id).sort()).toEqual(ids);
    expect(Object.keys(await h.readCredentials()).sort()).toEqual(ids);
  });

  test("leaves files alone it cannot read rather than overwriting them", async () => {
    const h = await start();
    await writeFile(join(h.dirs.config, "config.json"), "{ not json");
    const response = await h.send("POST", "/api/providers", { body: openai });
    expect(response.status).toBe(409);
    expect(response.json().error).toContain("not valid JSON");
    expect(await readFile(join(h.dirs.config, "config.json"), "utf8")).toBe("{ not json");
  });
});

describe("test connection", () => {
  const modelsUrl = "GET https://api.openai.com/v1/models";
  const saved = { config: { providers: [openai] }, credentials: { openai: { apiKey } } };
  const testWith = (protocol: string, id = "openai") =>
    harness!.send("POST", `/api/providers/${id}/test-connection`, { body: { protocol } });

  test("reports success for an OpenAI Provider, calling it through the injected transport", async () => {
    const h = await start({ ...saved, routes: { [modelsUrl]: fixture("openai/models.json") } });
    const response = await testWith("openai-images");

    expect(response.status).toBe(200);
    expect(response.json().result).toBe("success");
    expect(response.json().message).toContain('Provider "openai"');
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]!.url).toBe("https://api.openai.com/v1/models");
    expect(h.requests[0]!.headers.get("authorization")).toBe(`Bearer ${apiKey}`);
  });

  test("reports failure in plain language without the Credential, even when the Provider echoes it", async () => {
    await start({ ...saved, routes: { [modelsUrl]: fixture("openai/invalid-api-key.json", 401) } });
    const response = await testWith("openai-images");

    expect(response.json().result).toBe("failure");
    expect(response.json().message).toContain('Provider "openai"');
    expect(response.json().message).toContain("Incorrect API key provided");
    expect(response.text).not.toContain(apiKey);
  });

  test("reports failure when the Provider cannot be reached", async () => {
    await start(saved);
    const response = await testWith("openai-images");
    expect(response.json().result).toBe("failure");
    expect(response.json().message).toContain("Could not reach Provider \"openai\"");
  });

  test("reports failure when no Credential is saved, without calling the Provider", async () => {
    const h = await start({ config: saved.config });
    const response = await testWith("openai-images");
    expect(response.json()).toEqual({ result: "failure", message: expect.stringContaining("no Credential saved") });
    expect(h.requests).toHaveLength(0);
  });

  test("says a Protocol without a connection test is not supported yet", async () => {
    const h = await start(saved);
    const response = await testWith("made-up");
    expect(response.status).toBe(200);
    expect(response.json()).toEqual({ result: "unsupported", message: expect.stringContaining("not supported yet") });
    expect(h.requests).toHaveLength(0);
  });

  test("rejects a missing Protocol and an unknown Provider", async () => {
    await start(saved);
    expect((await harness!.send("POST", "/api/providers/openai/test-connection", { body: {} })).status).toBe(400);
    expect((await testWith("openai-images", "missing")).status).toBe(404);
  });
});
