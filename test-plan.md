# Recon Console test plan

## Phase 0: load

1. `brave://extensions` > Developer mode on > `Load unpacked` > pick this folder. (If already loaded, hit the reload ↻)
2. F12 > `Recon` panel.

## Phase 0.5: passive digest

1. Switch to the `Digest` tab. Browse the target normally for a minute. Click around, load a few views.
2. The `N reqs · M endpoints` counter should climb and the digest text should rebuild on its own.
3. Confirm the Attack surface list shows deduped endpoints with IDs collapsed to `:id`/`:uuid`, id-bearing rows marked `*`, and that Auth surface / Signal flags / missing security headers populate.
4. Hit `Copy digest for LLM`, paste into a scratch buffer.

## Phase 1: capture works

1. On the `Capture` tab, reload the page.
2. Rows should stream in. Toggle `JSON/GraphQL only` to reduce noise.
3. Click a row > see request/response + flagged auth headers.

## Phase 2: replay works

1. Pick a `GET` row that returned JSON (a "list"/"feed"/"me" type call).
2. In `Replay / tamper`, hit `Send` unchanged > should return the same `200` + body. That proves the replay rides your session.
3. Now tamper: change a query param (e.g. `count=20` > `count=5`, or a page number) > `Send` > different data back.

## Phase 3: first script
`Scripts` tab > paste, set the URL to a GET you captured, `Run`:

```js
const res = await recon.json('/PASTE_A_GET_PATH_YOU_CAPTURED');
recon.log('status', res.status);
recon.log('top-level keys:', Object.keys(res.body || {}));
recon.log(res.body);
```

## Phase 4: automation-ish
Read a list, resolve an item by name at runtime (never hardcode IDs), act on it. Add a `param` `name` = something you know exists, then:

```js
const res = await recon.json('/PASTE_A_LIST_ENDPOINT?per_page=100');
const items = res.body.items || res.body.data || res.body;   // adapt to the real shape
recon.log('fetched', items.length, 'items');
const hit = recon.resolveByName(items, recon.params.name, { keys: ['name','title','displayName'] });
recon.log('matched:', hit && (hit.id ?? hit));
```

GraphQL version:

```js
const q = `{ SOME_LIST_QUERY { nodes { id name } } }`;
const r = await recon.gql('/graphql', q);
const nodes = r.data.SOME_LIST_QUERY.nodes;
recon.log('nodes', nodes.length);
recon.log('id for', recon.params.name, '=', recon.resolveByName(nodes, recon.params.name, { field: 'id' }));
```

Phase 5: going write-ish

1. Test first. Write the script to log what it would change, don't send the write:

```js
const target = recon.resolveByName(list, recon.params.name, { field: 'id' });
recon.log('WOULD update id', target, 'to', recon.params.newValue);   // no write yet
```

2. Confirm the log shows the right target/value.
3. Flip it to the real write (a `POST`/`mutation`). The `write-gate` will block Run until you tick authorize.
4. For anything schedule-like or bulk, set a future state in the payload so nothing runs by surprise. Verify in the app's UI after.

## Fastest path to a useful first automation
Skip straight to a boring read task you want: "list all X and dump names+IDs," or "count open items." Use the `Bundle context for LLM` button, paste it to your LLM with the task, get a script back, run it.
