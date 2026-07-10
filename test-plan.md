# Recon Console — test plan

Work top to bottom. Each phase proves one thing. Use a site **you're logged into and authorized on** (your own account or an admin console you run). Read-only until Phase 5.

## Phase 0 — load (1 min)
1. `brave://extensions` → Developer mode on → **Load unpacked** → pick this folder. (If already loaded, hit the reload ↻ — version is 0.2.1.)
2. Open a logged-in SPA, F12 → **Recon** panel.

## Phase 1 — capture works
1. On the **Capture** tab, reload the page.
2. Rows should stream in. Toggle **JSON/GraphQL only** to cut noise.
3. Click a row → see request/response + auto-flagged auth headers.

✅ Pass = you see the site's own API calls with bodies.

## Phase 2 — replay works (session-riding proof)
1. Pick a **GET** row that returned JSON (a "list"/"feed"/"me" type call).
2. In **Replay / tamper**, hit **Send** unchanged → should return the same `200` + body. That proves the replay rides your session.
3. Now tamper: change a query param (e.g. `count=20` → `count=5`, or a page number) → **Send** → different data back.

✅ Pass = tampered request returns different but valid data. This is the core primitive.

## Phase 3 — first script (hello world)
**Scripts** tab → paste, set the URL to a GET you captured, **Run**:

```js
const res = await recon.json('/PASTE_A_GET_PATH_YOU_CAPTURED');
recon.log('status', res.status);
recon.log('top-level keys:', Object.keys(res.body || {}));
recon.log(res.body);
```

✅ Pass = Run log shows the status + shape. You now have a scripting surface riding the session.

## Phase 4 — automation-ish (read + resolve by name)
The real pattern: read a list, resolve an item by name at runtime (never hardcode IDs), act on it. Add a **param** `name` = something you know exists, then:

```js
const res = await recon.json('/PASTE_A_LIST_ENDPOINT?per_page=100');
const items = res.body.items || res.body.data || res.body;   // adapt to the real shape
recon.log('fetched', items.length, 'items');
const hit = recon.resolveByName(items, recon.params.name, { keys: ['name','title','displayName'] });
recon.log('matched:', hit && (hit.id ?? hit));
```

GraphQL version (if the site uses it — introspect first on the Capture tab):

```js
const q = `{ SOME_LIST_QUERY { nodes { id name } } }`;
const r = await recon.gql('/graphql', q);
const nodes = r.data.SOME_LIST_QUERY.nodes;
recon.log('nodes', nodes.length);
recon.log('id for', recon.params.name, '=', recon.resolveByName(nodes, recon.params.name, { field: 'id' }));
```

✅ Pass = it fetches, resolves the named item, logs its ID. That's a real automation building block.

## Phase 5 — going write-ish (only on something you own)
1. **Dry run first.** Write the script to *log what it would change*, don't send the write:
   ```js
   const target = recon.resolveByName(list, recon.params.name, { field: 'id' });
   recon.log('WOULD update id', target, 'to', recon.params.newValue);   // no write yet
   ```
2. Confirm the log shows the right target/value.
3. Flip it to the real write (a `POST`/`mutation`). The **write-gate** will block Run until you tick authorize — read the script, then tick.
4. For anything schedule-like or bulk, set a future/parked state in the payload so nothing fires by surprise. Verify in the app's UI after.

## Fastest path to a useful first automation
Skip straight to a boring read task you actually want: "list all X and dump names+IDs," or "count open items." Use the **Bundle context for Claude** button (it packages the captured schema + sample requests), paste it to Claude with the task, get a script back, run it. That's the intended loop.
