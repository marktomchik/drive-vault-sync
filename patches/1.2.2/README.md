# drive-vault-sync 1.2.2 — patch on top of the 1.2.1 release bundle

- Apply: `node apply.mjs <1.2.1 main.js> out.js` (the release workflow does this from `BASE`)
- Test: `BUNDLE=out.js node --test patch.test.mjs` (the 1.2.0 and 1.2.1 tests still pass on `out.js`)

## What changed

**"Download from Google Drive" compares first.** Before, the first sync of a device (and "Replace this vault with the cloud copy") downloaded every cloud file and rewrote it locally, even when the local copy was identical. That took minutes, rewrote hundreds of files and triggered a long follow-up sync.

Now, for every cloud file whose hash equals the local file's hash, the local file is kept as it is and only recorded in the sync index (with the merge base for Markdown, read from the local file). Only missing or different files are downloaded; different local versions are still backed up first. An empty vault still downloads everything. If a local file cannot be read, it is downloaded as before.

The progress total now counts only the files that will actually be downloaded. The log records `reset-local-from-cloud-plan` and `reset-local-from-cloud-kept` (counts only), and the final notice says how many files were already up to date.
