// Patch set for drive-vault-sync 1.2.3 (release main.js) -> 1.3.0.
// Each entry: [label, find, replace]. Every `find` must match exactly once.
// Goal: the plugin sees every file in its Drive folder (including ones added by other apps) and downloads them into the vault.
export default [
// Import of files added by other apps is on by default; tidy-up of imported originals and the full-folder check interval get defaults.
["defaults-import-on", "externalImportMode: \"off\", externalMaxFileSizeMB: 20 };", "externalImportMode: \"on\", externalMaxFileSizeMB: 20, externalTrashOriginals: true, externalFullScanHours: 6 };"],

// One-time switch of a saved "off" to "on" when 1.3.0 first loads. Turning it off again afterwards is kept.
["migrate-import-on", "    delete s.pluginStagingFolder, delete s.stagedPluginIds, delete s.autoInstallStagedPlugins;\n    this.settings = s;", "    delete s.pluginStagingFolder, delete s.stagedPluginIds, delete s.autoInstallStagedPlugins;\n    s.externalImportMigrated130 || (s.externalImportMode = \"on\", s.externalImportMigrated130 = true);\n    this.settings = s;"],

// Keep the time of the last full-folder check across restarts.
["keep-full-scan-time", "lastExternalScanAt: e == null ? void 0 : e.lastExternalScanAt, ", "lastExternalScanAt: e == null ? void 0 : e.lastExternalScanAt, lastExternalFullScanAt: e == null ? void 0 : e.lastExternalFullScanAt, "],

// dvsIsGone: is a Drive file trashed or missing. dvsFullFolderCandidates: full listing of the vault folder.
["helpers", "/** Metadata-only plan: what would be imported, without downloading anything. */\nfunction dvsPlanExternal(", "/* --- 1.3.0: see every file in the vault folder, never update a trashed copy, tidy up imported originals --- */\nasync function dvsIsGone(r, id) {\n  try {\n    let f = await r.requestJson(`${z}/files/${encodeURIComponent(id)}?fields=id,trashed`, \"GET\");\n    return !f || f.trashed === true;\n  } catch (e) {\n    return e && e.status === 404;\n  }\n}\n/** Every file under the vault folder that the manifest does not know about (catches what the \"changed since\" query missed). */\nasync function dvsFullFolderCandidates(r, filesFolderId, known, seen, skip, ignored) {\n  let out = [];\n  for (let f of await r.listVaultFiles(filesFolderId)) {\n    if (known.has(f.id) || seen.has(f.id) || String(f.mimeType || \"\").startsWith(oo)) continue;\n    if (skip && skip(f)) continue;\n    if (dvsDotPath(f.path) || ignored(f.path)) continue;\n    out.push({ file: f, path: f.path });\n  }\n  return out;\n}\n/** Metadata-only plan: what would be imported, without downloading anything. */\nfunction dvsPlanExternal("],

// Xs now also returns the ids of Drive originals that may be moved to the trash after the index is saved.
["xs-result-trash-list", "let s = { added: [], updated: [], skipped: [...pre.skipped], adopted: {} }, maxBytes", "let s = { added: [], updated: [], skipped: [...pre.skipped], adopted: {}, trash: [] }, maxBytes"],

// A Drive original identical to the vault copy is a pure duplicate: tidy it up.
["xs-same-content-trash", "if (h && !h.deleted && h.hash === hash) { s.adopted[u.id] = rec; s.skipped.push({ path: d, reason: \"same-content\" }); continue; }", "if (h && !h.deleted && h.hash === hash) { s.adopted[u.id] = rec; s.trash.push(u.id); s.skipped.push({ path: d, reason: \"same-content\" }); continue; }"],

// If the vault's own copy was trashed or deleted on Drive, write a new copy instead of updating the one in the trash.
["xs-no-update-of-trashed-copy", "if (h && !h.deleted && h.driveFileId) res = await r.updateContent(h.driveFileId, g, mime);", "if (h && !h.deleted && h.driveFileId && !await dvsIsGone(r, h.driveFileId)) res = await r.updateContent(h.driveFileId, g, mime);"],

// After a successful copy the original can be tidied up.
["xs-imported-trash", "    (h && !h.deleted ? s.updated : s.added).push(d);\n    s.adopted[u.id] = rec;", "    (h && !h.deleted ? s.updated : s.added).push(d);\n    s.adopted[u.id] = rec;\n    s.trash.push(u.id);"],

// A manual sync always checks the whole vault folder.
["engine-import-gets-manual-flag", "wn = await this.importExternalFiles(A, T), vn", "wn = await this.importExternalFiles(A, T, t), vn"],

// Originals are moved to the trash and the full-check time is saved only after the cloud index is saved.
["engine-after-save", "this.pendingAdopted && (await this.options.addExternalAdopted?.(this.pendingAdopted), this.pendingAdopted = void 0), wn !== void 0", "this.pendingAdopted && (await this.options.addExternalAdopted?.(this.pendingAdopted), this.pendingAdopted = void 0), await this.finishExternalImport(), wn !== void 0"],

// Order of checks: import off -> nothing; on but limited sign-in -> tell the user once. Adds finishExternalImport().
["engine-import-start", "  async importExternalFiles(t, localScan) {\n    var n, s, i, o, a;\n    if (!((s = (n = this.options).canSeeExternalFiles) != null && s.call(n))) return;\n    if (this.options.getExternalImportMode?.() !== \"on\") return;\n    let e = Date.now();\n    this.pendingAdopted = void 0;", "  async finishExternalImport() {\n    let trash = this.pendingTrash ?? [], full = this.pendingFullScanAt;\n    this.pendingTrash = void 0, this.pendingFullScanAt = void 0;\n    let done = 0, failed = 0;\n    for (let id of trash) {\n      try {\n        await this.options.drive.trashFile(id), done++;\n      } catch (y) {\n        failed++;\n      }\n    }\n    (done || failed) && await this.log(\"sync-engine-external-originals-trashed\", { trashed: done, failed });\n    full !== void 0 && await this.options.setExternalFullScanAt?.(full);\n  }\n  async importExternalFiles(t, localScan, manual = false) {\n    var n, s, i, o, a;\n    this.pendingTrash = void 0, this.pendingFullScanAt = void 0;\n    if (this.options.getExternalImportMode?.() !== \"on\") return;\n    if (!((s = (n = this.options).canSeeExternalFiles) != null && s.call(n))) {\n      this.options.onExternalBlind?.();\n      return;\n    }\n    let e = Date.now();\n    this.pendingAdopted = void 0;"],

// Besides the "changed since the last check" query, the whole vault folder is listed on manual sync and every few hours.
["engine-full-folder-scan", "      }, dvsSkipAdopted(adopted));\n      if (u.length === 0) return e;\n      let pre = dvsPlanExternal(t.manifest, u, adopted, maxBytes);", "      }, dvsSkipAdopted(adopted));\n      if (this.options.shouldFullScanExternal?.(manual)) {\n        let seen = new Set(u.map((x) => x.file.id)), extra = await dvsFullFolderCandidates(this.options.drive, t.filesFolderId, c, seen, dvsSkipAdopted(adopted), (h) => {\n          var g, p, f;\n          return (f = (p = (g = this.options).isIgnoredPath) == null ? void 0 : p.call(g, h)) != null ? f : false;\n        });\n        u.push(...extra), this.pendingFullScanAt = e;\n        await this.log(\"sync-engine-external-full-scan\", { found: extra.length });\n      }\n      if (u.length === 0) return e;\n      let pre = dvsPlanExternal(t.manifest, u, adopted, maxBytes);"],

// A held import is checked again next time.
["engine-held-no-full-mark", "await this.log(\"sync-engine-external-import-held\", { count: pre.plan.length }), this.options.onExternalHeld?.(pre.plan.length);\n        return;", "await this.log(\"sync-engine-external-import-held\", { count: pre.plan.length }), this.options.onExternalHeld?.(pre.plan.length), this.pendingFullScanAt = void 0;\n        return;"],

// Remember what to tidy up; a failed file keeps the full check due.
["engine-pending-trash", "      this.pendingAdopted = d.adopted;\n", "      this.pendingAdopted = d.adopted;\n      this.pendingTrash = this.options.getExternalTrashOriginals?.() === false ? [] : d.trash;\n      d.skipped.some((h) => h.reason === \"download-failed\" || h.reason === \"upload-failed\") && (this.pendingFullScanAt = void 0);\n"],

// Wire the new engine options.
["plugin-options", "canSeeExternalFiles: () => this.hasFullDriveAccess(), ", "canSeeExternalFiles: () => this.hasFullDriveAccess(), getExternalTrashOriginals: () => this.settings.externalTrashOriginals !== false, shouldFullScanExternal: (m) => this.shouldFullScanExternal(m), setExternalFullScanAt: (e) => this.savePluginData({ lastExternalFullScanAt: e }), onExternalBlind: () => this.handleExternalBlind(), "],

// Full-check schedule and a notice when the sign-in can't see other apps' files (once per start on a computer, once ever on a phone).
["plugin-methods", "  hasFullDriveAccess() {\n    return Nn(this.getStoredAuth());\n  }", "  hasFullDriveAccess() {\n    return Nn(this.getStoredAuth());\n  }\n  shouldFullScanExternal(manual) {\n    let last = this.pluginData.lastExternalFullScanAt, hours = Math.max(1, Number(this.settings.externalFullScanHours) || 6);\n    return !!manual || !last || Date.now() - last >= hours * 36e5;\n  }\n  handleExternalBlind() {\n    if (this.externalBlindNotified || !Ue() && this.settings.externalBlindHintShown) return;\n    this.externalBlindNotified = true;\n    Ue() || (this.settings.externalBlindHintShown = true, void this.saveSettings());\n    new D.Notice(Ue() ? \"Drive Vault Sync: notes that other apps add to the vault folder in Google Drive can't be seen with this sign-in (limited access). Open Settings \\u2192 Drive Vault Sync and sign in through the browser with the \\u201CDesktop app\\u201D client to download them.\" : \"Drive Vault Sync: this phone uses limited Google access, so notes added by other apps arrive here after the computer imports them. To import them here too, sign in on the computer through the browser, then use \\u201CSign in on another device\\u201D.\", 20000);\n  }"],

// Describe the new behaviour.
["settings-import-desc", "    new b.Setting(e).setName(\"Import files added by other apps\").setDesc(\"Off: nothing is imported. On: new and changed files that other apps put into the vault folder in Google Drive are imported during sync (needs full access, desktop). More than 50 files at once always wait for your review. Local changes are never overwritten \\u2014 both versions are kept.\")", "    new b.Setting(e).setName(\"Import files added by other apps\").setDesc(\"On: new and changed files that other apps put into the vault folder in Google Drive are downloaded during sync. The whole folder is checked on every manual sync and every few hours, so nothing is missed. Needs full access. More than 50 files at once always wait for your review. Local changes are never overwritten \\u2014 both versions are kept.\")"],

// Two new settings.
["settings-tidy-and-interval", "    new b.Setting(e).setName(\"Largest file to import, MB\")", "    new b.Setting(e).setName(\"Tidy up imported originals\").setDesc(\"After a file added by another app is copied into the vault, its original in Google Drive goes to the Drive trash (it can be restored there for 30 days). This stops duplicate files with the same name piling up in the vault folder.\").addToggle((s) => s.setValue(n.externalTrashOriginals !== false).onChange(async (i) => {\n      n.externalTrashOriginals = i, await this.plugin.saveSettings();\n    }));\n    new b.Setting(e).setName(\"Check the whole folder every, hours\").setDesc(\"Lists every file in the vault folder in Google Drive to find files the quick check missed. A manual sync always does this.\").addText((s) => s.setValue(String(n.externalFullScanHours ?? 6)).onChange(async (i) => {\n      let o = Number(i);\n      Number.isFinite(o) && o >= 1 && (n.externalFullScanHours = o, await this.plugin.saveSettings());\n    }));\n    new b.Setting(e).setName(\"Largest file to import, MB\")"],

];
