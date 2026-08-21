# Recon Console (Chrome/Brave extension)

Session-riding recon and scripted automation for authorized security testing and admin-console work. It turns the DevTools-console-paste workflow into a DevTools panel with three tabs:

- **Capture**: grab the site's own API traffic, run GraphQL introspection, and replay or tamper requests inside the page's real session.
- **Digest**: passive. Just browse — every request folds into a deduped attack-surface map (endpoint templates with IDs collapsed, observed params, IDOR/JWT/secret/PII flags, missing security headers, GraphQL ops). This is the AI-ready paste: a few KB of pure signal instead of MB of bodies, so it never crashes a chat.
- **Scripts**: describe a task, let Claude write it, paste it in, and run it in-session, with saved and parameterized scripts plus a write-gate. No stored creds, no console copy-paste.

## Why a panel beats console paste

- Captures at the network layer, so it sees all frames. The same-origin iframe blind spot that killed the fetch-hook logger is gone.
- No "Save ALL As HAR" ritual. Traffic streams into the panel live.
- Replay runs via `inspectedWindow.eval` in the page's main world, so it rides the existing session cookie and CSRF token exactly like a console `fetch` would.

## Install (Chrome or Brave)

1. Go to `chrome://extensions` (Brave: `brave://extensions`).
2. Toggle Developer mode on (top right).
3. Click Load unpacked and select this `recon-extension` folder.
4. Open DevTools (F12) on your target tab and pick the Recon panel.

No icons are bundled; the extension loads fine without them.

## Digest (start here — the passive path)

1. Open the Recon panel on your authorized target and switch to the **Digest** tab. That's the only setup.
2. Browse the site normally. The counter (`N reqs · M endpoints`) ticks up and the digest rebuilds live. No clicking rows, no toggles.
3. When you've covered the surface you care about, hit **Copy digest for Claude** and paste. The digest carries its own analysis preamble, so Claude ranks IDOR/BOLA, broken-auth, data-exposure, CORS, and missing-header candidates straight from it.
4. **auto-save to file** (on by default) drops a timestamped `recon-digest-<host>.md` into Downloads every ~150 requests, so a fresh recon file exists even if you never click. **Clear** resets the digest and the raw buffer.

Why it can't crash a paste: the digest is signal only. Endpoints are deduped and their IDs collapsed to `:id`/`:uuid`, response bodies are scanned for flags but never included, and every set is capped. A 3,000-request browse of a noisy app lands around a few KB. Bodies stay in the **Capture** tab for drill-down when Claude asks to see one.

## Use (Capture — manual drill-down)

1. Open the Recon panel, then reload or interact with the target page. Requests stream into the left list, and GraphQL ops show their operation name in orange.
2. Click a request to see request/response, plus auto-flagged auth headers (`X-CSRF-Token`, `Authorization`, `Content-Type`).
3. **Introspect GraphQL** reuses a captured GraphQL request's headers to run a schema introspection and list every mutation and query with args. A silent fail means introspection is disabled, which is itself worth noting.
4. **Replay / tamper**: edit method, URL, headers, or body and hit Send. The `Cookie` header is stripped from the editor because the browser attaches the real session cookie automatically. This is where you swap an ID and watch for broken object-level auth.
5. **Copy for Claude** and **Save JSON** export the filtered set as clean JSON with a recon-analysis preamble. Paste into Claude or save to the target's folder.

## Scripts tab

The loop you already run by hand, made repeatable:

1. In **Capture**, trigger the relevant requests and (for GraphQL) hit **Introspect** so the schema is known.
2. In **Scripts**, click **Bundle context for Claude**. It copies a prompt plus the captured schema and requests. Paste into Claude, describe the task, get a script back.
3. Paste the script into the editor, add any **Parameters** (name and value), then Save and Run. Output streams into the Run log.

Scripts run in the page's session via an injected `recon` helper (main-world `inspectedWindow.eval`), so they ride the existing cookie and CSRF exactly like a console paste:

- `await recon.gql(url, query, variables?, headers?)`: GraphQL POST; auto-attaches `X-CSRF-Token` from cookie; throws on non-JSON (the 403-HTML-crashes-`r.json()` trap, handled once).
- `await recon.json(url, opts?)`: fetch with `credentials:'include'`, returns `{status, ok, body}`.
- `recon.csrf(name?)`: CSRF token from cookie.
- `recon.resolveByName(arr, name, {keys?, field?, required?})`: resolve tenant-local IDs at runtime by name/title/displayName. Never hardcode IDs.
- `recon.log(...args)`: stream to the Run log.
- `recon.params`: object from the Parameters form.

**Write-gate:** if the script looks like it writes (non-GET method, `mutation` keyword, `DELETE`), Run is blocked until you tick the authorize box. It's a heuristic, not a guarantee, so read the script. Saved scripts persist in `chrome.storage.local`; store the script, never the IDs.

## Guardrail

Replay executes real authenticated requests against whatever origin you point it at. Only use it against assets explicitly in scope for a program you're authorized to test, or your own systems. Session-riding an out-of-scope app is unauthorized access, full stop. For tenant-isolation and cross-tenant IDOR testing, use two accounts you control; never touch another real tenant's data.

## Known limits / next

- **Digest is the crash-safe paste; raw exports are not.** Prefer Copy digest for Claude. The old Capture-tab "Copy for Claude" (raw requests) is still capped, but Save JSON is unbounded — feed that as a file, never a paste.
- Digest templating collapses numeric, UUID, long-hex, and opaque-token path segments to placeholders. A pathological ID scheme can over- or under-collapse; check the Attack surface list looks right.
- Digest signal flags record presence + location only, with the value redacted. They can false-positive (an email regex fires on any address). Confirm in the raw body via Capture before reporting.
- JWT decode reads header + payload claims only (never verifies or stores the signature). `alg` and claim keys are the recon value.
- auto-save writes to the browser's Downloads folder with a timestamped name; Chrome can't overwrite, so long sessions accumulate files. Turn it off if that's noise.
- Exports cap each request/response body at 4,000 chars (truncated bodies show `_truncated` plus a char count). Replay responses cap at ~200KB in the panel view.
- Every clipboard path is gated. Copy for Claude, Bundle context, and the per-request "Copy this request for Claude" all route through the ~300KB clipboard gate; anything larger auto-saves a `.json` file instead. On top of that, Copy for Claude caps the aggregate to the most-recent 200 requests / ~250KB (flagged with `capped` and `cappedNote`), so a normal copy is always paste-safe. Noisy APIs like YouTube's innertube hit this fast.
- Save JSON is the full, unbounded export, deliberately not capped. Don't open it and paste the contents into a chat; multi-MB JSON crashes it. Feed the saved file to Claude as a file, not a paste.
- Exports redact `Cookie`, `Set-Cookie`, `Authorization`, and `X-CSRF-Token` values (keys kept so the shape is visible). Never paste live session secrets into a chat.
- No request diffing yet (capture A vs replay B). Candidate for next.
- No fuzz or batch, deliberately out of scope until offensive use is on the table.
- Replay polls up to 10s for async results; scripts poll up to 90s. Very slow endpoints time out, though the work may still finish in the page.
- Write-gate is a static heuristic, so it can miss obfuscated writes and false-flag reads. Read the script.
- File-input `.click()` from a script needs a user gesture; inject a button the user clicks (same limitation as console paste).
