# Recon Console — Chrome/Brave extension

Session-riding recon **and scripted automation** for **authorized** security testing and admin-console work. Turns the DevTools-console-paste workflow into a DevTools panel with two tabs:

- **Capture** — capture the site's own API traffic, run GraphQL introspection, replay/tamper requests inside the page's real session.
- **Scripts** — describe a task → let Claude write it → paste it in → run it in-session, with saved+parameterized scripts and a write-gate. No stored creds, no console copy-paste.

## Why a panel beats console paste

- Captures at the network layer, so it sees **all frames** (the same-origin iframe blind spot that killed the fetch-hook logger is gone).
- No "Save ALL As HAR" ritual — traffic streams into the panel live.
- Replay runs via `inspectedWindow.eval` in the page's main world, so it rides the existing session cookie / CSRF token exactly like a console `fetch` would.

## Install (Chrome or Brave)

1. Go to `chrome://extensions` (Brave: `brave://extensions`).
2. Toggle **Developer mode** on (top right).
3. Click **Load unpacked** and select this `recon-extension` folder.
4. Open DevTools (F12) on your target tab → **Recon** panel.

No icons are bundled; the extension loads fine without them.

## Use

1. Open the Recon panel, then reload/interact with the target page — requests stream into the left list. GraphQL ops show their operation name in orange.
2. Click a request to see request/response, plus auto-flagged auth headers (`X-CSRF-Token`, `Authorization`, `Content-Type`).
3. **Introspect GraphQL** reuses a captured GraphQL request's headers to run a schema introspection and list every mutation + query with args. (Silent fail = introspection disabled, itself worth noting.)
4. **Replay / tamper** — edit method/URL/headers/body and Send. The `Cookie` header is stripped from the editor because the browser attaches the real session cookie automatically. This is where you swap an ID and watch for broken object-level auth.
5. **Copy for Claude** / **Save JSON** export the filtered set as clean JSON with a recon-analysis preamble — paste into Claude or save to the target's folder.

## Scripts tab

The loop you already run by hand, made repeatable:

1. In **Capture**, trigger the relevant requests and (for GraphQL) hit **Introspect** so the schema is known.
2. In **Scripts**, click **Bundle context for Claude** — copies a prompt + the captured schema/requests. Paste into Claude, describe the task, get a script back.
3. Paste the script into the editor, add any **Parameters** (name → value), **Save**, **Run**. Output streams into the Run log.

Scripts run in the page's session via an injected `recon` helper (main-world `inspectedWindow.eval`), so they ride the existing cookie/CSRF exactly like a console paste:

- `await recon.gql(url, query, variables?, headers?)` — GraphQL POST; auto-attaches `X-CSRF-Token` from cookie; **throws on non-JSON** (the 403-HTML-crashes-`r.json()` trap, handled once).
- `await recon.json(url, opts?)` — fetch with `credentials:'include'` → `{status, ok, body}`.
- `recon.csrf(name?)` — CSRF token from cookie.
- `recon.resolveByName(arr, name, {keys?, field?, required?})` — resolve **tenant-local IDs at runtime** by name/title/displayName. Never hardcode IDs.
- `recon.log(...args)` — stream to the Run log.
- `recon.params` — object from the Parameters form.

**Write-gate:** if the script looks like it writes (non-GET method, `mutation` keyword, `DELETE`), Run is blocked until you tick the authorize box. It's a heuristic, not a guarantee — read the script. Saved scripts persist in `chrome.storage.local`; store the *script*, never the IDs.

## Guardrail

Replay executes real authenticated requests against whatever origin you point it at. Only use it against assets explicitly **in scope** for a program you're authorized to test — or your own systems. Session-riding an out-of-scope app is unauthorized access, full stop. For tenant-isolation / cross-tenant IDOR testing, use two accounts **you** control; never touch another real tenant's data.

## Known limits / next

- Exports cap each request/response body at 4,000 chars (truncated bodies show `_truncated` + char count). Replay responses cap at ~200KB in the panel view.
- **Every clipboard path is gated.** Copy for Claude, Bundle context, and the per-request "Copy this request for Claude" all route through the ~300KB clipboard gate — anything larger auto-saves a `.json` file instead. On top of that, **Copy for Claude** caps the aggregate to the most-recent 200 requests / ~250KB (flagged with `capped` + `cappedNote`) so a normal copy is always paste-safe. Noisy APIs (YouTube's innertube, etc.) hit this fast.
- **Save JSON** is the full, unbounded export — deliberately not capped. Don't open it and paste the contents into a chat; multi-MB JSON crashes it. Feed the saved file to Claude as a file, not a paste.
- Exports **redact** `Cookie`, `Set-Cookie`, `Authorization`, and `X-CSRF-Token` values (keys kept so shape is visible). Never paste live session secrets into a chat.
- No request diffing yet (capture A vs replay B). Candidate for next.
- No fuzz/batch — deliberately out of scope until offensive use is on the table.
- Replay polls up to 10s for async results; scripts poll up to 90s. Very slow endpoints time out (the work may still finish in the page).
- Write-gate is a static heuristic — it can miss obfuscated writes and false-flag reads. Read the script.
- File-input `.click()` from a script needs a user gesture; inject a button the user clicks (same limitation as console paste).
