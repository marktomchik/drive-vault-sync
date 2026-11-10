// Read-only dry run of the 1.2.0 external import against the real Drive. Only GET requests to Drive.
// Tokens are kept in memory and never printed or written.
import { readFileSync } from "node:fs";
import vm from "node:vm";

const [bundle, dataFile] = process.argv.slice(2);
const data = JSON.parse(readFileSync(dataFile, "utf8"));
const ctx = { require: () => ({ Modal: class {}, Plugin: class {}, PluginSettingTab: class {}, ItemView: class {}, Component: class {}, Setting: class {}, Notice: class {}, TFile: class {}, TFolder: class {}, normalizePath: (p) => p, Platform: {}, requestUrl: async () => { throw new Error("x"); } }), module: { exports: {} }, exports: {}, console, TextEncoder, TextDecoder, crypto: globalThis.crypto, setTimeout, clearTimeout, window: globalThis, URL, URLSearchParams };
vm.createContext(ctx);
vm.runInContext(readFileSync(bundle, "utf8") + "\n;globalThis.__t = { it, dvsPlanExternal, dvsSkipAdopted, be, st, ge, pe, dvsCountReasons };", ctx);
const T = ctx.__t;

const s = data.settings;
const tok = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: s.clientId, client_secret: s.clientSecret, refresh_token: data.auth.refresh_token, grant_type: "refresh_token" }) }).then((r) => r.json());
if (!tok.access_token) { console.log("token refresh failed:", tok.error); process.exit(1); }
const H = { Authorization: `Bearer ${tok.access_token}` };
const api = "https://www.googleapis.com/drive/v3";
const get = async (path, q) => { const r = await fetch(`${api}${path}?${new URLSearchParams(q)}`, { headers: H }); if (!r.ok) throw new Error(`GET ${path} ${r.status}`); return r.json(); };
const esc = (x) => x.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
const child = async (parent, name, folder) => (await get("/files", { q: `${parent ? `'${parent}' in parents and ` : ""}name = '${esc(name)}' and trashed = false${folder ? " and mimeType = 'application/vnd.google-apps.folder'" : ""}`, fields: "files(id,name)", orderBy: folder ? "createdTime" : "modifiedTime desc" })).files[0];

const root = await child(null, s.remoteFolderName, true);
const filesF = await child(root.id, "files", true);
const mf = await child(root.id, ".obsidian-sync-manifest.json", false);
const manifest = await fetch(`${api}/files/${mf.id}?alt=media`, { headers: H }).then((r) => r.json());
const drive = {
  async listFilesChangedSince(since, cap = 2000) {
    const out = []; let pageToken;
    do {
      const a = await get("/files", { q: `modifiedTime > '${since}' and trashed = false and mimeType != 'application/vnd.google-apps.folder'`, fields: "nextPageToken,files(id,name,mimeType,parents,createdTime,modifiedTime,size,headRevisionId)", orderBy: "modifiedTime desc", pageSize: "200", ...(pageToken ? { pageToken } : {}) });
      out.push(...(a.files ?? [])); pageToken = a.nextPageToken;
    } while (pageToken && out.length < cap);
    return out;
  },
  getParentsInfo: (id) => get(`/files/${id}`, { fields: "id,name,parents" })
};
const known = new Set(Object.values(manifest.files).map((f) => f.driveFileId)); known.add(mf.id);
const ignored = (p) => T.ge(p, T.pe(s.ignoredPaths));
const maxBytes = 20 * 1048576;
console.log(`scope: ${data.auth.scope.split("/").pop()} | manifest entries: ${Object.keys(manifest.files).length} (deleted: ${Object.values(manifest.files).filter((f) => f.deleted).length})`);
for (const [label, since] of [["window 30 days (what 1.2.0 does)", T.st(data.lastExternalScanAt)], ["all time (worst case)", Date.parse("2000-01-01")]]) {
  const cands = await T.it(drive, new T.be(drive, filesF.id, root.id), since, known, ignored, T.dvsSkipAdopted(data.externalAdopted ?? {}));
  const pre = T.dvsPlanExternal(manifest, cands, data.externalAdopted ?? {}, maxBytes);
  const nNew = pre.plan.filter((p) => p.action === "new").length;
  console.log(`\n== ${label}: candidates ${cands.length}, would import ${pre.plan.length} (new ${nNew}, update ${pre.plan.length - nNew}); skipped ${JSON.stringify(T.dvsCountReasons(pre.skipped))}`);
  for (const p of pre.plan.slice(0, 15)) console.log(`  ${p.action} · ${p.path} · ${p.size} B · ${new Date(p.modifiedTime).toISOString().slice(0, 10)}`);
}
