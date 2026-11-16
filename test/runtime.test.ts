import { afterEach, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startHarness, type Harness, type HarnessOptions } from "./harness.ts";
import { textOf, tinyPng } from "./helpers.ts";

/** Two local Models on the Runtime litevision installed; the local Provider has no address, as litevision starts it. */
const config = {
  providers: [{ id: "local" }],
  models: [
    { alias: "flux3", provider: "local", modelId: "flux3-klein", protocol: "sdcpp" },
    { alias: "zimage", provider: "local", modelId: "z-image-turbo", protocol: "sdcpp" },
  ],
  defaultImageModel: "flux3",
};

const harnesses: Harness[] = [];
afterEach(async () => {
  // A session that shares a home is closed before the one that owns it, which deletes the folders.
  for (const harness of harnesses.reverse()) await harness.close();
  harnesses.length = 0;
});

async function session(options: HarnessOptions = {}): Promise<Harness> {
  const harness = await startHarness({ config, runtime: true, pollIntervalMs: 5, ...options });
  harnesses.push(harness);
  return harness;
}

function ok(result: Awaited<ReturnType<Harness["client"]["callTool"]>>): Record<string, any> {
  expect(result.isError, textOf(result)).toBeFalsy();
  return result.structuredContent as Record<string, any>;
}

const generate = (harness: Harness, args: Record<string, unknown> = {}) =>
  harness.client.callTool({ name: "generate_image", arguments: { prompt: "a red fox", ...args } });

const lock = async (harness: Harness) => JSON.parse(await readFile(join(harness.dirs.home, "runtime.json"), "utf8")) as { runtimePid: number; port: number };

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until(condition: () => Promise<boolean> | boolean, what: string, ms = 5000): Promise<void> {
  for (const start = Date.now(); !(await condition()); ) {
    if (Date.now() - start > ms) throw new Error(`Timed out waiting until ${what}`);
    await Bun.sleep(10);
  }
}

describe("the shared Runtime", () => {
  test("a local Job with no Runtime running starts one, and a second session on the machine reuses it", async () => {
    const first = await session();
    const output = ok(await generate(first));
    expect(new Uint8Array(await readFile(output.files[0]))).toEqual(new Uint8Array(tinyPng));

    const second = await session({ shareHomeWith: first });
    ok(await generate(second));

    const events = await first.runtime!.events();
    expect(events.filter((event) => event.event === "start")).toHaveLength(1);
    expect(events.filter((event) => event.event === "generate")).toHaveLength(2);
    expect(alive((await lock(first)).runtimePid)).toBe(true);
  });

  test("with no Runtime installed, a local Job does not start, and the Agent is told how to install one", async () => {
    const first = await session({ runtime: false });
    const result = await generate(first);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("npx -y litevision local install");
    expect(textOf(result)).not.toContain("Job ");
  });

    test("keeps a finished task a day, so get_job after a restart still finds it", async () => {
    const first = await session();
    ok(await generate(first));
    const [start] = (await first.runtime!.events()).filter((event) => event.event === "start");
    expect(start!.args!.join(" ")).toContain("--completed-ttl-seconds 86400");
    expect(start!.args!.join(" ")).toContain(`--model-dir ${join(first.dirs.home, "models")}`);
  });

  test("the session that started the Runtime stops it when it ends; the next Job starts a new one", async () => {
    const first = await session();
    ok(await generate(first));
    const second = await session({ shareHomeWith: first });
    const { runtimePid: pid } = await lock(first);

    await first.client.close();
    await until(() => !alive(pid), "the Runtime has stopped");

    ok(await generate(second));
    const starts = (await second.runtime!.events()).filter((event) => event.event === "start");
    expect(starts).toHaveLength(2);
    expect((await lock(second)).runtimePid).not.toBe(pid);
  });

  test("a Job whose Runtime stopped with the session that started it fails when picked up, without starting a new one", async () => {
    const first = await session();
    await first.runtime!.setJobMs(60_000);
    const { job_id } = ok(await generate(first, { wait: false }));
    await until(async () => (await first.runtime!.events()).some((event) => event.event === "generate"), "the Job is generating");

    const { runtimePid } = await lock(first);
    await first.restart();
    await until(() => !alive(runtimePid), "the Runtime has stopped");
    const result = await first.client.callTool({ name: "get_job", arguments: { job_id } });
    expect(textOf(result)).toContain("the Runtime that ran this Job has stopped");
    expect((await first.runtime!.events()).filter((event) => event.event === "start")).toHaveLength(1);
  });

    test("a lock left by a Runtime that died does not stop the next one starting", async () => {
    const first = await session();
    await writeFile(join(first.dirs.home, "runtime.json"), JSON.stringify({ runtimePid: 2 ** 22 + 1, port: 1, ownerPid: 2 ** 22 + 1, ownerId: "gone" }));
    ok(await generate(first));
    expect(alive((await lock(first)).runtimePid)).toBe(true);
  });

  test("unloads the Model once no local Job has run for the idle period, and loads it again for the next Job", async () => {
    const first = await session({ runtimeIdleMs: 100 });
    ok(await generate(first));
    await until(async () => (await first.runtime!.events()).some((event) => event.event === "unload"), "the Model is unloaded");
    ok(await generate(first));

    const events = (await first.runtime!.events()).map((event) => event.event).filter((event) => event !== "done");
    expect(events).toEqual(["start", "load", "generate", "unload", "load", "generate"]);
  });
});

describe("the machine-wide queue", () => {
  test("two sessions' Jobs on two Models take turns on the Runtime, grouped by Model", async () => {
    const first = await session();
    const second = await session({ shareHomeWith: first });
    await first.runtime!.setJobMs(150);

    const started = [
      ok(await generate(first, { wait: false })),
      ok(await generate(second, { model: "zimage", wait: false })),
      ok(await generate(first, { wait: false })),
    ];
    const owners = [first, second, first];
    for (const [index, { job_id }] of started.entries()) {
      expect(ok(await owners[index]!.client.callTool({ name: "get_job", arguments: { job_id } })).status).toBe("completed");
    }

    const events = (await first.runtime!.events()).filter((event) => event.event !== "start");
    // Each Job runs alone: generate, done, and only then the next. The later flux3 Job goes before the older zimage one.
    expect(events.map((event) => `${event.event} ${event.recipe}`)).toEqual([
      "load flux3-klein",
      "generate flux3-klein",
      "done flux3-klein",
      "generate flux3-klein",
      "done flux3-klein",
      "load z-image-turbo",
      "generate z-image-turbo",
      "done z-image-turbo",
    ]);
  });
});

describe("cancel_job on a local Model", () => {
  const cancel = (harness: Harness, job_id: string) => harness.client.callTool({ name: "cancel_job", arguments: { job_id } });
  const getJob = (harness: Harness, job_id: string) => harness.client.callTool({ name: "get_job", arguments: { job_id } });
  const count = async (harness: Harness, event: string) => (await harness.runtime!.events()).filter((logged) => logged.event === event).length;

  test("stops a generating Job on the Runtime, which keeps the Model loaded for the next Job", async () => {
    const first = await session();
    await first.runtime!.setJobMs(60_000);
    const { job_id } = ok(await generate(first, { wait: false }));
    await until(async () => (await count(first, "generate")) === 1, "the Job is generating");

    expect(ok(await cancel(first, job_id))).toMatchObject({ job_id, status: "cancelled" });
    const result = await getJob(first, job_id);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("was cancelled");

    await first.runtime!.setJobMs(10);
    ok(await generate(first));
    expect(await count(first, "cancel")).toBe(1);
    expect(await count(first, "load")).toBe(1);
  });

  test("drops a Job still waiting for its turn: it never reaches the Runtime", async () => {
    const first = await session();
    await first.runtime!.setJobMs(60_000);
    const running = ok(await generate(first, { wait: false }));
    await until(async () => (await count(first, "generate")) === 1, "the first Job is generating");
    const waiting = ok(await generate(first, { model: "zimage", wait: false }));

    expect(ok(await cancel(first, waiting.job_id))).toMatchObject({ status: "cancelled" });
    ok(await cancel(first, running.job_id));
    expect(await count(first, "generate")).toBe(1);
    expect(await count(first, "load")).toBe(1);
  });

  test("another session can cancel a Job: the session running it stops it", async () => {
    const first = await session();
    const second = await session({ shareHomeWith: first });
    await first.runtime!.setJobMs(60_000);
    const { job_id } = ok(await generate(first, { wait: false }));
    await until(async () => (await count(first, "generate")) === 1, "the Job is generating");

    expect(ok(await cancel(second, job_id))).toMatchObject({ status: "cancelling" });
    expect(textOf(await getJob(first, job_id))).toContain("was cancelled");
    expect(await count(first, "cancel")).toBe(1);
  });

  test("a Job that has already ended cannot be cancelled", async () => {
    const first = await session();
    const { job_id } = ok(await generate(first));
    const result = await cancel(first, job_id);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("already completed");
  });
});
