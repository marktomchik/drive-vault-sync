import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";

const file = process.env.BUNDLE;
const code = readFileSync(file, "utf8");
class Base { constructor(app) { this.app = app; } }
const obsidian = {
  Plugin: Base, Modal: Base, PluginSettingTab: Base, ItemView: Base, Component: Base,
  Setting: class { constructor() {} setName() { return this; } setDesc() { return this; } setHeading() { return this; } addButton() { return this; } addText() { return this; } addToggle() { return this; } addDropdown() { return this; } addTextArea() { return this; } },
  Notice: class { constructor() {} hide() {} },
  TFile: class {}, TFolder: class {}, normalizePath: (p) => p.replace(/\/+/g, "/").replace(/\/$/, ""),
  Platform: { isMobile: false, isDesktop: true }, requestUrl: async () => { throw new Error("no network"); }
};
const ctx = { require: (m) => { if (m === "obsidian") return obsidian; throw new Error("unexpected require " + m); }, module: { exports: {} }, exports: {}, console, TextEncoder, TextDecoder, crypto: globalThis.crypto, setTimeout, clearTimeout, window: globalThis, URL, URLSearchParams, Buffer, btoa, atob };
vm.createContext(ctx);
vm.runInContext(code + "\n;globalThis.__t = { K, Et, staging: typeof DvsPluginStaging };", ctx);
const { K, Et, staging } = ctx.__t;

test("plugin delivery is gone from the bundle", () => {
  assert.equal(staging, "undefined");
  for (const s of ["publish-plugins-for-devices", "install-staged-plugins", "publishStagedPlugins", "installStagedPlugins", "Plugins for other devices", "DVS_STAGED_FILES"]) {
    assert.ok(!code.includes(s), `still contains ${s}`);
  }
});

test("defaults no longer carry staging settings", () => {
  for (const k of ["pluginStagingFolder", "stagedPluginIds", "autoInstallStagedPlugins"]) assert.ok(!(k in K), k);
  assert.equal(K.externalImportMode, "off", "other 1.2.x defaults are kept");
});

test("old staging keys in data.json are dropped on load, other settings kept", async () => {
  const self = {
    app: { vault: { configDir: ".obsidian" } },
    pluginDir: ".obsidian/plugins/drive-vault-sync",
    readVaultDataFile: async () => ({ settings: { deviceName: "PC", pluginStagingFolder: "Плагіни", stagedPluginIds: "drive-vault-sync", autoInstallStagedPlugins: true } })
  };
  await Et.prototype.loadSettings.call(self);
  assert.equal(self.settings.deviceName, "PC");
  for (const k of ["pluginStagingFolder", "stagedPluginIds", "autoInstallStagedPlugins"]) assert.ok(!(k in self.settings), k);
});
