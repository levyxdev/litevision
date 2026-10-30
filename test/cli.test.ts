import { describe, expect, test } from "bun:test";
import { run, usage } from "../src/cli.ts";

describe("run", () => {
  test("prints usage with no command", () => {
    expect(run([])).toEqual({ code: 0, output: usage });
  });

  test("rejects an unknown command", () => {
    const result = run(["nope"]);
    expect(result.code).toBe(1);
    expect(result.output).toContain("Unknown command: nope");
  });
});
