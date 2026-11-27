// Patch set for drive-vault-sync 1.3.1 (release main.js) -> 1.3.2.
// Each entry: [label, find, replace]. Every `find` must match exactly once.
// Goal: when a newer version of a note shows up in Google Drive, the older same-named copies go to the Drive trash,
// so the vault folder keeps exactly one file per note.
export default [
["defaults-dedupe", "externalFullScanHours: 6, recentFirstDays: 14 };", "externalFullScanHours: 6, recentFirstDays: 14, externalDedupe: true };"],

// dvsPickOlderCopies / dvsDedupe: keep the file the cloud index uses, trash same-named copies that are not newer than it.
["helpers", "/** Metadata-only plan: what would be imported, without downloading anything. */\n", `/* --- 1.3.2: one file per note — older same-named copies go to the Drive trash --- */
var DVS_DEDUPE_GRACE_MS = 2 * 60 * 1e3;
/**
 * files: Drive files with { id, path, mimeType, modifiedTime }. Returns the copies that can go to the trash:
 * same path as a live index entry, not the file the index uses, and not newer than the index copy
 * (a newer one is a version the import has not taken yet, so it stays). Very fresh files are left alone
 * (another device may be about to point the index at them).
 */
function dvsPickOlderCopies(manifest, files, now = Date.now(), skipIds = new Set()) {
  let byPath = new Map();
  for (let f of files) {
    if (!f || !f.id || f.mimeType === De || String(f.mimeType || "").startsWith(oo)) continue;
    let list = byPath.get(f.path);
    list ? list.push(f) : byPath.set(f.path, [f]);
  }
  let out = [];
  for (let [path, list] of byPath) {
    if (list.length < 2) continue;
    let h = manifest.files[path];
    if (!h || h.deleted || !h.driveFileId || !list.some((f) => f.id === h.driveFileId)) continue;
    let keepAt = Math.max(h.updatedAt || 0, h.mtime || 0);
    if (!keepAt) continue;
    for (let f of list) {
      if (f.id === h.driveFileId || skipIds.has(f.id)) continue;
      let mod = Date.parse(f.modifiedTime || "") || 0;
      if (!mod || mod > keepAt || mod > now - DVS_DEDUPE_GRACE_MS) continue;
      out.push({ id: f.id, path, modifiedTime: mod, keptFileId: h.driveFileId });
    }
  }
  return out;
}
/** paths: only these notes (cheap, one query per folder); null: the whole vault folder. */
async function dvsDedupe(r, state, paths, skipIds = new Set(), now = Date.now()) {
  let files = [];
  if (paths === null) files = await r.listVaultFiles(state.filesFolderId);
  else {
    let byFolder = new Map();
    for (let p of paths) {
      let h = state.manifest.files[p];
      if (!h || h.deleted) continue;
      let dir = p.split("/").slice(0, -1).join("/"), names = byFolder.get(dir);
      names ? names.add(p.split("/").pop()) : byFolder.set(dir, new Set([p.split("/").pop()]));
    }
    for (let [dir, names] of byFolder) {
      let folderId = await r.ensureFolderPath(dir ? dir.split("/") : [], state.filesFolderId), pageToken;
      do {
        let q = fe({ q: \`'\${on(folderId)}' in parents and trashed = false\`, fields: "nextPageToken,files(id,name,mimeType,modifiedTime)", pageSize: 1e3, pageToken });
        let res = await r.requestJson(\`\${z}/files?\${q}\`, "GET");
        for (let f of res.files ?? []) names.has(f.name) && files.push({ ...f, path: dir ? \`\${dir}/\${f.name}\` : f.name });
        pageToken = res.nextPageToken;
      } while (pageToken);
    }
  }
  let picked = dvsPickOlderCopies(state.manifest, files, now, skipIds), trashed = 0, failed = 0;
  for (let c of picked) {
    try {
      await r.trashFile(c.id), trashed++;
    } catch (e) {
      failed++;
    }
  }
  return { checked: files.length, trashed, failed, paths: [...new Set(picked.map((c) => c.path))] };
}
/** Metadata-only plan: what would be imported, without downloading anything. */
`],

// Remember which notes this run touched (or the whole folder on a full check).
["import-reset", "    this.pendingTrash = void 0, this.pendingFullScanAt = void 0;\n    if (this.options.getExternalImportMode?.() !== \"on\") return;", "    this.pendingTrash = void 0, this.pendingFullScanAt = void 0, this.pendingDedupe = void 0;\n    if (this.options.getExternalImportMode?.() !== \"on\") return;"],
["import-remember", "      if (u.length === 0) return e;\n      let pre = dvsPlanExternal(t.manifest, u, adopted, maxBytes);", "      this.pendingDedupe = { state: t, paths: this.pendingFullScanAt !== void 0 ? null : [...new Set(u.map((x) => x.path))] };\n      if (u.length === 0) return e;\n      let pre = dvsPlanExternal(t.manifest, u, adopted, maxBytes);"],
["import-held", "this.options.onExternalHeld?.(pre.plan.length), this.pendingFullScanAt = void 0;", "this.options.onExternalHeld?.(pre.plan.length), this.pendingFullScanAt = void 0, this.pendingDedupe = void 0;"],

// After the cloud index is saved: trash the older copies.
["finish-dedupe", "    (done || failed) && await this.log(\"sync-engine-external-originals-trashed\", { trashed: done, failed });\n", `    (done || failed) && await this.log("sync-engine-external-originals-trashed", { trashed: done, failed });
    let dd = this.pendingDedupe;
    this.pendingDedupe = void 0;
    if (dd && (!dd.paths || dd.paths.length) && this.options.getExternalDedupe?.() !== false) {
      try {
        let res = await dvsDedupe(this.options.drive, dd.state, dd.paths, new Set(trash), Date.now());
        (res.trashed || res.failed) && await this.log("sync-engine-older-copies-trashed", { full: !dd.paths, checked: res.checked, trashed: res.trashed, failed: res.failed, notes: res.paths.length });
        res.trashed && new q.Notice(\`Drive Vault Sync: moved \${res.trashed} older cop\${res.trashed === 1 ? "y" : "ies"} of \${res.paths.length} note\${res.paths.length === 1 ? "" : "s"} to the Google Drive trash.\`);
      } catch (y) {
        await this.log("sync-engine-older-copies-failed", { error: y instanceof Error ? y.message : String(y) });
      }
    }
`],

// Wire the setting.
["plugin-option", "getExternalTrashOriginals: () => this.settings.externalTrashOriginals !== false, ", "getExternalTrashOriginals: () => this.settings.externalTrashOriginals !== false, getExternalDedupe: () => this.settings.externalDedupe !== false, "],

// New setting, right after "Tidy up imported originals".
["settings-ui", "      n.externalTrashOriginals = i, await this.plugin.saveSettings();\n    }));\n", `      n.externalTrashOriginals = i, await this.plugin.saveSettings();
    }));
    new b.Setting(e).setName("Keep only the newest copy of a note").setDesc("When Google Drive holds several files with the same name for one note (for example when another app saved a new version instead of replacing the old one), the older copies go to the Drive trash after the newest version is in the vault. They can be restored there for 30 days. A copy newer than the vault's version is imported first, never trashed.").addToggle((s) => s.setValue(n.externalDedupe !== false).onChange(async (i) => {
      n.externalDedupe = i, await this.plugin.saveSettings();
    }));
`],

// Version banner.
["banner", "/* Drive Vault Sync 1.2.0 — ", "/* Drive Vault Sync 1.3.2 (1.3.1 bundle + patch: keep only the newest copy of a note) — "],
];
