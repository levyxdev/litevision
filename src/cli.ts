#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { defaultDirs } from "./dirs.ts";
import { fetchTransport } from "./http.ts";
import { createServer } from "./server.ts";
import { openInBrowser } from "./settings/browser.ts";
import { defaultSettingsIdleMs, startSettingsServer } from "./settings/server.ts";

export const usage =
  "Usage: litevision [command]\n\nWith no command, runs the MCP server over stdio.\n\nCommands:\n  settings  Open the local settings page";

export type Command = { kind: "serve" } | { kind: "settings" } | { kind: "exit"; code: number; output: string };

export function parseCommand(argv: string[]): Command {
  const [command] = argv;
  if (command === undefined) return { kind: "serve" };
  if (command === "settings") return { kind: "settings" };
  if (command === "--help" || command === "-h") return { kind: "exit", code: 0, output: usage };
  return { kind: "exit", code: 1, output: `Unknown command: ${command}\n\n${usage}` };
}

/** Runs the settings page until it shuts down when idle. The terminal is the User's own, so it may show the URL. */
async function runSettings(): Promise<void> {
  const settings = await startSettingsServer({ dirs: defaultDirs(), http: fetchTransport, idleMs: defaultSettingsIdleMs });
  console.log(`litevision settings page: ${settings.url}`);
  console.log(`It shuts down after ${defaultSettingsIdleMs / 60_000} minutes of inactivity. Press Ctrl+C to stop it sooner.`);
  await openInBrowser(settings.url).catch(() => {
    console.log("Could not open your browser. Open the address above yourself.");
  });
  await settings.closed;
  console.log("Settings page closed.");
}

const isEntry = process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
  const command = parseCommand(process.argv.slice(2));
  if (command.kind === "serve") {
    // stdout carries the MCP protocol, so nothing else may be printed to it.
    await createServer({ dirs: defaultDirs(), http: fetchTransport }).connect(new StdioServerTransport());
  } else if (command.kind === "settings") {
    await runSettings();
  } else {
    (command.code === 0 ? console.log : console.error)(command.output);
    process.exitCode = command.code;
  }
}
