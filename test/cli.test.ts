import { describe, expect, test } from "bun:test";
import { parseCommand, usage } from "../src/cli.ts";

describe("parseCommand", () => {
  test("starts the MCP server with no command", () => {
    expect(parseCommand([])).toEqual({ kind: "serve" });
  });

  test("starts the settings page with `settings`", () => {
    expect(parseCommand(["settings"])).toEqual({ kind: "settings" });
  });

  test("prints usage for --help", () => {
    expect(parseCommand(["--help"])).toEqual({ kind: "exit", code: 0, output: usage });
  });

  test("rejects an unknown command", () => {
    const result = parseCommand(["nope"]);
    expect(result).toMatchObject({ kind: "exit", code: 1 });
    expect(result.kind === "exit" && result.output).toContain("Unknown command: nope");
  });
});
