import { afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { startHarness, type Harness } from "./harness.ts";

/** Each piece of Agent guidance once, where the Agent needs it (#75). These assert key facts, never wording. */

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function tools() {
  harness = await startHarness();
  const { tools } = await harness.client.listTools();
  const tool = (name: string) => tools.find((candidate) => candidate.name === name)!;
  const parameter = (name: string, field: string) => (tool(name).inputSchema.properties as Record<string, { description: string }>)[field]!.description;
  return { tool, parameter };
}

const skillDir = join(import.meta.dir, "..", "skills", "litevision");

describe("the server instructions", () => {
  test("name what to pass on from a result", async () => {
    harness = await startHarness();
    const instructions = harness.client.getInstructions()!;
    for (const field of ["`mismatch`", "`shortfall`", "`overrides`"]) expect(instructions).toContain(field);
  });

  test("say when to call each tool whose trigger the Agent cannot wait to read", async () => {
    harness = await startHarness();
    const instructions = harness.client.getInstructions()!;
    for (const name of ["open_settings", "list_models", "generate_comparison", "rate_job", "pick_result"]) expect(instructions).toContain(`\`${name}\``);
  });
});

describe("the tool descriptions", () => {
  test("list_models defines each Option Status", async () => {
    const { tool } = await tools();
    for (const status of ["Honoured", "Ignored", "Rejected", "Accepted"]) expect(tool("list_models").description).toContain(status);
  });

  test("generate_image and generate_video each say once to start several Jobs with `wait: false`", async () => {
    const { tool, parameter } = await tools();
    for (const name of ["generate_image", "generate_video"]) {
      expect(tool(name).description!.match(/`wait: false`/g)).toHaveLength(1);
      expect(parameter(name, "wait")).not.toContain("several");
    }
  });

  test("generate_video's `name` example names an .mp4, and no image file", async () => {
    const { parameter } = await tools();
    expect(parameter("generate_video", "name")).toContain(".mp4");
    expect(parameter("generate_video", "name")).not.toContain(".png");
  });

  test("generate_comparison's `output_path` says how a relative path resolves", async () => {
    const { parameter } = await tools();
    expect(parameter("generate_comparison", "output_path")).toContain("Relative paths");
  });
});

describe("the litevision Skill", () => {
  test("keeps to prompts and results: no section on several Jobs, no Option Status paragraph, no source tags", async () => {
    const skill = await readFile(join(skillDir, "SKILL.md"), "utf8");
    expect(skill).not.toMatch(/^## .*several Jobs/im);
    expect(skill).not.toContain("Honoured");
    expect(skill).not.toMatch(/\[(OpenAI|Google|FLUX|Seedream)(, [A-Za-z]+)*\]/);
    expect(skill).toContain("## Sources");
  });

  test("reaches local-Model setup through one line, in a file of its own", async () => {
    const skill = await readFile(join(skillDir, "SKILL.md"), "utf8");
    expect(skill.match(/\(LOCAL\.md\)/g)).toHaveLength(1);
    expect(await readFile(join(skillDir, "LOCAL.md"), "utf8")).toContain("local install");
    expect(skill).not.toContain("local install");
  });
});
