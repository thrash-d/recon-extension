# Changelog

This file follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions come from `manifest.json`.

## Unreleased

These changes landed after 0.3.1 without a version bump, so `manifest.json` still reads 0.3.1.

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
