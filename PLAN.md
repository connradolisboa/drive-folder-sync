# Drive Folder Sync — Improvement Plan

Each item is a self-contained task that can be implemented in a separate chat.
Check the box when the feature is merged.

---

## Phase 1 — Foundation & Quick Wins
*Small, isolated changes. No new files or UI components. Good starting point.*

### 10. Fix: `saveSettings()` Reconstructs `DriveSync` on Every Keystroke

**Goal:** Stop recreating the entire `DriveSync` instance whenever any setting changes.

**Files to touch:**
- `sync/DriveSync.ts` — add `updateSettings(settings: PluginSettings): void`
- `main.ts` — call `updateSettings` instead of `new DriveSync(...)`

**Checklist:**
- [x] Add `updateSettings(settings: PluginSettings): void` to `DriveSync` that replaces `this.settings`
- [x] Remove the `new DriveSync(...)` block from `main.ts` `saveSettings()`; call `this.driveSync.updateSettings(this.settings)` instead
- [x] Verify `DownloadManager` also doesn't need reconstruction (it's stateless — construct once in `onload`)

---

### 5. Sync on Startup Toggle

**Goal:** Add a setting to run one sync immediately when the vault opens, independent of the scheduler interval.

**Files to touch:**
- `types.ts` — add `syncOnStartup: boolean` to `PluginSettings` and `DEFAULT_SETTINGS`
- `main.ts` — trigger `runSync()` after auth check if enabled
- `settings/SettingsTab.ts` — add toggle in "Sync schedule" section

**Checklist:**
- [x] Add `syncOnStartup: boolean` to `PluginSettings` (default `false`)
- [x] In `main.ts` `onload()`, after confirming `isAuthorized`, call `this.runSync()` if `syncOnStartup` is true
- [x] Add toggle to settings UI under "Sync schedule"

---

### 6. Drive Folder URL Paste

**Goal:** Let users paste a full Drive URL (`https://drive.google.com/drive/folders/FOLDER_ID`) into the Drive folder ID field, auto-extracting the ID.

**Files to touch:**
- `settings/SettingsTab.ts` — update the `onChange` handler for `driveFolderId`

**Checklist:**
- [x] In the pair card's `Drive folder ID` `onChange`, check if input matches the Drive URL pattern (`/folders/([a-zA-Z0-9_-]+)`)
- [x] If matched, extract the ID and update the text input value in-place
- [x] Show a small success hint (e.g. "ID extracted") or just update silently

---

### 14. `pairLabel` Field in Companion Note Frontmatter

**Goal:** Include the sync pair's label in each companion note's frontmatter for easy Dataview filtering.

**Files to touch:**
- `sync/CompanionNoteManager.ts` — add `pairLabel` to the frontmatter written on create/update

**Checklist:**
- [x] In `CompanionNoteManager.create()`, add `pairLabel: "<pair.label>"` to the generated frontmatter
- [x] In `CompanionNoteManager.update()`, ensure `pairLabel` is preserved or re-written if the pair label changes
- [x] Update the template placeholder docs in `SettingsTab.ts` to mention `{{pairLabel}}`
- [x] Add `{{pairLabel}}` placeholder support in the template engine

---

## Phase 2 — Sync Power Features
*Extends the core sync engine with more control per pair and better performance.*

### 15. Exclude Subfolders per Sync Pair

**Goal:** Allow each sync pair to specify a list of subfolder names/paths that should be skipped during recursive file collection.

**Files to touch:**
- `types.ts` — add `excludedSubfolders: string[]` to `SyncPair`
- `sync/DriveSync.ts` — check exclusion list before descending into subfolders
- `settings/SettingsTab.ts` — add a multi-value text input (comma-separated) per pair card

**Checklist:**
- [x] Add `excludedSubfolders: string[]` to `SyncPair` (default `[]`)
- [x] In `DriveSync.collectFiles()`, before recursing into a subfolder, check if `folder.name` or the full `childRelPath` matches any entry in `pair.excludedSubfolders`; skip if matched
- [x] Pass `pair` (or the exclusion list) down through `collectFiles()` calls
- [x] Add a text input to each pair card in `SettingsTab.renderPairs()` for comma-separated subfolder names to exclude
- [x] Parse the comma-separated input into an array on save; display the array joined back as comma-separated on load

---

### 4. Per-Pair Deletion & Companion Settings

**Goal:** Allow each `SyncPair` to override the global `deletionBehavior` and `companionNotesEnabled` settings.

**Files to touch:**
- `types.ts` — add optional override fields to `SyncPair`
- `sync/DriveSync.ts` — resolve effective settings per pair
- `settings/SettingsTab.ts` — add override controls inside each pair card

**Checklist:**
- [x] Add to `SyncPair`: `deletionBehavior?: DeletionBehavior`, `archiveFolder?: string`, `companionNotesEnabled?: boolean`
- [x] In `DriveSync.syncPair()`, resolve effective deletion/companion settings: use pair override if set, else fall back to global
- [x] In `SettingsTab.renderPairs()`, add an "Advanced" toggle per card that reveals the override dropdowns/toggles
- [x] Ensure migration doesn't break existing pairs (all override fields undefined = use global)

---

### 7. Parallel File Downloads

**Goal:** Download multiple files concurrently instead of sequentially to speed up large initial syncs.

**Files to touch:**
- `sync/DriveSync.ts` — replace the sequential `for` loop in `syncPair()` with a concurrency-limited runner
- `types.ts` — add `downloadConcurrency: number` to `PluginSettings`
- `settings/SettingsTab.ts` — add concurrency input under "Sync schedule"

**Checklist:**
- [x] Add `downloadConcurrency: number` to `PluginSettings` (default `5`, range 1–10)
- [x] Add concurrency number input to settings UI under "Sync schedule"
- [x] Refactor the per-entry download block in `syncPair()` into a standalone `processEntry()` method
- [x] Use a concurrency-limited runner (simple semaphore or chunked `Promise.allSettled`) to call `processEntry()` in parallel
- [x] Ensure `result.downloaded/skipped/errors` counters are updated safely (use returned values, not shared mutation)

---

## Phase 3 — Visibility & Control
*New UI surfaces: sync log, status panel, and per-pair controls.*

### 8. Sync History Log

**Goal:** Append a one-line entry to a vault markdown file after each sync run, capturing timestamp, counts, and errors.

**Files to touch:**
- `sync/SyncLogger.ts` (new) — handles appending to the log file
- `types.ts` — add `syncLogEnabled: boolean`, `syncLogPath: string` to `PluginSettings`
- `main.ts` — call logger after `runSync()`
- `settings/SettingsTab.ts` — add toggle + path input

**Checklist:**
- [x] Add `syncLogEnabled: boolean` (default `false`) and `syncLogPath: string` (default `Drive Sync/.sync-log.md`) to `PluginSettings`
- [x] Create `sync/SyncLogger.ts` with `append(result: SyncResult): Promise<void>` — creates the file if missing, appends a `| timestamp | downloaded | skipped | removed | errors |` table row
- [x] Call `SyncLogger.append()` in `main.ts` after successful `runSync()`
- [x] Add toggle + file path input to settings UI under a new "Sync log" section

---

### 13. Per-Pair Sync Now Button

**Goal:** Add a "Sync now" button inside each sync pair card to trigger a sync for that pair only.

**Files to touch:**
- `sync/DriveSync.ts` — expose `syncSinglePair(pairId: string): Promise<SyncResult>`
- `main.ts` — expose `runSyncForPair(pairId: string): Promise<SyncResult>`
- `settings/SettingsTab.ts` — add button to each pair card header

**Checklist:**
- [x] Add `syncSinglePair(pairId: string)` to `DriveSync` (loads manifest, gets token, runs `syncPair` for matching pair, saves manifest)
- [x] Expose `runSyncForPair(pairId)` in `main.ts` with the same `syncing` guard
- [x] Add an extra button (icon `refresh-cw` or text "Sync") to each pair card in `SettingsTab.renderPairs()`
- [x] Show a `Notice` with the result when done

---

### 2. Sync Status Panel

**Goal:** Replace the ephemeral `Notice` with a persistent Obsidian leaf/view showing sync history, per-pair file counts, and errors.

**Files to touch:**
- `ui/SyncStatusView.ts` (new) — `ItemView` subclass
- `main.ts` — register the view, expose `lastSyncResult`
- `types.ts` — extend `SyncResult` to include `timestamp` and per-pair breakdown

**Checklist:**
- [x] Add `timestamp: number` and `pairs: Record<string, SyncResult>` to `SyncResult`
- [x] Create `ui/SyncStatusView.ts` implementing `ItemView` (leaf type `drive-sync-status`)
- [x] Register view in `main.ts` `onload()`
- [x] Add ribbon icon to open the view (or reuse existing, secondary click)
- [x] After each `runSync()`, push result into view and re-render
- [x] Show per-pair rows: pair label, downloaded, skipped, removed, errors, last sync time

---

## Phase 4 — Advanced Features
*Dry run mode and automation system expansion.*

### 12. Dry Run Mode

**Goal:** Add a "Dry run" button that lists what would be downloaded/removed without writing any files.

**Files to touch:**
- `sync/DriveSync.ts` — add optional `dryRun` flag to `sync()` and `syncPair()`
- `main.ts` — expose `runSync(dryRun?: boolean)`
- `settings/SettingsTab.ts` — add "Dry run" button next to "Sync now"
- `ui/DryRunModal.ts` (new) — `Modal` subclass to display the diff

**Checklist:**
- [ ] Add `dryRun?: boolean` param to `DriveSync.sync()` and `syncPair()`
- [ ] In dry-run mode, collect would-download and would-remove lists instead of performing actions; return them in an extended result type
- [ ] Create `ui/DryRunModal.ts` that renders two lists: "Would download" and "Would remove"
- [ ] Add "Dry run" button in settings "Manual sync" section that calls `runSync(true)` and opens the modal

---

### 3. More Automation Action Types

**Goal:** Add two new action types alongside `embed_to_daily_note`.

**New actions:**
- `append_to_note` — insert an embed/wikilink into any named vault note (not just daily)
- `add_tag_to_companion` — add a tag to the companion note's frontmatter after download

**Files to touch:**
- `types.ts` — extend `AutomationActionType`, add fields to `AutomationAction`
- `automation/AutomationEngine.ts` — implement new action handlers
- `settings/SettingsTab.ts` — add UI controls for new action fields (target note path, tag name)

**Checklist:**
- [ ] Add `"append_to_note" | "add_tag_to_companion"` to `AutomationActionType`
- [ ] Add optional fields to `AutomationAction`: `targetNotePath?: string`, `tagName?: string`
- [ ] Implement `runAppendToNote()` in `AutomationEngine` (reads note, appends embed, writes back)
- [ ] Implement `runAddTagToCompanion()` in `AutomationEngine` (patches YAML frontmatter tags array)
- [ ] Add conditional UI in `SettingsTab.renderAutomations()`: show `targetNotePath` input when action = `append_to_note`, `tagName` input when action = `add_tag_to_companion`
