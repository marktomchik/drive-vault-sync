import { Notice, Platform, Plugin, TAbstractFile, TFile, moment, normalizePath, setIcon } from "obsidian";
import { GoogleAuth } from "./auth";
import { decodeTransferPayload } from "./authTransfer";
import { GoogleDriveClient } from "./drive";
import {
  AuthExportModal,
  DeviceFlowModal,
  SyncFailuresModal,
  SyncLogModal,
  SyncProgressModal,
  chooseInitialSyncDirection,
  chooseLocalFilesToKeep,
  chooseRemoteCleanupCandidates,
  confirmDangerAction,
  confirmResetIndex,
  isDecisionModalOpen,
  showAuthImportModal
} from "./modals";
import { OfflineSyncQueue } from "./offlineQueue";
import { STAGE_LABELS, progressPercent } from "./progress";
import { GoogleDriveProvider } from "./provider";
import { RequestQueue } from "./queue";
import { LocalVaultScanner } from "./scanner";
import { DriveVaultSyncSettingTab } from "./settings";
import { SyncEngine, TransferFailure } from "./sync";
import {
  BackupMeta,
  DEFAULT_SETTINGS,
  DriveVaultSyncSettings,
  InitialSyncDirection,
  PluginData,
  RemoteCleanupCandidate,
  StoredAuth,
  StoredPluginData,
  SyncFailureEntry,
  SyncIndexEntry,
  SyncProgressState,
  SyncStatus,
  SyncSummary,
  defaultIgnoredPaths
} from "./types";
import { createLogger, ensureFolder, ignoredPatternsFromSettings, isIgnored, sanitizeLogValue } from "./utils";

const SYNC_LOG_PATH = ".sync/drive-vault-sync.log";
const MAX_SYNC_LOG_BYTES = 512 * 1024;
const STARTUP_SYNC_DELAY_MS = 2500;
const MOBILE_SCAN_CONCURRENCY = 2;
const RESUME_CHECK_MIN_INTERVAL_MS = 15000;
/** Vault events for files the sync itself just wrote are ignored for this long after a sync. */
const OWN_WRITE_GRACE_MS = 5000;
/** Folder name used by earlier releases; settings and sign-in are imported from it once. */
const LEGACY_PLUGIN_ID = "google-drive-vault-sync";

export default class DriveVaultSyncPlugin extends Plugin {
  settings: DriveVaultSyncSettings = { ...DEFAULT_SETTINGS };
  pluginData: PluginData = {};
  queue = new RequestQueue(DEFAULT_SETTINGS.requestConcurrency);
  auth!: GoogleAuth;
  drive!: GoogleDriveClient;
  provider!: GoogleDriveProvider;
  offlineQueue!: OfflineSyncQueue;
  scanner!: LocalVaultScanner;
  syncEngine!: SyncEngine;
  accountLabel?: string;
  /** Called when the connection or setup state changes (the settings tab re-renders). */
  onConnectionChange?: () => void;
  /** Called on every status/progress change (the settings tab refreshes its status card). */
  onStatusChange?: () => void;

  private statusBarEl?: HTMLElement;
  private mobileProgressNotice?: Notice;
  private lastResumeCheckAt = 0;
  private ribbonEl?: HTMLElement;
  private progressModal?: SyncProgressModal;
  private syncTimer?: number;
  private cloudWatchTimer?: number;
  private debounceTimer?: number;
  private cloudWatchRunning = false;
  private startupSyncRunning = false;
  private syncRunning = false;
  private normalUploadUnlocked = false;
  private ignoreOwnWritesUntil = 0;
  private recentOwnWrites = new Set<string>();
  /** Paths edited while a sync was running; they trigger a follow-up sync. */
  private pendingEventPaths = new Set<string>();
  private dirtyPaths = new Set<string>();
  private log = createLogger(() => this.settings.debugMode);
  private logSessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  private lastCloudWatchSkipLogAt = 0;
  private logCache?: string;
  private pendingLogLines: string[] = [];
  private logFlushTimer?: number;
  private dataFlushTimer?: number;
  private pendingDataFlush?: Promise<void>;
  private dataWriteChain: Promise<void> = Promise.resolve();
  private cachedRawData: StoredPluginData | null = null;
  private dataLoadFailed = false;
  private importedFromLegacy = false;
  private statusRefreshQueued = false;

  async onload() {
    await this.loadSettings();
    await this.loadPluginData();
    this.ensureDeviceIdentity();
    this.queue.setConcurrency(this.settings.requestConcurrency);
    this.auth = new GoogleAuth(
      this,
      () => this.settings.clientId,
      () => this.settings.clientSecret,
      (data) => this.savePluginData(data),
      () => this.markDisconnected()
    );
    this.auth.setAuth(this.pluginData.auth);
    this.drive = new GoogleDriveClient(this.auth, this.queue);
    this.provider = new GoogleDriveProvider(
      this.drive,
      () => this.settings.remoteFolderName,
      () => this.getVaultId(),
      () => this.getDeviceId(),
      () => this.getDeviceName()
    );
    this.offlineQueue = new OfflineSyncQueue(
      () => this.pluginData.offlineQueue ?? [],
      async (offlineQueue) => this.savePluginData({ offlineQueue }),
      () => this.getDeviceId()
    );
    this.scanner = new LocalVaultScanner(this.app.vault, () => this.settings.ignoredPaths, Platform.isMobile ? MOBILE_SCAN_CONCURRENCY : undefined);
    this.syncEngine = new SyncEngine({
      app: this.app,
      scanner: this.scanner,
      drive: this.drive,
      provider: this.provider,
      offlineQueue: this.offlineQueue,
      getRemoteFolderName: () => this.settings.remoteFolderName,
      getVaultId: () => this.getVaultId(),
      getIndex: () => this.pluginData.index ?? {},
      setIndex: async (index) => this.savePluginData({ index }),
      getLocalManifest: () => this.pluginData.localManifest,
      setLocalManifest: async (localManifest) => this.savePluginData({ localManifest }),
      getOfflineQueueItems: () => this.pluginData.offlineQueue ?? [],
      getMaxDeletionPercent: () => this.settings.maxDeletionPercent,
      getConflictPolicy: () => this.settings.conflictPolicy,
      getDeviceId: () => this.getDeviceId(),
      getDeviceName: () => this.getDeviceName(),
      getAppliedCommandIds: () => this.pluginData.appliedCommandIds ?? [],
      setAppliedCommandIds: async (appliedCommandIds) => this.savePluginData({ appliedCommandIds }),
      getBackupEnabled: () => this.settings.backupEnabled,
      getBackupMode: () => this.settings.backupMode,
      getBackupIntervalMinutes: () => this.settings.backupIntervalMinutes,
      getMaxBackups: () => this.settings.maxBackups,
      appendLog: (message, details) => this.appendSyncLog(message, details),
      persistFailures: (failures, attemptedPaths, operation) => this.recordSyncFailures(failures, attemptedPaths, operation),
      onProgress: (state) => this.handleProgressUpdate(state)
    });
    await this.appendSyncLog("plugin-loaded", {
      version: this.manifest.version,
      mobile: Platform.isMobile,
      syncOnStartup: this.settings.syncOnStartup,
      initialSyncCompleted: this.isInitialSyncCompleted(),
      connected: this.getStoredAuth() !== undefined,
      importedFromLegacy: this.importedFromLegacy
    });

    this.addSettingTab(new DriveVaultSyncSettingTab(this.app, this));
    this.registerCommands();
    this.registerVaultEvents();
    this.registerMobileLifecycle();
    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("dvs-status-bar");
    this.statusBarEl.setAttribute("aria-label-position", "top");
    this.statusBarEl.addEventListener("click", () => this.handleStatusBarClick());
    this.ribbonEl = this.addRibbonIcon("cloud", "Sync with Google Drive", () => this.handleStatusBarClick());
    this.updateStatusBar();
    this.registerObsidianProtocolHandler("drive-vault-sync", (params) => {
      if (typeof params.payload === "string" && params.payload) void this.handleAuthImport(params.payload);
    });

    if (this.importedFromLegacy) {
      new Notice("Drive Vault Sync imported your settings and Google sign-in from the previous version. Turn off the old copy of the plugin in Settings → Community plugins so the two don't sync at the same time.", 0);
    }

    this.app.workspace.onLayoutReady(() => void this.afterLayoutReady());
  }

  private async afterLayoutReady() {
    void this.refreshAccountLabel();
    if (this.settings.syncOnStartup && this.getStoredAuth() && this.isInitialSyncCompleted()) {
      await this.appendSyncLog("startup-sync-scheduled", { delayMs: STARTUP_SYNC_DELAY_MS });
      window.setTimeout(() => void this.safeStartupSync(), STARTUP_SYNC_DELAY_MS);
    } else {
      this.normalUploadUnlocked = true;
      await this.rememberCurrentRemoteMarkers();
      this.configureTimers();
      await this.appendSyncLog("startup-sync-skipped", {
        syncOnStartup: this.settings.syncOnStartup,
        connected: this.getStoredAuth() !== undefined,
        initialSyncCompleted: this.isInitialSyncCompleted()
      });
    }
  }

  onunload() {
    if (this.syncTimer !== undefined) window.clearInterval(this.syncTimer);
    if (this.cloudWatchTimer !== undefined) window.clearInterval(this.cloudWatchTimer);
    if (this.debounceTimer !== undefined) window.clearTimeout(this.debounceTimer);
    if (this.logFlushTimer !== undefined) {
      window.clearTimeout(this.logFlushTimer);
      this.logFlushTimer = undefined;
      void this.flushSyncLog();
    }
    if (this.dataFlushTimer !== undefined) {
      window.clearTimeout(this.dataFlushTimer);
      void this.flushPluginData();
    }
    this.progressModal?.close();
    this.mobileProgressNotice?.hide();
  }

  // -------------------------------------------------------------------------
  // Plugin data (settings, sign-in, sync index)
  // -------------------------------------------------------------------------

  private get pluginDir(): string {
    return this.manifest.dir ?? normalizePath(`${this.app.vault.configDir}/plugins/${this.manifest.id}`);
  }

  private get dataFilePath(): string {
    return `${this.pluginDir}/data.json`;
  }

  private get dataBackupPath(): string {
    return `${this.pluginDir}/data.json.bak`;
  }

  /**
   * Reads data.json, falling back to the last good backup or an interrupted write. If this plugin
   * has no data yet, settings from the previous release (different plugin folder) are imported.
   */
  private async readVaultDataFile(): Promise<StoredPluginData | null> {
    if (this.cachedRawData !== null) return this.cachedRawData;
    const adapter = this.app.vault.adapter;
    const parse = async (path: string): Promise<StoredPluginData | undefined> => {
      try {
        if (!(await adapter.exists(path))) return undefined;
        return JSON.parse(await adapter.read(path)) as StoredPluginData;
      } catch {
        return undefined;
      }
    };
    for (const path of [this.dataFilePath, this.dataBackupPath, `${this.dataFilePath}.tmp`]) {
      const data = await parse(path);
      if (!data) continue;
      this.cachedRawData = data;
      if (path !== this.dataFilePath) new Notice("Drive Vault Sync: the settings file was damaged, so the last good copy was restored.");
      return data;
    }
    try {
      if (await adapter.exists(this.dataFilePath)) {
        this.dataLoadFailed = true;
        new Notice("Drive Vault Sync: the settings file is unreadable and no backup was found. Nothing will be saved until it is fixed, so it is not overwritten.", 0);
        return null;
      }
    } catch {
      // ignore
    }
    const legacyDir = normalizePath(`${this.app.vault.configDir}/plugins/${LEGACY_PLUGIN_ID}`);
    if (legacyDir !== this.pluginDir) {
      for (const path of [`${legacyDir}/data.json`, `${legacyDir}/data.json.bak`]) {
        const data = await parse(path);
        if (!data) continue;
        this.cachedRawData = data;
        this.importedFromLegacy = true;
        return data;
      }
    }
    return null;
  }

  async loadSettings() {
    const data = await this.readVaultDataFile();
    const defaultsIgnored = defaultIgnoredPaths(this.app.vault.configDir, this.pluginDir);
    const settings: DriveVaultSyncSettings = {
      ...DEFAULT_SETTINGS,
      ignoredPaths: defaultsIgnored,
      ...(data?.settings ?? {})
    };
    if (!data?.settings?.ignoredPaths) settings.ignoredPaths = defaultsIgnored;
    const lines = settings.ignoredPaths.split(/\r?\n/).map((line) => line.trim());
    const required = [".sync/", `${this.pluginDir}/`];
    for (const entry of required) {
      if (!lines.includes(entry)) settings.ignoredPaths = `${settings.ignoredPaths.trim()}\n${entry}`.trim();
    }
    this.settings = settings;
  }

  async saveSettings() {
    await this.savePluginData({ settings: this.settings });
  }

  async loadPluginData() {
    const data = await this.readVaultDataFile();
    const index = trimIndexSnapshots(data?.index ?? {});
    const hasPreviousSyncState = Object.keys(index).length > 0 || data?.syncStatus?.lastSummary !== undefined;
    this.pluginData = {
      auth: data?.auth,
      index,
      localManifest: data?.localManifest,
      offlineQueue: data?.offlineQueue ?? [],
      vaultId: data?.vaultId,
      deviceId: data?.deviceId,
      appliedCommandIds: data?.appliedCommandIds ?? [],
      initialSyncCompleted: data?.initialSyncCompleted ?? (data?.auth ? hasPreviousSyncState : false),
      syncStatus: data?.syncStatus?.state === "syncing"
        ? { ...data.syncStatus, state: data.auth ? "idle" : "disconnected" }
        : data?.syncStatus ?? { state: data?.auth ? "idle" : "disconnected" },
      lastRemoteUpdatedAt: data?.lastRemoteUpdatedAt,
      lastRemoteCommandId: data?.lastRemoteCommandId,
      lastRemoteManifestVersion: data?.lastRemoteManifestVersion,
      syncFailures: data?.syncFailures ?? []
    };
    if (this.importedFromLegacy) await this.savePluginData({});
  }

  async savePluginData(data: Partial<StoredPluginData>): Promise<void> {
    const next = { ...data };
    delete next.settings;
    this.pluginData = { ...this.pluginData, ...next };
    return this.scheduleDataSave();
  }

  /** Coalesces bursts of saves (a sync updates state many times) into one disk write. */
  private scheduleDataSave(): Promise<void> {
    if (this.pendingDataFlush) return this.pendingDataFlush;
    this.pendingDataFlush = new Promise<void>((resolve, reject) => {
      this.dataFlushTimer = window.setTimeout(() => {
        this.flushPluginData().then(resolve, reject);
      }, 500);
    });
    return this.pendingDataFlush;
  }

  /** Writes are chained so two flushes can never interleave their temp-file/rename steps. */
  private flushPluginData(): Promise<void> {
    this.dataFlushTimer = undefined;
    this.pendingDataFlush = undefined;
    const run = this.dataWriteChain.then(() => this.writePluginData());
    this.dataWriteChain = run.catch(() => undefined);
    return run;
  }

  private async writePluginData(): Promise<void> {
    if (this.dataLoadFailed) return;
    const data: StoredPluginData = { ...this.pluginData, settings: this.settings };
    const body = JSON.stringify(data);
    const adapter = this.app.vault.adapter;
    try {
      // Keep the previous good file as a backup, then write atomically (temp file + rename).
      if (await adapter.exists(this.dataFilePath)) {
        try {
          const current = await adapter.read(this.dataFilePath);
          JSON.parse(current);
          await adapter.write(this.dataBackupPath, current);
        } catch {
          // The current file is unreadable — don't overwrite the backup with it.
        }
      }
      const tmpPath = `${this.dataFilePath}.tmp`;
      await adapter.write(tmpPath, body);
      try {
        await adapter.remove(this.dataFilePath);
      } catch {
        // It may not exist yet.
      }
      await adapter.rename(tmpPath, this.dataFilePath);
      this.cachedRawData = data;
    } catch (error) {
      this.log("Atomic data.json write failed, using saveData fallback", error instanceof Error ? error.message : String(error));
      await this.saveData(data);
      this.cachedRawData = data;
    }
  }

  getStoredAuth(): StoredAuth | undefined {
    return this.pluginData.auth;
  }

  // -------------------------------------------------------------------------
  // Google account
  // -------------------------------------------------------------------------

  async connectGoogleDrive() {
    const session = await this.auth.startDeviceFlow();
    const verificationUrl = session.device.verification_url_complete ?? session.device.verification_uri_complete;
    if (verificationUrl) window.open(verificationUrl, "_blank");
    new DeviceFlowModal(this.app, session, () => undefined).open();
    await session.done;
    await this.drive.test();
    await this.refreshAccountLabel();
    await this.setSyncStatus({ state: "idle" });
    new Notice(`Google Drive connected${this.accountLabel ? ` as ${this.accountLabel}` : ""}.`);
    this.onConnectionChange?.();
    await this.promptForInitialSyncIfNeeded();
  }

  async disconnectGoogleDrive() {
    const confirmed = await confirmDangerAction(
      this.app,
      "Disconnect Google Drive?",
      "Syncing stops on this device. Your notes and the copy in Google Drive are not touched, and you can connect again at any time.",
      "Disconnect"
    );
    if (!confirmed) return;
    await this.auth.disconnect();
    await this.markDisconnected();
    new Notice("Google Drive disconnected.");
    await this.setSyncStatus({ state: "disconnected" });
    this.onConnectionChange?.();
  }

  showAuthExportModal() {
    const auth = this.getStoredAuth();
    if (!auth) {
      new Notice("Connect Google Drive first.");
      return;
    }
    new AuthExportModal(this.app, auth).open();
  }

  private async handleAuthImport(rawPayload: string) {
    let payload;
    try {
      payload = decodeTransferPayload(rawPayload);
    } catch {
      new Notice("This QR code is not a valid sign-in code.");
      return;
    }
    const auth = await showAuthImportModal(this.app, payload);
    if (!auth) return;
    this.auth.setAuth(auth);
    await this.savePluginData({ auth });
    await this.refreshAccountLabel();
    await this.setSyncStatus({ state: "idle" });
    new Notice("Signed in to Google Drive.");
    this.onConnectionChange?.();
    await this.promptForInitialSyncIfNeeded();
  }

  async markDisconnected() {
    this.pluginData.auth = undefined;
    this.auth?.setAuth(undefined);
    this.accountLabel = undefined;
    await this.savePluginData({ auth: undefined });
  }

  private async refreshAccountLabel() {
    if (!this.getStoredAuth()) return;
    this.accountLabel = await this.auth.getAccountLabel();
    this.requestStatusRefresh();
  }

  // -------------------------------------------------------------------------
  // Backups
  // -------------------------------------------------------------------------

  async getBackups(): Promise<BackupMeta[]> {
    const state = await this.drive.loadRemoteState(this.settings.remoteFolderName, this.getVaultId());
    return state.manifest.backups ?? [];
  }

  async getManualBackups(): Promise<BackupMeta[]> {
    const state = await this.drive.loadRemoteState(this.settings.remoteFolderName, this.getVaultId());
    return state.manifest.manualBackups ?? [];
  }

  async createManualBackup(label: string): Promise<void> {
    await this.syncEngine.createManualBackup(label);
    new Notice(`Backup “${label}” created.`);
    this.requestStatusRefresh();
  }

  async restoreFromBackup(backup: BackupMeta): Promise<void> {
    await this.syncEngine.restoreFromBackup(backup.fileId);
    new Notice(`Restored from the backup of ${new Date(backup.createdAt).toLocaleString()}. The restored files will be synced to your other devices.`);
    this.afterLocalRestore();
  }

  async restoreFileFromBackup(backup: BackupMeta, path: string): Promise<void> {
    await this.syncEngine.restoreFileFromBackup(backup.fileId, path);
    new Notice(`Restored ${path}.`);
    this.afterLocalRestore();
  }

  /** Restored files must reach the cloud too; their own vault events were suppressed during the restore. */
  private afterLocalRestore() {
    this.syncEngine.consumeLocalWrites();
    this.pendingEventPaths.clear();
    this.requestStatusRefresh();
    this.scheduleAutoSync();
  }

  async deleteBackup(backup: BackupMeta): Promise<void> {
    await this.drive.trashFile(backup.folderId ?? backup.fileId);
    const state = await this.drive.loadRemoteState(this.settings.remoteFolderName, this.getVaultId());
    state.manifest.backups = (state.manifest.backups ?? []).filter((item) => item.id !== backup.id);
    await this.drive.saveManifest(state);
  }

  async deleteManualBackup(backup: BackupMeta): Promise<void> {
    await this.drive.trashFile(backup.folderId ?? backup.fileId);
    const state = await this.drive.loadRemoteState(this.settings.remoteFolderName, this.getVaultId());
    state.manifest.manualBackups = (state.manifest.manualBackups ?? []).filter((item) => item.id !== backup.id);
    await this.drive.saveManifest(state);
  }

  // -------------------------------------------------------------------------
  // Syncing
  // -------------------------------------------------------------------------

  private isBusy(): boolean {
    return this.syncRunning || this.startupSyncRunning || this.syncEngine?.isRunning() === true;
  }

  async syncNow(manual = false) {
    if (this.syncRunning || this.syncEngine?.isRunning()) {
      await this.appendSyncLog("sync-skipped-already-running", { manual, syncRunning: this.syncRunning, engineRunning: this.syncEngine?.isRunning() });
      if (manual) this.openProgressModal();
      return;
    }
    if (!this.getStoredAuth()) {
      await this.appendSyncLog("sync-skipped-disconnected", { manual });
      if (manual) new Notice("Connect Google Drive in the Drive Vault Sync settings first.");
      await this.setSyncStatus({ state: "disconnected" });
      return;
    }
    if (!this.isInitialSyncCompleted()) {
      await this.appendSyncLog("sync-skipped-initial-sync-incomplete", { manual });
      if (manual) await this.promptForInitialSyncIfNeeded();
      return;
    }
    const startedAt = Date.now();
    this.syncRunning = true;
    if (this.debounceTimer !== undefined) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    await this.appendSyncLog("sync-start", {
      manual,
      dirtyCount: this.dirtyPaths.size,
      startupSyncRunning: this.startupSyncRunning,
      normalUploadUnlocked: this.normalUploadUnlocked
    });
    await this.setSyncStatus({ ...this.pluginData.syncStatus, state: "syncing", lastStartedAt: startedAt, lastError: undefined });
    try {
      this.log("Starting sync", { dirtyCount: this.dirtyPaths.size });
      this.dirtyPaths.clear();
      const summary = await this.syncEngine.syncNow(manual);
      if (summary) await this.recordSyncSuccess(summary);
      else await this.setSyncStatus({ ...this.pluginData.syncStatus, state: "idle" });
      await this.appendSyncLog("sync-finished", summary);
    } catch (error) {
      new Notice(`Google Drive sync failed: ${error instanceof Error ? error.message : String(error)}`);
      this.log("Sync failed", error instanceof Error ? error.message : String(error));
      await this.appendSyncLog("sync-error", this.errorDetails(error));
      await this.recordSyncError(error);
    } finally {
      this.recentOwnWrites = this.syncEngine.consumeLocalWrites();
      this.ignoreOwnWritesUntil = Date.now() + OWN_WRITE_GRACE_MS;
      this.syncRunning = false;
      await this.appendSyncLog("sync-unlocked", { ownWrites: this.recentOwnWrites.size, pendingEvents: this.pendingEventPaths.size });
      this.schedulePendingEventSync();
    }
  }

  private async safeStartupSync() {
    if (this.startupSyncRunning) return;
    this.startupSyncRunning = true;
    this.normalUploadUnlocked = false;
    await this.appendSyncLog("startup-sync-start");
    try {
      await this.syncNow(false);
      await this.rememberCurrentRemoteMarkers();
      this.normalUploadUnlocked = true;
      await this.appendSyncLog("startup-sync-finished");
    } catch (error) {
      await this.appendSyncLog("startup-sync-error", this.errorDetails(error));
      throw error;
    } finally {
      this.startupSyncRunning = false;
      this.normalUploadUnlocked = true;
      this.configureTimers();
      await this.appendSyncLog("startup-sync-unlocked");
      this.schedulePendingEventSync();
    }
  }

  /** Edits made while a sync was running are synced right after it (minus files the sync wrote itself). */
  private schedulePendingEventSync() {
    if (this.pendingEventPaths.size === 0 || this.isBusy()) return;
    const userEdits = [...this.pendingEventPaths].filter((path) => !this.recentOwnWrites.has(path));
    this.pendingEventPaths.clear();
    if (userEdits.length === 0) return;
    for (const path of userEdits) this.dirtyPaths.add(path);
    void this.appendSyncLog("vault-events-during-sync", { count: userEdits.length });
    this.scheduleAutoSync();
  }

  private scheduleAutoSync() {
    if (!this.settings.autoSyncEnabled || !this.getStoredAuth() || !this.isInitialSyncCompleted() || !this.normalUploadUnlocked) return;
    if (this.debounceTimer !== undefined) window.clearTimeout(this.debounceTimer);
    const delayMs = Math.max(1, this.settings.syncDebounceSeconds) * 1000;
    this.debounceTimer = window.setTimeout(() => {
      this.debounceTimer = undefined;
      void this.syncNow();
    }, delayMs);
  }

  async openDailyNoteSafely() {
    if (!this.getStoredAuth()) {
      new Notice("Connect Google Drive first.");
      return;
    }
    if (this.isInitialSyncCompleted()) await this.syncNow(false);
    const { folder, format } = await this.readDailyNoteSettings();
    const fileName = `${moment().format(format || "YYYY-MM-DD")}.md`;
    const path = normalizePath(folder ? `${folder}/${fileName}` : fileName);
    const existing = this.app.vault.getAbstractFileByPath(path);
    let file: TFile;
    if (existing instanceof TFile) {
      file = existing;
    } else {
      const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      if (parent) await ensureFolder(this.app.vault, parent);
      file = await this.app.vault.create(path, "");
    }
    await this.app.workspace.getLeaf(false).openFile(file);
  }

  /** Reads the folder and date format configured in the core Daily notes plugin, if any. */
  private async readDailyNoteSettings(): Promise<{ folder: string; format: string }> {
    try {
      const raw = await this.app.vault.adapter.read(normalizePath(`${this.app.vault.configDir}/daily-notes.json`));
      const parsed = JSON.parse(raw) as { folder?: unknown; format?: unknown };
      return {
        folder: typeof parsed.folder === "string" ? parsed.folder.trim().replace(/^\/+|\/+$/g, "") : "",
        format: typeof parsed.format === "string" ? parsed.format.trim() : ""
      };
    } catch {
      return { folder: "", format: "" };
    }
  }

  async cleanRemoteDuplicates() {
    if (this.isBusy()) {
      new Notice("Wait for the current sync to finish first.");
      return;
    }
    if (!this.getStoredAuth()) {
      new Notice("Connect Google Drive first.");
      return;
    }
    await this.appendSyncLog("remote-cleanup-start");
    const notice = new Notice("Scanning the Google Drive folder…", 0);
    try {
      const state = await this.drive.loadRemoteState(this.settings.remoteFolderName, this.getVaultId());
      const remoteFiles = await this.drive.listVaultFiles(state.filesFolderId);
      const manifestByPath = new Map<string, string>();
      const manifestIds = new Set<string>();
      for (const file of Object.values(state.manifest.files)) {
        if (file.deleted) continue;
        manifestByPath.set(file.path, file.driveFileId);
        manifestIds.add(file.driveFileId);
      }
      const candidates: RemoteCleanupCandidate[] = remoteFiles
        .filter((file) => !manifestIds.has(file.id))
        .map((file) => {
          const keptFileId = manifestByPath.get(file.path);
          return {
            id: file.id,
            path: file.path,
            name: file.name,
            modifiedTime: file.modifiedTime ? Date.parse(file.modifiedTime) : null,
            size: file.size !== undefined ? Number(file.size) : undefined,
            reason: keptFileId ? "duplicate" as const : "orphan" as const,
            keptFileId
          };
        })
        .sort((a, b) => a.path.localeCompare(b.path) || (b.modifiedTime ?? 0) - (a.modifiedTime ?? 0));
      notice.hide();
      await this.appendSyncLog("remote-cleanup-scanned", {
        remoteFiles: remoteFiles.length,
        candidates: candidates.length,
        duplicates: candidates.filter((item) => item.reason === "duplicate").length,
        orphans: candidates.filter((item) => item.reason === "orphan").length
      });
      if (candidates.length === 0) {
        new Notice("No leftover files found — Google Drive is clean.");
        return;
      }
      const selected = await chooseRemoteCleanupCandidates(this.app, candidates);
      if (!selected || selected.length === 0) {
        await this.appendSyncLog("remote-cleanup-cancelled", { candidates: candidates.length });
        return;
      }
      const progress = new Notice(`Moving 0 of ${selected.length} files to the Google Drive trash…`, 0);
      let done = 0;
      for (const candidate of selected) {
        await this.drive.trashFile(candidate.id);
        done += 1;
        progress.setMessage(`Moving ${done} of ${selected.length} files to the Google Drive trash…`);
      }
      progress.hide();
      await this.appendSyncLog("remote-cleanup-finished", { trashed: selected.length });
      new Notice(`Moved ${selected.length} leftover file${selected.length === 1 ? "" : "s"} to the Google Drive trash.`);
    } catch (error) {
      notice.hide();
      await this.appendSyncLog("remote-cleanup-error", this.errorDetails(error));
      new Notice(error instanceof Error ? error.message : "Google Drive cleanup failed.");
    }
  }

  private async resetCloudFromLocal() {
    this.requireConnected();
    await this.setSyncStatus({ ...this.pluginData.syncStatus, state: "syncing", lastStartedAt: Date.now(), lastError: undefined });
    this.openProgressModal();
    try {
      const summary = await this.syncEngine.resetCloudFromLocal();
      await this.recordSyncSuccess(summary);
      await this.markInitialSyncCompleted();
    } catch (error) {
      await this.recordSyncError(error);
      throw error;
    } finally {
      this.recentOwnWrites = this.syncEngine.consumeLocalWrites();
      this.ignoreOwnWritesUntil = Date.now() + OWN_WRITE_GRACE_MS;
      this.schedulePendingEventSync();
    }
  }

  private async resetLocalFromCloud(keepLocalPaths: string[]) {
    this.requireConnected();
    await this.setSyncStatus({ ...this.pluginData.syncStatus, state: "syncing", lastStartedAt: Date.now(), lastError: undefined });
    this.openProgressModal();
    try {
      const summary = await this.syncEngine.resetLocalFromCloud(keepLocalPaths);
      await this.recordSyncSuccess(summary);
      await this.markInitialSyncCompleted();
    } catch (error) {
      await this.recordSyncError(error);
      throw error;
    } finally {
      this.recentOwnWrites = this.syncEngine.consumeLocalWrites();
      this.ignoreOwnWritesUntil = Date.now() + OWN_WRITE_GRACE_MS;
      this.schedulePendingEventSync();
    }
  }

  private async listLocalOnlyPaths(): Promise<string[]> {
    this.requireConnected();
    this.openProgressModal();
    return this.syncEngine.listLocalOnlyPaths();
  }

  async confirmAndResetCloudFromLocal() {
    if (this.isBusy()) {
      new Notice("Wait for the current sync to finish first.");
      return;
    }
    const confirmed = await confirmDangerAction(
      this.app,
      "Replace the cloud copy with this vault?",
      "The files currently in Google Drive are moved to the Google Drive trash (and backed up first), this vault is uploaded as the new cloud copy, and your other devices will replace their files with it on their next sync.",
      "Replace cloud copy"
    );
    if (confirmed) await this.resetCloudFromLocal();
  }

  async confirmAndResetLocalFromCloud() {
    if (this.isBusy()) {
      new Notice("Wait for the current sync to finish first.");
      return;
    }
    const confirmed = await confirmDangerAction(
      this.app,
      "Replace this vault with the cloud copy?",
      "Files on this device are overwritten with the versions from Google Drive (changed files are backed up first). Next, you can choose which files that exist only on this device should be kept.",
      "Continue"
    );
    if (!confirmed) return;
    const localOnlyPaths = await this.listLocalOnlyPaths();
    const keepPaths = localOnlyPaths.length > 0 ? await chooseLocalFilesToKeep(this.app, localOnlyPaths) : [];
    if (keepPaths === null) return;
    await this.resetLocalFromCloud(keepPaths);
  }

  async resetLocalSyncIndex() {
    if (this.isBusy()) {
      new Notice("Wait for the current sync to finish first.");
      return;
    }
    if (!(await confirmResetIndex(this.app))) return;
    await this.savePluginData({ index: {}, localManifest: undefined });
    new Notice("The sync state of this device was reset. The next sync compares every file.");
  }

  configureTimers() {
    if (this.syncTimer !== undefined) window.clearInterval(this.syncTimer);
    if (this.cloudWatchTimer !== undefined) window.clearInterval(this.cloudWatchTimer);
    this.syncTimer = undefined;
    this.cloudWatchTimer = undefined;
    if (this.settings.fullSyncFallbackEnabled && this.isInitialSyncCompleted()) {
      const intervalMs = Math.max(1, this.settings.syncIntervalMinutes) * 60 * 1000;
      this.syncTimer = window.setInterval(() => void this.syncNow(), intervalMs);
    }
    if (this.settings.cloudWatchEnabled && this.isInitialSyncCompleted()) {
      const intervalMs = Math.max(10, this.settings.cloudWatchIntervalSeconds) * 1000;
      this.cloudWatchTimer = window.setInterval(() => void this.checkCloudForChanges(), intervalMs);
    }
  }

  /** Polls a tiny change marker of the cloud index and starts a sync only when another device changed something. */
  private async checkCloudForChanges() {
    if (this.cloudWatchRunning || this.isBusy() || !this.normalUploadUnlocked || !this.getStoredAuth() || !this.isInitialSyncCompleted()) {
      if (Date.now() - this.lastCloudWatchSkipLogAt > 60000) {
        this.lastCloudWatchSkipLogAt = Date.now();
        await this.appendSyncLog("cloud-watch-skipped", {
          cloudWatchRunning: this.cloudWatchRunning,
          startupSyncRunning: this.startupSyncRunning,
          syncRunning: this.syncRunning,
          normalUploadUnlocked: this.normalUploadUnlocked,
          connected: this.getStoredAuth() !== undefined
        });
      }
      return;
    }
    this.cloudWatchRunning = true;
    try {
      const marker = await this.drive.getManifestMarker(this.settings.remoteFolderName);
      if (!marker) {
        await this.appendSyncLog("cloud-watch-no-manifest");
        return;
      }
      if (marker === this.pluginData.lastRemoteManifestVersion) return;
      await this.appendSyncLog("cloud-watch-trigger-sync", { marker, previous: this.pluginData.lastRemoteManifestVersion });
      this.log("Cloud watch detected a remote change", { marker });
      // Remember the marker first so a failing sync is not retried every few seconds;
      // the periodic full check and the next edit still pick the change up.
      await this.savePluginData({ lastRemoteManifestVersion: marker });
      await this.syncNow();
    } catch (error) {
      this.log("Cloud watch failed", error instanceof Error ? error.message : String(error));
      await this.appendSyncLog("cloud-watch-error", this.errorDetails(error));
    } finally {
      this.cloudWatchRunning = false;
    }
  }

  private async rememberCurrentRemoteMarkers() {
    if (!this.getStoredAuth()) return;
    try {
      const marker = await this.drive.getManifestMarker(this.settings.remoteFolderName);
      await this.savePluginData({ lastRemoteManifestVersion: marker });
      await this.appendSyncLog("remote-markers-remembered", { marker });
    } catch (error) {
      this.log("Could not refresh the cloud watch marker", error instanceof Error ? error.message : String(error));
      await this.appendSyncLog("remote-markers-error", this.errorDetails(error));
    }
  }

  // -------------------------------------------------------------------------
  // Commands & vault events
  // -------------------------------------------------------------------------

  private registerCommands() {
    this.addCommand({
      id: "sync-now",
      name: "Sync now",
      icon: "refresh-cw",
      callback: () => void this.syncNow(true)
    });
    this.addCommand({
      id: "show-sync-progress",
      name: "Show sync progress",
      icon: "list-checks",
      callback: () => this.openProgressModal()
    });
    this.addCommand({
      id: "show-failed-files",
      name: "Show files that failed to sync",
      icon: "alert-circle",
      callback: () => this.openSyncFailuresModal()
    });
    this.addCommand({
      id: "open-sync-log",
      name: "Open sync log",
      icon: "scroll-text",
      callback: () => this.openSyncLogModal()
    });
    this.addCommand({
      id: "connect-google-drive",
      name: "Connect Google Drive",
      callback: () => void this.connectGoogleDrive().catch((error) => new Notice(error instanceof Error ? error.message : String(error)))
    });
    this.addCommand({
      id: "disconnect-google-drive",
      name: "Disconnect Google Drive",
      checkCallback: (checking) => {
        if (!this.getStoredAuth()) return false;
        if (!checking) void this.disconnectGoogleDrive();
        return true;
      }
    });
    this.addCommand({
      id: "open-daily-note-after-sync",
      name: "Sync, then open today's daily note",
      icon: "calendar-check",
      callback: () => void this.openDailyNoteSafely()
    });
    this.addCommand({
      id: "clean-remote-duplicates",
      name: "Clean up leftover files in Google Drive",
      callback: () => void this.cleanRemoteDuplicates()
    });
    this.addCommand({
      id: "reset-local-sync-index",
      name: "Forget the sync state of this device",
      callback: () => void this.resetLocalSyncIndex()
    });
  }

  private registerVaultEvents() {
    const handle = (file: TAbstractFile | null, extraPath?: string) => {
      const path = file?.path;
      const paths = [path, extraPath].filter((value): value is string => !!value);
      const relevant = paths.filter((candidate) => !this.isExcludedPath(candidate));
      if (paths.length > 0 && relevant.length === 0) return;
      if (this.isBusy()) {
        for (const candidate of relevant) this.pendingEventPaths.add(candidate);
        return;
      }
      if (Date.now() < this.ignoreOwnWritesUntil && relevant.every((candidate) => this.recentOwnWrites.has(candidate))) return;
      for (const candidate of relevant) this.dirtyPaths.add(candidate);
      this.scheduleAutoSync();
    };
    this.registerEvent(this.app.vault.on("create", (file) => handle(file)));
    this.registerEvent(this.app.vault.on("modify", (file) => handle(file)));
    this.registerEvent(this.app.vault.on("delete", (file) => handle(file)));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => handle(file, oldPath)));
  }

  /** Phones freeze Obsidian in the background, so timers alone miss the moments around an app switch. */
  private registerMobileLifecycle() {
    if (!Platform.isMobile) return;
    this.registerDomEvent(activeDocument, "visibilitychange", () => {
      if (activeDocument.visibilityState === "hidden") this.handleAppHidden();
      else this.handleAppResumed();
    });
    this.registerDomEvent(window, "online", () => this.handleAppResumed());
  }

  /** Sends edits waiting for the debounce right away: the system may freeze the app before the timer fires. */
  private handleAppHidden() {
    if (this.debounceTimer === undefined) return;
    window.clearTimeout(this.debounceTimer);
    this.debounceTimer = undefined;
    void this.syncNow();
  }

  private handleAppResumed() {
    if (Date.now() - this.lastResumeCheckAt < RESUME_CHECK_MIN_INTERVAL_MS) return;
    this.lastResumeCheckAt = Date.now();
    if (this.dirtyPaths.size > 0 || (this.pluginData.offlineQueue?.length ?? 0) > 0) this.scheduleAutoSync();
    else if (this.settings.cloudWatchEnabled) void this.checkCloudForChanges();
  }

  private isExcludedPath(path: string): boolean {
    return path.startsWith(".sync/")
      || path.startsWith(".trash/")
      || path.startsWith(`${this.pluginDir}/`)
      || isIgnored(path, ignoredPatternsFromSettings(this.settings.ignoredPaths));
  }

  // -------------------------------------------------------------------------
  // Identity & first sync
  // -------------------------------------------------------------------------

  private getVaultId(): string {
    if (this.pluginData.vaultId) return this.pluginData.vaultId;
    const vaultId = randomHex(16);
    this.pluginData.vaultId = vaultId;
    void this.savePluginData({ vaultId });
    return vaultId;
  }

  private getDeviceId(): string {
    if (this.pluginData.deviceId) return this.pluginData.deviceId;
    const deviceId = randomHex(12);
    this.pluginData.deviceId = deviceId;
    void this.savePluginData({ deviceId });
    return deviceId;
  }

  private getDeviceName(): string {
    return this.settings.deviceName.trim() || `Device ${this.getDeviceId().slice(0, 6)}`;
  }

  private ensureDeviceIdentity() {
    const deviceId = this.getDeviceId();
    if (!this.settings.deviceName.trim()) {
      const kind = Platform.isMobile ? (Platform.isTablet ? "Tablet" : "Phone") : Platform.isMacOS ? "Mac" : Platform.isWin ? "Windows PC" : "Computer";
      this.settings.deviceName = `${kind} ${deviceId.slice(0, 4)}`;
      void this.saveSettings();
    }
  }

  private requireConnected() {
    if (!this.getStoredAuth()) throw new Error("Connect Google Drive first.");
  }

  isInitialSyncCompleted(): boolean {
    return this.pluginData.initialSyncCompleted === true;
  }

  async promptForInitialSyncIfNeeded() {
    if (!this.getStoredAuth() || this.isInitialSyncCompleted()) return;
    const direction = await chooseInitialSyncDirection(this.app);
    if (!direction) {
      new Notice("Syncing is paused until you choose how to start. You can do it later in the Drive Vault Sync settings.");
      this.onConnectionChange?.();
      return;
    }
    await this.runInitialSync(direction);
  }

  async runInitialSync(direction: InitialSyncDirection) {
    if (!this.getStoredAuth()) {
      new Notice("Connect Google Drive first.");
      await this.setSyncStatus({ state: "disconnected" });
      return;
    }
    if (this.isInitialSyncCompleted()) {
      new Notice("This device is already syncing.");
      return;
    }
    if (direction === "local-to-cloud") {
      const confirmed = await confirmDangerAction(
        this.app,
        "Upload this vault to Google Drive?",
        "If the Google Drive folder already contains a vault from another device, it is replaced by this one (the old files are backed up first and moved to the Google Drive trash).",
        "Upload this vault"
      );
      if (confirmed) await this.resetCloudFromLocal();
      return;
    }
    const localOnlyPaths = await this.listLocalOnlyPaths();
    if (localOnlyPaths.length > 0) {
      const keepPaths = await chooseLocalFilesToKeep(this.app, localOnlyPaths);
      if (keepPaths === null) {
        new Notice("Syncing is paused until you choose how to start. You can do it later in the Drive Vault Sync settings.");
        this.onConnectionChange?.();
        return;
      }
      await this.resetLocalFromCloud(keepPaths);
      return;
    }
    await this.resetLocalFromCloud([]);
  }

  private async markInitialSyncCompleted() {
    if (this.pluginData.initialSyncCompleted) return;
    await this.savePluginData({ initialSyncCompleted: true });
    this.normalUploadUnlocked = true;
    await this.rememberCurrentRemoteMarkers();
    this.configureTimers();
    this.onConnectionChange?.();
  }

  // -------------------------------------------------------------------------
  // Status, progress & reports
  // -------------------------------------------------------------------------

  private async setSyncStatus(status: SyncStatus) {
    await this.savePluginData({ syncStatus: status });
    this.updateStatusBar();
    this.requestStatusRefresh();
  }

  private handleStatusBarClick() {
    if (this.syncEngine?.getProgress().active || !this.getStoredAuth() || !this.isInitialSyncCompleted()) {
      if (!this.getStoredAuth() || !this.isInitialSyncCompleted()) {
        void this.promptForInitialSyncIfNeeded();
        if (!this.getStoredAuth()) new Notice("Open Settings → Drive Vault Sync to connect Google Drive.");
        return;
      }
      this.openProgressModal();
      return;
    }
    void this.syncNow(true);
  }

  openProgressModal() {
    if (this.progressModal) {
      this.progressModal.render(this.syncEngine.getProgress());
      return;
    }
    if (isDecisionModalOpen()) {
      new Notice("Finish the open sync dialog first.");
      return;
    }
    this.progressModal = new SyncProgressModal(
      this.app,
      this.syncEngine.getProgress(),
      () => { this.progressModal = undefined; },
      { openFailures: () => this.openSyncFailuresModal() }
    );
    this.progressModal.open();
  }

  openSyncFailuresModal() {
    new SyncFailuresModal(this.app, {
      getFailures: () => this.getSyncFailures(),
      clearOne: (path) => this.clearSyncFailure(path),
      clearAll: () => this.clearSyncFailures(),
      retry: () => void this.syncNow(true)
    }).open();
  }

  openSyncLogModal() {
    new SyncLogModal(this.app, () => this.buildSyncLogReport()).open();
  }

  private handleProgressUpdate(state: SyncProgressState) {
    this.updateStatusBar();
    this.updateMobileProgressNotice(state);
    this.progressModal?.render(state);
    this.requestStatusRefresh();
  }

  /** Phones have no status bar, so syncs that transfer files report their progress in a notice. */
  private updateMobileProgressNotice(state: SyncProgressState) {
    if (!Platform.isMobile) return;
    if (!state.active || this.progressModal) {
      this.mobileProgressNotice?.hide();
      this.mobileProgressNotice = undefined;
      return;
    }
    if (state.total === 0) return;
    const message = `Syncing with Google Drive: ${state.completed} of ${state.total}`;
    if (this.mobileProgressNotice) this.mobileProgressNotice.setMessage(message);
    else this.mobileProgressNotice = new Notice(message, 0);
  }

  /** Throttles settings-tab refreshes to one per animation frame. */
  private requestStatusRefresh() {
    if (!this.onStatusChange || this.statusRefreshQueued) return;
    this.statusRefreshQueued = true;
    window.requestAnimationFrame(() => {
      this.statusRefreshQueued = false;
      this.onStatusChange?.();
    });
  }

  private updateStatusBar() {
    const connected = this.getStoredAuth() !== undefined;
    const progress = this.syncEngine?.getProgress();
    const syncing = progress?.active === true;
    const status = this.pluginData.syncStatus;
    const state = !connected ? "disconnected" : syncing ? "syncing" : status?.state === "error" ? "error" : "idle";
    const failures = this.getSyncFailures().length;
    const allSynced = state === "idle" && !!status?.lastFinishedAt && failures === 0 && (status.lastSummary?.errors ?? 0) === 0;

    let icon = "cloud";
    let text = "";
    let label = "Google Drive: click to sync";
    if (state === "disconnected") {
      icon = "cloud-off";
      label = "Google Drive: not connected — open the settings to connect";
    } else if (state === "syncing" && progress) {
      icon = "refresh-cw";
      if (progress.stage === "scanning" && progress.stageTotal > 0) text = `${progressPercent(progress)}%`;
      else if (progress.total > 0) text = `${progress.completed}/${progress.total}`;
      label = `${progress.operation}: ${progress.stageDetail || STAGE_LABELS[progress.stage]} — click for details`;
    } else if (state === "error") {
      icon = "alert-circle";
      text = "Sync error";
      label = `Google Drive: ${status?.lastError ?? "sync failed"} — click to retry`;
    } else if (!this.isInitialSyncCompleted()) {
      icon = "cloud-cog";
      label = "Google Drive: choose how this device starts syncing";
    } else if (failures > 0) {
      icon = "alert-triangle";
      text = `${failures}`;
      label = `Google Drive: ${failures} file${failures === 1 ? "" : "s"} could not be synced — click to sync again`;
    } else if (allSynced) {
      icon = "check-circle";
      label = `Google Drive: everything synced${status?.lastFinishedAt ? ` (${new Date(status.lastFinishedAt).toLocaleTimeString()})` : ""} — click to sync again`;
    }

    if (this.statusBarEl) {
      this.statusBarEl.empty();
      this.statusBarEl.toggleClass("is-syncing", state === "syncing");
      this.statusBarEl.toggleClass("is-error", state === "error");
      const iconEl = this.statusBarEl.createSpan("dvs-status-bar-icon");
      setIcon(iconEl, icon);
      if (text) this.statusBarEl.createSpan({ text, cls: "dvs-status-bar-text" });
      this.statusBarEl.setAttribute("aria-label", label);
    }
    if (this.ribbonEl) {
      setIcon(this.ribbonEl, icon);
      this.ribbonEl.toggleClass("dvs-ribbon-syncing", state === "syncing");
      this.ribbonEl.setAttribute("aria-label", label);
    }
  }

  private async recordSyncSuccess(summary: SyncSummary) {
    await this.rememberCurrentRemoteMarkers();
    await this.setSyncStatus({
      state: "idle",
      lastStartedAt: summary.startedAt,
      lastFinishedAt: summary.finishedAt,
      lastDurationMs: summary.durationMs,
      lastSummary: summary
    });
  }

  private async recordSyncError(error: unknown) {
    await this.setSyncStatus({
      state: "error",
      lastStartedAt: this.pluginData.syncStatus?.lastStartedAt,
      lastFinishedAt: Date.now(),
      lastError: error instanceof Error ? error.message : String(error),
      lastSummary: this.pluginData.syncStatus?.lastSummary
    });
  }

  getSyncFailures(): SyncFailureEntry[] {
    return this.pluginData.syncFailures ?? [];
  }

  async clearSyncFailures() {
    await this.savePluginData({ syncFailures: [] });
    this.updateStatusBar();
    this.requestStatusRefresh();
  }

  async clearSyncFailure(path: string) {
    await this.savePluginData({ syncFailures: this.getSyncFailures().filter((entry) => entry.path !== path) });
    this.updateStatusBar();
    this.requestStatusRefresh();
  }

  /** Adds new failures and clears entries for files that were attempted again and succeeded. */
  private async recordSyncFailures(failures: TransferFailure[], attemptedPaths: string[], operation: string) {
    const existing = this.getSyncFailures();
    if (existing.length === 0 && failures.length === 0) return;
    const now = Date.now();
    const attempted = new Set(attemptedPaths);
    const failedNow = new Set(failures.map((failure) => failure.path));
    const kept = existing.filter((entry) => !attempted.has(entry.path) || failedNow.has(entry.path));
    const byPath = new Map(kept.map((entry) => [entry.path, { ...entry }]));
    for (const failure of failures) {
      const entry = byPath.get(failure.path);
      if (entry) {
        entry.error = failure.error;
        entry.operation = operation;
        entry.lastFailedAt = now;
        entry.count += 1;
      } else {
        byPath.set(failure.path, { path: failure.path, error: failure.error, operation, firstFailedAt: now, lastFailedAt: now, count: 1 });
      }
    }
    const next = Array.from(byPath.values()).sort((a, b) => b.lastFailedAt - a.lastFailedAt).slice(0, 200);
    await this.savePluginData({ syncFailures: next });
    this.updateStatusBar();
    this.requestStatusRefresh();
  }

  private async buildSyncLogReport(): Promise<string> {
    const status = this.pluginData.syncStatus;
    const progress = this.syncEngine?.getProgress();
    const settings = this.settings;
    const lines: string[] = [];
    const iso = (value?: number) => (value ? new Date(value).toISOString() : "—");
    const row = (label: string, value: string | number | boolean | undefined | null) => lines.push(`${label}: ${value === undefined || value === null || value === "" ? "—" : String(value)}`);

    lines.push("=== Drive Vault Sync — sync log ===");
    row("Generated", new Date().toISOString());
    row("Plugin version", this.manifest.version);
    row("Platform", Platform.isMobile ? "mobile" : "desktop");
    row("Device name", this.getDeviceName());
    row("Log session id", this.logSessionId);
    lines.push("", "--- Runtime state ---");
    row("Connected", this.getStoredAuth() !== undefined);
    row("Account", this.accountLabel);
    row("Initial sync completed", this.isInitialSyncCompleted());
    row("Sync running (plugin lock)", this.syncRunning);
    row("Sync engine running", this.syncEngine?.isRunning() ?? false);
    row("Startup sync running", this.startupSyncRunning);
    row("Cloud watch running", this.cloudWatchRunning);
    row("Normal upload unlocked", this.normalUploadUnlocked);
    row("Dirty paths queued", this.dirtyPaths.size);
    row("Edits waiting for the next sync", this.pendingEventPaths.size);
    row("Full-sync timer active", this.syncTimer !== undefined);
    row("Cloud-watch timer active", this.cloudWatchTimer !== undefined);
    row("Debounce timer active", this.debounceTimer !== undefined);
    row("Offline queue operations", this.pluginData.offlineQueue?.length ?? 0);
    row("Remote reset commands applied", this.pluginData.appliedCommandIds?.length ?? 0);
    row("Cloud index marker", this.pluginData.lastRemoteManifestVersion);
    lines.push("", "--- Last sync status ---");
    row("State", status?.state);
    row("Last started", iso(status?.lastStartedAt));
    row("Last finished", iso(status?.lastFinishedAt));
    row("Last duration", status?.lastDurationMs !== undefined ? `${(status.lastDurationMs / 1000).toFixed(1)}s` : undefined);
    row("Last error", status?.lastError);
    if (status?.lastSummary) {
      const summary = status.lastSummary;
      row("Last summary", `${summary.uploads} uploads, ${summary.downloads} downloads, ${summary.localDeletes} local deletes, ${summary.remoteDeletes} remote deletes, ${summary.conflicts} conflicts, ${summary.errors} errors${summary.command ? ` (command: ${summary.command})` : ""}`);
    }
    lines.push("", "--- Progress ---");
    if (progress) {
      row("Operation", progress.operation);
      row("Active", progress.active);
      row("Stage", `${progress.stage} — ${progress.stageDetail}`);
      row("Completed / total", `${progress.completed} / ${progress.total} (${progressPercent(progress)}%)`);
      row("Counts", Object.entries(progress.counts).filter(([, value]) => value > 0).map(([key, value]) => `${key} ${value}`).join(", "));
      if (progress.error) row("Error", progress.error);
      if (progress.items.length > 0) {
        lines.push("Recent items:");
        for (const item of progress.items.slice(0, 60)) lines.push(`  [${item.status}] ${item.kind} — ${item.path}${item.detail ? ` (${item.detail})` : ""}`);
      }
    } else {
      lines.push("(progress tracker unavailable)");
    }
    lines.push("", "--- Settings (secrets excluded) ---");
    row("Remote folder", settings.remoteFolderName);
    row("Auto sync local changes", settings.autoSyncEnabled);
    row("Sync on startup", settings.syncOnStartup);
    row("Full sync fallback", `${settings.fullSyncFallbackEnabled} / every ${settings.syncIntervalMinutes} min`);
    row("Cloud watch", `${settings.cloudWatchEnabled} / every ${settings.cloudWatchIntervalSeconds} s`);
    row("Sync delay after edits", `${settings.syncDebounceSeconds} s`);
    row("Conflict policy", settings.conflictPolicy);
    row("Backups", `${settings.backupEnabled} / mode ${settings.backupMode} / keep ${settings.maxBackups} / interval ${settings.backupIntervalMinutes} min`);
    row("Request concurrency", settings.requestConcurrency);
    row("Max deletion percent", settings.maxDeletionPercent);
    row("Debug mode", settings.debugMode);
    row("OAuth client id set", !!settings.clientId);
    row("OAuth client secret set", !!settings.clientSecret);
    row("Ignored path entries", settings.ignoredPaths.split(/\r?\n/).filter((line) => line.trim().length > 0).length);
    lines.push("");
    const failures = this.getSyncFailures();
    lines.push(`--- Files that failed to sync (${failures.length}) ---`);
    if (failures.length === 0) lines.push("(none)");
    for (const failure of failures.slice(0, 100)) {
      lines.push(`- ${failure.path} [${failure.operation}, ${failure.count}×, last ${iso(failure.lastFailedAt)}]`);
      lines.push(`  ${failure.error.replace(/\n/g, " ")}`);
    }
    lines.push("", `--- Recent activity (${SYNC_LOG_PATH}) ---`);
    await this.flushSyncLog().catch(() => undefined);
    let logText = "";
    try {
      logText = await this.app.vault.adapter.read(SYNC_LOG_PATH);
    } catch {
      logText = "";
    }
    const tail = logText.split(/\r?\n/).filter((line) => line.length > 0).slice(-200).join("\n");
    lines.push(tail || "(no activity logged yet)");
    return lines.join("\n");
  }

  private async appendSyncLog(message: string, details?: unknown): Promise<void> {
    const suffix = details === undefined ? "" : ` ${sanitizeLogValue(details)}`;
    this.pendingLogLines.push(`${new Date().toISOString()} [${this.logSessionId}] ${message}${suffix}\n`);
    if (this.logFlushTimer === undefined) {
      this.logFlushTimer = window.setTimeout(() => {
        this.logFlushTimer = undefined;
        void this.flushSyncLog();
      }, 1000);
    }
  }

  private async flushSyncLog(): Promise<void> {
    if (this.pendingLogLines.length === 0) return;
    const lines = this.pendingLogLines;
    this.pendingLogLines = [];
    try {
      if (!(await this.app.vault.adapter.exists(".sync"))) await this.app.vault.adapter.mkdir(".sync");
      if (this.logCache === undefined) {
        try {
          this.logCache = await this.app.vault.adapter.read(SYNC_LOG_PATH);
        } catch {
          this.logCache = "";
        }
      }
      let next = `${this.logCache}${lines.join("")}`;
      if (next.length > MAX_SYNC_LOG_BYTES) {
        next = next.slice(-MAX_SYNC_LOG_BYTES);
        const firstNewline = next.indexOf("\n");
        if (firstNewline >= 0) next = next.slice(firstNewline + 1);
        next = `${new Date().toISOString()} [${this.logSessionId}] log-truncated\n${next}`;
      }
      this.logCache = next;
      await this.app.vault.adapter.write(SYNC_LOG_PATH, next);
    } catch (error) {
      console.warn("[Drive Vault Sync] Could not write the sync log", error);
    }
  }

  private errorDetails(error: unknown): Record<string, string | undefined> {
    return {
      name: error instanceof Error ? error.name : undefined,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    };
  }
}

function randomHex(bytes: number): string {
  const values = new Uint8Array(bytes);
  crypto.getRandomValues(values);
  return Array.from(values).map((value) => value.toString(16).padStart(2, "0")).join("");
}

/**
 * Base snapshots are only used to merge Markdown notes. Older versions also stored them for every
 * other text file, which made the plugin data file very large — drop those on load.
 */
function trimIndexSnapshots(index: Record<string, SyncIndexEntry>): Record<string, SyncIndexEntry> {
  const trimmed: Record<string, SyncIndexEntry> = {};
  for (const [path, entry] of Object.entries(index)) {
    if (entry.baseSnapshot !== undefined && !path.toLowerCase().endsWith(".md")) {
      const { baseSnapshot: _snapshot, baseSnapshotHash: _hash, ...rest } = entry;
      trimmed[path] = rest;
    } else {
      trimmed[path] = entry;
    }
  }
  return trimmed;
}
