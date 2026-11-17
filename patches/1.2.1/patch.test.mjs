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
vm.runInContext(readFileSync(file, "utf8") + "\n;globalThis.__t = { js, zs, Ws, ft, Ue };", ctx);

const { js, zs, Ws } = ctx.__t;
const auth = { access_token: "AT", refresh_token: "RT", expires_at: 1, scope: "https://www.googleapis.com/auth/drive", client_id: "desk", client_secret: "sec" };
const plain = { v: 1, encrypted: false, auth };
const link = zs(plain);
const code = link.split("payload=")[1];

test("the full obsidian:// link is accepted", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(js(link))), plain);
});
test("the bare code still works (protocol handler path)", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(js(code))), plain);
});
test("text a camera or messenger mangled: spaces, line breaks, surrounding words", () => {
  const messy = "Search: " + link.slice(0, 40) + "\n " + link.slice(40, 90) + "  " + link.slice(90) + "  ";
  assert.deepEqual(JSON.parse(JSON.stringify(js(messy))), plain);
});
test("a percent-encoded link is accepted", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(js(encodeURIComponent(link)))), plain);
});
test("an encrypted payload round-trips through the link", async () => {
  const enc = await Ws(auth, "pw");
  const back = js(zs(enc));
  assert.equal(back.encrypted, true);
  assert.equal(back.data, enc.data);
});
test("junk is rejected", () => {
  assert.throws(() => js("https://example.com"));
  assert.throws(() => js(""));
  assert.throws(() => js("payload=" + btoa(JSON.stringify({ hello: 1 }))));
});
