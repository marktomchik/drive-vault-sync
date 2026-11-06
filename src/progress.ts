import {
  SyncActivityCounts,
  SyncActivityKind,
  SyncProgressItem,
  SyncProgressItemStatus,
  SyncProgressState,
  SyncStage
} from "./types";

/** How many recent rows are kept for the progress window. Older rows are dropped. */
const MAX_ITEMS = 300;
/** Scanning reports progress for every file; throttle listener calls while it runs. */
const SCAN_EMIT_THROTTLE_MS = 120;

export const STAGE_LABELS: Record<SyncStage, string> = {
  remote: "Read the cloud index",
  scanning: "Check this vault for changes",
  planning: "Compare this vault with the cloud",
  transferring: "Transfer files",
  backup: "Create a backup",
  saving: "Save the sync state"
};

export const DEFAULT_STAGES: SyncStage[] = ["remote", "scanning", "planning", "transferring", "backup", "saving"];

function emptyCounts(): SyncActivityCounts {
  return {
    upload: 0,
    download: 0,
    "delete-local": 0,
    "delete-remote": 0,
    rename: 0,
    merge: 0,
    conflict: 0,
    backup: 0,
    error: 0
  };
}

/**
 * Collects everything a sync run does — the current step, per-file activity and counters —
 * so the status bar and the progress window can show live progress.
 */
export class SyncProgressTracker {
  private state: SyncProgressState = {
    active: false,
    operation: "Sync",
    stage: "remote",
    stages: DEFAULT_STAGES,
    stageDetail: "",
    stageCompleted: 0,
    stageTotal: 0,
    total: 0,
    completed: 0,
    counts: emptyCounts(),
    items: []
  };
  private lastScanEmitAt = 0;

  constructor(private onChange: (state: SyncProgressState) => void) {}

  /** Starts a new run. The previous run's rows stay visible until this is called. */
  begin(operation = "Sync", stages: SyncStage[] = DEFAULT_STAGES): void {
    this.state = {
      active: true,
      operation,
      stage: stages[0] ?? "remote",
      stages,
      stageDetail: "Connecting to Google Drive…",
      stageCompleted: 0,
      stageTotal: 0,
      total: 0,
      completed: 0,
      counts: emptyCounts(),
      items: [],
      startedAt: Date.now()
    };
    this.emit();
  }

  /** Moves to another step. Steps that are not part of this operation are added on the fly. */
  setStage(stage: SyncStage, detail: string, total = 0): void {
    if (!this.state.stages.includes(stage)) {
      const order = DEFAULT_STAGES;
      this.state.stages = [...this.state.stages, stage].sort((a, b) => order.indexOf(a) - order.indexOf(b));
    }
    this.state.stage = stage;
    this.state.stageDetail = detail;
    this.state.stageCompleted = 0;
    this.state.stageTotal = total;
    this.emit();
  }

  setDetail(detail: string): void {
    this.state.stageDetail = detail;
    this.emit();
  }

  /** Reports progress while the vault is scanned/hashed. */
  setScanProgress(scanned: number, total: number): void {
    if (this.state.stage !== "scanning") this.setStage("scanning", "Checking this vault for changes…", total);
    this.state.stageCompleted = scanned;
    this.state.stageTotal = total;
    this.state.stageDetail = `Checked ${scanned} of ${total} file${total === 1 ? "" : "s"}`;
    const isFinal = scanned >= total;
    const now = Date.now();
    if (!isFinal && now - this.lastScanEmitAt < SCAN_EMIT_THROTTLE_MS) return;
    this.lastScanEmitAt = now;
    this.emit();
  }

  /** Kept for older call sites: switches to the transfer step. */
  startTransferPhase(): void {
    this.setStage("transferring", "Transferring files…", this.state.total);
  }

  /** Adds work to the expected file total (the progress bar denominator). */
  growTotalBy(extra: number): void {
    if (extra <= 0) return;
    this.state.total += extra;
    if (this.state.stage === "transferring" || this.state.stage === "backup") this.state.stageTotal = this.state.total;
    this.emit();
  }

  /** A file operation has started. */
  start(path: string, kind: SyncActivityKind, detail?: string): void {
    const item: SyncProgressItem = { path, kind, status: "active", startedAt: Date.now(), detail };
    if (this.state.transferStartedAt === undefined) this.state.transferStartedAt = item.startedAt;
    this.state.items.unshift(item);
    if (this.state.items.length > MAX_ITEMS) this.state.items.length = MAX_ITEMS;
    const inFlight = this.state.items.filter((entry) => entry.status === "active").length;
    if (this.state.completed + inFlight > this.state.total) this.state.total = this.state.completed + inFlight;
    this.state.stageDetail = `${activeVerb(kind)} ${path}`;
    this.emit();
  }

  /** The most recent active operation on `path` has finished. */
  finish(path: string, status: SyncProgressItemStatus = "done", detail?: string): void {
    const item = this.state.items.find((entry) => entry.path === path && entry.status === "active");
    if (item) {
      item.status = status;
      item.finishedAt = Date.now();
      if (detail !== undefined) item.detail = detail;
      if (status === "done") this.state.counts[item.kind] += 1;
    }
    if (status === "error") this.state.counts.error += 1;
    this.state.completed += 1;
    if (this.state.total < this.state.completed) this.state.total = this.state.completed;
    this.state.stageCompleted = this.state.completed;
    this.state.stageTotal = this.state.total;
    this.emit();
  }

  /** Records an operation that happened instantly (no separate start/finish). */
  markDone(path: string, kind: SyncActivityKind, detail?: string): void {
    this.start(path, kind, detail);
    this.finish(path, "done");
  }

  /**
   * Marks the latest operation on `path` as failed. If nothing was in flight for that path
   * (the error happened before a transfer started), a new failed row is added instead.
   */
  fail(path: string, message: string, kind: SyncActivityKind = "upload"): void {
    const active = this.state.items.find((entry) => entry.path === path && entry.status === "active");
    if (active) {
      this.finish(path, "error", message);
      return;
    }
    const recent = this.state.items.find((entry) => entry.path === path);
    if (recent && recent.status === "error") {
      recent.detail = message;
      this.emit();
      return;
    }
    this.note(path, kind, "error", message);
  }

  /** Records a non-file event (e.g. a cancelled conflict) without touching the file counter. */
  note(path: string, kind: SyncActivityKind, status: SyncProgressItemStatus, detail?: string): void {
    this.state.items.unshift({ path, kind, status, startedAt: Date.now(), finishedAt: Date.now(), detail });
    if (this.state.items.length > MAX_ITEMS) this.state.items.length = MAX_ITEMS;
    if (status === "error") this.state.counts.error += 1;
    else if (status === "done") this.state.counts[kind] += 1;
    this.emit();
  }

  end(error?: string): void {
    this.state.active = false;
    this.state.finishedAt = Date.now();
    this.state.error = error;
    if (this.state.total < this.state.completed) this.state.total = this.state.completed;
    for (const item of this.state.items) {
      if (item.status === "active") {
        item.status = error ? "error" : "skipped";
        item.finishedAt = Date.now();
      }
    }
    this.emit();
  }

  getState(): SyncProgressState {
    return this.state;
  }

  private emit(): void {
    this.onChange(this.state);
  }
}

export function progressPercent(state: SyncProgressState): number {
  if (state.stage === "scanning" && state.active) {
    return state.stageTotal > 0 ? Math.min(100, Math.round((state.stageCompleted / state.stageTotal) * 100)) : 0;
  }
  if (state.total <= 0) return state.active ? 0 : 100;
  return Math.min(100, Math.round((state.completed / state.total) * 100));
}

/** True when the bar should animate instead of showing a fixed percentage. */
export function isIndeterminate(state: SyncProgressState): boolean {
  if (!state.active) return false;
  if (state.stage === "scanning") return state.stageTotal === 0;
  if (state.stage === "transferring" || state.stage === "backup") return state.total === 0;
  return true;
}

/** Estimated time remaining for file transfers, in milliseconds. */
export function estimateRemainingMs(state: SyncProgressState): number | undefined {
  if (!state.active || state.transferStartedAt === undefined) return undefined;
  if (state.completed < 3 || state.total <= state.completed) return undefined;
  const elapsed = Date.now() - state.transferStartedAt;
  if (elapsed <= 0) return undefined;
  return Math.round((elapsed / state.completed) * (state.total - state.completed));
}

export function activeVerb(kind: SyncActivityKind): string {
  switch (kind) {
    case "upload": return "Uploading";
    case "download": return "Downloading";
    case "delete-local": return "Moving to trash";
    case "delete-remote": return "Deleting from Google Drive";
    case "rename": return "Renaming";
    case "merge": return "Merging";
    case "conflict": return "Resolving conflict in";
    case "backup": return "Backing up";
  }
}

export function doneVerb(kind: SyncActivityKind): string {
  switch (kind) {
    case "upload": return "Uploaded";
    case "download": return "Downloaded";
    case "delete-local": return "Moved to trash";
    case "delete-remote": return "Deleted in cloud";
    case "rename": return "Renamed";
    case "merge": return "Merged";
    case "conflict": return "Conflict";
    case "backup": return "Backed up";
  }
}

export function kindIcon(kind: SyncActivityKind): string {
  switch (kind) {
    case "upload": return "upload";
    case "download": return "download";
    case "delete-local": return "trash-2";
    case "delete-remote": return "cloud-off";
    case "rename": return "pencil";
    case "merge": return "git-merge";
    case "conflict": return "alert-triangle";
    case "backup": return "archive";
  }
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}
