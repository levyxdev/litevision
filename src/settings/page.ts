import { modelNotesMaxLength } from "../config.ts";
import { ratingReasonMaxLength } from "../history.ts";
import { localProtocol } from "../local/provider.ts";
import { suggestedAlias } from "./suggested-alias.ts";

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
  .tabs { position: sticky; top: 0; z-index: 1; display: flex; gap: 4px; margin-top: 28px; background: var(--bg);
    border-bottom: 1px solid var(--border); overflow-x: auto; }
  .tabs a { padding: 10px 12px; margin-bottom: -1px; border-bottom: 2px solid transparent; color: var(--muted);
    font-weight: 500; text-decoration: none; white-space: nowrap; }
  .tabs a:hover { color: var(--text); }
  .tabs a:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--focus); border-radius: 6px 6px 0 0; }
  .tabs a[aria-selected="true"] { color: var(--text); border-bottom-color: var(--accent); }
  section { margin-top: 24px; }
  section[hidden], form[hidden] { display: none; }
  .section-head { display: flex; align-items: flex-start; gap: 12px; margin-bottom: 14px; }
  .section-head > div { flex: 1; min-width: 0; }
  .section-head p { color: var(--muted); font-size: 13px; margin-top: 2px; }

  details.card { padding: 0; gap: 0; }
  details.card > summary { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; padding: 14px 20px;
    cursor: pointer; list-style: none; border-radius: 12px; }
  details.card > summary::-webkit-details-marker { display: none; }
  details.card > summary::before { content: ""; flex: none; width: 7px; height: 7px; margin-right: 2px;
    border-right: 2px solid var(--muted); border-bottom: 2px solid var(--muted); transform: rotate(-45deg); transition: transform 0.15s; }
  details.card[open] > summary::before { transform: rotate(45deg); }
  details.card > summary:hover { background: var(--hover); }
  details.card > summary:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--focus); }
  details.card > summary h3 { flex: 0 1 auto; }
  .summary-meta { flex: 1 1 160px; min-width: 0; font-size: 13px; color: var(--muted); overflow-wrap: anywhere; }
  .card-body { display: grid; gap: 16px; padding: 4px 20px 20px; }

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
  button.destructive { background: var(--danger); border-color: var(--danger); color: #fff; }
  button.destructive:hover:not(:disabled) { background: var(--danger); filter: brightness(1.08); }
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
  .option-statuses { display: grid; gap: 6px; font-size: 13px; }
  .option-statuses ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
  .option-statuses li { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px; overflow-wrap: anywhere; }
  .chip.ignored, .chip.rejected { color: var(--danger); border-color: currentColor; }
  .filters { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 14px; }
  .filters select { width: auto; flex: 1 1 140px; max-width: 220px; }
  .filters .count { flex: 1 0 auto; text-align: right; font-size: 13px; color: var(--muted); }
  .more { display: flex; justify-content: center; margin-top: 4px; }
  .report { display: grid; gap: 4px; padding: 12px 16px; margin-bottom: 12px; border: 1px solid var(--border);
    border-left: 3px solid var(--ok); border-radius: 12px; background: var(--surface); font-size: 13px; }
  .report[hidden] { display: none; }
  .report .report-head { display: flex; align-items: center; gap: 8px; font-weight: 500; }
  .report .report-head > span { flex: 1; }
  .report p { overflow-wrap: anywhere; color: var(--muted); }
  input[type="checkbox"] { width: 16px; height: 16px; padding: 0; margin: 0; flex: none; accent-color: var(--accent); cursor: pointer; }
  input[type="checkbox"]:disabled { cursor: default; opacity: 0.4; }
  input[type="checkbox"]:focus { box-shadow: 0 0 0 3px var(--focus); }
  .select-all { display: flex; align-items: center; gap: 8px; margin: 0 6px 0 2px; font-size: 13px; color: var(--muted); cursor: pointer; }
  .banner { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; padding: 8px 14px; margin-bottom: 12px;
    border-radius: 10px; background: var(--hover); font-size: 13px; }
  .banner[hidden], .selection-bar[hidden] { display: none; }
  button.link { height: auto; padding: 0; border: 0; background: none; color: var(--accent); }
  button.link:hover:not(:disabled) { background: none; text-decoration: underline; }
  .selection-bar { position: fixed; left: 50%; bottom: 16px; z-index: 2; transform: translateX(-50%); width: min(680px, calc(100% - 32px));
    display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 10px 14px; background: var(--surface);
    border: 1px solid var(--border); border-radius: 12px; box-shadow: 0 6px 24px rgb(0 0 0 / 0.18); }
  .selection-bar .summary { flex: 1 1 180px; font-weight: 500; }
  body.selecting main { padding-bottom: 150px; }
  body.selecting #status { bottom: 90px; }
  .comparison-head { display: flex; align-items: flex-start; gap: 10px; }
  .comparison-head > input[type="checkbox"], .card-head > input[type="checkbox"] { margin-top: 2px; align-self: flex-start; }
  .comparison-head > div { flex: 1; min-width: 0; }

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

  <nav class="tabs" role="tablist" aria-label="Settings">
    <a id="tab-providers" href="#providers" role="tab" aria-controls="providers">Providers</a>
    <a id="tab-models" href="#models" role="tab" aria-controls="models">Models</a>
    <a id="tab-history" href="#history" role="tab" aria-controls="history">Job history</a>
  </nav>

  <section id="providers" role="tabpanel" aria-labelledby="tab-providers">
    <div class="section-head">
      <div><h2>Providers</h2><p>Where litevision sends Jobs, with the API key each one needs.</p></div>
      <button id="show-add-provider" type="button" aria-controls="add-provider" aria-expanded="false">Add a Provider</button>
    </div>
    <form id="add-provider" class="card" autocomplete="off" hidden>
      <div class="card-head"><h3>Add a Provider</h3><button type="button" class="small" data-close>Cancel</button></div>
      <div class="fields">
        <div class="field"><label for="add-preset">Preset</label><select id="add-preset"></select></div>
        <div class="field"><label for="add-id">Name</label><input id="add-id" required spellcheck="false" placeholder="openai"></div>
        <div class="field wide"><label for="add-base-url">Base URL</label><input id="add-base-url" required spellcheck="false" placeholder="https://relay.example/v1"></div>
        <div class="field wide"><label for="add-credential">API key</label><input id="add-credential" class="secret" autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore spellcheck="false" placeholder="Paste your API key"></div>
      </div>
      <div class="actions"><button class="primary" type="submit">Add Provider</button></div>
    </form>
    <div id="provider-list"><p class="muted">Loading…</p></div>
  </section>

  <section id="models" role="tabpanel" aria-labelledby="tab-models" hidden>
    <div class="section-head">
      <div><h2>Models</h2><p>Your Agent picks a Model by its Alias. Model Notes tell it what each Model is good or bad at.</p></div>
      <button id="show-add-model" type="button" aria-controls="add-model" aria-expanded="false">Add a Model</button>
    </div>
    <form id="add-model" class="card" autocomplete="off" hidden>
      <div class="card-head"><h3>Add a Model</h3><button type="button" class="small" data-close>Cancel</button></div>
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
    <div id="model-list"><p class="muted">Loading…</p></div>
  </section>

  <section id="history" role="tabpanel" aria-labelledby="tab-history" hidden>
    <div class="section-head">
      <div><h2>Job history</h2>
      <p>Newest first. Rate a Job, or one of its results, to keep your verdict on it; rating it again replaces the earlier Rating. In a Comparison, pick the result you prefer; picking again replaces the earlier Pick.</p></div>
    </div>
    <div class="filters" role="group" aria-label="Filter the Job history">
      <label class="select-all"><input type="checkbox" id="select-all" aria-label="Select all loaded Jobs"> All</label>
      <select id="filter-model" aria-label="Model"><option value="">All Models</option></select>
      <select id="filter-outcome" aria-label="Status">
        <option value="">Any status</option><option value="completed">Completed</option><option value="failed">Failed</option><option value="running">Running</option>
      </select>
      <select id="filter-modality" aria-label="Images or videos"><option value="">Images and videos</option><option value="image">Images</option><option value="video">Videos</option></select>
      <span id="job-count" class="count" aria-live="polite"></span>
    </div>
    <div id="select-banner" class="banner" hidden></div>
    <div id="job-report" class="report" role="status" hidden></div>
    <div id="job-list"><p class="muted">Loading…</p></div>
    <div class="more"><button id="show-more" type="button" hidden>Show more</button></div>
  </section>
</main>
<div id="selection-bar" class="selection-bar" role="region" aria-label="Selected Jobs" hidden>
  <span id="selection-summary" class="summary" aria-live="polite"></span>
  <button id="delete-selected" type="button" class="destructive">Delete</button>
  <button id="clear-selection" type="button">Clear selection</button>
</div>
<div id="status" role="status" aria-live="polite"></div>

<script nonce="${nonce}">
"use strict";
const token = new URLSearchParams(location.search).get("token") || "";
let presets = [];
let protocols = [];
let providerIds = [];
const notesMax = ${modelNotesMaxLength};
const reasonMax = ${ratingReasonMaxLength};
const suggestedAlias = ${suggestedAlias.toString()};

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

/** The local Provider: litevision runs its Runtime on this computer, so there is no base URL or API key to set. */
function localProviderCard(provider) {
  const result = el("div", { className: "result" });
  const test = el("button", { type: "button", textContent: "Test connection" });
  test.onclick = () => act(test, async () => {
    result.textContent = "Checking…";
    result.className = "result";
    const outcome = await api("POST", "/api/providers/" + encodeURIComponent(provider.id) + "/test-connection", {});
    result.textContent = outcome.message;
    result.className = "result " + outcome.result;
  });
  return el("div", { className: "card" },
    el("div", { className: "card-head" }, el("h3", { textContent: provider.id }), el("span", { className: "chip", textContent: "On this computer" })),
    el("p", { className: "muted", textContent: "Runs local Models on this computer, with no base URL or API key. Add or remove them with npx -y litevision local install <model> and local remove <model>." }),
    el("div", { className: "actions" }, test),
    result,
  );
}

function providerCard(provider) {
  if (provider.local) return localProviderCard(provider);
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
  if (providers.length === 0) addProviderForm.show();
  list.replaceChildren(...(providers.length === 0
    ? [emptyState("No Providers yet. Add one with Add a Provider.")]
    : providers.map(providerCard)));
  // Local Models are added only by local install, so the Model forms never offer the local Provider.
  providerIds = providers.filter((p) => !p.local).map((p) => p.id);
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

const statusLabels = { honoured: "Honoured", ignored: "Ignored", rejected: "Rejected", accepted: "Accepted" };

/**
 * A Model's Option Statuses, read-only (ADR 0011): what the latest evidence says about each provider_options value sent
 * to it. There is nothing to edit; a value the User always wants belongs in Standing Options.
 */
function optionStatusesView(statuses) {
  const entries = statuses ? Object.keys(statusLabels).flatMap((name) => statuses[name] || []) : [];
  const list = entries.length === 0
    ? el("p", { className: "muted", textContent: "None recorded yet." })
    : el("ul", {}, ...entries.map((entry) => {
      const when = new Date(entry.date).toLocaleDateString(undefined, { dateStyle: "medium" });
      return el("li", {},
        el("span", { className: "chip " + entry.status, textContent: statusLabels[entry.status] }),
        el("span", { className: "key", textContent: JSON.stringify(entry.options) }),
        el("span", { className: "muted", textContent: (entry.jobDeleted ? "Deleted Job" : "Job " + entry.jobId.slice(0, 8)) + ", " + when + (entry.reason ? ": " + entry.reason : "") }));
    }));
  return el("div", { className: "wide option-statuses" },
    el("label", { textContent: "Option Statuses" }),
    list,
    el("div", { className: "note", textContent: "What litevision has learned about the provider_options sent to this Model, from its results and the Provider's errors; your Ratings never change it. Honoured: the result matched. Ignored: it did not. Rejected: the Provider refused it. Accepted: not refused, effect unknown. Read-only: to always send a value, set it in Standing Options." }));
}

function modelCard(model) {
  const alias = el("input", { value: model.alias, spellcheck: false });
  const provider = el("select", {}, ...options(providerIds.includes(model.provider) ? providerIds : [model.provider, ...providerIds], model.provider));
  const modelId = el("input", { value: model.modelId, spellcheck: false });
  const protocol = el("select", {}, ...options(protocols.includes(model.protocol) ? protocols : [model.protocol, ...protocols], model.protocol));
  const modality = el("select", {}, ...options(["image", "video"], model.modality));
  // A local Model's Provider, model id and Protocol are set by local install.
  if (model.local) for (const input of [provider, modelId, protocol]) input.disabled = true;
  const notes = notesField(model.notes);
  const standing = standingOptionsField(model.standingOptions);
  const path = "/api/models/" + encodeURIComponent(model.alias);

  const save = el("button", { type: "button", className: "primary", textContent: "Save" });
  save.onclick = () => act(save, async () => {
    await api("PATCH", path, { alias: alias.value, provider: provider.value, modelId: modelId.value, protocol: protocol.value, modality: modality.value, notes: notes.textarea.value, standingOptions: standing.read() });
    // A renamed Model stays open under its new Alias.
    if (openModels.delete(model.alias)) openModels.add(alias.value.trim());
    await loadModels();
  }, "Model saved.");

  const makeDefault = el("button", { type: "button", textContent: "Make default" });
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

  const statuses = optionStatuses[model.alias] || {};
  const flagged = (statuses.ignored || []).length + (statuses.rejected || []).length;
  const card = el("details", { className: "card", open: openModels.has(model.alias) },
    el("summary", {},
      el("h3", { textContent: model.alias }),
      el("span", { className: "summary-meta", textContent: model.modelId + " on " + model.provider }),
      el("span", { className: "chip", textContent: model.modality === "video" ? "Videos" : "Images" }),
      ...(model.default ? [el("span", { className: "chip accent", textContent: "Default " + model.modality })] : []),
      ...(flagged === 0 ? [] : [el("span", { className: "chip ignored", title: "Some provider_options were Ignored or Rejected: open to see which.", textContent: flagged + " Ignored or Rejected" })])),
    el("div", { className: "card-body" },
      el("div", { className: "fields" },
        field("Alias", alias), field("Provider", provider), field("Model id", modelId), field("Protocol", protocol), field("Makes", modality), notes.wrapper, standing.wrapper,
        optionStatusesView(statuses)),
      el("div", { className: "actions" }, save, ...(model.default ? [] : [makeDefault]), el("span", { className: "spacer" }), remove)),
  );
  card.ontoggle = () => (card.open ? openModels.add(model.alias) : openModels.delete(model.alias));
  return card;
}

// The saved Models, so the fetched model list can say which model ids are already added.
let savedModels = [];
// Each saved Model's Option Statuses, by Alias.
let optionStatuses = {};
// The Aliases of the Model cards the User has open, kept open when the list is redrawn.
const openModels = new Set();
// Redraws the fetched model list; set by setUpAddModelForm.
let showModelIds = () => {};

async function loadModels() {
  const list = document.getElementById("model-list");
  const [{ models }, statuses] = await Promise.all([api("GET", "/api/models"), api("GET", "/api/option-statuses")]);
  savedModels = models;
  optionStatuses = statuses.models;
  showModelIds();
  if (models.length === 0 && providerIds.length > 0) addModelForm.show();
  list.replaceChildren(...(models.length === 0
    ? [emptyState(providerIds.length === 0 ? "Add a Provider first, then add its Models here." : "No Models yet. Add one with Add a Model.")]
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

  // Until the User types their own Alias, suggest one from the Provider id and the model id.
  let aliasEdited = false;
  alias.oninput = () => (aliasEdited = alias.value !== "");
  const refreshAliasSuggestion = () => {
    if (!aliasEdited) alias.value = suggestedAlias(provider.value, modelId.value);
  };

  // Suggest the Protocol a preset Provider's Models usually speak; the User can still change it.
  provider.onchange = () => {
    const suggested = presets.find((p) => p.id === provider.value);
    if (suggested && protocols.includes(suggested.protocol)) protocol.value = suggested.protocol;
    forgetModelIds();
    fetchResult.textContent = "";
    refreshAliasSuggestion();
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

  modelId.oninput = () => {
    const known = knownModalities[modelId.value.trim()];
    if (known && known !== modality.value) {
      modality.value = known;
      showModelIds();
    }
    refreshAliasSuggestion();
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
      addModelForm.hide();
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
      addProviderForm.hide();
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
    await loadJobs(true);
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
      await loadJobs(true);
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
    : job.interrupted ? "Interrupted" : job.outcome === "running" ? "Running…" : "Failed";
  const details = [];
  if (job.error) details.push(el("p", { className: "result failure", textContent: job.error }));
  if (job.shortfall) details.push(el("p", { className: "result unsupported", textContent: job.shortfall }));
  if (job.mismatch) details.push(el("p", { className: "result unsupported", textContent: job.mismatch }));
  return el("div", { className: "card" },
    el("div", {},
      el("div", { className: "card-head" }, selectBox(job), el("h3", { textContent: job.model }),
        ...(isPicked(job) ? [el("span", { className: "chip accent", textContent: "Picked" })] : []),
        el("span", { className: "chip " + (job.outcome === "completed" ? "ok" : job.interrupted ? "failed" : job.outcome), textContent: outcome,
          title: job.interrupted ? "The litevision session running this Job ended before it finished. Your Agent can pick it up again with get_job, or you can delete it." : "" }),
        deleteButton("Delete", [job], "Delete this Job")),
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
    el("div", { className: "comparison-head" },
      comparisonBox(jobs),
      el("div", {},
        el("h3", { textContent: "Comparison · " + (jobs.length === jobs[0].comparison.size ? jobs.length + " Jobs" : jobs.length + " of its " + jobs[0].comparison.size + " Jobs match the filters") }),
        el("p", { textContent: status + " A Pick says which you prefer; it is not a Rating." })),
      deleteButton(jobs.length === jobs[0].comparison.size ? "Delete Comparison" : "Delete these " + jobs.length, jobs, "Delete the Comparison's Jobs shown here")),
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

/** "1 Job", "3 Results": a count and its noun. */
function count(n, noun) {
  return n + " " + noun + (n === 1 ? "" : "s");
}

/** Whether a Job can be deleted: anything but a Job a live litevision session is still running. */
function canDelete(job) {
  return !!job && (job.outcome !== "running" || !!job.interrupted);
}

/** What deleting these Jobs would remove, from what the page shows of them. */
function deletionOf(jobs) {
  const doomed = jobs.filter(canDelete);
  const ids = new Set(doomed.map((job) => job.id));
  const picked = new Set(doomed.filter((job) => job.comparison && job.comparison.pick && ids.has(job.comparison.pick.jobId)).map((job) => job.comparison.id));
  return { ids: [...ids], jobs: ids.size, results: doomed.reduce((sum, job) => sum + job.files.length, 0), picks: picked.size };
}

/** "Delete 2 Jobs, 3 Results and 1 Pick for good?" */
function deletionQuestion({ jobs, results, picks }) {
  return "Delete " + count(jobs, "Job") + ", " + count(results, "Result") + " and " + count(picks, "Pick") + " for good?\\n\\nThis cannot be undone. Result files you changed since they were saved are left, and your reference images are never deleted.";
}

/** A button that deletes these Jobs once the User confirms; disabled when none of them can be deleted. */
function deleteButton(label, jobs, title) {
  const button = el("button", { type: "button", className: "small danger", textContent: label, title });
  const deletion = deletionOf(jobs);
  if (deletion.ids.length === 0) {
    button.disabled = true;
    button.title = "A Job still running cannot be deleted: ask your Agent to cancel it, or wait for it to end.";
  }
  button.onclick = () => deleteJobs(button, { jobIds: deletion.ids }, deletionQuestion(deletion));
  return button;
}

/** Asks the User, then deletes, redraws the Job history and shows what was deleted and what was left. */
async function deleteJobs(button, body, question) {
  if (!confirm(question)) return;
  await act(button, async () => {
    const report = await api("POST", "/api/jobs/delete", body);
    showReport(report);
    // Every Job matching the filters is gone; a Job deleted alone leaves the rest of the selection.
    if (body.filter) clearSelection();
    await loadJobs(true);
  });
}

const skipReasons = { "content-changed": "changed since the Job saved it", "could-not-delete": "the system would not let litevision delete it" };

/** The deletion report above the Job history, until the User closes it. */
function showReport(report) {
  const box = document.getElementById("job-report");
  const close = el("button", { type: "button", className: "small", textContent: "Close" });
  close.onclick = () => (box.hidden = true);
  const lines = [];
  if (report.alreadyGone.length > 0) lines.push(count(report.alreadyGone.length, "Result") + (report.alreadyGone.length === 1 ? " was" : " were") + " already gone.");
  for (const skipped of report.skippedFiles) lines.push("Left " + skipped.file + ": " + skipReasons[skipped.reason] + ".");
  if (report.runningJobs.length > 0) lines.push(count(report.runningJobs.length, "Job") + " still running, so not deleted. Cancel " + (report.runningJobs.length === 1 ? "it" : "them") + " first.");
  if (report.notFound.length > 0) lines.push(count(report.notFound.length, "Job") + " had already been deleted.");
  for (const pick of report.picksRemoved) lines.push("A Comparison lost its Pick with the Job it picked.");
  for (const used of report.referencesOfOtherJobs) lines.push(used.file + " was a reference image of " + count(used.jobIds.length, "remaining Job") + ".");
  box.replaceChildren(
    el("div", { className: "report-head" }, el("span", { textContent: "Deleted " + count(report.deletedJobs.length, "Job") + " and " + count(report.deletedFiles.length, "Result") + "." }), close),
    ...lines.map((line) => el("p", { textContent: line })));
  box.hidden = false;
}

/** The Job history tab's filters, as the API takes them; empty values are left out. */
function jobFilter() {
  const filter = {};
  for (const name of ["model", "outcome", "modality"]) {
    const value = document.getElementById("filter-" + name).value;
    if (value !== "") filter[name] = value;
  }
  return filter;
}

function jobsPath(offset) {
  return "/api/jobs?" + new URLSearchParams({ ...jobFilter(), offset: String(offset) });
}

// How many entries are loaded, and where the next page starts; null once all are.
let loadedEntries = 0;
let nextOffset = null;

/** Shows the Job history's first page, or with \`keep\` as many entries as are loaded now, as after rating a Job. */
async function loadJobs(keep) {
  const list = document.getElementById("job-list");
  const wanted = keep ? Math.max(loadedEntries, 1) : 1;
  let page = await api("GET", jobsPath(0));
  const jobs = [...page.jobs];
  let loaded = page.nextOffset === null ? page.total : page.nextOffset;
  while (page.nextOffset !== null && loaded < wanted) {
    page = await api("GET", jobsPath(page.nextOffset));
    jobs.push(...page.jobs);
    loaded = page.nextOffset === null ? page.total : page.nextOffset;
  }
  showAliases(page.aliases);
  loadedJobs = new Map(jobs.map((job) => [job.id, job]));
  const filtered = Object.keys(jobFilter()).length > 0;
  list.replaceChildren(...(jobs.length === 0
    ? [emptyState(filtered ? "No Jobs match these filters." : "No Jobs yet. Images your Agent generates will appear here.")]
    : jobEntries(jobs)));
  showLoaded(loaded, page);
}

async function showMore(button) {
  await act(button, async () => {
    const page = await api("GET", jobsPath(nextOffset));
    // A Job another session recorded meanwhile shifts the pages, bringing back one already shown.
    const fresh = page.jobs.filter((job) => !loadedJobs.has(job.id));
    for (const job of fresh) loadedJobs.set(job.id, job);
    document.getElementById("job-list").append(...jobEntries(fresh));
    showLoaded(page.nextOffset === null ? page.total : page.nextOffset, page);
  });
}

function showLoaded(loaded, page) {
  loadedEntries = loaded;
  nextOffset = page.nextOffset;
  deletable = page.deletable;
  // Jobs deleted, or running again, drop out of the selection.
  for (const id of selected) if (!selectable(loadedJobs.get(id))) selected.delete(id);
  showSelection();
  document.getElementById("show-more").hidden = nextOffset === null;
  document.getElementById("job-count").textContent = page.total === 0 ? ""
    : loaded < page.total ? "Showing " + loaded + " of " + page.total + " entries" : page.total + (page.total === 1 ? " entry" : " entries");
}

/** Offers every Alias the Job history records, keeping the one chosen. */
function showAliases(aliases) {
  const select = document.getElementById("filter-model");
  const chosen = select.value;
  const all = chosen === "" || aliases.includes(chosen) ? aliases : [chosen, ...aliases];
  select.replaceChildren(el("option", { value: "", textContent: "All Models" }), ...options(all, chosen));
}

for (const name of ["model", "outcome", "modality"]) {
  document.getElementById("filter-" + name).onchange = () => {
    clearSelection();
    loadJobs().catch((error) => showStatus(error.message, true));
  };
}
document.getElementById("show-more").onclick = (event) => showMore(event.currentTarget);

// The Job history's selection: the Job ids ticked, or every Job matching the filters, loaded or not.
const selected = new Set();
let allMatching = false;
// The Job ticked or unticked last, where a shift-click range starts.
let lastTicked = null;
// The loaded Jobs by id, and what deleting every Job matching the filters would remove.
let loadedJobs = new Map();
let deletable = { jobs: 0, results: 0, picks: 0 };

/** Only a Job that can be deleted can be selected. */
const selectable = canDelete;

const loadedSelectable = () => [...loadedJobs.values()].filter(selectable).map((job) => job.id);
const isSelected = (id) => allMatching || selected.has(id);

/** A Job's checkbox; shift-click selects or clears every Job between it and the Job clicked before. */
function selectBox(job) {
  const box = el("input", { type: "checkbox", className: "select-job", checked: isSelected(job.id), disabled: !selectable(job) });
  box.dataset.id = job.id;
  box.setAttribute("aria-label", "Select this " + job.model + " Job");
  if (!selectable(job)) box.title = "A Job still running cannot be deleted: ask your Agent to cancel it, or wait for it to end.";
  box.onclick = (event) => {
    setSelected(event.shiftKey && lastTicked !== null ? idsBetween(lastTicked, job.id) : [job.id], box.checked);
    lastTicked = job.id;
  };
  return box;
}

/** A Comparison's checkbox: ticks or clears all of its Jobs shown, which can then be cleared one by one. */
function comparisonBox(jobs) {
  const ids = jobs.filter(selectable).map((job) => job.id);
  const box = el("input", { type: "checkbox", className: "select-comparison", disabled: ids.length === 0 });
  box.dataset.ids = ids.join(" ");
  box.setAttribute("aria-label", "Select this Comparison's Jobs");
  box.onclick = () => setSelected(ids, box.checked);
  return box;
}

/** The selectable Job ids from one Job's checkbox to another's, both included, in the order the page shows them. */
function idsBetween(from, to) {
  const ids = [...document.querySelectorAll("input.select-job:not(:disabled)")].map((box) => box.dataset.id);
  const [start, end] = [ids.indexOf(from), ids.indexOf(to)].sort((a, b) => a - b);
  return start === -1 ? [to] : ids.slice(start, end + 1);
}

function setSelected(ids, on) {
  // Changing one Job while every matching Job is selected leaves just the loaded ones selected, less or more that one.
  if (allMatching) {
    allMatching = false;
    for (const id of loadedSelectable()) selected.add(id);
  }
  for (const id of ids) on ? selected.add(id) : selected.delete(id);
  showSelection();
}

function clearSelection() {
  selected.clear();
  allMatching = false;
  lastTicked = null;
  showSelection();
}

/** What the selection would delete: counted on the page for ticked Jobs, by the server for every matching Job. */
function selection() {
  return allMatching ? deletable : deletionOf([...selected].map((id) => loadedJobs.get(id)).filter(Boolean));
}

/** Brings every checkbox, the banner and the selection bar in line with the selection. */
function showSelection() {
  for (const box of document.querySelectorAll("input.select-job")) box.checked = !box.disabled && isSelected(box.dataset.id);
  for (const box of document.querySelectorAll("input.select-comparison")) {
    const ids = box.dataset.ids ? box.dataset.ids.split(" ") : [];
    const ticked = ids.filter(isSelected).length;
    box.checked = ids.length > 0 && ticked === ids.length;
    box.indeterminate = ticked > 0 && ticked < ids.length;
  }
  const loaded = loadedSelectable();
  const ticked = loaded.filter(isSelected).length;
  const all = document.getElementById("select-all");
  all.disabled = loaded.length === 0;
  all.checked = loaded.length > 0 && ticked === loaded.length;
  all.indeterminate = ticked > 0 && ticked < loaded.length;

  const banner = document.getElementById("select-banner");
  if (allMatching) {
    const clear = el("button", { type: "button", className: "link", textContent: "Clear selection" });
    clear.onclick = clearSelection;
    banner.replaceChildren(el("span", { textContent: "All " + count(deletable.jobs, "Job") + " matching the filters are selected." }), clear);
  } else if (loaded.length > 0 && ticked === loaded.length && deletable.jobs > loaded.length) {
    const more = el("button", { type: "button", className: "link", textContent: "Select all " + deletable.jobs + " matching" });
    more.onclick = () => {
      allMatching = true;
      showSelection();
    };
    banner.replaceChildren(el("span", { textContent: "All " + count(loaded.length, "loaded Job") + " are selected." }), more);
  }
  banner.hidden = !(allMatching || (loaded.length > 0 && ticked === loaded.length && deletable.jobs > loaded.length));

  const chosen = selection();
  document.getElementById("selection-summary").textContent = count(chosen.jobs, "Job") + " · " + count(chosen.results, "Result") + " selected";
  document.getElementById("selection-bar").hidden = chosen.jobs === 0;
  document.body.classList.toggle("selecting", chosen.jobs > 0);
}

document.getElementById("select-all").onclick = (event) => {
  if (event.currentTarget.checked) {
    allMatching = false;
    for (const id of loadedSelectable()) selected.add(id);
    showSelection();
  } else clearSelection();
};
document.getElementById("clear-selection").onclick = clearSelection;
document.getElementById("delete-selected").onclick = (event) => {
  const chosen = selection();
  if (chosen.jobs === 0) return;
  deleteJobs(event.currentTarget, allMatching ? { filter: jobFilter() } : { jobIds: chosen.ids }, deletionQuestion(chosen));
};

const tabs = ["providers", "models", "history"];
/** Shows the tab the URL fragment names, or the first. */
function showTab() {
  const current = tabs.includes(location.hash.slice(1)) ? location.hash.slice(1) : tabs[0];
  for (const tab of tabs) {
    document.getElementById(tab).hidden = tab !== current;
    document.getElementById("tab-" + tab).setAttribute("aria-selected", String(tab === current));
  }
}
window.addEventListener("hashchange", showTab);
showTab();

/** An "Add" form, hidden until its button is pressed; it hides again on Cancel. */
function toggledForm(formId, buttonId) {
  const form = document.getElementById(formId);
  const button = document.getElementById(buttonId);
  const show = () => {
    form.hidden = false;
    button.hidden = true;
    button.setAttribute("aria-expanded", "true");
  };
  const hide = () => {
    form.hidden = true;
    button.hidden = false;
    button.setAttribute("aria-expanded", "false");
  };
  button.onclick = () => {
    show();
    const first = form.querySelector("input, select");
    if (first) first.focus();
  };
  form.querySelector("[data-close]").onclick = hide;
  return { show, hide };
}
const addProviderForm = toggledForm("add-provider", "show-add-provider");
const addModelForm = toggledForm("add-model", "show-add-model");

(async () => {
  try {
    ({ presets } = await api("GET", "/api/presets"));
    ({ protocols } = await api("GET", "/api/protocols"));
    protocols = protocols.filter((protocol) => protocol !== "${localProtocol}");
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
