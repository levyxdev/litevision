import { afterEach, describe, expect, test } from "bun:test";
import { fixture } from "./recorded-http.ts";
import { startSettingsHarness, type SettingsHarness, type SettingsHarnessOptions } from "./settings-harness.ts";

let harness: SettingsHarness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function start(options: SettingsHarnessOptions = {}): Promise<SettingsHarness> {
  harness = await startSettingsHarness(options);
  return harness;
}

const apiKey = "sk-test-0000secret0000";
const openai = { id: "openai", baseUrl: "https://api.openai.com/v1" };
const relay = { id: "relay", baseUrl: "https://relay.example/v1" };
const withProviders = { config: { providers: [openai, relay] }, credentials: { openai: { apiKey } } };

const gptImage = { alias: "gpt-image", provider: "openai", modelId: "gpt-image-1", protocol: "openai-images" };

const firstChange = new Date("2026-10-30T10:00:00.000Z");
const secondChange = new Date("2026-10-30T11:30:00.000Z");

/** A clock the test moves forward by hand. */
function clock(start: Date) {
  let current = start;
  return { now: () => current, set: (next: Date) => (current = next) };
}

describe("Models", () => {
  test("adding a Model writes it to config.json and lists it", async () => {
    const h = await start({ ...withProviders, now: () => firstChange });
    const response = await h.send("POST", "/api/models", { body: { ...gptImage, notes: "photoreal, good at text" } });

    // Model Notes written with the Model are the User's, with no previous version to undo to.
    const notes = { notes: "photoreal, good at text", notesHistory: { changedBy: "User", changedAt: firstChange.toISOString() } };
    expect(response.status).toBe(201);
    expect(response.json()).toEqual({ model: { ...gptImage, ...notes, default: false } });
    expect((await h.readConfig()).models).toEqual([{ ...gptImage, ...notes }]);

    expect((await h.send("GET", "/api/models")).json()).toEqual({
      models: [{ ...gptImage, ...notes, default: false }],
      defaultImageModel: null,
    });
  });

  test("the same upstream model on two Providers is two Models with different Aliases; a duplicate Alias is rejected", async () => {
    const h = await start(withProviders);
    expect((await h.send("POST", "/api/models", { body: gptImage })).status).toBe(201);
    const onRelay = { ...gptImage, alias: "gpt-image-cheap", provider: "relay" };
    expect((await h.send("POST", "/api/models", { body: onRelay })).status).toBe(201);

    const duplicate = await h.send("POST", "/api/models", { body: { ...gptImage, provider: "relay", modelId: "other" } });
    expect(duplicate.status).toBe(409);
    expect(duplicate.json().error).toContain('"gpt-image"');

    expect((await h.readConfig()).models).toEqual([gptImage, onRelay]);
  });

  test("rejects a Model on an unknown Provider, with an unsupported Protocol, a bad Alias or over-long Model Notes", async () => {
    const h = await start(withProviders);
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ...gptImage, provider: "missing" }, 'no Provider named "missing"'],
      [{ ...gptImage, protocol: "carrier-pigeon" }, "openai-images"],
      [{ ...gptImage, alias: "has space" }, "An Alias is"],
      [{ ...gptImage, modelId: "  " }, "model id"],
      [{ ...gptImage, notes: "x".repeat(301) }, "at most 300 characters"],
    ];
    for (const [body, message] of cases) {
      const response = await h.send("POST", "/api/models", { body });
      expect(response.status).toBe(400);
      expect(response.json().error).toContain(message);
    }
    expect((await h.readConfig()).models).toBeUndefined();
  });

  test("sets and clears the default image Model", async () => {
    const h = await start({ config: { providers: [openai], models: [gptImage] } });

    const set = await h.send("PUT", "/api/default-image-model", { body: { alias: "gpt-image" } });
    expect(set.status).toBe(200);
    expect(set.json()).toEqual({ defaultImageModel: "gpt-image" });
    expect((await h.readConfig()).defaultImageModel).toBe("gpt-image");
    expect((await h.send("GET", "/api/models")).json()).toEqual({
      models: [{ ...gptImage, notes: "", default: true }],
      defaultImageModel: "gpt-image",
    });

    expect((await h.send("PUT", "/api/default-image-model", { body: { alias: "missing" } })).status).toBe(404);
    expect((await h.readConfig()).defaultImageModel).toBe("gpt-image");

    expect((await h.send("PUT", "/api/default-image-model", { body: { alias: null } })).json()).toEqual({ defaultImageModel: null });
    expect((await h.readConfig()).defaultImageModel).toBeUndefined();
  });

  test("edits a Model, keeping the default image Model pointed at it when its Alias changes", async () => {
    const other = { ...gptImage, alias: "dalle", modelId: "dall-e-3" };
    const h = await start({
      config: { providers: [openai, relay], models: [{ ...gptImage, extra: "kept" }, other], defaultImageModel: "gpt-image" },
      now: () => firstChange,
    });

    const response = await h.send("PATCH", "/api/models/gpt-image", {
      body: { alias: "gpt-image-cheap", provider: "relay", modelId: "gpt-image-1-mini", notes: "cheap drafts" },
    });
    expect(response.status).toBe(200);
    const edited = { alias: "gpt-image-cheap", provider: "relay", modelId: "gpt-image-1-mini", protocol: "openai-images" };
    const notesHistory = { changedBy: "User", changedAt: firstChange.toISOString(), previous: "" };
    expect(response.json()).toEqual({ model: { ...edited, notes: "cheap drafts", notesHistory, default: true } });
    expect(await h.readConfig()).toEqual({
      providers: [openai, relay],
      models: [{ ...edited, notes: "cheap drafts", notesHistory, extra: "kept" }, other],
      defaultImageModel: "gpt-image-cheap",
    });

    // Empty Model Notes are removed rather than stored.
    await h.send("PATCH", "/api/models/gpt-image-cheap", { body: { notes: "  " } });
    expect((await h.readConfig()).models[0]).toEqual({ ...edited, notesHistory: { ...notesHistory, previous: "cheap drafts" }, extra: "kept" });

    expect((await h.send("PATCH", "/api/models/gpt-image-cheap", { body: { alias: "dalle" } })).status).toBe(409);
    expect((await h.send("PATCH", "/api/models/gpt-image-cheap", { body: { provider: "missing" } })).status).toBe(400);
    expect((await h.send("PATCH", "/api/models/missing", { body: { notes: "x" } })).status).toBe(404);
  });

  test("removes a Model, and with it the default when it was the default", async () => {
    const other = { ...gptImage, alias: "dalle", modelId: "dall-e-3" };
    const h = await start({ config: { providers: [openai], models: [gptImage, other], defaultImageModel: "gpt-image" } });

    expect((await h.send("DELETE", "/api/models/dalle")).status).toBe(204);
    expect(await h.readConfig()).toEqual({ providers: [openai], models: [gptImage], defaultImageModel: "gpt-image" });

    expect((await h.send("DELETE", "/api/models/gpt-image")).status).toBe(204);
    expect(await h.readConfig()).toEqual({ providers: [openai], models: [] });
    expect((await h.send("DELETE", "/api/models/gpt-image")).status).toBe(404);

    // The Provider is free to go once no Model uses it.
    expect((await h.send("DELETE", "/api/providers/openai")).status).toBe(204);
  });

  test("lists the Protocols a Model can use", async () => {
    const h = await start();
    expect((await h.send("GET", "/api/protocols")).json()).toEqual({ protocols: ["openai-images", "gemini"] });
  });
});

describe("fetching a Provider's model list", () => {
  const modelsUrl = "GET https://api.openai.com/v1/models";
  const fetchList = (protocol: string, id = "openai") =>
    harness!.send("POST", `/api/providers/${id}/model-ids`, { body: { protocol } });

  test("returns the model ids an OpenAI Provider reports, through the injected transport", async () => {
    const h = await start({ ...withProviders, routes: { [modelsUrl]: fixture("openai/models.json") } });
    const response = await fetchList("openai-images");

    expect(response.status).toBe(200);
    expect(response.json()).toEqual({ result: "success", modelIds: ["dall-e-3", "gpt-4o", "gpt-image-1"] });
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]!.headers.get("authorization")).toBe(`Bearer ${apiKey}`);
  });

  test("reports failure without the Credential, so the User can type a model id instead", async () => {
    await start({ ...withProviders, routes: { [modelsUrl]: fixture("openai/invalid-api-key.json", 401) } });
    const response = await fetchList("openai-images");

    expect(response.json()).toEqual({ result: "failure", message: expect.stringContaining('Provider "openai"') });
    expect(response.json().message).toContain("type the model id");
    expect(response.text).not.toContain(apiKey);
  });

  test("reports failure when no Credential is saved, without calling the Provider", async () => {
    const h = await start(withProviders);
    const response = await fetchList("openai-images", "relay");
    expect(response.json()).toEqual({ result: "failure", message: expect.stringContaining("no Credential saved") });
    expect(h.requests).toHaveLength(0);
  });

  test("says a Protocol without a model list is not supported, so the User types the model id", async () => {
    const h = await start(withProviders);
    const response = await fetchList("made-up");
    expect(response.json()).toEqual({ result: "unsupported", message: expect.stringContaining("type the model id") });
    expect(h.requests).toHaveLength(0);
    expect((await fetchList("openai-images", "missing")).status).toBe(404);
  });
});

describe("Model Notes", () => {
  const withNotes = (notes: string) => ({ config: { providers: [openai, relay], models: [{ ...gptImage, notes }] } });
  const editNotes = (notes: string, alias = "gpt-image") => harness!.send("PATCH", `/api/models/${alias}`, { body: { notes } });
  const undo = (alias = "gpt-image") => harness!.send("POST", `/api/models/${alias}/notes/undo`);
  const listed = async () => (await harness!.send("GET", "/api/models")).json().models[0];

  test("editing Model Notes replaces them, keeps the previous version and records the User and when", async () => {
    const h = await start({ ...withNotes("photoreal"), now: () => firstChange });
    const response = await editNotes("photoreal, cheap");

    expect(response.status).toBe(200);
    const notesHistory = { changedBy: "User", changedAt: firstChange.toISOString(), previous: "photoreal" };
    expect(response.json().model).toMatchObject({ notes: "photoreal, cheap", notesHistory });
    expect((await h.readConfig()).models[0]).toEqual({ ...gptImage, notes: "photoreal, cheap", notesHistory });
    expect(await listed()).toMatchObject({ notes: "photoreal, cheap", notesHistory });
  });

  test("saving a Model without changing its Model Notes records no change", async () => {
    const time = clock(firstChange);
    const h = await start({ ...withNotes("photoreal"), now: time.now });
    await editNotes("cartoonish");
    time.set(secondChange);

    // The page sends every field on save, Model Notes included.
    await h.send("PATCH", "/api/models/gpt-image", { body: { ...gptImage, provider: "relay", notes: "cartoonish" } });
    expect((await h.readConfig()).models[0].notesHistory).toEqual({
      changedBy: "User",
      changedAt: firstChange.toISOString(),
      previous: "photoreal",
    });
  });

  test("undo swaps the current and previous Model Notes as a User change, and a second undo redoes", async () => {
    const time = clock(firstChange);
    const h = await start({ ...withNotes("photoreal"), now: time.now });
    await editNotes("cartoonish");

    time.set(secondChange);
    const undone = await undo();
    expect(undone.status).toBe(200);
    const afterUndo = { changedBy: "User", changedAt: secondChange.toISOString(), previous: "cartoonish" };
    expect(undone.json().model).toMatchObject({ notes: "photoreal", notesHistory: afterUndo });
    expect((await h.readConfig()).models[0]).toEqual({ ...gptImage, notes: "photoreal", notesHistory: afterUndo });

    const redone = await undo();
    expect(redone.json().model).toMatchObject({
      notes: "cartoonish",
      notesHistory: { changedBy: "User", changedAt: secondChange.toISOString(), previous: "photoreal" },
    });
  });

  test("undo restores empty Model Notes when there were none before", async () => {
    const h = await start({ config: { providers: [openai], models: [gptImage] } });
    await editNotes("photoreal");
    await undo();
    expect((await h.readConfig()).models[0].notes).toBeUndefined();
    expect(await listed()).toMatchObject({ notes: "", notesHistory: { previous: "photoreal" } });
  });

  test("undo is refused when there is no previous version, and for an unknown Model", async () => {
    const h = await start(withNotes("photoreal"));
    const response = await undo();
    expect(response.status).toBe(409);
    expect(response.json().error).toContain("no previous");
    expect((await h.readConfig()).models[0]).toEqual({ ...gptImage, notes: "photoreal" });

    expect((await undo("missing")).status).toBe(404);
  });

  test("over-long Model Notes are rejected on edit", async () => {
    const h = await start(withNotes("photoreal"));
    const response = await editNotes("x".repeat(301));
    expect(response.status).toBe(400);
    expect(response.json().error).toContain("at most 300 characters");
    expect((await h.readConfig()).models[0]).toEqual({ ...gptImage, notes: "photoreal" });
  });
});

describe("Models area", () => {
  test("the settings page has a Models area", async () => {
    const h = await start();
    const page = await h.send("GET", "/");
    expect(page.text).toContain('id="model-list"');
    expect(page.text).toContain('id="add-model"');
    expect(page.text).toContain("/notes/undo");
  });
});
