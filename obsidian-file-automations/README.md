# File Automations

Standalone companion-note, transcription, periodic-note, and PDF-embed automations for Obsidian.

## Cutover from PDF Manager

Disable the legacy `drive-folder-sync` / “PDF Manager” plugin before enabling this plugin. On first load, File Automations reads the legacy plugin's `data.json`, `.obsidian/drive-sync-manifest.json`, and `.obsidian/drive-sync-transcriptions.json` when present. It copies relevant settings and tracking into new, namespaced files. Legacy files are never modified or deleted.

The import is idempotent. Existing automation IDs, managed-block sentinels, and `drive-sync-skip-*` frontmatter keys are preserved so old notes do not duplicate work.

The plugin intentionally keeps a companion that just received a successful transcription when “delete source after transcription” removes the PDF. Other source deletions follow the matching companion rule's policy.

For a two-plugin cutover, install and enable File Automations before the first Drive Downloader sync when practical. Late enable is also supported: File Automations reconciles the downloader's persisted disconnected-source state at startup, and consumes the optional `drive-downloader:source-disconnected` and synchronous `drive-downloader:source-removal-intent` workspace events. These handshakes preserve ordinary-removal versus Drive-archive companion policies without making either plugin a required dependency.

Legacy combined deletion values are split into independent PDF and companion behavior:

- `delete_keep_companion` and `archive_keep_companion` import as “keep companion.”
- `delete_only_companion` imports as “delete companion.”
- Plain `delete` imports as “delete companion”; plain `archive` imports as “archive companion.”

When a kept PDF is disconnected and its companion is deleted or archived, the detached state is persisted. Ordinary same-version vault events cannot immediately recreate the companion. A changed PDF version or an explicit “Process current PDF now” command treats the PDF as locally active again.
