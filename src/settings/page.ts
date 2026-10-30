/**
 * The settings page: one self-contained HTML document (no external assets) talking to the settings JSON API.
 * Every API call carries the one-time token from the page's own URL. Data is only ever inserted as text.
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
  input, select, button { font: inherit; border-radius: 7px; }
  input, select { width: 100%; padding: 7px 9px; border: 1px solid var(--border); background: var(--bg); color: var(--text); }
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
    <p class="muted">Choosing Models, Aliases and Model Notes will appear here.</p>
  </section>

  <section id="history">
    <h2>Job history</h2>
    <p class="muted">Past Jobs and their Ratings will appear here.</p>
  </section>
</main>
<div id="status" role="status" aria-live="polite"></div>

<script nonce="${nonce}">
"use strict";
const token = new URLSearchParams(location.search).get("token") || "";
let presets = [];

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

(async () => {
  try {
    ({ presets } = await api("GET", "/api/presets"));
    setUpAddForm();
    await loadProviders();
  } catch (error) {
    document.getElementById("provider-list").replaceChildren(el("p", { className: "muted", textContent: error.message }));
  }
})();
</script>
</body>
</html>`;
}
