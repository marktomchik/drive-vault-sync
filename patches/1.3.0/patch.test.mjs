import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";

const file = process.env.BUNDLE;
const code = readFileSync(file, "utf8");
class Base { constructor(app) { this.app = app; } }
const notices = [];
const obsidian = {
  Plugin: Base, Modal: Base, PluginSettingTab: Base, ItemView: Base, Component: Base,
  Setting: class { constructor() {} setName() { return this; } setDesc() { return this; } setHeading() { return this; } addButton() { return this; } addText() { return this; } addToggle() { return this; } addDropdown() { return this; } addTextArea() { return this; } },
  Notice: class { constructor(m) { notices.push(m); } hide() {} },
  TFile: class {}, TFolder: class {}, normalizePath: (p) => p.replace(/\/+/g, "/").replace(/\/$/, ""),
  Platform: { isMobile: false, isDesktop: true }, requestUrl: async () => { throw new Error("no network"); }
};
const ctx = { require: (m) => { if (m === "obsidian") return obsidian; throw new Error("unexpected require " + m); }, module: { exports: {} }, exports: {}, console, TextEncoder, TextDecoder, crypto: globalThis.crypto, setTimeout, clearTimeout, window: globalThis, URL, URLSearchParams, Buffer, btoa, atob };
vm.createContext(ctx);
vm.runInContext(code + "\n;globalThis.__t = { K, Et, bt, Xs, dvsPlanExternal, dvsFullFolderCandidates };", ctx);
const { K, Et, bt, Xs, dvsPlanExternal, dvsFullFolderCandidates } = ctx.__t;
const enc = (s) => new TextEncoder().encode(s).buffer;
const manifest = (files) => ({ version: 1, vaultId: "v", updatedAt: 0, files });

function fakeDrive({ changed = [], folder = [], contents = {}, trashed = new Set() } = {}) {
  const log = { downloads: [], created: [], updated: [], trashedNow: [] };
  let n = 0;
  return {
    log,
    listFilesChangedSince: async () => changed,
    listVaultFiles: async () => folder,
    getParentsInfo: async (id) => ({ id, name: "x", parents: [] }),
    downloadFile: async (id) => { log.downloads.push(id); return contents[id]; },
    ensureFolderPath: async (parts) => "folder:" + parts.join("/"),
    createFile: async (name, folder) => { log.created.push(folder + "/" + name); return { id: "own" + ++n, headRevisionId: "own-rev" }; },
    updateContent: async (id) => { log.updated.push(id); return { id, headRevisionId: "upd-rev" }; },
    requestJson: async (url) => {
      const id = decodeURIComponent(url.split("/files/")[1].split("?")[0]);
      return { id, trashed: trashed.has(id) };
    },
    trashFile: async (id) => { log.trashedNow.push(id); }
  };
}

test("import is on by default, with tidy-up and a 6-hour full check", () => {
  assert.equal(K.externalImportMode, "on");
  assert.equal(K.externalTrashOriginals, true);
  assert.equal(K.externalFullScanHours, 6);
});

async function load(saved) {
  const self = { app: { vault: { configDir: ".obsidian" } }, pluginDir: ".obsidian/plugins/drive-vault-sync", readVaultDataFile: async () => ({ settings: saved }) };
  await Et.prototype.loadSettings.call(self);
  return self.settings;
}

test("a saved \"off\" is switched on once; turning it off again afterwards is kept", async () => {
  const first = await load({ deviceName: "PC", externalImportMode: "off" });
  assert.equal(first.externalImportMode, "on");
  assert.equal(first.externalImportMigrated130, true);
  assert.equal(first.deviceName, "PC");
  const later = await load({ externalImportMode: "off", externalImportMigrated130: true });
  assert.equal(later.externalImportMode, "off");
});

test("a trashed vault copy is not updated in the trash: a new copy is created", async () => {
  const drive = fakeDrive({ contents: { u: enc("new text") }, trashed: new Set(["own-old"]) });
  const state = { filesFolderId: "files", rootFolderId: "root", manifest: manifest({
    "People/Olena.md": { path: "People/Olena.md", driveFileId: "own-old", hash: "old", size: 3, deleted: false, updatedAt: 1 }
  }) };
  const cands = [{ file: { id: "u", size: "8", modifiedTime: "2026-11-23T11:37:00Z", headRevisionId: "r1" }, path: "People/Olena.md" }];
  const pre = dvsPlanExternal(state.manifest, cands, {}, 1e9);
  const r = await Xs(drive, state, pre, 1000, { maxBytes: 1e9 });
  assert.deepEqual(drive.log.updated, []);
  assert.deepEqual(drive.log.created, ["folder:People/Olena.md"]);
  assert.equal(state.manifest.files["People/Olena.md"].driveFileId, "own1");
  assert.deepEqual([...r.trash], ["u"]);
  assert.deepEqual(drive.log.trashedNow, [], "Xs itself never trashes anything");
});

test("a live vault copy is still updated in place", async () => {
  const drive = fakeDrive({ contents: { u: enc("new text") } });
  const state = { filesFolderId: "files", rootFolderId: "root", manifest: manifest({
    "a.md": { path: "a.md", driveFileId: "own-live", hash: "old", size: 3, deleted: false, updatedAt: 1 }
  }) };
  const pre = dvsPlanExternal(state.manifest, [{ file: { id: "u", size: "8", modifiedTime: "2026-11-23T11:37:00Z" }, path: "a.md" }], {}, 1e9);
  await Xs(drive, state, pre, 1000, { maxBytes: 1e9 });
  assert.deepEqual(drive.log.updated, ["own-live"]);
  assert.deepEqual(drive.log.created, []);
});

test("an original identical to the vault copy is marked for tidy-up", async () => {
  const sha = async (s) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))).map((b) => b.toString(16).padStart(2, "0")).join("");
  const drive = fakeDrive({ contents: { d: enc("same") } });
  const state = { filesFolderId: "files", rootFolderId: "root", manifest: manifest({
    "a.md": { path: "a.md", driveFileId: "own", hash: await sha("same"), size: 4, deleted: false, updatedAt: 1 }
  }) };
  const pre = dvsPlanExternal(state.manifest, [{ file: { id: "d", size: "4", modifiedTime: "2026-11-23T11:37:00Z" }, path: "a.md" }], {}, 1e9);
  const r = await Xs(drive, state, pre, 1000, { maxBytes: 1e9 });
  assert.deepEqual([...r.trash], ["d"]);
  assert.deepEqual(drive.log.created, []);
});

test("full folder listing skips known, adopted, Google-native, dot and ignored files", async () => {
  const drive = fakeDrive({ folder: [
    { id: "known", path: "a.md", mimeType: "text/markdown" },
    { id: "seen", path: "b.md", mimeType: "text/markdown" },
    { id: "doc", path: "c", mimeType: "application/vnd.google-apps.document" },
    { id: "dot", path: ".obsidian/x.json", mimeType: "application/json" },
    { id: "ign", path: "skip/me.md", mimeType: "text/markdown" },
    { id: "own", path: "d.md", mimeType: "text/markdown" },
    { id: "new", path: "1 Щоденник/note.md", mimeType: "text/markdown", modifiedTime: "2026-11-23T11:37:00Z" }
  ] });
  const out = await dvsFullFolderCandidates(drive, "files", new Set(["known"]), new Set(["seen"]), (f) => f.id === "own", (p) => p.startsWith("skip/"));
  assert.deepEqual([...out.map((x) => x.file.id)], ["new"]);
});

function engine(drive, state, opts = {}) {
  const calls = { blind: 0, fullAt: [], logs: [] };
  const options = {
    drive,
    appendLog: async (m, d) => calls.logs.push([m, d]),
    canSeeExternalFiles: () => opts.full !== false,
    getExternalImportMode: () => opts.mode ?? "on",
    getExternalScanAt: () => Date.now(),
    isIgnoredPath: () => false,
    getExternalMaxBytes: () => 1e9,
    getExternalAdopted: () => ({}),
    addExternalAdopted: async () => {},
    getExternalTrashOriginals: () => opts.trash !== false,
    shouldFullScanExternal: (m) => !!m || !!opts.dueFull,
    setExternalFullScanAt: async (t) => calls.fullAt.push(t),
    onExternalBlind: () => { calls.blind += 1; }
  };
  const e = Object.create(bt.prototype);
  e.options = options;
  return { e, calls };
}

test("a manual sync finds a file the quick check missed, imports it, and tidies up only after finishing", async () => {
  const drive = fakeDrive({
    folder: [{ id: "claude", path: "1 Щоденник/note.md", mimeType: "text/markdown", size: "5", modifiedTime: "2026-11-23T11:37:00Z", headRevisionId: "r1" }],
    contents: { claude: enc("hello") }
  });
  const state = { filesFolderId: "files", rootFolderId: "root", manifest: manifest({}) };
  const { e, calls } = engine(drive, state);
  const at = await e.importExternalFiles(state, {}, true);
  assert.ok(at > 0);
  assert.ok(state.manifest.files["1 Щоденник/note.md"], "imported into the cloud index");
  assert.deepEqual(drive.log.created, ["folder:1 Щоденник/note.md"]);
  assert.deepEqual(drive.log.trashedNow, [], "nothing is trashed before the index is saved");
  await e.finishExternalImport();
  assert.deepEqual(drive.log.trashedNow, ["claude"]);
  assert.equal(calls.fullAt.length, 1);
});

test("without a manual sync or a due full check only the quick check runs", async () => {
  const drive = fakeDrive({ folder: [{ id: "claude", path: "n.md", mimeType: "text/markdown", modifiedTime: "2026-11-23T11:37:00Z" }], contents: { claude: enc("x") } });
  const state = { filesFolderId: "files", rootFolderId: "root", manifest: manifest({}) };
  const { e, calls } = engine(drive, state);
  await e.importExternalFiles(state, {}, false);
  assert.deepEqual(drive.log.created, []);
  await e.finishExternalImport();
  assert.equal(calls.fullAt.length, 0);
});

test("tidy-up can be turned off", async () => {
  const drive = fakeDrive({ folder: [{ id: "claude", path: "n.md", mimeType: "text/markdown", modifiedTime: "2026-11-23T11:37:00Z" }], contents: { claude: enc("x") } });
  const state = { filesFolderId: "files", rootFolderId: "root", manifest: manifest({}) };
  const { e } = engine(drive, state, { trash: false });
  await e.importExternalFiles(state, {}, true);
  await e.finishExternalImport();
  assert.deepEqual(drive.log.trashedNow, []);
  assert.deepEqual(drive.log.created, ["folder:/n.md"]);
});

test("limited sign-in with import on tells the user; import off stays silent", async () => {
  const state = { filesFolderId: "files", rootFolderId: "root", manifest: manifest({}) };
  const a = engine(fakeDrive(), state, { full: false });
  await a.e.importExternalFiles(state, {}, true);
  assert.equal(a.calls.blind, 1);
  const b = engine(fakeDrive(), state, { full: false, mode: "off" });
  await b.e.importExternalFiles(state, {}, true);
  assert.equal(b.calls.blind, 0);
});
