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
    --bg: #fafafa; --surface: #fff; --field: #fff; --hover: #f4f4f5; --text: #18181b; --muted: #71717a; --border: #e4e4e7;
    --accent: #2563eb; --focus: rgb(37 99 235 / 0.22); --danger: #dc2626; --ok: #15803d; --warn: #b45309;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #0f0f11; --surface: #18181b; --field: #121214; --hover: #26262a; --text: #f4f4f5; --muted: #a1a1aa; --border: #2e2e33;
      --accent: #3b82f6; --focus: rgb(59 130 246 / 0.35); --danger: #f87171; --ok: #4ade80; --warn: #fbbf24; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text);
    font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; -webkit-font-smoothing: antialiased; }
  main { max-width: 720px; margin: 0 auto; padding: 48px 20px 96px; }
  h1 { font-size: 20px; font-weight: 600; margin: 0 0 6px; }
  h2 { font-size: 15px; font-weight: 600; margin: 0; }
  h3 { font-size: 15px; font-weight: 600; margin: 0; flex: 1; min-width: 0; overflow-wrap: anywhere; }
  p { margin: 0; }
  .muted { color: var(--muted); }
  header p { color: var(--muted); }
  section { margin-top: 44px; }
  .section-head { margin-bottom: 14px; }
  .section-head p { color: var(--muted); font-size: 13px; margin-top: 2px; }

  .card { display: grid; gap: 16px; background: var(--surface); border: 1px solid var(--border); border-radius: 12px;
    padding: 20px; margin-bottom: 12px; }
  .card-head { display: flex; align-items: center; gap: 10px; }
  .fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; }
  .field { min-width: 0; }
  .wide { grid-column: 1 / -1; }
  .inline { display: flex; flex-wrap: wrap; gap: 8px; }
  .inline > input, .inline > select { flex: 1 1 200px; width: auto; }
  .actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding-top: 16px; border-top: 1px solid var(--border); }
  .actions > select { width: auto; flex: 0 1 180px; }
  .spacer { flex: 1; }
  .empty { color: var(--muted); padding: 20px; border: 1px dashed var(--border); border-radius: 12px; text-align: center; margin-bottom: 12px; }

  label { display: block; font-size: 12px; font-weight: 500; color: var(--muted); margin-bottom: 6px; }
  input, select, textarea, button { font: inherit; color: inherit; }
  input, select, textarea { width: 100%; height: 34px; padding: 0 10px; border: 1px solid var(--border); border-radius: 8px;
    background: var(--field); color: var(--text); }
  textarea { height: auto; min-height: 72px; padding: 8px 10px; resize: vertical; }
  input:focus, select:focus, textarea:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--focus); }
  input::placeholder, textarea::placeholder { color: var(--muted); opacity: 0.8; }
  /* API keys are masked with CSS: a real key field would make the browser offer to save the key as a site login. */
  .secret { -webkit-text-security: disc; }
  .counter { font-size: 12px; color: var(--muted); text-align: right; margin-top: 4px; }

  button { height: 34px; padding: 0 14px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface);
    font-weight: 500; cursor: pointer; white-space: nowrap; }
  button:hover:not(:disabled) { background: var(--hover); }
  button:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--focus); }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  button.primary:hover:not(:disabled) { background: var(--accent); filter: brightness(1.08); }
  button.danger { border-color: transparent; background: transparent; color: var(--danger); }
  button.small { height: 28px; padding: 0 10px; font-size: 13px; }
  button:disabled { opacity: 0.5; cursor: default; }

  .chip { flex: none; font-size: 12px; font-weight: 500; padding: 2px 10px; border-radius: 999px; border: 1px solid var(--border); color: var(--muted); }
  .chip.ok { color: var(--ok); border-color: currentColor; }
  .chip.accent { color: #fff; background: var(--accent); border-color: var(--accent); }
  .chip.failed { color: var(--danger); border-color: currentColor; }
  .chip.running { color: var(--warn); border-color: currentColor; }
  .key { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }

  .result { font-size: 13px; }
  .result:empty { display: none; }
  .field > .result { margin-top: 8px; }
  .result.success { color: var(--ok); } .result.failure { color: var(--danger); } .result.unsupported { color: var(--warn); }
  .note { font-size: 12px; color: var(--muted); display: flex; align-items: center; gap: 8px; margin-top: 8px; }

  .job-meta { font-size: 12px; color: var(--muted); margin-top: 2px; }
  .prompt { white-space: pre-wrap; overflow-wrap: anywhere; }
  .thumbs { display: flex; flex-wrap: wrap; gap: 8px; }
  .thumb { width: 96px; height: 96px; object-fit: cover; border-radius: 8px; border: 1px solid var(--border); background: var(--bg); }
  .thumb.video { width: 192px; height: 108px; }
  .thumb.placeholder { display: flex; align-items: center; justify-content: center; text-align: center; padding: 6px;
    font-size: 11px; color: var(--muted); border-style: dashed; }
  .result-thumb { margin: 0; display: grid; gap: 4px; width: min-content; }
  .result-thumb figcaption { font-size: 12px; color: var(--muted); overflow-wrap: anywhere; }
  .actions.rate { display: grid; gap: 10px; }
  .inline > select.rate-target { flex: 0 0 auto; }
  .rating { font-size: 13px; }
  .rating.good { color: var(--ok); } .rating.bad { color: var(--danger); }
  .comparison { display: grid; gap: 12px; border: 1px solid var(--border); border-left: 3px solid var(--accent);
    border-radius: 12px; padding: 16px; margin-bottom: 12px; }
  .comparison > .card { margin-bottom: 0; }
  .comparison-head p { font-size: 13px; color: var(--muted); margin-top: 2px; }
  .picked { color: var(--accent); font-weight: 500; }

  #status { position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%); max-width: calc(100% - 32px);
    background: var(--text); color: var(--bg); padding: 8px 14px; border-radius: 8px; font-size: 13px; display: none;
    box-shadow: 0 6px 24px rgb(0 0 0 / 0.18); }
  #status.error { background: var(--danger); color: #fff; }
</style>
</head>
<body>
<main>
  <header>
    <h1>litevision settings</h1>
    <p>Credentials you enter here are saved on this computer only, in a file only you can read. They never pass through your Agent.</p>
  </header>

  <section id="providers">
    <div class="section-head"><h2>Providers</h2></div>
    <div id="provider-list"><p class="muted">Loading…</p></div>

    <form id="add-provider" class="card" autocomplete="off">
      <h3>Add a Provider</h3>
      <div class="fields">
        <div class="field"><label for="add-preset">Preset</label><select id="add-preset"></select></div>
        <div class="field"><label for="add-id">Name</label><input id="add-id" required spellcheck="false" placeholder="openai"></div>
        <div class="field wide"><label for="add-base-url">Base URL</label><input id="add-base-url" required spellcheck="false" placeholder="https://relay.example/v1"></div>
        <div class="field wide"><label for="add-credential">API key</label><input id="add-credential" class="secret" autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore spellcheck="false" placeholder="Paste your API key"></div>
      </div>
      <div class="actions"><button class="primary" type="submit">Add Provider</button></div>
    </form>
  </section>

  <section id="models">
    <div class="section-head">
      <h2>Models</h2>
      <p>Your Agent picks a Model by its Alias. Model Notes tell it what each Model is good or bad at.</p>
    </div>
    <div id="model-list"><p class="muted">Loading…</p></div>

    <form id="add-model" class="card" autocomplete="off">
      <h3>Add a Model</h3>
      <div class="fields">
        <div class="field"><label for="model-provider">Provider</label><select id="model-provider" required></select></div>
        <div class="field"><label for="model-protocol">Protocol</label><select id="model-protocol" required></select></div>
        <div class="field"><label for="model-modality">Makes</label><select id="model-modality" required><option value="image">Images</option><option value="video">Videos</option></select></div>
        <div class="field wide">
          <label for="model-id">Model id</label>
          <div class="inline"><input id="model-id" required spellcheck="false" list="model-ids" placeholder="gpt-image-1"><button id="fetch-models" type="button">Fetch model list</button></div>
          <datalist id="model-ids"></datalist>
          <div id="fetch-result" class="result"></div>
        </div>
        <div class="field wide"><label for="model-alias">Alias</label><input id="model-alias" required spellcheck="false" placeholder="gpt-image-cheap"></div>
        <div class="field wide"><label for="model-notes">Model Notes</label><textarea id="model-notes" maxlength="${modelNotesMaxLength}" placeholder="photoreal, cheap, bad at Chinese text"></textarea></div>
      </div>
      <div class="actions"><button class="primary" type="submit">Add Model</button></div>
    </form>
  </section>

  <section id="history">
    <div class="section-head">
      <h2>Job history</h2>
      <p>Newest first. Rate a Job, or one of its results, to keep your verdict on it; rating it again replaces the earlier Rating. In a Comparison, pick the result you prefer; picking again replaces the earlier Pick.</p>
    </div>
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

let fieldCount = 0;
/** A labelled control, with any buttons on the same line. */
function field(text, control, ...buttons) {
  control.id ||= "field-" + ++fieldCount;
  return el("div", { className: "field" }, el("label", { htmlFor: control.id, textContent: text }),
    buttons.length === 0 ? control : el("div", { className: "inline" }, control, ...buttons));
}

/** An API key input, masked with CSS (see .secret) and marked for 1Password, LastPass and Bitwarden to leave alone. */
function secretInput(placeholder) {
  const input = el("input", { className: "secret", autocomplete: "off", spellcheck: false, placeholder });
  for (const name of ["data-1p-ignore", "data-lpignore", "data-bwignore"]) input.setAttribute(name, "true");
  return input;
}

function emptyState(text) {
  return el("p", { className: "empty", textContent: text });
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
  const credential = secretInput(provider.credential ? "New API key to replace the saved one" : "Paste your API key");
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

  const removeKey = el("button", { type: "button", className: "danger", textContent: "Remove key" });
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

  const keyChip = provider.credential
    ? el("span", { className: "chip ok key", textContent: "Key ••••" + provider.credential.last4 })
    : el("span", { className: "chip", textContent: "No API key" });

  return el("div", { className: "card" },
    el("div", { className: "card-head" }, el("h3", { textContent: provider.id }), keyChip),
    el("div", { className: "fields" },
      el("div", { className: "wide" }, field("Base URL", baseUrl, saveUrl)),
      el("div", { className: "wide" }, provider.credential ? field("API key", credential, saveKey, removeKey) : field("API key", credential, saveKey))),
    el("div", { className: "actions" }, protocol, test, el("span", { className: "spacer" }), remove),
    result,
  );
}

async function loadProviders() {
  const list = document.getElementById("provider-list");
  const { providers } = await api("GET", "/api/providers");
  list.replaceChildren(...(providers.length === 0
    ? [emptyState("No Providers yet. Add one below.")]
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
  const wrapper = field("Model Notes", textarea);
  wrapper.classList.add("wide");
  wrapper.append(counter);
  return { textarea, wrapper };
}

/** "Last changed by the Agent, 30 Oct 2026, 10:00", plus an undo button when there is a previous version. */
function notesHistoryRow(model, path) {
  const history = model.notesHistory;
  if (!history) return [];
  const who = history.changedBy === "Agent" ? "your Agent" : "you";
  const when = new Date(history.changedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  const parts = [el("span", { textContent: "Last changed by " + who + ", " + when + "." })];
  if (history.previous !== undefined) {
    const undo = el("button", { type: "button", className: "small", textContent: "Undo", title: "Back to: " + (history.previous || "(no Model Notes)") });
    undo.onclick = () => act(undo, async () => {
      await api("POST", path + "/notes/undo");
      await loadModels();
    }, "Model Notes restored. Undo again to redo.");
    parts.push(undo);
  }
  return [el("div", { className: "note" }, ...parts)];
}

/** A JSON textarea for a Model's Standing Options: request fields every Job on it sends unless the Agent overrides them. */
function standingOptionsField(value) {
  const textarea = el("textarea", {
    value: value ? JSON.stringify(value, null, 2) : "",
    spellcheck: false,
    placeholder: '{ "quality": "high" }',
  });
  const wrapper = field("Standing Options", textarea);
  wrapper.classList.add("wide");
  wrapper.append(el("div", { className: "note", textContent: "A JSON object of the Provider's own request fields, sent with every Job on this Model. Your Agent's provider_options override them for a Job. Leave empty for none." }));
  /** The value to save: null when empty; throws when the text is not a JSON object. */
  const read = () => {
    const text = textarea.value.trim();
    if (text === "") return null;
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('Standing Options must be a JSON object, such as { "quality": "high" }. This is not valid JSON: ' + text.slice(0, 40));
    }
    return parsed;
  };
  return { wrapper, read };
}

function modelCard(model) {
  const alias = el("input", { value: model.alias, spellcheck: false });
  const provider = el("select", {}, ...options(providerIds.includes(model.provider) ? providerIds : [model.provider, ...providerIds], model.provider));
  const modelId = el("input", { value: model.modelId, spellcheck: false });
  const protocol = el("select", {}, ...options(protocols.includes(model.protocol) ? protocols : [model.protocol, ...protocols], model.protocol));
  const modality = el("select", {}, ...options(["image", "video"], model.modality));
  const notes = notesField(model.notes);
  const standing = standingOptionsField(model.standingOptions);
  const path = "/api/models/" + encodeURIComponent(model.alias);

  const save = el("button", { type: "button", className: "primary", textContent: "Save" });
  save.onclick = () => act(save, async () => {
    await api("PATCH", path, { alias: alias.value, provider: provider.value, modelId: modelId.value, protocol: protocol.value, modality: modality.value, notes: notes.textarea.value, standingOptions: standing.read() });
    await loadModels();
  }, "Model saved.");

  const makeDefault = el("button", { type: "button", className: "small", textContent: "Make default" });
  makeDefault.onclick = () => act(makeDefault, async () => {
    await api("PUT", "/api/default-" + model.modality + "-model", { alias: model.alias });
    await loadModels();
  }, model.alias + " is now the default " + model.modality + " Model.");

  const remove = el("button", { type: "button", className: "danger", textContent: "Remove Model" });
  remove.onclick = () => {
    if (!confirm("Remove the Model " + model.alias + "?")) return;
    act(remove, async () => {
      await api("DELETE", path);
      await loadModels();
    }, "Model removed.");
  };

  notes.wrapper.append(...notesHistoryRow(model, path));

  return el("div", { className: "card" },
    el("div", { className: "card-head" }, el("h3", { textContent: model.alias }),
      model.default ? el("span", { className: "chip accent", textContent: "Default " + model.modality }) : makeDefault),
    el("div", { className: "fields" },
      field("Alias", alias), field("Provider", provider), field("Model id", modelId), field("Protocol", protocol), field("Makes", modality), notes.wrapper, standing.wrapper),
    el("div", { className: "actions" }, save, el("span", { className: "spacer" }), remove),
  );
}

// The saved Models, so the fetched model list can say which model ids are already added.
let savedModels = [];
// Redraws the fetched model list; set by setUpAddModelForm.
let showModelIds = () => {};

async function loadModels() {
  const list = document.getElementById("model-list");
  const { models } = await api("GET", "/api/models");
  savedModels = models;
  showModelIds();
  list.replaceChildren(...(models.length === 0
    ? [emptyState(providerIds.length === 0 ? "Add a Provider first, then add its Models below." : "No Models yet. Add one below.")]
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
  const modality = document.getElementById("model-modality");
  // The model ids the last fetch found, and what each one makes when the Provider says.
  let fetchedIds = [];
  let knownModalities = {};
  protocol.replaceChildren(...options(protocols));

  const forgetModelIds = () => {
    fetchedIds = [];
    knownModalities = {};
    showModelIds();
  };

  // Lists the fetched model ids that make what Makes says (and those the Provider says nothing about),
  // marking the ones already added as a Model on this Provider.
  showModelIds = () => {
    const shown = fetchedIds.filter((id) => (knownModalities[id] ?? modality.value) === modality.value);
    ids.replaceChildren(...shown.map((id) => {
      const aliases = savedModels.filter((m) => m.provider === provider.value && m.modelId === id).map((m) => m.alias);
      return el("option", aliases.length === 0 ? { value: id } : { value: id, label: "Already added as " + aliases.join(", ") });
    }));
    if (fetchedIds.length === 0) return;
    const hidden = fetchedIds.length - shown.length;
    const other = modality.value === "image" ? "video" : "image";
    fetchResult.textContent = shown.length + (hidden === 0 ? "" : " " + modality.value) + " model id(s) found"
      + (hidden === 0 ? "" : ", and " + hidden + " " + other + " model id(s) hidden until Makes says " + (other === "image" ? "Images" : "Videos"))
      + ". Pick one in the Model id field, or type your own.";
  };

  // Suggest the Protocol a preset Provider's Models usually speak; the User can still change it.
  provider.onchange = () => {
    const suggested = presets.find((p) => p.id === provider.value);
    if (suggested && protocols.includes(suggested.protocol)) protocol.value = suggested.protocol;
    forgetModelIds();
    fetchResult.textContent = "";
  };
  protocol.onchange = forgetModelIds;
  modality.onchange = () => showModelIds();

  fetchButton.onclick = () => act(fetchButton, async () => {
    fetchResult.textContent = "Fetching…";
    fetchResult.className = "result";
    const outcome = await api("POST", "/api/providers/" + encodeURIComponent(provider.value) + "/model-ids", { protocol: protocol.value });
    if (outcome.result === "success") {
      fetchedIds = outcome.modelIds;
      knownModalities = outcome.modalities || {};
      fetchResult.className = "result success";
      showModelIds();
      if (fetchedIds.length === 0) fetchResult.textContent = "No model ids found. Type the model id.";
      modelId.focus();
    } else {
      forgetModelIds();
      fetchResult.textContent = outcome.message;
      fetchResult.className = "result " + outcome.result;
    }
  });

  // Until the User types their own Alias, suggest the model id.
  let aliasEdited = false;
  alias.oninput = () => (aliasEdited = alias.value !== "");
  modelId.oninput = () => {
    const known = knownModalities[modelId.value.trim()];
    if (known && known !== modality.value) {
      modality.value = known;
      showModelIds();
    }
    if (!aliasEdited) alias.value = modelId.value.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[^A-Za-z0-9]+/, "").slice(0, 64);
  };

  const form = document.getElementById("add-model");
  form.onsubmit = (event) => {
    event.preventDefault();
    const body = { alias: alias.value, provider: provider.value, modelId: modelId.value, protocol: protocol.value, modality: modality.value };
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

/** An image or video of a Job, or a placeholder once the file is gone. */
function thumbnail(job, file) {
  const src = file.thumbnail + "?token=" + encodeURIComponent(token);
  const media = job.modality === "video"
    ? el("video", { className: "thumb video", src, title: file.path, controls: true, muted: true, preload: "metadata" })
    : el("img", { className: "thumb", src, alt: file.path, title: file.path, loading: "lazy" });
  media.onerror = () => media.replaceWith(el("div", { className: "thumb placeholder", title: file.path, textContent: "File no longer on disk" }));
  return media;
}

function formatDuration(ms) {
  return ms < 1000 ? ms + " ms" : (ms / 1000).toFixed(1) + " s";
}

function ratingText(rating) {
  return (rating.verdict === "good" ? "Good" : "Bad") + ": " + rating.reason;
}

/** Whether this Job is its Comparison's Pick: as a whole, or with \`result\` that one result of it. */
function isPicked(job, result) {
  const pick = job.comparison && job.comparison.pick;
  return !!pick && pick.jobId === job.id && (result === undefined || pick.result === result);
}

/**
 * A thumbnail, captioned with its number, its own Rating and whether it is its Comparison's Pick, when the Job has
 * several results or this one is rated or picked.
 */
function resultThumbnail(job, file, index) {
  const media = thumbnail(job, file);
  const picked = job.files.length > 1 && isPicked(job, index + 1);
  if (job.files.length === 1 && !file.rating) return media;
  const caption = el("figcaption", { textContent: "Result " + (index + 1) + (picked ? " · Picked" : "") + (file.rating ? " · " + ratingText(file.rating) : "") });
  if (file.rating) caption.className = "rating " + file.rating.verdict;
  else if (picked) caption.className = "picked";
  return el("figure", { className: "result-thumb" }, media, caption);
}

/**
 * For a completed Job of a Comparison: a Pick button for the Job or, when it has several results, the one selected.
 * A Pick says which of the Comparison's results the User prefers; it is not a Rating.
 */
function pickRow(job) {
  if (!job.comparison || job.outcome !== "completed") return [];
  const target = el("select", { className: "rate-target", title: "What you pick" },
    el("option", { value: "", textContent: "Whole Job" }),
    ...job.files.map((_, index) => el("option", { value: String(index + 1), textContent: "Result " + (index + 1) })));
  const button = el("button", { type: "button", textContent: "Pick" });
  button.onclick = () => act(button, async () => {
    const body = { jobId: job.id };
    if (target.value !== "") body.result = Number(target.value);
    await api("POST", "/api/comparisons/" + encodeURIComponent(job.comparison.id) + "/pick", body);
    await loadJobs();
  }, "Pick saved.");
  const controls = job.files.length > 1 ? [target, button] : [button];
  return [el("div", { className: "actions" }, el("span", { className: "spacer muted", textContent: "Prefer this one?" }), ...controls)];
}

/**
 * The whole Job's Rating, and a one-line reason with Good and Bad buttons to rate the Job or, when it has several
 * results, one of them. Only completed Jobs can be rated.
 */
function ratingRow(job) {
  if (job.outcome !== "completed") return [];
  const whole = job.files.length > 1 ? "Whole Job · " : "";
  const current = job.rating
    ? el("span", { className: "rating " + job.rating.verdict, textContent: whole + ratingText(job.rating) })
    : el("span", { className: "rating muted", textContent: whole + "Not rated yet." });
  const reason = el("input", { maxLength: reasonMax, placeholder: "One-line reason, e.g. the text is misspelled" });
  const target = el("select", { className: "rate-target", title: "What the Rating is about" },
    el("option", { value: "", textContent: "Whole Job" }),
    ...job.files.map((_, index) => el("option", { value: String(index + 1), textContent: "Result " + (index + 1) })));
  const rateAs = (verdict, label) => {
    const button = el("button", { type: "button", textContent: label });
    button.onclick = () => act(button, async () => {
      const body = { verdict, reason: reason.value };
      if (target.value !== "") body.result = Number(target.value);
      await api("POST", "/api/jobs/" + encodeURIComponent(job.id) + "/rating", body);
      await loadJobs();
    }, "Rating saved.");
    return button;
  };
  const controls = job.files.length > 1 ? [target, reason] : [reason];
  return [el("div", { className: "actions rate" }, current, el("div", { className: "inline" }, ...controls, rateAs("good", "Good"), rateAs("bad", "Bad")))];
}

function jobCard(job) {
  const when = new Date(job.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  const outcome = job.outcome === "completed"
    ? (job.modality === "video" ? "Video" : job.files.length + " image(s)")
    : job.outcome === "running" ? "Running…" : "Failed";
  const details = [];
  if (job.error) details.push(el("p", { className: "result failure", textContent: job.error }));
  if (job.shortfall) details.push(el("p", { className: "result unsupported", textContent: job.shortfall }));
  if (job.mismatch) details.push(el("p", { className: "result unsupported", textContent: job.mismatch }));
  return el("div", { className: "card" },
    el("div", {},
      el("div", { className: "card-head" }, el("h3", { textContent: job.model }),
        ...(isPicked(job) ? [el("span", { className: "chip accent", textContent: "Picked" })] : []),
        el("span", { className: "chip " + (job.outcome === "completed" ? "ok" : job.outcome), textContent: outcome })),
      el("p", { className: "job-meta", textContent: job.modelId + " on " + job.provider + " · " + when + " · " + formatDuration(job.durationMs) })),
    el("p", { className: "prompt", textContent: job.prompt }),
    ...(job.files.length === 0 ? [] : [el("div", { className: "thumbs" }, ...job.files.map((file, index) => resultThumbnail(job, file, index)))]),
    ...details,
    ...ratingRow(job),
    ...pickRow(job),
  );
}

/** A Comparison's Jobs together, under what the User picked among them. */
function comparisonCard(jobs) {
  const pick = jobs[0].comparison.pick;
  const picked = pick && jobs.find((job) => job.id === pick.jobId);
  const status = !pick ? "Not picked yet."
    : "Picked: " + (pick.result === undefined ? "" : "result " + pick.result + " of ") + (picked ? picked.model + "'s Job" : "Job " + pick.jobId) + ".";
  return el("div", { className: "comparison" },
    el("div", { className: "comparison-head" }, el("h3", { textContent: "Comparison · " + jobs.length + " Jobs" }),
      el("p", { textContent: status + " A Pick says which you prefer; it is not a Rating." })),
    ...jobs.map(jobCard));
}

/** Job cards, each Comparison's Jobs (which the listing keeps together) in one Comparison card. */
function jobEntries(jobs) {
  const entries = [];
  for (let i = 0; i < jobs.length; ) {
    const comparison = jobs[i].comparison;
    if (!comparison) { entries.push(jobCard(jobs[i])); i++; continue; }
    let end = i;
    while (end < jobs.length && jobs[end].comparison && jobs[end].comparison.id === comparison.id) end++;
    entries.push(comparisonCard(jobs.slice(i, end)));
    i = end;
  }
  return entries;
}

async function loadJobs() {
  const list = document.getElementById("job-list");
  const { jobs } = await api("GET", "/api/jobs");
  list.replaceChildren(...(jobs.length === 0
    ? [emptyState("No Jobs yet. Images your Agent generates will appear here.")]
    : jobEntries(jobs)));
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
