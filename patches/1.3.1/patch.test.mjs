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
vm.runInContext(code + "\n;globalThis.__t = { K, dvsRecentFirst, dvsRecentFirstMetas };", ctx);
const { K, dvsRecentFirst, dvsRecentFirstMetas } = ctx.__t;
const day = 864e5, now = Date.parse("2026-11-23T12:00:00Z");

test("default is 14 days", () => assert.equal(K.recentFirstDays, 14));

test("files from the last 14 days come first, newest first; the rest keep their order", () => {
  const paths = ["old-b.md", "week.md", "old-a.md", "today.md", "cloud-only.md", "yesterday.md", "15-days.md"];
  const local = {
    "old-b.md": { mtime: now - 100 * day },
    "week.md": { mtime: now - 7 * day },
    "old-a.md": { mtime: now - 30 * day },
    "today.md": { mtime: now - 3600e3 },
    "yesterday.md": { mtime: now - day },
    "15-days.md": { mtime: now - 15 * day }
  };
  const files = { "cloud-only.md": { mtime: now - 40 * day, updatedAt: now - 2 * day }, "old-a.md": { mtime: now - 30 * day, updatedAt: now - 30 * day } };
  assert.deepEqual([...dvsRecentFirst(paths, local, files, now, 14)], ["today.md", "yesterday.md", "cloud-only.md", "week.md", "old-b.md", "old-a.md", "15-days.md"]);
});

test("0 days keeps the old order", () => {
  const paths = ["b", "a"];
  assert.deepEqual([...dvsRecentFirst(paths, { a: { mtime: now } }, {}, now, 0)], ["b", "a"]);
});

test("whole-cloud download goes newest first too", () => {
  const metas = [{ path: "old.md", mtime: now - 60 * day }, { path: "new.md", mtime: now - day }, { path: "newer.md", updatedAt: now - 3600e3 }];
  assert.deepEqual([...dvsRecentFirstMetas(metas, now, 14).map((m) => m.path)], ["newer.md", "new.md", "old.md"]);
});
