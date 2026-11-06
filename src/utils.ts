import { TFile, TFolder, Vault, normalizePath } from "obsidian";

const TEXT_EXTENSIONS = new Set([
  "md",
  "txt",
  "json",
  "yaml",
  "yml",
  "csv",
  "tsv",
  "css",
  "js",
  "ts",
  "html",
  "xml",
  "svg",
  "canvas"
]);

export function sanitizeLogValue(value: unknown): string {
  if (typeof value === "string") return value.length > 96 ? `${value.slice(0, 96)}...` : value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function createLogger(enabled: () => boolean) {
  return (message: string, details?: unknown) => {
    if (!enabled()) return;
    if (details === undefined) {
      console.debug(`[Drive Vault Sync] ${message}`);
    } else {
      console.debug(`[Drive Vault Sync] ${message}`, sanitizeLogValue(details));
    }
  };
}

export function normalizeVaultPath(path: string): string {
  return normalizePath(path).replace(/^\/+/, "");
}

export function isIgnored(path: string, ignoredPatterns: string[]): boolean {
  const normalized = normalizeVaultPath(path);
  return ignoredPatterns.some((pattern) => {
    const clean = normalizeVaultPath(pattern.trim());
    if (!clean) return false;
    if (clean.endsWith("/")) return normalized.startsWith(clean);
    return normalized === clean || normalized.startsWith(`${clean}/`);
  });
}

export function ignoredPatternsFromSettings(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

export function getExtension(path: string): string {
  const last = path.split("/").pop() ?? "";
  const index = last.lastIndexOf(".");
  return index >= 0 ? last.slice(index + 1).toLowerCase() : "";
}

export function isLikelyText(path: string): boolean {
  return TEXT_EXTENSIONS.has(getExtension(path));
}

export async function sha256Hex(data: string | ArrayBuffer): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function byteSize(data: string | ArrayBuffer): number {
  return typeof data === "string" ? new TextEncoder().encode(data).byteLength : data.byteLength;
}

/** True for paths whose top-level segment starts with a dot (e.g. `.sync/...`). Obsidian's Vault API does not index these. */
export function isHiddenPath(path: string): boolean {
  return (normalizeVaultPath(path).split("/")[0] ?? "").startsWith(".");
}

async function ensureAdapterFolder(vault: Vault, path: string): Promise<void> {
  const parts = normalizeVaultPath(path).split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    try {
      if (!(await vault.adapter.exists(current))) await vault.adapter.mkdir(current);
    } catch {
      if (!(await vault.adapter.exists(current))) throw new Error(`Unable to create folder: ${current}`);
    }
  }
}

export async function ensureFolder(vault: Vault, path: string): Promise<void> {
  const normalized = normalizeVaultPath(path);
  if (!normalized) return;
  if (isHiddenPath(normalized)) {
    await ensureAdapterFolder(vault, normalized);
    return;
  }
  const parts = normalized.split("/");
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    const existing = vault.getAbstractFileByPath(current);
    if (existing instanceof TFolder) continue;
    if (existing) throw new Error(`Path collision: ${current} is a file, not a folder.`);
    try {
      await vault.createFolder(current);
    } catch (error) {
      if (vault.getAbstractFileByPath(current) instanceof TFolder) continue;
      throw error;
    }
  }
}

export function parentFolder(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

const MAX_WRITE_COLLISION_RETRIES = 5;

export async function writeVaultFile(vault: Vault, path: string, data: string | ArrayBuffer, depth = 0): Promise<void> {
  const normalized = normalizeVaultPath(path);
  if (isHiddenPath(normalized)) {
    const hiddenFolder = parentFolder(normalized);
    if (hiddenFolder) await ensureAdapterFolder(vault, hiddenFolder);
    if (typeof data === "string") await vault.adapter.write(normalized, data);
    else await vault.adapter.writeBinary(normalized, data);
    return;
  }
  if (depth >= MAX_WRITE_COLLISION_RETRIES) {
    throw new Error(`Drive Vault Sync: giving up writing "${path}" after ${depth} rename attempts`);
  }
  const folder = parentFolder(normalized);
  try {
    if (folder) await ensureFolder(vault, folder);
  } catch {
    await writeVaultFile(vault, safeCollisionPath(normalized), data, depth + 1);
    return;
  }
  const existing = vault.getAbstractFileByPath(normalized);
  if (existing instanceof TFile) {
    if (typeof data === "string") await vault.modify(existing, data);
    else await vault.modifyBinary(existing, data);
    return;
  }
  if (existing instanceof TFolder) {
    await writeVaultFile(vault, safeCollisionPath(normalized), data, depth + 1);
    return;
  }
  try {
    if (typeof data === "string") await vault.create(normalized, data);
    else await vault.createBinary(normalized, data);
  } catch (error) {
    const afterCreate = vault.getAbstractFileByPath(normalized);
    if (afterCreate instanceof TFile) {
      if (typeof data === "string") await vault.modify(afterCreate, data);
      else await vault.modifyBinary(afterCreate, data);
      return;
    }
    if (/already exists/i.test(error instanceof Error ? error.message : String(error))) {
      await writeVaultFile(vault, safeCollisionPath(normalized), data, depth + 1);
      return;
    }
    throw error;
  }
}

export function conflictPath(path: string, source: string): string {
  const date = new Date();
  const stamp = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}${String(date.getMinutes()).padStart(2, "0")}`;
  const slash = path.lastIndexOf("/");
  const folder = slash >= 0 ? `${path.slice(0, slash + 1)}` : "";
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return `${folder}${name} conflict ${stamp} ${source}`;
  return `${folder}${name.slice(0, dot)} conflict ${stamp} ${source}${name.slice(dot)}`;
}

export function deletedCopyPath(path: string): string {
  return conflictPath(path, "deleted");
}

const UNSAFE_FILENAME_CHARS = /[\\/:*?"<>|]/g;
const CONFLICT_SUFFIX = / \(conflict [0-9a-z]{4,8}\)/g;

/** Flat, short, collision-free path for a file that could not be written to its real location. */
export function safeCollisionPath(path: string): string {
  const date = new Date();
  const stamp = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}-${String(date.getHours()).padStart(2, "0")}-${String(date.getMinutes()).padStart(2, "0")}-${String(date.getSeconds()).padStart(2, "0")}`;
  const baseName = (normalizeVaultPath(path)
    .replace(/^\.sync\/(?:conflicts|backups)\/[^/]+\//, "")
    .split("/")
    .filter(Boolean)
    .pop() || "file")
    .replace(UNSAFE_FILENAME_CHARS, "_")
    .replace(CONFLICT_SUFFIX, "");
  const token = Math.random().toString(36).slice(2, 8);
  const dot = baseName.lastIndexOf(".");
  const name = dot > 0 ? `${baseName.slice(0, dot)} (conflict ${token})${baseName.slice(dot)}` : `${baseName} (conflict ${token})`;
  return `.sync/conflicts/${stamp}/${name}`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export function encodeQuery(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  return search.toString();
}

export function unique<T>(values: Iterable<T>): T[] {
  return Array.from(new Set(values));
}
