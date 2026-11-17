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
const ctx = { require: (m) => { if (m === "obsidian") return obsidian; throw new Error("unexpected require " + m); }, module: { exports: {} }, exports: {}, console, TextEncoder, TextDecoder, crypto: globalThis.crypto, setTimeout, clearTimeout, window: globalThis, URL, URLSearchParams, Buffer, btoa, atob };
vm.createContext(ctx);
vm.runInContext(readFileSync(file, "utf8") + "\n;globalThis.__t = { bt };", ctx);


const { bt } = ctx.__t;
const md = (h) => ({ hash: h, size: 1, isText: true, extension: "md", mtime: 1 });
function makeEngine(local, cloud) {
  const writes = [], reads = [], deletes = [], uploads = [];
  let index = null;
  const files = {};
  for (const [p, h] of Object.entries(cloud)) files[p] = { path: p, hash: h, driveFileId: "id-" + p, revision: "r1", size: 1, deleted: false };
  const options = {
    scanner: { scan: async () => local, readText: async (p) => { reads.push(p); return "text of " + p; } },
    provider: { prepare: async () => ({ manifest: { files }, filesFolderId: "f" }), download: async (p) => ({ content: "cloud " + p, isText: true }) },
    drive: { saveManifest: async () => {} },
    getBackupEnabled: () => false,
    setIndex: async (i) => { index = i; },
    getDeviceId: () => "dev", getDeviceName: () => "PC"
  };
  const e = new bt(options);
  e.log = async () => {};
  e.writeLocal = async (p) => { writes.push(p); };
  e.safeLocalDelete = async (p) => { deletes.push(p); };
  e.uploadLocal = async (p) => { uploads.push(p); };
  e.reportFailedTransfers = async () => {};
  e.buildScanCache = () => ({});
  return { e, writes, reads, deletes, uploads, get index() { return index; } };
}

test("identical files are not downloaded again; only missing and different ones are", async () => {
  const t = makeEngine({ "a.md": md("H1"), "b.md": md("OLD"), "local-only.md": md("L") }, { "a.md": "H1", "b.md": "NEW", "c.md": "H3" });
  const summary = await t.e.resetLocalFromCloud(["local-only.md"]);
  assert.deepEqual([...t.writes].sort(), ["b.md", "c.md"]);
  assert.equal(summary.downloads, 2);
  assert.deepEqual(Object.keys(t.index).sort(), ["a.md", "b.md", "c.md"]);
  assert.equal(t.index["a.md"].lastSyncedHash, "H1");
  assert.equal(t.index["a.md"].lastSyncedRemoteId, "id-a.md");
  assert.deepEqual(t.deletes, []);
  assert.deepEqual(t.uploads, ["local-only.md"]);
});

test("an empty vault downloads everything", async () => {
  const t = makeEngine({}, { "a.md": "H1", "b.md": "H2" });
  const summary = await t.e.resetLocalFromCloud([]);
  assert.equal(summary.downloads, 2);
  assert.deepEqual([...t.writes].sort(), ["a.md", "b.md"]);
});

test("a local file missing from the cloud and not kept is still handled as before", async () => {
  const t = makeEngine({ "x.md": md("X") }, { "a.md": "H1" });
  await t.e.resetLocalFromCloud([]);
  assert.deepEqual(t.deletes, ["x.md"]);
});

test("if the local copy cannot be read, the file is downloaded instead", async () => {
  const t = makeEngine({ "a.md": md("H1") }, { "a.md": "H1" });
  t.e.options.scanner.readText = async () => { throw new Error("locked"); };
  const summary = await t.e.resetLocalFromCloud([]);
  assert.equal(summary.downloads, 1);
  assert.deepEqual(t.writes, ["a.md"]);
});
