#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { defaultDirs } from "./dirs.ts";
import { fetchTransport } from "./http.ts";
import { createServer } from "./server.ts";

export const usage =
  "Usage: litevision [command]\n\nWith no command, runs the MCP server over stdio.\n\nCommands:\n  settings  Open the local settings page";

export type Command = { kind: "serve" } | { kind: "exit"; code: number; output: string };

export function parseCommand(argv: string[]): Command {
  const [command] = argv;
  if (command === undefined) return { kind: "serve" };
  if (command === "--help" || command === "-h") return { kind: "exit", code: 0, output: usage };
  return { kind: "exit", code: 1, output: `Unknown command: ${command}\n\n${usage}` };
}

const isEntry = process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
  const command = parseCommand(process.argv.slice(2));
  if (command.kind === "serve") {
    // stdout carries the MCP protocol, so nothing else may be printed to it.
    await createServer({ dirs: defaultDirs(), http: fetchTransport }).connect(new StdioServerTransport());
  } else {
    (command.code === 0 ? console.log : console.error)(command.output);
    process.exitCode = command.code;
  }
}
