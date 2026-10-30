import { afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { startHarness, type Harness, type HarnessOptions, type Route } from "./harness.ts";

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
    expect(await request!.json()).toEqual({ model: "gpt-image-1", prompt: "a red fox", n: 1, size: "1024x1024" });
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

    const history = await readHistory(harness);
    expect(history).toEqual([
      {
        type: "job",
        id: output.job_id,
        createdAt: new Date(2026, 9, 30, 14, 5, 0).toISOString(),
        model: "gpt-image",
        provider: "openai",
        protocol: "openai-images",
        modelId: "gpt-image-1",
        prompt: "a red fox",
        parameters: {
          n: 1,
          aspectRatio: "1:1",
          size: { aspectRatio: "1:1", width: 1024, height: 1024 },
          references: [],
          providerOptions: {},
        },
        durationMs: 2500,
        files: output.files,
        outcome: "completed",
      },
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

async function readHistory(harness: Harness): Promise<unknown[]> {
  const text = await readFile(join(harness.dirs.data, "jobs.jsonl"), "utf8");
  return text.trim().split("\n").map((line) => JSON.parse(line));
}
