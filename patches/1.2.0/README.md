# drive-vault-sync 1.2.0 — local patch on top of the 1.1.0 bundle

The 1.1.0 TypeScript source was not found, so 1.2.0 was made by patching the installed bundle.
Port these changes into `src/` when the source turns up.

## Files

- `main-1.1.0.reformatted.js` — the installed 1.1.0 `main.js`, reformatted with esbuild. It behaves the same.
- `main-1.2.0.reformatted.js` — the result after patching.
- `changes.diff` — the difference between the two.
- `patches.mjs` + `apply.mjs` — the patch as find/replace pairs. Each one must match exactly once.
  To apply: `node apply.mjs main-1.1.0.reformatted.js out.js`
- `patch.test.mjs` — unit tests. To run: `BUNDLE=out.js node --test patch.test.mjs`
- `dryrun.mjs` — read-only preview against the real Drive (GET requests only; tokens stay in memory).
  To run: `node dryrun.mjs out.js <path to data.json>`

## What changed

1. **External import (`Xs`, `dvsPlanExternal`, `importExternalFiles`)**
   - **Off by default.** It runs only with the new setting `externalImportMode: "on"` and full Drive access.
   - **The Drive original is never changed or deleted.** Its content is copied into a file this plugin owns:
     - a new file gets a new copy via `createFile`;
     - a changed file updates the vault's own copy in place via `updateContent`.

     This lets phones that only have the `drive.file` scope read it. 1.1.0 put the foreign file id straight into the manifest, so phones could not read it.
   - **Changed files are imported too.** The plugin remembers each original's `headRevisionId` in `externalAdopted`, a new key stored per device in `data.json`. This map also holds the ids of the copies the plugin created.
   - **What is skipped:**
     - dot-folders such as `.obsidian`;
     - ignored paths;
     - files larger than `externalMaxFileSizeMB` (default 20);
     - files older than the vault copy, or older than the file's deletion in the vault;
     - older duplicates at the same path;
     - files whose content is identical to the vault or to the local copy.
   - **Local files are never written by the importer.** The engine then applies the cloud change as it always does:
     - an unchanged local file is updated, after a local backup;
     - a changed local file is merged, or both versions are kept with a conflict copy.
   - **More than 50 files hold the import.** A Notice is shown once and cloud-watch stops polling. The import continues only after the user approves it from the preview window.
   - **The log records counts only,** not paths.
2. **Preview / dry run**
   - Command: "Preview files added outside Obsidian (dry run)". It is also a button in the settings.
   - It reads metadata only. A window lists what would be imported and offers "Turn on import and sync".
3. **Plugin delivery (`DvsPluginStaging`)**
   - Desktop, before each sync: installed plugins listed in `stagedPluginIds` are copied into the vault folder `pluginStagingFolder` (default `Плагіни`), but only when the installed version is newer. Staged copies are never downgraded.
   - After a successful sync: newer staged versions are installed into `.obsidian/plugins/<id>`, and the old `main.js` is kept as `main.js.prev`.
   - `data.json` is never copied.
   - Commands: "Copy plugins to the folder for other devices", "Install newer plugins from the folder for other devices".
4. **Settings UI:** `renderDvsExtras` — the import mode, the size limit, the staging folder, the plugin ids, and the auto-install toggle.
5. **Version:** `manifest.json` is now 1.2.0.
