#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createInterface } from "node:readline/promises";
import { defaultDirs } from "./dirs.ts";
import { fetchTransport } from "./http.ts";
import { catalog } from "./local/catalog.ts";
import { detectHardware } from "./local/hardware.ts";
import { runLocal, type LocalCommand } from "./local/install.ts";
import { createServer } from "./server.ts";
import { openInBrowser } from "./settings/browser.ts";
import { defaultSettingsIdleMs, startSettingsServer } from "./settings/server.ts";

export const usage = `Usage: litevision [command]

With no command, runs the MCP server over stdio.

Commands:
  settings                    Open the local settings page
  local install <model>       Download a local Model and the Runtime, and configure them
    --quant <quantisation>    Instead of the one chosen for this machine's memory
    --force                   Even if it will likely not fit this machine
    --yes                     Without asking, once the User has agreed to the download
  local remove <model>        Delete a local Model's weights and remove it from the configuration
    --yes                     Without asking`;

export type Command = { kind: "serve" } | { kind: "settings" } | LocalCommand | { kind: "exit"; code: number; output: string };

const usageError = (problem: string): Command => ({ kind: "exit", code: 1, output: `${problem}\n\n${usage}` });

function parseLocal([action, model, ...flags]: string[]): Command {
  if (action !== "install" && action !== "remove") return usageError(`Unknown local command: ${action ?? "(none)"}`);
  if (model === undefined || model.startsWith("-")) return usageError(`Name the Model to ${action}.`);
  const allowed = action === "install" ? ["--yes", "--force", "--quant"] : ["--yes"];
  let quant: string | undefined;
  for (let index = 0; index < flags.length; index++) {
    const flag = flags[index]!;
    if (!allowed.includes(flag)) return usageError(`Unknown option for local ${action}: ${flag}`);
    if (flag === "--quant") {
      quant = flags[++index];
      if (quant === undefined) return usageError("--quant needs a quantisation, such as Q4_K.");
    }
  }
  const yes = flags.includes("--yes");
  return action === "install" ? { kind: "local", action, model, quant, yes, force: flags.includes("--force") } : { kind: "local", action, model, yes };
}

export function parseCommand(argv: string[]): Command {
  const [command, ...rest] = argv;
  if (command === undefined) return { kind: "serve" };
  if (command === "settings") return { kind: "settings" };
  if (command === "local") return parseLocal(rest);
  if (command === "--help" || command === "-h") return { kind: "exit", code: 0, output: usage };
  return usageError(`Unknown command: ${command}`);
}

/** Asks in the User's terminal; when no terminal is attached, as when an Agent runs the command, no one can answer. */
async function confirmInTerminal(question: string): Promise<boolean> {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await terminal.question(`${question} [y/N] `)).trim());
  } finally {
    terminal.close();
  }
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
  } else if (command.kind === "local") {
    process.exitCode = await runLocal(command, {
      dirs: defaultDirs(),
      http: fetchTransport,
      catalog,
      hardware: detectHardware,
      confirm: process.stdin.isTTY ? confirmInTerminal : undefined,
      print: (line) => console.log(line),
    });
  } else {
    (command.code === 0 ? console.log : console.error)(command.output);
    process.exitCode = command.code;
  }
}
