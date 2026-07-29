# Split obsidian-pdf-manager into two plugins

## Context

`obsidian-pdf-manager` (plugin id `drive-folder-sync`, ~13,000 lines) currently bundles two conceptually distinct jobs in one plugin: syncing/downloading files from Google Drive, and running automations (companion notes, transcription, periodic notes, page-splitting) on those files. The user wants these separated into two independently-publishable plugins so each can be maintained, scoped, and eventually distributed on its own. This plan builds both as subfolders in the current repo — `obsidian-drive-downloader/` and `obsidian-file-automations/` — leaving the existing root untouched as a backup/reference. The user will later export each subfolder to its own repo.

Investigation (two rounds — architecture survey, then line-level verification of the trickiest coupling points) found this is a real refactor, not a file-move: the two areas share one settings object, one file-tracking manifest, and — critically — `DriveSync.processEntry()` directly calls `AutomationEngine.runForFile()` in-process after every download and reacts to its result (including deciding whether to delete the source file). None of that direct coupling can survive a real plugin split; it needs to become two plugins that only interact by watching the same vault, the same way `main.ts` already handles automations for externally-created (e.g. Syncthing) files today.

The user confirmed, when asked, that they want **full behavioral parity** rather than a stripped-down v1: keep per-pair-style companion overrides and all current companion-aware deletion behaviors, rebuild the combined status modal as two separate modals in this same pass, and make the automation plugin mobile-capable (rewrite the one Node-only dependency it would otherwise inherit). The PDF-embed display toggle (a third, unrelated feature) goes to the automation plugin.

## Final directory layout

```
obsidian-drive-downloader/
  main.ts                          # thin: auth, scheduler, manifest, sync commands/ribbon, Account/Sync/Advanced settings
  types.ts                         # DriveDownloaderSettings + SyncPair (no companion fields) + SyncManifestEntry
  auth/GoogleAuth.ts
  sync/
    DriveSync.ts                   # trimmed: no automation/transcription calls, no companion calls
    DownloadManager.ts
    DriveChanges.ts
    SyncManifest.ts                # trimmed ManifestEntry
    Recycle.ts
    CacheManager.ts
    DiskSpaceCheck.ts
    Scheduler.ts
    SyncLog.ts
    SyncLogger.ts
  ai/PdfPageHasher.ts               # mobile-safe (Web Crypto) rewritten copy
  workers/heavyWorker.ts
  commands/
    VerifyIntegrity.ts
    Audit.ts                       # trimmed: drop companion-specific checks
  ui/
    DriveFilePickerModal.ts
    DryRunModal.ts
    ConflictModal.ts
    SyncLogModal.ts
    ChangelogModal.ts
    SyncStatusView.ts              # trimmed EventMap subset
    FileStatusModal.ts             # rebuilt: sync-status-only
  settings/SettingsTab.ts          # Account, Sync, Advanced tabs
  events/EventBus.ts               # trimmed EventMap (download events only)
  telemetry/ErrorReporter.ts
  manifest.json                    # isDesktopOnly: true (GoogleAuth needs Electron/Node)
  package.json / esbuild.config.mjs / tsconfig.json

obsidian-file-automations/
  main.ts                          # thin: settings tabs, vault watchers, ribbon/commands, PDF-embed feature
  types.ts                         # FileAutomationSettings + Automation + CompanionRule types
  automation/
    AutomationEngine.ts            # depends on AutomationTrackingStore, vault-wide scans instead of manifest.entries()
    AutomationLinter.ts
    DateResolver.ts
  companion/
    CompanionNoteManager.ts        # rewritten: CompanionRule (folder-scoped) replaces SyncPair param
    pathTokens.ts
  ai/
    GeminiClient.ts
    MistralClient.ts
    PdfPageHasher.ts                # same mobile-safe rewrite, duplicated
    TranscriptionStore.ts          # re-keyed by vaultPath
  tracking/AutomationManifestStore.ts   # NEW — own tracking store, keyed by vaultPath
  commands/TranscribeCurrentFile.ts
  ui/
    AutomationDryRunModal.ts
    AutomationStatusModal.ts       # NEW — transcription/automation/companion status, rebuilt from FileTrackerModal
  pdfEmbed/                         # moved from main.ts — windowed/collapsible PDF embed display
  settings/SettingsTab.ts          # Notes(companion rules), Automations, Transcription, PDF Embed tabs
  events/EventBus.ts               # trimmed EventMap (automation events only)
  manifest.json                    # isDesktopOnly: false
  package.json / esbuild.config.mjs / tsconfig.json
```

## Settings split

Two fully independent interfaces, no shared object:

- **`DriveDownloaderSettings`**: `clientId`, `clientSecret`, `syncPairs` (loses all companion-override fields), `driveFolderId`/`vaultDestFolder` (legacy migration fields), `syncIntervalMinutes`, `syncOnStartup`, `downloadConcurrency`, `deletionBehavior: "keep"|"delete"|"archive"` (PDF-only now — see companion decoupling below), `archiveFolder`, `redownloadUserDeleted`, `mirrorLocalDeletionToDrive` (new), `driveArchiveFolderId`, sync-log/activity-log/cache/hashing/error-reporting settings.
- **`FileAutomationSettings`**: `automations: Automation[]` (unchanged shape), `companionRules: CompanionRule[]` (new — replaces per-pair overrides, see below), `companionNotesEnabled`, global companion fallback folder/template/title, `companionOnSourceDelete: "keep"|"delete"|"archive"` (new — see below), `periodicNotesPaths`, transcription provider/keys/model/prompt, transcribe-destination defaults, `pdfEmbedWindowed`/`pdfEmbedCollapsible`.

**`migrateLegacySettings`/`migrateAutomationActions` correction**: verified in `main.ts:1216-1282` this function is actually **two unrelated migrations bundled together**, not one automation-only migration as first assumed — (1) legacy single-pair → `syncPairs` array (`main.ts:1218-1236`, download-side) and (2) legacy automation action types → `add_to_periodic_note` (`main.ts:1239-1282`, `migrateAutomationActions`/`synthesizePeriodicTemplate`, automation-side). These must be **split**, not moved wholesale: part (1) goes to the downloader's `main.ts`, part (2) goes to the automation plugin's `main.ts`.

## Each plugin's own tracking store

Downloader keeps a trimmed `SyncManifestEntry` (`vaultPath`, `driveModifiedTime`, `pairId`, `userDeletedAt`, `driveTrashed`, `driveMd5`, `contentHash`), still keyed by `driveFileId`.

Automation plugin gets a **new** `tracking/AutomationManifestStore.ts`, keyed by `vaultPath`:
```ts
export interface AutomationTrackingEntry {
  vaultPath: string;
  companionPath?: string | null;
  companionMtime?: number;
  automationRuns?: Record<string, AutomationRunRecord>; // keyed by automation id
}
```
`ai/TranscriptionStore.ts` is re-keyed the same way (`vaultPath` instead of `driveFileId`, using vault mtime or `PdfPageHasher` content hash as the version signal) — this also fixes an existing bug where ad-hoc transcription of non-Drive files (`commands/TranscribeCurrentFile.ts:306`) is silently untracked today. `AutomationEngine.countMatchingFiles`/`runForAllMatchingFiles` (currently iterate `manifest.entries()`, i.e. Drive-only files) are rewritten to scan `app.vault.getFiles()` — this is required, not optional, or the bulk-automation-run command silently stops covering manually-added PDFs once the download manifest is gone.

## Replacing the direct DriveSync → AutomationEngine call

Delete `sync/DriveSync.ts:963-988` (the `automationEngine.runForFile` block) and the `automationEngine`/`transcriptionStore`/`companion` constructor params. A downloaded file becomes an ordinary vault `create`/`modify` event; the automation plugin gets its **own** `vault.on("create"/"modify"/"rename"/"delete", …)` wiring in its `main.ts`, modeled directly on the existing pattern at `main.ts:430-470,636-693` (which already proves this works today for Syncthing/manually-added files — it just becomes the *only* path instead of an alternate one). The existing `wasRecentlyDownloadedByPdfManager` double-run suppression (`main.ts:638-641`) becomes unnecessary and is deleted — one trigger path instead of two, which is simpler than today, not more complex.

## Companion notes — full parity design (per user's choice)

**Per-rule overrides** replace per-pair overrides: `CompanionRule { triggerFolderPath: string; companionFolder?: string; templatePath?: string; title?: string; enabled: boolean }`, matched by folder prefix the same way `AutomationEngine.matchesTrigger()` already matches automation triggers — reuse that matching logic rather than inventing new matching code. `CompanionNoteManager`'s methods (`companionPath`, `create`, `update`, `loadTemplate`, `resolveTitle`, `renderTemplate` — `sync/CompanionNoteManager.ts:56,101,157,260,284,306`) swap their `pair: SyncPair` parameter for `rule: CompanionRule`. The `{{pairLabel}}` template token has no equivalent (sync pairs don't exist in this plugin) — document as a breaking change for anyone using that token; templates need updating.

**Create/update trigger**: today only fires from inside `DriveSync.processEntry()` (`sync/DriveSync.ts:892-924`) — there's no vault-event equivalent yet. New `vault.on("create"/"modify")` handler in the automation plugin's `main.ts` calls `companionManager.create()`/`update()` when a file matches a `CompanionRule`, using vault `mtime`/content-hash instead of Drive's `modifiedTime`/`md5Checksum` as the change signal (compared against `AutomationTrackingEntry.companionMtime`).

**Rename**: `CompanionNoteManager.rename()` (`sync/CompanionNoteManager.ts:227-239`) is reusable as-is, but today is *only* called from `DriveSync.handleRename()` (`sync/DriveSync.ts:1048-1069`) — confirmed there is no existing vault-rename-driven equivalent, so a real gap, not just a seam. New `vault.on("rename")` in the automation plugin looks up the old path in `AutomationManifestStore`, and if a companion exists, calls `rename()`.

**Deletion — decoupled full parity**: today `DriveSync.removeEntry()/removeFile()` (`sync/DriveSync.ts:1079-1153`) reads `companionPath` off the manifest and directly deletes/archives the companion alongside the PDF, giving three combined variants (`delete_keep_companion`, `archive_keep_companion`, `delete_only_companion`). Post-split there's no shared manifest to read `companionPath` from, and no IPC is wanted. Design: **two independently-configured deletion policies that achieve the same (and a superset of) behavior with zero cross-plugin calls**:
- Downloader's `deletionBehavior` only ever governs the PDF: `keep` / `delete` / `archive`.
- Automation plugin gets its own new setting, `companionOnSourceDelete: "keep"|"delete"|"archive"`, applied by its own `vault.on("delete")` watcher when the PDF it was tracking disappears (detected via its own `AutomationManifestStore`, independent of *why* the PDF vanished — Drive-side deletion, user deletion, or anything else).
- The 3×3 combination reproduces all three original variants (e.g. `delete` + `companionOnSourceDelete: keep` = old `delete_keep_companion`) plus additional combinations the original never supported, using nothing but each plugin watching the same vault independently.

## Delete-after-transcription (automation-triggered deletion of the source PDF)

Automation plugin, after a successful `transcribe_to_companion` action with `deleteFileAfterTranscription`, calls `this.app.vault.trash(file, true)` directly — no cross-plugin call (replacing today's `DriveSync.deleteSourceAfterTranscription()`, `sync/DriveSync.ts:976-987`, which currently also reaches into the Drive API). Downloader gets one small addition: a `mirrorLocalDeletionToDrive` setting — when a manifest entry's `userDeletedAt` is set (already tracked today via the existing generic `vault.on("delete")` watcher at `main.ts:459-470` → `manifestStore.markUserDeleted`) and this setting is on, the next sync pass calls the existing `trashDriveFile()` (`sync/DriveSync.ts:522-538`, reused verbatim) instead of merely skipping re-download. Net: ~10 new lines in the downloader, an ordinary `vault.trash()` call in the automation plugin, zero IPC.

## PDF-embed display feature → File Automations plugin

Move `pdfEmbedWindowed`/`pdfEmbedCollapsible` settings and their ~130 lines of implementation (`main.ts:161-165,700-830`) into `obsidian-file-automations/`, along with the relevant `renderNotesTab` UI portion (`settings/SettingsTab.ts:667-738`) as its own settings section. No dependency on Drive sync, so this is a clean lift.

## Status view — full rebuild (per user's choice)

`ui/FileTrackerModal.ts` (632 lines) and `ui/FileStatusModal.ts` currently import `SyncManifestStore` + `TranscriptionStore` + `AutomationEngine` together — neither moves as-is. Build two independent replacements in this same pass:
- Downloader: trimmed `FileStatusModal.ts` showing sync status only (manifest entry, last synced, pair).
- Automation plugin: new `ui/AutomationStatusModal.ts` showing transcription status (`TranscriptionStore`), automation run history (`AutomationManifestStore`), and companion note status — built fresh against the new vaultPath-keyed stores rather than ported line-by-line.

## Mobile support — rewrite PdfPageHasher (per user's choice)

`ai/PdfPageHasher.ts` currently imports Node's `crypto` directly (confirmed: `ai/PdfPageHasher.ts:1`) — the only Node/Electron dependency found anywhere in `automation/`, `ai/`, `sync/CompanionNoteManager.ts`, `sync/pathTokens.ts`, or `commands/TranscribeCurrentFile.ts`. Rewrite it once to use Web Crypto (`crypto.subtle.digest`, available in both Obsidian desktop and mobile), and duplicate the same mobile-safe version into both plugins (the downloader doesn't need it for mobile — `GoogleAuth.ts`'s OAuth flow still requires Electron's `shell.openExternal` and a local Node `http` server, so the downloader stays `isDesktopOnly: true` regardless — but using one consistent implementation in both places avoids maintaining two divergent hashers). This lets `obsidian-file-automations/manifest.json` set `isDesktopOnly: false`.

## Audit.ts and small utilities

`commands/Audit.ts` is entirely download-manifest-focused, but 4 of its 6 checks are companion-related (`commands/Audit.ts:36-83,96-112`) and read `companionPath` straight off the manifest — since the download manifest drops that field, these 4 checks move to the downloader trimmed (checks 1 "missing vault file" and 5 "orphaned pair" only survive there). No separate automation-side audit is planned for this pass — can be added later if wanted.

Small pure utilities with no external deps (`ai/PdfPageHasher.ts` after rewrite) are duplicated rather than shared via a common folder — no shared/monorepo tooling, matching "avoid overgrown" for the build setup itself (see below).

## Build/tooling — kept minimal

No workspaces, no Lerna/Turborepo, no shared tsconfig/eslint base. Each subfolder is an independent copy of the current project's build setup: own `package.json` (own `node_modules`), own `esbuild.config.mjs` (same externals list), own `tsconfig.json`, own `manifest.json` with a new plugin id/name (default: `drive-downloader`/"Drive Downloader" and `file-automations`/"File Automations", matching the folder names — flag if different names are wanted). The existing repo root is left completely untouched, continues to build and function as today, and serves as the user's backup/reference.

## Ordered implementation steps

1. Scaffold `obsidian-file-automations/` (copy build config, new manifest.json) — build this one first since it has fewer external dependencies.
2. Move automation-side files per the mapping above; write the mobile-safe `PdfPageHasher.ts`.
3. Build `tracking/AutomationManifestStore.ts`; re-key `TranscriptionStore`.
4. Rewrite `AutomationEngine` to use the new tracking store and vault-wide scans for bulk operations.
5. Rewrite `CompanionNoteManager` to use `CompanionRule` instead of `SyncPair`.
6. Write the automation plugin's `main.ts`: settings tabs (Notes/companion rules, Automations, Transcription, PDF Embed), vault watchers (create/modify/rename/delete) covering automations + companion notes + delete-after-transcription + companion-on-source-delete, PDF-embed feature, `migrateAutomationActions` migration, new `AutomationStatusModal.ts`.
7. Build and smoke-test standalone in a scratch vault: companion creation/rename/delete on manually-added PDFs, automation firing on vault events, ad-hoc transcription, delete-after-transcription, PDF-embed toggle.
8. Scaffold `obsidian-drive-downloader/`; move download-side files, trimming `DriveSync.ts` (remove automation/transcription/companion calls), `SyncManifest.ts`'s `ManifestEntry`, `Audit.ts`.
9. Add `mirrorLocalDeletionToDrive` behavior.
10. Write the downloader's `main.ts`: auth, scheduler, manifest, Account/Sync/Advanced settings tabs, `syncPairs` migration, trimmed `FileStatusModal.ts`, download-only vault-delete watcher.
11. Build and smoke-test standalone: OAuth flow, folder sync, rename-healing, deletion-pass behavior (keep/delete/archive), `mirrorLocalDeletionToDrive`.
12. **Integration test**: run both plugins together in one scratch vault — confirm a Drive-downloaded file is picked up purely via vault events by the automation plugin (companion note created, automation runs, no double-processing), and that deleting a file produces the expected combination of PDF/companion fates per each plugin's independent settings.
13. Leave the original repo root untouched as backup; no cleanup needed there for this migration to be complete.

## Verification

- `npm run build` (esbuild) succeeds in both subfolders independently.
- Both `manifest.json` files validate (correct id/name/isDesktopOnly).
- Manual test in a scratch Obsidian vault with both plugins installed side by side: Drive sync produces a file → companion note auto-created → transcription automation runs → delete-after-transcription trashes the source → next downloader sync mirrors the deletion to Drive (if enabled). Also test a manually-dropped PDF (no Drive involvement) to confirm the automation plugin works fully standalone.
- Confirm no regressions in the original repo root (untouched, but re-run its existing build once at the end to be sure nothing in the workspace was accidentally disturbed).
