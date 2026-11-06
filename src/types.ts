export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";

export type DriveVaultSyncSettings = {
  clientId: string;
  clientSecret: string;
  deviceName: string;
  conflictPolicy: ConflictPolicy;
  remoteFolderName: string;
  autoSyncEnabled: boolean;
  fullSyncFallbackEnabled: boolean;
  syncOnStartup: boolean;
  syncIntervalMinutes: number;
  cloudWatchEnabled: boolean;
  cloudWatchIntervalSeconds: number;
  syncDebounceSeconds: number;
  requestConcurrency: number;
  maxDeletionPercent: number;
  ignoredPaths: string;
  debugMode: boolean;
  backupEnabled: boolean;
  backupMode: BackupMode;
  backupIntervalMinutes: number;
  maxBackups: number;
};

export type StoredAuth = {
  access_token: string;
  refresh_token?: string;
  expires_at: number;
  scope?: string;
  token_type?: string;
};

export type ConflictPolicy = "keep-both" | "prefer-local" | "prefer-remote";
export type InitialSyncDirection = "cloud-to-local" | "local-to-cloud";
export type BackupMode = "safety-only" | "timed" | "every-sync";

export type SyncStatusState = "disconnected" | "idle" | "syncing" | "error";

export type SyncSummary = {
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
  uploads: number;
  downloads: number;
  localDeletes: number;
  remoteDeletes: number;
  conflicts: number;
  errors: number;
  command?: string;
};

export type SyncStatus = {
  state: SyncStatusState;
  lastStartedAt?: number;
  lastFinishedAt?: number;
  lastDurationMs?: number;
  lastError?: string;
  lastSummary?: SyncSummary;
};

export type SyncIndexEntry = {
  path: string;
  lastSyncedHash: string;
  lastSyncedRemoteId?: string;
  lastSyncedRemoteRevision?: string;
  lastSyncedAt: number;
  baseSnapshot?: string;
  baseSnapshotHash?: string;
  deleted?: boolean;
};

export type SyncRecord = {
  path: string;
  fileId?: string;
  lastKnownRemoteHash: string | null;
  lastKnownLocalHash: string | null;
  lastSyncTime: number;
  lastRemoteModified: number | null;
  lastLocalModified: number | null;
  /** Byte size of the file as of lastLocalModified — paired with it to validate the scan cache. */
  lastLocalSize: number | null;
  deleted: boolean;
  deviceId: string;
};

export type LocalSyncManifest = {
  version: 1;
  deviceId: string;
  updatedAt: number;
  records: Record<string, SyncRecord>;
};

export type SyncQueueItem = {
  id: string;
  type: "upload" | "delete" | "rename";
  path: string;
  createdAt: number;
  deviceId: string;
  targetPath?: string;
};

export type LocalFile = LocalFileMeta & {
  content: string | ArrayBuffer;
};

export type RemoteMetadata = {
  path: string;
  fileId?: string;
  hash: string | null;
  size?: number;
  modifiedTime: number | null;
  revision?: string;
  deleted: boolean;
  deviceId?: string;
};

export type RemoteChange = RemoteMetadata;

export type RemoteFile = RemoteMetadata & {
  content: string | ArrayBuffer;
  isText: boolean;
};

export type RemoteManifest = {
  version: 1;
  vaultId: string;
  updatedAt: number;
  files: Record<string, RemoteFileMeta>;
  command?: RemoteSyncCommand;
  snapshots?: RemoteSnapshotMeta[];
  backups?: BackupMeta[];
  manualBackups?: BackupMeta[];
};

export type RemoteSyncCommand = {
  id: string;
  type: "replace-local-from-cloud";
  createdAt: number;
  createdByDeviceId: string;
  createdByDeviceName: string;
};

export type RemoteSnapshotMeta = {
  id: string;
  name: string;
  fileId: string;
  createdAt: number;
  createdByDeviceId: string;
  createdByDeviceName: string;
};

export type BackupFileEntry = {
  driveFileId: string;
  hash: string;
  size: number;
  mtime?: number;
};

export type BackupFileSource = BackupFileEntry & {
  content: string | ArrayBuffer;
  mimeType: string;
};

export type BackupMeta = {
  id: string;
  fileId: string;
  folderId?: string;
  name: string;
  label?: string;
  kind?: "auto" | "manual";
  createdAt: number;
  deviceName: string;
  changedCount: number;
  deletedCount: number;
};

export type BackupData = {
  v: 1;
  id: string;
  createdAt: number;
  deviceName: string;
  label?: string;
  kind?: "auto" | "manual";
  /** True for backups that store independent copies of file contents instead of live synced file IDs */
  snapshotFiles?: boolean;
  /** Only files whose hash changed compared to the previous backup / last known state */
  changedFiles: Record<string, BackupFileEntry>;
  /** Paths that were deleted in this sync */
  deletedPaths: string[];
};

export type RemoteFileMeta = {
  path: string;
  driveFileId: string;
  hash: string;
  size: number;
  mtime?: number;
  revision?: string;
  deleted: boolean;
  updatedAt: number;
  deletedAt?: number;
  deviceId?: string;
  deviceName?: string;
};

export type SyncFailureEntry = {
  path: string;
  error: string;
  operation: string;
  firstFailedAt: number;
  lastFailedAt: number;
  count: number;
};

export type PluginData = {
  auth?: StoredAuth;
  index?: Record<string, SyncIndexEntry>;
  localManifest?: LocalSyncManifest;
  offlineQueue?: SyncQueueItem[];
  vaultId?: string;
  deviceId?: string;
  appliedCommandIds?: string[];
  initialSyncCompleted?: boolean;
  syncStatus?: SyncStatus;
  lastRemoteUpdatedAt?: number;
  lastRemoteCommandId?: string;
  /** Cheap change marker of the remote index file (Drive `version`), used by cloud watch. */
  lastRemoteManifestVersion?: string;
  syncFailures?: SyncFailureEntry[];
};

export type StoredPluginData = PluginData & {
  settings?: Partial<DriveVaultSyncSettings>;
};

export type LocalFileMeta = {
  path: string;
  hash: string;
  size: number;
  extension: string;
  mtime?: number;
  isText: boolean;
};

export type RemoteState = {
  rootFolderId: string;
  filesFolderId: string;
  manifestFileId?: string;
  manifest: RemoteManifest;
};

export type RemoteCleanupCandidate = {
  id: string;
  path: string;
  name: string;
  modifiedTime: number | null;
  size?: number;
  reason: "duplicate" | "orphan";
  keptFileId?: string;
};

export type PlannedDeletion = {
  path: string;
  direction: "local" | "remote";
};

/** What a single progress row represents. */
export type SyncActivityKind =
  | "upload"
  | "download"
  | "delete-local"
  | "delete-remote"
  | "rename"
  | "merge"
  | "conflict"
  | "backup";
/** @deprecated kept as an alias for older call sites. */
export type SyncProgressDirection = SyncActivityKind;
export type SyncProgressItemStatus = "active" | "done" | "error" | "skipped";

export type SyncProgressItem = {
  path: string;
  kind: SyncActivityKind;
  status: SyncProgressItemStatus;
  startedAt: number;
  finishedAt?: number;
  /** Extra context, e.g. the new path of a rename or an error message. */
  detail?: string;
};

/** Ordered high-level steps of a sync run, shown as a checklist in the progress window. */
export type SyncStage = "remote" | "scanning" | "planning" | "transferring" | "backup" | "saving";

export type SyncActivityCounts = Record<SyncActivityKind | "error", number>;

export type SyncProgressState = {
  active: boolean;
  /** Human title of the running operation, e.g. "Sync" or "Restore from backup". */
  operation: string;
  stage: SyncStage;
  /** Stages this operation goes through, in order. */
  stages: SyncStage[];
  /** Short description of what is happening right now. */
  stageDetail: string;
  /** Item counter for the current stage (files scanned, files transferred...). */
  stageCompleted: number;
  stageTotal: number;
  /** Files transferred so far and the expected total for the whole run. */
  total: number;
  completed: number;
  counts: SyncActivityCounts;
  items: SyncProgressItem[];
  startedAt?: number;
  /** When the first file operation of this run started (used for the time estimate). */
  transferStartedAt?: number;
  finishedAt?: number;
  /** Set when the last run ended with an error. */
  error?: string;
};

export type ManualConflictDetails = {
  path: string;
  localText: string;
  remoteText: string;
  deviceName: string;
  modifiedAt: number | null;
  changeCount: number;
};

export type ManualConflictChoice = "keep-local" | "keep-remote" | "keep-both" | "cancel";
export type RemoteDeleteConflictChoice = "keep-local" | "delete-local" | "cancel";

export function defaultIgnoredPaths(configDir: string, pluginDir?: string): string {
  const normalizedConfigDir = configDir.replace(/\/+$/, "");
  return [
    `${(pluginDir ?? `${normalizedConfigDir}/plugins/drive-vault-sync`).replace(/\/+$/, "")}/`,
    `${normalizedConfigDir}/workspace.json`,
    `${normalizedConfigDir}/workspace-mobile.json`,
    `${normalizedConfigDir}/cache/`,
    ".sync/",
    ".trash/"
  ].join("\n");
}

export const DEFAULT_SETTINGS: DriveVaultSyncSettings = {
  clientId: "",
  clientSecret: "",
  deviceName: "",
  conflictPolicy: "keep-both",
  remoteFolderName: "ObsidianGoogleDriveSync",
  autoSyncEnabled: true,
  fullSyncFallbackEnabled: true,
  syncOnStartup: true,
  syncIntervalMinutes: 30,
  cloudWatchEnabled: true,
  cloudWatchIntervalSeconds: 30,
  syncDebounceSeconds: 2,
  requestConcurrency: 2,
  maxDeletionPercent: 20,
  ignoredPaths: "",
  debugMode: false,
  backupEnabled: true,
  backupMode: "timed",
  backupIntervalMinutes: 30,
  maxBackups: 10
};
