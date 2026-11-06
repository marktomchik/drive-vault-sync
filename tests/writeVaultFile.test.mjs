import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const outfile = path.join(tmpdir(), `dvs-test-utils-${Date.now()}.mjs`);
await build({
  entryPoints: ["src/utils.ts"],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  plugins: [{
    name: "obsidian-shim",
    setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({
        path: path.resolve("tests/obsidian-shim.mjs")
      }));
    }
  }]
});

const { writeVaultFile } = await import(`${pathToFileURL(outfile).href}?${Date.now()}`);

test("writes folder/file collisions to a flat, readable conflict copy", async () => {
  const created = [];
  const adapterWrites = [];
  const vault = {
    getAbstractFileByPath: () => null,
    createFolder: async () => undefined,
    create: async (filePath, content) => {
      if (filePath === "Daily.md") throw new Error("Folder already exists");
      created.push({ filePath, content });
    },
    createBinary: async (filePath, content) => {
      if (filePath === "Daily.md") throw new Error("Folder already exists");
      created.push({ filePath, content });
    },
    modify: async () => undefined,
    modifyBinary: async () => undefined,
    adapter: {
      exists: async () => false,
      mkdir: async () => undefined,
      write: async (filePath, content) => adapterWrites.push({ filePath, content }),
      writeBinary: async (filePath, content) => adapterWrites.push({ filePath, content })
    }
  };

  await writeVaultFile(vault, "Daily.md", "remote text");

  // Hidden .sync/ paths are written through the adapter because the vault API ignores dot-folders.
  assert.equal(created.length, 0);
  assert.equal(adapterWrites.length, 1);
  assert.match(adapterWrites[0].filePath, /^\.sync\/conflicts\/[0-9-]+\/Daily \(conflict [0-9a-z]{4,8}\)\.md$/);
  assert.equal(adapterWrites[0].content, "remote text");
});

test("writes regular files through the vault API", async () => {
  const created = [];
  const vault = {
    getAbstractFileByPath: () => null,
    createFolder: async () => undefined,
    create: async (filePath, content) => created.push({ filePath, content }),
    createBinary: async (filePath, content) => created.push({ filePath, content }),
    modify: async () => undefined,
    modifyBinary: async () => undefined
  };
  await writeVaultFile(vault, "Notes/Today.md", "hello");
  assert.deepEqual(created, [{ filePath: "Notes/Today.md", content: "hello" }]);
});
