// Patch set for drive-vault-sync 1.1.0 (esbuild-reformatted bundle) -> 1.2.0.
// Each entry: [label, find, replace]. Every `find` must match exactly once.
export default [
["defaults",
`backupIntervalMinutes: 30, maxBackups: 10 };`,
`backupIntervalMinutes: 30, maxBackups: 10, externalImportMode: "off", externalMaxFileSizeMB: 20, pluginStagingFolder: "Плагіни", stagedPluginIds: "drive-vault-sync", autoInstallStagedPlugins: true };`],

["scan-filter",
`async function it(r, t, e, n, s) {
  var a;
  let i = await r.listFilesChangedSince(new Date(e).toISOString()), o = [];
  for (let c of i) {
    if (n.has(c.id) || (a = c.mimeType) != null && a.startsWith(oo)) continue;
    let l = await t.resolve(c);
    !l || s(l) || o.push({ file: c, path: l });
  }
  return o;
}`,
`async function it(r, t, e, n, s, skip) {
  var a;
  let i = await r.listFilesChangedSince(new Date(e).toISOString()), o = [];
  for (let c of i) {
    if (n.has(c.id) || (a = c.mimeType) != null && a.startsWith(oo)) continue;
    if (skip && skip(c)) continue;
    let l = await t.resolve(c);
    !l || s(l) || dvsDotPath(l) || o.push({ file: c, path: l });
  }
  return o;
}
/* --- 1.2.0: safe import of files added outside Obsidian --- */
var dvsObs = require("obsidian"), DVS_EXTERNAL_LIMIT = 50, DVS_EXTERNAL_LABEL = "Google Drive (added by another app)";
function dvsDotPath(p) {
  return p.split("/").some((x) => x.startsWith("."));
}
function dvsSkipAdopted(adopted) {
  return (f) => {
    let a = adopted[f.id];
    return !!a && (a.own === true || !!a.revision && a.revision === f.headRevisionId);
  };
}
function dvsCountReasons(list) {
  let out = {};
  for (let s of list) out[s.reason] = (out[s.reason] || 0) + 1;
  return out;
}
/** Metadata-only plan: what would be imported, without downloading anything. */
function dvsPlanExternal(manifest, candidates, adopted, maxBytes) {
  let byPath = new Map(), skipped = [];
  for (let { file: u, path: d } of candidates) {
    let prev = adopted[u.id], size = Number(u.size || 0), mod = Date.parse(u.modifiedTime || "") || 0;
    if (size > maxBytes) { skipped.push({ path: d, reason: "too-large", size }); continue; }
    let h = manifest.files[d];
    if (h && h.deleted) {
      let created = Date.parse(u.createdTime || u.modifiedTime || "") || 0, del = h.deletedAt ?? h.updatedAt ?? 0;
      if (created <= del) { skipped.push({ path: d, reason: "older-than-deletion" }); continue; }
    } else if (h && mod <= (h.updatedAt || 0)) {
      // The vault copy changed after this Drive file: never overwrite newer vault content.
      skipped.push({ path: d, reason: "older-than-vault-copy" });
      continue;
    }
    let item = { file: u, path: d, action: h && !h.deleted ? "update" : "new", size, modifiedTime: mod, adoptedBefore: !!prev };
    let other = byPath.get(d);
    if (other && other.modifiedTime >= mod) { skipped.push({ path: d, reason: "older-duplicate" }); continue; }
    other && skipped.push({ path: d, reason: "older-duplicate" });
    byPath.set(d, item);
  }
  return { plan: [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path)), skipped };
}
/**
 * Imports planned files one by one. The Drive original is never changed or deleted: its content is copied into
 * a file this plugin owns (so phones signed in with the limited scope can read it). Local files are never written
 * here — the sync engine applies the new cloud version afterwards with its usual safety (unchanged local file ->
 * updated with a local backup; changed local file -> merge / "keep both" conflict copy).
 */
async function Xs(r, t, pre, n = Date.now(), ctx = {}) {
  let s = { added: [], updated: [], skipped: [...pre.skipped], adopted: {} }, maxBytes = ctx.maxBytes ?? Infinity;
  for (let item of pre.plan) {
    let { file: u, path: d } = item, h = t.manifest.files[d], rec = { path: d, revision: u.headRevisionId, at: n }, g;
    try {
      g = await r.downloadFile(u.id);
    } catch (y) {
      s.skipped.push({ path: d, reason: "download-failed" });
      continue;
    }
    if (g.byteLength > maxBytes) { s.skipped.push({ path: d, reason: "too-large" }); continue; }
    let isText = V(d), p = isText ? new TextDecoder().decode(g) : g, hash = await ee(p), local = ctx.local ? ctx.local[d] : void 0;
    if (h && !h.deleted && h.hash === hash) { s.adopted[u.id] = rec; s.skipped.push({ path: d, reason: "same-content" }); continue; }
    if (local && local.hash === hash) { s.adopted[u.id] = rec; s.skipped.push({ path: d, reason: "same-as-local" }); continue; }
    let mime = vo(d, isText), res;
    try {
      if (h && !h.deleted && h.driveFileId) res = await r.updateContent(h.driveFileId, g, mime);
      else {
        let folder = await r.ensureFolderPath(d.split("/").slice(0, -1), t.filesFolderId);
        res = await r.createFile(d.split("/").pop() || d, folder, g, mime);
        ctx.saveOwn && await ctx.saveOwn({ [res.id]: { path: d, own: true, at: n } });
      }
    } catch (y) {
      s.skipped.push({ path: d, reason: "upload-failed" });
      continue;
    }
    t.manifest.files[d] = { path: d, driveFileId: res.id, hash, size: J(p), mtime: Date.parse(u.modifiedTime || "") || n, revision: res.headRevisionId, deleted: false, updatedAt: n, deviceId: "external", deviceName: DVS_EXTERNAL_LABEL };
    (h && !h.deleted ? s.updated : s.added).push(d);
    s.adopted[u.id] = rec;
  }
  return (s.added.length || s.updated.length) && (t.manifest.updatedAt = n), s;
}
function dvsFormatSize(n) {
  return n >= 1048576 ? \`\${(n / 1048576).toFixed(1)} MB\` : n >= 1024 ? \`\${Math.round(n / 1024)} KB\` : \`\${n} B\`;
}
var DvsExternalPreviewModal = class extends dvsObs.Modal {
  constructor(app, plugin, pre) {
    super(app);
    this.plugin = plugin;
    this.pre = pre;
  }
  onOpen() {
    let { contentEl: e } = this, p = this.pre.plan, added = p.filter((x) => x.action === "new").length;
    e.empty(), this.setTitle ? this.setTitle("Files added outside Obsidian") : e.createEl("h2", { text: "Files added outside Obsidian" });
    e.createEl("p", { text: p.length === 0 ? "Nothing to import right now. No files were downloaded or changed." : \`\${p.length} file\${p.length === 1 ? "" : "s"} would be imported: \${added} new, \${p.length - added} updated. This is a preview \\u2014 nothing has been downloaded or changed yet.\` });
    p.length > DVS_EXTERNAL_LIMIT && e.createEl("p", { cls: "mod-warning", text: \`That is more than \${DVS_EXTERNAL_LIMIT} files. Check the list carefully before importing.\` });
    if (p.length) {
      let ul = e.createEl("ul");
      for (let x of p.slice(0, 40)) ul.createEl("li", { text: \`\${x.action === "new" ? "new" : "update"} \\u00b7 \${x.path} \\u00b7 \${dvsFormatSize(x.size)}\` });
      p.length > 40 && e.createEl("p", { cls: "dvs-muted", text: \`\\u2026and \${p.length - 40} more.\` });
    }
    let reasons = dvsCountReasons(this.pre.skipped), keys = Object.keys(reasons);
    keys.length && e.createEl("p", { cls: "dvs-muted", text: "Skipped: " + keys.map((k) => \`\${k} \${reasons[k]}\`).join(", ") });
    e.createEl("p", { cls: "dvs-muted", text: "Local notes are never overwritten blindly: if a note was changed here, both versions are kept. Nothing is deleted. Files in dot-folders (.obsidian and others) are ignored." });
    let row = new dvsObs.Setting(e);
    p.length && row.addButton((b) => b.setButtonText(this.plugin.settings.externalImportMode === "on" ? "Import now" : "Turn on import and sync").setCta().onClick(async () => {
      this.close(), await this.plugin.approveExternalImport(p.length);
    }));
    row.addButton((b) => b.setButtonText("Close").onClick(() => this.close()));
  }
  onClose() {
    this.contentEl.empty();
  }
};
/* --- 1.2.0: plugin code delivery through a normal vault folder --- */
var DVS_STAGED_FILES = ["main.js", "manifest.json", "styles.css"];
function dvsCompareVersions(a, b) {
  let x = String(a || "0").split(/[.-]/).map((v) => parseInt(v, 10) || 0), y = String(b || "0").split(/[.-]/).map((v) => parseInt(v, 10) || 0);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    let d = (x[i] || 0) - (y[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}
var DvsPluginStaging = class {
  constructor(app, getFolder, getIds, log) {
    this.app = app;
    this.getFolder = getFolder;
    this.getIds = getIds;
    this.log = log;
  }
  installedDir(id) {
    return (0, dvsObs.normalizePath)(\`\${this.app.vault.configDir}/plugins/\${id}\`);
  }
  stagedDir(id) {
    return (0, dvsObs.normalizePath)(\`\${this.getFolder()}/\${id}\`);
  }
  async readManifest(path) {
    let a = this.app.vault.adapter;
    try {
      return await a.exists(path) ? JSON.parse(await a.read(path)) : null;
    } catch (e) {
      return null;
    }
  }
  validId(id) {
    return /^[a-z0-9][a-z0-9._-]*$/i.test(id) && !id.includes("..");
  }
  /** Desktop: copy installed plugins into the staging folder when the installed version is newer. Never downgrades. */
  async publish(force = false) {
    let done = [], vault = this.app.vault;
    for (let id of this.getIds()) {
      if (!this.validId(id)) continue;
      let inst = await this.readManifest(\`\${this.installedDir(id)}/manifest.json\`), staged = await this.readManifest(\`\${this.stagedDir(id)}/manifest.json\`);
      if (!inst || inst.id !== id) continue;
      let cmp = staged ? dvsCompareVersions(inst.version, staged.version) : 1;
      if (cmp < 0 || cmp === 0 && !force) continue;
      let dir = this.stagedDir(id);
      for (let part of [this.getFolder(), dir]) vault.getAbstractFileByPath(part) || await vault.createFolder(part).catch(() => void 0);
      for (let f of DVS_STAGED_FILES) {
        let src = \`\${this.installedDir(id)}/\${f}\`;
        if (f === "manifest.json" || !await vault.adapter.exists(src)) continue;
        await this.writeVault(\`\${dir}/\${f}\`, await vault.adapter.read(src));
      }
      await this.writeVault(\`\${dir}/manifest.json\`, await vault.adapter.read(\`\${this.installedDir(id)}/manifest.json\`));
      done.push(\`\${id} \${inst.version}\`);
    }
    return done.length && await this.log("plugin-staging-published", { plugins: done }), done;
  }
  async writeVault(path, text) {
    let vault = this.app.vault, f = vault.getAbstractFileByPath(path);
    if (f instanceof dvsObs.TFile) {
      (await vault.read(f)) !== text && await vault.modify(f, text);
    } else await vault.create(path, text);
  }
  /** Copy plugins from the staging folder into the config folder when the staged version is newer. Never touches data.json. */
  async installNewer() {
    let done = [], a = this.app.vault.adapter;
    for (let id of this.getIds()) {
      if (!this.validId(id)) continue;
      let sdir = this.stagedDir(id), staged = await this.readManifest(\`\${sdir}/manifest.json\`);
      if (!staged || staged.id !== id || !await a.exists(\`\${sdir}/main.js\`)) continue;
      let idir = this.installedDir(id), inst = await this.readManifest(\`\${idir}/manifest.json\`);
      if (inst && dvsCompareVersions(staged.version, inst.version) <= 0) continue;
      await a.exists(idir) || await a.mkdir(idir);
      await a.exists(\`\${idir}/main.js\`) && await a.write(\`\${idir}/main.js.prev\`, await a.read(\`\${idir}/main.js\`));
      for (let f of DVS_STAGED_FILES) f !== "manifest.json" && await a.exists(\`\${sdir}/\${f}\`) && await a.write(\`\${idir}/\${f}\`, await a.read(\`\${sdir}/\${f}\`));
      await a.write(\`\${idir}/manifest.json\`, await a.read(\`\${sdir}/manifest.json\`));
      done.push(\`\${id} \${staged.version}\`);
    }
    return done.length && await this.log("plugin-staging-installed", { plugins: done }), done;
  }
};`],

["engine-call",
`wn = await this.importExternalFiles(A), vn =`,
`wn = await this.importExternalFiles(A, T), vn =`],

["engine-save",
`await this.options.provider.save(), wn !== void 0 &&`,
`await this.options.provider.save(), this.pendingAdopted && (await this.options.addExternalAdopted?.(this.pendingAdopted), this.pendingAdopted = void 0), wn !== void 0 &&`],

["engine-import",
`  async importExternalFiles(t) {
    var n, s, i, o, a;
    if (!((s = (n = this.options).canSeeExternalFiles) != null && s.call(n))) return;
    let e = Date.now();
    try {
      (i = this.externalResolver) != null && i.matches(t.filesFolderId, t.rootFolderId) || (this.externalResolver = new be(this.options.drive, t.filesFolderId, t.rootFolderId));
      let c = new Set(Object.values(t.manifest.files).map((h) => h.driveFileId));
      t.manifestFileId && c.add(t.manifestFileId);
      let l = st((a = (o = this.options).getExternalScanAt) == null ? void 0 : a.call(o), e), u = await it(this.options.drive, this.externalResolver, l, c, (h) => {
        var g, p, f;
        return (f = (p = (g = this.options).isIgnoredPath) == null ? void 0 : p.call(g, h)) != null ? f : false;
      });
      if (u.length === 0) return e;
      let d = await Xs(this.options.drive, t.manifest, u, e);
      return await this.log("sync-engine-external-files", { added: d.added, skipped: d.skipped }), d.skipped.some((h) => h.reason === "download-failed") ? void 0 : e;
    } catch (c) {`,
`  async importExternalFiles(t, localScan) {
    var n, s, i, o, a;
    if (!((s = (n = this.options).canSeeExternalFiles) != null && s.call(n))) return;
    if (this.options.getExternalImportMode?.() !== "on") return;
    let e = Date.now();
    this.pendingAdopted = void 0;
    try {
      (i = this.externalResolver) != null && i.matches(t.filesFolderId, t.rootFolderId) || (this.externalResolver = new be(this.options.drive, t.filesFolderId, t.rootFolderId));
      let c = new Set(Object.values(t.manifest.files).map((h) => h.driveFileId));
      t.manifestFileId && c.add(t.manifestFileId);
      let adopted = this.options.getExternalAdopted?.() ?? {}, maxBytes = this.options.getExternalMaxBytes?.() ?? 20 * 1048576;
      let l = st((a = (o = this.options).getExternalScanAt) == null ? void 0 : a.call(o), e), u = await it(this.options.drive, this.externalResolver, l, c, (h) => {
        var g, p, f;
        return (f = (p = (g = this.options).isIgnoredPath) == null ? void 0 : p.call(g, h)) != null ? f : false;
      }, dvsSkipAdopted(adopted));
      if (u.length === 0) return e;
      let pre = dvsPlanExternal(t.manifest, u, adopted, maxBytes);
      if (pre.plan.length > DVS_EXTERNAL_LIMIT && !this.options.consumeExternalLargeImportApproval?.()) {
        await this.log("sync-engine-external-import-held", { count: pre.plan.length }), this.options.onExternalHeld?.(pre.plan.length);
        return;
      }
      let d = await Xs(this.options.drive, t, pre, e, { local: localScan, maxBytes, saveOwn: (m) => this.options.addExternalAdopted?.(m) });
      this.pendingAdopted = d.adopted;
      await this.log("sync-engine-external-files", { added: d.added.length, updated: d.updated.length, skipped: dvsCountReasons(d.skipped) });
      d.added.length + d.updated.length > 0 && new q.Notice(\`Drive Vault Sync: imported \${d.added.length + d.updated.length} file(s) added outside Obsidian.\`);
      return d.skipped.some((h) => h.reason === "download-failed" || h.reason === "upload-failed") ? void 0 : e;
    } catch (c) {`],

["engine-options",
`isIgnoredPath: (e) => ge(e, pe(this.settings.ignoredPaths)) })`,
`isIgnoredPath: (e) => ge(e, pe(this.settings.ignoredPaths)), getExternalImportMode: () => this.settings.externalImportMode, getExternalMaxBytes: () => this.externalMaxBytes(), getExternalAdopted: () => {
      var e;
      return (e = this.pluginData.externalAdopted) != null ? e : {};
    }, addExternalAdopted: (e) => {
      var n;
      return this.savePluginData({ externalAdopted: { ...(n = this.pluginData.externalAdopted) != null ? n : {}, ...e } });
    }, consumeExternalLargeImportApproval: () => {
      let e = this.externalLargeImportApproved;
      return this.externalLargeImportApproved = false, !!e;
    }, onExternalHeld: (e) => this.handleExternalHeld(e) }), this.pluginStaging = new DvsPluginStaging(this.app, () => this.settings.pluginStagingFolder.trim() || K.pluginStagingFolder, () => this.settings.stagedPluginIds.split(/\\r?\\n|,/).map((e) => e.trim()).filter(Boolean), (e, n) => this.appendSyncLog(e, n))`],

["load-data",
`lastExternalScanAt: e == null ? void 0 : e.lastExternalScanAt, syncFailures:`,
`lastExternalScanAt: e == null ? void 0 : e.lastExternalScanAt, externalAdopted: e == null ? void 0 : e.externalAdopted, syncFailures:`],

["sync-hooks",
`      let o = await this.syncEngine.syncNow(e);
      o ? await this.recordSyncSuccess(o) : await this.setSyncStatus({ ...this.pluginData.syncStatus, state: "idle" }), await this.appendSyncLog("sync-finished", o);`,
`      await this.publishStagedPlugins(false);
      let o = await this.syncEngine.syncNow(e);
      o ? await this.recordSyncSuccess(o) : await this.setSyncStatus({ ...this.pluginData.syncStatus, state: "idle" }), await this.appendSyncLog("sync-finished", o), o && await this.installStagedPlugins();`],

["poll",
`    if (!this.hasFullDriveAccess() || Date.now() - this.lastExternalPollAt < Mo) return false;`,
`    if (!this.hasFullDriveAccess() || this.settings.externalImportMode !== "on" || this.externalImportHeld || Date.now() - this.lastExternalPollAt < Mo) return false;`],

["poll-filter",
`      return (await it(this.drive, this.externalPollResolver, st(this.pluginData.lastExternalScanAt), c, (u) => ge(u, pe(this.settings.ignoredPaths)))).length > 0;`,
`      return (await it(this.drive, this.externalPollResolver, st(this.pluginData.lastExternalScanAt), c, (u) => ge(u, pe(this.settings.ignoredPaths)), dvsSkipAdopted((s = this.pluginData.externalAdopted) != null ? s : {}))).length > 0;`],

["plugin-methods",
`  hasFullDriveAccess() {
    return Nn(this.getStoredAuth());
  }`,
`  hasFullDriveAccess() {
    return Nn(this.getStoredAuth());
  }
  externalMaxBytes() {
    return Math.max(1, Number(this.settings.externalMaxFileSizeMB) || 20) * 1048576;
  }
  handleExternalHeld(e) {
    this.externalImportHeld || new D.Notice(\`Drive Vault Sync: \${e} files added outside Obsidian are waiting. That is more than \${DVS_EXTERNAL_LIMIT}, so nothing was imported. Run \\u201CPreview files added outside Obsidian\\u201D to review them.\`, 0), this.externalImportHeld = true;
  }
  /** Dry run: lists what would be imported. Downloads and changes nothing. */
  async previewExternalImport() {
    var e;
    if (!this.hasFullDriveAccess()) {
      new D.Notice("This sign-in only sees files the plugin created. Sign in with full access in the plugin settings (desktop) to see files added by other apps.", 8e3);
      return;
    }
    let n = new D.Notice("Looking for files added outside Obsidian\\u2026", 0);
    try {
      let s = await this.drive.loadRemoteState(this.settings.remoteFolderName, this.getVaultId()), i = new Set(Object.values(s.manifest.files).map((l) => l.driveFileId));
      s.manifestFileId && i.add(s.manifestFileId);
      let o = (e = this.pluginData.externalAdopted) != null ? e : {}, a = await it(this.drive, new be(this.drive, s.filesFolderId, s.rootFolderId), st(this.pluginData.lastExternalScanAt), i, (l) => ge(l, pe(this.settings.ignoredPaths)), dvsSkipAdopted(o)), c = dvsPlanExternal(s.manifest, a, o, this.externalMaxBytes());
      await this.appendSyncLog("external-import-preview", { count: c.plan.length, skipped: dvsCountReasons(c.skipped) }), n.hide(), new DvsExternalPreviewModal(this.app, this, c).open();
    } catch (s) {
      n.hide(), new D.Notice(\`Preview failed: \${s instanceof Error ? s.message : String(s)}\`), await this.appendSyncLog("external-import-preview-failed", this.errorDetails(s));
    }
  }
  async approveExternalImport(e) {
    this.externalLargeImportApproved = e > DVS_EXTERNAL_LIMIT, this.externalImportHeld = false, this.settings.externalImportMode !== "on" && (this.settings.externalImportMode = "on", await this.saveSettings()), await this.syncNow(true);
  }
  async publishStagedPlugins(e = false) {
    if (!Ue() || !this.pluginStaging) return;
    try {
      let n = await this.pluginStaging.publish(e);
      e && new D.Notice(n.length ? \`Copied for other devices: \${n.join(", ")}\` : "The plugin folder for other devices is already up to date.");
    } catch (n) {
      await this.appendSyncLog("plugin-staging-publish-failed", this.errorDetails(n));
    }
  }
  async installStagedPlugins(e = false) {
    if (!this.pluginStaging || !e && !this.settings.autoInstallStagedPlugins) return;
    try {
      let n = await this.pluginStaging.installNewer();
      n.length ? new D.Notice(\`Plugins updated: \${n.join(", ")}. Restart Obsidian to use the new versions.\`, 0) : e && new D.Notice("No newer plugins in the staging folder.");
    } catch (n) {
      await this.appendSyncLog("plugin-staging-install-failed", this.errorDetails(n));
    }
  }`],

["commands",
`  registerCommands() {
    this.addCommand({ id: "sync-now",`,
`  registerCommands() {
    this.addCommand({ id: "preview-external-files", name: "Preview files added outside Obsidian (dry run)", icon: "search", callback: () => void this.previewExternalImport() }), this.addCommand({ id: "publish-plugins-for-devices", name: "Copy plugins to the folder for other devices", icon: "package", callback: () => void this.publishStagedPlugins(true) }), this.addCommand({ id: "install-staged-plugins", name: "Install newer plugins from the folder for other devices", icon: "download", callback: () => void this.installStagedPlugins(true) });
    this.addCommand({ id: "sync-now",`],

["settings-ui",
`    })), this.renderFullAccess(e);
  }
  renderFullAccess(e) {`,
`    })), this.renderFullAccess(e), this.renderDvsExtras(e);
  }
  renderDvsExtras(e) {
    let n = this.plugin.settings;
    new b.Setting(e).setName("Import files added by other apps").setDesc("Off: nothing is imported. On: new and changed files that other apps put into the vault folder in Google Drive are imported during sync (needs full access, desktop). More than 50 files at once always wait for your review. Local changes are never overwritten \\u2014 both versions are kept.").addDropdown((s) => s.addOption("off", "Off").addOption("on", "On").setValue(n.externalImportMode === "on" ? "on" : "off").onChange(async (i) => {
      n.externalImportMode = i, this.plugin.externalImportHeld = false, await this.plugin.saveSettings();
    })).addButton((s) => s.setButtonText("Preview").onClick(() => void this.plugin.previewExternalImport()));
    new b.Setting(e).setName("Largest file to import, MB").setDesc("Bigger files are skipped so phones don't run out of memory.").addText((s) => s.setValue(String(n.externalMaxFileSizeMB)).onChange(async (i) => {
      let o = Number(i);
      Number.isFinite(o) && o > 0 && (n.externalMaxFileSizeMB = o, await this.plugin.saveSettings());
    }));
    new b.Setting(e).setName("Plugins for other devices").setHeading();
    new b.Setting(e).setName("Folder").setDesc("A normal vault folder that carries plugin code to your other devices (the settings folder itself is never synced). data.json is never copied.").addText((s) => s.setValue(n.pluginStagingFolder).onChange(async (i) => {
      n.pluginStagingFolder = i.trim() || K.pluginStagingFolder, await this.plugin.saveSettings();
    }));
    new b.Setting(e).setName("Plugin IDs").setDesc("One per line.").addTextArea((s) => s.setValue(n.stagedPluginIds).onChange(async (i) => {
      n.stagedPluginIds = i, await this.plugin.saveSettings();
    }));
    new b.Setting(e).setName("Install newer versions automatically").setDesc("After a sync, newer plugin versions from the folder are installed (the previous main.js is kept as main.js.prev). Restart Obsidian afterwards.").addToggle((s) => s.setValue(n.autoInstallStagedPlugins).onChange(async (i) => {
      n.autoInstallStagedPlugins = i, await this.plugin.saveSettings();
    })).addButton((s) => s.setButtonText("Copy now").onClick(() => void this.plugin.publishStagedPlugins(true)));
  }
  renderFullAccess(e) {`],
["remove-1.1.0-import",
"async function Xs(r, t, e, n = Date.now()) {\n  var i, o, a, c, l;\n  let s = { added: [], skipped: [] };\n  for (let { file: u, path: d } of e) {\n    let h = t.files[d];\n    if (h && !h.deleted) {\n      s.skipped.push({ path: d, reason: \"already-synced\" });\n      continue;\n    }\n    if (h != null && h.deleted) {\n      let y = Date.parse((o = (i = u.createdTime) != null ? i : u.modifiedTime) != null ? o : \"\") || 0, v = (c = (a = h.deletedAt) != null ? a : h.updatedAt) != null ? c : 0;\n      if (y <= v) {\n        s.skipped.push({ path: d, reason: \"older-than-deletion\" });\n        continue;\n      }\n    }\n    let g;\n    try {\n      g = await r.downloadFile(u.id);\n    } catch (y) {\n      s.skipped.push({ path: d, reason: \"download-failed\" });\n      continue;\n    }\n    let p = V(d) ? new TextDecoder().decode(g) : g, f = Date.parse((l = u.modifiedTime) != null ? l : \"\") || n;\n    t.files[d] = { path: d, driveFileId: u.id, hash: await ee(p), size: J(p), mtime: f, revision: u.headRevisionId, deleted: false, updatedAt: n, deviceName: \"Google Drive (added by another app)\" }, s.added.push(d);\n  }\n  return s.added.length > 0 && (t.updatedAt = n), s;\n}",
"/* 1.1.0 Xs (direct adoption of foreign file ids) replaced by the 1.2.0 Xs above */"],
];
