// Patch set for drive-vault-sync 1.2.1 (release main.js) -> 1.2.2.
// Each entry: [label, find, replace]. Every `find` must match exactly once.
// Goal: "Download from Google Drive" compares first and downloads only missing or different files.
export default [
["reset-local-plan",
`let c = await this.options.provider.prepare(), l = Object.values(c.manifest.files).filter((p) => !p.deleted).length;
      this.progress.growTotalBy(l + t.length);`,
`let c = await this.options.provider.prepare(), dvsSame = new Set(Object.values(c.manifest.files).filter((p) => !p.deleted && p.hash && a[p.path] && a[p.path].hash === p.hash).map((p) => p.path)), dvsKept = 0, l = Object.values(c.manifest.files).filter((p) => !p.deleted).length - dvsSame.size;
      // 1.2.2: files whose content already matches the cloud are kept as they are, not downloaded again.
      await this.log("reset-local-from-cloud-plan", { cloudFiles: l + dvsSame.size, alreadyUpToDate: dvsSame.size, toDownload: l });
      this.progress.growTotalBy(l + t.length);`],

["reset-local-skip-identical",
`for (let p of Object.values(c.manifest.files)) if (!p.deleted) try {
        await this.downloadRemote(p.path, p, d, n);`,
`for (let p of Object.values(c.manifest.files)) if (!p.deleted) try {
        if (dvsSame.has(p.path)) {
          let dvsOk = false;
          try {
            let dvsLocal = a[p.path], dvsText = dvsLocal.isText ? await this.options.scanner.readText(p.path) : void 0;
            d[p.path] = await this.indexEntry(p.path, p.hash, p.driveFileId, p.revision, dvsText, dvsLocal.isText), dvsOk = true;
          } catch (x) {
          }
          if (dvsOk) {
            dvsKept += 1;
            continue;
          }
          this.progress.growTotalBy(1);
        }
        await this.downloadRemote(p.path, p, d, n);`],

["reset-local-notice",
`new q.Notice("This vault was reset from Google Drive.")`,
`await this.log("reset-local-from-cloud-kept", { alreadyUpToDate: dvsKept, downloaded: n.downloads }), new q.Notice(dvsKept > 0 ? \`Google Drive: \${n.downloads} downloaded, \${dvsKept} were already up to date.\` : "This vault was reset from Google Drive.")`],

["choice-card-text",
`This device is replaced with the cloud copy; you can keep files that exist only here.`,
`Files that already match the cloud stay as they are; only missing or different files are downloaded (different local versions are backed up first). You can keep files that exist only here.`],

["settings-first-sync-text",
`This vault is replaced with the cloud copy \\u2014 you can keep files that exist only here.`,
`Files that already match the cloud stay as they are; only missing or different files are downloaded \\u2014 you can keep files that exist only here.`]
];
