const entries = [];
let selectedId = null;
let idSeq = 0;
let lastSchema = null;

const $ = (s) => document.querySelector(s);
const listEl = $("#list");
const detailEl = $("#detail");
const countEl = $("#count");
const onlyJsonEl = $("#onlyJson");
const filterEl = $("#filter");

function looksJson(mime) {
  return mime && /json|graphql/i.test(mime);
}

function parseMaybeJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function gqlOpName(reqBody) {
  const j = parseMaybeJson(reqBody);
  const node = Array.isArray(j) ? j[0] : j;
  if (!node || !node.query) return null;
  if (node.operationName) return node.operationName;
  const m = /(?:query|mutation|subscription)\s+([A-Za-z0-9_]+)/.exec(node.query);
  if (m) return m[1];
  const anon = /\b(mutation|query)\b/.exec(node.query);
  return anon ? anon[1] : "gql";
}

chrome.devtools.network.onRequestFinished.addListener((har) => {
  const req = har.request;
  const res = har.response;
  const url = req.url;
  const reqMime = (req.postData && req.postData.mimeType) || "";
  const resMime = (res.content && res.content.mimeType) || "";
  const reqBody = req.postData ? req.postData.text : null;

  const isGql = /graphql/i.test(url) || /graphql/i.test(reqMime) ||
    (reqBody && /"query"\s*:/.test(reqBody));

  const entry = {
    id: ++idSeq,
    method: req.method,
    url,
    status: res.status,
    reqHeaders: req.headers || [],
    reqBody,
    reqMime,
    resMime,
    resBody: null,
    isGql,
    isJson: isGql || looksJson(reqMime) || looksJson(resMime),
    gqlOp: isGql ? gqlOpName(reqBody) : null,
    ts: Date.now(),
  };
  entries.push(entry);

  har.getContent((content) => {
    entry.resBody = content || null;
    if (entry.id === selectedId) renderDetail(entry);
  });

  render();
});

function passesFilter(e) {
  if (onlyJsonEl.checked && !e.isJson) return false;
  const q = filterEl.value.trim().toLowerCase();
  if (!q) return true;
  return e.url.toLowerCase().includes(q) ||
    (e.gqlOp && e.gqlOp.toLowerCase().includes(q));
}

function shortPath(url) {
  try {
    const u = new URL(url);
    return u.pathname + (u.search ? u.search.slice(0, 40) : "");
  } catch { return url; }
}

function render() {
  const shown = entries.filter(passesFilter);
  countEl.textContent = shown.length;
  if (!shown.length) {
    listEl.innerHTML = '<div class="empty">No matching requests.</div>';
    return;
  }
  listEl.innerHTML = "";
  for (const e of shown) {
    const row = document.createElement("div");
    row.className = "row" + (e.isGql ? " gql" : "") + (e.id === selectedId ? " sel" : "");
    row.innerHTML =
      `<span class="method m-${e.method}">${e.method}</span>` +
      `<span class="status">${e.status || ""}</span>` +
      `<span class="path">${e.gqlOp ? '<span class="gqlop">' + e.gqlOp + "</span> " : ""}${escapeHtml(shortPath(e.url))}</span>`;
    row.onclick = () => { selectedId = e.id; render(); renderDetail(e); };
    listEl.appendChild(row);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function pretty(text) {
  const j = parseMaybeJson(text);
  return j ? JSON.stringify(j, null, 2) : (text || "");
}

function headersToObj(arr) {
  const o = {};
  for (const h of arr) o[h.name] = h.value;
  return o;
}

function renderDetail(e) {
  const h = headersToObj(e.reqHeaders);
  const interesting = ["x-csrf-token", "authorization", "content-type", "cookie"];
  const flagged = Object.keys(h).filter((k) => interesting.includes(k.toLowerCase()));

  detailEl.innerHTML = `
    <div class="field"><label>Method / URL</label>
      <pre>${e.method} ${escapeHtml(e.url)}</pre></div>
    ${flagged.length ? `<div class="field"><label>Auth-relevant headers</label>
      <pre>${escapeHtml(flagged.map((k) => k + ": " + h[k]).join("\n"))}</pre></div>` : ""}
    <h3>Request body</h3>
    <pre>${escapeHtml(pretty(e.reqBody)) || '<span class="muted">— none —</span>'}</pre>
    <h3>Response (${e.status})</h3>
    <pre>${escapeHtml(pretty(e.resBody)) || '<span class="muted">— loading / empty —</span>'}</pre>
    <h3>Replay / tamper</h3>
    <div class="warn">Runs in the page's own session. Only replay against assets you are authorized to test.</div>
    <div class="field"><label>URL</label>
      <input type="text" id="r-url" value="${escapeHtml(e.url)}"></div>
    <div class="field"><label>Method</label>
      <select id="r-method">
        ${["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) =>
          `<option ${m === e.method ? "selected" : ""}>${m}</option>`).join("")}
      </select></div>
    <div class="field"><label>Headers (JSON)</label>
      <textarea id="r-headers" rows="4">${escapeHtml(JSON.stringify(replayHeaders(h), null, 2))}</textarea></div>
    <div class="field"><label>Body</label>
      <textarea id="r-body" rows="5">${escapeHtml(e.reqBody || "")}</textarea></div>
    <div class="replaybar">
      <button id="r-send" class="accent">Send</button>
      <button id="r-copy">Copy this request for Claude</button>
    </div>
    <h3>Replay response</h3>
    <pre id="r-out"><span class="muted">— not sent —</span></pre>
  `;
  $("#r-send").onclick = () => doReplay(e);
  $("#r-copy").onclick = () => copyOrSave(JSON.stringify(exportEntry(e), null, 2), $("#r-copy"), "recon-request");
}

function replayHeaders(h) {
  const keep = {};
  for (const k of Object.keys(h)) {
    const lk = k.toLowerCase();
    if (lk === "cookie" || lk === "content-length" || lk.startsWith(":")) continue;
    keep[k] = h[k];
  }
  return keep;
}

const REPLAY_FN = function (id, method, url, headers, body) {
  window.__recon = window.__recon || {};
  window.__recon[id] = { done: false };
  (async () => {
    try {
      const opts = { method, headers, credentials: "include" };
      if (body && method !== "GET" && method !== "HEAD") opts.body = body;
      const r = await fetch(url, opts);
      const text = await r.text();
      window.__recon[id] = { done: true, status: r.status, body: text.slice(0, 200000) };
    } catch (err) {
      window.__recon[id] = { done: true, error: String(err) };
    }
  })();
  return true;
};

function evalInPage(expr) {
  return new Promise((resolve) => {
    chrome.devtools.inspectedWindow.eval(expr, (result, err) => {
      resolve(err ? { __evalError: err } : result);
    });
  });
}

async function runInPage(id, method, url, headers, body) {
  const call = `(${REPLAY_FN.toString()})(${JSON.stringify(id)},${JSON.stringify(method)},${JSON.stringify(url)},${JSON.stringify(headers)},${JSON.stringify(body)})`;
  await evalInPage(call);
  for (let i = 0; i < 100; i++) {
    const r = await evalInPage(`window.__recon && window.__recon[${JSON.stringify(id)}]`);
    if (r && r.done) return r;
    await new Promise((res) => setTimeout(res, 100));
  }
  return { error: "timeout after 10s" };
}

async function doReplay(e) {
  const out = $("#r-out");
  out.textContent = "sending…";
  let headers;
  try { headers = JSON.parse($("#r-headers").value); }
  catch { out.textContent = "Headers must be valid JSON."; return; }
  const rid = "replay_" + (++idSeq);
  const res = await runInPage(rid, $("#r-method").value, $("#r-url").value, headers, $("#r-body").value);
  if (res.error) { out.textContent = "ERROR: " + res.error; return; }
  out.textContent = "HTTP " + res.status + "\n\n" + pretty(res.body);
}

const INTROSPECTION = `query IntrospectionQuery {
  __schema {
    mutationType { fields { name args { name type { name kind ofType { name kind } } } } }
    queryType { fields { name args { name } } }
  }
}`;

async function introspect() {
  const gql = [...entries].reverse().find((e) => e.isGql);
  if (!gql) { alert("No GraphQL request captured yet. Trigger one in the page first."); return; }
  const h = replayHeaders(headersToObj(gql.reqHeaders));
  h["Content-Type"] = "application/json";
  const rid = "introspect_" + (++idSeq);
  const res = await runInPage(rid, "POST", gql.url, h, JSON.stringify({ query: INTROSPECTION }));
  const j = parseMaybeJson(res.body);
  const schema = j && j.data && j.data.__schema;
  if (!schema) {
    detailEl.innerHTML = `<div class="warn">Introspection failed or disabled.</div><pre>${escapeHtml((res.error || "") + "\n" + pretty(res.body))}</pre>`;
    return;
  }
  const muts = (schema.mutationType && schema.mutationType.fields) || [];
  const queries = (schema.queryType && schema.queryType.fields) || [];
  const fmtArgs = (a) => (a || []).map((x) => x.name).join(", ");
  lastSchema = {
    endpoint: gql.url,
    mutations: muts.map((m) => ({ name: m.name, args: (m.args || []).map((x) => x.name) })),
    queries: queries.map((q) => ({ name: q.name, args: (q.args || []).map((x) => x.name) })),
  };
  detailEl.innerHTML = `
    <h3>Endpoint</h3><pre>${escapeHtml(gql.url)}</pre>
    <h3>Mutations (${muts.length})</h3>
    <pre>${escapeHtml(muts.map((m) => m.name + "(" + fmtArgs(m.args) + ")").join("\n")) || "none"}</pre>
    <h3>Queries (${queries.length})</h3>
    <pre>${escapeHtml(queries.map((q) => q.name + "(" + fmtArgs(q.args) + ")").join("\n")) || "none"}</pre>`;
}

const BODY_CAP = 4000;      // per-body char cap in any export
const CLIP_MAX = 300000;    // refuse to copy anything larger; save to file instead
const REDACT = ["cookie", "set-cookie", "authorization", "x-csrf-token"];

function trimBody(raw) {
  if (raw == null) return null;
  const parsed = parseMaybeJson(raw);
  const s = parsed != null ? JSON.stringify(parsed) : String(raw);
  if (s.length <= BODY_CAP) return parsed != null ? parsed : raw;
  return { _truncated: true, chars: s.length, preview: s.slice(0, BODY_CAP) };
}

function safeHeaders(arr) {
  const o = {};
  for (const h of arr) o[h.name] = REDACT.includes(h.name.toLowerCase()) ? "[redacted]" : h.value;
  return o;
}

function exportEntry(e) {
  return {
    method: e.method, url: e.url, status: e.status,
    requestHeaders: safeHeaders(e.reqHeaders),
    requestBody: trimBody(e.reqBody),
    responseBody: trimBody(e.resBody),
    graphqlOperation: e.gqlOp,
  };
}

function downloadText(text, base) {
  const blob = new Blob([text], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${base}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function copyOrSave(text, btn, base) {
  if (text.length > CLIP_MAX) {
    downloadText(text, base);
    if (btn) { const t = btn.textContent; btn.textContent = `too big (${Math.round(text.length / 1024)}KB) → saved file`; setTimeout(() => (btn.textContent = t), 2500); }
    return;
  }
  copyText(text, btn);
}

const EXPORT_ENTRY_CAP = 200;       // max requests in a default (paste-safe) export
const EXPORT_CHAR_BUDGET = 250000;  // keep a default export under the clipboard gate

function exportPayload(all = false) {
  const full = entries.filter(passesFilter).map(exportEntry);
  const total = full.length;
  let shown = full;
  let capped = false;
  if (!all) {
    if (shown.length > EXPORT_ENTRY_CAP) { shown = shown.slice(-EXPORT_ENTRY_CAP); capped = true; }
    // drop oldest entries until the payload fits the paste-safe char budget
    while (shown.length > 1 && JSON.stringify(shown).length > EXPORT_CHAR_BUDGET) { shown = shown.slice(1); capped = true; }
  }
  return {
    note: "Captured API traffic for authorized security recon. Identify auth/authorization weaknesses, IDOR/BOLA candidates (tenant-local IDs, sequential IDs), sensitive data exposure, and interesting undocumented operations.",
    origin: shown[0] ? new URL(shown[0].url).origin : null,
    count: shown.length,
    totalCaptured: total,
    capped,
    ...(capped ? { cappedNote: `Showing most-recent ${shown.length} of ${total} captured requests. Use Save JSON for the full set.` } : {}),
    requests: shown,
  };
}

async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    if (btn) { const t = btn.textContent; btn.textContent = "copied ✓"; setTimeout(() => (btn.textContent = t), 1200); }
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text; document.body.appendChild(ta); ta.select();
    document.execCommand("copy"); ta.remove();
  }
}

function saveJson() {
  downloadText(JSON.stringify(exportPayload(true), null, 2), "recon");
}

$("#clear").onclick = () => { entries.length = 0; selectedId = null; render(); detailEl.innerHTML = '<div class="empty">Select a request.</div>'; };
$("#onlyJson").onchange = render;
$("#filter").oninput = render;
$("#copyAll").onclick = () => copyOrSave(JSON.stringify(exportPayload(), null, 2), $("#copyAll"), "recon");
$("#saveAll").onclick = saveJson;
$("#introspect").onclick = introspect;

render();

/* ---------- Tabs ---------- */
document.querySelectorAll(".tab").forEach((t) => {
  t.onclick = () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
    document.querySelectorAll(".view").forEach((x) => x.classList.remove("active"));
    t.classList.add("active");
    document.getElementById(t.dataset.view).classList.add("active");
  };
});

/* ---------- Injected in-page SDK (runs in the target's main world) ---------- */
function __reconSDK(runId) {
  window.__recon = window.__recon || {};
  const slot = (window.__recon[runId] = { done: false, logs: [], error: null });
  const str = (x) => { try { return typeof x === "string" ? x : JSON.stringify(x); } catch { return String(x); } };
  window.recon = {
    params: {},
    log: function () { slot.logs.push(Array.prototype.map.call(arguments, str).join(" ")); },
    csrf: function (name) {
      name = name || "CSRF-TOKEN";
      const m = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
      return m ? decodeURIComponent(m[1]) : null;
    },
    json: async function (url, opts) {
      opts = opts || {};
      if (opts.credentials === undefined) opts.credentials = "include";
      const r = await fetch(url, opts);
      const t = await r.text();
      let body; try { body = JSON.parse(t); } catch { body = t; }
      return { status: r.status, ok: r.ok, body };
    },
    gql: async function (url, query, variables, headers) {
      const h = Object.assign({ "Content-Type": "application/json" }, headers || {});
      const tok = this.csrf();
      if (tok && !h["X-CSRF-Token"]) h["X-CSRF-Token"] = tok;
      const r = await fetch(url, { method: "POST", credentials: "include", headers: h, body: JSON.stringify({ query, variables: variables || {} }) });
      const t = await r.text();
      let body;
      try { body = JSON.parse(t); }
      catch { throw new Error("non-JSON response (" + r.status + "): " + t.slice(0, 300)); }
      if (body.errors) this.log("GraphQL errors:", body.errors);
      return body;
    },
    resolveByName: function (arr, name, opts) {
      opts = opts || {};
      const keys = opts.keys || ["name", "title", "displayName"];
      const want = String(name).toLowerCase();
      const hit = (arr || []).find((n) => keys.some((k) => n[k] != null && String(n[k]).toLowerCase() === want));
      if (!hit && opts.required !== false) throw new Error('resolveByName: no match for "' + name + '"');
      return hit ? (opts.field ? hit[opts.field] : hit) : null;
    },
  };
}

/* ---------- Write-gate heuristic ---------- */
function writeGate(code) {
  const reasons = [];
  if (/method\s*:\s*['"`](POST|PUT|PATCH|DELETE)/i.test(code)) reasons.push("non-GET fetch method");
  if (/\bmutation\b/i.test(code)) reasons.push('"mutation" keyword');
  if (/\bDELETE\b/.test(code)) reasons.push("DELETE reference");
  return { flagged: reasons.length > 0, reasons };
}

function renderGateBox() {
  const box = $("#gate-box");
  const g = writeGate($("#s-code").value);
  if (!g.flagged) { box.innerHTML = ""; return; }
  box.innerHTML = `<div class="gate">Possible <b>write</b> detected (${g.reasons.join(", ")}). Heuristic, not a guarantee — read the script.
    <label class="chk" style="margin-top:4px;"><input type="checkbox" id="gate-ok"> I authorize this script to make changes on an asset I'm allowed to modify.</label></div>`;
}

/* ---------- Script runner ---------- */
async function runScript() {
  const code = $("#s-code").value;
  const g = writeGate(code);
  if (g.flagged) {
    const ok = document.getElementById("gate-ok");
    if (!ok || !ok.checked) { $("#log").textContent = "Blocked: write detected — tick the authorize box first."; return; }
  }
  const params = collectParams();
  const runId = "run_" + (++idSeq);
  const logEl = $("#log");
  logEl.textContent = "running…";
  const harness =
    `(async function(){ (${__reconSDK.toString()})(${JSON.stringify(runId)});` +
    ` window.recon.params = ${JSON.stringify(params)};` +
    ` var slot = window.__recon[${JSON.stringify(runId)}];` +
    ` try { await (async function(){\n${code}\n})(); slot.ok = true; }` +
    ` catch(e){ slot.error = String(e && e.stack ? e.stack : e); } slot.done = true; })();`;
  await evalInPage(harness);
  for (let i = 0; i < 900; i++) {
    const slot = await evalInPage(`window.__recon && window.__recon[${JSON.stringify(runId)}]`);
    if (slot) {
      const lines = (slot.logs || []).join("\n");
      logEl.textContent = (lines || "(no output yet)") +
        (slot.done ? (slot.error ? "\n\nERROR: " + slot.error : "\n\n✓ done") : "\n…");
      if (slot.done) return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  logEl.textContent += "\n\n(timeout after 90s — script may still be running in the page)";
}

/* ---------- Parameters ---------- */
function addParamRow(k, v) {
  const row = document.createElement("div");
  row.className = "params-row";
  row.innerHTML =
    `<input type="text" class="p-k" placeholder="key" value="${escapeHtml(k || "")}">` +
    `<input type="text" class="p-v" placeholder="value" value="${escapeHtml(v || "")}">` +
    `<button class="p-x">✕</button>`;
  row.querySelector(".p-x").onclick = () => row.remove();
  $("#params-rows").appendChild(row);
}

function collectParams() {
  const o = {};
  $("#params-rows").querySelectorAll(".params-row").forEach((r) => {
    const k = r.querySelector(".p-k").value.trim();
    if (k) o[k] = r.querySelector(".p-v").value;
  });
  return o;
}

function currentParamsList() {
  return Array.from($("#params-rows").querySelectorAll(".params-row"))
    .map((r) => ({ k: r.querySelector(".p-k").value, v: r.querySelector(".p-v").value }))
    .filter((p) => p.k.trim());
}

/* ---------- Script library (chrome.storage.local) ---------- */
const STORE_KEY = "recon_scripts";
let scripts = [];
let currentScriptId = null;

function loadLib() {
  chrome.storage.local.get(STORE_KEY, (r) => {
    scripts = r[STORE_KEY] || [];
    renderLib();
  });
}

function persistLib() {
  chrome.storage.local.set({ [STORE_KEY]: scripts });
}

function renderLib() {
  const el = $("#lib-list");
  el.innerHTML = "";
  if (!scripts.length) { el.innerHTML = '<div class="muted" style="padding:6px;">No saved scripts.</div>'; return; }
  for (const s of scripts) {
    const d = document.createElement("div");
    d.className = "libitem" + (s.id === currentScriptId ? " sel" : "");
    d.textContent = s.name || "untitled";
    d.onclick = () => selectScript(s.id);
    el.appendChild(d);
  }
}

function selectScript(id) {
  const s = scripts.find((x) => x.id === id);
  if (!s) return;
  currentScriptId = id;
  $("#s-name").value = s.name || "";
  $("#s-code").value = s.code || "";
  $("#params-rows").innerHTML = "";
  (s.params || []).forEach((p) => addParamRow(p.k, p.v));
  renderGateBox();
  renderLib();
}

function newScript() {
  currentScriptId = null;
  $("#s-name").value = "";
  $("#s-code").value = "";
  $("#params-rows").innerHTML = "";
  $("#gate-box").innerHTML = "";
  $("#log").textContent = "— not run —";
  renderLib();
}

function saveScript() {
  const rec = {
    id: currentScriptId || "s_" + Date.now(),
    name: $("#s-name").value.trim() || "untitled",
    code: $("#s-code").value,
    params: currentParamsList(),
  };
  const i = scripts.findIndex((x) => x.id === rec.id);
  if (i >= 0) scripts[i] = rec; else scripts.push(rec);
  currentScriptId = rec.id;
  persistLib();
  renderLib();
}

function deleteScript() {
  if (!currentScriptId) { newScript(); return; }
  scripts = scripts.filter((x) => x.id !== currentScriptId);
  persistLib();
  newScript();
}

/* ---------- Context bundle for Claude ---------- */
function bundleForClaude() {
  const shown = entries.filter(passesFilter).slice(-15).map(exportEntry);
  const origin = shown[0] ? new URL(shown[0].url).origin : (lastSchema ? new URL(lastSchema.endpoint).origin : null);
  const preamble =
`Write a script for my "Recon Console" script runner. It runs in the page's already-authenticated session. Do NOT write a standalone fetch script or a Node script — write the body only, using these injected helpers:

- await recon.gql(url, query, variables?, headers?)  // GraphQL POST, auto-attaches X-CSRF-Token from cookie, throws on non-JSON (e.g. 403 HTML)
- await recon.json(url, opts?)                        // fetch w/ credentials:'include' -> {status, ok, body}
- recon.csrf(name?)                                   // CSRF token from cookie
- recon.resolveByName(arr, name, {keys?, field?, required?})  // resolve tenant-local IDs by name/title/displayName at runtime
- recon.log(...args)                                  // prints to the run log
- recon.params                                        // object from the Parameters form

Rules:
- Resolve every ID at runtime by name. IDs are tenant-local — never hardcode them.
- Read what you need first (context queries), then act.
- Anything that writes, isolate clearly.

TASK: <describe what you want automated here>

Captured context from the live session:`;
  const bundle = { origin, schema: lastSchema, sampleRequests: shown };
  return preamble + "\n\n```json\n" + JSON.stringify(bundle, null, 2) + "\n```";
}

/* ---------- Scripts view bindings ---------- */
$("#add-param").onclick = () => addParamRow("", "");
$("#s-code").oninput = renderGateBox;
$("#s-run").onclick = runScript;
$("#s-save").onclick = saveScript;
$("#s-delete").onclick = deleteScript;
$("#new-script").onclick = newScript;
$("#s-bundle").onclick = () => copyOrSave(bundleForClaude(), $("#s-bundle"), "recon-context");
loadLib();
