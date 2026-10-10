# Recon Console

A Chrome and Firefox DevTools extension for session-riding recon and scripted automation, for authorized security testing and developer work. It adds three tabs to the DevTools panel:

- Capture grabs the site's own API traffic, runs GraphQL introspection, and replays or tampers requests inside the page's real session.
- Digest is passive. Just browse, and every request folds into a deduped attack-surface map (endpoint templates with IDs collapsed, observed params, IDOR/JWT/secret/PII flags, missing security headers, GraphQL ops). A few KB of deduped map instead of MB of bodies.
- Scripts lets you describe a task, let your favorite LLM write it, paste it in, and run it in-session, with saved and parameterized scripts plus a write-gate.

## Install

### Chrome

1. Go to `chrome://extensions`.
2. Toggle Developer mode on (top right).
3. Click Load unpacked and select this `recon-extension` folder.
4. Open DevTools (F12) on your target tab and pick the Recon panel.

### Firefox

Firefox loads it as a temporary add-on, so load it again after each browser restart.

1. Go to `about:debugging#/runtime/this-firefox`.
2. Click Load Temporary Add-on and select this folder's `manifest.json`.
3. Open DevTools (F12) on your target tab and pick the Recon panel.

Firefox reads the `browser_specific_settings.gecko` block in the manifest for its add-on ID. Firefox has no folder picker, so saves there always go to Downloads.

## Digest tab

1. Open the Recon panel on your authorized target and switch to the `Digest` tab.
2. Browse the site normally. The counter (`N reqs · M endpoints`) ticks up and the digest rebuilds live.
3. When you've covered the surface you care about, hit `Copy digest for LLM` and paste. The digest carries its own analysis preamble, so the LLM ranks IDOR/BOLA, broken-auth, data-exposure, CORS, and missing-header candidates straight from it.
4. `Save digest` writes a timestamped `recon-digest-<host>.md` snapshot. `Choose folder…` picks where saves go, Downloads by default. `auto-save` is off by default. Tick it to overwrite a single `recon-digest-<host>.md` in that folder every ~150 requests, so a current recon file always exists without clicking. `Clear` resets the digest and the raw buffer.

The chosen folder is remembered across sessions, but the browser re-asks for write permission the first time you Save after reopening DevTools. Auto-save works only while that permission is live.

## Capture tab

1. Open the Recon panel, then reload or interact with the target page. Requests stream into the left list, and GraphQL ops show their operation name in orange.
2. Click a request to see request/response, plus auto-flagged auth headers (`X-CSRF-Token`, `Authorization`, `Content-Type`).
3. `Introspect GraphQL` reuses a captured GraphQL request's headers to run a schema introspection and list every mutation and query with args.
4. `Replay / tamper` edits method, URL, headers, or body and hits Send. The `Cookie` header is stripped from the editor because the browser attaches the real session cookie automatically. After a send, `Diff vs captured response` shows the status change and, for JSON, which values differ by key path.
5. `Copy for LLM` and `Save JSON` export the filtered set as clean JSON with a recon-analysis preamble. Paste into your LLM or save to the target's folder.
6. The `scope` field takes in-scope host patterns such as `*.target.com, api.target.io`. When set, requests to other hosts are dropped before capture and a dropped count shows next to the counter. It's saved per inspected site, so it sticks across reloads.

## Scripts tab

Capture a few requests, hand them to an LLM, and run the script it writes back, all inside the page's live session:

1. In `Capture`, trigger the relevant requests and (for GraphQL) hit `Introspect` so the schema is known.
2. In `Scripts`, click `Bundle context for LLM`. It copies a prompt plus the captured schema and requests. Paste into your LLM, describe the task, get a script back.
3. Paste the script into the editor, add any `Parameters` (name and value), then Save and Run. Output streams into the Run log.

Scripts run in the page's session via an injected `recon` helper (main-world `inspectedWindow.eval`), so they ride the existing session cookie and CSRF token:

- `await recon.gql(url, query, variables?, headers?)`: GraphQL POST; auto-attaches `X-CSRF-Token` from cookie; throws on non-JSON, so a 403 HTML error page doesn't crash parsing.
- `await recon.json(url, opts?)`: fetch with `credentials:'include'`, returns `{status, ok, body}`.
- `recon.csrf(name?)`: CSRF token from cookie. With no name it tries `CSRF-TOKEN`, `XSRF-TOKEN`, `csrftoken`, and `_csrf`.
- `recon.resolveByName(arr, name, {keys?, field?, required?})`: resolve tenant-local IDs at runtime by name/title/displayName. Never hardcode IDs.
- `recon.log(...args)`: stream to the Run log.
- `recon.params`: object from the Parameters form.

If a script looks like it writes (non-GET method, `mutation` keyword, `DELETE`), Run is blocked until you tick authorize. Saved scripts persist in `chrome.storage.local`; store the script, never the IDs.

## Guardrail

Replay executes real authenticated requests against whatever origin you point it at. Only use it against assets explicitly in scope for a program you're authorized to test, or your own systems. Session-riding an out-of-scope app is unauthorized access, full stop. For tenant-isolation and cross-tenant IDOR testing, use two accounts you control; never touch another real tenant's data.

## Known limits

- Signal flags record only that something matched and where, with the value redacted. They false-positive (an email regex matches any address), so confirm in the raw body under Capture before reporting.
- JWT decode reads the header and payload claims. It never verifies or stores the signature. The `alg` and claim keys are the recon value.
- The folder picker needs the File System Access API (Chrome and Edge). Firefox has no such API and saves to Downloads.
- With auto-save on and a folder chosen, one `recon-digest-<host>.md` is overwritten in place. With no folder, each save is a new timestamped file in Downloads, because Chrome can't overwrite there.
- Exports cap each request and response body at 4,000 chars; a truncated body shows `_truncated` and a char count. Replay responses show up to ~200KB in the panel.
- Copies are size-gated. `Copy for LLM`, `Bundle context`, and per-request `Copy this request for LLM` route through a ~300KB clipboard gate; anything larger saves a `.json` file instead. `Copy for LLM` also caps the set to the 200 most-recent requests or ~250KB, flagged with `capped`, so a copy is always paste-safe. Noisy APIs like YouTube's innertube hit this fast.
- `Save JSON` is the full export, uncapped. It can be multi-MB, so give the saved file to the LLM as a file. Don't paste its contents into a chat.
- Exports redact the values of `Cookie`, `Set-Cookie`, `Authorization`, and `X-CSRF-Token` and keep the keys, so the request shape stays visible. Never paste live session secrets into a chat.
- Replay polls for up to 10s for async results; scripts poll for up to 90s. A slower endpoint times out in the panel even if the work finishes in the page.
- The write-gate is a static heuristic. It can miss an obfuscated write and can flag a read, so read the script.
- Response diffing compares one captured response against its replay only. Diffing two arbitrary captures isn't supported.
- No fuzzing or batching. Out of scope until offensive use is on the table.
