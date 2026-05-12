# IMPROVEMENTS.md

Feature plan for the next round of drive-folder-sync work. Each phase is self-contained — drop it into a fresh chat as the starting brief.

**Previous plan archived at:** `IMPROVEMENTS_archive_2026-05-12.md`

**Conventions:**
- **Drive ID** = immutable Google Drive file ID. The only reliable identity for tracking.
- **Companion note** = markdown sidecar created by `CompanionNoteManager`.
- **Manifest** = `.obsidian/drive-sync-manifest.json` (`sync/SyncManifest.ts`). Authoritative source of truth.

---

## Phase 7 — File Explorer Context Menus

**Goal:** Expose key plugin actions on any file via right-click in Obsidian's file explorer. No new settings UI — pure UX convenience layer.

### 7.1 Right-click "Transcribe file"

**Status:** `openTranscribePickerForFile(app, plugin, file)` already exists in `commands/TranscribeCurrentFile.ts:19` — just needs to be wired to the file-menu event.

**Tasks:**
- [ ] In `main.ts`, register a `file-menu` event via `this.registerEvent(this.app.workspace.on("file-menu", ...))`
- [ ] Add menu item "Drive Sync: Transcribe file" — show only when clicked file is a `.pdf`
- [ ] On click: call `openTranscribePickerForFile(this.app, this, file)`
- [ ] Guard with `geminiEnabled` check — if AI is off, show a disabled item with tooltip "Enable AI transcription in settings"

**Files:** `main.ts` only.

---

### 7.2 Right-click "View sync status"

**Goal:** Show the sync status for a specific file without opening the full file tracker table.

**Tasks:**
- [ ] Add menu item "Drive Sync: View status" to the `file-menu` handler (any file type)
- [ ] If the file is in the manifest (matched by vault path) → open `FileTrackerModal` pre-filtered to that file; OR create a lightweight `ui/FileSyncStatusModal.ts` that shows a single entry card (driveFileId, pairLabel, modifiedTime, companion path, transcribed state, automation run history)
- [ ] If the file is NOT in the manifest → show a brief modal/notice: "This file is not tracked by Drive Sync." with option to run available automations manually

**Recommendation:** Build `FileSyncStatusModal` as a new lightweight modal (single-entry view). `FileTrackerModal` is a full table — filtering it to one row is a worse UX than a clean single-file card.

**Files:** `main.ts`, new `ui/FileSyncStatusModal.ts`.

---

### 7.3 Right-click "Run automations on this file"

**Goal:** Apply any matching automation to a right-clicked file without going through settings.

**Tasks:**
- [ ] Add menu item "Drive Sync: Run automations" to the `file-menu` handler
- [ ] On click: find all automations whose `triggerFolderPath` matches the file's vault path
- [ ] If 0 match → notice "No automations match this file's folder."
- [ ] If 1 match → confirm and run directly
- [ ] If >1 match → open a `FuzzySuggestModal` to pick which automation to run
- [ ] Call `AutomationEngine.runForFile(vaultPath, companionPath, driveCreatedTime, undefined, driveFileId, driveModifiedTime, force=true)`
- [ ] Show result notice

**Files:** `main.ts`, `automation/AutomationEngine.ts` (no changes needed — API is sufficient).

---

## Phase 8 — Automations on Any Vault File

**Goal:** Run automations and transcription on files that were NOT synced from Drive. Users should be able to use embed/link/tag/companion automations as general vault utilities, not just post-sync hooks.

### 8.1 Decouple automation trigger from the manifest

**Current state:** `AutomationEngine.runForFile()` already accepts optional `driveFileId` and `driveModifiedTime`. The only gap is:
1. The "Run on existing files" button in settings (`§2.1`) only iterates manifest entries — it skips non-Drive files.
2. There's no command palette entry to pick an arbitrary vault file + run an automation.

**Tasks:**
- [ ] New command `drive-sync:run-automation-on-file`:
  - First picker: `FuzzySuggestModal` over all vault files (not just manifest entries)
  - Second picker: `FuzzySuggestModal` over `settings.automations` that match the file's folder path; if none match, show all automations with a note
  - Calls `AutomationEngine.runForFile(vaultPath, companionPath, undefined, undefined, undefined, undefined, force=true)`
  - Result notice
- [ ] For idempotency on non-manifest files: when `driveFileId` is undefined, skip the idempotency check entirely (always run); log at debug level
- [ ] Register command in `main.ts`

**Files:** `main.ts`, `automation/AutomationEngine.ts` (idempotency guard tweak).

---

### 8.2 Create companion note for any vault file

**Goal:** The "create companion note" action today only fires as part of sync. Expose it as a standalone command.

**Tasks:**
- [ ] New command `drive-sync:create-companion-for-file`:
  - If there is an active PDF file → use it; else open a `FuzzySuggestModal` over all `.pdf` files in the vault
  - Check if a companion already exists (via manifest or by scanning for a note with matching `driveFileId` frontmatter) → if yes, open it; if no, create it
  - Use `transcribeCompanionFallbackFolder` as the creation folder (falls back to alongside PDF when empty)
  - Uses the companion template (respects `transcribeCompanionTemplatePath` and `transcribeCompanionTemplate` from the Transcription settings tab)
  - No Drive ID = companion frontmatter has `driveFileId: ""` (placeholder)
- [ ] Add to `file-menu` event: "Drive Sync: Create companion note" (PDF files only)
- [ ] Register command in `main.ts`

**Files:** `main.ts`, `commands/TranscribeCurrentFile.ts` or new `commands/CreateCompanion.ts`, `sync/CompanionNoteManager.ts`.

---

### 8.3 Transcription settings tab — status check

**Note for implementer:** Most settings the user asked for in this area are **already implemented**:
- ✅ Separate "Transcription" tab in settings (`settings/SettingsTab.ts:819–968`)
- ✅ Default destination dropdown (`transcribeDefaultDest`)
- ✅ Companion note inline template (`transcribeCompanionTemplate`)
- ✅ Companion note template file path override (`transcribeCompanionTemplatePath`)
- ✅ Daily note template (`transcribeDailyTemplate`)
- ✅ Existing note template (`transcribeNoteTemplate`)
- ✅ Fallback folder when companion doesn't exist (`transcribeCompanionFallbackFolder`)

**What's not yet there (gaps to fill):**
- [ ] The companion-note template in the Transcription tab does not yet surface the global `companionNoteTemplatePath` setting — the two settings are separate (one for the sync flow, one for the transcribe command). Consider merging or cross-linking them in the UI so users aren't confused by duplicate template controls.
- [ ] No "Test template" button — show a rendered preview with dummy values; low priority but reduces support questions.

**Files:** `settings/SettingsTab.ts`.

---

## Phase 9 — Two-Way Sync

**Goal:** Changes made inside the vault propagate back to Google Drive. This is the most complex phase and must be implemented last, after Phases 7–8 are stable.

### Design constraints

- **Non-destructive by default.** Vault → Drive pushes should never silently overwrite Drive content. Conflict detection is mandatory, not optional.
- **Drive remains the canonical source.** The sync direction is primarily Drive → Vault. Two-way sync adds an opt-in "push" direction; it does not make the vault a peer.
- **Scope in v1:** Upload vault changes to Drive for PDF files already in the manifest (files that originated from Drive). New vault-originated files (not in manifest) are handled by a separate "Upload to Drive" feature (out of scope for v1).

---

### 9.1 Upload queue & vault event tracking

**Goal:** Detect vault-side modifications to Drive-synced files and queue them for upload.

**Tasks:**
- [ ] Add `twoWaySyncEnabled: boolean` to `PluginSettings` (default `false`); add toggle in settings under a new "Two-Way Sync" section
- [ ] Add `pendingUpload?: { queuedAt: string; reason: string }` to `ManifestEntry` in `types.ts`
- [ ] In `main.ts`, register `vault.on("modify", ...)`:
  - If `twoWaySyncEnabled` is false, no-op
  - Look up the modified file's vault path in the manifest
  - If found, set `entry.pendingUpload = { queuedAt: now, reason: "vault-modified" }`
  - Debounce: don't queue if the file was just downloaded in the last 5 seconds (avoid re-queue on our own writes)
- [ ] Persist the `pendingUpload` flag to the manifest on each modification (or batch on next save cycle)

**Files:** `types.ts`, `main.ts`, `sync/SyncManifest.ts`.

---

### 9.2 Drive upload API

**Goal:** Implement the upload path in the Drive API layer.

**Tasks:**
- [ ] New `sync/DriveUploader.ts`:
  - `uploadFile(driveFileId: string, fileBuffer: ArrayBuffer, mimeType: string): Promise<DriveFile>` — uses Drive's `files.update` with multipart upload (method: PATCH to `upload/drive/v3/files/{fileId}`)
  - Retry with exponential backoff (max 3 attempts, same pattern as existing Drive calls)
  - Returns updated `DriveFile` with new `modifiedTime`
- [ ] Auth: reuse `GoogleAuth.getAccessToken()` from `auth/GoogleAuth.ts`
- [ ] Error handling: distinguish 404 (file deleted from Drive — stale manifest), 403 (permission lost), 5xx (transient)

**Files:** new `sync/DriveUploader.ts`.

---

### 9.3 Conflict detection before upload

**Goal:** Before pushing a vault file to Drive, verify Drive hasn't also changed since the last sync. If both changed → conflict.

**Tasks:**
- [ ] Before every upload:
  1. Fetch Drive file metadata (`files.get?fields=id,modifiedTime`) for the driveFileId
  2. Compare Drive `modifiedTime` with `manifest.entry.driveModifiedTime`
  3. If Drive is newer → both sides changed → conflict
- [ ] Conflict resolution respects `conflictPolicy` setting:
  - `"keep-vault"` → upload regardless
  - `"take-drive"` → skip upload, re-download Drive version instead
  - `"ask"` → open `ConflictModal` (`ui/ConflictModal.ts` already exists) with three options: keep vault / take Drive / keep both (rename one)
  - `"save-both"` → upload vault version with a timestamped name; keep Drive original

**Files:** `sync/DriveUploader.ts`, `ui/ConflictModal.ts` (extend for upload context).

---

### 9.4 Upload pass in the sync cycle

**Goal:** Integrate the upload queue into the existing sync loop.

**Tasks:**
- [ ] Add `DriveUploader` to `DriveSync` constructor
- [ ] At the **end** of each `sync()` run (after the download pass), run the upload pass:
  - Iterate manifest entries with `pendingUpload` set
  - For each: run conflict detection (§9.3), then upload (§9.2)
  - On success: clear `pendingUpload`, update `entry.driveModifiedTime` to the returned `modifiedTime`
  - On conflict (ask mode): pause upload pass for that file, surface conflict to user
  - On 404: remove `pendingUpload`, mark entry `driveTrashed: true` or log warning
  - On error: retain `pendingUpload`, increment a `uploadRetryCount`; after 3 failures, clear flag and log
- [ ] Surface upload count in `SyncResult`: add `uploaded: number` field
- [ ] Show upload count in `SyncStatusView`

**Files:** `sync/DriveSync.ts`, `sync/DriveUploader.ts`, `types.ts` (add `uploaded` to `SyncResult`), `ui/SyncStatusView.ts`.

---

### 9.5 Settings & UX for Two-Way Sync

**Tasks:**
- [ ] New "Two-Way Sync" section in `SettingsTab.ts` (under Sync settings or its own tab):
  - Toggle: "Enable two-way sync (push vault changes to Drive)"
  - Warning callout: "Two-way sync will overwrite Drive files. Ensure you have a conflict policy configured."
  - "Conflict policy" dropdown (already exists globally — cross-link here, or show inline)
  - Per-pair override toggle: "Enable two-way sync for this pair" (`twoWaySyncEnabled?: boolean` on `SyncPair`)
- [ ] Status indicator in `SyncStatusView`: show pending upload queue count
- [ ] "Upload pending changes" button in settings (manual trigger, without waiting for next scheduled sync)
- [ ] Dry-run mode for uploads: "What would be uploaded?" — extends `DryRunModal` with an "Upload queue" section

**Files:** `types.ts`, `settings/SettingsTab.ts`, `ui/SyncStatusView.ts`, `ui/DryRunModal.ts`.

---

### 9.6 Failure-proofing for Two-Way Sync

**Tasks:**
- [ ] Write lock: if a file is being downloaded by the sync engine, skip it from the upload pass in the same run (no same-run read-modify-write)
- [ ] Manifest backup before upload pass: write `.obsidian/drive-sync-manifest.json.tmp` before committing uploads (same pattern as §5.5 transactional writes, already implemented)
- [ ] Upload history in the sync activity log (`SyncLog.ts`): log every upload attempt with outcome
- [ ] "Pause two-way sync" command: sets a vault-local flag that suppresses the upload pass without changing settings
- [ ] Re-queue on startup: if plugin unloads mid-upload-pass (crash, quit), `pendingUpload` entries survive in the manifest and are retried on next sync

**Files:** `sync/DriveSync.ts`, `sync/SyncLog.ts`, `main.ts`.

---

## Implementation order

```
Phase 7 (1–2 sessions) → Phase 8 (1–2 sessions) → Phase 9 (3–5 sessions)
```

Phase 7 is pure `main.ts` wiring — lowest risk, fastest payoff.
Phase 8 requires a small `AutomationEngine` tweak but no structural changes.
Phase 9 requires a new `DriveUploader.ts`, a write-path through the sync engine, and careful conflict handling. Do not start Phase 9 until Phases 7–8 are merged and stable.

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
| `ui/FileTrackerModal.ts` | Full file tracker table |
| `ui/FileSyncStatusModal.ts` | (new) Single-file status card |
| `sync/DriveUploader.ts` | (new) Drive upload API wrapper |
| `commands/TranscribeCurrentFile.ts` | Transcribe command + `openTranscribePickerForFile()` |
