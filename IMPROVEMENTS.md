# IMPROVEMENTS.md

Action plan for the next round of drive-folder-sync features. Implementation is divided into phases — each phase builds on the previous one. Every feature section is self-contained: drop it into a fresh chat as the starting brief.

**Conventions:**
- **Drive ID** = immutable Google Drive file ID. The only reliable identity for tracking.
- **Companion note** = markdown sidecar created by `CompanionNoteManager`.
- **Manifest** = `.obsidian/drive-sync-manifest.json` (`sync/SyncManifest.ts`). Authoritative source of truth.

---

## Phase 0 — Foundations (low risk, unblocks everything)

### 0.1 Command palette commands

**Goal:** Expose existing functionality (sync, dry-run, per-pair sync) via the command palette. Foundation for later commands.

**Tasks:**
- [x] Register `drive-sync:sync-now` in `main.ts` → `runSync(false)`
- [x] Register `drive-sync:dry-run` → `runSync(true)`
- [x] Register `drive-sync:sync-pair` → modal picks pair, calls `runSyncForPair(pairId)`
- [x] Add a `SuggestModal<SyncPair>` for the pair picker (reuse Obsidian's `FuzzySuggestModal`)
- [x] All commands use plain `callback`, not `checkCallback` — always available

**Files:** `main.ts` only.

**Verification:** Open command palette in a vault with the plugin loaded; commands appear and execute.

---

### 0.2 Frontmatter tracking on companion notes

**Goal:** Make the PDF ↔ companion-note relationship self-describing inside the markdown. Foundation for idempotent re-runs (Phase 1) — we need somewhere to read run state from.

**Tasks:**
- [x] Extend default companion template in `sync/CompanionNoteManager.ts:6-24` with new fields:
  - [x] `companion-of: "[[<sourceVaultPath>]]"` — Obsidian wikilink to the source PDF
  - [x] `sourceVaultPath: "<path>"` — string fallback if the wikilink breaks
  - [x] Rename existing `lastUpdate` → `sourceDriveModifiedTime` for clarity (migrate old field on read)
  - [x] Keep existing `driveFileId`, `transcribed`, `pairLabel`, `syncDate`
- [x] Update `CompanionNoteManager.update()` to refresh the new fields while preserving user-added frontmatter (use Obsidian's `processFrontMatter` API)
- [x] Add a migration helper: on first sync after upgrade, rewrite old companion frontmatter to the new schema
- [x] **Start reading `transcribed: true`** before re-transcribing (currently set but ignored)

**Files:** `sync/CompanionNoteManager.ts`, `sync/DriveSync.ts:408-441`.

**Verification:** Sync a new PDF → companion has `companion-of` wikilink that resolves. Manually rename the PDF in the vault → companion still resolves (via `sourceVaultPath` fallback).

---

## Phase 1 — Idempotency core

### 1.1 Per-file/per-automation run ledger

**Goal:** The same automation must never duplicate work. Same companion must never be created twice. Same PDF must never be re-transcribed unless content changed or user forces it.

**Tasks:**
- [x] Extend `ManifestEntry` in `types.ts`:
  ```ts
  automationRuns?: {
    [automationId: string]: {
      lastRunAt: string;                  // ISO
      lastRunDriveModifiedTime: string;   // what we ran against
      result: "success" | "skipped" | "error";
      outputs?: string[];                  // e.g. ["daily-note:2026-05-10", "companion:Notes/foo.md"]
      errorMessage?: string;
    };
  };
  ```
- [x] Add `SyncManifest.recordAutomationRun(driveFileId, automationId, run)` and `getAutomationRun(driveFileId, automationId)`
- [x] Implement the decision matrix in `AutomationEngine.ts` — wrap every `runAction()` call:

  | Condition | Default | `force=true` |
  |---|---|---|
  | Never run before | RUN | RUN |
  | Ran before, `driveModifiedTime` unchanged | SKIP | RUN |
  | Ran before, `driveModifiedTime` newer | RUN | RUN |
  | Last result was `error` | RUN | RUN |

- [x] Record `success` / `skipped` / `error` after each run

**Files:** `types.ts`, `sync/SyncManifest.ts`, `automation/AutomationEngine.ts`.

---

### 1.2 Companion-creation guard

**Tasks:**
- [x] Before `CompanionNoteManager.create()`, look up the manifest entry's `companionPath`. If present AND file exists on disk → switch to `update()`.
- [x] If `companionPath` missing but a file with the expected stem exists at the expected location → **adopt** it (write `driveFileId` to its frontmatter, update manifest) instead of creating a new one.

**Files:** `sync/CompanionNoteManager.ts`.

---

### 1.3 Transcription guard

**Tasks:**
- [x] Read companion `transcribed: true` flag before calling Gemini
- [x] If `transcribed=true` AND PDF's `driveModifiedTime` matches the stored `sourceDriveModifiedTime` → skip
- [x] Honor `force=true` to override

**Files:** `sync/DriveSync.ts`, `sync/CompanionNoteManager.ts`.

---

### 1.4 Embed/link/tag guards audit

**Tasks:**
- [x] Embed insertions already de-duped at `AutomationEngine.ts:544-546` — verify still correct
- [x] Audit `link_to_matching_note` action for the same de-dup pattern; add if missing
- [x] Audit `add_tag_to_companion` action — don't re-add an existing tag

**Files:** `automation/AutomationEngine.ts`.

**Verification (Phase 1):** Run sync twice in a row with no Drive changes → second run logs all automations as `skipped`. Touch a PDF in Drive (no real change) → modifiedTime advances → automations re-run but companion content is unchanged.

---

## Phase 2 — User-facing re-run controls

### 2.1 Per-automation "Run on existing files" button

**Goal:** Apply an existing automation to files already in the vault, without forcing a re-sync.

**Tasks:**
- [x] Add `AutomationEngine.runForAllMatchingFiles(automationId, opts: { force?: boolean, dryRun?: boolean })`:
  - [x] Iterate every manifest entry
  - [x] Filter by automation's `triggerFolderPath` + `scope` + `excluded`
  - [x] Apply the §1.1 decision matrix per file
  - [x] Call `runAction()` for each match
  - [x] Return `{ matched, ran, skipped, errors }`
- [x] Add "Run on existing files" button next to each automation row in `settings/SettingsTab.ts`
- [x] Confirmation modal shows: "This will check N matching files. Force re-run already-completed files? [No / Yes]"
- [x] Progress notice during execution; final summary notice

**Files:** `automation/AutomationEngine.ts`, `settings/SettingsTab.ts`.

---

### 2.2 Command palette: run automations

**Tasks:**
- [x] `drive-sync:run-automations-all` → iterates every active automation, calls `runForAllMatchingFiles(id, { force: false })`
- [x] `drive-sync:run-automation` → modal picks one automation, then prompt for `force` y/n
- [x] Both reuse the Phase 0 modal pattern

**Files:** `main.ts`.

**Verification (Phase 2):** Click "Run on existing files" twice for the same automation → second run reports 0 ran, N skipped.

---

## Phase 3 — Transcribe current file command

**Goal:** Command palette entry that transcribes the currently active file to a chosen destination.

**Tasks:**
- [x] Register `drive-sync:transcribe-current-file` in `main.ts`
- [x] Create `commands/TranscribeCurrentFile.ts`:
  - [x] Get active file via `app.workspace.getActiveFile()`
  - [x] Validate file type (PDF for v1; flag images/audio as out-of-scope)
  - [x] Modal: choose destination
    - [x] Companion note (create if missing)
    - [x] Today's daily note
    - [x] Pick a file… (`FuzzySuggestModal` over all markdown files)
  - [x] If destination already has a transcription, prompt: skip / append / replace
  - [x] Call `GeminiClient.transcribePdf()`
  - [x] Write to destination using existing helpers (`CompanionNoteManager.update()` for companion path, plain `vault.process()` otherwise)
- [x] Resolve daily-note path:
  - [x] Try Obsidian's Daily Notes plugin settings first
  - [x] Fall back to plugin setting `transcribeDailyNoteFormat` (default: `YYYY-MM-DD.md` in vault root)

**Files:** `main.ts`, new `commands/TranscribeCurrentFile.ts`, reuses `ai/GeminiClient.ts` + `sync/CompanionNoteManager.ts`.

**Decisions made:**
- Daily note path: reads core Daily Notes plugin settings first (format + folder), falls back to `periodicNotesPaths.daily` template, then `YYYY-MM-DD.md` in vault root.
- Non-PDF support (images, audio): deferred to a follow-up phase.

**Verification:** Open a PDF, run command, pick "Today's daily note" → transcription appears under a heading in today's note. Run again → prompt asks before overwriting.

---

## Phase 4 — Partial PDF re-transcription

**Goal:** When a PDF updates, only re-transcribe pages whose content actually changed. Saves Gemini tokens; preserves stable pages.

### 4.1 Per-page fingerprint store

**Tasks:**
- [ ] New `ai/PdfPageHasher.ts`:
  - [ ] Use `pdfjs-dist` to extract text per page
  - [ ] Return `{ pageNumber, textHash, charCount }[]`
- [ ] New `ai/TranscriptionStore.ts`:
  - [ ] Sidecar JSON at `.obsidian/drive-sync-transcriptions/<driveFileId>.json`:
    ```json
    {
      "driveFileId": "…",
      "pdfHash": "sha256-of-full-pdf",
      "pages": [
        { "n": 1, "hash": "…", "text": "…", "transcribedAt": "2026-05-10T…" }
      ]
    }
    ```
  - [ ] CRUD: `load(driveFileId)`, `save(driveFileId, store)`, `delete(driveFileId)`

### 4.2 Page-range transcription via Gemini

**Tasks:**
- [ ] Add `GeminiClient.transcribePdfPageRange(pdfBuffer, fromPage, toPage): Promise<{ page, text }[]>`
- [ ] Prompt template: `"Transcribe pages {N}-{M} of this PDF. Output as: ## Page N\\n<text>\\n## Page N+1\\n<text>…"`
- [ ] Parse response back into per-page chunks
- [ ] Fallback: if returned page count ≠ requested → log warning, fall back to full re-transcription

### 4.3 Change detection + re-assembly

**Tasks:**
- [ ] In `DriveSync.ts` transcription path:
  - [ ] Hash all pages of the new PDF
  - [ ] Diff against `TranscriptionStore` — collect changed page numbers
  - [ ] If none changed → skip Gemini entirely, mark `success`
  - [ ] If some changed → call `transcribePdfPageRange` with the changed range(s) (collapse contiguous ranges)
  - [ ] Update store with new per-page records
  - [ ] Re-render the companion's `## Transcription` section from the store, in page order

### 4.4 Force-full command

**Tasks:**
- [ ] Add `drive-sync:force-full-retranscribe` command — clears the store entry for the active file's PDF, then transcribes from scratch
- [ ] Useful when extraction drifts or you want a clean baseline

**Files:** new `ai/PdfPageHasher.ts`, new `ai/TranscriptionStore.ts`, `ai/GeminiClient.ts`, `sync/DriveSync.ts:408-441`, `sync/CompanionNoteManager.ts` (render from store), `main.ts`.

**Open questions:**
- [ ] Empirical test of Gemini's reliability on page-range requests before committing to this design
- [ ] If `pdfjs-dist` extracted text differs from Gemini's transcription output → which is canonical for hashing? Decide: hash the extracted text (deterministic, local), use Gemini for human-quality rendering

**Verification:** Transcribe a 20-page PDF. Edit page 7 in Drive. Re-sync → log shows "1 page changed, 1 page transcribed". Companion `## Transcription` has updated page 7 only, pages 1–6 and 8–20 byte-identical to before.

---

## Phase 5 — Failure-point mitigations

These follow the audit in the "Failure Points" section below. Implement after the core features are stable.

### 5.1 Use `fileManager.renameFile` for backlink safety

**Goal:** Renames in Drive trigger vault renames; today's `vault.rename()` breaks backlinks.

**Tasks:**
- [x] Replace `vault.rename()` with `app.fileManager.renameFile()` in `DriveSync.handleRename()`
- [x] Same for companion note renames

**Files:** `sync/DriveSync.ts:467-509`.

---

### 5.2 Heal companion renames in vault

**Goal:** Today only the PDF rename is healed; user renaming the companion breaks the manifest mapping.

**Tasks:**
- [x] Extend `manifest.healRename()` (or add `healCompanionRename()`) to detect when a renamed file is a companion (matches a `companionPath` in the manifest) and update accordingly
- [x] Hook into `vault.on("rename")` in `main.ts`

**Files:** `sync/SyncManifest.ts`, `main.ts:93-100`.

---

### 5.3 Detect user vault-side deletions

**Goal:** If user deletes the PDF in Obsidian, next sync re-downloads it as a ghost.

**Tasks:**
- [x] Hook `vault.on("delete")` — if the deleted file matches a manifest entry's `vaultPath`, mark `userDeleted: true` with timestamp
- [x] In `DriveSync.processEntry()`, skip re-download for `userDeleted=true` entries UNLESS Drive's `modifiedTime` advances past the deletion timestamp
- [x] Add a settings toggle: "Re-download user-deleted files when Drive updates them" (default: ask)

**Files:** `types.ts` (extend `ManifestEntry`), `sync/SyncManifest.ts`, `sync/DriveSync.ts`, `main.ts`.

---

### 5.4 Concurrent edit protection

**Goal:** Sync overwriting a companion while user is editing it silently clobbers unsaved changes.

**Tasks:**
- [x] Before overwriting a companion, check `app.vault.adapter.stat(companionPath).mtime` vs the manifest's last-known mtime
- [x] If vault mtime is newer → log a conflict, write a `.conflict-<timestamp>.md` backup, then proceed
- [x] Surface the conflict in the status view

**Files:** `sync/CompanionNoteManager.ts`, `ui/SyncStatusView.ts`.

---

### 5.5 Transactional manifest writes

**Goal:** Sync errors mid-run leave the manifest in an inconsistent state.

**Tasks:**
- [x] Buffer manifest updates in memory during a sync
- [x] Write to `.obsidian/drive-sync-manifest.json.tmp` then atomic rename on phase boundary
- [x] Add Drive API retry with exponential backoff (max 3 retries)

**Files:** `sync/SyncManifest.ts`, `sync/DriveSync.ts`.

---

### 5.6 Trashed vs purged Drive files

**Goal:** Don't delete vault copies when files are only in Drive Trash (still recoverable).

**Tasks:**
- [x] Audit the Drive list query — make `trashed=true` files visible
- [x] On finding a trashed file: mark manifest entry `driveTrashed: true`, preserve vault copy
- [x] Only delete vault copy when file is genuinely missing from Drive (not just trashed)

**Files:** `sync/DriveSync.ts` (Drive query + Phase 2 deletion logic).

---

### 5.7 Cross-pair move companion-folder recompute

**Goal:** When a file moves across pairs with different companion-folder configs, the companion needs to move under the new pair's rules.

**Tasks:**
- [x] In `handleRename()`, when `pairId` changes, recompute companion path under the new pair's `companionFolder` settings (don't reuse old pair's resolved path)
- [x] Move the companion file to the new location
- [x] Update manifest with the new `companionPath`

**Files:** `sync/DriveSync.ts`, `sync/CompanionNoteManager.ts`.

---

## Phase 6 — Quality-of-life features

These are independent suggestions from the planning round. Pick and choose based on priority.

### 6.1 Conflict resolution UI

**Goal:** When both Drive and vault have changed, give the user a choice instead of silently overwriting.

**Tasks:**
- [ ] Add a `ConflictModal` showing both versions side-by-side
- [ ] Options: keep vault / take Drive / save both (with timestamp suffix)
- [ ] Surface via `vault.on("modify")` tracking — flag companion notes the user has edited since last sync
- [ ] Add a "Conflict policy" setting: ask / always-keep-vault / always-take-drive / always-save-both

**Files:** new `ui/ConflictModal.ts`, `sync/CompanionNoteManager.ts`, `settings/SettingsTab.ts`.

---

### 6.2 Per-file automation opt-out via frontmatter

**Goal:** Let users skip specific automations on individual files without changing folder config.

**Tasks:**
- [ ] Read `drive-sync-skip-automations: [<automationId>, …]` from companion frontmatter
- [ ] In `AutomationEngine.runForFile()`, check this list and skip matching automations
- [ ] Also support `drive-sync-skip-all: true` as a shortcut
- [ ] Document the flag in the settings tab

**Files:** `automation/AutomationEngine.ts`, `settings/SettingsTab.ts` (docs only).

---

### 6.3 Sync activity log

**Goal:** Rolling log of what happened during each sync. Current status view is good for "now"; useless for "last Tuesday".

**Tasks:**
- [ ] New `sync/SyncLog.ts` — append-only `.obsidian/drive-sync.log` (JSON-lines)
- [ ] Log entries: `{ ts, level, syncId, file?, action, result, details? }`
- [ ] Rotate at 10MB; keep last 3 rotations
- [ ] Add a "View sync log" command + simple modal viewer
- [ ] Settings toggle: log level (info / warn / error)

**Files:** new `sync/SyncLog.ts`, `main.ts`, `ui/SyncLogModal.ts`, `settings/SettingsTab.ts`.

---

### 6.4 Per-pair Gemini token budget

**Goal:** Prevent runaway transcription costs.

**Tasks:**
- [ ] Add `monthlyTokenCap?: number` to pair config in `types.ts`
- [ ] Track tokens used per pair per month (reset on month boundary) in `.obsidian/drive-sync-usage.json`
- [ ] Before each Gemini call, check cap → if exceeded, skip transcription, log warning
- [ ] Surface usage in settings tab: "X / Y tokens used this month"
- [ ] Optional: email/notice when 80% / 100% reached

**Files:** `types.ts`, new `ai/UsageTracker.ts`, `ai/GeminiClient.ts`, `settings/SettingsTab.ts`.

---

### 6.5 Dry-run for automations

**Goal:** Show what re-running an automation would do, before doing it.

**Tasks:**
- [ ] `AutomationEngine.runForAllMatchingFiles()` already takes `dryRun: boolean` (per §2.1) — make sure it returns full preview without side effects
- [ ] Add "Dry run" alongside "Run" in the per-automation settings UI
- [ ] Show preview in a modal: file list, action that would happen, skip reasons

**Files:** `automation/AutomationEngine.ts`, `settings/SettingsTab.ts`.

---

### 6.6 Health check / audit command

**Goal:** Detect manifest drift, orphaned files, broken links.

**Tasks:**
- [ ] New `drive-sync:audit` command
- [ ] Walks the manifest and reports:
  - [ ] Manifest entries whose `vaultPath` no longer exists
  - [ ] Companion notes referencing a `driveFileId` not in the manifest
  - [ ] Companion notes whose `companion-of` wikilink doesn't resolve
  - [ ] PDFs in monitored folders missing from the manifest (un-synced state)
  - [ ] Duplicate companions for the same `driveFileId`
- [ ] Output as a modal with "Fix" buttons per category

**Files:** new `commands/Audit.ts`, `main.ts`.

---

## Failure points — current state audit

Honest assessment of how the plugin handles Drive-side changes today. Used to scope Phase 5.

| Scenario | Current handling | Risk | Mitigation phase |
|---|---|---|---|
| **Drive rename** | Works — Drive ID stable, path mismatch triggers `handleRename()` (`DriveSync.ts:390-392`) | Wikilinks to old PDF path break in companion | §5.1 |
| **Drive move within pair** | Works (same path-mismatch logic) | Wikilinks break | §5.1 |
| **Drive move across pairs** | Works — `globalSeenIds` + `pairId` update (`DriveSync.ts:96-104, 278-282`) | Companion may need to move under new pair's folder rules | §5.7 |
| **Drive deletion** | Phase 2 catches missing IDs; `deletionBehavior` applies | `delete` mode is unrecoverable; users may want soft-delete default | Default to `archive`; doc only |
| **Drive content update** | Detected via `modifiedTime` only | False-positive on metadata edits → wasted Gemini calls | §4 (page hashing makes this safe) |
| **Vault rename of PDF** | Works — `manifest.healRename()` from `vault.on("rename")` (`main.ts:93-100`) | — | — |
| **Vault rename of companion** | Not handled — manifest still points to old path | Next sync may overwrite wrong file | §5.2 |
| **Vault deletion of PDF** | Not handled — re-downloaded as ghost on next sync | Confusing UX | §5.3 |
| **Concurrent edit during sync** | No locking — overwrites silently | Data loss | §5.4 |
| **Drive API rate limit / partial failure** | Errors bubble up; manifest in partial state | Inconsistent state across runs | §5.5 |
| **Drive trash (not purged)** | Likely treated as deletion (depending on query filter) | Vault copy deleted prematurely | §5.6 |

---

## Quick-reference: file paths

| File | What |
|---|---|
| `main.ts` | Plugin entry, ribbon icons, vault event listeners, scheduler |
| `types.ts` | All shared types — `ManifestEntry`, `Automation`, pair config |
| `sync/DriveSync.ts` | Two-phase sync; download + automations + deletion pass |
| `sync/SyncManifest.ts` | Drive-ID → vault state mapping (the source of truth) |
| `sync/CompanionNoteManager.ts` | Companion creation, update, frontmatter |
| `automation/AutomationEngine.ts` | Automation matching + execution |
| `ai/GeminiClient.ts` | Gemini API wrapper |
| `settings/SettingsTab.ts` | All settings UI |
| `ui/SyncStatusView.ts` | Status side-panel |
