import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const outfile = path.join(tmpdir(), `dvs-test-sync-${Date.now()}.mjs`);
const shimPath = path.resolve("tests/obsidian-shim.mjs");
await build({
  stdin: {
    contents: `
      export { SyncEngine } from "./src/sync";
      export { GoogleDriveProvider } from "./src/provider";
      export { LocalVaultScanner } from "./src/scanner";
      export { OfflineSyncQueue } from "./src/offlineQueue";
    `,
    resolveDir: process.cwd(),
    loader: "ts"
  },
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  plugins: [{
    name: "obsidian-shim",
    setup(pluginBuild) {
      // External, so the test and the bundle share one copy (instanceof TFile must work across both).
      pluginBuild.onResolve({ filter: /^obsidian$/ }, () => ({ path: pathToFileURL(shimPath).href, external: true }));
      pluginBuild.onResolve({ filter: /^qrcode$/ }, () => ({ path: "qrcode", namespace: "stub" }));
      pluginBuild.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "export async function toDataURL() { return ''; }", loader: "js" }));
    }
  }]
});
globalThis.window = globalThis;
const shim = await import(pathToFileURL(shimPath).href);
const { SyncEngine, GoogleDriveProvider, LocalVaultScanner, OfflineSyncQueue } = await import(`${pathToFileURL(outfile).href}?${Date.now()}`);

/** Minimal in-memory vault with the parts of the Obsidian API the engine uses. */
function createVault(initial = {}) {
  const files = new Map();
  let clock = 1000;
  const put = (filePath, content) => {
    const file = files.get(filePath)?.file ?? new shim.TFile(filePath);
    file.stat = { mtime: ++clock, size: Buffer.byteLength(content) };
    files.set(filePath, { file, content });
  };
  for (const [filePath, content] of Object.entries(initial)) put(filePath, content);
  const vault = {
    files,
    put,
    getFiles: () => [...files.values()].map((entry) => entry.file),
    getAbstractFileByPath: (filePath) => files.get(filePath)?.file ?? null,
    read: async (file) => files.get(file.path).content,
    readBinary: async (file) => new TextEncoder().encode(files.get(file.path).content).buffer,
    create: async (filePath, content) => put(filePath, content),
    createBinary: async (filePath, content) => put(filePath, new TextDecoder().decode(content)),
    modify: async (file, content) => put(file.path, content),
    modifyBinary: async (file, content) => put(file.path, new TextDecoder().decode(content)),
    createFolder: async () => undefined,
    adapter: {
      exists: async () => false,
      mkdir: async () => undefined,
      write: async (filePath, content) => put(filePath, content),
      writeBinary: async (filePath, content) => put(filePath, new TextDecoder().decode(content))
    }
  };
  const app = {
    vault,
    fileManager: { trashFile: async (file) => { files.delete(file.path); } }
  };
  return { vault, app };
}

/** In-memory stand-in for the Google Drive client. */
function createDrive({ failUploadFor = new Set() } = {}) {
  const blobs = new Map();
  let nextId = 1;
  const state = {
    rootFolderId: "root",
    filesFolderId: "files",
    manifest: { version: 1, vaultId: "vault", updatedAt: 0, files: {} }
  };
  const drive = {
    blobs,
    state,
    saved: 0,
    async loadRemoteState() {
      return { ...state, manifest: JSON.parse(JSON.stringify(state.manifest)) };
    },
    async saveManifest(remoteState) {
      drive.saved += 1;
      state.manifest = JSON.parse(JSON.stringify(remoteState.manifest));
    },
    async uploadVaultFile(filePath, content, _mime, _folder, existingId) {
      if (failUploadFor.has(filePath)) throw new Error(`Upload rejected for ${filePath}`);
      const id = existingId ?? `f${nextId++}`;
      blobs.set(id, typeof content === "string" ? content : new TextDecoder().decode(content));
      return { id, headRevisionId: `r${nextId}` };
    },
    async downloadFile(id) {
      return new TextEncoder().encode(blobs.get(id)).buffer;
    },
    async trashFile(id) {
      blobs.delete(id);
    },
    async createBackup() {
      return {};
    }
  };
  return drive;
}

async function sha(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function createEngine({ app, drive }) {
  const pluginData = { index: {}, localManifest: undefined, offlineQueue: [], failures: [] };
  const progressStates = [];
  const provider = new GoogleDriveProvider(drive, () => "Folder", () => "vault", () => "device-a", () => "Laptop");
  const scanner = new LocalVaultScanner(app.vault, () => ".sync/");
  const offlineQueue = new OfflineSyncQueue(() => pluginData.offlineQueue, async (items) => { pluginData.offlineQueue = items; }, () => "device-a");
  const engine = new SyncEngine({
    app,
    scanner,
    drive,
    provider,
    offlineQueue,
    getRemoteFolderName: () => "Folder",
    getVaultId: () => "vault",
    getIndex: () => pluginData.index,
    setIndex: async (index) => { pluginData.index = index; },
    getLocalManifest: () => pluginData.localManifest,
    setLocalManifest: async (manifest) => { pluginData.localManifest = manifest; },
    getOfflineQueueItems: () => pluginData.offlineQueue,
    getMaxDeletionPercent: () => 100,
    getConflictPolicy: () => "keep-both",
    getDeviceId: () => "device-a",
    getDeviceName: () => "Laptop",
    getAppliedCommandIds: () => [],
    setAppliedCommandIds: async () => undefined,
    getBackupEnabled: () => false,
    getBackupMode: () => "safety-only",
    getBackupIntervalMinutes: () => 30,
    getMaxBackups: () => 10,
    appendLog: async () => undefined,
    persistFailures: async (failures) => { pluginData.failures = failures; },
    onProgress: (state) => progressStates.push({ stage: state.stage, active: state.active })
  });
  return { engine, pluginData, progressStates };
}

test("uploads new local notes and downloads new cloud notes, reporting every stage", async () => {
  const { app, vault } = createVault({ "Local.md": "from laptop" });
  const drive = createDrive();
  drive.blobs.set("cloud1", "from phone");
  drive.state.manifest.files["Phone.md"] = {
    path: "Phone.md", driveFileId: "cloud1", hash: await sha("from phone"), size: 10, deleted: false, updatedAt: 1, deviceId: "device-b"
  };
  const { engine, progressStates } = createEngine({ app, drive });

  const summary = await engine.syncNow(false);

  assert.equal(summary.uploads, 1);
  assert.equal(summary.downloads, 1);
  assert.equal(summary.errors, 0);
  assert.equal(vault.files.get("Phone.md").content, "from phone");
  assert.ok(drive.state.manifest.files["Local.md"]);
  const stages = new Set(progressStates.map((state) => state.stage));
  for (const stage of ["remote", "scanning", "planning", "transferring", "saving"]) assert.ok(stages.has(stage), `missing stage ${stage}`);
  const final = engine.getProgress();
  assert.equal(final.active, false);
  assert.equal(final.counts.upload, 1);
  assert.equal(final.counts.download, 1);
  assert.ok(engine.consumeLocalWrites().has("Phone.md"), "downloads are reported as own writes");
});

test("a second sync without changes transfers nothing", async () => {
  const { app } = createVault({ "Note.md": "hello" });
  const drive = createDrive();
  const { engine } = createEngine({ app, drive });
  await engine.syncNow(false);
  const second = await engine.syncNow(false);
  assert.equal(second.uploads + second.downloads + second.localDeletes + second.remoteDeletes, 0);
});

test("deleting a note locally marks it deleted in the cloud", async () => {
  const { app, vault } = createVault({ "Keep.md": "keep", "Gone.md": "bye" });
  const drive = createDrive();
  const { engine } = createEngine({ app, drive });
  await engine.syncNow(false);
  vault.files.delete("Gone.md");
  const summary = await engine.syncNow(false);
  assert.equal(summary.remoteDeletes, 1);
  assert.equal(drive.state.manifest.files["Gone.md"].deleted, true);
  assert.equal(engine.getProgress().counts["delete-remote"], 1);
});

test("one failing file does not stop the rest of the sync", async () => {
  const { app } = createVault({ "Good.md": "ok", "Bad.md": "broken" });
  const drive = createDrive({ failUploadFor: new Set(["Bad.md"]) });
  const { engine, pluginData } = createEngine({ app, drive });
  const summary = await engine.syncNow(false);
  assert.equal(summary.uploads, 1);
  assert.equal(summary.errors, 1);
  assert.ok(drive.state.manifest.files["Good.md"]);
  assert.equal(pluginData.failures.length, 1);
  assert.equal(pluginData.failures[0].path, "Bad.md");
  const failedRow = engine.getProgress().items.find((item) => item.path === "Bad.md");
  assert.equal(failedRow.status, "error");
  assert.match(failedRow.detail, /Upload rejected/);
});

test("edits on two devices in different paragraphs are merged automatically", async () => {
  const { app, vault } = createVault({ "Daily.md": "Intro\n\nTasks\n" });
  const drive = createDrive();
  const { engine } = createEngine({ app, drive });
  await engine.syncNow(false);

  vault.put("Daily.md", "Intro\nLocal line\n\nTasks\n");
  const remoteText = "Intro\n\nTasks\nRemote line\n";
  const remoteEntry = drive.state.manifest.files["Daily.md"];
  drive.blobs.set(remoteEntry.driveFileId, remoteText);
  remoteEntry.hash = await sha(remoteText);
  remoteEntry.deviceId = "device-b";

  const summary = await engine.syncNow(false);
  assert.equal(summary.conflicts, 0);
  const merged = vault.files.get("Daily.md").content;
  assert.match(merged, /Local line/);
  assert.match(merged, /Remote line/);
  assert.equal(engine.getProgress().counts.merge, 1);
});

test("the scanner reads no more files at once than its concurrency allows", async () => {
  const { app } = createVault(Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`note-${i}.png`, "x"])));
  let reading = 0;
  let peak = 0;
  const readBinary = app.vault.readBinary;
  app.vault.readBinary = async (file) => {
    peak = Math.max(peak, ++reading);
    await new Promise((resolve) => setTimeout(resolve, 1));
    reading -= 1;
    return readBinary(file);
  };
  await new LocalVaultScanner(app.vault, () => "", 2).scan();
  assert.equal(peak, 2);
});
