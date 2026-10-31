import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { version } from "../package.json";

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
