# drive-vault-sync 1.3.1 — patch on top of the 1.3.0 release bundle

- Apply: `node apply.mjs <1.3.0 main.js> out.js` (the release workflow does this from `BASE`)
- Test: `BUNDLE=out.js node --test patch.test.mjs` (the 1.2.1, 1.2.2 and 1.3.0 tests still pass on `out.js`)

## What changed

**Recent files first.** Before, files were transferred in the order the vault scan returned them, followed by cloud-only paths (effectively random). Now every file changed in the last `recentFirstDays` days (default 14) is transferred first, **newest first**; all other files follow in the usual order. "Changed" is the latest of the local modification time and the cloud copy's modification, update or deletion time.

- Applies to a normal sync, to "Download from Google Drive" / "Replace this vault with the cloud copy", and to a cloud reset made on another device.
- New setting "Sync recent files first, days" (0 turns it off).
- Version: `manifest.json` 1.3.1.
