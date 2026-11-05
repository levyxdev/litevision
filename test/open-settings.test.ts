import { afterEach, describe, expect, test } from "bun:test";
import { startHarness, type Harness, type HarnessOptions } from "./harness.ts";

const apiKey = "sk-test-0000secret0000";
const configured: HarnessOptions = {
  config: { providers: [{ id: "openai", baseUrl: "https://api.openai.com/v1" }] },
  credentials: { openai: { apiKey } },
};

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

const openSettings = () => harness!.client.callTool({ name: "open_settings", arguments: {} });

function textOf(result: Awaited<ReturnType<typeof openSettings>>): string {
  return (result.content as Array<{ text?: string }>).map((part) => part.text ?? "").join("\n");
}

const getSettingsPrompt = () => harness!.client.getPrompt({ name: "settings" });

function promptText(result: Awaited<ReturnType<typeof getSettingsPrompt>>): string {
  return result.messages.map((message) => (message.content as { text?: string }).text ?? "").join("\n");
}

describe("open_settings", () => {
  test("is one of the tools", async () => {
    harness = await startHarness();
    const { tools } = await harness.client.listTools();
    expect(tools.map((tool) => tool.name)).toContain("open_settings");
  });

  test("opens the settings page in the User's browser without exposing the token or any Credential", async () => {
    harness = await startHarness(configured);
    const result = await openSettings();

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("Opened the litevision settings page");
    expect(harness.openedUrls).toHaveLength(1);
    const url = new URL(harness.openedUrls[0]!);
    expect(url.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const token = url.searchParams.get("token")!;
    expect(token.length).toBeGreaterThanOrEqual(32);
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain(token);
    expect(serialised).not.toContain(url.port);
    expect(serialised).not.toContain(apiKey);

    const page = await fetch(url);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Providers");
  });

  test("reuses the running settings page instead of starting another", async () => {
    harness = await startHarness();
    await openSettings();
    await openSettings();
    expect(harness.openedUrls).toHaveLength(2);
    expect(harness.openedUrls[1]).toBe(harness.openedUrls[0]!);
  });

  test("starts a fresh settings page once the previous one shut down when idle", async () => {
    harness = await startHarness({ settingsIdleMs: 50 });
    await openSettings();
    await new Promise((resolve) => setTimeout(resolve, 150));
    await expect(fetch(harness.openedUrls[0]!)).rejects.toThrow();

    await openSettings();
    expect(harness.openedUrls).toHaveLength(2);
    expect(harness.openedUrls[1]).not.toBe(harness.openedUrls[0]!);
    expect((await fetch(harness.openedUrls[1]!)).status).toBe(200);
  });

  test("when no browser can be opened, tells the Agent to have the User run `litevision settings`", async () => {
    harness = await startHarness({
      openBrowser: async () => {
        throw new Error("spawn xdg-open ENOENT");
      },
    });
    const result = await openSettings();
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("litevision settings");
    expect(textOf(result)).not.toContain("token");
  });

  test("shuts the settings page down along with the MCP server", async () => {
    harness = await startHarness();
    await openSettings();
    const [url] = harness.openedUrls;
    await harness.close();
    harness = undefined;
    await expect(fetch(url!)).rejects.toThrow();
  });
});

describe("settings prompt", () => {
  test("is offered to the User, and listing it opens nothing", async () => {
    harness = await startHarness();
    const { prompts } = await harness.client.listPrompts();
    const settings = prompts.find((prompt) => prompt.name === "settings");
    expect(settings?.description).toContain("settings page");
    expect(harness.openedUrls).toHaveLength(0);
  });

  test("opens the settings page itself, and tells the Agent it is already open without exposing the token", async () => {
    harness = await startHarness();
    const result = await getSettingsPrompt();

    expect(harness.openedUrls).toHaveLength(1);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.role).toBe("user");
    expect(promptText(result)).toContain("already opened");
    expect(promptText(result)).toContain("Do not call `open_settings`");
    const url = new URL(harness.openedUrls[0]!);
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain(url.searchParams.get("token")!);
    expect(serialised).not.toContain(url.port);
  });

  test("shares the running settings page with `open_settings`", async () => {
    harness = await startHarness();
    await getSettingsPrompt();
    await openSettings();
    expect(harness.openedUrls).toHaveLength(2);
    expect(harness.openedUrls[1]).toBe(harness.openedUrls[0]!);
  });

  test("when no browser can be opened, asks the Agent to have the User run `litevision settings`", async () => {
    const attempted: string[] = [];
    harness = await startHarness({
      openBrowser: async (url) => {
        attempted.push(url);
        throw new Error("spawn xdg-open ENOENT");
      },
    });
    const result = await getSettingsPrompt();
    expect(promptText(result)).toContain("litevision settings");
    expect(JSON.stringify(result)).not.toContain(new URL(attempted[0]!).searchParams.get("token")!);
  });
});
