// Patch set for drive-vault-sync 1.3.0 (release main.js) -> 1.3.1.
// Each entry: [label, find, replace]. Every `find` must match exactly once.
// Goal: files changed in the last 14 days are synced first, then everything else as before.
export default [
// Files changed in the last 14 days are synced first (0 turns this off).
["defaults-recent-first", "externalTrashOriginals: true, externalFullScanHours: 6 };", "externalTrashOriginals: true, externalFullScanHours: 6, recentFirstDays: 14 };"],

// dvsRecentFirst / dvsRecentFirstMetas: put recently changed files at the front, keep the rest in place.
["helpers", "/* --- 1.3.0: see every file in the vault folder, never update a trashed copy, tidy up imported originals --- */\n", "/* --- 1.3.1: sync recently changed files first --- */\nfunction dvsChangedAt(localMeta, remoteMeta) {\n  let t = 0;\n  localMeta && localMeta.mtime && (t = Math.max(t, localMeta.mtime));\n  remoteMeta && (t = Math.max(t, remoteMeta.mtime || 0, remoteMeta.updatedAt || 0, remoteMeta.deletedAt || 0));\n  return t;\n}\n/** Paths changed within `days` come first, newest first; every other path keeps its usual order. */\nfunction dvsRecentFirst(paths, local, files, now = Date.now(), days = 14) {\n  let d = Number(days);\n  if (!Number.isFinite(d) || d <= 0) return paths;\n  let since = now - d * 864e5, recent = [], rest = [];\n  for (let p of paths) {\n    let t = dvsChangedAt(local ? local[p] : void 0, files ? files[p] : void 0);\n    t >= since ? recent.push([p, t]) : rest.push(p);\n  }\n  return recent.sort((a, b) => b[1] - a[1]).map((x) => x[0]).concat(rest);\n}\n/** Same order for a list of cloud entries (used when a device downloads the whole cloud copy). */\nfunction dvsRecentFirstMetas(metas, now = Date.now(), days = 14) {\n  let byPath = new Map(metas.map((m) => [m.path, m])), files = Object.fromEntries(byPath);\n  return dvsRecentFirst([...byPath.keys()], void 0, files, now, days).map((p) => byPath.get(p));\n}\n/* --- 1.3.0: see every file in the vault folder, never update a trashed copy, tidy up imported originals --- */\n"],

// Normal sync: recent files first.
["sync-loop-order", "let Ce = Lt([...Object.keys(T), ...vn.map((m) => m.path), ...Object.keys(L), ...Object.keys(N.records)]);", "let Ce = dvsRecentFirst(Lt([...Object.keys(T), ...vn.map((m) => m.path), ...Object.keys(L), ...Object.keys(N.records)]), T, A.manifest.files, Date.now(), this.options.getRecentFirstDays?.() ?? 14);"],

// "Download from Google Drive" / replace from cloud: recent files first.
["download-all-order", "for (let p of Object.values(c.manifest.files)) if (!p.deleted) try {", "for (let p of dvsRecentFirstMetas(Object.values(c.manifest.files), Date.now(), this.options.getRecentFirstDays?.() ?? 14)) if (!p.deleted) try {"],

// A cloud reset made on another device: recent files first.
["cloud-reset-order", "for (let c of Object.values(t.manifest.files)) c.deleted || await this.downloadRemote(c.path, c, o, n);", "for (let c of dvsRecentFirstMetas(Object.values(t.manifest.files), Date.now(), this.options.getRecentFirstDays?.() ?? 14)) c.deleted || await this.downloadRemote(c.path, c, o, n);"],

// Wire the setting.
["plugin-option", "getExternalTrashOriginals: () => this.settings.externalTrashOriginals !== false, ", "getExternalTrashOriginals: () => this.settings.externalTrashOriginals !== false, getRecentFirstDays: () => { let d = Number(this.settings.recentFirstDays); return Number.isFinite(d) && d >= 0 ? d : 14; }, "],

// New setting.
["settings-ui", "    new b.Setting(e).setName(\"Largest file to import, MB\")", "    new b.Setting(e).setName(\"Sync recent files first, days\").setDesc(\"Files changed in this many days are transferred first, newest first; everything else follows in the usual order. 0 turns this off.\").addText((s) => s.setValue(String(n.recentFirstDays ?? 14)).onChange(async (i) => {\n      let o = Number(i);\n      Number.isFinite(o) && o >= 0 && (n.recentFirstDays = o, await this.plugin.saveSettings());\n    }));\n    new b.Setting(e).setName(\"Largest file to import, MB\")"],

];
