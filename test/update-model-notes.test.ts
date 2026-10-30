import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { startHarness, type Harness } from "./harness.ts";
import { textOf } from "./helpers.ts";

const openai = { id: "openai", baseUrl: "https://api.openai.com/v1" };
const gptImage = { alias: "gpt-image", provider: "openai", modelId: "gpt-image-1", protocol: "openai-images" };
const dalle = { alias: "dalle", provider: "openai", modelId: "dall-e-3", protocol: "openai-images" };

const firstChange = new Date("2026-10-30T10:00:00.000Z");
const secondChange = new Date("2026-10-30T11:30:00.000Z");

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

/** A clock the test moves forward by hand. */
function clock(start: Date) {
  let current = start;
  return { now: () => current, set: (next: Date) => (current = next) };
}

async function start(models: unknown[], now = () => firstChange): Promise<Harness> {
  harness = await startHarness({ config: { providers: [openai], models }, now });
  return harness;
}

const updateNotes = (args: Record<string, unknown>) => harness!.client.callTool({ name: "update_model_notes", arguments: args });
const readConfig = async () => JSON.parse(await readFile(join(harness!.dirs.config, "config.json"), "utf8"));
const listedNotes = async (alias: string) => {
  const result = await harness!.client.callTool({ name: "list_models", arguments: {} });
  const { models } = result.structuredContent as { models: Array<{ alias: string; notes: string }> };
  return models.find((model) => model.alias === alias)?.notes;
};

describe("update_model_notes", () => {
  test("replaces the Model Notes whole, keeps the previous version and records the Agent and when", async () => {
    await start([{ ...gptImage, notes: "photoreal" }, dalle]);
    const result = await updateNotes({ model: "gpt-image", notes: "photoreal, cheap, bad at Chinese text" });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      model: "gpt-image",
      notes: "photoreal, cheap, bad at Chinese text",
      previous_notes: "photoreal",
      changed: true,
      changed_by: "Agent",
      changed_at: firstChange.toISOString(),
    });
    expect(textOf(result)).toContain("photoreal, cheap, bad at Chinese text");

    const [stored, untouched] = (await readConfig()).models;
    expect(stored).toEqual({
      ...gptImage,
      notes: "photoreal, cheap, bad at Chinese text",
      notesHistory: { changedBy: "Agent", changedAt: firstChange.toISOString(), previous: "photoreal" },
    });
    expect(untouched).toEqual(dalle);
    expect(await listedNotes("gpt-image")).toBe("photoreal, cheap, bad at Chinese text");
  });

  test("keeps only one previous version", async () => {
    const time = clock(firstChange);
    await start([{ ...gptImage, notes: "first" }], time.now);
    await updateNotes({ model: "gpt-image", notes: "second" });
    time.set(secondChange);
    await updateNotes({ model: "gpt-image", notes: "third" });

    expect((await readConfig()).models[0]).toEqual({
      ...gptImage,
      notes: "third",
      notesHistory: { changedBy: "Agent", changedAt: secondChange.toISOString(), previous: "second" },
    });
  });

  test("sets Model Notes on a Model that had none, and can clear them", async () => {
    await start([gptImage]);
    const set = await updateNotes({ model: "gpt-image", notes: "  sharp line art  " });
    expect(set.structuredContent).toMatchObject({ notes: "sharp line art", previous_notes: "" });
    expect((await readConfig()).models[0].notes).toBe("sharp line art");

    const cleared = await updateNotes({ model: "gpt-image", notes: "" });
    expect(cleared.isError).toBeFalsy();
    expect((await readConfig()).models[0]).toEqual({
      ...gptImage,
      notesHistory: { changedBy: "Agent", changedAt: firstChange.toISOString(), previous: "sharp line art" },
    });
    expect(await listedNotes("gpt-image")).toBe("");
  });

  test("rejects Model Notes over the length cap and changes nothing", async () => {
    await start([{ ...gptImage, notes: "photoreal" }]);
    const result = await updateNotes({ model: "gpt-image", notes: "x".repeat(301) });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("at most 300 characters");
    expect((await readConfig()).models[0]).toEqual({ ...gptImage, notes: "photoreal" });

    expect((await updateNotes({ model: "gpt-image", notes: "x".repeat(300) })).isError).toBeFalsy();
  });

  test("an unknown Alias is an error that lists the known ones", async () => {
    await start([gptImage, dalle]);
    const result = await updateNotes({ model: "missing", notes: "x" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('"missing"');
    expect(textOf(result)).toContain("gpt-image, dalle");
  });

  test("with no Model configured, tells the Agent to call open_settings", async () => {
    await start([]);
    const result = await updateNotes({ model: "gpt-image", notes: "x" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Call `open_settings`");
  });

  test("the same text again records no change", async () => {
    const time = clock(firstChange);
    await start([{ ...gptImage, notes: "old" }], time.now);
    await updateNotes({ model: "gpt-image", notes: "new" });
    time.set(secondChange);
    const again = await updateNotes({ model: "gpt-image", notes: "new" });

    expect(again.structuredContent).toMatchObject({ changed: false, changed_at: firstChange.toISOString() });
    expect((await readConfig()).models[0].notesHistory).toEqual({
      changedBy: "Agent",
      changedAt: firstChange.toISOString(),
      previous: "old",
    });
  });

  test("the User can undo the Agent's change in the settings page", async () => {
    const time = clock(firstChange);
    await start([{ ...gptImage, notes: "photoreal" }], time.now);
    await updateNotes({ model: "gpt-image", notes: "cartoonish" });

    await harness!.client.callTool({ name: "open_settings", arguments: {} });
    const page = new URL(harness!.openedUrls[0]!);
    time.set(secondChange);
    const response = await fetch(new URL("/api/models/gpt-image/notes/undo", page.origin), {
      method: "POST",
      headers: { origin: page.origin, "x-litevision-token": page.searchParams.get("token")! },
    });
    expect(response.status).toBe(200);

    expect(await listedNotes("gpt-image")).toBe("photoreal");
    expect((await readConfig()).models[0].notesHistory).toEqual({
      changedBy: "User",
      changedAt: secondChange.toISOString(),
      previous: "cartoonish",
    });
  });

  test("the server instructions require showing old and new Model Notes and getting the User's agreement first", async () => {
    harness = await startHarness();
    const instructions = harness.client.getInstructions() ?? "";
    expect(instructions).toContain("update_model_notes");
    expect(instructions).toMatch(/old and new Model Notes/);
    expect(instructions).toMatch(/agree/);
  });
});
