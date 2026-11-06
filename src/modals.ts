import { App, Modal, Notice, Platform, Setting, TFile, setIcon } from "obsidian";
import { DeviceFlowSession } from "./auth";
import { AuthTransferPayload, buildTransferUrl, decryptAuth, encryptAuth, generateQRCodeDataUrl } from "./authTransfer";
import {
  STAGE_LABELS,
  activeVerb,
  doneVerb,
  estimateRemainingMs,
  formatDuration,
  isIndeterminate,
  kindIcon,
  progressPercent
} from "./progress";
import {
  BackupData,
  BackupMeta,
  InitialSyncDirection,
  ManualConflictChoice,
  ManualConflictDetails,
  PlannedDeletion,
  RemoteCleanupCandidate,
  RemoteDeleteConflictChoice,
  StoredAuth,
  SyncFailureEntry,
  SyncProgressItem,
  SyncProgressState
} from "./types";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

let openDecisionModals = 0;

/** True while a dialog that waits for the user's decision (conflict, deletion review...) is open. */
export function isDecisionModalOpen(): boolean {
  return openDecisionModals > 0;
}

/**
 * Opens a modal that resolves a promise exactly once — when a button is pressed or the modal is
 * dismissed (resolving with `dismissValue`).
 */
function decisionModal<T>(
  app: App,
  dismissValue: T,
  build: (modal: Modal, finish: (value: T) => void) => void
): Promise<T> {
  return new Promise((resolve) => {
    const modal = new Modal(app);
    let settled = false;
    openDecisionModals += 1;
    const finish = (value: T, close = true) => {
      if (settled) return;
      settled = true;
      openDecisionModals = Math.max(0, openDecisionModals - 1);
      resolve(value);
      if (close) modal.close();
    };
    modal.modalEl.addClass("dvs-modal");
    build(modal, (value) => finish(value));
    modal.onClose = () => {
      finish(dismissValue, false);
      modal.contentEl.empty();
    };
    modal.open();
  });
}

function intro(container: HTMLElement, text: string): HTMLElement {
  return container.createEl("p", { text, cls: "dvs-intro" });
}

/** Renders a searchable list with "Select all / none" and one toggle per entry. */
function selectableList<T>(
  container: HTMLElement,
  items: T[],
  selected: Set<string>,
  keyOf: (item: T) => string,
  labelOf: (item: T) => string,
  descOf?: (item: T) => string
): void {
  const toolbar = container.createDiv("dvs-list-toolbar");
  const search = toolbar.createEl("input", { type: "search", placeholder: "Filter files…", cls: "dvs-search" });
  const selectAll = toolbar.createEl("button", { text: "Select all" });
  const selectNone = toolbar.createEl("button", { text: "Select none" });
  const counter = container.createDiv("dvs-list-counter");
  const list = container.createDiv("dvs-file-list");
  const visible = () => {
    const query = search.value.toLowerCase();
    return items.filter((item) => labelOf(item).toLowerCase().includes(query));
  };
  const render = () => {
    list.empty();
    counter.setText(`${selected.size} of ${items.length} selected`);
    for (const item of visible()) {
      const setting = new Setting(list).setName(labelOf(item));
      if (descOf) setting.setDesc(descOf(item));
      setting.addToggle((toggle) => toggle.setValue(selected.has(keyOf(item))).onChange((value) => {
        if (value) selected.add(keyOf(item));
        else selected.delete(keyOf(item));
        counter.setText(`${selected.size} of ${items.length} selected`);
      }));
    }
  };
  selectAll.addEventListener("click", () => {
    for (const item of visible()) selected.add(keyOf(item));
    render();
  });
  selectNone.addEventListener("click", () => {
    for (const item of visible()) selected.delete(keyOf(item));
    render();
  });
  search.addEventListener("input", render);
  render();
}

async function copyToClipboard(text: string, successMessage: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    new Notice(successMessage);
  } catch {
    new Notice("Could not copy to the clipboard. Select the text and copy it manually.");
  }
}

function splitPath(path: string): { folder: string; name: string } {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? { folder: "", name: path } : { folder: path.slice(0, slash + 1), name: path.slice(slash + 1) };
}

function relativeTime(timestamp: number): string {
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(timestamp).toLocaleString();
}

// ---------------------------------------------------------------------------
// Google sign-in
// ---------------------------------------------------------------------------

export class DeviceFlowModal extends Modal {
  private timerId?: number;
  private statusEl!: HTMLElement;
  private countdownEl!: HTMLElement;
  private readonly openedAt = Date.now();

  constructor(app: App, private session: DeviceFlowSession, private onCancel: () => void) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    const device = this.session.device;
    const verificationUrl = device.verification_url_complete ?? device.verification_uri_complete ?? device.verification_url ?? device.verification_uri ?? "";
    this.modalEl.addClass("dvs-modal");
    this.titleEl.setText("Connect Google Drive");
    contentEl.empty();

    const steps = contentEl.createEl("ol", { cls: "dvs-steps" });
    steps.createEl("li", { text: "Open the Google page below and sign in with the account that should store your vault." });
    steps.createEl("li", { text: "Enter this code when Google asks for it:" });

    const codeRow = contentEl.createDiv("dvs-user-code-row");
    codeRow.createDiv({ text: device.user_code, cls: "dvs-user-code" });
    const copyButton = codeRow.createEl("button", { text: "Copy code" });
    copyButton.addEventListener("click", () => void copyToClipboard(device.user_code, "Code copied."));

    contentEl.createEl("p", { text: "Then allow access. This window closes by itself once Google confirms.", cls: "dvs-muted" });
    this.countdownEl = contentEl.createEl("p", { cls: "dvs-muted" });
    this.statusEl = contentEl.createDiv("dvs-waiting");
    const spinner = this.statusEl.createSpan("dvs-spinner");
    setIcon(spinner, "loader");
    this.statusEl.createSpan({ text: "Waiting for Google…" });

    new Setting(contentEl)
      .addButton((button) => button.setButtonText("Open Google sign-in page").setCta().onClick(() => window.open(verificationUrl, "_blank")))
      .addButton((button) => button.setButtonText("Cancel").onClick(() => {
        this.session.cancel();
        this.onCancel();
        this.close();
      }));
    this.timerId = window.setInterval(() => this.renderCountdown(), 1000);
    this.renderCountdown();
    this.session.done.then(() => this.close()).catch((error) => {
      this.statusEl.empty();
      this.statusEl.addClass("dvs-error-text");
      this.statusEl.setText(error instanceof Error ? error.message : "Authorization failed.");
    });
  }

  onClose() {
    if (this.timerId !== undefined) window.clearInterval(this.timerId);
    this.contentEl.empty();
  }

  private renderCountdown() {
    const remaining = Math.max(0, Math.ceil((this.session.device.expires_in * 1000 - (Date.now() - this.openedAt)) / 1000));
    this.countdownEl.setText(`The code expires in ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}.`);
  }
}

// ---------------------------------------------------------------------------
// Deletion review
// ---------------------------------------------------------------------------

export class LargeDeletionModal extends Modal {
  private selected = new Set<string>();
  private settled = false;

  constructor(
    app: App,
    private deletions: PlannedDeletion[],
    private percent: number,
    private resolve: (paths: PlannedDeletion[] | null) => void
  ) {
    super(app);
  }

  onOpen() {
    openDecisionModals += 1;
    const { contentEl } = this;
    this.modalEl.addClass("dvs-modal");
    this.titleEl.setText("Review deletions before syncing");
    contentEl.empty();
    const localCount = this.deletions.filter((item) => item.direction === "local").length;
    const remoteCount = this.deletions.length - localCount;
    intro(contentEl, `This sync would delete ${this.deletions.length} files (${this.percent.toFixed(1)}% of everything synced) — that is more than your safety limit, so nothing is deleted until you confirm.`);
    const summary = contentEl.createEl("ul", { cls: "dvs-bullets" });
    if (localCount > 0) summary.createEl("li", { text: `${localCount} on this device (they go to the trash and are backed up first)` });
    if (remoteCount > 0) summary.createEl("li", { text: `${remoteCount} in Google Drive (marked as deleted for your other devices)` });
    intro(contentEl, "Turn on the files you really want to delete. Everything else is left untouched.");
    selectableList(
      contentEl,
      this.deletions,
      this.selected,
      deletionKey,
      (item) => item.path,
      (item) => item.direction === "local" ? "Delete on this device" : "Delete in Google Drive"
    );
    new Setting(contentEl)
      .addButton((button) => button.setButtonText("Delete selected").setWarning().onClick(() => {
        this.settle(this.deletions.filter((item) => this.selected.has(deletionKey(item))));
      }))
      .addButton((button) => button.setButtonText("Keep all files").setCta().onClick(() => this.settle([])))
      .addButton((button) => button.setButtonText("Cancel sync").onClick(() => this.settle(null)));
  }

  onClose() {
    this.settle(null, false);
    this.contentEl.empty();
  }

  private settle(value: PlannedDeletion[] | null, close = true) {
    if (this.settled) return;
    this.settled = true;
    openDecisionModals = Math.max(0, openDecisionModals - 1);
    this.resolve(value);
    if (close) this.close();
  }
}

function deletionKey(deletion: PlannedDeletion): string {
  return `${deletion.direction}:${deletion.path}`;
}

// ---------------------------------------------------------------------------
// Live progress
// ---------------------------------------------------------------------------

type ProgressFilter = "all" | "active" | "errors";

export class SyncProgressModal extends Modal {
  private state: SyncProgressState;
  private filter: ProgressFilter = "all";
  private renderQueued = false;
  private tickTimer?: number;

  constructor(
    app: App,
    initialState: SyncProgressState,
    private onCloseCallback: () => void,
    private actions: { openFailures?: () => void } = {}
  ) {
    super(app);
    this.state = initialState;
  }

  onOpen() {
    this.modalEl.addClass("dvs-modal", "dvs-progress-modal");
    this.renderNow();
    // Keeps the elapsed time / estimate fresh even when no file event arrives.
    this.tickTimer = window.setInterval(() => {
      if (this.state.active) this.render(this.state);
    }, 1000);
  }

  onClose() {
    if (this.tickTimer !== undefined) window.clearInterval(this.tickTimer);
    this.contentEl.empty();
    this.onCloseCallback();
  }

  /** Re-renders at most once per animation frame, so fast syncs do not flood the UI. */
  render(state: SyncProgressState) {
    this.state = state;
    if (this.renderQueued) return;
    this.renderQueued = true;
    window.requestAnimationFrame(() => {
      this.renderQueued = false;
      this.renderNow();
    });
  }

  private renderNow() {
    const state = this.state;
    const { contentEl } = this;
    const scrollTop = contentEl.querySelector(".dvs-activity-list")?.scrollTop ?? 0;
    contentEl.empty();
    this.titleEl.setText(state.active ? `${state.operation} in progress` : state.startedAt ? `${state.operation} — ${state.error ? "stopped" : "finished"}` : "Sync progress");

    if (!state.startedAt) {
      intro(contentEl, "No sync has run since Obsidian started. Progress will appear here as soon as one starts.");
      this.renderFooter(contentEl);
      return;
    }

    this.renderHeader(contentEl, state);
    this.renderStages(contentEl, state);
    this.renderCounters(contentEl, state);
    this.renderActivity(contentEl, state);
    const list = contentEl.querySelector(".dvs-activity-list");
    if (list) list.scrollTop = scrollTop;
    this.renderFooter(contentEl);
  }

  private renderHeader(container: HTMLElement, state: SyncProgressState) {
    const header = container.createDiv("dvs-progress-header");
    const percent = progressPercent(state);
    const indeterminate = isIndeterminate(state);
    const top = header.createDiv("dvs-progress-top");
    const statusIcon = top.createSpan("dvs-progress-status-icon");
    if (state.active) {
      statusIcon.addClass("dvs-spin");
      setIcon(statusIcon, "refresh-cw");
    } else if (state.error) {
      statusIcon.addClass("dvs-error-text");
      setIcon(statusIcon, "alert-circle");
    } else {
      statusIcon.addClass("dvs-success-text");
      setIcon(statusIcon, "check-circle");
    }
    top.createSpan({
      cls: "dvs-progress-headline",
      text: state.active ? state.stageDetail || "Working…" : state.error ? `Stopped: ${state.error}` : finishedHeadline(state)
    });
    if (!indeterminate) top.createSpan({ cls: "dvs-progress-percent", text: `${percent}%` });

    const bar = header.createDiv({ cls: "dvs-progress-bar", attr: { role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100" } });
    if (indeterminate) {
      bar.addClass("is-indeterminate");
    } else {
      bar.setAttribute("aria-valuenow", String(percent));
    }
    if (state.error) bar.addClass("is-error");
    else if (!state.active) bar.addClass("is-done");
    const fill = bar.createDiv("dvs-progress-bar-fill");
    fill.setCssProps({ "--dvs-progress": `${indeterminate ? 100 : percent}%` });

    const meta = header.createDiv("dvs-progress-meta");
    if (state.total > 0) meta.createSpan({ text: `${state.completed} of ${state.total} done` });
    else if (state.stage === "scanning" && state.stageTotal > 0) meta.createSpan({ text: `${state.stageCompleted} of ${state.stageTotal} files checked` });
    const startedAt = state.startedAt ?? Date.now();
    const elapsed = (state.active ? Date.now() : state.finishedAt ?? Date.now()) - startedAt;
    meta.createSpan({ text: `${state.active ? "Running for" : "Took"} ${formatDuration(elapsed)}` });
    const remaining = estimateRemainingMs(state);
    if (remaining !== undefined) meta.createSpan({ text: `About ${formatDuration(remaining)} left` });
  }

  private renderStages(container: HTMLElement, state: SyncProgressState) {
    const list = container.createEl("ol", { cls: "dvs-stage-list" });
    const currentIndex = state.stages.indexOf(state.stage);
    state.stages.forEach((stage, index) => {
      const done = !state.active ? (!state.error || index < currentIndex) : index < currentIndex;
      const current = index === currentIndex && state.active;
      const failed = !state.active && !!state.error && index === currentIndex;
      const row = list.createEl("li", { cls: "dvs-stage" });
      row.toggleClass("is-done", done && !failed);
      row.toggleClass("is-current", current);
      row.toggleClass("is-failed", failed);
      const icon = row.createSpan("dvs-stage-icon");
      setIcon(icon, failed ? "x-circle" : done ? "check-circle-2" : current ? "loader" : "circle");
      if (current) icon.addClass("dvs-spin");
      const text = row.createDiv("dvs-stage-text");
      text.createDiv({ cls: "dvs-stage-name", text: STAGE_LABELS[stage] });
      if (current && state.stageTotal > 0 && (stage === "scanning" || stage === "transferring" || stage === "backup")) {
        text.createDiv({ cls: "dvs-stage-detail", text: `${state.stageCompleted} / ${state.stageTotal}` });
      }
    });
  }

  private renderCounters(container: HTMLElement, state: SyncProgressState) {
    const counts = state.counts;
    const chips: Array<[string, string, string, number]> = [
      ["upload", "uploaded", "uploaded", counts.upload],
      ["download", "downloaded", "downloaded", counts.download],
      ["trash-2", "deleted", "deleted", counts["delete-local"] + counts["delete-remote"]],
      ["pencil", "renamed", "renamed", counts.rename],
      ["git-merge", "merged", "merged", counts.merge],
      ["archive", "backed up", "backed up", counts.backup],
      ["alert-triangle", "conflict", "conflicts", counts.conflict],
      ["alert-circle", "error", "errors", counts.error]
    ];
    const row = container.createDiv("dvs-counters");
    for (const [icon, singular, plural, value] of chips) {
      if (value === 0) continue;
      const chip = row.createDiv("dvs-chip");
      if (icon === "alert-circle") chip.addClass("is-error");
      setIcon(chip.createSpan("dvs-chip-icon"), icon);
      chip.createSpan({ text: `${value} ${value === 1 ? singular : plural}` });
    }
    if (!row.hasChildNodes()) row.remove();
  }

  private renderActivity(container: HTMLElement, state: SyncProgressState) {
    const errors = state.items.filter((item) => item.status === "error").length;
    const activeCount = state.items.filter((item) => item.status === "active").length;
    const tabs = container.createDiv("dvs-tabs");
    const tab = (key: ProgressFilter, label: string) => {
      const button = tabs.createEl("button", { text: label, cls: "dvs-tab" });
      button.toggleClass("is-active", this.filter === key);
      button.addEventListener("click", () => {
        this.filter = key;
        this.renderNow();
      });
    };
    tab("all", `All (${state.items.length})`);
    tab("active", `In progress (${activeCount})`);
    tab("errors", `Errors (${errors})`);

    const items = state.items.filter((item) => this.filter === "all" || (this.filter === "active" ? item.status === "active" : item.status === "error"));
    if (items.length === 0) {
      container.createDiv({
        cls: "dvs-empty",
        text: this.filter === "errors" ? "No errors." : this.filter === "active" ? "Nothing is transferring right now." : state.active ? "Files will appear here as soon as they start transferring." : "No files needed to be transferred."
      });
      return;
    }
    const list = container.createDiv("dvs-activity-list");
    for (const item of items) this.renderItem(list, item);
  }

  private renderItem(list: HTMLElement, item: SyncProgressItem) {
    const row = list.createDiv({ cls: `dvs-activity is-${item.status}` });
    const icon = row.createSpan("dvs-activity-icon");
    setIcon(icon, item.status === "error" ? "alert-circle" : kindIcon(item.kind));
    const body = row.createDiv("dvs-activity-body");
    const { folder, name } = splitPath(item.path);
    const pathEl = body.createDiv("dvs-activity-path");
    pathEl.createSpan({ cls: "dvs-activity-name", text: name });
    if (folder) pathEl.createSpan({ cls: "dvs-activity-folder", text: folder.replace(/\/$/, "") });
    if (item.detail) body.createDiv({ cls: "dvs-activity-detail", text: item.detail });
    const status = row.createSpan("dvs-activity-status");
    status.setText(item.status === "active" ? `${activeVerb(item.kind)}…` : item.status === "error" ? "Failed" : item.status === "skipped" ? "Skipped" : doneVerb(item.kind));
    const file = this.app.vault.getAbstractFileByPath(item.path);
    if (item.status !== "active" && file instanceof TFile) {
      row.addClass("is-clickable");
      row.setAttribute("aria-label", `Open ${item.path}`);
      row.addEventListener("click", () => {
        this.close();
        void this.app.workspace.getLeaf(false).openFile(file);
      });
    }
  }

  private renderFooter(container: HTMLElement) {
    const footer = new Setting(container);
    if (this.actions.openFailures && this.state.counts.error > 0 && !this.state.active) {
      footer.addButton((button) => button.setButtonText("Show failed files").onClick(() => {
        this.close();
        this.actions.openFailures?.();
      }));
    }
    footer.addButton((button) => button
      .setButtonText(this.state.active ? "Hide (keeps syncing)" : "Close")
      .setCta()
      .onClick(() => this.close()));
  }
}

function finishedHeadline(state: SyncProgressState): string {
  const parts: string[] = [];
  const { counts } = state;
  if (counts.upload) parts.push(`${counts.upload} uploaded`);
  if (counts.download) parts.push(`${counts.download} downloaded`);
  const deleted = counts["delete-local"] + counts["delete-remote"];
  if (deleted) parts.push(`${deleted} deleted`);
  if (counts.error) parts.push(`${counts.error} failed`);
  const when = state.finishedAt ? ` · ${relativeTime(state.finishedAt)}` : "";
  return parts.length === 0 ? `Everything is up to date${when}` : `Done: ${parts.join(", ")}${when}`;
}

// ---------------------------------------------------------------------------
// Sync log & failed files
// ---------------------------------------------------------------------------

export class SyncLogModal extends Modal {
  private textArea?: HTMLTextAreaElement;

  constructor(app: App, private loadReport: () => Promise<string>) {
    super(app);
  }

  onOpen() {
    this.modalEl.addClass("dvs-modal");
    this.titleEl.setText("Sync log");
    const { contentEl } = this;
    contentEl.empty();
    intro(contentEl, "A snapshot of the current sync state and recent activity. Secrets and note contents are never included, so it is safe to share when asking for help.");
    this.textArea = contentEl.createEl("textarea", { cls: "dvs-log-textarea" });
    this.textArea.setAttr("readonly", "true");
    this.textArea.setAttr("spellcheck", "false");
    this.textArea.value = "Collecting…";
    new Setting(contentEl)
      .addButton((button) => button.setButtonText("Copy").setCta().onClick(() => {
        if (this.textArea) void copyToClipboard(this.textArea.value, "Sync log copied.");
      }))
      .addButton((button) => button.setButtonText("Refresh").onClick(() => void this.refresh()))
      .addButton((button) => button.setButtonText("Close").onClick(() => this.close()));
    void this.refresh();
  }

  onClose() {
    this.contentEl.empty();
  }

  private async refresh() {
    if (!this.textArea) return;
    this.textArea.value = "Collecting…";
    try {
      this.textArea.value = await this.loadReport();
    } catch (error) {
      this.textArea.value = `Could not build the sync log: ${error instanceof Error ? error.message : String(error)}`;
    }
    this.textArea.setSelectionRange(0, 0);
    this.textArea.scrollTop = 0;
  }
}

export type SyncFailuresHandlers = {
  getFailures: () => SyncFailureEntry[];
  clearOne: (path: string) => Promise<void>;
  clearAll: () => Promise<void>;
  retry: () => void;
};

export class SyncFailuresModal extends Modal {
  constructor(app: App, private handlers: SyncFailuresHandlers) {
    super(app);
  }

  onOpen() {
    this.modalEl.addClass("dvs-modal");
    this.titleEl.setText("Files that failed to sync");
    this.render();
  }

  onClose() {
    this.contentEl.empty();
  }

  private render() {
    const { contentEl } = this;
    contentEl.empty();
    const failures = [...this.handlers.getFailures()].sort((a, b) => b.lastFailedAt - a.lastFailedAt);
    if (failures.length === 0) {
      const empty = contentEl.createDiv("dvs-empty-state");
      setIcon(empty.createSpan("dvs-empty-icon"), "check-circle");
      empty.createDiv({ text: "No sync problems. Files that fail to upload or download are listed here until they sync cleanly." });
      new Setting(contentEl).addButton((button) => button.setButtonText("Close").onClick(() => this.close()));
      return;
    }
    intro(contentEl, `${failures.length} file${failures.length === 1 ? "" : "s"} could not be synced. They are retried on every sync and disappear from this list once they succeed.`);
    new Setting(contentEl)
      .addButton((button) => button.setButtonText("Retry now").setCta().onClick(() => {
        this.handlers.retry();
        this.close();
      }))
      .addButton((button) => button.setButtonText("Copy all errors").onClick(() => void copyToClipboard(buildFailureReport(failures), "All errors copied.")))
      .addButton((button) => button.setButtonText("Clear list").setWarning().onClick(async () => {
        await this.handlers.clearAll();
        this.render();
      }));
    const list = contentEl.createDiv("dvs-failure-list");
    for (const failure of failures) {
      const item = list.createDiv("dvs-failure");
      const head = item.createDiv("dvs-failure-head");
      head.createDiv({ text: failure.path, cls: "dvs-failure-path" });
      const actions = head.createDiv("dvs-failure-actions");
      const copy = actions.createEl("button", { attr: { "aria-label": "Copy error" } });
      setIcon(copy, "copy");
      copy.addEventListener("click", () => void copyToClipboard(`${failure.path}\n${failure.error}`, "Error copied."));
      const remove = actions.createEl("button", { attr: { "aria-label": "Remove from list" } });
      setIcon(remove, "x");
      remove.addEventListener("click", () => {
        void this.handlers.clearOne(failure.path).then(() => this.render());
      });
      const when = new Date(failure.lastFailedAt).toLocaleString();
      item.createDiv({
        cls: "dvs-failure-meta",
        text: failure.count > 1 ? `${failure.operation} · failed ${failure.count} times · last ${when}` : `${failure.operation} · ${when}`
      });
      item.createEl("pre", { cls: "dvs-failure-error", text: failure.error });
    }
  }
}

function buildFailureReport(failures: SyncFailureEntry[]): string {
  const lines = [
    "=== Drive Vault Sync — files that failed to sync ===",
    `Generated: ${new Date().toISOString()}`,
    `Count: ${failures.length}`,
    ""
  ];
  for (const failure of failures) {
    lines.push(`- ${failure.path}`);
    lines.push(`  operation: ${failure.operation}`);
    lines.push(`  failures: ${failure.count}`);
    lines.push(`  first: ${new Date(failure.firstFailedAt).toISOString()}`);
    lines.push(`  last: ${new Date(failure.lastFailedAt).toISOString()}`);
    lines.push(`  error: ${failure.error.replace(/\n/g, "\n         ")}`);
    lines.push("");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Confirmations & choices
// ---------------------------------------------------------------------------

export function confirmResetIndex(app: App): Promise<boolean> {
  return decisionModal(app, false, (modal, finish) => {
    modal.titleEl.setText("Forget what was synced on this device?");
    intro(modal.contentEl, "Your notes and the Google Drive copy stay untouched. The next sync re-checks every file from scratch, which takes longer but can fix a confused sync state.");
    new Setting(modal.contentEl)
      .addButton((button) => button.setButtonText("Reset sync state").setWarning().onClick(() => finish(true)))
      .addButton((button) => button.setButtonText("Cancel").onClick(() => finish(false)));
  });
}

export function confirmDangerAction(app: App, title: string, message: string, cta: string): Promise<boolean> {
  return decisionModal(app, false, (modal, finish) => {
    modal.titleEl.setText(title);
    const warning = modal.contentEl.createDiv("dvs-callout is-warning");
    setIcon(warning.createSpan("dvs-callout-icon"), "alert-triangle");
    warning.createDiv({ text: message });
    new Setting(modal.contentEl)
      .addButton((button) => button.setButtonText(cta).setWarning().onClick(() => finish(true)))
      .addButton((button) => button.setButtonText("Cancel").onClick(() => finish(false)));
  });
}

export function chooseInitialSyncDirection(app: App): Promise<InitialSyncDirection | null> {
  return decisionModal<InitialSyncDirection | null>(app, null, (modal, finish) => {
    modal.titleEl.setText("How should this device start syncing?");
    intro(modal.contentEl, "This is a one-time choice for this device. Automatic sync stays paused until you pick one.");
    const choices = modal.contentEl.createDiv("dvs-choice-grid");
    const choice = (icon: string, title: string, description: string, onPick: () => void, recommended = false) => {
      const card = choices.createEl("button", { cls: "dvs-choice-card" });
      if (recommended) card.addClass("is-recommended");
      setIcon(card.createSpan("dvs-choice-icon"), icon);
      card.createDiv({ cls: "dvs-choice-title", text: title });
      card.createDiv({ cls: "dvs-choice-desc", text: description });
      if (recommended) card.createDiv({ cls: "dvs-choice-badge", text: "Most common" });
      card.addEventListener("click", onPick);
    };
    choice("cloud-download", "Download from Google Drive", "Use this when the vault is already synced from another device. This device is replaced with the cloud copy; you can keep files that exist only here.", () => finish("cloud-to-local"), true);
    choice("cloud-upload", "Upload this vault", "Use this for your very first device. The cloud copy is replaced with this vault and other devices follow it.", () => finish("local-to-cloud"));
    new Setting(modal.contentEl).addButton((button) => button.setButtonText("Decide later").onClick(() => finish(null)));
  });
}

export function chooseLocalFilesToKeep(app: App, paths: string[]): Promise<string[] | null> {
  return decisionModal<string[] | null>(app, null, (modal, finish) => {
    const selected = new Set<string>(paths);
    modal.titleEl.setText("Keep files that exist only on this device?");
    intro(modal.contentEl, `${paths.length} file${paths.length === 1 ? "" : "s"} on this device are not in Google Drive. Selected files are kept and uploaded; the rest go to the trash (and into a backup first).`);
    selectableList(modal.contentEl, paths, selected, (path) => path, (path) => path);
    new Setting(modal.contentEl)
      .addButton((button) => button.setButtonText("Keep selected").setCta().onClick(() => finish(Array.from(selected))))
      .addButton((button) => button.setButtonText("Move all to trash").setWarning().onClick(() => finish([])))
      .addButton((button) => button.setButtonText("Cancel").onClick(() => finish(null)));
  });
}

export function chooseRemoteCleanupCandidates(app: App, candidates: RemoteCleanupCandidate[]): Promise<RemoteCleanupCandidate[] | null> {
  return decisionModal<RemoteCleanupCandidate[] | null>(app, null, (modal, finish) => {
    const selected = new Set(candidates.map((candidate) => candidate.id));
    modal.titleEl.setText("Clean up hidden Google Drive duplicates?");
    intro(modal.contentEl, "These files are in the sync folder on Google Drive but no device uses them (usually leftovers of interrupted uploads). Selected files are moved to the Google Drive trash, where you can still restore them for 30 days.");
    selectableList(
      modal.contentEl,
      candidates,
      selected,
      (candidate) => candidate.id,
      (candidate) => candidate.path,
      (candidate) => [
        candidate.reason === "duplicate" ? "Duplicate of a synced file" : "Not used by any device",
        candidate.modifiedTime ? `modified ${new Date(candidate.modifiedTime).toLocaleString()}` : undefined,
        candidate.size !== undefined ? formatBytes(candidate.size) : undefined
      ].filter(Boolean).join(" · ")
    );
    new Setting(modal.contentEl)
      .addButton((button) => button.setButtonText("Move selected to trash").setWarning().onClick(() => {
        finish(candidates.filter((candidate) => selected.has(candidate.id)));
      }))
      .addButton((button) => button.setButtonText("Cancel").onClick(() => finish(null)));
  });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function showConflictNotice(count: number) {
  if (count > 0) new Notice(`${count} sync conflict${count === 1 ? " was" : "s were"} left for later. Run “Sync now” to resolve ${count === 1 ? "it" : "them"}.`);
}

export function showManualConflictModal(app: App, details: ManualConflictDetails): Promise<ManualConflictChoice> {
  return decisionModal<ManualConflictChoice>(app, "cancel", (modal, finish) => {
    modal.titleEl.setText("This note changed on two devices");
    modal.contentEl.createDiv({ text: details.path, cls: "dvs-path-pill" });
    intro(modal.contentEl, `Both this device and ${details.deviceName} edited it since the last sync${details.modifiedAt ? ` (their version is from ${new Date(details.modifiedAt).toLocaleString()})` : ""}, and the edits could not be combined automatically.`);
    const diffEl = modal.contentEl.createDiv("dvs-diff");
    diffEl.addClass("dvs-hidden");
    let diffRendered = false;
    const actions = new Setting(modal.contentEl)
      .addButton((button) => button.setButtonText("Keep mine").setCta().onClick(() => finish("keep-local")))
      .addButton((button) => button.setButtonText("Keep theirs").setWarning().onClick(() => finish("keep-remote")))
      .addButton((button) => button.setButtonText("Keep both").onClick(() => finish("keep-both")))
      .addButton((button) => button.setButtonText("Show differences").onClick(() => {
        const visible = !diffEl.hasClass("dvs-hidden");
        if (!visible && !diffRendered) {
          diffRendered = true;
          renderDiff(diffEl, details.remoteText, details.localText, true, "Their version compared with yours.");
        }
        diffEl.toggleClass("dvs-hidden", visible);
        button.setButtonText(visible ? "Show differences" : "Hide differences");
      }))
      .addButton((button) => button.setButtonText("Decide later").onClick(() => finish("cancel")));
    actions.settingEl.addClass("dvs-conflict-actions");
  });
}

export function showRemoteDeleteConflictModal(app: App, path: string, deviceName: string, deletedAt: number | null): Promise<RemoteDeleteConflictChoice> {
  return decisionModal<RemoteDeleteConflictChoice>(app, "cancel", (modal, finish) => {
    modal.titleEl.setText("Deleted elsewhere, edited here");
    modal.contentEl.createDiv({ text: path, cls: "dvs-path-pill" });
    intro(modal.contentEl, `This file was deleted on ${deviceName}${deletedAt ? ` (${new Date(deletedAt).toLocaleString()})` : ""}, but it has changes on this device that were never synced.`);
    const actions = new Setting(modal.contentEl)
      .addButton((button) => button.setButtonText("Keep my version").setCta().onClick(() => finish("keep-local")))
      .addButton((button) => button.setButtonText("Delete it here too").setWarning().onClick(() => finish("delete-local")))
      .addButton((button) => button.setButtonText("Decide later").onClick(() => finish("cancel")));
    actions.settingEl.addClass("dvs-conflict-actions");
  });
}

// ---------------------------------------------------------------------------
// Moving the Google sign-in to another device
// ---------------------------------------------------------------------------

export class AuthExportModal extends Modal {
  private usePassword = true;
  private password = "";
  private confirmPassword = "";
  private qrEl!: HTMLElement;
  private errorEl!: HTMLElement;
  private generateBtn!: HTMLButtonElement;

  constructor(app: App, private auth: StoredAuth) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    this.modalEl.addClass("dvs-modal");
    this.titleEl.setText("Sign in on another device");
    contentEl.empty();
    intro(contentEl, "Scan this QR code with the camera of the other device, with Obsidian and this plugin installed. It signs that device in to the same Google account without repeating the setup.");
    const warning = contentEl.createDiv("dvs-callout is-warning");
    setIcon(warning.createSpan("dvs-callout-icon"), "shield-alert");
    warning.createDiv({ text: "The code contains your Google access — treat it like a password and don't share screenshots of it." });

    const passwordSetting = new Setting(contentEl)
      .setName("Password")
      .addText((text) => {
        text.inputEl.type = "password";
        text.setPlaceholder("Enter a password").onChange((value) => { this.password = value; });
      });
    const confirmSetting = new Setting(contentEl)
      .setName("Repeat password")
      .addText((text) => {
        text.inputEl.type = "password";
        text.setPlaceholder("Repeat the password").onChange((value) => { this.confirmPassword = value; });
      });
    new Setting(contentEl)
      .setName("Protect with a password")
      .setDesc("Recommended. The other device asks for this password before importing.")
      .addToggle((toggle) => toggle.setValue(true).onChange((value) => {
        this.usePassword = value;
        passwordSetting.settingEl.toggleClass("dvs-hidden", !value);
        confirmSetting.settingEl.toggleClass("dvs-hidden", !value);
        this.qrEl.empty();
        this.errorEl.setText("");
      }));
    contentEl.appendChild(passwordSetting.settingEl);
    contentEl.appendChild(confirmSetting.settingEl);

    this.errorEl = contentEl.createEl("p", { cls: "dvs-error-text" });
    new Setting(contentEl).addButton((button) => {
      this.generateBtn = button.buttonEl;
      button.setButtonText("Show QR code").setCta().onClick(() => void this.generate());
    });
    this.qrEl = contentEl.createDiv("dvs-qr-container");
  }

  private async generate() {
    this.errorEl.setText("");
    if (this.usePassword) {
      if (!this.password) {
        this.errorEl.setText("Enter a password.");
        return;
      }
      if (this.password !== this.confirmPassword) {
        this.errorEl.setText("The passwords do not match.");
        return;
      }
    }
    this.generateBtn.disabled = true;
    this.generateBtn.textContent = "Generating…";
    try {
      const payload: AuthTransferPayload = this.usePassword
        ? await encryptAuth(this.auth, this.password)
        : { v: 1, encrypted: false, auth: this.auth };
      const qrDataUrl = await generateQRCodeDataUrl(buildTransferUrl(payload));
      this.qrEl.empty();
      this.qrEl.createEl("img", { attr: { alt: "QR code for signing in on another device", src: qrDataUrl }, cls: "dvs-qr" });
      this.qrEl.createEl("p", {
        text: this.usePassword
          ? "Scan it on the other device — you will be asked for the password."
          : "Not password-protected: scan it right away and close this window.",
        cls: "dvs-muted"
      });
    } catch (error) {
      this.errorEl.setText(error instanceof Error ? error.message : "Could not generate the QR code.");
    } finally {
      this.generateBtn.disabled = false;
      this.generateBtn.textContent = "Show QR code";
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

export function showAuthImportModal(app: App, payload: AuthTransferPayload): Promise<StoredAuth | null> {
  return decisionModal<StoredAuth | null>(app, null, (modal, finish) => {
    modal.titleEl.setText("Sign in with a code from another device");
    if (!payload.encrypted) {
      intro(modal.contentEl, "This QR code signs this device in to Google Drive with the account used on your other device.");
      new Setting(modal.contentEl)
        .addButton((button) => button.setButtonText("Sign in").setCta().onClick(() => finish(payload.auth)))
        .addButton((button) => button.setButtonText("Cancel").onClick(() => finish(null)));
      return;
    }
    intro(modal.contentEl, "This QR code is password-protected. Enter the password you chose on the other device.");
    let password = "";
    const errorEl = modal.contentEl.createEl("p", { cls: "dvs-error-text" });
    let importBtn!: HTMLButtonElement;
    new Setting(modal.contentEl)
      .setName("Password")
      .addText((text) => {
        text.inputEl.type = "password";
        text.setPlaceholder("Password").onChange((value) => { password = value; });
        text.inputEl.addEventListener("keydown", (event) => { if (event.key === "Enter") importBtn.click(); });
      });
    new Setting(modal.contentEl)
      .addButton((button) => {
        importBtn = button.buttonEl;
        button.setButtonText("Sign in").setCta().onClick(async () => {
          errorEl.setText("");
          if (!password) {
            errorEl.setText("Enter the password.");
            return;
          }
          importBtn.disabled = true;
          importBtn.textContent = "Checking…";
          try {
            finish(await decryptAuth(payload, password));
          } catch (error) {
            errorEl.setText(error instanceof Error ? error.message : "Could not decrypt the code.");
            importBtn.disabled = false;
            importBtn.textContent = "Sign in";
          }
        });
      })
      .addButton((button) => button.setButtonText("Cancel").onClick(() => finish(null)));
  });
}

// ---------------------------------------------------------------------------
// Backups
// ---------------------------------------------------------------------------

export type BackupRestoreChoice = { type: "all" } | { type: "file"; path: string };

export function showBackupRestoreModal(
  app: App,
  backup: BackupMeta,
  data: BackupData,
  downloadFile: (fileId: string) => Promise<ArrayBuffer>
): Promise<BackupRestoreChoice | null> {
  return decisionModal<BackupRestoreChoice | null>(app, null, (modal, finish) => {
    modal.titleEl.setText(backup.label ? `Backup “${backup.label}”` : "Backup");
    modal.contentEl.createDiv({ text: `${new Date(backup.createdAt).toLocaleString()} · ${backup.deviceName}`, cls: "dvs-muted" });
    intro(modal.contentEl, backup.kind === "manual"
      ? `A full copy of ${backup.changedCount} files. Restoring overwrites those files with the backed-up versions.`
      : `${backup.changedCount} changed and ${backup.deletedCount} deleted files were saved before a sync. Restoring overwrites those files with the backed-up versions.`);
    const hasSnapshotFiles = data.snapshotFiles === true || backup.folderId !== undefined;
    if (!hasSnapshotFiles) {
      modal.contentEl.createEl("p", {
        text: "This is an older backup format. It may point to the current Google Drive file instead of an independent historical copy.",
        cls: "dvs-diff-meta"
      });
    }

    const changedPaths = Object.keys(data.changedFiles).sort();
    const deletedPaths = [...data.deletedPaths].sort();
    const allPaths = [...changedPaths, ...deletedPaths];
    const search = modal.contentEl.createEl("input", { type: "search", placeholder: "Filter files…", cls: "dvs-search" });
    const listEl = modal.contentEl.createDiv("dvs-file-list");

    const renderList = () => {
      listEl.empty();
      const query = search.value.toLowerCase();
      for (const path of allPaths.filter((item) => item.toLowerCase().includes(query))) {
        const isDeleted = deletedPaths.includes(path);
        const row = listEl.createDiv("dvs-backup-row");
        const header = row.createDiv("dvs-backup-row-header");
        header.createSpan({
          text: (isDeleted ? "✕ " : "~ ") + path,
          cls: isDeleted ? "dvs-path-deleted" : "dvs-path-changed"
        });
        if (!isDeleted && isLikelyTextPath(path)) {
          const toggle = header.createEl("button", { text: "Compare", cls: "dvs-small-button" });
          const diffEl = row.createDiv("dvs-diff");
          diffEl.addClass("dvs-hidden");
          let loaded = false;
          toggle.addEventListener("click", () => {
            void (async () => {
              if (loaded) {
                const visible = !diffEl.hasClass("dvs-hidden");
                diffEl.toggleClass("dvs-hidden", visible);
                toggle.textContent = visible ? "Compare" : "Hide";
                return;
              }
              loaded = true;
              toggle.textContent = "Loading…";
              toggle.disabled = true;
              try {
                const entry = data.changedFiles[path];
                const backupText = new TextDecoder().decode(await downloadFile(entry.driveFileId));
                const localFile = app.vault.getAbstractFileByPath(path);
                const localText = localFile instanceof TFile ? await app.vault.read(localFile) : undefined;
                diffEl.empty();
                renderDiff(diffEl, backupText, localText, hasSnapshotFiles);
              } catch (error) {
                diffEl.setText(error instanceof Error ? error.message : "Could not load the comparison.");
              }
              toggle.textContent = "Hide";
              toggle.disabled = false;
              diffEl.removeClass("dvs-hidden");
            })();
          });
        }
        if (!isDeleted) {
          const restoreFile = header.createEl("button", { text: "Restore", cls: "dvs-small-button" });
          restoreFile.addEventListener("click", () => finish({ type: "file", path }));
        }
      }
    };
    search.addEventListener("input", renderList);
    renderList();

    new Setting(modal.contentEl)
      .addButton((button) => button.setButtonText(backup.kind === "manual" ? "Restore all files" : "Restore all changed files").setWarning().onClick(() => finish({ type: "all" })))
      .addButton((button) => button.setButtonText("Cancel").onClick(() => finish(null)));
  });
}

export function requestManualBackupName(app: App): Promise<string | null> {
  return decisionModal<string | null>(app, null, (modal, finish) => {
    let value = `Backup ${new Date().toLocaleString()}`;
    modal.titleEl.setText("Create a full backup");
    intro(modal.contentEl, "Uploads a complete copy of this vault to Google Drive. Manual backups are kept until you delete them yourself.");
    new Setting(modal.contentEl)
      .setName("Name")
      .addText((text) => text.setValue(value).onChange((next) => { value = next; }));
    new Setting(modal.contentEl)
      .addButton((button) => button.setButtonText("Create backup").setCta().onClick(() => {
        const trimmed = value.trim();
        if (trimmed) finish(trimmed);
      }))
      .addButton((button) => button.setButtonText("Cancel").onClick(() => finish(null)));
  });
}

function isLikelyTextPath(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return ["md", "txt", "json", "yaml", "yml", "csv", "css", "js", "ts", "html", "xml", "canvas"].includes(ext);
}

// ---------------------------------------------------------------------------
// Text diff
// ---------------------------------------------------------------------------

const MAX_DIFF_LINES = 300;

function renderDiff(container: HTMLElement, backupText: string, localText?: string, hasSnapshotFiles = true, caption?: string) {
  container.createEl("p", {
    text: caption ?? (localText === undefined ? "The backed-up version (the file no longer exists locally)." : "The backed-up version compared with the current file."),
    cls: "dvs-diff-meta"
  });
  const backupLines = backupText.split("\n");
  const localLines = localText?.split("\n") ?? [];
  const pre = container.createEl("pre", { cls: "dvs-diff-pre" });
  if (localText === undefined) {
    renderTextSnapshot(pre, backupLines);
    return;
  }
  if (backupText === localText) {
    pre.createSpan({
      text: hasSnapshotFiles ? "(no differences)" : "(this older backup points to the same text as the current file; the historical text may not be available)",
      cls: "dvs-diff-meta"
    });
    return;
  }
  let count = 0;
  for (const op of diffLines(backupLines, localLines)) {
    if (count >= MAX_DIFF_LINES) {
      pre.createSpan({ text: "\n… comparison truncated …", cls: "dvs-diff-meta" });
      break;
    }
    const prefix = op.type === "remove" ? "- " : op.type === "add" ? "+ " : "  ";
    pre.createSpan({ text: `${prefix}${formatDiffLine(op.line)}\n`, cls: `dvs-diff-${op.type}` });
    count++;
  }
}

function renderTextSnapshot(pre: HTMLElement, lines: string[]) {
  for (let i = 0; i < Math.min(lines.length, MAX_DIFF_LINES); i++) {
    pre.createSpan({ text: `- ${formatDiffLine(lines[i])}\n`, cls: "dvs-diff-remove" });
  }
  if (lines.length > MAX_DIFF_LINES) pre.createSpan({ text: "\n… truncated …", cls: "dvs-diff-meta" });
}

/** Keeps real spaces on phones, where long lines have to wrap at word boundaries. */
function formatDiffLine(line: string): string {
  if (line.length === 0) return "␀";
  return line.replace(/\r/g, "␍").replace(/\t/g, "⇥").replace(/ /g, Platform.isPhone ? " " : "·");
}

type DiffOp = { type: "ctx" | "add" | "remove"; line: string };

function diffLines(a: string[], b: string[]): DiffOp[] {
  const lcs = computeLcs(a, b);
  const ops: DiffOp[] = [];
  let ai = 0, bi = 0, li = 0;
  while (ai < a.length || bi < b.length) {
    if (li < lcs.length && ai === lcs[li][0] && bi === lcs[li][1]) {
      ops.push({ type: "ctx", line: a[ai] });
      ai++; bi++; li++;
    } else if (bi < b.length && (li >= lcs.length || bi < lcs[li][1])) {
      ops.push({ type: "add", line: b[bi++] });
    } else {
      ops.push({ type: "remove", line: a[ai++] });
    }
  }
  return ops;
}

function computeLcs(a: string[], b: string[]): [number, number][] {
  const m = a.length, n = b.length;
  if (m === 0 || n === 0) return [];
  // Cap to avoid O(m·n) memory on huge files; the diff then shows full replace.
  if (m * n > 40000) return [];
  const dp: number[][] = Array.from({ length: m + 1 }, (): number[] => Array<number>(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const result: [number, number][] = [];
  let i = m, j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) { result.push([i - 1, j - 1]); i--; j--; }
    else if (dp[i - 1][j] > dp[i][j - 1]) i--;
    else j--;
  }
  return result.reverse();
}
