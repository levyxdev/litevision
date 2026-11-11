import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture } from "./recorded-http.ts";
import { renderPage } from "../src/settings/page.ts";
import { suggestedAlias } from "../src/settings/suggested-alias.ts";
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

const gptImage = { alias: "gpt-image", provider: "openai", modelId: "gpt-image-1", protocol: "openai-images", modality: "image" };

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
      defaultVideoModel: null,
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
      defaultVideoModel: null,
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
    const edited = { alias: "gpt-image-cheap", provider: "relay", modelId: "gpt-image-1-mini", protocol: "openai-images", modality: "image" };
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
    expect((await h.send("GET", "/api/protocols")).json()).toEqual({ protocols: expect.arrayContaining(["openai-images", "apimart", "gemini", "venice"]) });
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

describe("Standing Options (ADR 0010)", () => {
  const withModel = { config: { providers: [openai], models: [gptImage] }, credentials: { openai: { apiKey } } };
  const edit = (standingOptions: unknown) => harness!.send("PATCH", "/api/models/gpt-image", { body: { standingOptions } });

  test("saving Standing Options stores them on the Model and shows them again; clearing them removes them", async () => {
    const h = await start(withModel);
    const saved = await edit({ quality: "high", background: "opaque" });
    expect(saved.status).toBe(200);
    expect(saved.json().model.standingOptions).toEqual({ quality: "high", background: "opaque" });
    expect((await h.readConfig()).models[0].standingOptions).toEqual({ quality: "high", background: "opaque" });
    expect((await h.send("GET", "/api/models")).json().models[0].standingOptions).toEqual({ quality: "high", background: "opaque" });

    const cleared = await edit(null);
    expect(cleared.status).toBe(200);
    expect(cleared.json().model).not.toHaveProperty("standingOptions");
    expect((await h.readConfig()).models[0]).toEqual(gptImage);
  });

  test("an empty object clears them too", async () => {
    const h = await start(withModel);
    await edit({ quality: "high" });
    expect((await edit({})).status).toBe(200);
    expect((await h.readConfig()).models[0]).toEqual(gptImage);
  });

  test("rejects Standing Options that are not a JSON object, and says why", async () => {
    const h = await start(withModel);
    for (const value of [["quality", "high"], "quality=high", 3]) {
      const response = await edit(value);
      expect(response.status).toBe(400);
      expect(response.json().error).toContain("Standing Options must be a JSON object");
    }
    expect((await h.readConfig()).models[0]).toEqual(gptImage);
  });

  test("rejects Standing Options that set a field the Model's Protocol fills itself, naming it", async () => {
    const h = await start(withModel);
    const response = await edit({ prompt: "always a fox", quality: "high" });
    expect(response.status).toBe(400);
    expect(response.json().error).toContain("`prompt`");
    expect(response.json().error).toContain("litevision fills");
    expect((await h.readConfig()).models[0]).toEqual(gptImage);
  });

  test("rejects a nested field the Protocol fills itself, such as Gemini's response format type", async () => {
    const google = { id: "google", baseUrl: "https://generativelanguage.googleapis.com/v1beta" };
    const banana = { alias: "banana", provider: "google", modelId: "gemini-3-pro-image", protocol: "gemini", modality: "image" };
    const h = await start({ config: { providers: [google], models: [banana] }, credentials: { google: { apiKey } } });
    const send = (standingOptions: unknown) => h.send("PATCH", "/api/models/banana", { body: { standingOptions } });

    const typed = await send({ response_format: { type: "text", image_size: "2K" } });
    expect(typed.status).toBe(400);
    expect(typed.json().error).toContain("`response_format.type`");
    expect((await send({ response_format: { image_size: "2K" } })).status).toBe(200);
  });

  test("can be set when adding a Model", async () => {
    const h = await start(withModel);
    const response = await h.send("POST", "/api/models", { body: { ...gptImage, alias: "hq", standingOptions: { quality: "high" } } });
    expect(response.status).toBe(201);
    expect((await h.readConfig()).models[1].standingOptions).toEqual({ quality: "high" });
  });

  test("the Model form edits them", async () => {
    const h = await start();
    expect((await h.send("GET", "/")).text).toContain("Standing Options");
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

describe("Option Statuses (ADR 0011)", () => {
  /** A completed Job on `gpt-image` that asked for 1024x1536 and got it. */
  const matched = {
    type: "job",
    id: "fox",
    createdAt: "2026-11-04T09:00:00.000Z",
    model: "gpt-image",
    provider: "openai",
    protocol: "openai-images",
    modelId: "gpt-image-1",
    prompt: "a red fox",
    parameters: { n: 1, requested: { shape: "1024x1536", resolution: null }, references: [], providerOptions: { size: "1024x1536", quality: "high" } },
    durationMs: 1_000,
    files: ["/out/fox.png"],
    observed: [{ width: 1024, height: 1536 }],
    outcome: "completed",
  };

  async function withHistory(): Promise<SettingsHarness> {
    const h = await start({ ...withProviders, config: { ...withProviders.config, models: [gptImage], defaultImageModel: "gpt-image" } });
    await mkdir(h.dirs.data, { recursive: true });
    const rating = { type: "rating", jobId: "fox", verdict: "bad", reason: "the fur looks fake", ratedAt: "2026-11-04T09:05:00.000Z" };
    await writeFile(join(h.dirs.data, "jobs.jsonl"), `${JSON.stringify(matched)}\n${JSON.stringify(rating)}\n`);
    return h;
  }

  test("each Model's Option Statuses are listed by status, with their dates and Job ids, and a Rating changes none", async () => {
    const h = await withHistory();
    const response = await h.send("GET", "/api/option-statuses");
    expect(response.status).toBe(200);
    expect(response.json()).toEqual({
      models: {
        "gpt-image": {
          honoured: [{ options: { size: "1024x1536" }, status: "honoured", jobId: "fox", date: "2026-11-04T09:00:00.000Z" }],
          ignored: [],
          rejected: [],
          accepted: [{ options: { quality: "high" }, status: "accepted", jobId: "fox", date: "2026-11-04T09:00:00.000Z" }],
        },
      },
    });
  });

  test("the latest evidence is the Job that finished last, not the one that started last", async () => {
    const h = await start({ ...withProviders, config: { ...withProviders.config, models: [gptImage] } });
    // `slow` started first but was rejected after `fox` had matched, so its rejection is the latest evidence.
    const sent = { ...matched.parameters, providerOptions: { size: "1024x1536" } };
    const slow = { ...matched, id: "slow", createdAt: "2026-11-04T08:00:00.000Z", parameters: sent, files: [], observed: undefined };
    const lines = [
      { ...slow, outcome: "running" },
      { ...matched, parameters: sent },
      { ...slow, outcome: "failed", error: { kind: "rejected_option", message: "x The Provider said: HTTP 400: bad size", options: ["size"] } },
    ];
    await mkdir(h.dirs.data, { recursive: true });
    await writeFile(join(h.dirs.data, "jobs.jsonl"), lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
    const statuses = (await h.send("GET", "/api/option-statuses")).json().models["gpt-image"];
    expect(statuses.honoured).toEqual([]);
    expect(statuses.rejected).toEqual([
      { options: { size: "1024x1536" }, status: "rejected", jobId: "slow", date: "2026-11-04T08:00:00.000Z", reason: "HTTP 400: bad size" },
    ]);
  });

  test("are read-only: the page shows them, and nothing in the settings API changes them", async () => {
    const h = await withHistory();
    expect((await h.send("GET", "/")).text).toContain("Option Statuses");
    for (const method of ["POST", "PATCH", "PUT", "DELETE"]) expect((await h.send(method, "/api/option-statuses", { body: {} })).status).toBe(404);
  });
});

describe("the Alias a new Model is prefilled with", () => {
  test("starts with the Provider id, so the same model on two Providers gets two Aliases", () => {
    expect(suggestedAlias("together", "google/flash-image-3.1")).toBe("together-google-flash-image-3.1");
    expect(suggestedAlias("gemini", "gemini-3.1-flash-image")).toBe("gemini-3.1-flash-image");
    expect(suggestedAlias("openrouter", "google/gemini-3.1-flash-image")).toBe("openrouter-google-gemini-3.1-flash-image");
  });

  test("is a valid Alias, and empty until there is a model id", () => {
    expect(suggestedAlias("together", "")).toBe("");
    expect(suggestedAlias("", "gpt-image-1")).toBe("gpt-image-1");
    expect(suggestedAlias("relay", " /black-forest-labs/FLUX.1 [pro] ")).toBe("relay-black-forest-labs-FLUX.1-pro");
    expect(suggestedAlias("relay", "x".repeat(80))).toBe("relay-" + "x".repeat(58));
  });

  test("is what the settings page fills in", () => {
    const script = /<script nonce="n">([\s\S]*)<\/script>/.exec(renderPage("n"))![1]!;
    // The page's script must still parse with the suggestion embedded in it.
    expect(() => new Function(script)).not.toThrow();
    expect(script).toContain("suggestedAlias(provider.value, modelId.value)");
  });
});
