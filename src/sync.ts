import { App, Notice, TFile } from "obsidian";
import { GoogleDriveClient } from "./drive";
import { createLocalManifest, manifestFromIndex, updateRecordFromSync } from "./localManifest";
import { MergeEngine } from "./merge";
import { OfflineSyncQueue } from "./offlineQueue";
import { GoogleDriveProvider } from "./provider";
import { SyncProgressTracker } from "./progress";
import { LocalVaultScanner, ScanCacheEntry } from "./scanner";
import { BackupFileSource, BackupMode, ConflictPolicy, LocalFile, LocalFileMeta, LocalSyncManifest, PlannedDeletion, RemoteFile, RemoteFileMeta, RemoteManifest, RemoteSyncCommand, SyncIndexEntry, SyncProgressState, SyncQueueItem, SyncSummary } from "./types";
import { byteSize, conflictPath, deletedCopyPath, getExtension, isLikelyText, sha256Hex, unique, writeVaultFile } from "./utils";
import { LargeDeletionModal, showConflictNotice, showManualConflictModal, showRemoteDeleteConflictModal } from "./modals";

const MAX_SNAPSHOT_BYTES = 1024 * 1024;

export type SyncEngineOptions = {
  app: App;
  scanner: LocalVaultScanner;
  drive: GoogleDriveClient;
  provider: GoogleDriveProvider;
  offlineQueue: OfflineSyncQueue;
  getRemoteFolderName: () => string;
  getVaultId: () => string;
  getIndex: () => Record<string, SyncIndexEntry>;
  setIndex: (index: Record<string, SyncIndexEntry>) => Promise<void>;
  getLocalManifest: () => LocalSyncManifest | undefined;
  setLocalManifest: (manifest: LocalSyncManifest) => Promise<void>;
  getOfflineQueueItems: () => SyncQueueItem[];
  getMaxDeletionPercent: () => number;
  getConflictPolicy: () => ConflictPolicy;
  getDeviceId: () => string;
  getDeviceName: () => string;
  getAppliedCommandIds: () => string[];
  setAppliedCommandIds: (ids: string[]) => Promise<void>;
  getBackupEnabled: () => boolean;
  getBackupMode: () => BackupMode;
  getBackupIntervalMinutes: () => number;
  getMaxBackups: () => number;
  appendLog: (message: string, details?: unknown) => Promise<void>;
  onProgress?: (state: SyncProgressState) => void;
  /** Records per-file failures (and clears entries for paths that synced cleanly). */
  persistFailures?: (failures: TransferFailure[], attemptedPaths: string[], operation: string) => Promise<void>;
};

export type TransferFailure = { path: string; error: string };

type SyncCounters = {
  uploads: number;
  downloads: number;
  localDeletes: number;
  remoteDeletes: number;
  conflicts: number;
  errors: number;
};

export class SyncEngine {
  private running = false;
  private localWrites = new Set<string>();
  private mergeEngine = new MergeEngine();
  private progress = new SyncProgressTracker((state) => this.options.onProgress?.(state));

  constructor(private options: SyncEngineOptions) {}

  isRunning(): boolean {
    return this.running;
  }

  getProgress(): SyncProgressState {
    return this.progress.getState();
  }

  /** Paths this engine wrote or deleted locally since the last call, so vault events for them can be ignored. */
  consumeLocalWrites(): Set<string> {
    const written = this.localWrites;
    this.localWrites = new Set();
    return written;
  }

  private async writeLocal(path: string, content: string | ArrayBuffer): Promise<void> {
    this.localWrites.add(path);
    await writeVaultFile(this.options.app.vault, path, content);
  }

  async syncNow(manual = false): Promise<SyncSummary | undefined> {
    if (this.running) {
      if (manual) new Notice("Google Drive sync is already running.");
      return;
    }
    this.running = true;
    const startedAt = Date.now();
    const counters: SyncCounters = { uploads: 0, downloads: 0, localDeletes: 0, remoteDeletes: 0, conflicts: 0, errors: 0 };
    const changedPaths: string[] = [];
    const deletedPaths: string[] = [];
    const safetyBackupFiles: Record<string, BackupFileSource> = {};
    const routineBackupFiles: Record<string, BackupFileSource> = {};
    this.progress.begin("Sync");
    let runError: string | undefined;
    try {
      await this.log("sync-engine-start", { manual });
      this.progress.setStage("remote", "Reading the cloud index from Google Drive…");
      await this.options.provider.prepare();
      await this.drainOfflineQueue();
      const local = await this.options.scanner.scan({
        cache: this.buildScanCache(),
        onProgress: (scanned, total) => this.progress.setScanProgress(scanned, total)
      });
      this.progress.setStage("planning", "Comparing this vault with the cloud…");
      const state = this.options.provider.getState();
      const remoteChanges = await this.options.provider.listChanges();
      await this.log("sync-engine-state-loaded", {
        localCount: Object.keys(local).length,
        remoteCount: Object.keys(state.manifest.files).length,
        remoteChangeCount: remoteChanges.length
      });
      const commandSummary = await this.applyRemoteCommandIfNeeded(state, local, counters);
      if (commandSummary) return commandSummary;
      const captureRoutineBackups = this.shouldCaptureRoutineBackups(state.manifest);
      const index = { ...this.options.getIndex() };
      const localManifest = this.currentLocalManifest(index);
      await this.applyLocalRenames(local, state.manifest, index, localManifest, counters);
      const paths = unique([...Object.keys(local), ...remoteChanges.map((change) => change.path), ...Object.keys(index), ...Object.keys(localManifest.records)]);
      await this.log("sync-engine-paths-planned", { pathCount: paths.length });
      const deletionPlan = this.planDeletions(paths, local, state.manifest, index, localManifest);
      if (deletionPlan.length > 0) await this.log("sync-engine-deletion-plan", { count: deletionPlan.length });
      const deletionPlanPaths = new Set(deletionPlan.map((item) => item.path));
      this.progress.growTotalBy(this.estimateTransferCount(paths, local, state.manifest, index, localManifest, deletionPlanPaths));
      if (deletionPlan.length > 5) this.progress.setDetail("Waiting for you to review the planned deletions…");
      const allowedDeletions = await this.reviewLargeDeletionPlan(deletionPlan, Object.keys(index).length);
      if (allowedDeletions === null) {
        new Notice("Google Drive sync cancelled.");
        return;
      }
      const allowedDeletionKeys = new Set(allowedDeletions.map((item) => `${item.direction}:${item.path}`));

      const failures: TransferFailure[] = [];
      const plannedTotal = this.progress.getState().total;
      this.progress.setStage("transferring", plannedTotal > 0 ? "Transferring files…" : "Everything is already in sync", plannedTotal);
      for (const path of paths) {
        try {
          const localMeta = local[path];
          const remoteMeta = state.manifest.files[path];
          const entry = index[path];
          const record = localManifest.records[path];
          const lastLocalHash = record?.lastKnownLocalHash ?? entry?.lastSyncedHash ?? null;
          const lastRemoteHash = record?.lastKnownRemoteHash ?? entry?.lastSyncedHash ?? null;
          const baseHash = lastLocalHash ?? lastRemoteHash ?? null;

          if (localMeta && remoteMeta && !remoteMeta.deleted && localMeta.hash === baseHash && remoteMeta.hash === baseHash) {
            // In sync, but an older sync may have left the entry flagged as deleted: clear the stale flag.
            if (entry?.deleted || record?.deleted) {
              index[path] = { ...entry, path, lastSyncedHash: localMeta.hash, deleted: false };
              updateRecordFromSync(localManifest.records, path, localMeta, remoteMeta, this.options.getDeviceId(), false);
            }
            continue;
          }

          if (!localMeta && !remoteMeta) {
            // Nothing exists on either side (the cloud no longer even has a tombstone): forget the stale entry.
            await this.log("sync-engine-stale-entry-pruned", { path });
            delete index[path];
            delete localManifest.records[path];
            continue;
          }

          if (localMeta && remoteMeta && !remoteMeta.deleted && localMeta.hash !== baseHash && remoteMeta.hash === baseHash) {
            changedPaths.push(path);
            if (captureRoutineBackups) await this.captureRemoteBackupVisible(routineBackupFiles, path, remoteMeta);
            await this.uploadLocal(path, localMeta, state.filesFolderId, state.manifest, index, counters, localManifest);
            continue;
          }

          if (localMeta && remoteMeta && !remoteMeta.deleted && localMeta.hash === baseHash && remoteMeta.hash !== baseHash) {
            changedPaths.push(path);
            await this.captureLocalBackup(safetyBackupFiles, path, localMeta);
            await this.downloadRemote(path, remoteMeta, index, counters, localManifest);
            continue;
          }

          if (localMeta && remoteMeta?.deleted && (baseHash === null || entry?.deleted || record?.deleted)) {
            changedPaths.push(path);
            await this.log("sync-engine-remote-deleted-local-recreated", { path, baseHash, indexDeleted: entry?.deleted, recordDeleted: record?.deleted });
            await this.uploadLocal(path, localMeta, state.filesFolderId, state.manifest, index, counters, localManifest);
            continue;
          }

          if (localMeta && remoteMeta?.deleted && baseHash !== null && localMeta.hash !== baseHash) {
            changedPaths.push(path);
            await this.log("sync-engine-delete-conflict-detected", {
              path,
              localHash: localMeta.hash,
              baseHash,
              deletedBy: remoteMeta.deviceName ?? remoteMeta.deviceId,
              deletedAt: remoteMeta.deletedAt ?? remoteMeta.updatedAt
            });
            const choice = await showRemoteDeleteConflictModal(
              this.options.app,
              path,
              remoteMeta.deviceName ?? remoteMeta.deviceId ?? "another device",
              remoteMeta.deletedAt ?? remoteMeta.updatedAt ?? null
            );
            if (choice === "keep-local") {
              await this.log("sync-engine-delete-conflict-keep-local", { path });
              await this.uploadLocal(path, localMeta, state.filesFolderId, state.manifest, index, counters, localManifest);
              continue;
            }
            if (choice === "delete-local") {
              await this.log("sync-engine-delete-conflict-delete-local", { path });
              deletedPaths.push(path);
              await this.captureLocalBackup(safetyBackupFiles, path, localMeta);
              await this.safeLocalDelete(path, index, counters, localManifest);
              continue;
            }
            await this.log("sync-engine-delete-conflict-cancelled", { path });
            this.progress.note(path, "conflict", "skipped", "Deleted on another device — skipped for now");
            counters.conflicts += 1;
            continue;
          }

          if (localMeta && remoteMeta?.deleted && localMeta.hash === baseHash) {
            if (allowedDeletionKeys.has(`local:${path}`)) {
              deletedPaths.push(path);
              await this.captureLocalBackup(safetyBackupFiles, path, localMeta);
              await this.safeLocalDelete(path, index, counters, localManifest);
              continue;
            }
            // The user skipped this deletion in the review dialog: leave the file alone for now.
            if (deletionPlanPaths.has(path)) continue;
            // A tombstone that was never part of a deletion plan is stale; the local file wins.
            await this.log("sync-engine-stale-tombstone-local-reupload", { path, baseHash });
            changedPaths.push(path);
            await this.uploadLocal(path, localMeta, state.filesFolderId, state.manifest, index, counters, localManifest);
            continue;
          }

          if (!localMeta && remoteMeta && !remoteMeta.deleted && remoteMeta.hash === baseHash) {
            if (allowedDeletionKeys.has(`remote:${path}`)) {
              deletedPaths.push(path);
              await this.captureRemoteBackupVisible(safetyBackupFiles, path, remoteMeta);
              await this.tombstoneRemote(path, state.manifest, index, counters, localManifest);
            }
            continue;
          }

          if (!localMeta && remoteMeta?.deleted) {
            index[path] = { ...(entry ?? this.emptyEntry(path)), deleted: true };
            updateRecordFromSync(localManifest.records, path, undefined, remoteMeta, this.options.getDeviceId(), true);
            continue;
          }

          if (!localMeta && remoteMeta && !remoteMeta.deleted) {
            changedPaths.push(path);
            await this.downloadRemote(path, remoteMeta, index, counters, localManifest);
            continue;
          }

          if (localMeta && (!remoteMeta || remoteMeta.deleted)) {
            changedPaths.push(path);
            if (entry?.deleted) await this.log("sync-engine-local-recreated-after-index-delete", { path, baseHash });
            await this.uploadLocal(path, localMeta, state.filesFolderId, state.manifest, index, counters, localManifest);
            continue;
          }

          if (localMeta && remoteMeta && !remoteMeta.deleted && localMeta.hash !== baseHash && remoteMeta.hash !== baseHash) {
            changedPaths.push(path);
            await this.log("sync-engine-conflict-detected", {
              path,
              localHash: localMeta.hash,
              remoteHash: remoteMeta.hash,
              baseHash,
              manual
            });
            const resolved = await this.resolveConflict(path, localMeta, remoteMeta, state.filesFolderId, state.manifest, index, counters, safetyBackupFiles, localManifest, manual);
            await this.log("sync-engine-conflict-resolved", { path, resolved });
            if (!resolved) {
              counters.conflicts += 1;
              this.progress.note(path, "conflict", "skipped", "Changed on both sides — skipped for now");
            }
          }
        } catch (error) {
          // One broken file must not abort the whole sync.
          counters.errors += 1;
          const message = error instanceof Error ? error.message : String(error);
          failures.push({ path, error: message });
          this.progress.fail(path, message, local[path] ? "upload" : "download");
          await this.log("sync-engine-path-failed", { path, error: message });
        }
      }

      const backupFiles = this.backupFilesForSync(safetyBackupFiles, routineBackupFiles);
      if (this.options.getBackupEnabled() && (Object.keys(backupFiles).length > 0 || deletedPaths.length > 0)) {
        try {
          this.progress.setStage("backup", "Saving a backup copy to Google Drive…");
          this.progress.growTotalBy(Object.keys(backupFiles).length);
          await this.options.drive.createBackup(
            state, backupFiles, deletedPaths, this.options.getDeviceId(), this.options.getDeviceName(), this.options.getMaxBackups(),
            (path) => this.progress.markDone(path, "backup")
          );
        } catch (error) {
          // Backup failure must not abort sync.
          await this.log("sync-engine-backup-failed", { error: error instanceof Error ? error.message : String(error) });
        }
      }
      // Persist the local baseline first: if saving the remote manifest fails, the next sync
      // still knows what was transferred and simply retries the manifest write.
      this.progress.setStage("saving", "Saving the sync index…");
      await this.options.setIndex(index);
      localManifest.updatedAt = Date.now();
      await this.options.setLocalManifest(localManifest);
      try {
        await this.options.provider.save();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.log("sync-engine-manifest-save-failed", { error: message });
        new Notice(`Google Drive sync: the remote index could not be saved (${message}). Local changes are kept and the next sync will retry.`, 0);
        throw error;
      }
      await this.log("sync-engine-finished", {
        uploads: counters.uploads,
        downloads: counters.downloads,
        localDeletes: counters.localDeletes,
        remoteDeletes: counters.remoteDeletes,
        conflicts: counters.conflicts,
        errors: counters.errors
      });
      showConflictNotice(counters.conflicts);
      if (manual) new Notice("Google Drive sync complete.");
      await this.reportFailedTransfers(failures, "sync-engine-summary-failures");
      await this.options.persistFailures?.(failures, paths, "sync");
      return this.summary(startedAt, counters);
    } catch (error) {
      runError = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      this.running = false;
      this.progress.end(runError);
    }
  }

  /** Best-effort estimate of how many files will be uploaded/downloaded, used only to size the progress bar. */
  private estimateTransferCount(
    paths: string[],
    local: Record<string, LocalFileMeta>,
    manifest: RemoteManifest,
    index: Record<string, SyncIndexEntry>,
    localManifest: LocalSyncManifest,
    deletionPlanPaths: Set<string>
  ): number {
    let count = 0;
    for (const path of paths) {
      if (deletionPlanPaths.has(path)) continue;
      const localMeta = local[path];
      const remoteMeta = manifest.files[path];
      const record = localManifest.records[path];
      const entry = index[path];
      const lastLocalHash = record?.lastKnownLocalHash ?? entry?.lastSyncedHash ?? null;
      const lastRemoteHash = record?.lastKnownRemoteHash ?? entry?.lastSyncedHash ?? null;
      const baseHash = lastLocalHash ?? lastRemoteHash ?? null;
      const inSync = localMeta && remoteMeta && !remoteMeta.deleted && localMeta.hash === baseHash && remoteMeta.hash === baseHash;
      // Nothing to transfer when the file is gone locally and the cloud has no live copy of it.
      const nothingToTransfer = !localMeta && (!remoteMeta || remoteMeta.deleted);
      if (!inSync && !nothingToTransfer) count += 1;
    }
    return count;
  }

  private async log(message: string, details?: unknown): Promise<void> {
    await this.options.appendLog(message, details);
  }

  private async reportFailedTransfers(failures: TransferFailure[], logEvent: string): Promise<void> {
    if (failures.length === 0) return;
    await this.log(logEvent, { count: failures.length, files: failures });
    const shown = failures.slice(0, 8).map((item) => `• ${item.path}: ${item.error}`).join("\n");
    const more = failures.length > 8 ? `\n…and ${failures.length - 8} more (see the failed files list)` : "";
    new Notice(`Google Drive sync: ${failures.length} file${failures.length === 1 ? "" : "s"} failed to transfer:\n${shown}${more}`, 0);
  }

  async resetCloudFromLocal(): Promise<SyncSummary> {
    if (this.running) throw new Error("Google Drive sync is already running.");
    this.running = true;
    const startedAt = Date.now();
    const counters: SyncCounters = { uploads: 0, downloads: 0, localDeletes: 0, remoteDeletes: 0, conflicts: 0, errors: 0 };
    this.progress.begin("Replace the cloud copy with this vault", ["scanning", "remote", "backup", "transferring", "saving"]);
    let runError: string | undefined;
    try {
      const local = await this.options.scanner.scan({
        cache: this.buildScanCache(),
        onProgress: (scanned, total) => this.progress.setScanProgress(scanned, total)
      });
      this.progress.setStage("remote", "Reading the cloud index from Google Drive…");
      this.progress.growTotalBy(Object.keys(local).length);
      const state = await this.options.provider.prepare();
      this.progress.setDetail("Saving a snapshot of the current cloud index…");
      await this.options.drive.createManifestSnapshot(state, this.options.getDeviceId(), this.options.getDeviceName());
      if (this.options.getBackupEnabled()) {
        try {
          const backupFiles: Record<string, BackupFileSource> = {};
          const activeRemotes = Object.values(state.manifest.files).filter((remote) => !remote.deleted);
          this.progress.setStage("backup", "Backing up the current cloud files before replacing them…");
          this.progress.growTotalBy(activeRemotes.length * 2);
          for (const remote of activeRemotes) {
            this.progress.start(remote.path, "backup", "Downloading the cloud version");
            await this.captureRemoteBackup(backupFiles, remote.path, remote);
            this.progress.finish(remote.path);
          }
          await this.options.drive.createBackup(
            state, backupFiles, [], this.options.getDeviceId(), this.options.getDeviceName(), this.options.getMaxBackups(),
            (path) => this.progress.markDone(path, "backup")
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await this.log("reset-cloud-from-local-backup-failed", { error: message });
          new Notice(`Google Drive sync: pre-reset backup failed and was skipped (${message}).`, 10000);
        }
      }
      const toTrash = Object.values(state.manifest.files).filter((remote) => !remote.deleted);
      this.progress.setStage("transferring", "Moving old cloud files to Google Drive trash…");
      this.progress.growTotalBy(toTrash.length);
      for (const remote of toTrash) {
        this.progress.start(remote.path, "delete-remote");
        try {
          await this.options.drive.trashFile(remote.driveFileId);
        } catch (error) {
          this.progress.finish(remote.path, "error", error instanceof Error ? error.message : String(error));
          throw error;
        }
        this.progress.finish(remote.path);
        counters.remoteDeletes += 1;
      }
      if (state.manifestFileId) {
        await this.options.drive.trashFile(state.manifestFileId);
        state.manifestFileId = undefined;
      }
      const command = this.createCommand();
      state.manifest = {
        version: 1,
        vaultId: this.options.getVaultId(),
        updatedAt: Date.now(),
        files: {},
        command,
        snapshots: state.manifest.snapshots ?? []
      };
      const index: Record<string, SyncIndexEntry> = {};
      const failures: TransferFailure[] = [];
      this.progress.setDetail("Uploading this vault…");
      for (const path of Object.keys(local)) {
        try {
          await this.uploadLocal(path, local[path], state.filesFolderId, state.manifest, index, counters);
        } catch (error) {
          counters.errors += 1;
          const message = error instanceof Error ? error.message : String(error);
          failures.push({ path, error: message });
          this.progress.fail(path, message, "upload");
          await this.log("reset-cloud-from-local-upload-failed", { path, error: message });
        }
      }
      this.progress.setStage("saving", "Saving the new cloud index…");
      await this.options.setIndex(index);
      await this.options.drive.saveManifest(state);
      await this.markCommandApplied(command.id);
      new Notice("Google Drive was reset from this vault.");
      await this.reportFailedTransfers(failures, "reset-cloud-from-local-summary");
      await this.options.persistFailures?.(failures, Object.keys(local), "reset-cloud-from-local");
      return this.summary(startedAt, counters, "reset-cloud-from-local");
    } catch (error) {
      runError = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      this.running = false;
      this.progress.end(runError);
    }
  }

  async resetLocalFromCloud(keepLocalPaths: string[]): Promise<SyncSummary> {
    if (this.running) throw new Error("Google Drive sync is already running.");
    this.running = true;
    const startedAt = Date.now();
    const counters: SyncCounters = { uploads: 0, downloads: 0, localDeletes: 0, remoteDeletes: 0, conflicts: 0, errors: 0 };
    this.progress.begin("Replace this vault with the cloud copy", ["scanning", "remote", "backup", "transferring", "saving"]);
    let runError: string | undefined;
    try {
      const local = await this.options.scanner.scan({
        cache: this.buildScanCache(),
        onProgress: (scanned, total) => this.progress.setScanProgress(scanned, total)
      });
      this.progress.setStage("remote", "Reading the cloud index from Google Drive…");
      const state = await this.options.provider.prepare();
      const remoteActiveCount = Object.values(state.manifest.files).filter((remote) => !remote.deleted).length;
      this.progress.growTotalBy(remoteActiveCount + keepLocalPaths.length);
      const keep = new Set(keepLocalPaths);
      if (this.options.getBackupEnabled()) {
        // Only back up local files that the reset would actually overwrite or delete.
        const atRisk = Object.entries(local).filter(([path, meta]) => {
          const remote = state.manifest.files[path];
          if (!remote || remote.deleted) return !keep.has(path);
          return remote.hash !== meta.hash;
        });
        if (atRisk.length > 0) {
          try {
            const backupFiles: Record<string, BackupFileSource> = {};
            this.progress.setStage("backup", "Backing up local files that will be overwritten…");
            this.progress.growTotalBy(atRisk.length * 2);
            for (const [path, meta] of atRisk) {
              this.progress.start(path, "backup", "Reading the local version");
              await this.captureLocalBackup(backupFiles, path, meta);
              this.progress.finish(path);
            }
            await this.options.drive.createBackup(
              state, backupFiles, [], this.options.getDeviceId(), this.options.getDeviceName(), this.options.getMaxBackups(),
              (path) => this.progress.markDone(path, "backup")
            );
            await this.options.drive.saveManifest(state); // persist backup metadata before local reset
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await this.log("reset-local-from-cloud-backup-failed", { error: message });
            new Notice(`Google Drive sync: pre-download backup failed and was skipped (${message}).`, 10000);
          }
        }
      }
      const index: Record<string, SyncIndexEntry> = {};
      const failures: TransferFailure[] = [];
      const localOnly = Object.keys(local).filter((path) => {
        const remote = state.manifest.files[path];
        return (!remote || remote.deleted) && !keep.has(path);
      });
      this.progress.setStage("transferring", "Downloading the cloud copy…");
      this.progress.growTotalBy(localOnly.length);
      for (const path of localOnly) await this.safeLocalDelete(path, index, counters);
      for (const remote of Object.values(state.manifest.files)) {
        if (remote.deleted) continue;
        try {
          await this.downloadRemote(remote.path, remote, index, counters);
        } catch (error) {
          counters.errors += 1;
          const message = error instanceof Error ? error.message : String(error);
          failures.push({ path: remote.path, error: message });
          this.progress.fail(remote.path, message, "download");
          await this.log("reset-local-from-cloud-download-failed", { path: remote.path, error: message });
        }
      }
      if (keep.size > 0) {
        this.progress.setDetail("Uploading the local-only files you chose to keep…");
        const afterDownload = await this.options.scanner.scan();
        for (const path of keep) {
          const meta = afterDownload[path];
          if (meta) await this.uploadLocal(path, meta, state.filesFolderId, state.manifest, index, counters);
        }
      }
      this.progress.setStage("saving", "Saving the sync index…");
      await this.options.drive.saveManifest(state);
      await this.options.setIndex(index);
      new Notice("This vault was reset from Google Drive.");
      await this.reportFailedTransfers(failures, "reset-local-from-cloud-summary");
      await this.options.persistFailures?.(
        failures,
        [...Object.values(state.manifest.files).filter((remote) => !remote.deleted).map((remote) => remote.path), ...keepLocalPaths],
        "reset-local-from-cloud"
      );
      return this.summary(startedAt, counters, "reset-local-from-cloud");
    } catch (error) {
      runError = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      this.running = false;
      this.progress.end(runError);
    }
  }

  async listLocalOnlyPaths(): Promise<string[]> {
    this.progress.begin("Find files that exist only on this device", ["scanning", "remote"]);
    let runError: string | undefined;
    try {
      const local = await this.options.scanner.scan({
        cache: this.buildScanCache(),
        onProgress: (scanned, total) => this.progress.setScanProgress(scanned, total)
      });
      this.progress.setStage("remote", "Reading the cloud index from Google Drive…");
      const state = await this.options.drive.loadRemoteState(this.options.getRemoteFolderName(), this.options.getVaultId());
      return Object.keys(local).filter((path) => {
        const remote = state.manifest.files[path];
        return !remote || remote.deleted;
      }).sort();
    } catch (error) {
      runError = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      this.progress.end(runError);
    }
  }

  async createManualBackup(label: string): Promise<void> {
    if (this.running) throw new Error("Google Drive sync is already running.");
    this.running = true;
    this.progress.begin(`Manual backup “${label}”`, ["scanning", "remote", "backup", "saving"]);
    let runError: string | undefined;
    try {
      const local = await this.options.scanner.scan({
        cache: this.buildScanCache(),
        onProgress: (scanned, total) => this.progress.setScanProgress(scanned, total)
      });
      this.progress.setStage("remote", "Reading the cloud index from Google Drive…");
      const state = await this.options.drive.loadRemoteState(this.options.getRemoteFolderName(), this.options.getVaultId());
      const backupFiles: Record<string, BackupFileSource> = {};
      this.progress.setStage("backup", "Uploading a full copy of this vault…");
      this.progress.growTotalBy(Object.keys(local).length);
      for (const [path, meta] of Object.entries(local)) {
        await this.captureLocalBackup(backupFiles, path, meta);
      }
      await this.options.drive.createManualBackup(
        state,
        backupFiles,
        label,
        this.options.getDeviceId(),
        this.options.getDeviceName(),
        (path) => this.progress.markDone(path, "backup")
      );
      this.progress.setStage("saving", "Saving the backup list…");
      await this.options.drive.saveManifest(state);
    } catch (error) {
      runError = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      this.running = false;
      this.progress.end(runError);
    }
  }

  async restoreFromBackup(backupFileId: string): Promise<void> {
    if (this.running) throw new Error("Google Drive sync is already running.");
    this.running = true;
    this.progress.begin("Restore from backup", ["remote", "transferring", "saving"]);
    let runError: string | undefined;
    try {
      this.progress.setStage("remote", "Reading the backup contents…");
      const data = await this.options.drive.loadBackupData(backupFileId);
      const entries = Object.entries(data.changedFiles);
      this.progress.setStage("transferring", "Restoring files…");
      this.progress.growTotalBy(entries.length);
      for (const [path, entry] of entries) {
        this.progress.start(path, "download", "From backup");
        try {
          const content = await this.options.drive.downloadFile(entry.driveFileId);
          await this.writeLocal(path, isLikelyText(path) ? new TextDecoder().decode(content) : content);
        } catch (error) {
          this.progress.finish(path, "error", error instanceof Error ? error.message : String(error));
          throw error;
        }
        this.progress.finish(path);
      }
      this.progress.setStage("saving", "Resetting the sync baseline…");
      await this.options.setIndex({});
    } catch (error) {
      runError = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      this.running = false;
      this.progress.end(runError);
    }
  }

  async restoreFileFromBackup(backupFileId: string, path: string): Promise<void> {
    if (this.running) throw new Error("Google Drive sync is already running.");
    this.running = true;
    this.progress.begin("Restore one file from backup", ["remote", "transferring"]);
    let runError: string | undefined;
    try {
      const data = await this.options.drive.loadBackupData(backupFileId);
      const entry = data.changedFiles[path];
      if (!entry) throw new Error("This file is not available in the selected backup.");
      this.progress.setStage("transferring", "Restoring the file…", 1);
      this.progress.start(path, "download", "From backup");
      const content = await this.options.drive.downloadFile(entry.driveFileId);
      await this.writeLocal(path, isLikelyText(path) ? new TextDecoder().decode(content) : content);
      this.progress.finish(path);
      // Only this path needs re-checking; keep the rest of the baseline intact.
      const index = { ...this.options.getIndex() };
      delete index[path];
      await this.options.setIndex(index);
    } catch (error) {
      runError = error instanceof Error ? error.message : String(error);
      this.progress.fail(path, runError, "download");
      throw error;
    } finally {
      this.running = false;
      this.progress.end(runError);
    }
  }

  private backupFilesForSync(
    safetyFiles: Record<string, BackupFileSource>,
    routineFiles: Record<string, BackupFileSource>
  ): Record<string, BackupFileSource> {
    const safetyCount = Object.keys(safetyFiles).length;
    const routineCount = Object.keys(routineFiles).length;
    if (routineCount === 0) return safetyFiles;

    const mode = this.options.getBackupMode();
    if (mode === "safety-only" && safetyCount === 0) return {};
    if (mode === "safety-only") return safetyFiles;
    if (mode === "timed" && safetyCount > 0) return { ...routineFiles, ...safetyFiles };
    return { ...routineFiles, ...safetyFiles };
  }

  /** Builds a (mtime, size) -> hash cache from the last known local state, so scan() can skip unchanged files. */
  private buildScanCache(): Record<string, ScanCacheEntry> {
    const manifest = this.options.getLocalManifest();
    const cache: Record<string, ScanCacheEntry> = {};
    if (!manifest) return cache;
    for (const record of Object.values(manifest.records)) {
      if (record.deleted) continue;
      if (record.lastLocalModified == null || record.lastLocalSize == null || record.lastKnownLocalHash == null) continue;
      cache[record.path] = { mtime: record.lastLocalModified, size: record.lastLocalSize, hash: record.lastKnownLocalHash };
    }
    return cache;
  }

  private currentLocalManifest(index: Record<string, SyncIndexEntry>): LocalSyncManifest {
    const existing = this.options.getLocalManifest();
    if (existing?.version === 1) {
      return {
        ...existing,
        records: { ...existing.records }
      };
    }
    const migrated = Object.keys(index).length > 0
      ? manifestFromIndex(index, this.options.getDeviceId())
      : createLocalManifest(this.options.getDeviceId());
    return migrated;
  }

  private async drainOfflineQueue(): Promise<void> {
    const items = this.options.offlineQueue.items();
    if (items.length === 0) return;
    this.progress.setDetail(`Sending ${items.length} change${items.length === 1 ? "" : "s"} saved while offline…`);
    for (const item of items) {
      if (item.type === "upload") {
        const localMeta = (await this.options.scanner.scan())[item.path];
        if (!localMeta) {
          await this.options.offlineQueue.remove(item.id);
          continue;
        }
        const content = await this.options.scanner.read(item.path, !localMeta.isText);
        this.progress.start(item.path, "upload", "Queued while offline");
        try {
          await this.options.provider.upload({ ...localMeta, content });
        } catch (error) {
          this.progress.finish(item.path, "error", error instanceof Error ? error.message : String(error));
          throw error;
        }
        this.progress.finish(item.path);
        await this.options.offlineQueue.remove(item.id);
      } else if (item.type === "delete") {
        await this.options.provider.delete(item.path);
        this.progress.markDone(item.path, "delete-remote", "Queued while offline");
        await this.options.offlineQueue.remove(item.id);
      } else {
        await this.options.offlineQueue.remove(item.id);
      }
    }
  }

  private shouldCaptureRoutineBackups(manifest: RemoteManifest): boolean {
    const mode = this.options.getBackupMode();
    if (mode === "every-sync") return true;
    if (mode === "safety-only") return false;
    const intervalMs = Math.max(1, this.options.getBackupIntervalMinutes()) * 60 * 1000;
    const latestBackupAt = Math.max(0, ...(manifest.backups ?? []).map((backup) => backup.createdAt));
    return latestBackupAt === 0 || Date.now() - latestBackupAt >= intervalMs;
  }

  private async captureLocalBackup(files: Record<string, BackupFileSource>, path: string, meta: LocalFileMeta): Promise<void> {
    if (files[path]) return;
    const file = this.options.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;
    const isText = meta.isText && isLikelyText(path);
    const content = isText ? await this.options.app.vault.read(file) : await this.options.app.vault.readBinary(file);
    files[path] = {
      driveFileId: "",
      hash: meta.hash,
      size: meta.size,
      mtime: meta.mtime,
      content,
      mimeType: this.mimeTypeFor(path, isText)
    };
  }

  private async captureRemoteBackup(files: Record<string, BackupFileSource>, path: string, meta: RemoteFileMeta): Promise<void> {
    if (files[path]) return;
    const content = await this.options.drive.downloadFile(meta.driveFileId);
    this.captureRemoteBackupContent(files, path, meta, content);
  }

  /** Same as captureRemoteBackup, but shown in the progress window (used inside the main sync loop). */
  private async captureRemoteBackupVisible(files: Record<string, BackupFileSource>, path: string, meta: RemoteFileMeta): Promise<void> {
    if (files[path]) return;
    this.progress.start(path, "backup", "Keeping the cloud version before overwriting it");
    try {
      await this.captureRemoteBackup(files, path, meta);
    } catch (error) {
      this.progress.finish(path, "error", error instanceof Error ? error.message : String(error));
      throw error;
    }
    this.progress.finish(path);
  }

  private captureRemoteBackupContent(files: Record<string, BackupFileSource>, path: string, meta: RemoteFileMeta, content: ArrayBuffer): void {
    if (files[path]) return;
    files[path] = {
      driveFileId: "",
      hash: meta.hash,
      size: meta.size,
      mtime: meta.mtime,
      content,
      mimeType: this.mimeTypeFor(path, isLikelyText(path))
    };
  }

  private async captureConflictBackup(path: string, localMeta: LocalFileMeta, remoteMeta: RemoteFileMeta, remoteData: ArrayBuffer): Promise<void> {
    try {
      await this.writeConflictBackup(path, localMeta, remoteMeta, remoteData);
    } catch (error) {
      // A diagnostic copy is nice-to-have; never let it block conflict resolution.
      await this.log("sync-engine-conflict-backup-failed", { path, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private async writeConflictBackup(path: string, localMeta: LocalFileMeta, remoteMeta: RemoteFileMeta, remoteData: ArrayBuffer): Promise<void> {
    const stamp = timestampPath(new Date());
    const backupRoot = conflictBackupRoot(stamp, path);
    const entry = this.options.getIndex()[path];
    if (entry?.baseSnapshot !== undefined) {
      await this.writeLocal(`${backupRoot}/base.md`, entry.baseSnapshot);
    }
    const localFile = this.options.app.vault.getAbstractFileByPath(path);
    if (localFile instanceof TFile) {
      const localContent = localMeta.isText ? await this.options.app.vault.read(localFile) : await this.options.app.vault.readBinary(localFile);
      await this.writeLocal(`${backupRoot}/local${localMeta.isText ? ".md" : ".bin"}`, localContent);
    }
    await this.writeLocal(`${backupRoot}/remote${isLikelyText(path) ? ".md" : ".bin"}`, isLikelyText(path) ? new TextDecoder().decode(remoteData) : remoteData);
    await this.writeLocal(
      `${backupRoot}/metadata.json`,
      JSON.stringify({
        path,
        remoteDevice: remoteMeta.deviceName ?? remoteMeta.deviceId ?? null,
        remoteModified: remoteMeta.mtime ?? remoteMeta.updatedAt ?? null,
        createdAt: Date.now()
      }, null, 2)
    );
  }

  private mimeTypeFor(path: string, isText: boolean): string {
    if (!isText) return "application/octet-stream";
    if (path.toLowerCase().endsWith(".md")) return "text/markdown; charset=utf-8";
    return "text/plain; charset=utf-8";
  }

  private planDeletions(
    paths: string[],
    local: Record<string, LocalFileMeta>,
    manifest: RemoteManifest,
    index: Record<string, SyncIndexEntry>,
    localManifest: LocalSyncManifest
  ): PlannedDeletion[] {
    const plan: PlannedDeletion[] = [];
    for (const path of paths) {
      const localMeta = local[path];
      const remoteMeta = manifest.files[path];
      const record = localManifest.records[path];
      const entry = index[path];
      const lastHash = record?.lastKnownRemoteHash ?? entry?.lastSyncedHash;
      if (!localMeta && remoteMeta && !remoteMeta.deleted && remoteMeta.hash === lastHash) {
        plan.push({ path, direction: "remote" });
      }
      // A file this device already knew as deleted but which exists again is re-uploaded by the sync
      // loop ("recreated"), so it must not be planned (or counted) as a local deletion.
      const baseHash = record?.lastKnownLocalHash ?? record?.lastKnownRemoteHash ?? entry?.lastSyncedHash ?? null;
      const recreated = baseHash === null || entry?.deleted || record?.deleted;
      if (localMeta && remoteMeta?.deleted && localMeta.hash === lastHash && !recreated) {
        plan.push({ path, direction: "local" });
      }
    }
    return plan;
  }

  private async reviewLargeDeletionPlan(plan: PlannedDeletion[], knownSyncedCount: number): Promise<PlannedDeletion[] | null> {
    if (plan.length === 0) return [];
    if (plan.length <= 5) return plan;
    const percent = knownSyncedCount === 0 ? 0 : (plan.length / knownSyncedCount) * 100;
    if (percent <= this.options.getMaxDeletionPercent()) return plan;
    return new Promise((resolve) => {
      new LargeDeletionModal(this.options.app, plan, percent, resolve).open();
    });
  }

  private async applyLocalRenames(
    local: Record<string, LocalFileMeta>,
    manifest: RemoteManifest,
    index: Record<string, SyncIndexEntry>,
    localManifest: LocalSyncManifest,
    counters: SyncCounters
  ): Promise<void> {
    const missingRemoteByHash = new Map<string, RemoteFileMeta[]>();
    for (const [oldPath, remote] of Object.entries(manifest.files)) {
      if (local[oldPath] || remote.deleted) continue;
      const oldIndex = index[oldPath];
      const record = localManifest.records[oldPath];
      const baseHash = record?.lastKnownRemoteHash ?? oldIndex?.lastSyncedHash ?? null;
      if (baseHash !== remote.hash) continue;
      const bucket = missingRemoteByHash.get(remote.hash) ?? [];
      bucket.push(remote);
      missingRemoteByHash.set(remote.hash, bucket);
    }

    for (const [newPath, localMeta] of Object.entries(local)) {
      if (manifest.files[newPath] && !manifest.files[newPath].deleted) continue;
      const candidates = missingRemoteByHash.get(localMeta.hash);
      if (!candidates || candidates.length !== 1) continue;
      const oldRemote = candidates[0];
      const oldPath = oldRemote.path;
      this.progress.start(newPath, "rename", `Moved from ${oldPath}`);
      try {
        await this.options.provider.rename(oldPath, newPath);
      } catch (error) {
        this.progress.finish(newPath, "error", error instanceof Error ? error.message : String(error));
        throw error;
      }
      this.progress.finish(newPath);
      const renamedRemote = manifest.files[newPath];
      index[newPath] = await this.indexEntry(newPath, localMeta.hash, renamedRemote.driveFileId, renamedRemote.revision, await this.options.scanner.read(newPath, !localMeta.isText), localMeta.isText);
      index[oldPath] = { ...(index[oldPath] ?? this.emptyEntry(oldPath)), deleted: true, lastSyncedAt: Date.now() };
      updateRecordFromSync(localManifest.records, newPath, localMeta, renamedRemote, this.options.getDeviceId(), false);
      updateRecordFromSync(localManifest.records, oldPath, undefined, manifest.files[oldPath], this.options.getDeviceId(), true);
      candidates.pop();
      counters.uploads += 1;
    }
  }

  private async uploadLocal(
    path: string,
    localMeta: LocalFileMeta,
    filesFolderId: string,
    manifest: RemoteManifest,
    index: Record<string, SyncIndexEntry>,
    counters?: SyncCounters,
    localManifest?: LocalSyncManifest
  ): Promise<void> {
    const content = await this.options.scanner.read(path, !localMeta.isText);
    const localFile: LocalFile = { ...localMeta, content };
    this.progress.start(path, "upload");
    try {
      await this.options.provider.upload(localFile);
    } catch (error) {
      this.progress.finish(path, "error", error instanceof Error ? error.message : String(error));
      if (isOfflineError(error)) {
        await this.options.offlineQueue.enqueue("upload", path);
      }
      throw error;
    }
    this.progress.finish(path);
    const uploadedMeta = manifest.files[path];
    index[path] = await this.indexEntry(path, localMeta.hash, uploadedMeta?.driveFileId, uploadedMeta?.revision, content, localMeta.isText);
    if (localManifest) updateRecordFromSync(localManifest.records, path, localMeta, uploadedMeta, this.options.getDeviceId(), false);
    if (counters) counters.uploads += 1;
  }

  private async downloadRemote(path: string, remoteMeta: RemoteFileMeta, index: Record<string, SyncIndexEntry>, counters?: SyncCounters, localManifest?: LocalSyncManifest): Promise<void> {
    this.progress.start(path, "download");
    let remote;
    try {
      remote = await this.options.provider.download(path);
      await this.writeLocal(path, remote.content);
    } catch (error) {
      this.progress.finish(path, "error", error instanceof Error ? error.message : String(error));
      throw error;
    }
    this.progress.finish(path);
    index[path] = await this.indexEntry(path, remoteMeta.hash, remoteMeta.driveFileId, remoteMeta.revision, remote.content, remote.isText);
    if (localManifest) updateRecordFromSync(localManifest.records, path, {
      path,
      hash: remoteMeta.hash,
      size: remoteMeta.size,
      extension: path.split(".").pop()?.toLowerCase() ?? "",
      mtime: Date.now(),
      isText: remote.isText
    }, remoteMeta, this.options.getDeviceId(), false);
    if (counters) counters.downloads += 1;
  }

  private async resolveConflict(
    path: string,
    localMeta: LocalFileMeta,
    remoteMeta: RemoteFileMeta,
    filesFolderId: string,
    manifest: RemoteManifest,
    index: Record<string, SyncIndexEntry>,
    counters: SyncCounters,
    backupFiles?: Record<string, BackupFileSource>,
    localManifest?: LocalSyncManifest,
    allowManualResolution = false
  ): Promise<boolean> {
    await this.log("sync-engine-conflict-resolve-start", { path, manual: allowManualResolution });
    const remoteFile = await this.options.provider.download(path);
    await this.log("sync-engine-conflict-remote-downloaded", {
      path,
      isText: remoteFile.isText,
      size: typeof remoteFile.content === "string" ? byteSize(remoteFile.content) : remoteFile.content.byteLength
    });
    const remoteData = typeof remoteFile.content === "string" ? new TextEncoder().encode(remoteFile.content).buffer : remoteFile.content;
    const policy = this.options.getConflictPolicy();
    if (policy === "prefer-local") {
      if (backupFiles) this.captureRemoteBackupContent(backupFiles, path, remoteMeta, remoteData);
      await this.uploadLocal(path, localMeta, filesFolderId, manifest, index, counters, localManifest);
      return true;
    }
    if (policy === "prefer-remote") {
      if (backupFiles) await this.captureLocalBackup(backupFiles, path, localMeta);
      await this.downloadRemote(path, remoteMeta, index, counters, localManifest);
      return true;
    }
    const canTryTextMerge = localMeta.isText && isLikelyText(path) && localMeta.size <= MAX_SNAPSHOT_BYTES && remoteData.byteLength <= MAX_SNAPSHOT_BYTES;
    if (canTryTextMerge) {
      const baseText = index[path]?.baseSnapshot;
      const merged = await this.tryAutoMergeConflict(path, localMeta, remoteFile, filesFolderId, manifest, index, counters, backupFiles, localManifest);
      if (merged) return true;

      const localText = await this.options.scanner.readText(path);
      const remoteText = typeof remoteFile.content === "string" ? remoteFile.content : new TextDecoder().decode(remoteData);
      await this.log("sync-engine-conflict-modal-open", { path, manual: allowManualResolution });
      const choice = await showManualConflictModal(this.options.app, {
        path,
        localText,
        remoteText,
        deviceName: remoteMeta.deviceName ?? remoteMeta.deviceId ?? "Unknown device",
        modifiedAt: remoteMeta.mtime ?? remoteMeta.updatedAt ?? null,
        changeCount: baseText === undefined ? 2 : countChangedLines(baseText, localText) + countChangedLines(baseText, remoteText)
      });
      if (choice === "keep-local") {
        await this.uploadLocal(path, localMeta, filesFolderId, manifest, index, counters, localManifest);
        return true;
      }
      if (choice === "keep-remote") {
        await this.downloadRemote(path, remoteMeta, index, counters, localManifest);
        return true;
      }
      if (choice === "keep-both") {
        await this.log("sync-engine-conflict-keep-both", { path, manual: allowManualResolution });
        await this.keepBothConflict(path, localMeta, remoteMeta, remoteFile, filesFolderId, manifest, index, counters, localManifest);
        return true;
      }
      return false;
    }
    await this.captureConflictBackup(path, localMeta, remoteMeta, remoteData);
    await this.log("sync-engine-conflict-diagnostic-backup-created", { path });
    await this.log("sync-engine-conflict-keep-both-binary", { path });
    await this.keepBothConflict(path, localMeta, remoteMeta, remoteFile, filesFolderId, manifest, index, counters, localManifest);
    return true;
  }

  private async tryAutoMergeConflict(
    path: string,
    localMeta: LocalFileMeta,
    remoteFile: RemoteFile,
    filesFolderId: string,
    manifest: RemoteManifest,
    index: Record<string, SyncIndexEntry>,
    counters: SyncCounters,
    backupFiles?: Record<string, BackupFileSource>,
    localManifest?: LocalSyncManifest
  ): Promise<boolean> {
    const baseText = index[path]?.baseSnapshot;
    if (baseText === undefined) {
      await this.log("sync-engine-conflict-auto-merge-skipped", { path, reason: "missing-base-snapshot" });
      return false;
    }
    const localText = await this.options.scanner.readText(path);
    const remoteText = typeof remoteFile.content === "string" ? remoteFile.content : new TextDecoder().decode(remoteFile.content);
    const merged = this.mergeEngine.merge(path, baseText, localText, remoteText);
    if (merged.status === "conflict") {
      await this.log("sync-engine-conflict-auto-merge-conflict", { path, reason: merged.reason });
      return false;
    }
    const mergedText = merged.status === "no-changes" ? localText : merged.content;
    if (backupFiles) await this.captureLocalBackup(backupFiles, path, localMeta);
    await this.writeLocal(path, mergedText);
    this.progress.note(path, "merge", "done", "Edits from both devices were combined");
    const hash = await sha256Hex(mergedText);
    const localMerged: LocalFileMeta = {
      path,
      hash,
      size: byteSize(mergedText),
      extension: getExtension(path),
      mtime: Date.now(),
      isText: true
    };
    await this.log("sync-engine-conflict-auto-merged", { path, status: merged.status });
    await this.uploadLocal(path, localMerged, filesFolderId, manifest, index, counters, localManifest);
    return true;
  }

  private async keepBothConflict(
    path: string,
    localMeta: LocalFileMeta,
    remoteMeta: RemoteFileMeta,
    remoteFile: RemoteFile,
    filesFolderId: string,
    manifest: RemoteManifest,
    index: Record<string, SyncIndexEntry>,
    counters: SyncCounters,
    localManifest?: LocalSyncManifest
  ): Promise<void> {
    const localContent = await this.options.scanner.read(path, !localMeta.isText);
    const copyPath = conflictPath(path, this.options.getDeviceName());
    await this.log("sync-engine-keep-both-write-copy", { path, copyPath });
    this.progress.note(path, "conflict", "done", `Kept both versions — your copy is “${copyPath.split("/").pop()}”`);
    await this.writeLocal(copyPath, localContent);
    const copyMeta: LocalFileMeta = {
      path: copyPath,
      hash: await sha256Hex(localContent),
      size: byteSize(localContent),
      extension: getExtension(copyPath),
      mtime: Date.now(),
      isText: localMeta.isText
    };
    await this.uploadLocal(copyPath, copyMeta, filesFolderId, manifest, index, counters, localManifest);
    await this.writeLocal(path, remoteFile.content);
    index[path] = await this.indexEntry(path, remoteMeta.hash, remoteMeta.driveFileId, remoteMeta.revision, remoteFile.content, remoteFile.isText);
    if (localManifest) updateRecordFromSync(localManifest.records, path, {
      path,
      hash: remoteMeta.hash,
      size: remoteMeta.size,
      extension: getExtension(path),
      mtime: Date.now(),
      isText: remoteFile.isText
    }, remoteMeta, this.options.getDeviceId(), false);
    counters.downloads += 1;
  }

  private async tombstoneRemote(path: string, manifest: RemoteManifest, index: Record<string, SyncIndexEntry>, counters?: SyncCounters, localManifest?: LocalSyncManifest) {
    const remote = manifest.files[path];
    if (!remote) return;
    this.progress.markDone(path, "delete-remote");
    await this.options.provider.delete(path);
    index[path] = { ...(index[path] ?? this.emptyEntry(path)), deleted: true, lastSyncedAt: Date.now() };
    if (localManifest) updateRecordFromSync(localManifest.records, path, undefined, manifest.files[path], this.options.getDeviceId(), true);
    if (counters) counters.remoteDeletes += 1;
  }

  private async safeLocalDelete(path: string, index: Record<string, SyncIndexEntry>, counters?: SyncCounters, localManifest?: LocalSyncManifest): Promise<void> {
    const file = this.options.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      this.localWrites.add(path);
      this.progress.start(path, "delete-local");
      try {
        try {
          await this.options.app.fileManager.trashFile(file);
        } catch {
          const content = isLikelyText(path) ? await this.options.app.vault.read(file) : await this.options.app.vault.readBinary(file);
          await this.writeLocal(deletedCopyPath(path), content);
          await this.options.app.fileManager.trashFile(file);
        }
      } catch (error) {
        this.progress.finish(path, "error", error instanceof Error ? error.message : String(error));
        throw error;
      }
      this.progress.finish(path);
    }
    index[path] = { ...(index[path] ?? this.emptyEntry(path)), deleted: true, lastSyncedAt: Date.now() };
    if (localManifest) updateRecordFromSync(localManifest.records, path, undefined, undefined, this.options.getDeviceId(), true);
    if (counters) counters.localDeletes += 1;
  }

  private async indexEntry(
    path: string,
    hash: string,
    remoteId: string | undefined,
    remoteRevision: string | undefined,
    content: string | ArrayBuffer,
    isText: boolean
  ): Promise<SyncIndexEntry> {
    const entry: SyncIndexEntry = {
      path,
      lastSyncedHash: hash,
      lastSyncedRemoteId: remoteId,
      lastSyncedRemoteRevision: remoteRevision,
      lastSyncedAt: Date.now(),
      deleted: false
    };
    // Base snapshots power the three-way merge, which only runs on Markdown notes. Storing them
    // for other text files (JSON, canvas, CSS...) only bloats the plugin's data file.
    if (isText && typeof content === "string" && isMergeablePath(path) && byteSize(content) <= MAX_SNAPSHOT_BYTES) {
      entry.baseSnapshot = content;
      entry.baseSnapshotHash = await sha256Hex(content);
    }
    return entry;
  }

  private emptyEntry(path: string): SyncIndexEntry {
    return {
      path,
      lastSyncedHash: "",
      lastSyncedAt: Date.now()
    };
  }

  private async applyRemoteCommandIfNeeded(
    state: { manifest: RemoteManifest },
    local: Record<string, LocalFileMeta>,
    counters: SyncCounters
  ): Promise<SyncSummary | undefined> {
    const command = state.manifest.command;
    if (!command || command.type !== "replace-local-from-cloud") return undefined;
    if (command.createdByDeviceId === this.options.getDeviceId()) return undefined;
    if (this.options.getAppliedCommandIds().includes(command.id)) return undefined;
    const startedAt = Date.now();
    const index: Record<string, SyncIndexEntry> = {};
    this.progress.setStage("transferring", `Applying the cloud reset made on ${command.createdByDeviceName}…`);
    const activeRemoteCount = Object.values(state.manifest.files).filter((remote) => !remote.deleted).length;
    this.progress.growTotalBy(activeRemoteCount);
    for (const path of Object.keys(local)) {
      const remote = state.manifest.files[path];
      if (!remote || remote.deleted) await this.safeLocalDelete(path, index, counters);
    }
    for (const remote of Object.values(state.manifest.files)) {
      if (!remote.deleted) await this.downloadRemote(remote.path, remote, index, counters);
    }
    await this.options.setIndex(index);
    await this.markCommandApplied(command.id);
    new Notice(`Applied Google Drive reset from ${command.createdByDeviceName}.`);
    return this.summary(startedAt, counters, command.type);
  }

  private createCommand(): RemoteSyncCommand {
    const createdAt = Date.now();
    return {
      id: `${createdAt}-${this.options.getDeviceId().slice(0, 8)}`,
      type: "replace-local-from-cloud",
      createdAt,
      createdByDeviceId: this.options.getDeviceId(),
      createdByDeviceName: this.options.getDeviceName()
    };
  }

  private async markCommandApplied(id: string): Promise<void> {
    await this.options.setAppliedCommandIds(unique([...this.options.getAppliedCommandIds(), id]).slice(-50));
  }

  private summary(startedAt: number, counters: SyncCounters, command?: string): SyncSummary {
    const finishedAt = Date.now();
    return {
      startedAt,
      finishedAt,
      durationMs: finishedAt - startedAt,
      uploads: counters.uploads,
      downloads: counters.downloads,
      localDeletes: counters.localDeletes,
      remoteDeletes: counters.remoteDeletes,
      conflicts: counters.conflicts,
      errors: counters.errors,
      command
    };
  }
}

function timestampPath(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-") + "-" + [
    String(date.getHours()).padStart(2, "0"),
    String(date.getMinutes()).padStart(2, "0"),
    String(date.getSeconds()).padStart(2, "0")
  ].join("-");
}

/** Flat backup folder name: `<basename>-<hash>` keeps paths short and unique without deep encoded trees. */
function conflictBackupRoot(stamp: string, path: string): string {
  const base = (path.replace(/\\/g, "/").split("/").filter(Boolean).pop() || "root").replace(/[\\/:*?"<>|]/g, "_");
  return `.sync/backups/${stamp}/${base}-${fnv1a(path)}`;
}

function fnv1a(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function isMergeablePath(path: string): boolean {
  return path.toLowerCase().endsWith(".md");
}

function isOfflineError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /offline|network|timeout|unable to resolve|unknownhost|err_name_not_resolved|failed to fetch/i.test(message);
}

function countChangedLines(base: string, changed: string): number {
  const baseLines = base.split("\n");
  const changedLines = changed.split("\n");
  const length = Math.max(baseLines.length, changedLines.length);
  let count = 0;
  for (let index = 0; index < length; index += 1) {
    if (baseLines[index] !== changedLines[index]) count += 1;
  }
  return count;
}
