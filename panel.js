const entries = [];
let selectedId = null;
let idSeq = 0;
let lastSchema = null;

const MAX_RAW = 1000;        // ring-buffer cap on raw entries kept in the panel
let digest = newDigest();

// Callback-style storage wrappers. chrome.storage returns a Promise in Chrome
// MV3 but is callback-only under Firefox's chrome.* alias. We normalize to
// callbacks, which both browsers honor, and wrap them once here.
const storageGet = (keys) => new Promise((res) => chrome.storage.local.get(keys, res));
const storageSet = (obj) => new Promise((res) => chrome.storage.local.set(obj, res));

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
    resHeaders: res.headers || [],
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
  if (entries.length > MAX_RAW) entries.shift();
  ingestRequest(entry);

  har.getContent((content) => {
    entry.resBody = content || null;
    ingestResponse(entry);
    scheduleDigest();
    maybeAutoSave();
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
      `<span class="method m-${escapeHtml(e.method)}">${escapeHtml(e.method)}</span>` +
      `<span class="status">${e.status || ""}</span>` +
      `<span class="path">${e.gqlOp ? '<span class="gqlop">' + escapeHtml(e.gqlOp) + "</span> " : ""}${escapeHtml(shortPath(e.url))}</span>`;
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
      <pre>${escapeHtml(e.method)} ${escapeHtml(e.url)}</pre></div>
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
      <button id="r-copy">Copy this request for LLM</button>
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

function downloadText(text, base, ext, mime) {
  ext = ext || "json";
  const blob = new Blob([text], { type: mime || "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${base}-${new Date().toISOString().replace(/[:.]/g, "-")}.${ext}`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function copyOrSave(text, btn, base, ext, mime) {
  if (text.length > CLIP_MAX) {
    downloadText(text, base, ext, mime);
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

/* ---------- Injected in-page SDK ---------- */
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

/* ---------- Context bundle for LLM ---------- */
function bundleForLLM() {
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
$("#s-bundle").onclick = () => copyOrSave(bundleForLLM(), $("#s-bundle"), "recon-context");
loadLib();

/* ================== Passive recon digest ==================
   Every finished request folds into a deduped attack-surface map.
   Bodies never leave the panel. The digest is signal only, so it
   stays a few KB and is safe to paste into a chat. */

function newDigest() {
  return {
    totalRequests: 0,
    firstSeen: null,
    lastSeen: null,
    hosts: new Set(),
    origins: {},   // origin -> { count, secSeen:Set }
    surface: {},   // "METHOD host/template" -> aggregate
    gql: {},       // endpoint -> Set(op names)
    auth: { schemes: new Set(), jwtAlgs: new Set(), jwtClaims: new Set(), csrf: false, cookie: false, bearer: false },
    flags: {},     // signalType -> { count, examples:Set }
    idParams: new Set(),
  };
}

const SURFACE_CAP = 500;
const SET_CAP = 40;
const EX_CAP = 5;
const DIGEST_MAX = 180000;

function capAdd(set, val, max) {
  if (set.size < (max || SET_CAP)) set.add(val);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function templatePath(pathname) {
  return pathname.split("/").map((seg) => {
    if (!seg) return seg;
    if (/^\d+$/.test(seg)) return ":id";
    if (UUID_RE.test(seg)) return ":uuid";
    if (/^[0-9a-f]{24,}$/i.test(seg)) return ":hex";
    if (seg.length >= 20 && /[0-9]/.test(seg) && /[A-Za-z]/.test(seg) && /^[A-Za-z0-9_-]+$/.test(seg)) return ":token";
    return seg;
  }).join("/");
}

function isIdParamName(k) {
  return /(_id$|^id$|^ids$|uuid|guid|tenant|account|acct|^user$|^org$|^oid$|^pid$|^gid$|customer|member)/i.test(k);
}

function b64urlDecode(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  try { return decodeURIComponent(escape(atob(s))); } catch { try { return atob(s); } catch { return null; } }
}

function decodeJwt(tok) {
  const parts = tok.split(".");
  if (parts.length < 2) return null;
  try {
    const header = JSON.parse(b64urlDecode(parts[0]) || "{}");
    const payload = JSON.parse(b64urlDecode(parts[1]) || "{}");
    return { alg: header.alg || "?", claims: Object.keys(payload) };
  } catch { return null; }
}

const JWT_RE = /eyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g;

const SIGNAL_RES = [
  ["email", /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g],
  ["awsAccessKey", /AKIA[0-9A-Z]{16}/g],
  ["googleApiKey", /AIza[0-9A-Za-z_-]{35}/g],
  ["privateKey", /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ["s3Url", /(?:[a-z0-9.-]+\.s3[.-][a-z0-9-]*\.amazonaws\.com|s3:\/\/)/gi],
  ["internalIp", /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g],
  ["stackTrace", /(?:Traceback \(most recent call last\)|Exception in thread|\bat [\w.$]+\([\w.]+\.(?:java|kt|rb|py|php):\d+\)|System\.[A-Za-z.]+Exception)/g],
  ["secretKeyName", /"(?:api[_-]?key|secret|client[_-]?secret|access[_-]?token|refresh[_-]?token|password|passwd|pwd)"\s*:/gi],
];

const SEC_HEADERS = ["content-security-policy", "strict-transport-security", "x-content-type-options", "x-frame-options", "referrer-policy", "permissions-policy"];

function headerVal(arr, name) {
  const h = (arr || []).find((x) => x.name.toLowerCase() === name);
  return h ? h.value : null;
}

function shortLoc(method, host, tpl) {
  return `${method} ${host}${tpl}`;
}

function addFlag(type, loc) {
  const f = digest.flags[type] || (digest.flags[type] = { count: 0, examples: new Set() });
  f.count++;
  capAdd(f.examples, loc, EX_CAP);
}

function ingestRequest(e) {
  digest.totalRequests++;
  const now = e.ts || Date.now();
  if (!digest.firstSeen) digest.firstSeen = now;
  digest.lastSeen = now;

  let u;
  try { u = new URL(e.url); } catch { return; }
  const host = u.host;
  const origin = u.origin;
  digest.hosts.add(host);
  const o = digest.origins[origin] || (digest.origins[origin] = { count: 0, secSeen: new Set() });
  o.count++;

  const tpl = templatePath(u.pathname);
  const key = e.method + " " + host + tpl;
  let s = digest.surface[key];
  if (!s) {
    if (Object.keys(digest.surface).length >= SURFACE_CAP) { digest._surfaceTruncated = true; }
    else s = digest.surface[key] = { method: e.method, host, template: tpl, count: 0, statuses: new Set(), queryKeys: new Set(), bodyKeys: new Set(), idParams: new Set(), gqlOps: new Set(), hasPathId: tpl !== u.pathname };
  }
  if (s) {
    s.count++;
    if (e.status) s.statuses.add(e.status);
    u.searchParams.forEach((val, k) => {
      capAdd(s.queryKeys, k);
      if (isIdParamName(k) || /^\d+$/.test(val)) { s.idParams.add(k); capAdd(digest.idParams, shortLoc(e.method, host, tpl) + "?" + k); }
    });
    const jb = parseMaybeJson(e.reqBody);
    if (jb && typeof jb === "object" && !Array.isArray(jb)) {
      for (const k of Object.keys(jb)) {
        capAdd(s.bodyKeys, k);
        if (isIdParamName(k)) { s.idParams.add(k); capAdd(digest.idParams, shortLoc(e.method, host, tpl) + " {" + k + "}"); }
      }
    }
    if (e.gqlOp) {
      s.gqlOps.add(e.gqlOp);
      const ep = digest.gql[e.url.split("?")[0]] || (digest.gql[e.url.split("?")[0]] = new Set());
      capAdd(ep, e.gqlOp, 60);
    }
  }

  const auth = headerVal(e.reqHeaders, "authorization");
  if (auth) {
    const scheme = auth.split(" ")[0];
    digest.auth.schemes.add(scheme);
    if (/^bearer$/i.test(scheme)) {
      digest.auth.bearer = true;
      const m = auth.match(JWT_RE);
      if (m) { const j = decodeJwt(m[0]); if (j) { digest.auth.jwtAlgs.add(j.alg); j.claims.forEach((c) => capAdd(digest.auth.jwtClaims, c)); } }
    }
  }
  if (headerVal(e.reqHeaders, "x-csrf-token")) { digest.auth.csrf = true; digest.auth.schemes.add("csrf"); }
  if (headerVal(e.reqHeaders, "cookie")) { digest.auth.cookie = true; }

  for (const hh of e.resHeaders || []) {
    const n = hh.name.toLowerCase();
    if (SEC_HEADERS.includes(n)) o.secSeen.add(n);
  }
  const acao = headerVal(e.resHeaders, "access-control-allow-origin");
  if (acao === "*") addFlag("corsWildcard", shortLoc(e.method, host, tpl));
}

function ingestResponse(e) {
  const text = e.resBody;
  if (!text || typeof text !== "string") return;
  let host = "", tpl = "";
  try { const u = new URL(e.url); host = u.host; tpl = templatePath(u.pathname); } catch {}
  const loc = shortLoc(e.method, host, tpl);
  const sample = text.slice(0, 200000);
  for (const [type, re] of SIGNAL_RES) {
    re.lastIndex = 0;
    if (re.test(sample)) addFlag(type, loc);
  }
  JWT_RE.lastIndex = 0;
  const jm = sample.match(JWT_RE);
  if (jm) { addFlag("jwtInBody", loc); const j = decodeJwt(jm[0]); if (j) { digest.auth.jwtAlgs.add(j.alg); j.claims.forEach((c) => capAdd(digest.auth.jwtClaims, c)); } }
}

function surfaceScore(s) {
  return (s.idParams.size || s.hasPathId ? 100 : 0) + (s.method !== "GET" ? 10 : 0) + Math.min(9, s.count);
}

function fmtTs(t) {
  return t ? new Date(t).toISOString().replace("T", " ").slice(0, 19) : "—";
}

const DIGEST_PREAMBLE =
`Passive recon digest of a site I'm authorized to test. This is a deduped map of the attack surface — endpoint templates (IDs collapsed to :id/:uuid), observed params, and signal flags. It is not raw request/response bodies. From this, identify and RANK by likelihood x impact:
- IDOR/BOLA: id-bearing endpoints (marked *), tenant-local or sequential IDs — which to swap and how.
- Broken auth / authz: JWT alg + claims, endpoints that should require authz.
- Sensitive data exposure: flagged signals (emails, keys, internal IPs, stack traces).
- Risky CORS (corsWildcard) and missing security headers.
- Undocumented / high-value operations (GraphQL mutations, admin-looking paths).
For each candidate give: the endpoint, why it's suspicious, and the exact request to try. Ask me to pull the full body from the panel for anything you need to see in detail.`;

function buildDigest() {
  const hosts = [...digest.hosts];
  const surf = Object.values(digest.surface).sort((a, b) => surfaceScore(b) - surfaceScore(a) || b.count - a.count);
  const L = [];
  L.push(DIGEST_PREAMBLE, "", "# Recon digest");
  L.push(`Hosts: ${hosts.join(", ") || "—"}`);
  L.push(`Requests: ${digest.totalRequests} | Unique endpoints: ${surf.length} | Window: ${fmtTs(digest.firstSeen)} -> ${fmtTs(digest.lastSeen)}`);
  L.push("");
  L.push("## Attack surface (deduped, IDs collapsed)");
  L.push("`*` = carries an ID (IDOR/BOLA candidate). x = times seen. [] = statuses.");
  L.push("");
  const cap = 200;
  for (const s of surf.slice(0, cap)) {
    const mark = (s.idParams.size || s.hasPathId) ? "* " : "";
    const p = [];
    if (s.queryKeys.size) p.push("q: " + [...s.queryKeys].join(","));
    if (s.bodyKeys.size) p.push("body: " + [...s.bodyKeys].join(","));
    if (s.gqlOps.size) p.push("gql: " + [...s.gqlOps].join(","));
    L.push(`- ${mark}\`${s.method} ${s.host}${s.template}\` x${s.count} [${[...s.statuses].join(",")}]${p.length ? " -- " + p.join(" | ") : ""}`);
  }
  if (surf.length > cap || digest._surfaceTruncated) L.push(`- ...more endpoints truncated. Use Save digest or the Capture tab for the full set.`);

  const gqlEndpoints = Object.keys(digest.gql);
  if (gqlEndpoints.length) {
    L.push("", "## GraphQL");
    for (const ep of gqlEndpoints) L.push(`- ${ep} -- ops: ${[...digest.gql[ep]].join(", ")}`);
    L.push("  (Run Introspect on the Capture tab to dump the full schema.)");
  }

  L.push("", "## Auth surface");
  L.push(`- Schemes: ${[...digest.auth.schemes].join(", ") || "none observed"}`);
  L.push(`- Cookie: ${digest.auth.cookie ? "yes" : "no"} | CSRF header: ${digest.auth.csrf ? "yes" : "no"} | Bearer: ${digest.auth.bearer ? "yes" : "no"}`);
  if (digest.auth.jwtAlgs.size) L.push(`- JWT alg: ${[...digest.auth.jwtAlgs].join(", ")} | claims: ${[...digest.auth.jwtClaims].join(", ")}`);

  const flagTypes = Object.keys(digest.flags);
  if (flagTypes.length) {
    L.push("", "## Signal flags (value redacted; location = endpoint)");
    for (const t of flagTypes) { const f = digest.flags[t]; L.push(`- ${t} x${f.count} -- e.g. ${[...f.examples].join(" ; ")}`); }
  }

  const missLines = [];
  for (const origin of Object.keys(digest.origins)) {
    const seen = digest.origins[origin].secSeen;
    const missing = SEC_HEADERS.filter((h) => !seen.has(h));
    if (missing.length) missLines.push(`- ${origin}: ${missing.join(", ")}`);
  }
  if (missLines.length) { L.push("", "## Security headers never observed (per origin)"); L.push(...missLines); }

  if (digest.idParams.size) {
    L.push("", "## ID-bearing params (IDOR targets)");
    L.push("- " + [...digest.idParams].join("\n- "));
  }

  let out = L.join("\n");
  if (out.length > DIGEST_MAX) out = out.slice(0, DIGEST_MAX) + "\n\n...digest truncated at " + DIGEST_MAX + " chars. Use Save digest for the full file.";
  return out;
}

function digestBase() {
  const h = primaryHost();
  return "recon-digest" + (h ? "-" + h.replace(/[^a-z0-9.-]/gi, "_") : "");
}
function primaryHost() {
  let best = null, n = -1;
  for (const origin of Object.keys(digest.origins)) {
    if (digest.origins[origin].count > n) { n = digest.origins[origin].count; best = origin; }
  }
  try { return best ? new URL(best).host : null; } catch { return null; }
}

/* ---------- live render (throttled) ---------- */
let digestTimer = null, digestDirty = false;
function scheduleDigest() {
  digestDirty = true;
  if (digestTimer) return;
  digestTimer = setTimeout(() => { digestTimer = null; if (digestDirty) { digestDirty = false; renderDigest(); } }, 500);
}
function renderDigest() {
  const req = $("#dg-req"), ep = $("#dg-ep"), out = $("#digest-out");
  if (req) req.textContent = digest.totalRequests;
  if (ep) ep.textContent = Object.keys(digest.surface).length;
  if (out && digest.totalRequests) out.textContent = buildDigest();
}

/* ---------- save target: chosen folder or Downloads ---------- */
let dirHandle = null;

function idbOpen() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("recon", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbSet(k, v) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const t = db.transaction("kv", "readwrite");
    t.objectStore("kv").put(v, k);
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
  });
}
async function idbGet(k) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const t = db.transaction("kv", "readonly");
    const rq = t.objectStore("kv").get(k);
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
}

function setFolderLabel(text) {
  const el = $("#dg-folder");
  if (el) el.textContent = text;
}

async function dirReady(canPrompt) {
  if (!dirHandle) return false;
  const opts = { mode: "readwrite" };
  try {
    if ((await dirHandle.queryPermission(opts)) === "granted") return true;
    if (canPrompt && (await dirHandle.requestPermission(opts)) === "granted") return true;
  } catch { /* handle stale */ }
  return false;
}

async function pickSaveDir() {
  if (!window.showDirectoryPicker) { alert("This browser build has no folder picker. Files will go to Downloads."); return; }
  try {
    const h = await window.showDirectoryPicker({ mode: "readwrite", id: "recon-digest" });
    dirHandle = h;
    await idbSet("dirHandle", h);
    await storageSet({ recon_dir_name: h.name });
    setFolderLabel("Folder: " + h.name);
  } catch (e) {
    if (e && e.name !== "AbortError") alert("Folder pick failed: " + e);
  }
}

// Write text to the chosen folder if usable; else fall back to a Downloads blob.
// overwrite=true reuses a stable filename (auto-save); else timestamps (manual snapshot).
async function writeDigestFile(text, overwrite, btn) {
  const base = digestBase();
  if (await dirReady(!overwrite)) {   // only prompt for permission on a user-gesture (manual) save
    const name = overwrite ? base + ".md" : base + "-" + new Date().toISOString().replace(/[:.]/g, "-") + ".md";
    try {
      const fh = await dirHandle.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      await w.write(text);
      await w.close();
      if (btn) { const t = btn.textContent; btn.textContent = "saved → " + dirHandle.name; setTimeout(() => (btn.textContent = t), 1500); }
      return;
    } catch (e) { /* fall through to Downloads */ }
  }
  downloadText(text, base, "md", "text/markdown");
  if (btn) { const t = btn.textContent; btn.textContent = "saved → Downloads"; setTimeout(() => (btn.textContent = t), 1500); }
}

/* ---------- auto-save ---------- */
let lastAutoSaveCount = 0, lastAutoSaveTs = 0;
function maybeAutoSave() {
  const cb = $("#dg-autosave");
  if (!cb || !cb.checked) return;
  const now = Date.now();
  if (digest.totalRequests - lastAutoSaveCount >= 150 && now - lastAutoSaveTs >= 60000) {
    lastAutoSaveCount = digest.totalRequests;
    lastAutoSaveTs = now;
    writeDigestFile(buildDigest(), true);
  }
}

/* ---------- digest view bindings ---------- */
$("#dg-copy").onclick = () => copyOrSave(buildDigest(), $("#dg-copy"), digestBase(), "md", "text/markdown");
$("#dg-save").onclick = () => writeDigestFile(buildDigest(), false, $("#dg-save"));
$("#dg-folder-btn").onclick = () => pickSaveDir();
(async () => {
  try {
    const h = await idbGet("dirHandle");
    if (h) {
      dirHandle = h;
      const r = await storageGet("recon_dir_name");
      setFolderLabel("Folder: " + (r.recon_dir_name || h.name) + " (re-grant on first save)");
    }
  } catch { /* no saved handle */ }
})();
$("#dg-clear").onclick = () => {
  digest = newDigest();
  entries.length = 0;
  selectedId = null;
  lastAutoSaveCount = 0;
  render();
  detailEl.innerHTML = '<div class="empty">Select a request.</div>';
  renderDigest();
  $("#digest-out").innerHTML = '<span class="muted">Cleared. Browse to rebuild the digest.</span>';
};
