# Changelog

## Unreleased

- **Vault-wide automation triggers** — PDFs created, modified, or moved into an
  automation's watched folder now run matching automations even when the files
  were added by Obsidian Sync, Syncthing, another plugin, or manually. PDF
  Manager's own downloads are suppressed from this listener to avoid duplicate runs.
- **Split journal pages to daily notes** — a new `split_pages_to_daily_notes` automation
  action. Per-page OCR (Mistral) reads the handwritten date at the top of each page of a
  multi-page PDF and embeds that exact page (`![[file.pdf#page=N]]`) into the matching daily
  note, creating the note when missing. The inserted line is customizable (e.g. a callout).

## 1.1.0

Architecture, observability and safety-net upgrades (Phases 11–13).

- **Typed event bus** decouples sync, automations and the status view.
- **Live activity ticker** and **per-pair health badges** in the status panel.
- **Content-addressed download cache** — moves/renames/duplicates re-use bytes you already have.
- **Off-thread hashing** keeps the UI responsive on large PDFs.
- **Drive changes API** dirty-check skips the full folder walk when nothing changed.
- **md5-based change detection** avoids wasted re-downloads and transcription calls.
- **Manifest auto-backups** (last 20) with a restore command.
- **Crash-safe recycle bin** with `undo last sync`.
- **Disk-space pre-flight** and an **effective sync-rate cap**.
- **Verify-integrity** command reports manifest drift.
- **Automation linter** flags broken automation config.
- **Opt-in anonymous error reporting** (off by default).
- **Sandbox "test sync"** per pair.

## 1.0.0

- Initial release: one-way Google Drive → vault sync, companion notes, automations and AI transcription.
