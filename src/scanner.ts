import { TFile, Vault } from "obsidian";
import { LocalFileMeta } from "./types";
import { byteSize, getExtension, ignoredPatternsFromSettings, isIgnored, isLikelyText, sha256Hex } from "./utils";

const DEFAULT_SCAN_CONCURRENCY = 6;

/** Last known (mtime, size, hash) for a path — lets scan() skip re-reading/re-hashing content that hasn't changed. */
export type ScanCacheEntry = { mtime: number; size: number; hash: string };

export type ScanOptions = {
  cache?: Record<string, ScanCacheEntry>;
  onProgress?: (scanned: number, total: number) => void;
};

export class LocalVaultScanner {
  constructor(private vault: Vault, private getIgnoredPaths: () => string, private concurrency = DEFAULT_SCAN_CONCURRENCY) {}

  async scan(options?: ScanOptions): Promise<Record<string, LocalFileMeta>> {
    const ignored = ignoredPatternsFromSettings(this.getIgnoredPaths());
    const files = this.vault.getFiles().filter((file) => !isIgnored(file.path, ignored));
    const result: Record<string, LocalFileMeta> = {};
    const total = files.length;
    let scanned = 0;
    options?.onProgress?.(0, total);
    let cursor = 0;
    const worker = async () => {
      while (cursor < files.length) {
        const file = files[cursor++];
        result[file.path] = await this.scanFile(file, options?.cache?.[file.path]);
        scanned += 1;
        options?.onProgress?.(scanned, total);
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, files.length) }, worker));
    return result;
  }

  async read(path: string, forceBinary = false): Promise<string | ArrayBuffer> {
    const file = this.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error(`Local file not found: ${path}`);
    if (!forceBinary && isLikelyText(path)) return this.vault.read(file);
    return this.vault.readBinary(file);
  }

  async readText(path: string): Promise<string> {
    const file = this.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error(`Local file not found: ${path}`);
    return this.vault.read(file);
  }

  private async scanFile(file: TFile, cached?: ScanCacheEntry): Promise<LocalFileMeta> {
    const isText = isLikelyText(file.path);
    if (cached && cached.mtime === file.stat.mtime && cached.size === file.stat.size) {
      return {
        path: file.path,
        hash: cached.hash,
        size: cached.size,
        extension: getExtension(file.path),
        mtime: file.stat.mtime,
        isText
      };
    }
    const content = isText ? await this.vault.read(file) : await this.vault.readBinary(file);
    return {
      path: file.path,
      hash: await sha256Hex(content),
      size: byteSize(content),
      extension: getExtension(file.path),
      mtime: file.stat.mtime,
      isText
    };
  }
}
