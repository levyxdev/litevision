#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const usage = "Usage: litevision <command>\n\nCommands:\n  settings  Open the local settings page";

export function run(argv: string[]): { code: number; output: string } {
  const [command] = argv;
  if (command === undefined || command === "--help" || command === "-h") {
    return { code: 0, output: usage };
  }
  return { code: 1, output: `Unknown command: ${command}\n\n${usage}` };
}

const isEntry = process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
  const { code, output } = run(process.argv.slice(2));
  (code === 0 ? console.log : console.error)(output);
  process.exitCode = code;
}
