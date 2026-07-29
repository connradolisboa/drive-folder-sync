# Changelog

## 1.1.0

The Google Drive downloader is now an independent desktop-only plugin.

- **One-time legacy import** keeps downloader settings from Drive Folder Sync while
  excluding unrelated feature configuration.
- **Typed event bus** decouples sync operations and the status view.
- **Live activity ticker** and **per-pair health badges** in the status panel.
- **Content-addressed download cache** — moves/renames/duplicates re-use bytes you already have.
- **Off-thread hashing** keeps the UI responsive on large PDFs.
- **Drive changes API** dirty-check skips the full folder walk when nothing changed.
- **MD5-based change detection** avoids wasted re-downloads.
- **Manifest auto-backups** (last 20) with a restore command.
- **Crash-safe recycle bin** with `undo last sync`.
- **Disk-space pre-flight** and an **effective sync-rate cap**.
- **Verify-integrity** command reports manifest drift.
- **Opt-in anonymous error reporting** (off by default).
- **Sandbox "test sync"** per pair.
- **Observable vault writes** use Obsidian's binary file APIs so other plugins receive
  normal create and modify events.
- **Optional Drive deletion controls** include delete-after-sync and safe mirroring of
  tracked local deletions to Drive trash.
