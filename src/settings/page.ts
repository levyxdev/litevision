import { modelNotesMaxLength } from "../config.ts";
import { ratingReasonMaxLength } from "../history.ts";

/**
 * The settings page: one self-contained HTML document (no external assets) talking to the settings JSON API.
 * Every API call carries the one-time token from the page's own URL: in a header, or for an <img>, which cannot set
 * headers, in the image URL's query. Data is only ever inserted as text.
 */
export function renderPage(nonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>litevision settings</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f7f7f8; --card: #fff; --text: #1d1d1f; --muted: #6b6b73; --border: #dcdce0;
    --accent: #2f6fde; --danger: #c43d3d; --ok: #1f8a4c; --warn: #a86b00;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #151517; --card: #1f1f22; --text: #ececf0; --muted: #a0a0aa; --border: #35353b;
      --accent: #6f9cf0; --danger: #ec6b6b; --ok: #4cc283; --warn: #e0a640; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text);
    font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 760px; margin: 0 auto; padding: 24px 16px 64px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 17px; margin: 32px 0 12px; }
  h3 { font-size: 15px; margin: 0; }
  p.lead, .muted { color: var(--muted); }
  p.lead { margin: 0 0 8px; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 16px; margin-bottom: 12px; }
  .row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .row + .row { margin-top: 10px; }
  .grow { flex: 1 1 220px; min-width: 0; }
  label { display: block; font-size: 13px; color: var(--muted); margin-bottom: 4px; }
  input, select, textarea, button { font: inherit; border-radius: 7px; }
  input, select, textarea { width: 100%; padding: 7px 9px; border: 1px solid var(--border); background: var(--bg); color: var(--text); }
  textarea { resize: vertical; min-height: 60px; }
  .badge { font-size: 12px; padding: 2px 8px; border-radius: 999px; background: var(--accent); color: #fff; }
  .counter { font-size: 12px; color: var(--muted); text-align: right; }
  .notes-history { font-size: 13px; }
  button { padding: 7px 12px; border: 1px solid var(--border); background: var(--card); color: var(--text); cursor: pointer; white-space: nowrap; }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  button.danger { color: var(--danger); }
  button:disabled { opacity: 0.6; cursor: default; }
  code { font-size: 13px; overflow-wrap: anywhere; }
  .key { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .result { font-size: 14px; margin-top: 10px; }
  .result.success { color: var(--ok); } .result.failure { color: var(--danger); } .result.unsupported { color: var(--warn); }
  #status { position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%); max-width: calc(100% - 32px);
    background: var(--text); color: var(--bg); padding: 8px 14px; border-radius: 8px; font-size: 14px; display: none; }
  #status.error { background: var(--danger); color: #fff; }
  .job-meta { font-size: 13px; color: var(--muted); }
  .prompt { margin: 8px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
  .thumbs { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
  .thumb { width: 112px; height: 112px; object-fit: cover; border-radius: 7px; border: 1px solid var(--border); background: var(--bg); }
  .thumb.placeholder { display: flex; align-items: center; justify-content: center; text-align: center; padding: 6px;
    font-size: 12px; color: var(--muted); border-style: dashed; }
  .rating { font-size: 14px; }
  .rating.good { color: var(--ok); } .rating.bad { color: var(--danger); }
  .outcome.failed { color: var(--danger); } .outcome.running { color: var(--warn); }
</style>
</head>
<body>
<main>
  <h1>litevision settings</h1>
  <p class="lead">Credentials you enter here are saved on this computer only, in a file only you can read. They never pass through your Agent.</p>

  <section id="providers">
    <h2>Providers</h2>
    <div id="provider-list"><p class="muted">Loading…</p></div>

    <form id="add-provider" class="card" autocomplete="off">
      <h3>Add a Provider</h3>
      <div class="row">
        <div class="grow"><label for="add-preset">Preset</label><select id="add-preset"></select></div>
        <div class="grow"><label for="add-id">Name</label><input id="add-id" required spellcheck="false" placeholder="openai"></div>
      </div>
      <div class="row">
        <div class="grow"><label for="add-base-url">Base URL</label><input id="add-base-url" required spellcheck="false" placeholder="https://relay.example/v1"></div>
      </div>
      <div class="row">
        <div class="grow"><label for="add-credential">API key</label><input id="add-credential" type="password" autocomplete="new-password" spellcheck="false" placeholder="Paste your API key"></div>
      </div>
      <div class="row"><button class="primary" type="submit">Add Provider</button></div>
    </form>
  </section>

  <section id="models">
    <h2>Models</h2>
    <p class="muted">Your Agent picks a Model by its Alias. Model Notes tell it what each Model is good or bad at.</p>
    <div id="model-list"><p class="muted">Loading…</p></div>

    <form id="add-model" class="card" autocomplete="off">
      <h3>Add a Model</h3>
      <div class="row">
        <div class="grow"><label for="model-provider">Provider</label><select id="model-provider" required></select></div>
        <div class="grow"><label for="model-protocol">Protocol</label><select id="model-protocol" required></select></div>
      </div>
      <div class="row">
        <div class="grow"><label for="model-id">Model id</label><input id="model-id" required spellcheck="false" list="model-ids" placeholder="gpt-image-1"></div>
        <button id="fetch-models" type="button">Fetch model list</button>
      </div>
      <datalist id="model-ids"></datalist>
      <div id="fetch-result" class="result"></div>
      <div class="row">
        <div class="grow"><label for="model-alias">Alias</label><input id="model-alias" required spellcheck="false" placeholder="gpt-image-cheap"></div>
      </div>
      <div class="row">
        <div class="grow"><label for="model-notes">Model Notes</label><textarea id="model-notes" maxlength="${modelNotesMaxLength}" placeholder="photoreal, cheap, bad at Chinese text"></textarea></div>
      </div>
      <div class="row"><button class="primary" type="submit">Add Model</button></div>
    </form>
  </section>

  <section id="history">
    <h2>Job history</h2>
    <p class="muted">Newest first. Rate a Job to keep your verdict on it; rating it again replaces the earlier Rating.</p>
    <div id="job-list"><p class="muted">Loading…</p></div>
  </section>
</main>
<div id="status" role="status" aria-live="polite"></div>

<script nonce="${nonce}">
"use strict";
const token = new URLSearchParams(location.search).get("token") || "";
let presets = [];
let protocols = [];
let providerIds = [];
const notesMax = ${modelNotesMaxLength};
const reasonMax = ${ratingReasonMaxLength};

async function api(method, path, body) {
  const init = { method, headers: { "x-litevision-token": token } };
  if (body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetch(path, init);
  } catch {
    throw new Error("The settings page has shut down. Run \`litevision settings\` or ask your Agent to open it again.");
  }
  if (response.status === 204) return undefined;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 403) throw new Error("This page is no longer authorised. Open the settings page again.");
    throw new Error(data.error || "Request failed with HTTP " + response.status + ".");
  }
  return data;
}

function el(tag, props, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props || {});
  for (const child of children) node.append(child);
  return node;
}

let statusTimer;
function showStatus(message, isError) {
  const status = document.getElementById("status");
  status.textContent = message;
  status.className = isError ? "error" : "";
  status.style.display = "block";
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => (status.style.display = "none"), isError ? 8000 : 3000);
}

/** Runs an action from a button, disabling it meanwhile and reporting errors. */
async function act(button, action, success) {
  button.disabled = true;
  try {
    await action();
    if (success) showStatus(success);
  } catch (error) {
    showStatus(error.message, true);
  } finally {
    button.disabled = false;
  }
}

function protocolFor(provider) {
  const preset = presets.find((p) => p.baseUrl === provider.baseUrl) || presets.find((p) => p.id === provider.id);
  return preset ? preset.protocol : "openai-images";
}

function protocolSelect(selected) {
  const select = el("select", { title: "Protocol to test with" });
  const protocols = [...new Set(presets.map((p) => p.protocol))];
  for (const protocol of protocols) select.append(el("option", { value: protocol, textContent: protocol, selected: protocol === selected }));
  return select;
}

function providerCard(provider) {
  const baseUrl = el("input", { value: provider.baseUrl, spellcheck: false });
  const credential = el("input", { type: "password", autocomplete: "new-password", spellcheck: false,
    placeholder: provider.credential ? "New API key to replace the saved one" : "Paste your API key" });
  const protocol = protocolSelect(protocolFor(provider));
  const result = el("div", { className: "result" });

  const saveUrl = el("button", { type: "button", textContent: "Save URL" });
  saveUrl.onclick = () => act(saveUrl, async () => {
    await api("PATCH", "/api/providers/" + encodeURIComponent(provider.id), { baseUrl: baseUrl.value });
    await loadProviders();
  }, "Base URL saved.");

  const saveKey = el("button", { type: "button", className: "primary", textContent: provider.credential ? "Replace key" : "Save key" });
  saveKey.onclick = () => act(saveKey, async () => {
    await api("PATCH", "/api/providers/" + encodeURIComponent(provider.id), { credential: credential.value });
    credential.value = "";
    await loadProviders();
  }, "API key saved.");

  const removeKey = el("button", { type: "button", className: "danger", textContent: "Remove key", disabled: !provider.credential });
  removeKey.onclick = () => {
    if (!confirm("Remove the saved API key for " + provider.id + "?")) return;
    act(removeKey, async () => {
      await api("DELETE", "/api/providers/" + encodeURIComponent(provider.id) + "/credential");
      await loadProviders();
    }, "API key removed.");
  };

  const test = el("button", { type: "button", textContent: "Test connection" });
  test.onclick = () => act(test, async () => {
    result.textContent = "Testing…";
    result.className = "result";
    const outcome = await api("POST", "/api/providers/" + encodeURIComponent(provider.id) + "/test-connection", { protocol: protocol.value });
    result.textContent = outcome.message;
    result.className = "result " + outcome.result;
  });

  const remove = el("button", { type: "button", className: "danger", textContent: "Remove Provider" });
  remove.onclick = () => {
    if (!confirm("Remove the Provider " + provider.id + " and its saved API key?")) return;
    act(remove, async () => {
      await api("DELETE", "/api/providers/" + encodeURIComponent(provider.id));
      await loadProviders();
    }, "Provider removed.");
  };

  const keyText = provider.credential
    ? el("span", { className: "key", textContent: "API key ••••" + provider.credential.last4 })
    : el("span", { className: "muted", textContent: "No API key saved" });

  return el("div", { className: "card" },
    el("div", { className: "row" }, el("h3", { className: "grow", textContent: provider.id }), keyText),
    el("div", { className: "row" }, el("div", { className: "grow" }, baseUrl), saveUrl),
    el("div", { className: "row" }, el("div", { className: "grow" }, credential), saveKey, removeKey),
    el("div", { className: "row" }, el("div", { className: "grow" }, protocol), test, remove),
    result,
  );
}

async function loadProviders() {
  const list = document.getElementById("provider-list");
  const { providers } = await api("GET", "/api/providers");
  list.replaceChildren(...(providers.length === 0
    ? [el("p", { className: "muted", textContent: "No Providers yet. Add one below." })]
    : providers.map(providerCard)));
  providerIds = providers.map((p) => p.id);
  const select = document.getElementById("model-provider");
  const chosen = select.value;
  select.replaceChildren(...options(providerIds, chosen));
  select.onchange();
  // Model cards list the Providers too.
  await loadModels();
}

function options(values, selected) {
  return values.map((value) => el("option", { value, textContent: value, selected: value === selected }));
}

/** A textarea for Model Notes with a live character count. */
function notesField(value) {
  const textarea = el("textarea", { value, maxLength: notesMax, placeholder: "photoreal, cheap, bad at Chinese text" });
  const counter = el("div", { className: "counter" });
  const update = () => (counter.textContent = textarea.value.length + " / " + notesMax);
  textarea.oninput = update;
  update();
  return { textarea, wrapper: el("div", { className: "grow" }, el("label", { textContent: "Model Notes" }), textarea, counter) };
}

/** "Last changed by the Agent, 30 Oct 2026, 10:00", plus an undo button when there is a previous version. */
function notesHistoryRow(model, path) {
  const history = model.notesHistory;
  if (!history) return [];
  const who = history.changedBy === "Agent" ? "your Agent" : "you";
  const when = new Date(history.changedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  const parts = [el("span", { className: "grow muted", textContent: "Model Notes last changed by " + who + ", " + when + "." })];
  if (history.previous !== undefined) {
    const undo = el("button", { type: "button", textContent: "Undo", title: "Back to: " + (history.previous || "(no Model Notes)") });
    undo.onclick = () => act(undo, async () => {
      await api("POST", path + "/notes/undo");
      await loadModels();
    }, "Model Notes restored. Undo again to redo.");
    parts.push(undo);
  }
  return [el("div", { className: "row notes-history" }, ...parts)];
}

function labelled(text, control) {
  return el("div", { className: "grow" }, el("label", { textContent: text }), control);
}

function modelCard(model) {
  const alias = el("input", { value: model.alias, spellcheck: false });
  const provider = el("select", {}, ...options(providerIds.includes(model.provider) ? providerIds : [model.provider, ...providerIds], model.provider));
  const modelId = el("input", { value: model.modelId, spellcheck: false });
  const protocol = el("select", {}, ...options(protocols.includes(model.protocol) ? protocols : [model.protocol, ...protocols], model.protocol));
  const notes = notesField(model.notes);
  const path = "/api/models/" + encodeURIComponent(model.alias);

  const save = el("button", { type: "button", className: "primary", textContent: "Save" });
  save.onclick = () => act(save, async () => {
    await api("PATCH", path, { alias: alias.value, provider: provider.value, modelId: modelId.value, protocol: protocol.value, notes: notes.textarea.value });
    await loadModels();
  }, "Model saved.");

  const makeDefault = el("button", { type: "button", textContent: "Make default" });
  makeDefault.onclick = () => act(makeDefault, async () => {
    await api("PUT", "/api/default-image-model", { alias: model.alias });
    await loadModels();
  }, model.alias + " is now the default image Model.");

  const remove = el("button", { type: "button", className: "danger", textContent: "Remove Model" });
  remove.onclick = () => {
    if (!confirm("Remove the Model " + model.alias + "?")) return;
    act(remove, async () => {
      await api("DELETE", path);
      await loadModels();
    }, "Model removed.");
  };

  return el("div", { className: "card" },
    el("div", { className: "row" }, el("h3", { className: "grow", textContent: model.alias }),
      model.default ? el("span", { className: "badge", textContent: "Default" }) : makeDefault),
    el("div", { className: "row" }, labelled("Alias", alias), labelled("Provider", provider)),
    el("div", { className: "row" }, labelled("Model id", modelId), labelled("Protocol", protocol)),
    el("div", { className: "row" }, notes.wrapper),
    ...notesHistoryRow(model, path),
    el("div", { className: "row" }, save, remove),
  );
}

async function loadModels() {
  const list = document.getElementById("model-list");
  const { models } = await api("GET", "/api/models");
  list.replaceChildren(...(models.length === 0
    ? [el("p", { className: "muted", textContent: providerIds.length === 0 ? "Add a Provider first, then add its Models below." : "No Models yet. Add one below." })]
    : models.map(modelCard)));
}

function setUpAddModelForm() {
  const provider = document.getElementById("model-provider");
  const protocol = document.getElementById("model-protocol");
  const modelId = document.getElementById("model-id");
  const alias = document.getElementById("model-alias");
  const notes = document.getElementById("model-notes");
  const fetchButton = document.getElementById("fetch-models");
  const fetchResult = document.getElementById("fetch-result");
  const ids = document.getElementById("model-ids");
  protocol.replaceChildren(...options(protocols));

  // Suggest the Protocol a preset Provider's Models usually speak; the User can still change it.
  provider.onchange = () => {
    const suggested = presets.find((p) => p.id === provider.value);
    if (suggested && protocols.includes(suggested.protocol)) protocol.value = suggested.protocol;
    ids.replaceChildren();
    fetchResult.textContent = "";
  };
  protocol.onchange = () => ids.replaceChildren();

  fetchButton.onclick = () => act(fetchButton, async () => {
    fetchResult.textContent = "Fetching…";
    fetchResult.className = "result";
    const outcome = await api("POST", "/api/providers/" + encodeURIComponent(provider.value) + "/model-ids", { protocol: protocol.value });
    if (outcome.result === "success") {
      ids.replaceChildren(...outcome.modelIds.map((id) => el("option", { value: id })));
      fetchResult.textContent = outcome.modelIds.length + " model id(s) found. Pick one in the Model id field, or type your own.";
      fetchResult.className = "result success";
      modelId.focus();
    } else {
      fetchResult.textContent = outcome.message;
      fetchResult.className = "result " + outcome.result;
    }
  });

  // Until the User types their own Alias, suggest the model id.
  let aliasEdited = false;
  alias.oninput = () => (aliasEdited = alias.value !== "");
  modelId.oninput = () => {
    if (!aliasEdited) alias.value = modelId.value.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[^A-Za-z0-9]+/, "").slice(0, 64);
  };

  const form = document.getElementById("add-model");
  form.onsubmit = (event) => {
    event.preventDefault();
    const body = { alias: alias.value, provider: provider.value, modelId: modelId.value, protocol: protocol.value };
    if (notes.value.trim() !== "") body.notes = notes.value;
    act(form.querySelector("button[type=submit]"), async () => {
      await api("POST", "/api/models", body);
      modelId.value = alias.value = notes.value = "";
      aliasEdited = false;
      await loadModels();
    }, "Model added.");
  };
}

function setUpAddForm() {
  const preset = document.getElementById("add-preset");
  const id = document.getElementById("add-id");
  const baseUrl = document.getElementById("add-base-url");
  const credential = document.getElementById("add-credential");
  for (const p of presets) preset.append(el("option", { value: p.id, textContent: p.label }));
  preset.append(el("option", { value: "", textContent: "Custom base URL" }));
  const applyPreset = () => {
    const chosen = presets.find((p) => p.id === preset.value);
    id.value = chosen ? chosen.id : "";
    baseUrl.value = chosen ? chosen.baseUrl : "";
  };
  preset.onchange = applyPreset;
  applyPreset();

  const form = document.getElementById("add-provider");
  form.onsubmit = (event) => {
    event.preventDefault();
    const body = { id: id.value, baseUrl: baseUrl.value };
    if (credential.value.trim() !== "") body.credential = credential.value;
    act(form.querySelector("button"), async () => {
      await api("POST", "/api/providers", body);
      credential.value = "";
      preset.value = "";
      applyPreset();
      await loadProviders();
    }, "Provider added.");
  };
}

/** An image of a Job, or a placeholder once the file is gone. */
function thumbnail(file) {
  const img = el("img", { className: "thumb", src: file.thumbnail + "?token=" + encodeURIComponent(token), alt: file.path, title: file.path, loading: "lazy" });
  img.onerror = () => img.replaceWith(el("div", { className: "thumb placeholder", title: file.path, textContent: "Image no longer on disk" }));
  return img;
}

function formatDuration(ms) {
  return ms < 1000 ? ms + " ms" : (ms / 1000).toFixed(1) + " s";
}

/** The current Rating, and a one-line reason with Good and Bad buttons to rate the Job. Only completed Jobs can be rated. */
function ratingRows(job) {
  if (job.outcome !== "completed") return [];
  const current = job.rating
    ? el("span", { className: "grow rating " + job.rating.verdict, textContent: (job.rating.verdict === "good" ? "Good" : "Bad") + ": " + job.rating.reason })
    : el("span", { className: "grow muted", textContent: "Not rated yet." });
  const reason = el("input", { maxLength: reasonMax, placeholder: "One-line reason, e.g. the text is misspelled" });
  const rateAs = (verdict, label) => {
    const button = el("button", { type: "button", textContent: label });
    button.onclick = () => act(button, async () => {
      await api("POST", "/api/jobs/" + encodeURIComponent(job.id) + "/rating", { verdict, reason: reason.value });
      await loadJobs();
    }, "Rating saved.");
    return button;
  };
  return [
    el("div", { className: "row" }, current),
    el("div", { className: "row" }, el("div", { className: "grow" }, reason), rateAs("good", "Good"), rateAs("bad", "Bad")),
  ];
}

function jobCard(job) {
  const when = new Date(job.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  const outcome = job.outcome === "completed"
    ? job.files.length + " image(s)"
    : job.outcome === "running" ? "Running…" : "Failed";
  const details = [];
  if (job.error) details.push(el("p", { className: "result failure", textContent: job.error }));
  if (job.shortfall) details.push(el("p", { className: "result unsupported", textContent: job.shortfall }));
  return el("div", { className: "card" },
    el("div", { className: "row job-meta" },
      el("span", { className: "grow", textContent: job.model + " (" + job.modelId + " on " + job.provider + ") · " + when + " · " + formatDuration(job.durationMs) }),
      el("span", { className: "outcome " + job.outcome, textContent: outcome })),
    el("p", { className: "prompt", textContent: job.prompt }),
    ...(job.files.length === 0 ? [] : [el("div", { className: "thumbs" }, ...job.files.map(thumbnail))]),
    ...details,
    ...ratingRows(job),
  );
}

async function loadJobs() {
  const list = document.getElementById("job-list");
  const { jobs } = await api("GET", "/api/jobs");
  list.replaceChildren(...(jobs.length === 0
    ? [el("p", { className: "muted", textContent: "No Jobs yet. Images your Agent generates will appear here." })]
    : jobs.map(jobCard)));
}

(async () => {
  try {
    ({ presets } = await api("GET", "/api/presets"));
    ({ protocols } = await api("GET", "/api/protocols"));
    setUpAddForm();
    setUpAddModelForm();
    await loadProviders();
    await loadJobs();
  } catch (error) {
    for (const id of ["provider-list", "model-list", "job-list"]) {
      document.getElementById(id).replaceChildren(el("p", { className: "muted", textContent: error.message }));
    }
  }
})();
</script>
</body>
</html>`;
}
