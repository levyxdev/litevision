import { afterEach, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { startHarness, type Harness, type HarnessOptions } from "./harness.ts";
import { readHistory, recorded, textOf, tinyPng } from "./helpers.ts";

const generationsUrl = "POST https://api.openai.com/v1/images/generations";
const editsUrl = "POST https://api.openai.com/v1/images/edits";
const apiKey = "sk-test-0000secret0000";

interface GenerateResult {
  job_id: string;
  model: string;
  files: string[];
  aspect_ratio: string;
  size: string;
  requested_aspect_ratio: string;
  aspect_ratio_adjusted: boolean;
}

/** One OpenAI Provider with three `openai-images` Models; `gpt-image` is the default. */
function openaiSetup(routes: HarnessOptions["routes"] = { [generationsUrl]: recorded("openai/generations.json") }): HarnessOptions {
  return {
    config: {
      providers: [{ id: "openai", baseUrl: "https://api.openai.com/v1" }],
      models: [
        { alias: "gpt-image", provider: "openai", modelId: "gpt-image-1", protocol: "openai-images" },
        { alias: "dalle3", provider: "openai", modelId: "dall-e-3", protocol: "openai-images" },
        { alias: "dalle2", provider: "openai", modelId: "dall-e-2", protocol: "openai-images" },
      ],
      defaultImageModel: "gpt-image",
    },
    credentials: { openai: { apiKey } },
    routes,
    now: () => new Date(2026, 9, 30, 14, 5, 0),
  };
}

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function generate(args: Record<string, unknown>) {
  return harness!.client.callTool({ name: "generate_image", arguments: { prompt: "a red fox", ...args } });
}

function outputOf(result: Awaited<ReturnType<typeof generate>>): GenerateResult {
  expect(result.isError, textOf(result)).toBeFalsy();
  return result.structuredContent as unknown as GenerateResult;
}

describe("n", () => {
  test("n > 1 saves that many files and returns all their paths", async () => {
    harness = await startHarness(openaiSetup({ [generationsUrl]: recorded("openai/generations-2.json") }));
    const output = outputOf(await generate({ n: 2 }));

    expect(output.files).toHaveLength(2);
    expect(new Set(output.files).size).toBe(2);
    for (const file of output.files) expect(await readFile(file)).toEqual(tinyPng);
    expect(await harness.requests[0]!.json()).toMatchObject({ n: 2 });
  });
});

describe("aspect_ratio", () => {
  test("a supported aspect ratio is sent as its concrete size", async () => {
    harness = await startHarness(openaiSetup());
    const output = outputOf(await generate({ aspect_ratio: "2:3" }));

    expect(await harness.requests[0]!.json()).toMatchObject({ size: "1024x1536" });
    expect(output).toMatchObject({
      aspect_ratio: "2:3",
      size: "1024x1536",
      requested_aspect_ratio: "2:3",
      aspect_ratio_adjusted: false,
    });
  });

  test("an unsupported aspect ratio is mapped to the closest supported one and the actual size is reported", async () => {
    harness = await startHarness(openaiSetup());
    const result = await generate({ aspect_ratio: "16:9" });
    const output = outputOf(result);

    expect(await harness.requests[0]!.json()).toMatchObject({ size: "1536x1024" });
    expect(output).toMatchObject({
      aspect_ratio: "3:2",
      size: "1536x1024",
      requested_aspect_ratio: "16:9",
      aspect_ratio_adjusted: true,
    });
    expect(textOf(result)).toContain("1536x1024");
  });

  test("portrait ratios map to the closest portrait size", async () => {
    harness = await startHarness(openaiSetup());
    const output = outputOf(await generate({ aspect_ratio: "3:4" }));
    expect(output).toMatchObject({ aspect_ratio: "2:3", size: "1024x1536", aspect_ratio_adjusted: true });
  });

  test("the closest size depends on the Model", async () => {
    harness = await startHarness(openaiSetup());
    const output = outputOf(await generate({ model: "dalle3", aspect_ratio: "16:9" }));
    expect(await harness.requests[0]!.json()).toMatchObject({ model: "dall-e-3", size: "1792x1024" });
    expect(output).toMatchObject({ aspect_ratio: "16:9", size: "1792x1024", aspect_ratio_adjusted: false });
  });

  test("defaults to 1:1", async () => {
    harness = await startHarness(openaiSetup());
    const output = outputOf(await generate({}));
    expect(await harness.requests[0]!.json()).toMatchObject({ size: "1024x1024" });
    expect(output).toMatchObject({ aspect_ratio: "1:1", size: "1024x1024", aspect_ratio_adjusted: false });
  });

  test("an aspect ratio outside the supported set is rejected before any Provider request", async () => {
    harness = await startHarness(openaiSetup());
    const result = await generate({ aspect_ratio: "21:9" });
    expect(result.isError).toBe(true);
    expect(harness.requests).toHaveLength(0);
  });
});

const tinyJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);

describe("references", () => {
  test("with an OpenAI Model performs an edit, uploading each reference image as a file", async () => {
    harness = await startHarness(openaiSetup({ [editsUrl]: recorded("openai/edits.json") }));
    await writeFile(join(harness.cwd, "fox.png"), tinyPng);
    const elsewhere = join(harness.dirs.output, "..", "lamp.jpg");
    await writeFile(elsewhere, tinyJpeg);

    const result = await generate({ prompt: "put the fox under the lamp", references: ["fox.png", elsewhere], aspect_ratio: "3:2" });
    const output = outputOf(result);

    expect(output.files).toHaveLength(1);
    expect(await readFile(output.files[0]!)).toEqual(tinyPng);
    expect(harness.requests).toHaveLength(1);
    const [request] = harness.requests;
    expect(`${request!.method} ${request!.url}`).toBe(editsUrl);
    expect(request!.headers.get("authorization")).toBe(`Bearer ${apiKey}`);
    const form = await request!.formData();
    expect(form.get("model")).toBe("gpt-image-1");
    expect(form.get("prompt")).toBe("put the fox under the lamp");
    expect(form.get("n")).toBe("1");
    expect(form.get("size")).toBe("1536x1024");
    const images = form.getAll("image[]") as File[];
    expect(images.map((image) => [image.name, image.type])).toEqual([
      ["fox.png", "image/png"],
      ["lamp.jpg", "image/jpeg"],
    ]);
    expect(Buffer.from(await images[0]!.arrayBuffer())).toEqual(tinyPng);
    expect(Buffer.from(await images[1]!.arrayBuffer())).toEqual(tinyJpeg);
  });

  test("with a Model that cannot take reference images, errors with what the Model supports", async () => {
    harness = await startHarness(openaiSetup());
    await writeFile(join(harness.cwd, "fox.png"), tinyPng);
    const result = await generate({ model: "dalle3", references: ["fox.png"] });

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain('Model "dalle3" cannot take reference images');
    expect(text).toContain("1:1 (1024x1024), 16:9 (1792x1024), 9:16 (1024x1792)");
    expect(text).toContain("up to 1 image per Job");
    expect(text).toContain("no reference images");
    expect(harness.requests).toHaveLength(0);
  });

  test("more references than the Model takes errors with its limit", async () => {
    harness = await startHarness(openaiSetup());
    await writeFile(join(harness.cwd, "fox.png"), tinyPng);
    const result = await generate({ model: "dalle2", references: ["fox.png", "fox.png"] });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("cannot take 2 reference images");
    expect(textOf(result)).toContain("up to 1 reference image");
    expect(harness.requests).toHaveLength(0);
  });

  test("a reference that does not exist errors before any Provider request", async () => {
    harness = await startHarness(openaiSetup());
    const result = await generate({ references: ["missing.png"] });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Reference image "missing.png" does not exist');
    expect(textOf(result)).toContain(join(harness.cwd, "missing.png"));
    expect(harness.requests).toHaveLength(0);
  });

  test("a reference that is not an image errors before any Provider request", async () => {
    harness = await startHarness(openaiSetup());
    await writeFile(join(harness.cwd, "notes.txt"), "not an image");
    const result = await generate({ references: ["notes.txt"] });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Reference image "notes.txt" is not a PNG, JPEG, WebP or GIF image');
    expect(harness.requests).toHaveLength(0);
  });
});

describe("output_path", () => {
  test("saves into the requested folder, creating it", async () => {
    harness = await startHarness(openaiSetup({ [generationsUrl]: recorded("openai/generations-2.json") }));
    const folder = join(harness.cwd, "..", "project", "assets", "generated");
    const output = outputOf(await generate({ n: 2, output_path: folder }));

    expect(output.files).toHaveLength(2);
    for (const file of output.files) {
      expect(dirname(file)).toBe(folder);
      expect(await readFile(file)).toEqual(tinyPng);
    }
  });

  test("a relative output_path resolves against the server's working directory", async () => {
    harness = await startHarness(openaiSetup());
    const output = outputOf(await generate({ output_path: "assets" }));

    expect(dirname(output.files[0]!)).toBe(join(harness.cwd, "assets"));
    expect(await readFile(output.files[0]!)).toEqual(tinyPng);
  });

  test("omitted, files go to the default dated folder", async () => {
    harness = await startHarness(openaiSetup());
    const output = outputOf(await generate({}));
    expect(dirname(output.files[0]!)).toBe(join(harness.dirs.output, "2026-10-30"));
  });
});

describe("provider_options", () => {
  test("reach the Provider request unchanged", async () => {
    harness = await startHarness(openaiSetup());
    const providerOptions = {
      quality: "high",
      background: "transparent",
      moderation: "low",
      output_compression: 80,
      user: { nested: ["kept", 1, true, null] },
    };
    outputOf(await generate({ provider_options: providerOptions }));

    expect(await harness.requests[0]!.json()).toEqual({
      model: "gpt-image-1",
      prompt: "a red fox",
      n: 1,
      size: "1024x1024",
      ...providerOptions,
    });
  });

  test("reach an edit request as form fields", async () => {
    harness = await startHarness(openaiSetup({ [editsUrl]: recorded("openai/edits.json") }));
    await writeFile(join(harness.cwd, "fox.png"), tinyPng);
    outputOf(await generate({ references: ["fox.png"], provider_options: { input_fidelity: "high", output_compression: 80 } }));

    const form = await harness.requests[0]!.formData();
    expect(form.get("input_fidelity")).toBe("high");
    expect(form.get("output_compression")).toBe("80");
  });

  test("may not override what litevision sets itself", async () => {
    harness = await startHarness(openaiSetup());
    const result = await generate({ provider_options: { prompt: "something else", size: "auto" } });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("provider_options may not set `prompt`, `size`");
    expect(harness.requests).toHaveLength(0);
  });
});

describe("typed Provider errors", () => {
  const cases = [
    { fixture: "invalid-api-key.json", status: 401, kind: "auth", says: "rejected the Credential", detail: "Incorrect API key provided" },
    { fixture: "insufficient-quota.json", status: 429, kind: "balance", says: "insufficient balance or quota", detail: "exceeded your current quota" },
    { fixture: "billing-hard-limit-reached.json", status: 400, kind: "balance", says: "insufficient balance or quota", detail: "Billing hard limit" },
    { fixture: "rate-limit-exceeded.json", status: 429, kind: "rate_limit", says: "rate limiting", detail: "Rate limit reached" },
    { fixture: "moderation-blocked.json", status: 400, kind: "refusal", says: "refused the request on content grounds", detail: "rejected by the safety system" },
    { fixture: "content-policy-violation.json", status: 400, kind: "refusal", says: "refused the request on content grounds", detail: "not allowed by our safety system" },
    { fixture: "server-error.json", status: 500, kind: "other", says: "HTTP 500", detail: "The server had an error" },
  ];

  test.each(cases)("$fixture (HTTP $status) is reported as $kind, in plain language naming the Provider", async ({ fixture, status, kind, says, detail }) => {
    harness = await startHarness(openaiSetup({ [generationsUrl]: recorded(`openai/${fixture}`, status) }));
    const result = await generate({});

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain('Provider "openai"');
    expect(text).toContain(says);
    expect(text).toContain(detail);
    expect(JSON.stringify(result)).not.toContain(apiKey);

    const [record] = await readHistory(harness);
    expect(record).toMatchObject({ outcome: "failed", files: [], error: { kind } });
  });

  test("an edit request maps errors the same way", async () => {
    harness = await startHarness(openaiSetup({ [editsUrl]: recorded("openai/moderation-blocked.json", 400) }));
    await writeFile(join(harness.cwd, "fox.png"), tinyPng);
    const result = await generate({ references: ["fox.png"] });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("refused the request on content grounds");
    expect((await readHistory(harness))[0]).toMatchObject({ error: { kind: "refusal" } });
  });

  test("an auth error tells the Agent to call open_settings rather than ask for the key", async () => {
    harness = await startHarness(openaiSetup({ [generationsUrl]: recorded("openai/invalid-api-key.json", 401) }));
    const text = textOf(await generate({}));
    expect(text).toContain("open_settings");
    expect(text).toContain("[redacted]");
  });
});

describe("Job history", () => {
  test("records every generate_image parameter", async () => {
    harness = await startHarness(openaiSetup({ [editsUrl]: recorded("openai/edits.json") }));
    await writeFile(join(harness.cwd, "fox.png"), tinyPng);
    const output = outputOf(
      await generate({
        prompt: "the fox, at dusk",
        n: 1,
        aspect_ratio: "16:9",
        references: ["fox.png"],
        output_path: "assets",
        provider_options: { quality: "high" },
      }),
    );

    const [record] = await readHistory(harness);
    expect(record).toMatchObject({
      id: output.job_id,
      model: "gpt-image",
      prompt: "the fox, at dusk",
      parameters: {
        n: 1,
        aspectRatio: "16:9",
        size: { aspectRatio: "3:2", width: 1536, height: 1024 },
        references: [join(harness.cwd, "fox.png")],
        outputPath: join(harness.cwd, "assets"),
        providerOptions: { quality: "high" },
      },
      files: output.files,
      outcome: "completed",
    });
  });
});

describe("prompts", () => {
  const prompt = "  A sign that reads “Café 東京”\n\n--no blur, keep   spacing  ";

  test("are sent verbatim to the generations endpoint", async () => {
    harness = await startHarness(openaiSetup());
    outputOf(await generate({ prompt }));
    expect(((await harness.requests[0]!.json()) as { prompt: string }).prompt).toBe(prompt);
    expect((await readHistory(harness))[0]!.prompt).toBe(prompt);
  });

  test("are sent verbatim to the edits endpoint", async () => {
    harness = await startHarness(openaiSetup({ [editsUrl]: recorded("openai/edits.json") }));
    await writeFile(join(harness.cwd, "fox.png"), tinyPng);
    outputOf(await generate({ prompt, references: ["fox.png"] }));
    expect((await harness.requests[0]!.formData()).get("prompt")).toBe(prompt);
  });
});

describe("n above the Model's maximum", () => {
  test("errors with what the Model supports, before any Provider request", async () => {
    harness = await startHarness(openaiSetup());
    const result = await generate({ model: "dalle3", n: 2 });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Model "dalle3" cannot generate 2 images in one Job');
    expect(textOf(result)).toContain("up to 1 image per Job");
    expect(harness.requests).toHaveLength(0);
  });
});
