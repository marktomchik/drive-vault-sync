import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";

const file = process.env.BUNDLE;
class Base { constructor(app) { this.app = app; } }
class TFile { constructor(path) { this.path = path; } }
const obsidian = {
  Plugin: Base, Modal: Base, PluginSettingTab: Base, ItemView: Base, Component: Base,
  Setting: class { constructor() {} setName() { return this; } setDesc() { return this; } setHeading() { return this; } addButton() { return this; } addText() { return this; } addToggle() { return this; } addDropdown() { return this; } addTextArea() { return this; } },
  Notice: class { constructor(m) { obsidian.notices.push(m); } hide() {} },
  TFile, TFolder: class {}, normalizePath: (p) => p.replace(/\/+/g, "/").replace(/\/$/, ""),
  Platform: { isMobile: false, isDesktop: true }, requestUrl: async () => { throw new Error("no network"); },
  notices: []
};
const ctx = { require: (m) => { if (m === "obsidian") return obsidian; throw new Error("unexpected require " + m); }, module: { exports: {} }, exports: {}, console, TextEncoder, TextDecoder, crypto: globalThis.crypto, setTimeout, clearTimeout, window: globalThis, URL, URLSearchParams, Buffer };
vm.createContext(ctx);
vm.runInContext(readFileSync(file, "utf8") + "\n;globalThis.__t = { Xs, dvsPlanExternal, it, DvsPluginStaging, dvsCompareVersions, dvsSkipAdopted, dvsDotPath };", ctx);
const { Xs, dvsPlanExternal, it, DvsPluginStaging, dvsCompareVersions, dvsSkipAdopted } = ctx.__t;
const enc = (s) => new TextEncoder().encode(s).buffer;

function fakeDrive(files, contents) {
  const log = { downloads: [], created: [], updated: [] };
  let n = 0;
  return {
    log,
    listFilesChangedSince: async () => files,
    downloadFile: async (id) => { log.downloads.push(id); return contents[id]; },
    ensureFolderPath: async (parts) => "folder:" + parts.join("/"),
    createFile: async (name, folder) => { log.created.push(folder + "/" + name); return { id: "own" + ++n, headRevisionId: "own-rev" }; },
    updateContent: async (id) => { log.updated.push(id); return { id, headRevisionId: "upd-rev" }; }
  };
}
const resolver = { resolve: async (f) => f.path };
const manifest = (files) => ({ version: 1, vaultId: "v", updatedAt: 0, files });

test("plan: dot-folders, oversized, older-than-vault, older-than-deletion and duplicates are skipped", async () => {
  const files = [
    { id: "a", path: "Reports/data.json", size: "7", modifiedTime: "2026-11-09T10:00:00Z", createdTime: "2026-11-09T10:00:00Z", headRevisionId: "r1" },
    { id: "b", path: ".obsidian/plugins/x/main.js", size: "3", modifiedTime: "2026-11-09T10:00:00Z" },
    { id: "c", path: "big.pdf", size: String(50 * 1048576), modifiedTime: "2026-11-09T10:00:00Z" },
    { id: "d", path: "Notes/old.md", size: "3", modifiedTime: "2026-01-01T00:00:00Z" },
    { id: "e", path: "Notes/gone.md", size: "3", modifiedTime: "2026-11-09T00:00:00Z", createdTime: "2026-01-01T00:00:00Z" },
    { id: "f1", path: "dup.md", size: "1", modifiedTime: "2026-11-01T00:00:00Z" },
    { id: "f2", path: "dup.md", size: "1", modifiedTime: "2026-11-05T00:00:00Z" },
    { id: "g", path: "Notes/edited.md", size: "4", modifiedTime: "2026-11-09T12:00:00Z" }
  ];
  const drive = fakeDrive(files, {});
  const m = manifest({
    "Notes/old.md": { path: "Notes/old.md", driveFileId: "x1", hash: "h", size: 3, deleted: false, updatedAt: Date.parse("2026-06-01T00:00:00Z") },
    "Notes/gone.md": { path: "Notes/gone.md", driveFileId: "x2", hash: "h", size: 3, deleted: true, deletedAt: Date.parse("2026-05-01T00:00:00Z"), updatedAt: 0 },
    "Notes/edited.md": { path: "Notes/edited.md", driveFileId: "x3", hash: "h", size: 3, deleted: false, updatedAt: Date.parse("2026-11-01T00:00:00Z") }
  });
  const cands = await it(drive, resolver, 0, new Set(["x1", "x2", "x3"]), () => false);
  assert.equal(cands.some((c) => c.path.startsWith(".obsidian")), false);
  const pre = dvsPlanExternal(m, cands, {}, 20 * 1048576);
  assert.deepEqual([...pre.plan].map((p) => `${p.action}:${p.path}`).sort(), ["new:Reports/data.json", "new:dup.md", "update:Notes/edited.md"]);
  assert.equal(pre.plan.find((p) => p.path === "dup.md").file.id, "f2");
  const reasons = [...pre.skipped].map((s) => s.reason).sort();
  assert.deepEqual(reasons, ["older-duplicate", "older-than-deletion", "older-than-vault-copy", "too-large"]);
  assert.equal(drive.log.downloads.length, 0, "planning never downloads");
});

test("import copies into plugin-owned files, never touches the Drive original, keeps identical local files", async () => {
  const files = [
    { id: "a", path: "Reports/data.json", size: "7", modifiedTime: "2026-11-09T10:00:00Z", headRevisionId: "r1" },
    { id: "s", path: "same.md", size: "2", modifiedTime: "2026-11-09T10:00:00Z", headRevisionId: "r1" },
    { id: "u", path: "Notes/edited.md", size: "3", modifiedTime: "2026-11-09T12:00:00Z", headRevisionId: "r5" }
  ];
  const drive = fakeDrive(files, { a: enc('{"a":1}'), s: enc("hi"), u: enc("new") });
  const state = { filesFolderId: "files", rootFolderId: "root", manifest: manifest({
    "Notes/edited.md": { path: "Notes/edited.md", driveFileId: "x3", hash: "old", size: 3, deleted: false, updatedAt: Date.parse("2026-11-01T00:00:00Z") }
  }) };
  const ownSaved = [];
  const sha = async (s) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))).map((b) => b.toString(16).padStart(2, "0")).join("");
  const local = { "same.md": { hash: await sha("hi") } };
  const cands = await it(drive, resolver, 0, new Set(["x3"]), () => false);
  const pre = dvsPlanExternal(state.manifest, cands, {}, 1e9);
  const r = await Xs(drive, state, pre, 1000, { local, maxBytes: 1e9, saveOwn: async (m) => ownSaved.push(m) });
  assert.deepEqual([...r.added], ["Reports/data.json"]);
  assert.deepEqual([...r.updated], ["Notes/edited.md"]);
  assert.deepEqual([...drive.log.downloads].sort(), ["Notes/edited.md", "same.md", "Reports/data.json"].map((p) => files.find((f) => f.path === p).id).sort());
  assert.deepEqual(drive.log.created, ["folder:Reports/data.json"]);
  assert.deepEqual(drive.log.updated, ["x3"], "only the plugin's own copy is updated");
  const fin = state.manifest.files["Reports/data.json"];
  assert.equal(fin.driveFileId, "own1");
  assert.notEqual(fin.driveFileId, "a");
  assert.equal(state.manifest.files["same.md"], undefined, "identical local file: engine uploads it itself");
  assert.equal(ownSaved.length, 1);
  assert.equal(r.adopted.a.revision, "r1");
  assert.equal(r.adopted.s.revision, "r1");
  // Unchanged adopted originals and own copies are not candidates again.
  const skip = dvsSkipAdopted({ ...r.adopted, ...ownSaved[0] });
  assert.equal(skip({ id: "a", headRevisionId: "r1" }), true);
  assert.equal(skip({ id: "a", headRevisionId: "r2" }), false);
  assert.equal(skip({ id: "own1", headRevisionId: "zzz" }), true);
});

test("plugin staging: publishes newer, installs newer, never downgrades, never copies data.json", async () => {
  const fs = new Map();
  const adapter = {
    exists: async (p) => fs.has(p) || [...fs.keys()].some((k) => k.startsWith(p + "/")),
    read: async (p) => { if (!fs.has(p)) throw new Error("missing " + p); return fs.get(p); },
    write: async (p, t) => { fs.set(p, t); },
    mkdir: async () => {}
  };
  const vault = {
    configDir: ".obsidian", adapter,
    getAbstractFileByPath: (p) => (fs.has(p) ? new TFile(p) : null),
    createFolder: async () => {},
    read: async (f) => fs.get(f.path), modify: async (f, t) => fs.set(f.path, t), create: async (p, t) => fs.set(p, t)
  };
  const man = (v) => JSON.stringify({ id: "drive-vault-sync", version: v });
  fs.set(".obsidian/plugins/drive-vault-sync/manifest.json", man("1.2.0"));
  fs.set(".obsidian/plugins/drive-vault-sync/main.js", "NEW");
  fs.set(".obsidian/plugins/drive-vault-sync/data.json", "SECRET");
  const st = new DvsPluginStaging({ vault }, () => "Плагіни", () => ["drive-vault-sync", "../evil"], async () => {});
  assert.equal((await st.publish(false)).length, 1);
  assert.equal(fs.get("Плагіни/drive-vault-sync/main.js"), "NEW");
  assert.equal(fs.has("Плагіни/drive-vault-sync/data.json"), false);
  assert.equal((await st.publish(false)).length, 0, "same version: nothing to do");
  // Phone side: older installed version gets the staged one; data.json stays.
  fs.set(".obsidian/plugins/drive-vault-sync/manifest.json", man("1.1.0"));
  fs.set(".obsidian/plugins/drive-vault-sync/main.js", "OLD");
  assert.equal((await st.publish(false)).length, 0, "never downgrades the staging copy");
  assert.deepEqual([...await st.installNewer()], ["drive-vault-sync 1.2.0"]);
  assert.equal(fs.get(".obsidian/plugins/drive-vault-sync/main.js"), "NEW");
  assert.equal(fs.get(".obsidian/plugins/drive-vault-sync/main.js.prev"), "OLD");
  assert.equal(fs.get(".obsidian/plugins/drive-vault-sync/data.json"), "SECRET");
  assert.equal((await st.installNewer()).length, 0);
  assert.equal(dvsCompareVersions("1.10.0", "1.9.9"), 1);
});
