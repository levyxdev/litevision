import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startHarness, type Harness, type HarnessOptions, type Route } from "./harness.ts";
import { readHistory, readHistoryLines } from "./helpers.ts";

const generationsUrl = "POST https://api.openai.com/v1/images/generations";
const apiKey = "sk-test-0000secret0000";
const tinyPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function recorded(name: string, status = 200): Route {
  return async () =>
    new Response(await readFile(join(import.meta.dir, "fixtures", name)), {
      status,
      headers: { "content-type": "application/json" },
    });
}

/** One OpenAI Provider with one `openai-images` Model, aliased `gpt-image` and set as the default. */
function openaiSetup(routes: HarnessOptions["routes"] = { [generationsUrl]: recorded("openai/generations.json") }): HarnessOptions {
  return {
    config: {
      providers: [{ id: "openai", baseUrl: "https://api.openai.com/v1" }],
      models: [{ alias: "gpt-image", provider: "openai", modelId: "gpt-image-1", protocol: "openai-images" }],
      defaultImageModel: "gpt-image",
    },
    credentials: { openai: { apiKey } },
    routes,
    now: () => new Date(2026, 9, 30, 14, 5, 0),
  };
}

interface GenerateResult {
  job_id: string;
  model: string;
  files: string[];
}

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe("MCP server", () => {
  test("lists generate_image and ships server instructions", async () => {
    harness = await startHarness();
    const { tools } = await harness.client.listTools();
    expect(tools.map((tool) => tool.name)).toContain("generate_image");
    expect(harness.client.getInstructions()).toContain("open_settings");
  });

  test("the server instructions point at the litevision Skill and how to install it (ADR 0007)", async () => {
    harness = await startHarness();
    const instructions = harness.client.getInstructions()!;
    expect(instructions).toContain("use the litevision Skill");
    expect(instructions).toContain("npx skills add levyxdev/litevision");
  });

  test("the litevision Skill ships in this repository under its own name", async () => {
    const skill = await readFile(join(import.meta.dir, "..", "skills", "litevision", "SKILL.md"), "utf8");
    expect(skill).toMatch(/^---\nname: litevision\n/);
  });
});

function textOf(result: Awaited<ReturnType<Harness["client"]["callTool"]>>): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  return content.map((part) => part.text ?? "").join("\n");
}

describe("generate_image", () => {
  test("with nothing configured, tells the Agent to call open_settings instead of asking for a Credential", async () => {
    harness = await startHarness();
    const result = await harness.client.callTool({ name: "generate_image", arguments: { prompt: "a red fox" } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Call `open_settings`");
    expect(textOf(result)).toContain("Never ask the User");
    expect(harness.requests).toHaveLength(0);
  });

  test("generates an image with an openai-images Model and returns only its file path", async () => {
    harness = await startHarness(openaiSetup());
    const result = await harness.client.callTool({
      name: "generate_image",
      arguments: { prompt: "a red fox", model: "gpt-image" },
    });

    expect(result.isError).toBeFalsy();
    const output = result.structuredContent as unknown as GenerateResult;
    expect(output.model).toBe("gpt-image");
    expect(output.job_id).toMatch(/\S+/);
    expect(output.files).toHaveLength(1);
    const [file] = output.files;
    expect(file!.startsWith(join(harness.dirs.output, "2026-10-30"))).toBe(true);
    expect(await readFile(file!)).toEqual(tinyPng);
    expect(textOf(result)).toContain(file!);
    expect(textOf(result)).not.toContain(tinyPng.toString("base64"));

    const [request] = harness.requests;
    expect(request!.headers.get("authorization")).toBe(`Bearer ${apiKey}`);
    // No size of litevision's own: OpenAI's default applies (ADR 0010).
    expect(await request!.json()).toEqual({ model: "gpt-image-1", prompt: "a red fox", n: 1 });
  });

  test("uses the default image Model when model is omitted", async () => {
    harness = await startHarness(openaiSetup());
    const result = await harness.client.callTool({ name: "generate_image", arguments: { prompt: "a red fox" } });
    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as unknown as GenerateResult).model).toBe("gpt-image");
  });

  test("rejects an unknown Alias and lists the known ones", async () => {
    harness = await startHarness(openaiSetup());
    const result = await harness.client.callTool({
      name: "generate_image",
      arguments: { prompt: "a red fox", model: "midjourney" },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Unknown Model Alias "midjourney"');
    expect(textOf(result)).toContain("gpt-image");
    expect(harness.requests).toHaveLength(0);
  });

  test("appends each Job to the Job history", async () => {
    let clock = new Date(2026, 9, 30, 14, 5, 0).getTime();
    const slowGeneration: Route = async (request) => {
      clock += 2500;
      return recorded("openai/generations.json")(request);
    };
    harness = await startHarness({ ...openaiSetup({ [generationsUrl]: slowGeneration }), now: () => new Date(clock) });

    const result = await harness.client.callTool({ name: "generate_image", arguments: { prompt: "a red fox" } });
    const output = result.structuredContent as unknown as GenerateResult;

    const job = {
      type: "job",
      id: output.job_id,
      createdAt: new Date(2026, 9, 30, 14, 5, 0).toISOString(),
      model: "gpt-image",
      provider: "openai",
      protocol: "openai-images",
      modelId: "gpt-image-1",
      modality: "image",
      prompt: "a red fox",
      parameters: {
        n: 1,
        requested: { shape: null, resolution: null, size: null, format: null },
        references: [],
        providerOptions: {},
      },
    };
    // Append-only: one record when the Job starts, one when it ends.
    expect(await readHistoryLines(harness)).toEqual([
      { ...job, durationMs: 0, files: [], outcome: "running" },
      { ...job, durationMs: 2500, files: output.files, outcome: "completed", observed: [{ width: 1, height: 1, format: "png" }] },
    ]);
  });

  test("never reveals the Credential, even when the Provider echoes it in an error", async () => {
    harness = await startHarness(openaiSetup({ [generationsUrl]: recorded("openai/invalid-api-key.json", 401) }));
    const result = await harness.client.callTool({ name: "generate_image", arguments: { prompt: "a red fox" } });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Provider "openai"');
    expect(textOf(result)).toContain("Incorrect API key provided");
    expect(JSON.stringify(result)).not.toContain(apiKey);

    const history = await readHistory(harness);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ outcome: "failed", files: [], error: { kind: "auth" } });
    expect(JSON.stringify(history)).not.toContain(apiKey);
  });

  test("downloads results the Provider returns as links", async () => {
    const imageUrl = "https://oaidalleapiprodscus.blob.core.windows.net/private/img-fox.png?se=2026-10-30T15%3A05%3A00Z&sig=abc";
    harness = await startHarness(
      openaiSetup({
        [generationsUrl]: recorded("openai/generations-url.json"),
        [`GET ${imageUrl}`]: () => new Response(tinyPng, { headers: { "content-type": "image/png" } }),
      }),
    );
    const result = await harness.client.callTool({ name: "generate_image", arguments: { prompt: "a red fox" } });

    expect(result.isError).toBeFalsy();
    const [file] = (result.structuredContent as unknown as GenerateResult).files;
    expect(file!.endsWith(".png")).toBe(true);
    expect(await readFile(file!)).toEqual(tinyPng);
  });

  test("with no Credential saved for the Provider, tells the Agent to call open_settings", async () => {
    harness = await startHarness({ ...openaiSetup(), credentials: {} });
    const result = await harness.client.callTool({ name: "generate_image", arguments: { prompt: "a red fox" } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Provider "openai" has no Credential saved');
    expect(textOf(result)).toContain("Call `open_settings`");
    expect(harness.requests).toHaveLength(0);
  });

  test("with no default image Model, asks for an Alias and lists the known ones", async () => {
    const setup = openaiSetup();
    const { defaultImageModel: _, ...config } = setup.config as Record<string, unknown>;
    harness = await startHarness({ ...setup, config });
    const result = await harness.client.callTool({ name: "generate_image", arguments: { prompt: "a red fox" } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("No default image Model is set");
    expect(textOf(result)).toContain("gpt-image");
  });
});

describe("saved file names", () => {
  const generate = async (args: Record<string, unknown> = {}) => {
    const result = await harness!.client.callTool({ name: "generate_image", arguments: { prompt: "an ID photo", ...args } });
    expect(result.isError, textOf(result)).toBeFalsy();
    return (result.structuredContent as unknown as GenerateResult).files;
  };
  const folder = () => join(harness!.dirs.output, "2026-10-30");

  test("with `name`, the file is named after it, and a second Job with the same name gets -2", async () => {
    harness = await startHarness(openaiSetup());
    expect(await generate({ name: "张三" })).toEqual([join(folder(), "张三.png")]);
    expect(await generate({ name: "张三" })).toEqual([join(folder(), "张三-2.png")]);
    expect(await readFile(join(folder(), "张三-2.png"))).toEqual(tinyPng);
  });

  test("a Job with several results numbers them from 1, and the next Job with that name takes the next free numbers", async () => {
    harness = await startHarness(openaiSetup({ [generationsUrl]: recorded("openai/generations-2.json") }));
    expect(await generate({ name: "张三", n: 2 })).toEqual([join(folder(), "张三-1.png"), join(folder(), "张三-2.png")]);
    expect(await generate({ name: "张三", n: 2 })).toEqual([join(folder(), "张三-3.png"), join(folder(), "张三-4.png")]);
  });

  test("a Job that asked for several results numbers them even when only one came back", async () => {
    harness = await startHarness(openaiSetup());
    expect(await generate({ name: "张三", n: 2 })).toEqual([join(folder(), "张三-1.png")]);
  });

  test("without `name`, files are named after the time the Job started, with -2 on a clash", async () => {
    harness = await startHarness(openaiSetup());
    expect(await generate()).toEqual([join(folder(), "140500.png")]);
    expect(await generate()).toEqual([join(folder(), "140500-2.png")]);
  });

  test("a name taken with another extension, or in another case, still counts as taken", async () => {
    harness = await startHarness(openaiSetup());
    await mkdir(folder(), { recursive: true });
    await writeFile(join(folder(), "Fox.jpg"), "");
    expect(await generate({ name: "fox" })).toEqual([join(folder(), "fox-2.png")]);
  });

  test("only the characters a path cannot hold are removed from `name`", async () => {
    harness = await startHarness(openaiSetup());
    expect(await generate({ name: " a/b\\c:d*e?f\"g<h>i|j 李.v2 " })).toEqual([join(folder(), "abcdefghij 李.v2.png")]);
  });

  test("a `name` with nothing a file name can hold is refused before the Job starts", async () => {
    harness = await startHarness(openaiSetup());
    const result = await harness.client.callTool({ name: "generate_image", arguments: { prompt: "a fox", name: "/:?" } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("`name`");
    expect(harness.requests).toHaveLength(0);
  });

  test("`name` is recorded in the Job, and get_job finds the files after a restart", async () => {
    harness = await startHarness(openaiSetup());
    const result = await harness.client.callTool({ name: "generate_image", arguments: { prompt: "an ID photo", name: "张三" } });
    const { job_id, files } = result.structuredContent as unknown as GenerateResult;
    expect((await readHistory(harness))[0]).toMatchObject({ id: job_id, parameters: { name: "张三" }, files });

    await harness.restart();
    const job = await harness.client.callTool({ name: "get_job", arguments: { job_id } });
    expect((job.structuredContent as unknown as GenerateResult).files).toEqual([join(folder(), "张三.png")]);
  });

  test("is described on generate_image", async () => {
    harness = await startHarness();
    const { tools } = await harness.client.listTools();
    const schema = tools.find((tool) => tool.name === "generate_image")!.inputSchema.properties as Record<string, { description: string }>;
    expect(schema.name!.description).toContain("any language");
  });
});
