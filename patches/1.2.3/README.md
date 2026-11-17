# drive-vault-sync 1.2.3 — patch on top of the 1.2.2 release bundle

- Apply: `node apply.mjs <1.2.2 main.js> out.js` (the release workflow does this from `BASE`)
- Test: `BUNDLE=out.js node --test patch.test.mjs` (the 1.2.1 and 1.2.2 tests still pass on `out.js`; the 1.2.0 tests no longer do, because they test the removed plugin delivery)

## What changed

**Plugin delivery is removed.** Plugin updates now come straight from GitHub releases through BRAT, so the plugin no longer copies plugins between devices.

- Removed `DvsPluginStaging` (with `DVS_STAGED_FILES` and `dvsCompareVersions`), added in 1.2.0.
- No more copying of installed plugins into the staging folder before a sync, and no more installing from it after a sync.
- Removed the commands "Copy plugins to the folder for other devices" and "Install newer plugins from the folder for other devices".
- Removed the "Plugins for other devices" section from the settings.
- The settings `pluginStagingFolder`, `stagedPluginIds` and `autoInstallStagedPlugins` are dropped from the defaults and from `data.json` on the next load.
- The staging folder in the vault (default `Плагіни`) is **not** deleted: it is an ordinary vault folder now and can be removed by hand.
