import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { version } from "../package.json";
import { catalog } from "../src/local/catalog.ts";
import { installFakeRuntime } from "./harness.ts";

let root: string;
let bundle: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "litevision-stdio-"));
  bundle = join(root, "cli.js");
  // Same bundle `npm run build` ships, run on Node the way `npx -y litevision` would.
  execFileSync(process.execPath, ["build", join(import.meta.dir, "../src/cli.ts"), "--target", "node", "--outfile", bundle]);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

test("the built CLI serves MCP over stdio on Node", async () => {
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({ command: "node", args: [bundle], env: { PATH: process.env.PATH ?? "", HOME: root } }),
  );
  try {
    expect(client.getServerVersion()).toMatchObject({ name: "litevision", version });

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toContain("generate_image");

    const result = await client.callTool({ name: "generate_image", arguments: { prompt: "a red fox" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("open_settings");
  } finally {
    await client.close();
  }
});

test("the Runtime the server started stops when its client goes away", async () => {
  const home = join(root, "runtime-user");
  const dirs = { home: join(home, ".litevision"), output: join(home, "litevision", "outputs") };
  await mkdir(dirs.home, { recursive: true });
  const config = {
    providers: [{ id: "local", baseUrl: "http://127.0.0.1:1234" }],
    models: [{ alias: "flux3", provider: "local", modelId: "flux3-klein", protocol: "sdcpp" }],
    defaultImageModel: "flux3",
  };
  await writeFile(join(dirs.home, "config.json"), JSON.stringify(config));
  await installFakeRuntime(home, dirs, catalog);

  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(new StdioClientTransport({ command: "node", args: [bundle], env: { PATH: process.env.PATH ?? "", HOME: home } }));
  const result = await client.callTool({ name: "generate_image", arguments: { prompt: "a red fox" } });
  expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
  const { runtimePid: pid } = JSON.parse(await readFile(join(dirs.home, "runtime.json"), "utf8")) as { runtimePid: number };
  expect(() => process.kill(pid, 0)).not.toThrow();

  await client.close();
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && (() => { try { process.kill(pid, 0); return true; } catch { return false; } })()) await Bun.sleep(20);
  expect(() => process.kill(pid, 0)).toThrow();
});
