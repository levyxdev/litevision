/**
 * Stands in for sd-server as the Runtime binary: the harness installs a script that runs this file. It serves the
 * part of sd-server's API litevision uses, refuses to load or unload while a Job runs, as sd-server does, and logs
 * every event to `log.jsonl` in FAKE_RUNTIME_DIR. `fake.json` there sets how long a Job takes, read on each request.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";

const dir = process.env.FAKE_RUNTIME_DIR!;
const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--listen-port") + 1]);
const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const log = (event: Record<string, unknown>) => appendFileSync(join(dir, "log.jsonl"), `${JSON.stringify({ ...event, at: Date.now(), pid: process.pid })}\n`);
const settings = (): { jobMs?: number } => {
  try {
    return JSON.parse(readFileSync(join(dir, "fake.json"), "utf8"));
  } catch {
    return {};
  }
};

let state: "empty" | "ready" = "empty";
let recipe: string | null = null;
interface Task {
  id: string;
  status: "generating" | "completed" | "cancelled";
  result: { images: Array<{ b64_json: string }> } | null;
  error: { code: string; message: string } | null;
}
const tasks = new Map<string, Task>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
let next = 1;

const status = () => ({ state, recipe, models: {}, error: null, load_elapsed_seconds: null });
const busy = () => [...tasks.values()].some((task) => task.status === "generating");

function send(response: ServerResponse, code: number, body: unknown) {
  response.writeHead(code, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function bodyOf(request: IncomingMessage): Promise<Record<string, any>> {
  let text = "";
  for await (const chunk of request) text += chunk;
  return text === "" ? {} : JSON.parse(text);
}

createServer(async (request, response) => {
  const path = new URL(request.url!, "http://localhost").pathname;
  const route = `${request.method} ${path}`;
  const body = request.method === "POST" ? await bodyOf(request) : {};
  if (route === "GET /sdcpp/v1/models/status") return send(response, 200, status());
  if (route === "POST /sdcpp/v1/models/load") {
    if (busy()) return send(response, 409, { error: "model is busy", code: "model_busy" });
    state = "ready";
    recipe = body.recipe;
    log({ event: "load", recipe });
    return send(response, 200, status());
  }
  if (route === "POST /sdcpp/v1/models/unload") {
    if (busy()) return send(response, 409, { error: "model is busy", code: "model_busy" });
    log({ event: "unload", recipe });
    state = "empty";
    recipe = null;
    return send(response, 200, status());
  }
  if (route === "POST /sdcpp/v1/img_gen") {
    if (state !== "ready") return send(response, 503, { error: "No model is loaded", code: "model_not_loaded" });
    const task: Task = { id: `job_${next++}`, status: "generating", result: null, error: null };
    tasks.set(task.id, task);
    log({ event: "generate", recipe, id: task.id });
    timers.set(task.id, setTimeout(() => {
      task.status = "completed";
      task.result = { images: Array.from({ length: body.batch_count ?? 1 }, () => ({ b64_json: pngBase64 })) };
      log({ event: "done", recipe, id: task.id });
    }, settings().jobMs ?? 50));
    return send(response, 202, { id: task.id, poll_url: `/sdcpp/v1/jobs/${task.id}` });
  }
  const job = /^\/sdcpp\/v1\/jobs\/([^/]+)(\/cancel)?$/.exec(path);
  const task = job === null ? undefined : tasks.get(job[1]!);
  if (job !== null && task === undefined) return send(response, 404, { error: "job not found" });
  if (task !== undefined && request.method === "GET" && job![2] === undefined) return send(response, 200, task);
  if (task !== undefined && request.method === "POST" && job![2] === "/cancel") {
    if (task.status === "generating") {
      clearTimeout(timers.get(task.id));
      task.status = "cancelled";
      task.error = { code: "cancelled", message: "job cancelled by client" };
      log({ event: "cancel", recipe, id: task.id });
    }
    return send(response, 200, { ...task, cancel_requested: true });
  }
  send(response, 404, { error: "not found" });
}).listen(port, "127.0.0.1", () => log({ event: "start", args }));
