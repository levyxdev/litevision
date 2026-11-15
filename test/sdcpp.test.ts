import { afterEach, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startHarness, type Harness, type HarnessOptions, type Route } from "./harness.ts";
import { readHistory, recorded, textOf, tinyPng } from "./helpers.ts";

const root = "http://127.0.0.1:1234";
const statusUrl = `GET ${root}/sdcpp/v1/models/status`;
const loadUrl = `POST ${root}/sdcpp/v1/models/load`;
const imgGenUrl = `POST ${root}/sdcpp/v1/img_gen`;
const jobUrl = `GET ${root}/sdcpp/v1/jobs/job_01HTXYZABC`;

/** A local Provider with no Credential, its Runtime at sd-server's default address, and FLUX 3 Klein ready on it. */
function localSetup(routes: HarnessOptions["routes"] = {}): HarnessOptions {
  return {
    config: {
      providers: [{ id: "local", baseUrl: root }],
      models: [{ alias: "flux3", provider: "local", modelId: "flux3-klein", protocol: "sdcpp" }],
      defaultImageModel: "flux3",
    },
    routes: {
      [statusUrl]: recorded("sdcpp/status-ready.json"),
      [imgGenUrl]: recorded("sdcpp/submitted.json", 202),
      [jobUrl]: recorded("sdcpp/job-completed.json"),
      ...routes,
    },
    pollIntervalMs: 1,
  };
}

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

const generate = (args: Record<string, unknown> = {}) =>
  harness!.client.callTool({ name: "generate_image", arguments: { prompt: "a red fox", ...args } });

function ok(result: Awaited<ReturnType<typeof generate>>): Record<string, any> {
  expect(result.isError, textOf(result)).toBeFalsy();
  return result.structuredContent as Record<string, any>;
}

async function bodyOf(url: string): Promise<Record<string, any>> {
  const request = harness!.requests.find((candidate) => `${candidate.method} ${candidate.url}` === url);
  expect(request, `no request to ${url}`).toBeDefined();
  return (await request!.clone().json()) as Record<string, any>;
}

describe("generate_image with the sdcpp Protocol", () => {
  test("generates on a Runtime with the Model's recipe loaded, with no Credential, and saves the images", async () => {
    harness = await startHarness(localSetup());
    const output = ok(await generate({ n: 2 }));

    expect(await bodyOf(imgGenUrl)).toEqual({ prompt: "a red fox", batch_count: 2 });
    expect(harness.requests.some((request) => request.headers.has("authorization"))).toBe(false);
    expect(harness.requests.map((request) => `${request.method} ${request.url}`)).not.toContain(loadUrl);
    expect(output.files).toHaveLength(2);
    expect(new Uint8Array(await readFile(output.files[0]))).toEqual(new Uint8Array(tinyPng));
  });

  for (const [loaded, status] of [
    ["no Model", "sdcpp/status-empty.json"],
    ["another Model", "sdcpp/status-other-recipe.json"],
  ] as const) {
    test(`with ${loaded} loaded, loads the Model's recipe first, then generates`, async () => {
      harness = await startHarness(localSetup({ [statusUrl]: recorded(status), [loadUrl]: recorded("sdcpp/status-ready.json") }));
      ok(await generate());

      expect(harness.requests.map((request) => `${request.method} ${request.url}`)).toEqual([statusUrl, loadUrl, imgGenUrl, jobUrl]);
      expect(await bodyOf(loadUrl)).toEqual({ recipe: "flux3-klein" });
    });
  }

  test("edits: sends each reference as a data URL in ref_images, and provider_options untranslated", async () => {
    harness = await startHarness(localSetup());
    const reference = join(harness.cwd, "fox.png");
    await writeFile(reference, tinyPng);
    ok(await generate({ references: [reference, reference], provider_options: { width: 768, sample_params: { sample_steps: 8 } } }));

    const png = `data:image/png;base64,${tinyPng.toString("base64")}`;
    expect(await bodyOf(imgGenUrl)).toEqual({
      prompt: "a red fox",
      batch_count: 1,
      ref_images: [png, png],
      width: 768,
      sample_params: { sample_steps: 8 },
    });
  });
});

/** Answers with each route in turn, then keeps answering with the last. */
function inTurn(...routes: Route[]): Route {
  let calls = 0;
  return (request) => routes[Math.min(calls++, routes.length - 1)]!(request);
}

describe("an sdcpp Runtime that is not ready", () => {
  test("waits out a load under way, then generates without loading again", async () => {
    harness = await startHarness(
      localSetup({ [statusUrl]: inTurn(recorded("sdcpp/status-loading.json"), recorded("sdcpp/status-loading.json"), recorded("sdcpp/status-ready.json")) }),
    );
    ok(await generate());
    expect(harness.requests.map((request) => `${request.method} ${request.url}`)).toEqual([statusUrl, statusUrl, statusUrl, imgGenUrl, jobUrl]);
  });

  test("when the answer to a load is lost, goes by the Runtime's status", async () => {
    harness = await startHarness(
      localSetup({
        [statusUrl]: inTurn(recorded("sdcpp/status-empty.json"), recorded("sdcpp/status-loading.json"), recorded("sdcpp/status-ready.json")),
        [loadUrl]: () => {
          throw new Error("socket hang up");
        },
      }),
    );
    ok(await generate());
    expect(harness.requests.filter((request) => `${request.method} ${request.url}` === loadUrl)).toHaveLength(1);
  });

  for (const [what, routes] of [
    ["loading a Model when the Job is sent", { [imgGenUrl]: recorded("sdcpp/model-loading.json", 503) }],
    ["left with no Model when the Job is sent", { [imgGenUrl]: recorded("sdcpp/model-not-loaded.json", 503) }],
    [
      "busy with another Model's Jobs",
      { [statusUrl]: recorded("sdcpp/status-other-recipe.json"), [loadUrl]: recorded("sdcpp/model-busy.json", 409) },
    ],
  ] as const) {
    test(`is reported as not ready, not as a rejected option, when ${what}`, async () => {
      harness = await startHarness(localSetup(routes));
      const result = await generate({ provider_options: { width: 768 } });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('Provider "local" is not ready for the Job');
      expect(textOf(result)).not.toContain("rejected an option");
      expect((await readHistory(harness))[0]).toMatchObject({ outcome: "failed", error: { kind: "not_ready" } });
    });
  }

  for (const [what, fixture, status, said] of [
    ["fails to load", "sdcpp/load-failed.json", 422, "Model initialization failed"],
    ["the Runtime does not know", "sdcpp/unknown-recipe.json", 400, "unknown recipe"],
  ] as const) {
    test(`a recipe that ${what} is reported with what the Runtime said, and no Job is sent`, async () => {
      harness = await startHarness(localSetup({ [statusUrl]: recorded("sdcpp/status-empty.json"), [loadUrl]: recorded(fixture, status) }));
      const result = await generate();

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain(`Loading the Model's recipe "flux3-klein" failed: ${said}`);
      expect(harness.requests.map((request) => `${request.method} ${request.url}`)).not.toContain(imgGenUrl);
    });
  }
});

describe("sdcpp failures", () => {
  test("an option the Runtime names in a 400 is a rejected option", async () => {
    harness = await startHarness(localSetup({ [imgGenUrl]: recorded("sdcpp/invalid-parameter.json", 400) }));
    const result = await generate({ provider_options: { width: 99999 } });

    expect(textOf(result)).toContain("rejected an option");
    expect(textOf(result)).toContain("generation width and height must be between 1 and 8192");
    expect((await readHistory(harness))[0]).toMatchObject({ error: { kind: "rejected_option" } });
  });

  test("a 400 that names no option is reported as it came, not as a rejected option", async () => {
    harness = await startHarness(localSetup({ [imgGenUrl]: recorded("sdcpp/invalid-generation-parameters.json", 400) }));
    const result = await generate({ provider_options: { sample_params: { sample_steps: "many" } } });

    expect(textOf(result)).toContain("invalid generation parameters");
    expect(textOf(result)).not.toContain("rejected an option");
  });

  test("provider_options may set the image count field, as for any other Protocol", async () => {
    harness = await startHarness(localSetup());
    ok(await generate({ provider_options: { batch_count: 2 } }));
    expect(await bodyOf(imgGenUrl)).toMatchObject({ batch_count: 2 });
  });

  test("a failed Job reports what the Runtime said", async () => {
    harness = await startHarness(localSetup({ [jobUrl]: recorded("sdcpp/job-failed.json") }));
    const result = await generate();

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("generate_image returned empty results");
  });

  test("polls a queued Job until it completes", async () => {
    harness = await startHarness(localSetup({ [jobUrl]: inTurn(recorded("sdcpp/job-queued.json"), recorded("sdcpp/job-completed.json")) }));
    expect(ok(await generate()).files).toHaveLength(2);
  });
});

describe("Credentials with a local Provider", () => {
  test("a cloud Provider without a Credential still fails as before, beside a local one that needs none", async () => {
    const setup = localSetup();
    const config = setup.config as { providers: unknown[]; models: unknown[] };
    config.providers.push({ id: "openai", baseUrl: "https://api.openai.com/v1" });
    config.models.push({ alias: "gpt", provider: "openai", modelId: "gpt-image-2", protocol: "openai-images" });
    harness = await startHarness(setup);

    ok(await generate());
    const result = await generate({ model: "gpt" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Provider "openai" has no Credential saved.');
  });
});

describe("an sdcpp Job across a restart", () => {
  test("get_job picks the Job up from the Runtime after the MCP server restarts", async () => {
    let done = false;
    const job: Route = (request) => (done ? recorded("sdcpp/job-completed.json") : recorded("sdcpp/job-queued.json"))(request);
    // A short wait limit gives up on the Job once it is queued on the Runtime.
    harness = await startHarness({ ...localSetup({ [jobUrl]: job }), waitLimitMs: 20 });
    const { job_id } = ok(await generate());

    await harness.restart();
    done = true;
    const result = ok(await harness.client.callTool({ name: "get_job", arguments: { job_id } }));

    expect(result).toMatchObject({ status: "completed" });
    expect(result.files).toHaveLength(2);
    expect(harness.requests.filter((request) => `${request.method} ${request.url}` === imgGenUrl)).toHaveLength(1);
  });
});
