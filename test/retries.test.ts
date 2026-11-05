import { afterEach, describe, expect, test } from "bun:test";
import { startHarness, type Harness, type HarnessOptions, type Route } from "./harness.ts";
import { readHistoryLines, recorded, textOf } from "./helpers.ts";

const generationsUrl = "POST https://api.openai.com/v1/images/generations";
const apiKey = "sk-test-0000secret0000";

/** One OpenAI Provider with one synchronous `openai-images` Model, the default. */
function openaiSetup(route: Route): HarnessOptions {
  return {
    config: {
      providers: [{ id: "openai", baseUrl: "https://api.openai.com/v1" }],
      models: [{ alias: "gpt-image", provider: "openai", modelId: "gpt-image-1", protocol: "openai-images" }],
      defaultImageModel: "gpt-image",
    },
    credentials: { openai: { apiKey } },
    routes: { [generationsUrl]: route },
  };
}

/** Answers with each route in turn, then keeps answering with the last one. */
function inTurn(...routes: Route[]): Route {
  let next = 0;
  return (request) => routes[Math.min(next++, routes.length - 1)]!(request);
}

const status = (code: number): Route => () => Response.json({ error: { message: `HTTP ${code} from the gateway` } }, { status: code });
const succeeds = recorded("openai/generations.json");

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

const generate = () => harness!.client.callTool({ name: "generate_image", arguments: { prompt: "a red fox" } });
const sent = () => harness!.requests.filter((request) => `${request.method} ${request.url}` === generationsUrl);

describe("gateway errors", () => {
  test.each([502, 503, 504])("HTTP %i is retried and the Job completes, with only its final outcome in the Job history", async (code) => {
    harness = await startHarness(openaiSetup(inTurn(status(code), succeeds)));
    const result = await generate();

    expect(result.isError, textOf(result)).toBeFalsy();
    expect(sent()).toHaveLength(2);
    const lines = await readHistoryLines(harness);
    expect(lines.map((line) => line.outcome)).toEqual(["running", "completed"]);
  });
});

/** A `fetch` failure as Node reports it: "fetch failed", with the reason and its code in the cause. */
function networkFailure(code: string, message: string, syscall?: string): Route {
  return () => {
    throw new TypeError("fetch failed", { cause: Object.assign(new Error(message), { code, ...(syscall === undefined ? {} : { syscall }) }) });
  };
}

const refused = networkFailure("ECONNREFUSED", "connect ECONNREFUSED 162.159.140.245:443", "connect");
const timedOut = networkFailure("UND_ERR_HEADERS_TIMEOUT", "Headers Timeout Error");

describe("failures the Provider never processed are retried", () => {
  test("a connection that failed before the request was sent is retried and the Job completes", async () => {
    harness = await startHarness(openaiSetup(inTurn(refused, succeeds)));
    const result = await generate();

    expect(result.isError, textOf(result)).toBeFalsy();
    expect(sent()).toHaveLength(2);
    expect((await readHistoryLines(harness)).map((line) => line.outcome)).toEqual(["running", "completed"]);
  });

  test("is retried at most twice, then the Job fails with what went wrong", async () => {
    harness = await startHarness(openaiSetup(refused));
    const result = await generate();

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Could not reach Provider "openai" (tried 3 times)');
    expect(textOf(result)).toContain("ECONNREFUSED");
    expect(sent()).toHaveLength(3);
    expect((await readHistoryLines(harness)).map((line) => line.outcome)).toEqual(["running", "failed"]);
  });

  test("a gateway error that persists is retried at most twice", async () => {
    harness = await startHarness(openaiSetup(status(503)));
    const result = await generate();

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("HTTP 503");
    expect(sent()).toHaveLength(3);
    expect((await readHistoryLines(harness)).map((line) => line.outcome)).toEqual(["running", "failed"]);
  });

  test("a connect that timed out never sent the request, so it is retried", async () => {
    const connectTimedOut = networkFailure("ETIMEDOUT", "connect ETIMEDOUT 162.159.140.245:443", "connect");
    harness = await startHarness(openaiSetup(inTurn(connectTimedOut, succeeds)));

    expect((await generate()).isError).toBeFalsy();
    expect(sent()).toHaveLength(2);
  });
});

describe("failures the Provider may have processed are not retried", () => {
  test("a request that timed out after it was sent is not retried, and its error says the Provider may have charged for it", async () => {
    harness = await startHarness(openaiSetup(inTurn(timedOut, succeeds)));
    const result = await generate();

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Provider "openai" did not answer in time');
    expect(textOf(result)).toContain("charged");
    expect(sent()).toHaveLength(1);
  });

  test("HTTP 500 is not retried: the Provider may have started on the request", async () => {
    harness = await startHarness(openaiSetup(inTurn(status(500), succeeds)));
    expect((await generate()).isError).toBe(true);
    expect(sent()).toHaveLength(1);
  });

  test("rate limiting is not retried", async () => {
    harness = await startHarness(openaiSetup(inTurn(recorded("openai/rate-limit-exceeded.json", 429), succeeds)));
    const result = await generate();

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("rate limiting");
    expect(sent()).toHaveLength(1);
  });
});
