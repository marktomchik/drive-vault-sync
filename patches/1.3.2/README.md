# drive-vault-sync 1.3.2 — patch on top of the 1.3.1 release bundle

- Apply: `node apply.mjs <1.3.1 main.js> out.js` (the release workflow does this from `BASE`)
- Test: `BUNDLE=out.js node --test patch.test.mjs` (the 1.2.1, 1.2.2, 1.3.0 and 1.3.1 tests still pass on `out.js`; the 1.2.3 test already failed on 1.3.0/1.3.1)

## What changed

**Keep only the newest copy of a note.** Apps that can only create files (for example an AI assistant writing through a Google Drive connector) save a new version of a note as a *second* file with the same name. 1.3.0 imported the newest one, but the older files stayed in the vault folder — and every earlier import had left extra copies too — so the folder filled up with same-named duplicates.

After the cloud index is saved (`finishExternalImport`), `dvsDedupe` now moves the older same-named copies to the Google Drive trash:

- A copy goes to the trash only if its path has a live index entry, the index's own file is in the same folder, and the copy is **not newer** than the index entry (`updatedAt`/`mtime`). A newer copy is a version the import has not taken yet: it stays, gets imported on this or the next sync, and is tidied up then.
- Files changed in the last 2 minutes, folders and Google Docs are never touched.
- Quick check: only the notes found by this run's import check are looked at (one listing per folder). Full check (every manual sync and every `externalFullScanHours`): the whole vault folder, which also clears old leftovers.
- Needs full Drive access and import turned on, like the import itself. A notice says how many copies were trashed; the sync log records `sync-engine-older-copies-trashed`.
- New setting "Keep only the newest copy of a note" (`externalDedupe`, default on).
- Version: `manifest.json` 1.3.2.
