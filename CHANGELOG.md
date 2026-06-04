# Changelog

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
