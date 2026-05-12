# IMPROVEMENTS.md

Action plan for the **next** round of drive-folder-sync features. The previous plan is archived at `IMPROVEMENTS_archive_2026-05-12_v2.md` (and `_archive_2026-05-12.md`).

---

## How to use this document (read first)

This file is the source of truth for **what's left to build**. Every concrete unit of work is a checkbox. The flow for any chat picking this up:

1. **Pick the next unchecked phase** in order. Phases are dependency-ordered — do not jump ahead unless the prerequisite is already in place.
2. **Read the entire phase section** before writing any code (each section is intentionally self-contained so you can drop it into a fresh chat as a brief).
3. **Implement the tasks** in the order listed within the phase. Tick boxes as you go: `- [ ]` → `- [x]`.
4. **Run the verification block** at the end of each phase. If it doesn't pass, do not mark the phase complete.
5. **Commit per phase**, not per task. Commit message format: `Phase 7.X — <short summary>`.
6. **If you change the plan** (new task discovered, scope adjustment), edit this file in the same commit so the doc and the code agree.
7. **Decisions made mid-implementation** go into a `**Decisions made:**` block under the relevant phase (see Phase 3 in archive for the format).

**Conventions** (carried forward):
- **Drive ID** = immutable Google Drive file ID. The only reliable identity for tracking.
- **Companion note** = markdown sidecar created by `CompanionNoteManager`.
- **Manifest** = `.obsidian/drive-sync-manifest.json` (`sync/SyncManifest.ts`). Authoritative source of truth.
- **Tracked file** = a file present in the manifest (i.e., synced from Drive at some point).
- **Untracked file** = a vault file with no manifest entry (e.g., notes the user created locally, files imported outside the sync).

---

## Phase 7 — Transcription settings tab (split out)

**Status:** the "Transcription" tab already exists in [settings/SettingsTab.ts:29](settings/SettingsTab.ts#L29) and `renderTranscriptionTab` lives at [settings/SettingsTab.ts:819](settings/SettingsTab.ts#L819). This phase **enriches** that tab — it does not create a new one. Any setting that doesn't already belong to "transcription only" stays where it is.

### 7.1 Audit + relocate

- [ ] List every transcription-related setting currently rendered outside the Transcription tab and move them into `renderTranscriptionTab` (provider, API keys, model, prompt — currently mixed into other panes).
- [ ] Group settings inside the Transcription tab using `<h3>` subheadings:
  - [ ] **Provider & credentials** (provider toggle, Gemini API key + model + prompt, Mistral API key)
  - [ ] **Default behavior** (default destination, fallback companion folder)
  - [ ] **Templates** (one block per destination type — see §7.2)
  - [ ] **Page-hash retranscription** (force-full button, store size info)
- [ ] Add a small "Test connection" button per provider that runs a 1-page dummy call and shows a success/error notice.

### 7.2 Per-destination templates (3 boxes + 1 file picker)

The "Transcribe file" command supports three destinations (companion / daily / arbitrary note). Each gets its own template setting.

- [ ] **Companion-note template** — two inputs that work together:
  - [ ] Inline textarea (`transcribeCompanionTemplate` — already exists in `types.ts:152`)
  - [ ] File-path picker (`transcribeCompanionTemplatePath` — already exists in `types.ts:153`). When the path is set and the file exists, it **overrides** the inline value at write time. Show a small "(file overrides inline)" hint when both are populated.
  - [ ] "Browse…" button next to the path field opens a `FuzzySuggestModal` over markdown files.
  - [ ] "Preview" button renders the template against a synthetic example (sample title, sample transcription).
- [ ] **Daily-note template** (`transcribeDailyTemplate`) — single textarea, no file picker.
- [ ] **Other-note template** (`transcribeNoteTemplate`) — single textarea, no file picker.
- [ ] Document supported tokens **inline below each textarea** (don't make users hunt): `{{transcription}}`, `{{title}}`, `{{fileName}}`, `{{date}}`, `{{link}}`, `{{embed}}`, `{{sourcePath}}`, `{{pairLabel}}`.
- [ ] Add `{{sourcePath}}` and `{{pairLabel}}` as **new** tokens — they don't exist yet (see `commands/TranscribeCurrentFile.ts:419-428`). Implement in `writeTranscription()`.

### 7.3 Default-destination companion fallback folder

- [ ] Promote `transcribeCompanionFallbackFolder` (already in `types.ts:156`) to a top-level setting under "Default behavior".
- [ ] Add a help line: "When transcribing into a companion note that doesn't exist yet, create it here. Empty = alongside the source file. Supports `{{RootFolder}}`, `{{folderL1}}`, `{{folderL2}}` tokens."
- [ ] Surface a live preview line: "Example: `<sourcePath>` → `<resolvedCompanionPath>`" using the active file (or a stub).

### 7.4 Default-destination behavior tweaks

- [ ] Replace the existing dropdown options (`ask` / `companion` / `daily` / `note`) with the same set, but rename "note" → "specific file" for clarity in the UI.
- [ ] When `default = "specific file"` is selected, immediately reveal a file picker for the **default note** (new setting `transcribeDefaultNotePath: string`). Without it, the option behaves like "ask".

### 7.5 Verification

- [ ] Open Settings → Transcription → every previously-mentioned setting is visible here, nowhere else.
- [ ] Run "Transcribe current file" on a PDF with the companion template path pointing to a real template file → output uses that file's content.
- [ ] Empty all three template textareas → output falls back to the built-in `## Transcription` block (current behavior preserved).

**Files:** `settings/SettingsTab.ts`, `types.ts`, `commands/TranscribeCurrentFile.ts`, `main.ts` (only if the new `transcribeDefaultNotePath` flow needs wiring).

---

## Phase 8 — File-explorer right-click menu

**Goal:** Surface the most-used commands directly in the file-explorer context menu so the user never opens the command palette to act on a single file.

### 8.1 Wire `file-menu` event in main.ts

- [ ] In `main.ts`, register `this.app.workspace.on("file-menu", (menu, file) => { … })` and add a top-level **"Drive Sync"** submenu when the file matches **any** of the entry conditions below.
- [ ] Use `menu.addItem(item => item.setTitle("Drive Sync").setIcon("refresh-cw").setSection("drive-sync")…)` and chain a sub-`Menu` so all options are nested under one entry (avoid polluting the menu).

### 8.2 Items inside the submenu

For PDFs (or any file the user might want to transcribe):
- [ ] **"Transcribe…"** — opens the existing `DestinationPickerModal`. Hidden when the active provider is disabled.
- [ ] **"Transcribe to companion note"** — fast path; skips the picker.
- [ ] **"Transcribe to today's daily note"** — fast path.

For any file (PDF or otherwise) — the "automation on any file" surface from Phase 9:
- [ ] **"Run automation on this file…"** — opens `AutomationPickerModal`, then runs `runForFileAdHoc(file.path, automationId, { force: false, ignoreFolderTrigger: true })`.
- [ ] **"Create companion note"** — calls `companionManager.create()` against this file, even if it's not Drive-tracked. (Implement in §9.3.)

For tracked files (those present in the manifest):
- [ ] **"Show Drive Sync status…"** — opens a new `FileStatusModal` (see §8.3).
- [ ] **"Force full re-transcription"** — same behavior as the existing command, but scoped to this file.
- [ ] **"Sync this pair now"** — runs `runSyncForPair(entry.pairId)` for the file's owning pair.

### 8.3 `FileStatusModal` — single-file inspector

This is the per-file view of the global FileTracker.

- [ ] New file `ui/FileStatusModal.ts`. Constructor: `(app, plugin, file: TFile)`.
- [ ] Display sections (only show ones with data):
  - [ ] **Drive metadata**: `driveFileId`, `driveModifiedTime`, `pairId` + label, trashed flag, user-deleted flag.
  - [ ] **Companion**: companion path (clickable → opens the note), exists yes/no, last conflict timestamp.
  - [ ] **Transcription**: store entry hash, page count, per-destination history.
  - [ ] **Automation runs**: each `automationRuns[]` row — id, name, last run at, last result, output count, error message.
  - [ ] **Untracked**: when no manifest entry exists, show a single line: "Not tracked by Drive Sync." with action buttons for what's possible (transcribe, create companion, run ad-hoc automation).
- [ ] Action row at the bottom: same buttons as the right-click submenu, for parity.

### 8.4 Verification

- [ ] Right-click a Drive-synced PDF → "Drive Sync" submenu appears with all relevant items.
- [ ] Right-click a markdown note created locally (not synced) → "Drive Sync" submenu appears with only the "ad-hoc" items (transcribe is hidden if not a PDF; "Run automation on this file" is shown).
- [ ] "Show Drive Sync status" on a tracked file shows manifest data; on an untracked file shows "Not tracked".

**Files:** `main.ts`, new `ui/FileStatusModal.ts`. No type changes.

---

## Phase 9 — Run automations on **any** file (tracked or not)

**Goal:** Today, automations only run as part of a Drive sync, on files that match the automation's `triggerFolderPath`. This phase makes them runnable on **any vault file**, on demand, via command palette or right-click.

### 9.1 Bypass the trigger filter

- [ ] Extend `AutomationEngine.runForFile()` ([automation/AutomationEngine.ts:116](automation/AutomationEngine.ts#L116)) to accept `ignoreFolderTrigger?: boolean` in a new options bag.
- [ ] When `ignoreFolderTrigger=true`, skip the `matchesTrigger` filter at line 126 and consider every active automation a candidate (still honor `excludedSubfolders` and the `drive-sync-skip-*` frontmatter flags).
- [ ] Refactor the long positional signature into `runForFile(opts: RunForFileOptions)` to avoid argument-position bugs. Update the only existing caller in `sync/DriveSync.ts`.

### 9.2 New entry point: `runForFileAdHoc`

- [ ] Add `AutomationEngine.runForFileAdHoc(vaultPath: string, automationId: string, opts: { force?: boolean; dryRun?: boolean })`:
  - [ ] Looks up the manifest entry by `vaultPath` (may be `null` for untracked files).
  - [ ] If untracked, generates a synthetic context: `driveFileId = null`, `driveModifiedTime = file.stat.mtime as ISO`, `companionPath = null`, `transcription = null`.
  - [ ] Calls `runAction()` directly with that context. Skips the §1.1 decision matrix when `driveFileId` is null (we have nothing to compare against; treat it as `force=true`).
  - [ ] When the file **is** tracked, passes through the matrix as usual unless `force` is set.
- [ ] Returns `{ ran: boolean, skippedReason?: string, error?: string, outputs?: string[] }`.

### 9.3 Companion creation as an ad-hoc action

- [ ] Today, companion notes are only created during sync. Add a public method `CompanionNoteManager.createForArbitraryFile(file: TFile, pair?: SyncPair | null)`:
  - [ ] Resolves the companion path using the pair's settings if a pair is provided, otherwise the global defaults (with the same `{{RootFolder}}` token resolution).
  - [ ] Creates the companion note **without** registering a manifest entry (it's user-initiated, not Drive-derived).
  - [ ] Sets frontmatter `companion-of: "[[<vaultPath>]]"` and `sourceVaultPath: "<vaultPath>"`. Omits `driveFileId`.
- [ ] Wire this into the right-click "Create companion note" item from §8.2.

### 9.4 Command-palette entries

- [ ] `drive-sync:run-automation-on-active-file` — uses the active file. Picker for which automation, then a force toggle.
- [ ] `drive-sync:run-all-automations-on-active-file` — runs every active automation (with `ignoreFolderTrigger=true`). Confirmation modal listing what will run.
- [ ] `drive-sync:create-companion-for-active-file` — calls §9.3 against the active file.

### 9.5 Verification

- [ ] Create a fresh markdown note outside any sync pair's folder. Right-click → "Run automation on this file…" → pick `link_to_matching_note` → automation runs and creates/links the matching note even though the file is untracked.
- [ ] Run the same automation a second time on the same file → it runs again (no manifest = no matrix). This is intentional; document it in `AutomationEngine` as a comment.
- [ ] On a Drive-tracked file, the same flow respects the matrix unless force is set.

**Files:** `automation/AutomationEngine.ts`, `sync/CompanionNoteManager.ts`, `main.ts`, plus the right-click hooks added in Phase 8.

---

## Phase 10 — Two-way sync (the massive one)

**Do not start this phase until Phases 7-9 are fully checked off and stable for at least two weeks of regular use.** Two-way sync is the highest-risk feature in the entire plugin. Most of the engineering effort is **not** sync logic — it's failure containment, conflict resolution, and giving the user a believable undo.

### 10.0 Pre-flight: explicit non-goals

Document these in the plugin README before writing code, so user expectations are bounded:

- [ ] **Not** real-time. Two-way sync runs on the same scheduler as the existing pull-only sync; expect minute-level latency.
- [ ] **Not** a full-fidelity Drive client. Edits to Google Docs/Sheets/Slides remain pull-only (their native format is not markdown).
- [ ] **Not** a backup tool. The user is told, in writing, to keep their own backups.

### 10.1 Per-pair toggle and explicit opt-in

- [ ] Add `bidirectional?: boolean` to `SyncPair` in `types.ts`. Default `false`. Existing pairs continue as one-way.
- [ ] Settings UI: a toggle **per pair** in the Sync tab. The first time the user enables it, show a modal that requires typing the pair label to confirm.
- [ ] Add `bidirectionalScope?: { include: string[]; exclude: string[] }` — glob-style filters limiting which file types are upload-eligible (default: `["**/*.md"]`).

### 10.2 Manifest extensions

Extend `ManifestEntry` in `types.ts`:

- [ ] `vaultMtime?: number` — last vault filesystem mtime we observed at sync time (ms).
- [ ] `vaultContentHash?: string` — sha256 of vault content at last sync. Source of truth for "did the user actually change it?".
- [ ] `driveContentHash?: string` — sha256 of Drive content at last sync (computed locally after download).
- [ ] `lastUploadedAt?: string` — ISO. When we last pushed this file up.
- [ ] `pendingUpload?: { reason: "modified" | "created" | "renamed" | "deleted"; queuedAt: string }` — queued change waiting for next sync window.
- [ ] `conflictHistory?: Array<{ at: string; resolution: "kept-vault" | "took-drive" | "saved-both"; backupPath?: string }>` — for the audit log + UI.

### 10.3 Detecting vault-side changes

- [ ] In `main.ts`, add `vault.on("modify")`, `vault.on("create")`, `vault.on("delete")`, `vault.on("rename")` listeners that:
  - [ ] Check whether the file is inside a `bidirectional=true` pair's `vaultDestFolder`.
  - [ ] Match against `bidirectionalScope` filters.
  - [ ] If yes, set `pendingUpload` on the manifest entry (or create a `{ pendingUpload, vaultPath, pairId }` placeholder for newly-created files).
  - [ ] Debounce per-file (200ms) to coalesce rapid edits.
- [ ] **Critical:** ignore changes the plugin itself just wrote. Track an in-memory `recentlyWrittenPaths: Map<string, number>` keyed by path, with a TTL of 2s. Skip the listener when the file path is in there.

### 10.4 Upload pipeline

New file `sync/DriveUploader.ts`. Responsibilities:

- [ ] **Created** files → Drive `files.create` (multipart) under the resolved Drive folder. Capture the new `driveFileId` and write a manifest entry.
- [ ] **Modified** files → Drive `files.update` with the new bytes. Update `driveModifiedTime` from the response, update both content hashes.
- [ ] **Renamed** files → Drive `files.update` with `{ name }`. If the rename also moves to a different folder, also `addParents`/`removeParents`.
- [ ] **Deleted** files → respect a per-pair setting `vaultDeletionBehavior`: `keep_in_drive` (default), `trash` (move to Drive trash), `archive` (move to the configured archive folder), `delete` (genuinely purge — needs second confirmation).
- [ ] All upload calls go through the same exponential-backoff retry wrapper as the download path (see Phase 5.5 in archive).

### 10.5 Conflict detection

A conflict exists when **both** of the following are true:
- The vault file's content hash differs from `vaultContentHash` (user edited locally since last sync), AND
- The Drive file's `modifiedTime` is newer than the manifest's `driveModifiedTime` (Drive edited since last sync).

Implement:
- [ ] In `DriveSync.processEntry()`, before downloading: detect conflict using the rule above. If found, do **not** overwrite. Route to §10.6.
- [ ] Mirror the same check before upload: download the current Drive bytes, hash, compare.
- [ ] Conflict-free push and conflict-free pull both happen in the same sync run, in this order: pulls first (fast-fail on local conflict), then pushes.

### 10.6 Conflict resolution

Reuse `conflictPolicy` from the existing settings (`save-both` | `keep-vault` | `take-drive` | `ask`), extended:

- [ ] `save-both` (default) — write Drive's version to `<basename>.drive-conflict-<ts>.<ext>` next to the local file; keep local; queue a fresh upload of the local version. Same on the Drive side: rename the Drive file with a suffix and upload local as a new file.
- [ ] `keep-vault` — push local; overwrite Drive.
- [ ] `take-drive` — pull Drive; overwrite local. Make a `.local-backup-<ts>` copy first.
- [ ] `ask` — open the existing `ConflictModal` ([ui/ConflictModal.ts](ui/ConflictModal.ts)) extended with a 3-pane diff (vault / drive / merged) and a "save both" default.
- [ ] Every resolution writes to `conflictHistory` and the activity log.

### 10.7 Transactional sync run (hard requirement)

Two-way sync must never leave the manifest in an inconsistent state.

- [ ] Wrap each pair's sync run in a transaction object that buffers manifest writes in memory.
- [ ] On any unrecoverable error, discard the buffer; the manifest on disk remains as it was at the start of the run.
- [ ] On success, atomic-write the buffer to `.obsidian/drive-sync-manifest.json.tmp` then `rename` to the real path (Phase 5.5 in archive already implemented this for one-way; extend it).
- [ ] Split the sync into **phases** with explicit checkpoints: `pull-changes`, `detect-conflicts`, `resolve-conflicts`, `push-changes`, `apply-deletions`. Each checkpoint flushes the buffer; a failure inside a phase rolls back only that phase.

### 10.8 Pre-write safety net

Before **any** destructive operation (overwrite, delete, rename) on either side:

- [ ] Write a backup to `.obsidian/drive-sync-recycle/<pairId>/<ts>-<sanitized-path>` containing the bytes about to be replaced (capped at 50MB per file by default, configurable).
- [ ] Garbage-collect the recycle directory: keep last 7 days, capped at 500MB total.
- [ ] Add a `drive-sync:open-recycle` command that opens this folder.

### 10.9 Rate-limit and quota guardrails

- [ ] Cap upload concurrency separately from download (`uploadConcurrency`, default `2`).
- [ ] Track Drive API quota usage per minute; if we hit 80% of the per-user quota, pause uploads for the rest of the minute.
- [ ] Settings: `maxBytesPerSync` (default 100MB) — a per-run safety brake. Refuse a run that would upload more than this without the user explicitly clicking "Override for this run".

### 10.10 Dry-run for two-way

The existing dry-run mode currently shows downloads + removals. Extend:

- [ ] Show planned uploads, conflicts, and the resolution that **would** apply for each.
- [ ] Show planned deletions on the Drive side (with the file names, not just counts).
- [ ] No network writes happen in dry-run; only reads.

### 10.11 Observability

Two-way sync amplifies every existing failure mode. The user must be able to see what happened.

- [ ] Extend `SyncActivityLog` with new event types: `upload`, `upload-conflict`, `upload-error`, `recycle-write`, `quota-pause`.
- [ ] Show a separate counter in `SyncStatusView` for "pending uploads" (count of manifest entries with `pendingUpload`).
- [ ] On any upload failure, surface a persistent (non-auto-dismissing) notice with a button to open the activity log.

### 10.12 Migration and kill switch

- [ ] Add a "Disable two-way sync for all pairs" button at the top of the Sync tab. One click reverts every pair to `bidirectional=false` without touching files. For when something goes wrong.
- [ ] On plugin upgrade to the version that introduces two-way, run a migration that explicitly sets `bidirectional=false` on every existing pair (defensive — never silently enable).

### 10.13 Verification (acceptance criteria — every single one must pass)

- [ ] Create a markdown note in a bidirectional pair's vault folder → after one sync cycle it appears in Drive with matching content.
- [ ] Edit the file in Drive → after the next sync, the vault file matches Drive (no conflict because vault didn't change).
- [ ] Edit the file in Drive AND in the vault between two sync runs → conflict is detected, `save-both` produces both files, neither version is silently lost.
- [ ] Rename a file in the vault → Drive name updates; backlinks in the vault remain intact (use `fileManager.renameFile`).
- [ ] Delete a file in the vault with `vaultDeletionBehavior=trash` → file moves to Drive trash; restoring it from Drive trash and re-syncing restores the vault copy.
- [ ] Kill the network mid-upload → next sync resumes from `pendingUpload`; no manifest corruption.
- [ ] Trigger 50 vault edits in 10 seconds → upload queue debounces; no API rate-limit error.
- [ ] Run `drive-sync:audit` → reports zero drift after a full bidirectional cycle.

**Files:** `types.ts`, `sync/DriveSync.ts`, new `sync/DriveUploader.ts`, new `sync/SyncTransaction.ts`, `sync/SyncManifest.ts`, `sync/SyncLog.ts`, `ui/ConflictModal.ts`, `ui/SyncStatusView.ts`, `settings/SettingsTab.ts`, `main.ts`.

---

## Phase 11 — Architectural / correctness upgrades

These can be tackled independently of Phases 7-10 once those are merged. Each subsection is self-contained; pick the highest-value one for the moment. Recommended order is **11.2 → 11.5 → 11.1 → 11.3 → 11.4** because manifest scaling and the event bus are prerequisites for the others.

### 11.1 Drive `changes` API instead of full folder polling

**Goal:** Stop refetching the entire folder tree per pair on every sync interval.

- [ ] Bootstrap: call `changes.getStartPageToken()` once per pair, store in manifest as `pair.driveStartPageToken`.
- [ ] Per sync: call `changes.list(pageToken)` instead of walking the folder. Process only the returned changes.
- [ ] Filter changes to those whose `file.parents` intersect the pair's tracked folder set (Drive returns global changes; we ignore the rest).
- [ ] Fall back to a full re-scan when the API returns `newStartPageToken` without a `nextPageToken` and we detect drift (e.g., a file in the manifest that the changes feed never mentioned and isn't in the folder anymore — handled by a periodic sanity sweep, default once per 24h).
- [ ] Settings toggle `useChangesApi` (default `false` until proven). Per-pair override.
- [ ] **Verification:** Sync a pair with 5000 files; second sync after a single Drive edit issues 1-2 API calls instead of N.

**Files:** `sync/DriveSync.ts`, `auth/GoogleAuth.ts` (scope check — `changes.list` needs `drive.metadata.readonly` if not already granted), `types.ts`, `settings/SettingsTab.ts`.

### 11.2 SQLite-backed manifest

**Goal:** Constant-time lookups + cheap atomic transactions, replacing the JSON blob.

- [ ] Add `@sqlite.org/sqlite-wasm` (or `sql.js`). Decide based on bundle size.
- [ ] Schema: `entries(drive_file_id PRIMARY KEY, vault_path UNIQUE, companion_path, drive_modified_time, …)`, `automation_runs(drive_file_id, automation_id, last_run_at, …, PRIMARY KEY (drive_file_id, automation_id))`, `pairs_meta(pair_id, drive_start_page_token, …)`.
- [ ] Adapter pattern: `SyncManifestStore` becomes an interface; `JsonManifestStore` (current) and `SqliteManifestStore` (new) both implement it. Existing code is untouched.
- [ ] Migration: on first load with `useSqliteManifest=true`, read the JSON manifest, write to SQLite, keep the JSON as `.obsidian/drive-sync-manifest.json.legacy`.
- [ ] Use `BEGIN IMMEDIATE` / `COMMIT` per sync phase; this replaces the in-memory buffer pattern from Phase 5.5 / 10.7.
- [ ] **Verification:** Sync a vault with 20K manifest entries; load time drops from O(seconds) to O(milliseconds); per-entry write does not rewrite the whole file.

**Files:** new `sync/manifest/SqliteManifestStore.ts`, refactor `sync/SyncManifest.ts` into an interface + `JsonManifestStore`, `package.json`, `esbuild.config.mjs`.

### 11.3 Content-addressed download cache

**Goal:** Drive moves/renames/duplicates never re-download bytes we already have.

- [ ] On every download, write to `.obsidian/drive-sync-cache/<sha256>` and symlink/copy from there to the vault destination.
- [ ] Manifest entry gains `contentHash: string`. On Drive change, compare new `md5Checksum` (Drive returns this for binary files — see §11.4) against `contentHash`. If equal, skip download.
- [ ] Cache GC: LRU eviction, default cap 2GB (configurable). Evict cache entries whose hash is not referenced in the manifest first.
- [ ] **Verification:** Move a 50MB PDF in Drive across folders; observe sync log shows "moved (cache hit)" with zero bytes downloaded.

**Files:** `sync/DownloadManager.ts`, `sync/DriveSync.ts`, `types.ts`, new `sync/CacheManager.ts`.

### 11.4 Off-thread heavy work (Web Worker)

**Goal:** Stop freezing the Obsidian UI on PDF parsing and large-file hashing.

- [ ] New `workers/heavyWorker.ts` exposing `hashFile(bytes)`, `hashPdfPages(bytes)`, `extractPdfText(bytes, fromPage?, toPage?)`.
- [ ] Bundle the worker as a separate entry in `esbuild.config.mjs`, ship as a string, instantiate via `new Worker(URL.createObjectURL(new Blob([workerSrc])))`.
- [ ] Move `ai/PdfPageHasher.ts` and any sha256 of large blobs onto the worker.
- [ ] Cap concurrent worker tasks (default `navigator.hardwareConcurrency - 1`).
- [ ] **Verification:** Sync a folder with 50 200-page PDFs; UI stays interactive throughout.

**Files:** new `workers/heavyWorker.ts`, `ai/PdfPageHasher.ts`, `esbuild.config.mjs`, `sync/DriveSync.ts`.

### 11.5 Internal typed pub/sub event bus

**Goal:** Decouple `DriveSync`, `AutomationEngine`, `CompanionNoteManager`, and the status view; make Phase 10 wiring sane.

- [ ] New `events/EventBus.ts` — typed emitter: `on<E extends keyof Events>(event: E, handler: (e: Events[E]) => void)`.
- [ ] Define event payloads for `downloaded`, `uploaded`, `skipped`, `conflict`, `automation-run`, `manifest-write`, `auth-failed`, `recycle-write`.
- [ ] Refactor existing direct calls (e.g., `pushResultToStatusView` in `main.ts:397`) to subscribe via the bus.
- [ ] Status view, activity log, and notice handler all subscribe rather than being called directly.
- [ ] **Verification:** Adding a new subscriber (e.g., a notification badge) requires zero changes in `DriveSync`.

**Files:** new `events/EventBus.ts`, `sync/DriveSync.ts`, `sync/CompanionNoteManager.ts`, `automation/AutomationEngine.ts`, `ui/SyncStatusView.ts`, `main.ts`.

---

## Phase 12 — UX / observability

Independently shippable; each can land in its own PR.

### 12.1 Live activity ticker

- [ ] Add a "Live" tab in `SyncStatusView` showing the last 50 events from the EventBus (Phase 11.5) in reverse chronological order.
- [ ] Each row: timestamp, icon by event type, file path (clickable), one-line summary. Clear button.
- [ ] Auto-scroll on new events; pause-on-hover.

**Files:** `ui/SyncStatusView.ts`, depends on `events/EventBus.ts` from §11.5.

### 12.2 Per-pair health badge

- [ ] Compute health per pair on each sync: `green` if last sync succeeded < 2× interval ago and zero errors in last hour; `yellow` if errors-in-hour > 0 OR last sync > 2× interval ago; `red` if last 3 syncs all failed.
- [ ] Render a colored dot next to each pair label in the Sync settings tab and the status view.
- [ ] Tooltip on hover shows the underlying numbers.

**Files:** `settings/SettingsTab.ts`, `ui/SyncStatusView.ts`, `sync/SyncManifest.ts` (track per-pair sync history).

### 12.3 In-app changelog on update

- [ ] Bundle `CHANGELOG.md` with the plugin (already common practice for community plugins).
- [ ] On `onload`, compare `manifest.json:version` against `data.json:lastSeenVersion`. If different, parse the new entries from the changelog and show a one-time modal.
- [ ] Modal includes a "Don't show again" checkbox and a link to the GitHub release page.

**Files:** new `ui/ChangelogModal.ts`, `main.ts`, `CHANGELOG.md` (create + maintain).

### 12.4 First-run wizard for two-way pairs

Pre-req: Phase 10 shipped.

- [ ] When the user toggles `bidirectional=true` for the first time on **any** pair, open a 4-step wizard: scope filters → conflict policy → recycle retention → mandatory dry-run with results review.
- [ ] Persist `bidirectionalOnboardingCompleted: true` so subsequent toggles use a one-line confirm.
- [ ] Wizard cannot be skipped on the first time. Subsequent first-time toggles per pair show a one-screen summary.

**Files:** new `ui/BidirectionalWizardModal.ts`, `settings/SettingsTab.ts`.

### 12.5 Sandbox "test sync" mode per pair

- [ ] Per-pair button "Test sync against sandbox subfolder…" — prompts for a subfolder name, runs one sync round limited to that subfolder, shows a result modal.
- [ ] Useful for proving a config (especially bidirectional) on a small slice before going live.

**Files:** `settings/SettingsTab.ts`, `sync/DriveSync.ts` (accept `scopeSubfolderPath` option).

---

## Phase 13 — Safety nets / failure containment

Each task is small and independently mergeable. Sort by what's bitten you most.

### 13.1 Disk-space pre-flight

- [ ] Before each sync, sum the expected download size from the changes feed (or estimate at 2× when unknown). If `2× expected > free disk`, abort with a clear notice; don't start the sync at all.
- [ ] Use `navigator.storage.estimate()` for cross-platform free-space; fall back to a Node `statvfs` call on desktop where available.

**Files:** `sync/DriveSync.ts`, new `sync/DiskSpaceCheck.ts`.

### 13.2 Manifest schema versioning + auto-backup

- [ ] Add `manifestSchemaVersion: number` to the manifest root. Bump when the shape changes.
- [ ] On every successful manifest write, also write a copy to `.obsidian/drive-sync-manifest.backups/<YYYY-MM-DD-HHmmss>.json`.
- [ ] Keep last N backups (default 20). GC older ones.
- [ ] Add `drive-sync:restore-manifest` command that lists backups in a modal and restores the chosen one (with a 2-step confirm).

**Files:** `sync/SyncManifest.ts`, `main.ts`.

### 13.3 Effective sync-rate cap

- [ ] Enforce a minimum interval of 60 seconds regardless of `syncIntervalMinutes` (clamp + log a warning if the user sets less).
- [ ] Per-pair token bucket: max 30 sync runs per hour per pair. Above the cap, log a warning and skip the run.

**Files:** `sync/Scheduler.ts`, `sync/DriveSync.ts`.

### 13.4 `drive-sync:verify-integrity` command

- [ ] Walk the manifest. For each entry: check vault file exists, hash it, compare to `vaultContentHash` (when present from Phase 10.2).
- [ ] Build a report grouped by drift type: `missing` / `hash-mismatch` / `mtime-mismatch` / `manifest-only`.
- [ ] Modal shows the report with per-row "Fix" actions where applicable (re-download from Drive, remove from manifest, etc.).
- [ ] Pure-read; no side effects until the user clicks Fix.

**Files:** new `commands/VerifyIntegrity.ts`, `main.ts`.

### 13.5 Crash-safe recycle bin (extends Phase 10.8)

- [ ] Each recycled file gets a sibling `.json` sidecar: `{ originalPath, driveFileId, pairId, action, timestamp, sha256, restoreInstructions }`.
- [ ] New `drive-sync:undo-last-sync` command: scans the recycle bin for entries written in the last sync run (group by `syncRunId`) and restores them with a confirm modal.
- [ ] Only the most recent run is undoable; older runs require manual restore from `drive-sync:open-recycle`.

**Files:** `sync/Recycle.ts` (new — encapsulates the recycle logic from §10.8), new `commands/UndoLastSync.ts`, `main.ts`.

### 13.6 Opt-in anonymous error reporting

- [ ] Capture unhandled errors in a global `Promise.unhandledRejection` + `window.onerror` handler.
- [ ] Strip vault paths, file names, and any string > 64 chars before sending. Send only: error class, message template, stack frames.
- [ ] Settings toggle (default OFF) + endpoint URL (default empty — user supplies their own collector or uses ours if/when one exists).
- [ ] Show the exact JSON that would be sent, with a "Send test report" button, before enabling.

**Files:** new `telemetry/ErrorReporter.ts`, `main.ts`, `settings/SettingsTab.ts`.

### 13.7 Per-file frontmatter direction overrides

Pre-req: Phase 10 shipped (only meaningful in bidirectional pairs).

- [ ] Honor companion frontmatter `drive-sync-direction: pull-only | push-only | both | paused`. Default `both` in bidirectional pairs.
- [ ] Honor `drive-sync-direction` set on the **synced file itself** (not just the companion) for non-companion bidirectional pairs.
- [ ] Surface in the Audit modal: list files with non-default direction so users remember they set it.

**Files:** `automation/AutomationEngine.ts` (already reads similar flags), `sync/DriveSync.ts`, `sync/DriveUploader.ts`, `commands/Audit.ts`.

### 13.8 Auth refresh-token expiry UX

- [ ] Wrap every Drive API call in a 401 detector. On a confirmed auth failure (after a refresh attempt), set `auth.state = "expired"`.
- [ ] When `expired`, the scheduler pauses, the ribbon icon turns red with a badge, and a non-dismissable notice asks the user to re-auth.
- [ ] One-click re-auth from the notice opens the OAuth flow.
- [ ] Activity log records the moment auth went stale and the moment it was restored.

**Files:** `auth/GoogleAuth.ts`, `sync/DriveSync.ts`, `main.ts`, `ui/SyncStatusView.ts`.

### 13.9 Use Drive `md5Checksum` for change detection

- [ ] When listing files, request `md5Checksum` in the `fields` parameter (already supported for binary files; ignored for Google-native types).
- [ ] Manifest stores `driveMd5: string`. On change-detection, compare `md5Checksum` first; only fall back to `modifiedTime` when md5 is unavailable (Google Docs etc.).
- [ ] Skips wasted Gemini calls when Drive's `modifiedTime` bumps but content is identical (a real, observed bug).

**Files:** `sync/DriveSync.ts`, `types.ts`.

### 13.10 Automation-config linter

- [ ] On settings save and inside `commands/Audit.ts`, validate every automation:
  - [ ] `triggerFolderPath` resolves to an existing vault folder
  - [ ] `targetNotePath` (when used) refers to an existing note
  - [ ] `searchFolderPath`, `newNoteFolder`, `newNoteTemplatePath` exist
  - [ ] No two enabled automations share identical `(triggerFolderPath, action.type, …)` (warn — sometimes intended)
  - [ ] `matchConfidenceThreshold` in `[0, 1]`
- [ ] Show the lint result inline in the automation card (red border + tooltip) and as a section in the audit modal.

**Files:** new `automation/AutomationLinter.ts`, `settings/SettingsTab.ts`, `commands/Audit.ts`.

---

## Quick-reference: file paths (unchanged from previous round)

| File | What |
|---|---|
| `main.ts` | Plugin entry, ribbon icons, vault event listeners, scheduler |
| `types.ts` | All shared types — `ManifestEntry`, `Automation`, pair config |
| `sync/DriveSync.ts` | Two-phase sync; download + automations + deletion pass |
| `sync/SyncManifest.ts` | Drive-ID → vault state mapping (the source of truth) |
| `sync/CompanionNoteManager.ts` | Companion creation, update, frontmatter |
| `automation/AutomationEngine.ts` | Automation matching + execution |
| `ai/GeminiClient.ts` | Gemini API wrapper |
| `ai/MistralClient.ts` | Mistral API wrapper |
| `ai/TranscriptionStore.ts` | Per-page transcription store |
| `commands/TranscribeCurrentFile.ts` | Transcribe-on-demand command |
| `commands/Audit.ts` | Manifest health audit |
| `settings/SettingsTab.ts` | All settings UI |
| `ui/SyncStatusView.ts` | Status side-panel |
| `ui/FileTrackerModal.ts` | Vault-wide file inspector |
| `ui/ConflictModal.ts` | Conflict resolution UI |
