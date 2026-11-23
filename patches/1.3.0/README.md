# drive-vault-sync 1.3.0 — patch on top of the 1.2.3 release bundle

- Apply: `node apply.mjs <1.2.3 main.js> out.js` (the release workflow does this from `BASE`)
- Test: `BUNDLE=out.js node --test patch.test.mjs` (the 1.2.1 and 1.2.2 tests still pass on `out.js`; the 1.2.3 test checks the old "off" default and no longer applies)

## What changed

The plugin now sees every file in its Google Drive folder and downloads it into the vault, including files added by other apps.

1. **Import is on by default.** The default for `externalImportMode` is `"on"`. A saved `"off"` is switched on once when 1.3.0 first loads (flag `externalImportMigrated130`); if the user turns it off again, that choice is kept.
2. **Whole-folder check.** The quick "changed since the last check" query could miss files (for example ones added while the device had limited access, or more than 30 days ago). Now the whole vault folder is listed (`dvsFullFolderCandidates`) on every manual sync and every `externalFullScanHours` (default 6). Known, adopted, Google-native, dot-folder and excluded files are skipped. The time of the last full check is stored as `lastExternalFullScanAt`.
3. **No writing into the trash.** If the manifest points to a vault copy that was trashed or deleted in Drive (`dvsIsGone`), the import creates a new copy instead of updating the trashed one.
4. **Tidy up imported originals** (`externalTrashOriginals`, default on). After a file is copied into a plugin-owned file, or when it is identical to the vault copy, the original goes to the Drive trash. This happens only after the cloud index has been saved (`finishExternalImport`), so a failed save never leaves a note only in the trash.
5. **Limited sign-in is visible.** With import on but only `drive.file` access, a notice explains how to get full access (once per start on a computer, once ever on a phone).
6. **Settings:** new "Tidy up imported originals" and "Check the whole folder every, hours"; the import description no longer says "desktop".
7. **Version:** `manifest.json` 1.3.0.
