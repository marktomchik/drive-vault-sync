import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";

const code = readFileSync(process.env.BUNDLE, "utf8");
class Base { constructor(app) { this.app = app; } }
const obsidian = {
  Plugin: Base, Modal: Base, PluginSettingTab: Base, ItemView: Base, Component: Base,
  Setting: class { constructor() {} setName() { return this; } setDesc() { return this; } setHeading() { return this; } addButton() { return this; } addText() { return this; } addToggle() { return this; } addDropdown() { return this; } addTextArea() { return this; } },
  Notice: class { constructor() {} hide() {} },
  TFile: class {}, TFolder: class {}, normalizePath: (p) => p,
  Platform: { isMobile: false, isDesktop: true }, requestUrl: async () => { throw new Error("no network"); }
};
const ctx = { require: (m) => { if (m === "obsidian") return obsidian; throw new Error("unexpected require " + m); }, module: { exports: {} }, exports: {}, console, TextEncoder, TextDecoder, crypto: globalThis.crypto, setTimeout, clearTimeout, window: globalThis, URL, URLSearchParams, Buffer, btoa, atob };
vm.createContext(ctx);
vm.runInContext(code + "\n;globalThis.__t = { K, dvsPickOlderCopies, dvsDedupe };", ctx);
const { K, dvsPickOlderCopies, dvsDedupe } = ctx.__t;
const now = Date.parse("2026-11-27T12:00:00Z"), iso = (ms) => new Date(ms).toISOString(), min = 60e3, day = 864e5;
const note = "1 Щоденник/VITA NOVA.md";
const manifest = (extra = {}) => ({ files: { [note]: { path: note, driveFileId: "keep", updatedAt: now - 10 * min, mtime: now - 11 * min, deleted: false, ...extra } } });
const ids = (list) => [...list].map((c) => c.id).sort();

test("on by default", () => assert.equal(K.externalDedupe, true));

test("older same-named copies are picked, the index copy stays", () => {
  const files = [
    { id: "keep", path: note, modifiedTime: iso(now - 10 * min) },
    { id: "old-claude", path: note, modifiedTime: iso(now - 3 * day) },
    { id: "old-own", path: note, modifiedTime: iso(now - 2 * day) },
    { id: "other", path: "1 Щоденник/інша.md", modifiedTime: iso(now - 5 * day) }
  ];
  assert.deepEqual(ids(dvsPickOlderCopies(manifest(), files, now)), ["old-claude", "old-own"]);
});

test("a copy newer than the vault version is not touched (the import takes it first)", () => {
  const files = [{ id: "keep", path: note, modifiedTime: iso(now - 10 * min) }, { id: "newer", path: note, modifiedTime: iso(now - 5 * min) }];
  assert.deepEqual(ids(dvsPickOlderCopies(manifest(), files, now)), []);
});

test("very fresh copies, deleted notes, unknown paths and missing index copies are left alone", () => {
  const fresh = [{ id: "keep", path: note, modifiedTime: iso(now) }, { id: "fresh", path: note, modifiedTime: iso(now - 30e3) }];
  assert.deepEqual(ids(dvsPickOlderCopies(manifest({ updatedAt: now }), fresh, now)), []);
  const two = [{ id: "keep", path: note, modifiedTime: iso(now - day) }, { id: "old", path: note, modifiedTime: iso(now - 2 * day) }];
  assert.deepEqual(ids(dvsPickOlderCopies(manifest({ deleted: true }), two, now)), []);
  assert.deepEqual(ids(dvsPickOlderCopies({ files: {} }, two, now)), []);
  assert.deepEqual(ids(dvsPickOlderCopies(manifest({ driveFileId: "gone" }), two, now)), []);
});

test("folders, Google Docs and already-trashed ids are skipped", () => {
  const files = [
    { id: "keep", path: note, modifiedTime: iso(now - 10 * min) },
    { id: "doc", path: note, mimeType: "application/vnd.google-apps.document", modifiedTime: iso(now - day) },
    { id: "dir", path: note, mimeType: "application/vnd.google-apps.folder", modifiedTime: iso(now - day) },
    { id: "done", path: note, modifiedTime: iso(now - day) },
    { id: "old", path: note, modifiedTime: iso(now - day) }
  ];
  assert.deepEqual(ids(dvsPickOlderCopies(manifest(), files, now, new Set(["done"]))), ["old"]);
});

function fakeDrive(files) {
  const trashed = [];
  return {
    trashed,
    async listVaultFiles() { return files.map((f) => ({ ...f, name: f.path.split("/").pop() })); },
    async ensureFolderPath(parts) { return "folder:" + parts.join("/"); },
    async requestJson(url) {
      const q = decodeURIComponent(new URL(url).searchParams.get("q"));
      const folder = /'([^']+)' in parents/.exec(q)[1].replace(/^folder:/, "");
      return { files: files.filter((f) => f.path.split("/").slice(0, -1).join("/") === folder).map((f) => ({ id: f.id, name: f.path.split("/").pop(), modifiedTime: f.modifiedTime })) };
    },
    async trashFile(id) { trashed.push(id); }
  };
}

test("per-note mode lists the note's folder and trashes only older copies of that note", async () => {
  const files = [
    { id: "keep", path: note, modifiedTime: iso(now - 10 * min) },
    { id: "old", path: note, modifiedTime: iso(now - day) },
    { id: "x-keep", path: "1 Щоденник/x.md", modifiedTime: iso(now - day) },
    { id: "x-old", path: "1 Щоденник/x.md", modifiedTime: iso(now - 2 * day) }
  ];
  const m = manifest(); m.files["1 Щоденник/x.md"] = { path: "1 Щоденник/x.md", driveFileId: "x-keep", updatedAt: now - day, deleted: false };
  const r = fakeDrive(files);
  const res = await dvsDedupe(r, { filesFolderId: "root", manifest: m }, [note], new Set(), now);
  assert.deepEqual(r.trashed, ["old"]);
  assert.equal(res.trashed, 1);
});

test("whole-folder mode cleans every note", async () => {
  const files = [
    { id: "keep", path: note, modifiedTime: iso(now - 10 * min) },
    { id: "old", path: note, modifiedTime: iso(now - day) },
    { id: "x-keep", path: "x.md", modifiedTime: iso(now - day) },
    { id: "x-old", path: "x.md", modifiedTime: iso(now - 2 * day) }
  ];
  const m = manifest(); m.files["x.md"] = { path: "x.md", driveFileId: "x-keep", updatedAt: now - day, deleted: false };
  const r = fakeDrive(files);
  const res = await dvsDedupe(r, { filesFolderId: "root", manifest: m }, null, new Set(), now);
  assert.deepEqual([...r.trashed].sort(), ["old", "x-old"]);
  assert.deepEqual([...res.paths].sort(), [note, "x.md"].sort());
});

test("the sync engine trashes older copies after the index is saved", async () => {
  vm.runInContext(";globalThis.__e = bt;", ctx);
  const Engine = ctx.__e;
  const files = [{ id: "keep", path: note, modifiedTime: iso(Date.now() - day) }, { id: "old", path: note, modifiedTime: iso(Date.now() - 2 * day) }, { id: "orig", path: note, modifiedTime: iso(Date.now() - 3 * day) }];
  const r = fakeDrive(files), logs = [];
  const m = { files: { [note]: { path: note, driveFileId: "keep", updatedAt: Date.now() - day, deleted: false } } };
  const engine = Object.create(Engine.prototype);
  engine.options = { drive: r, appendLog: async (e, d) => logs.push([e, d]), getExternalDedupe: () => true };
  engine.pendingTrash = ["orig"];
  engine.pendingDedupe = { state: { filesFolderId: "root", manifest: m }, paths: [note] };
  await engine.finishExternalImport();
  assert.deepEqual([...r.trashed].sort(), ["old", "orig"]);
  assert.ok(logs.some(([e, d]) => e === "sync-engine-older-copies-trashed" && d.trashed === 1));
  assert.equal(engine.pendingDedupe, undefined);

  const r2 = fakeDrive(files);
  engine.options = { drive: r2, appendLog: async () => {}, getExternalDedupe: () => false };
  engine.pendingDedupe = { state: { filesFolderId: "root", manifest: m }, paths: [note] };
  await engine.finishExternalImport();
  assert.deepEqual(r2.trashed, []);
});
