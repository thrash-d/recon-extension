# Changelog

This file follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions come from `manifest.json`.

## 0.5.0, 2026-10-10

### Added

- Replay response diff. After a replay, a `Diff vs captured response` toggle shows the status change and, for JSON, the added, removed, and changed values by key path. Non-JSON falls back to a line diff (#1, #6).
- In-scope host allowlist. A `scope` field on the Capture tab takes host patterns such as `*.target.com, api.target.io`. When set, requests to other hosts are dropped before they reach the list or the digest, and a dropped count shows next to the request counter. The scope is saved per inspected origin (#7).

### Changed

- `recon.csrf()` with no argument now tries `CSRF-TOKEN`, `XSRF-TOKEN`, `csrftoken`, and `_csrf` in order, and escapes the cookie name before building the regex. `recon.gql()` logs once when it sends a request with no CSRF token, so a 403 isn't mistaken for an authorization result (#4).

### Fixed

- Replay and script results are deleted from the page's `window.__recon` after the panel reads them, so a long session doesn't grow the page's memory (#3).
- Both Clear buttons reset the stored GraphQL schema, so `Bundle context for LLM` can't send a previous target's schema after switching targets (#5).

## 0.4.1, 2026-09-26

### Fixed

- The request list and detail view escape the HTTP method and GraphQL operation name. A page could put HTML in `operationName` and have it rendered, and run, inside the DevTools panel.

## 0.4.0, 2026-09-26

A minor version, because Firefox support is a new feature.

### Added

- Firefox support. The manifest has a `browser_specific_settings.gecko` key, so the extension installs on Firefox 116 and later.

### Changed

- Storage calls use callbacks, because Firefox's `chrome.*` alias doesn't return promises. Saving and restoring the folder name failed there before.
- Panel labels no longer name a specific LLM.
- The README and test plan were rewritten, with separate install steps for Chrome and Firefox.

## 0.3.1, 2026-08-21

### Added

- Folder picker for saving digests, through the File System Access API in Chrome. Firefox falls back to Downloads.

### Changed

- Auto-save is opt-in.

## 0.3.0, 2026-08-21

### Added

- Passive recon digest tab.

## 0.2.2, 2026-07-10

First version in this repository.
